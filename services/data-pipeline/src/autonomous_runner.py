"""Execute one SQL-scheduled unit with a hard process budget and durable status."""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from src import collection_priority, source_suspension, source_traffic, source_withdrawal
from src.catalogue_lock import LOCK_WAIT_ENV, CatalogueLockTimeout, catalogue_writer_lock
from src.config import (
    ANTHROPIC_API_KEY_ENV,
    AUTONOMOUS_RUN_ID_ENV,
    CADASTRE_ENRICH_ENABLED_ENV,
    DEFAULT_REPLICATE_CANCEL_AFTER,
    DPE_ENRICH_ENABLED_ENV,
    REPLICATE_CANCEL_AFTER_ENV,
    SOURCE_NAMES,
    load_settings,
)
from src.document_reading import READING_ENABLED_ENV
from src.enrichment_lane_settings import LaneSettingsError, lane_settings
from src.enrichment_queue_limits import (
    COLLECTION_PENDING_STOP_REASON,
    ENRICHMENT_BUDGET_SECONDS,
    ENRICHMENT_BUDGET_SECONDS_ENV,
    ENRICHMENT_MAX_JOBS,
    ENRICHMENT_MAX_JOBS_ENV,
    ENRICHMENT_WORKER_REPORT_ENV,
    LLM_BUDGET_STOP_REASON,
    QUEUES_EMPTY_STOP_REASON,
    read_worker_report,
)
from src.run_finalizer import register_run
from src.source_absence import (
    mark_unseen_undated_sales,
    mark_unseen_undated_sales_of_disabled_sources,
    withdraw_missing_sales,
)
from src.source_health import SOURCE_WARNING_EXIT_CODE
from src.sources.licitor import SOURCE_BUDGET_ENV as LICITOR_SOURCE_BUDGET_ENV
from src.sources.petites_affiches import SOURCE_BUDGET_ENV as PETITES_AFFICHES_SOURCE_BUDGET_ENV
from src.sources.robots_policy_copies import COVERAGE_KEY as ROBOTS_COPIES_KEY
from src.sources.robots_policy_copies import merge_copies as merge_robots_policy_copies
from src.stage_watchdog import WATCHDOG_ENV, WATCHDOG_EXIT_CODE
from src.storage.supabase_client import close_open_run, merge_into_run_report
from src.storage.supabase_client import connect as postgres_connect
from src.timestamps import aware_timestamp

# Décision du propriétaire (11/10/2026) : chaque source au plus toutes les 12 h.
INVENTORY_CADENCE = timedelta(hours=12)
INVENTORY_DISPATCH_MARGIN = timedelta(minutes=45)
# Un inventaire complet ne compte pour l'absence d'une vente que s'il est distant d'au moins cette durée du
# précédent compté (deux passages rapprochés de quelques minutes ne valent pas deux inventaires). La migration
# 20261029150100 applique le même écart au retrait ; tests/test_source_absence.py compare les deux.
ABSENCE_MIN_INVENTORY_SPACING = INVENTORY_CADENCE
NEAR_SALE_HORIZON = timedelta(days=7)
ACTIVE_LISTING_STATUSES = frozenset({'active', 'upcoming', 'postponed', 'unknown'})
ENRICHMENT_TERMINAL_STATUSES = frozenset({'completed', 'failed'})
# Décisions d'un item de collecte qui ne sont pas terminales : tant qu'il en reste, la publication n'est pas complète.
PENDING_PUBLICATION_DECISIONS = ('discovered', 'normalized', 'admitted', 'publication_failed', 'normalization_failed')
# Décisions qui ne se résorbent pas d'elles-mêmes au run suivant : une annonce qui échoue à la normalisation ou à
# la publication échoue de la même façon tant que son contenu ou le code ne change pas.
STUCK_PUBLICATION_DECISIONS = ('publication_failed', 'normalization_failed')
STUCK_ITEMS_SAMPLE = 5
# Sources dont l'inventaire PUBLIC ENTIER ne peut pas être certifié par nature. Agrasc affiche des cartes d'archive
# vendues sans lien (aucune fiche à publier) : coverage_complete reste faux à chaque run. Sa publication est évaluée
# sur son catalogue adressable (les seules cartes qui ont une fiche) : certifié, toutes les fiches découvertes émises,
# aucune décision en suspens, run réussi. Cette règle ne sert QU'À last_publication_complete_at (santé publique,
# date « vérifié le », alerte publication_stale) : l'absence et le retrait de ventes restent liés à l'inventaire
# public entier (inventory_complete), jamais à ce périmètre.
SCOPED_PUBLICATION_SOURCES = frozenset({'agrasc'})


def _enrichment_completed(counts: dict[object, object]) -> int:
    """Count jobs successfully completed during this worker run.

    A terminal failure proves queue activity, but it does not establish useful
    business progress for the batch.  At least one completed job is required
    before an exhausted item can downgrade the run to partial success.
    """
    return int(counts.get('completed', 0) or 0)


def _enrichment_terminal(counts: dict[object, object]) -> int:
    """Count completed and failed jobs for bounded worker activity metrics."""
    return sum(int(counts.get(status, 0) or 0) for status in ENRICHMENT_TERMINAL_STATUSES)


def _enrichment_exhausted_detail(row: tuple[object, ...]) -> dict[str, object]:
    """Return a bounded, non-sensitive summary for one exhausted job."""
    job_id, job_type, attempt_count, max_attempts = row
    return {
        'job_id': str(job_id) if job_id is not None else None,
        'job_type': str(job_type) if job_type is not None else None,
        'attempt_count': int(attempt_count or 0),
        'max_attempts': int(max_attempts or 0),
    }


def next_attempt(*, failures: int, access_denied: bool, retry_not_before: str | None,
                 now: datetime) -> datetime:
    delay = timedelta(hours=24) if access_denied and failures >= 2 else timedelta(minutes=min(360, 15 * 2 ** min(failures, 5)))
    deadline = now + delay
    other = aware_timestamp(retry_not_before)
    if other is not None:
        deadline = max(deadline, other)
    return deadline


# Un refus d'accès se lit d'abord dans le compteur structuré du client HTTP
# (coverage['access_denials']). Les messages d'erreur ne servent qu'en complément
# et doivent porter l'état HTTP lui-même : un « 403 » dans une URL ne compte pas.
_HTTP_REFUSAL = re.compile(r'\bHTTP (?:401|403)\b')


def access_denied(coverage: dict[str, object], problems: Iterable[object]) -> bool:
    """True when the source refused access (HTTP 401/403), not when a URL contains 401/403."""
    return bool(coverage.get('access_denials')) or any(
        _HTTP_REFUSAL.search(str(problem)) for problem in problems
    )


def _near_sale(row: dict[str, object], now: datetime) -> bool:
    evidence = row.get('evidence')
    evidence = evidence if isinstance(evidence, dict) else {}
    status = str(row.get('status') or evidence.get('status') or '').lower()
    if status not in ACTIVE_LISTING_STATUSES:
        return False
    sale_date = aware_timestamp(row.get('sale_date')) or aware_timestamp(evidence.get('sale_date'))
    return sale_date is not None and now <= sale_date <= now + NEAR_SALE_HORIZON


def _source_check_times(payload: object, *, source: str, source_url: str, now: datetime,
                        allow_checkpoint_checked_at: bool = False) -> list[datetime]:
    if not isinstance(payload, dict):
        return []
    result: list[datetime] = []
    if allow_checkpoint_checked_at:
        checkpoint_checked_at = aware_timestamp(payload.get('_checkpoint_checked_at'))
        if checkpoint_checked_at is not None and checkpoint_checked_at <= now:
            result.append(checkpoint_checked_at)
    checks = payload.get('source_checks')
    if isinstance(checks, dict):
        check = checks.get(source_url)
        if isinstance(check, dict) and (not check.get('source_name') or check.get('source_name') == source):
            checked_at = aware_timestamp(check.get('checked_at'))
            if checked_at is not None and checked_at <= now:
                result.append(checked_at)
    nested = payload.get('raw_payload')
    if isinstance(nested, dict):
        result.extend(_source_check_times(nested, source=source, source_url=source_url, now=now))
    return result


def _row_payloads(row: dict[str, object]) -> Iterable[tuple[object, bool]]:
    # A catalogue raw_payload can contain a stale private checkpoint marker
    # copied from another source. Only the SQL row selected for this run/URL
    # and a matching observation are allowed to carry that marker.
    yield row.get('raw_payload'), False
    yield row.get('checkpoint_payload'), True
    observations = row.get('observations')
    if isinstance(observations, list):
        for observation in observations:
            if not isinstance(observation, dict):
                continue
            if observation.get('source_url') == row.get('source_url'):
                yield observation.get('raw_payload') or observation, True


def next_inventory_deadline(*, now: datetime, started_at: object | None, source: str,
                            evidence_rows: Iterable[dict[str, object]]) -> datetime:
    """Return a bounded source deadline from verified rows in the real run.

    ``evidence_rows`` is deliberately supplied by the current run's collection
    items. A stale alias which was absent from this run cannot move the
    deadline backwards. A checkpoint timestamp is the time the detail was
    actually checked, while ``started_at`` is only a conservative fallback for
    a row observed by this run without a usable check timestamp.
    """
    current = aware_timestamp(now)
    if current is None:
        raise ValueError('now must be timezone-aware')
    run_started = aware_timestamp(started_at)
    anchors: list[datetime] = []
    for row in evidence_rows:
        if not _near_sale(row, current):
            continue
        source_url = str(row.get('source_url') or '')
        checks: list[datetime] = []
        if source_url:
            for payload, allow_checkpoint_checked_at in _row_payloads(row):
                checks.extend(_source_check_times(
                    payload, source=source, source_url=source_url, now=current,
                    allow_checkpoint_checked_at=allow_checkpoint_checked_at,
                ))
        if checks:
            # A stale checkpoint marker must not override a newer source check
            # for the same URL. The inventory cadence is based on the oldest
            # URL after each URL's strongest reusable evidence is selected.
            anchors.append(max(checks))
        elif run_started is not None and run_started <= current:
            anchors.append(run_started)
    if not anchors:
        # No close listing was evidenced by this run. Keep the ordinary
        # cadence instead of inheriting an old alias/checkpoint forever.
        return current + INVENTORY_CADENCE
    return max(current, min(anchors) + INVENTORY_CADENCE - INVENTORY_DISPATCH_MARGIN)


def _schedule_evidence_rows(db: Any, run_id: str, source: str) -> list[dict[str, object]]:
    rows = db.execute("""select i.source_url,i.canonical_source_url,i.evidence,
            s.sale_date,s.status,s.raw_payload,s.observations,c.payload
        from public.auction_collection_items i
        left join public.auction_sales s
          on s.source_url=coalesce(i.canonical_source_url,i.source_url)
        left join public.auction_collection_checkpoints c
          on c.run_id=i.run_id and c.source_url=i.source_url
        where i.run_id=%s and i.source_name=%s""", (run_id, source)).fetchall()
    return [
        {
            'source_url': row[0],
            'canonical_source_url': row[1],
            'evidence': row[2],
            'sale_date': row[3],
            'status': row[4],
            'raw_payload': row[5],
            'observations': row[6],
            'checkpoint_payload': row[7],
        }
        for row in rows
    ]


_ROBOTS_POLICY_DETAIL_KEYS = ('state', 'error_type', 'transient', 'status_code', 'copy_age_hours', 'error')


def _stop_cause(coverage: dict[str, Any]) -> str | None:
    """La raison précise de l'arrêt. « 0 requête » seul ne dit pas que robots.txt était illisible (EI, 16/11/2026)."""
    robots = coverage.get('robots_policy')
    state = robots.get('state') if isinstance(robots, dict) else None
    if state == 'unavailable':
        return 'robots_unavailable'
    if state == 'refused':
        return 'robots_refused'
    if isinstance(coverage.get('list_fetch_failures'), list) and coverage['list_fetch_failures']:
        return 'list_fetch_failed'
    stop_reason = coverage.get('stop_reason')
    return stop_reason if isinstance(stop_reason, str) else None


def _inventory_blocker_details(coverage: dict[str, Any]) -> dict[str, Any]:
    """Pourquoi l'inventaire n'est pas déclaré complet : les chiffres de la couverture, et la cause de l'arrêt.

    Les seuls textes sont des messages d'erreur techniques bornés à 200 caractères (adresse de la page de
    liste ou de robots.txt, type d'erreur) : aucun contenu de fiche.
    """
    details: dict[str, Any] = {
        key: coverage[key]
        for key in ('stop_reason', 'errors', 'pages_fetched', 'advertised_total', 'unique_listings_seen',
                    'total_changed_during_scan')
        if isinstance(coverage.get(key), (str, int, bool)) and coverage.get(key) is not None
    }
    stop_cause = _stop_cause(coverage)
    if stop_cause:
        details['stop_cause'] = stop_cause
    robots = coverage.get('robots_policy')
    if isinstance(robots, dict):
        details['robots_policy'] = {
            key: str(robots[key])[:200] if key == 'error' else robots[key]
            for key in _ROBOTS_POLICY_DETAIL_KEYS if robots.get(key) is not None
        }
    for key in ('list_fetch_failures', 'detail_failures'):
        failures = coverage.get(key)
        if isinstance(failures, list) and failures:
            details[f'{key}_count'] = len(failures)
    list_failures = coverage.get('list_fetch_failures')
    if isinstance(list_failures, list) and list_failures:
        details['list_fetch_failures_sample'] = [
            {key: str(item[key])[:200] for key in ('url', 'error_type', 'error') if item.get(key)}
            for item in list_failures[:3] if isinstance(item, dict)
        ]
    detail_failures = coverage.get('detail_failures')
    if isinstance(detail_failures, list):
        details['detail_failures_sample'] = [
            {key: str(item[key])[:200] for key in ('source_url', 'kind', 'reason') if item.get(key)}
            for item in detail_failures[:3] if isinstance(item, dict)
        ]
    certificate = coverage.get('certificate')
    if isinstance(certificate, dict):
        reasons = sorted({
            str(reason)
            for partition in certificate.get('partitions') or [] if isinstance(partition, dict)
            for reason in partition.get('reasons') or []
        })
        if reasons:
            details['certificate_reasons'] = reasons
    return details


def finish_source(db_url: str, run_id: str, *, connect: Callable[[str], Any] = postgres_connect) -> None:
    with connect(db_url) as db:
        row = db.execute('select source,status,summary,errors,started_at from public.auction_runs where id=%s', (run_id,)).fetchone()
        source, status, summary, errors, started_at = row
        if source == 'enrichment-queue':
            return
        summary, errors = summary or {}, errors or {}
        coverage = (summary.get('scrape_coverage') or {}).get(source) or {}
        coverage = dict(coverage)
        problems = errors.get(source) or []
        previous = db.execute('select consecutive_failures,last_publication_complete_at,coverage from public.auction_source_state where source_name=%s for update', (source,)).fetchone()
        last_publication_complete_at = previous[1] if len(previous) > 1 else None
        previous_coverage = previous[2] if len(previous) > 2 and isinstance(previous[2], dict) else {}
        # La copie de robots.txt survit à un passage qui ne l'a pas relue (src/sources/robots_policy_copies.py) :
        # la plus récente des deux, 24 h au plus après sa lecture.
        robots_copies = merge_robots_policy_copies(previous_coverage.get(ROBOTS_COPIES_KEY), coverage.get(ROBOTS_COPIES_KEY))
        coverage.pop(ROBOTS_COPIES_KEY, None)
        if robots_copies:
            coverage[ROBOTS_COPIES_KEY] = robots_copies
        # Site injoignable (src/source_suspension.py) : classe de l'échec, sonde espacée, suspension après 72 h. La
        # sonde suppose la copie commune de robots.txt (migration 20261204100000) : sans elle, la collecte relancée
        # referait quatre essais, et l'espacement d'avant reste. PIPELINE_SOURCE_AUTO_SUSPEND=off coupe les deux.
        probe_row = db.execute("select to_regclass('app_private.robots_policies') is not null").fetchone()
        probe_available = bool(probe_row and probe_row[0])
        unreachable = source_suspension.decide(
            previous_coverage, coverage, now=datetime.now(UTC), probe_available=probe_available,
            auto_suspend=source_suspension.auto_suspend_enabled())
        coverage.update(unreachable.coverage())
        denied = access_denied(coverage, problems)
        publication_counts = dict(db.execute("""select decision,count(*)
            from public.auction_collection_items where run_id=%s and source_name=%s group by decision""",
            (run_id, source)).fetchall())
        publication_published = int(publication_counts.get('published', 0))
        publication_pending = sum(int(publication_counts.get(decision, 0)) for decision in PENDING_PUBLICATION_DECISIONS)
        publication_failed = int(publication_counts.get('publication_failed', 0)) + int(publication_counts.get('normalization_failed', 0))
        if publication_failed:
            publication_status = 'failed'
        elif publication_pending:
            publication_status = 'pending'
        elif status == 'failed':
            publication_status = 'partial' if publication_published else 'failed'
        else:
            publication_status = 'complete'
        coverage.update({
            'publication_status': publication_status,
            'publication_pending': publication_pending,
            'publication_published': publication_published,
            'publication_failed': publication_failed,
            'observed_at': datetime.now(UTC).isoformat(),
        })
        scoped_complete = bool(
            coverage.get('scoped_inventory_complete') is True
            or (
                coverage.get('inventory_scope') == 'addressable_public_catalogue'
                and isinstance(coverage.get('certificate'), dict)
                and coverage['certificate'].get('addressable_public_inventory_certified') is True
                and coverage['certificate'].get('all_discovered_announcements_emitted') is True
            )
        )
        global_complete = coverage.get('coverage_complete') is True
        has_progress = bool(
            coverage.get('listings_emitted')
            or publication_published
            or publication_pending
            or publication_failed
        )
        availability = (
            'access_denied' if denied
            else 'unavailable' if (problems or status == 'failed') and not has_progress
            else 'partial' if not global_complete or scoped_complete
            else 'available'
        )
        # A run that ended `succeeded`, published sales and was not refused
        # access is only noisy (for instance one detail page in error): it keeps
        # the ordinary inventory cadence. The retry back-off is reserved for
        # `failed` runs, runs without published progress and access refusals.
        backoff = bool(problems or status == 'failed') and (
            status == 'failed' or denied or not publication_published
        )
        failures = previous[0] + 1 if backoff else 0
        pending = publication_pending
        complete = global_complete
        # Inventaire à prendre en compte pour la publication : l'inventaire public entier, ou, pour les sources qui ne
        # peuvent pas le certifier par nature (SCOPED_PUBLICATION_SOURCES), le catalogue adressable certifié.
        publication_scoped = bool(not complete and source in SCOPED_PUBLICATION_SOURCES and scoped_complete)
        publication_inventory_complete = complete or publication_scoped
        publication_complete = publication_inventory_complete and not pending and status == 'succeeded'
        coverage['publication_scope'] = 'addressable_public_catalogue' if publication_scoped else 'public_catalogue'
        # Pourquoi la publication n'est pas « complète » : sans cela, last_publication_complete_at qui ne bouge plus
        # (Enchères Immobilières, 08/10) ne dit pas laquelle des trois conditions manque, ni quelles décisions
        # restent en suspens.
        blockers = [
            name for name, blocked in (
                ('inventory_incomplete', not publication_inventory_complete),
                ('publication_pending', bool(pending)),
                ('run_not_succeeded', status != 'succeeded'),
            ) if blocked
        ]
        coverage['publication_blockers'] = blockers
        coverage['publication_pending_decisions'] = {
            decision: int(publication_counts.get(decision, 0)) for decision in PENDING_PUBLICATION_DECISIONS
            if publication_counts.get(decision)
        }
        blocker_details: dict[str, Any] = {}
        if 'inventory_incomplete' in blockers:
            blocker_details['inventory_incomplete'] = _inventory_blocker_details(coverage)
        if 'publication_pending' in blockers:
            blocker_details['publication_pending'] = {
                'decisions': coverage['publication_pending_decisions'],
                # Seules les décisions de STUCK_PUBLICATION_DECISIONS persistent d'un run à l'autre ; les autres
                # (découverte, normalisation, admission) se résorbent quand un run va jusqu'au bout.
                'persistent': sum(int(publication_counts.get(d, 0)) for d in STUCK_PUBLICATION_DECISIONS),
            }
            if blocker_details['publication_pending']['persistent']:
                coverage['publication_stuck_items'] = [
                    {'source_url': str(item_url)[:300], 'decision': decision, 'reason': str(item_reason or '')[:200]}
                    for item_url, decision, item_reason in db.execute("""select source_url,decision,reason
                        from public.auction_collection_items
                        where run_id=%s and source_name=%s and decision = any(%s)
                        order by updated_at desc limit %s""",
                        (run_id, source, list(STUCK_PUBLICATION_DECISIONS), STUCK_ITEMS_SAMPLE)).fetchall()
                ]
        if 'run_not_succeeded' in blockers:
            blocker_details['run_not_succeeded'] = {'run_status': status}
        coverage['publication_blocker_details'] = blocker_details
        # Depuis quand : la dernière publication complète connue (None : jamais).
        coverage['publication_blocked_since'] = (
            (last_publication_complete_at.isoformat() if isinstance(last_publication_complete_at, datetime)
             else None) if blockers else None
        )
        if blockers:
            # Une annotation par run : une source figée se voit dans le journal sans ouvrir la base.
            print(f'::warning title=Publication incomplète ({source})::blockers={",".join(blockers)} '
                  f'pending={coverage["publication_pending_decisions"]} '
                  f'last_complete={coverage["publication_blocked_since"]} '
                  f'stop_reason={coverage.get("stop_reason")} '
                  f'stop_cause={_stop_cause(coverage)}')
        now = datetime.now(UTC)
        if backoff:
            # Retry-After and persistent access refusals retain their existing
            # bounded policy and must not be shortened by freshness cadence.
            deadline = next_attempt(failures=failures, access_denied=denied,
                retry_not_before=coverage.get('retry_not_before'), now=now)
            if unreachable.probe_at is not None and not denied:
                # Panne passagère de robots.txt : la collecte suivante est une sonde (une requête), dans 1 à 6 h.
                deadline = max(unreachable.probe_at, aware_timestamp(coverage.get('retry_not_before')) or now)
        else:
            deadline = next_inventory_deadline(
                now=now,
                started_at=started_at,
                source=source,
                evidence_rows=_schedule_evidence_rows(db, run_id, source),
            )
            # A Retry-After announced during a noisy-but-published run is still honoured.
            retry_deadline = aware_timestamp(coverage.get('retry_not_before'))
            if retry_deadline is not None:
                deadline = max(deadline, retry_deadline)
        # Un run en échec (budget épuisé, arrêt brutal) ne prouve rien sur l'absence : seul un run
        # `succeeded` compte comme inventaire complet, sinon le compteur d'absence avancerait, et
        # last_inventory_complete_at (qui autorise le retrait) non plus.
        inventory_complete = complete and status == 'succeeded'
        record_source_presence(db, run_id, source, availability, inventory_complete)
        # Agrasc ne certifie jamais l'inventaire public entier (cartes d'archive vendues sans lien : coverage_complete
        # reste faux). Son inventaire adressable certifié, lui, est complet : il prouve la fraîcheur de la source
        # (last_inventory_complete_at) sans compter pour l'absence ni pour le retrait de ventes (ci-dessus et
        # ci-dessous, inventory_complete seul).
        inventory_fresh = inventory_complete or (scoped_complete and status == 'succeeded')
        suspended_until = deadline if denied or coverage.get('retry_not_before') else None
        if unreachable.suspend_until is not None:
            # 72 h sans réponse : 7 jours sans collecte ni fiche ; rien n'est retiré du catalogue.
            deadline = suspended_until = max(unreachable.suspend_until, suspended_until or unreachable.suspend_until)
            print(f'::warning title=Source suspendue ({source})::{unreachable.suspension_reason}')
        db.execute("""update public.auction_source_state set
            availability=%s,coverage=%s,last_error=%s,consecutive_failures=%s,
            next_inventory_at=%s,suspended_until=%s,
            suspension_reason=case when %s::text is not null then %s::text
                when suspension_reason like %s then null else suspension_reason end,
            last_inventory_complete_at=case when %s then now() else last_inventory_complete_at end,
            last_publication_complete_at=case when %s then now() else last_publication_complete_at end,
            updated_at=now() where source_name=%s and last_run_id=%s""",
            (availability,Jsonb(coverage),json.dumps(problems or errors,ensure_ascii=False)[:2000] if problems or failures else None,
             failures,deadline,suspended_until,
             unreachable.suspension_reason,unreachable.suspension_reason,source_suspension.SUSPENSION_REASON + '%',
             inventory_fresh,publication_complete,source,run_id))
        _sync_source_suspension_alerts(db)
        db.execute("""update public.auction_runs set summary=coalesce(summary,'{}') || %s
            where id=%s""", (Jsonb({'scrape_coverage': {source: coverage}}), run_id))
    # Après le commit, hors de la transaction qui clôt le run : une panne ici ne doit rien défaire.
    # Seulement après un inventaire complet réussi (jamais sur un inventaire partiel).
    if inventory_complete and not denied:
        _withdraw_missing_sales(db_url, run_id, source, connect=connect)
        # Ventes à venir sans date non revues depuis 14 jours (D13) : même condition que le retrait.
        _record_source_absence(db_url, run_id, 'unseen_undated_sales',
                               mark_unseen_undated_sales(db_url, source, connect=connect), connect=connect)
    # Sources désactivées : la même règle, sans condition d'inventaire (décision du propriétaire du 14/11/2026). Elles
    # ne tournent pas : la fin de chaque passage d'une autre source les traite.
    _record_source_absence(db_url, run_id, 'unseen_undated_disabled_sources',
                           mark_unseen_undated_sales_of_disabled_sources(db_url, connect=connect), connect=connect)


def _sync_source_suspension_alerts(db: Any) -> None:
    """Open or close ``pipeline.source.<nom>.suspended_unreachable`` (migration 20261204100000), in a savepoint.

    Before the migration the function is absent and nothing happens; a failure never undoes the source state.
    """
    row = db.execute("select to_regprocedure('app_private.sync_source_suspension_alerts(timestamptz)')").fetchone()
    if not (row and row[0]):
        return
    try:
        with db.transaction():
            db.execute("select app_private.sync_source_suspension_alerts(now())")
    except Exception as exc:  # noqa: BLE001 - l'alerte est secondaire : l'état de la source reste écrit
        print(f'Source suspension alerts not synchronised: {type(exc).__name__}')


def _withdraw_missing_sales(db_url: str, run_id: str, source: str, *, connect: Callable[[str], Any]) -> None:
    """Retire les ventes absentes des deux derniers inventaires complets (src.source_absence)."""
    _record_source_absence(db_url, run_id, 'source_absence', withdraw_missing_sales(db_url, source, connect=connect),
                           connect=connect)


def _record_source_absence(db_url: str, run_id: str, key: str, result: dict[str, Any] | list[Any] | None, *,
                           connect: Callable[[str], Any]) -> None:
    if not result:
        return
    try:
        with connect(db_url) as db:
            db.execute("""update public.auction_runs set summary=coalesce(summary,'{}') || %s
                where id=%s""", (Jsonb({key: result}), run_id))
    except Exception as exc:  # le compte rendu du run est secondaire
        print(f'Source absence summary ({key}) not recorded: {type(exc).__name__}')


def record_source_presence(db, run_id: str, source: str, availability: str, complete: bool) -> None:
    # Only a certified full inventory can establish absence. No deletion follows it.
    db.execute("""insert into app_private.auction_sale_source_presence as current_row(
        sale_id, source_name, availability, state, attempted_at, checked_at, run_id, legacy_raw)
      select s.id, %s::text, %s::text,
        case when %s then case when exists(
          select 1 from public.auction_collection_items i
          where i.run_id=%s and (i.source_url=s.source_url or i.canonical_source_url=s.source_url)
        ) then 'present' else 'absent' end else null end,
        now(), case when %s then now() else null end, %s::text,
        false
      from public.auction_sales s
      where s.source_name=%s
         or exists(select 1 from public.auction_sale_source_presence p
            where p.sale_id=s.id and p.source_name=%s::text)
         or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.observations)='array'
            then s.observations else '[]'::jsonb end) o where o.value->>'source_name'=%s)
         or exists(select 1 from public.auction_collection_items i
            where i.run_id=%s and i.canonical_source_url=s.source_url)
      on conflict (sale_id, source_name) do update set
        availability=excluded.availability,
        state=case when %s then excluded.state else current_row.state end,
        attempted_at=excluded.attempted_at,
        checked_at=case when %s then excluded.checked_at else current_row.checked_at end,
        run_id=excluded.run_id,
        legacy_raw=false""",
        (source, availability, complete, run_id, complete, run_id,
         source, source, source, run_id, complete, complete),
    )
    if complete:
        count_absent_inventories(db, run_id, source)


def count_absent_inventories(db, run_id: str, source: str) -> None:
    """Compte les inventaires COMPLETS consécutifs d'une source où chaque vente est absente.

    À appeler seulement après un inventaire complet (``state`` vient d'être posée pour ce run). Une vente revue
    remet son compteur à zéro. Idempotent pour un même run : ``absent_run_id`` empêche de compter deux fois le
    même inventaire. Une absence n'est comptée que si le dernier inventaire compté pour cette vente (le run
    ``absent_run_id``, sinon ``absent_since``) date d'au moins ``ABSENCE_MIN_INVENTORY_SPACING`` : deux
    inventaires rapprochés de quelques minutes ne comptent que pour un. Les ventes absentes depuis deux
    inventaires complets sont retirées par ``src.source_absence`` (migration 20261028110100).
    """
    db.execute("""update app_private.auction_sale_source_presence as p set
        absent_inventories = case when p.state = 'absent' then p.absent_inventories + 1 else 0 end,
        absent_since = case when p.state = 'absent' then coalesce(p.absent_since, p.checked_at) else null end,
        absent_run_id = case when p.state = 'absent' then %s::text else null end
      from (
        select q.sale_id, coalesce(r.finished_at, r.started_at, q.absent_since) as last_counted_at
        from app_private.auction_sale_source_presence q
        left join public.auction_runs r on r.id::text = q.absent_run_id
        where q.source_name = %s::text
      ) as previous
      where previous.sale_id = p.sale_id
        and p.source_name = %s::text and p.run_id = %s::text and p.checked_at is not null
        and (
          (p.state = 'absent' and p.absent_run_id is distinct from %s::text
            and (previous.last_counted_at is null
              or previous.last_counted_at <= p.checked_at - make_interval(secs => %s)))
          or (p.state = 'present' and (p.absent_inventories > 0 or p.absent_run_id is not null))
        )""", (run_id, source, source, run_id, run_id, ABSENCE_MIN_INVENTORY_SPACING.total_seconds()))


DOCUMENT_READING_BUDGET_SECONDS = 5 * 60
DOCUMENT_BACKLOG_BUDGET_SECONDS = 10 * 60


def _run_optional_pass(label: str, command: list[str], *, env: dict[str, str], timeout: float) -> int:
    """Exit code of a pass that follows the worker; a timeout or a failure to start it counts as 1."""
    try:
        return int(subprocess.run(command, env=env, timeout=timeout, check=False).returncode)
    except Exception as exc:
        # Every failure, whatever its type: an optional pass never changes the run status, its code only goes
        # to the run summary. The type is printed so the job log says why the code is 1.
        print(f'{label} did not finish: {type(exc).__name__}')
        return 1


def _run_document_backlog(env: dict[str, str]) -> int:
    """Bounded catch-up of unread attachments after the enrichment queue (src.document_backlog).

    A PDF job is created only when a sale is republished, and one that exhausted its retries is never
    queued again: until 02/11/2026 only a manual run read those attachments (Cessions de l'État: 37 of
    51 live sales unread). Six sales per tick, each retried at most once a day; the AI reading that
    follows this step reads the texts, so the drain does not run its own. Optional like the reading:
    its exit code is reported in the run summary and never changes the run status.
    """
    command = [sys.executable, '-m', 'src.document_backlog', '--max-sales', '6', '--budget-minutes', '8']
    return _run_optional_pass(
        'Document backlog', command, env={**env, READING_ENABLED_ENV: 'false'},
        timeout=DOCUMENT_BACKLOG_BUDGET_SECONDS,
    )


def _run_document_reading(env: dict[str, str]) -> int:
    """Short « lecture des pièces » pass after the enrichment queue.

    Bounded and optional: its exit code is reported in the run summary and never
    changes the run status.
    """
    command = [sys.executable, '-m', 'src.document_reading', '--max-sales', '15', '--budget-minutes', '4']
    return _run_optional_pass('Document reading', command, env=env, timeout=DOCUMENT_READING_BUDGET_SECONDS)


# Ten minutes of pass (a sale starts only if its two calls, the lock wait and the write still fit), plus one minute
# to start the process: src.document_vision_pass.PASS_TIMEOUT_SECONDS, tied by tests/test_document_vision_pass.py.
DOCUMENT_VISION_BUDGET_SECONDS = 11 * 60


def _run_document_vision(env: dict[str, str]) -> int:
    """Bounded « lecture des pièces par Claude » pass after the Qwen reading (src.document_vision_pass, lot V3b-1).

    Off unless DOCUMENT_VISION_MODE says otherwise (dry_run, write). Ten sales and ten minutes per pass. It makes no
    request to the sites (the pieces come from the local cache of the PDF reading) and runs at the cadence of the
    external passes, which also bounds its model calls. It is the only process that gets the Anthropic API key, taken
    from the runner's own environment (``execute`` leaves it out of every other one). Optional like the reading: its
    exit code is reported in the run summary and never changes the run status.
    """
    command = [sys.executable, '-m', 'src.document_vision_pass', '--max-sales', '10', '--budget-minutes', '10']
    key = os.environ.get(ANTHROPIC_API_KEY_ENV)
    vision_env = {**env, ANTHROPIC_API_KEY_ENV: key} if key else env
    return _run_optional_pass('Document vision', command, env=vision_env, timeout=DOCUMENT_VISION_BUDGET_SECONDS)


ADDRESS_POSITIONS_BUDGET_SECONDS = 6 * 60


def _run_address_positions(env: dict[str, str]) -> int:
    """Bounded « positions » pass after the enrichment queue (src.address_positions).

    Batch BAN geocoding (one CSV request per 250 addresses, 500 sales at most) of the upcoming sales that have a street
    or a locality in their address but only a commune centre or no point. Optional like the document reading: its exit
    code is reported in the run summary and never changes the run status.
    """
    command = [sys.executable, '-m', 'src.address_positions', '--max-sales', '500', '--budget-seconds', '170']
    return _run_optional_pass('Address positions', command, env=env, timeout=ADDRESS_POSITIONS_BUDGET_SECONDS)


PDF_PHOTOS_BUDGET_SECONDS = 6 * 60


def _run_pdf_photos(env: dict[str, str]) -> int:
    """Bounded « photos des pièces jointes » pass after the enrichment queue (src.pdf_photos).

    25 sales per tick at most (nearest sale dates first); the 180 s budget is the real bound. On 02/11/2026 three sales
    (six court-sale specifications, scanned text without photos) took 10 s of the 180: at three per tick the 9 photos of
    a tender read months ahead would have waited days. Each document is read in a
    process without secrets and the photos of the property it holds (maps, logos and diagrams left out) are added to
    the sale's gallery. 180 s of work, so the slowest document still ends well inside the 6-minute timeout. Optional
    like the document reading: its exit code is reported in the run summary and never changes the run status.
    """
    command = [sys.executable, '-m', 'src.pdf_photos', '--max-sales', '25', '--budget-seconds', '180']
    return _run_optional_pass('PDF photos', command, env=env, timeout=PDF_PHOTOS_BUDGET_SECONDS)


LICITOR_HISTORY_BUDGET_SECONDS = 330
# Copie des lots pour les scénarios d'enchères, seule, quand le tick a épuisé son budget (60 s de SQL au plus).
LICITOR_SNAPSHOT_ONLY_SECONDS = 90
LICITOR_SOURCE = 'licitor'
# Temps laissé après la lecture des fiches pour normaliser, publier et clore le run.
LICITOR_BUDGET_MARGIN_SECONDS = 8 * 60
# The collection process ends itself (watchdog, src/stage_watchdog.py) this long before
# the hard kill, so that the log names the blocked step instead of ending on a bare kill.
WATCHDOG_MARGIN_SECONDS = 90


def _run_licitor_history_refresh(env: dict[str, str]) -> int:
    """One tick of the Licitor adjudication history collector (owner decision, 12/10/2026).

    Bounded like the document reading: at most 100 polite requests, its exit code
    is reported in the run summary and never changes the run status.
    """
    command = [sys.executable, '-m', 'src.sources.licitor_history_refresh']
    try:
        result = subprocess.run(command, env=env, timeout=LICITOR_HISTORY_BUDGET_SECONDS, check=False)
        return int(result.returncode)
    except subprocess.TimeoutExpired:
        print('Licitor history did not finish: TimeoutExpired')
        # The tick was stopped before the scenarios' copy of the lots: refresh it alone. Its own code is not
        # reported: the tick already counts as failed.
        _run_optional_pass(
            'Licitor scenarios copy', [*command, '--snapshot-only'], env=env, timeout=LICITOR_SNAPSHOT_ONLY_SECONDS
        )
        return 1
    except Exception as exc:
        # Optional like the other passes: never a run failure (see ``_run_optional_pass``).
        print(f'Licitor history did not finish: {type(exc).__name__}')
        return 1


def _skip_withdrawn_run(db_url: str, run_id: str, source: str, *, connect: Callable[[str], Any]) -> None:
    """Close a scheduled run of a withdrawn source as skipped, without running anything."""
    print(f'Source {source} retirée du catalogue; scheduled run closed without collecting')
    with connect(db_url) as db:
        db.execute("""update public.auction_runs set status='succeeded',finished_at=now(),updated_at=now(),
            summary=coalesce(summary,'{}') || %s where id=%s""",
            (Jsonb({'completion_status': 'skipped', 'skipped_reason': 'source_withdrawn'}), run_id))


# Hard bound of one worker pass: its own budget, plus five minutes to end the batch it holds when the budget ends.
ENRICHMENT_WORKER_OVERRUN_SECONDS = 5 * 60
ENRICHMENT_WORKER_TIMEOUT_SECONDS = ENRICHMENT_BUDGET_SECONDS + ENRICHMENT_WORKER_OVERRUN_SECONDS
# Before it starts, a collection waits for the catalogue writer lock (src.collection_priority) at most as long as a
# worker pass can still hold it. The wait happens before the run is claimed: its lease and budget do not run yet.
COLLECTION_CATALOGUE_PREWAIT_SECONDS = ENRICHMENT_WORKER_TIMEOUT_SECONDS
# An enrichment unit of the separate lane works until its run lease (set by the scheduler in the run summary,
# ``running_lease_seconds``) minus this margin: start-up after the claim, closing writes, and a pass that ends late.
ENRICHMENT_LEASE_MARGIN_SECONDS = 15 * 60
# A valid running_lease_seconds: the same pattern as the lease expiry of claim_autonomous_pipeline_run (SQL anchors it
# with ^ and $; tests/test_pipeline_cadence_invariants.py checks that both read the value with this one rule).
RUNNING_LEASE_SECONDS_PATTERN = r'[1-9][0-9]{0,5}'
# A collection's pre-wait ends this long before the dispatch lease of its queued run (lease_until in its summary).
QUEUED_LEASE_MARGIN_SECONDS = 5 * 60
# An optional pass that contacts a host waits this long at most for the source traffic turn, else it is skipped.
EXTERNAL_PASS_TRAFFIC_WAIT_SECONDS = 60
# A worker pass shorter than this is mostly its finalization margin: the unit ends instead.
ENRICHMENT_MIN_PASS_SECONDS = 5 * 60
# Optional passes that contact an external host (attachments, Licitor history, BAN, the pieces read by Claude) keep
# their daily volume of before the lane, about 17 a day (owner, 17/11/2026: not one more request per site): at most
# once per unit, and only when no enrichment run that ran it finished in the last 24 h / 17. The document reading
# (LLM only) runs every cycle.
EXTERNAL_PASS_MIN_INTERVAL = timedelta(hours=24) / 17
EXTERNAL_PASS_KEYS = frozenset({
    'document_backlog_exit_code', 'address_positions_exit_code', 'pdf_photos_exit_code', 'licitor_history_exit_code',
    'document_vision_exit_code',
})


def _external_pass_due(db_url: str, run_id: str, key: str, *, connect: Callable[[str], Any]) -> bool:
    """True when no other enrichment run that recorded ``key`` finished within ``EXTERNAL_PASS_MIN_INTERVAL``."""
    with connect(db_url) as db:
        row = db.execute("""select max(finished_at) from public.auction_runs
            where source='enrichment-queue' and id<>%s and summary ? %s""", (run_id, key)).fetchone()
    last = aware_timestamp(row[0]) if row and isinstance(row[0], datetime) else None
    return last is None or last <= datetime.now(UTC) - EXTERNAL_PASS_MIN_INTERVAL
ENRICHMENT_WORKER_COMMAND = (sys.executable, '-m', 'src.queued_runner', '--enrichment-only')
# Parallel lane (owner, 17/11/2026): one source-detail worker and PIPELINE_ENRICHMENT_GENERAL_WORKERS general ones.
SOURCE_DETAIL_WORKER_FAMILY = 'source_detail'
GENERAL_WORKER_FAMILY = 'enrichment'
# Exit code of a unit whose lane settings were refused (same as the worker's, src.queued_runner).
LANE_SETTINGS_EXIT_CODE = 3
# The standard ubuntu-24.04 runner has 4 vCPUs: the compute threads of the 1+N workers share them.
RUNNER_CPUS = 4
# Not OMP_THREAD_LIMIT: Tesseract already runs on one thread (src.pdf_ocr, OCR_THREAD_LIMIT, measured faster);
# a share of 4/(N+1) would raise it to 2 threads with one general worker.
THREAD_LIMIT_ENVS = ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
                     'VECLIB_MAXIMUM_THREADS')
# A worker still running when the unit stops (exception, SIGTERM of a cancelled job) gets this long to end.
LANE_WORKER_TERMINATE_SECONDS = 10
# A cycle stops the unit when every worker found nothing left it may claim.
IDLE_WORKER_STOP_REASONS = frozenset({QUEUES_EMPTY_STOP_REASON, LLM_BUDGET_STOP_REASON})
# With two general workers or more, the first one claims document readings first (``--pdf-first``): the readings
# always have a worker that serves them before the fact passes, which wait for them anyway, and the fact passes keep
# the other ones. A single general worker keeps the score order (+24 for a reading), or the fact passes would wait for
# the whole reading backlog while the AI budget goes unused.
PDF_FIRST_WORKER_ARGUMENT = '--pdf-first'


def _worker_failure(code: int) -> str | None:
    if code == WATCHDOG_EXIT_CODE:
        return (
            'Worker watchdog fired: a step stayed blocked until the end of the budget; '
            'see the "WATCHDOG" line and the stage journal in the job log'
        )
    return None


def _run_worker(command: list[str], env: dict[str, str], timeout: float) -> tuple[int, str | None]:
    try:
        code = subprocess.run(command, env=env, timeout=timeout, check=False).returncode
    except subprocess.TimeoutExpired:
        return 1, 'Execution budget exceeded; committed checkpoints preserved'
    except Exception as exc:
        return 1, str(exc)[:1000]
    return code, _worker_failure(code)


@contextmanager
def _catalogue_writer(db_url: str, *, label: str, wait_seconds: float) -> Iterator[bool]:
    """Hold the catalogue writer lock for the block; yields False (without it) when it stayed busy ``wait_seconds``."""
    with ExitStack() as stack:
        try:
            stack.enter_context(catalogue_writer_lock(db_url, label=label, wait_seconds=wait_seconds, heartbeat_seconds=0))
        except CatalogueLockTimeout:
            yield False
            return
        yield True


def _collection_wait_budget(db_url: str, run_id: str, *, connect: Callable[[str], Any]) -> float | None:
    """Seconds a queued scheduled collection may wait before it starts; None for any other run.

    At most ``COLLECTION_CATALOGUE_PREWAIT_SECONDS``, and never past its dispatch lease (lease_until) minus
    ``QUEUED_LEASE_MARGIN_SECONDS``: the scheduler would expire a run that waits longer.
    """
    with connect(db_url) as db:
        row = db.execute("""select source, summary #>> '{github_dispatch,lease_until}' from public.auction_runs
            where id=%s and scheduler_owned and status='queued'""", (run_id,)).fetchone()
    if not row or row[0] == collection_priority.ENRICHMENT_SOURCE:
        return None
    budget = float(COLLECTION_CATALOGUE_PREWAIT_SECONDS)
    lease_until = aware_timestamp(row[1]) if len(row) > 1 else None
    if lease_until is not None:
        left = (lease_until - datetime.now(UTC)).total_seconds() - QUEUED_LEASE_MARGIN_SECONDS
        budget = max(0.0, min(budget, left))
    return budget


def _enrichment_lane_lease_seconds(db_url: str, run_id: str, *, connect: Callable[[str], Any]) -> int | None:
    """Run lease the scheduler gave this enrichment run (migration 20261203100000); None before that migration."""
    with connect(db_url) as db:
        row = db.execute("""select summary->>'running_lease_seconds' from public.auction_runs where id=%s""",
                         (run_id,)).fetchone()
    value = row[0] if row else None
    return int(value) if isinstance(value, str) and re.fullmatch(RUNNING_LEASE_SECONDS_PATTERN, value) else None


@dataclass
class LaneWorker:
    """One worker process of a cycle: its family, how it ended, and its report (``finish_worker_pass``)."""

    family: str
    code: int
    failure: str | None
    seconds: float
    report: dict[str, Any]

    def to_json(self) -> dict[str, Any]:
        report = self.report
        return {
            'family': self.family,
            'exit_code': self.code,
            'seconds': round(self.seconds, 1),
            'stop_reason': report.get('stop_reason'),
            'pdf_first': report.get('pdf_first'),
            'llm_budget_refusals': report.get('llm_budget_refusals'),
            'handled': report.get('handled'),
            'claimed_by_job_type': report.get('claimed_by_job_type'),
            'ocr_seconds': report.get('ocr_seconds'),
            'host_turns': report.get('host_turns'),
            'publication_lock_deferrals': report.get('publication_lock_deferrals'),
        }


def _lane_thread_env(processes: int) -> dict[str, str]:
    """Compute threads per worker (OpenMP, BLAS) so that the 1+N workers share the runner's cores: 4/(N+1)."""
    threads = str(max(1, RUNNER_CPUS // max(1, processes)))
    return {name: threads for name in THREAD_LIMIT_ENVS}


def _relay_output(stream: Any, prefix: str) -> None:
    """Copy a worker's output line by line under its family and number; GitHub commands (``::``) stay unprefixed."""
    for raw in iter(stream.readline, b''):
        line = raw.decode('utf-8', errors='replace').rstrip('\n')
        print(line if line.startswith('::') else f'{prefix} {line}', flush=True)
    stream.close()


def _raise_on_sigterm(signum: int, _frame: Any) -> None:
    raise SystemExit(128 + signum)


def _run_lane_workers(general_workers: int, env: dict[str, str], budget: int, directory: str) -> list[LaneWorker]:
    """Run one source-detail worker and ``general_workers`` general ones side by side; wait for all of them.

    They share the unit's environment, hence its ``AUTONOMOUS_RUN_ID``: the AI cap per execution
    (``reserve_pipeline_prediction``, 90 calls per 30 minutes) stays the unit's. A failed or killed worker does
    not stop the others; each is bounded by the same budget plus the overrun. Their output is prefixed with
    ``[family#n]``. If the unit itself stops (exception, SIGTERM), the workers still running are terminated. With two
    general workers or more, the first one claims document readings first (``PDF_FIRST_WORKER_ARGUMENT``).
    """
    families = [SOURCE_DETAIL_WORKER_FAMILY] + [GENERAL_WORKER_FAMILY] * general_workers
    worker_env = {**env, ENRICHMENT_BUDGET_SECONDS_ENV: str(budget), **_lane_thread_env(len(families))}
    started = time.monotonic()
    timeout = budget + ENRICHMENT_WORKER_OVERRUN_SECONDS
    running: list[tuple[str, str, subprocess.Popen[bytes] | None, str | None]] = []
    relays: list[threading.Thread] = []
    previous_sigterm = None
    if threading.current_thread() is threading.main_thread():
        previous_sigterm = signal.signal(signal.SIGTERM, _raise_on_sigterm)
    try:
        for index, family in enumerate(families):
            report_path = os.path.join(directory, f'report-{index}-{family}.json')
            command = [*ENRICHMENT_WORKER_COMMAND, '--family', family]
            if family == GENERAL_WORKER_FAMILY and index == 1 and general_workers >= 2:
                command.append(PDF_FIRST_WORKER_ARGUMENT)
            try:
                process = subprocess.Popen(command, env={**worker_env, ENRICHMENT_WORKER_REPORT_ENV: report_path},
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            except Exception as exc:
                running.append((family, report_path, None, str(exc)[:1000]))
                continue
            running.append((family, report_path, process, None))
            if process.stdout is not None:
                relay = threading.Thread(target=_relay_output, args=(process.stdout, f'[{family}#{index}]'),
                                         name=f'lane-output-{index}', daemon=True)
                relay.start()
                relays.append(relay)
        workers: list[LaneWorker] = []
        for family, report_path, process, start_failure in running:
            failure = start_failure
            if process is None:
                code = 1
            else:
                try:
                    code = process.wait(timeout=max(0.0, started + timeout - time.monotonic()))
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    code, failure = 1, 'Execution budget exceeded; committed checkpoints preserved'
                else:
                    failure = _worker_failure(code)
            if code and failure is None:
                failure = f'Worker ({family}) exited with status {code}'
            workers.append(LaneWorker(family, code, failure, time.monotonic() - started,
                                      read_worker_report(report_path) or {}))
        return workers
    finally:
        alive = [process for _, _, process, _ in running if process is not None and process.poll() is None]
        for process in alive:
            process.terminate()
        for process in alive:
            try:
                process.wait(timeout=LANE_WORKER_TERMINATE_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for relay in relays:
            relay.join(timeout=5)
        if previous_sigterm is not None:
            signal.signal(signal.SIGTERM, previous_sigterm)


def _cycle_stop_reason(workers: list[LaneWorker]) -> str | None:
    """One stop reason for the cycle: None when a report is missing, a collection when one worker yielded to it, the
    first worker's that still had work (an idle source-detail worker never ends the unit while a general one ran to
    its budget), and when no worker had anything left to claim: ``llm_budget_exhausted`` if fact passes refused by the
    AI budget are left, ``queues_empty`` only otherwise."""
    reasons = [worker.report.get('stop_reason') for worker in workers]
    if any(not isinstance(reason, str) for reason in reasons):
        return None
    if COLLECTION_PENDING_STOP_REASON in reasons:
        return COLLECTION_PENDING_STOP_REASON
    busy = [str(reason) for reason in reasons if reason not in IDLE_WORKER_STOP_REASONS]
    if busy:
        return busy[0]
    return LLM_BUDGET_STOP_REASON if LLM_BUDGET_STOP_REASON in reasons else QUEUES_EMPTY_STOP_REASON


@dataclass
class EnrichmentUnit:
    """What one scheduled enrichment unit did: one worker pass and its optional passes per cycle."""

    worker_code: int = 0
    failure: str | None = None
    # Last exit code of each optional pass, under the run summary keys used since they exist.
    exit_codes: dict[str, int] = field(default_factory=dict)
    cycles: list[dict[str, Any]] = field(default_factory=list)
    collection_wait_seconds: float = 0.0
    stop_reason: str = 'single_cycle'


def _run_enrichment_cycle(env: dict[str, str], unit: EnrichmentUnit, *, db_url: str, budget: int,
                          deadline: float | None, licitor_withdrawn: bool,
                          external_pass_due: Callable[[str], bool], general_workers: int = 0) -> str | None:
    """One worker pass, then the optional passes; returns the worker's stop reason (None: no report).

    ``general_workers`` (parallel lane): the pass is one source-detail worker and that many general workers side by
    side, and the optional passes start once all of them have ended. 0: the mixed worker alone, as before.
    """
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='enrichment-worker-') as directory:
        if general_workers:
            workers = _run_lane_workers(general_workers, env, budget, directory)
        else:
            report_path = os.path.join(directory, 'report.json')
            code, failure = _run_worker(
                list(ENRICHMENT_WORKER_COMMAND),
                {**env, ENRICHMENT_BUDGET_SECONDS_ENV: str(budget), ENRICHMENT_WORKER_REPORT_ENV: report_path},
                budget + ENRICHMENT_WORKER_OVERRUN_SECONDS,
            )
            report = read_worker_report(report_path) or {}
    if general_workers:
        failed = next((worker for worker in workers if worker.code), None)
        code, failure = (failed.code, failed.failure) if failed else (0, None)
        worker_stop = _cycle_stop_reason(workers)
        handled_by_family: dict[str, int] = {}
        for worker in workers:
            for family, count in (worker.report.get('handled_by_family') or {}).items():
                handled_by_family[family] = handled_by_family.get(family, 0) + int(count or 0)
        report = {'handled': sum(int(worker.report.get('handled') or 0) for worker in workers),
                  'handled_by_family': handled_by_family}
    else:
        worker_stop = report.get('stop_reason') if isinstance(report.get('stop_reason'), str) else None
    if code:
        unit.worker_code, unit.failure = code, failure
    cycle: dict[str, Any] = {
        'worker_exit_code': code,
        'worker_seconds': round(time.monotonic() - started, 1),
        'worker_stop_reason': worker_stop,
        'worker_handled': report.get('handled'),
        'worker_handled_by_family': report.get('handled_by_family'),
    }
    if general_workers:
        cycle['workers'] = [worker.to_json() for worker in workers]
    # A failed worker leaves the catalogue in an unknown state: the passes that read or write it wait for the next
    # cycle. The Licitor history tick does not depend on the queue and keeps running, as before.
    passes: list[tuple[str, Callable[[dict[str, str]], int], float]] = []
    if code == 0:
        passes += [
            ('document_backlog_exit_code', _run_document_backlog, DOCUMENT_BACKLOG_BUDGET_SECONDS),
            ('document_reading_exit_code', _run_document_reading, DOCUMENT_READING_BUDGET_SECONDS),
            ('document_vision_exit_code', _run_document_vision, DOCUMENT_VISION_BUDGET_SECONDS),
            ('address_positions_exit_code', _run_address_positions, ADDRESS_POSITIONS_BUDGET_SECONDS),
            ('pdf_photos_exit_code', _run_pdf_photos, PDF_PHOTOS_BUDGET_SECONDS),
        ]
    if not licitor_withdrawn:
        passes.append(('licitor_history_exit_code', _run_licitor_history_refresh,
                       LICITOR_HISTORY_BUDGET_SECONDS + LICITOR_SNAPSHOT_ONLY_SECONDS))
    skipped: dict[str, str] = {}
    for key, run_pass, timeout in passes:
        if deadline is not None and deadline - time.monotonic() < timeout:
            skipped[key] = 'unit_budget'
        elif key in EXTERNAL_PASS_KEYS and (key in unit.exit_codes or not external_pass_due(key)):
            skipped[key] = 'site_cadence'
        elif collection_priority.collection_pending_now():
            # Never next to a collection: the passes also fetch from the sources (attachments, Licitor history).
            skipped[key] = COLLECTION_PENDING_STOP_REASON
        elif key in EXTERNAL_PASS_KEYS:
            # One process at a time talks to the sources (src.source_traffic): a collection that starts now waits.
            with source_traffic.source_traffic_turn(
                db_url, label=key, wait_seconds=EXTERNAL_PASS_TRAFFIC_WAIT_SECONDS
            ) as turn:
                if turn:
                    unit.exit_codes[key] = run_pass(env)
                else:
                    skipped[key] = 'source_traffic_busy'
        else:
            unit.exit_codes[key] = run_pass(env)
    if skipped:
        cycle['passes_skipped'] = skipped
    cycle['seconds'] = round(time.monotonic() - started, 1)
    unit.cycles.append(cycle)
    return worker_stop


def _run_enrichment_unit(env: dict[str, str], *, db_url: str, unit_seconds: int | None, licitor_withdrawn: bool,
                         external_pass_due: Callable[[str], bool], general_workers: int = 0) -> EnrichmentUnit:
    """Run the enrichment queue for one scheduled unit.

    Without ``unit_seconds`` (a run dispatched before the separate lane existed): one cycle, as before. With it, the
    unit chains cycles until its deadline, waits while a collection is pending, and ends when the worker failed, found
    nothing left to claim (the queues empty, or only fact passes refused by the AI budget) or left no report.
    """
    unit = EnrichmentUnit()
    deadline = None if unit_seconds is None else time.monotonic() + unit_seconds
    while True:
        budget = ENRICHMENT_BUDGET_SECONDS
        if deadline is not None:
            waited = time.monotonic()
            collection_priority.wait_while_collection_pending(deadline=deadline)
            # The collection's end (photo copy, closing writes) still holds the source traffic turn: wait for it too,
            # or the worker would yield again at once.
            with source_traffic.source_traffic_turn(
                db_url, label='enrichment unit', wait_seconds=max(1.0, deadline - time.monotonic())
            ) as turn:
                pass
            unit.collection_wait_seconds += time.monotonic() - waited
            budget = min(budget, int(deadline - time.monotonic()) - ENRICHMENT_WORKER_OVERRUN_SECONDS)
            if budget < ENRICHMENT_MIN_PASS_SECONDS:
                unit.stop_reason = 'unit_budget'
                break
            if not turn:
                # Still busy (wait cut short): the workers would yield at once. The unit ends cleanly instead.
                unit.stop_reason = 'source_traffic_busy'
                break
        worker_stop = _run_enrichment_cycle(
            env, unit, db_url=db_url, budget=budget, deadline=deadline, licitor_withdrawn=licitor_withdrawn,
            external_pass_due=external_pass_due, general_workers=general_workers,
        )
        if deadline is None:
            break
        if unit.worker_code:
            unit.stop_reason = 'worker_failed'
            break
        if worker_stop is None:
            unit.stop_reason = 'worker_report_missing'
            break
        if worker_stop in IDLE_WORKER_STOP_REASONS:
            unit.stop_reason = worker_stop
            break
    return unit


def execute(run_id: str, *, enrichment_lane: bool = False,
            connect: Callable[[str], Any] = postgres_connect) -> int:
    """Run one scheduled unit; ``enrichment_lane``: dispatched in the enrichment queue's own concurrency group."""
    run_id = str(UUID(run_id))
    settings = load_settings()
    db_url = str(settings.get('supabase_db_url') or '')
    if not db_url:
        raise RuntimeError('Automatic execution requires transactional PostgreSQL')
    wait_budget = _collection_wait_budget(db_url, run_id, connect=connect)
    if wait_budget is None:
        return _execute_claimed(run_id, db_url, enrichment_lane=enrichment_lane, prewait=None, connect=connect)
    # A scheduled collection: take the source traffic turn (the queue worker ends the batch it holds, its optional
    # passes end) and wait for the catalogue writer lock, before the run is claimed and its budget runs. The turn is
    # kept until the end-of-collection writes. Past the wait budget the collection starts anyway, as before the lanes.
    started = time.monotonic()
    deadline = started + wait_budget
    with source_traffic.source_traffic_turn(
        db_url, label='scheduled collection', wait_seconds=max(1.0, deadline - started)
    ) as turn:
        with _catalogue_writer(
            db_url, label='scheduled collection (before start)', wait_seconds=max(1.0, deadline - time.monotonic())
        ) as free:
            pass
        prewait = {'seconds': round(time.monotonic() - started, 1), 'budget_seconds': round(wait_budget, 1),
                   'timed_out': not (turn and free)}
        return _execute_claimed(run_id, db_url, enrichment_lane=enrichment_lane, prewait=prewait, connect=connect)


def _execute_claimed(run_id: str, db_url: str, *, enrichment_lane: bool, prewait: dict[str, Any] | None,
                     connect: Callable[[str], Any]) -> int:
    collection_prewait = prewait
    # Claim once even when GitHub dispatch was retried after an uncertain response.
    with connect(db_url) as db:
        row = db.execute("""update public.auction_runs set status='running',started_at=now(),updated_at=now()
            where id=%s and scheduler_owned and status='queued' returning source""", (run_id,)).fetchone()
    if not row:
        print('Scheduled run already claimed, finished or invalid; nothing to execute')
        return 0
    source = row[0]
    withdrawn = source_withdrawal.withdrawn_sources(db_url)
    if source in withdrawn:
        # Source retirée du catalogue entre le lancement et l'exécution : aucune requête, aucun
        # échec, et finish_source n'est pas appelé (pas de recul, pas d'alerte « source manquée »).
        _skip_withdrawn_run(db_url, run_id, source, connect=connect)
        return 0
    register_run(run_id)
    env = {
        **os.environ,
        AUTONOMOUS_RUN_ID_ENV: run_id,
        # Les plafonds du travailleur et le délai d'annulation par défaut : une valeur héritée du job est écrasée.
        ENRICHMENT_BUDGET_SECONDS_ENV: str(ENRICHMENT_BUDGET_SECONDS),
        ENRICHMENT_MAX_JOBS_ENV: str(ENRICHMENT_MAX_JOBS),
        REPLICATE_CANCEL_AFTER_ENV: DEFAULT_REPLICATE_CANCEL_AFTER,
        # Une unité planifiée a un budget de quelques minutes et saute déjà les traitements lourds
        # (--no-heavy-enrichment, --no-llm) : elle ne fait pas non plus les appels à IGN Cadastre et
        # ADEME DPE, dont l'API publique limite les appels (README, « Enrichissement DPE ADEME »).
        # Ces enrichissements restent faits par la collecte complète lancée à la main (src.main).
        CADASTRE_ENRICH_ENABLED_ENV: 'false',
        DPE_ENRICH_ENABLED_ENV: 'false',
        # A scheduled unit must not sit on the catalogue writer lock for
        # long (its budget is minutes); a busy catalogue fails the unit fast.
        LOCK_WAIT_ENV: '300',
    }
    # A native crash (« Worker exited with status -11 ») otherwise leaves no Python stack in the job log.
    env['PYTHONFAULTHANDLER'] = '1'
    # The Anthropic API key goes to the reading of the pieces by Claude alone (_run_document_vision): neither the
    # collection, nor the workers that open untrusted PDFs, nor the other passes get it.
    env.pop(ANTHROPIC_API_KEY_ENV, None)
    failure = None
    execution_started = datetime.now(UTC)
    unit: EnrichmentUnit | None = None
    general_workers = 0
    if source == 'enrichment-queue':
        # The separate lane (own GitHub concurrency group, lease written by the scheduler) chains cycles until its
        # lease; otherwise one cycle, as before the lane existed (old scheduler or old dispatcher still deployed).
        lease = _enrichment_lane_lease_seconds(db_url, run_id, connect=connect) if enrichment_lane else None
        unit_seconds = lease - ENRICHMENT_LEASE_MARGIN_SECONDS if lease else None
        budget = unit_seconds or ENRICHMENT_WORKER_TIMEOUT_SECONDS
        try:
            # Parallel lane settings (src.enrichment_lane_settings): checked before any worker starts.
            general_workers = lane_settings().general_workers
        except LaneSettingsError as exc:
            print(f"::error title=Réglages de la voie d'enrichissement refusés::{exc}", flush=True)
            code, failure = LANE_SETTINGS_EXIT_CODE, f'Enrichment lane settings refused: {exc}'
        else:
            unit = _run_enrichment_unit(
                env, db_url=db_url, unit_seconds=unit_seconds, licitor_withdrawn=LICITOR_SOURCE in withdrawn,
                external_pass_due=lambda key: _external_pass_due(db_url, run_id, key, connect=connect),
                general_workers=general_workers,
            )
            code, failure = unit.worker_code, unit.failure
    else:
        if source not in SOURCE_NAMES:
            raise ValueError('Unknown scheduled source')
        command = [sys.executable,'-m','src.main','--source',source,'--run-id',run_id,'--no-llm','--no-heavy-enrichment']
        # Licitor's full public inventory took about 27 minutes to collect on
        # 2026-09-21, leaving too little of the ordinary budget to publish it.
        budget = (50 if source == 'licitor' else 35) * 60
        env[WATCHDOG_ENV] = str(budget - WATCHDOG_MARGIN_SECONDS)
        if source == 'petites_affiches':
            # Leave time for the main process to flush factual publications and
            # persist the partial run before the scheduler's hard kill.
            env[PETITES_AFFICHES_SOURCE_BUDGET_ENV] = str(budget - 5 * 60)
        if source == LICITOR_SOURCE:
            # Same contract: the detail pages (sequential, spaced) of a national
            # inventory can outlast the scheduler budget, which killed eight runs
            # in a row. The source stops reading details LICITOR_BUDGET_MARGIN_SECONDS
            # before the hard kill, publishes the whole list and resumes next run.
            env[LICITOR_SOURCE_BUDGET_ENV] = str(budget - LICITOR_BUDGET_MARGIN_SECONDS)
        code, failure = _run_worker(command, env, budget)
    worker_code = code
    # Exit 2 from src.main means "published, but an enabled source was empty or
    # failed": the run itself succeeded, so keep it succeeded and hand the
    # warning to the workflow instead of recording a worker failure.
    source_warning = source != 'enrichment-queue' and code == SOURCE_WARNING_EXIT_CODE
    if source_warning:
        code = worker_code = 0
    with ExitStack() as end_writes:
        # src.main released the catalogue writer lock when it ended. The closing writes of a collection (run close,
        # source state, presence, absences, withdrawals) take it again, so no queue worker writes a sale meanwhile.
        if source != 'enrichment-queue' and not end_writes.enter_context(_catalogue_writer(
                db_url, label=f'collection end ({source})', wait_seconds=COLLECTION_CATALOGUE_PREWAIT_SECONDS)):
            print(f'::warning title=Fin de collecte hors verrou ({source})::catalogue writer lock still busy')
        with connect(db_url) as db:
            existing_summary = db.execute('select summary from public.auction_runs where id=%s', (run_id,)).fetchone()[0] or {}
            summary = {"scheduler_budget_seconds":budget,"execution_seconds":(datetime.now(UTC)-execution_started).total_seconds(),
                       "worker_exit_code": SOURCE_WARNING_EXIT_CODE if source_warning else worker_code}
            if source_warning:
                summary["source_warning"] = True
            if collection_prewait is not None:
                summary["catalogue_prewait"] = collection_prewait
            if unit is not None:
                summary.update(unit.exit_codes)
                summary["enrichment_unit"] = {
                    "mode": "lane" if unit_seconds else "single_cycle",
                    "unit_seconds": unit_seconds,
                    "stop_reason": unit.stop_reason,
                    "collection_wait_seconds": round(unit.collection_wait_seconds, 1),
                    "cycles": unit.cycles,
                }
                if general_workers:
                    # 1 source-detail worker + N general workers per cycle (each cycle lists them under "workers").
                    summary["enrichment_unit"]["general_workers"] = general_workers
            if source == 'enrichment-queue' and LICITOR_SOURCE in withdrawn:
                summary["licitor_history_skipped"] = "source_withdrawn"
            run_errors: dict[str, list[str]] = {}
            counts: dict[object, object] = {}
            exhausted = 0
            if worker_code:
                run_errors['runner'] = [failure or f'Worker exited with status {worker_code}']
            if source == 'enrichment-queue':
                counts = dict(db.execute("select status,count(*) from public.auction_enrichment_jobs where updated_at>=%s group by status", (execution_started,)).fetchall())
                summary['enrichment_jobs'] = counts
                # Per job type and final status (measure of the separate lane, docs/runbooks/pipeline-enrichment-stalled.md).
                by_type = db.execute("""select coalesce(jsonb_object_agg(job_type, statuses), '{}'::jsonb) from (
                        select job_type, jsonb_object_agg(status, jobs) as statuses from (
                            select job_type, status, count(*) as jobs from public.auction_enrichment_jobs
                             where updated_at>=%s group by job_type, status) per_status
                         group by job_type) per_type""", (execution_started,)).fetchone()
                summary['enrichment_jobs_by_type'] = by_type[0] if by_type and isinstance(by_type[0], dict) else {}
                exhausted = db.execute("""select count(*) from public.auction_enrichment_jobs
                    where updated_at>=%s and status='failed' and attempt_count>=max_attempts""",
                    (execution_started,)).fetchone()[0]
                summary['enrichment_jobs_exhausted'] = exhausted
                completed = _enrichment_completed(counts)
                summary['enrichment_jobs_completed'] = completed
                summary['enrichment_jobs_terminal'] = _enrichment_terminal(counts)
                if exhausted:
                    exhausted_rows = db.execute("""select id,job_type,attempt_count,max_attempts
                        from public.auction_enrichment_jobs
                        where updated_at>=%s and status='failed' and attempt_count>=max_attempts
                        order by updated_at desc limit 20""", (execution_started,)).fetchall()
                    summary['enrichment_jobs_exhausted_details'] = [
                        _enrichment_exhausted_detail(row) for row in (exhausted_rows or [])
                    ]
                    exhaustion_message = f'{exhausted} enrichment job(s) exhausted their retry budget'
                    run_errors['enrichment_jobs'] = [exhaustion_message]
                    # The completion-status decision below requires at least one
                    # successfully completed job. Never replace a non-zero worker
                    # code; its systemic failure must remain visible.
                    if worker_code == 0 and completed == 0:
                        code, failure = 1, 'Exhausted enrichment jobs reported without worker progress'
                        run_errors['runner'] = [failure]
            existing_completion = existing_summary.get('completion_status') if isinstance(existing_summary, dict) else None
            existing_coverage = (existing_summary.get('scrape_coverage') or {}).get(source, {}) if isinstance(existing_summary, dict) else {}
            source_budget_stop = bool(isinstance(existing_coverage, dict) and existing_coverage.get('budget_exhausted'))
            # A source can finish its bounded collection and publish a useful
            # partial result with exit code 0. Preserve that explicit status instead
            # of replacing it with the scheduler's transport status.
            if source == 'enrichment-queue' and worker_code:
                summary['completion_status'] = 'interrupted'
            elif source == 'enrichment-queue' and exhausted and worker_code == 0 and _enrichment_completed(counts) > 0:
                summary['completion_status'] = 'partial_success'
            elif source_budget_stop:
                summary['completion_status'] = 'partial_success'
                summary['stop_reason'] = 'source_budget_exhausted'
            elif existing_completion in {'partial_success', 'partial', 'scoped_partial', 'incomplete'}:
                summary['completion_status'] = existing_completion
            elif source == 'enrichment-queue' and exhausted:
                summary['completion_status'] = 'interrupted' if worker_code else 'retry_exhausted'
            elif code:
                summary['completion_status'] = 'interrupted'
            elif source == 'enrichment-queue' and counts.get('failed'):
                summary['completion_status'] = 'partial_success'
            else:
                summary['completion_status'] = 'complete'
            if source == 'enrichment-queue' and counts.get('failed') and 'enrichment_jobs' not in run_errors:
                run_errors['enrichment_jobs'] = [
                    f"{int(counts.get('failed') or 0)} enrichment job(s) failed and remain retryable"
                ]
            close_open_run(db, run_id, 'failed' if code else 'succeeded', summary, run_errors)
            # src.main closes its own run: close_open_run then leaves it as it is, and the scheduler facts and errors are
            # still added.
            merge_into_run_report(db, run_id, summary, run_errors)
        finish_source(db_url, run_id, connect=connect)
    return SOURCE_WARNING_EXIT_CODE if source_warning and not code else code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--enrichment-lane', action='store_true',
                        help="the unit runs in the enrichment queue's own concurrency group (separate lane)")
    arguments = parser.parse_args()
    raise SystemExit(execute(arguments.run_id, enrichment_lane=arguments.enrichment_lane))
