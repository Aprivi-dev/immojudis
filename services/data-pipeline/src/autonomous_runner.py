"""Execute one SQL-scheduled unit with a hard process budget and durable status."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from src import source_withdrawal
from src.config import load_settings
from src.run_finalizer import register_run
from src.source_absence import withdraw_missing_sales
from src.source_health import SOURCE_WARNING_EXIT_CODE
from src.stage_watchdog import WATCHDOG_ENV, WATCHDOG_EXIT_CODE
from src.storage.supabase_client import connect

# Alias de compatibilité : des tests patchent ce nom de module.
_postgres_connect = connect

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


def _retry_not_before_deadline(value: str | None) -> datetime | None:
    """Parse a source's Retry-After deadline; ``None`` when absent or unusable."""
    if not value:
        return None
    try:
        other = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return other if other.tzinfo else None


def next_attempt(*, failures: int, access_denied: bool, retry_not_before: str | None,
                 now: datetime) -> datetime:
    delay = timedelta(hours=24) if access_denied and failures >= 2 else timedelta(minutes=min(360, 15 * 2 ** min(failures, 5)))
    deadline = now + delay
    other = _retry_not_before_deadline(retry_not_before)
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


def _aware_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        candidate = value
    elif isinstance(value, str):
        try:
            candidate = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            return None
    else:
        return None
    if candidate.tzinfo is None or candidate.utcoffset() is None:
        return None
    return candidate.astimezone(UTC)


def _near_sale(row: dict[str, object], now: datetime) -> bool:
    evidence = row.get('evidence')
    evidence = evidence if isinstance(evidence, dict) else {}
    status = str(row.get('status') or evidence.get('status') or '').lower()
    if status not in ACTIVE_LISTING_STATUSES:
        return False
    sale_date = _aware_timestamp(row.get('sale_date')) or _aware_timestamp(evidence.get('sale_date'))
    return sale_date is not None and now <= sale_date <= now + NEAR_SALE_HORIZON


def _source_check_times(payload: object, *, source: str, source_url: str, now: datetime,
                        allow_checkpoint_checked_at: bool = False) -> list[datetime]:
    if not isinstance(payload, dict):
        return []
    result: list[datetime] = []
    if allow_checkpoint_checked_at:
        checkpoint_checked_at = _aware_timestamp(payload.get('_checkpoint_checked_at'))
        if checkpoint_checked_at is not None and checkpoint_checked_at <= now:
            result.append(checkpoint_checked_at)
    checks = payload.get('source_checks')
    if isinstance(checks, dict):
        check = checks.get(source_url)
        if isinstance(check, dict) and (not check.get('source_name') or check.get('source_name') == source):
            checked_at = _aware_timestamp(check.get('checked_at'))
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
    current = _aware_timestamp(now)
    if current is None:
        raise ValueError('now must be timezone-aware')
    run_started = _aware_timestamp(started_at)
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


def finish_source(db_url: str, run_id: str) -> None:
    with _postgres_connect(db_url) as db:
        row = db.execute('select source,status,summary,errors,started_at from public.auction_runs where id=%s', (run_id,)).fetchone()
        source, status, summary, errors, started_at = row
        if source == 'enrichment-queue':
            return
        summary, errors = summary or {}, errors or {}
        coverage = (summary.get('scrape_coverage') or {}).get(source) or {}
        coverage = dict(coverage)
        problems = errors.get(source) or []
        previous = db.execute('select consecutive_failures from public.auction_source_state where source_name=%s for update', (source,)).fetchone()
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
        publication_complete = complete and not pending and status == 'succeeded'
        # Pourquoi la publication n'est pas « complète » : sans cela, last_publication_complete_at qui ne bouge plus
        # (Enchères Immobilières, 08/10) ne dit pas laquelle des trois conditions manque, ni quelles décisions
        # restent en suspens.
        coverage['publication_blockers'] = [
            name for name, blocked in (
                ('inventory_incomplete', not complete),
                ('publication_pending', bool(pending)),
                ('run_not_succeeded', status != 'succeeded'),
            ) if blocked
        ]
        coverage['publication_pending_decisions'] = {
            decision: int(publication_counts.get(decision, 0)) for decision in PENDING_PUBLICATION_DECISIONS
            if publication_counts.get(decision)
        }
        now = datetime.now(UTC)
        if backoff:
            # Retry-After and persistent access refusals retain their existing
            # bounded policy and must not be shortened by freshness cadence.
            deadline = next_attempt(failures=failures, access_denied=denied,
                retry_not_before=coverage.get('retry_not_before'), now=now)
        else:
            deadline = next_inventory_deadline(
                now=now,
                started_at=started_at,
                source=source,
                evidence_rows=_schedule_evidence_rows(db, run_id, source),
            )
            # A Retry-After announced during a noisy-but-published run is still honoured.
            retry_deadline = _retry_not_before_deadline(coverage.get('retry_not_before'))
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
        db.execute("""update public.auction_source_state set
            availability=%s,coverage=%s,last_error=%s,consecutive_failures=%s,
            next_inventory_at=%s,suspended_until=%s,
            last_inventory_complete_at=case when %s then now() else last_inventory_complete_at end,
            last_publication_complete_at=case when %s then now() else last_publication_complete_at end,
            updated_at=now() where source_name=%s and last_run_id=%s""",
            (availability,Jsonb(coverage),json.dumps(problems or errors,ensure_ascii=False)[:2000] if problems or failures else None,
             failures,deadline,deadline if denied or coverage.get('retry_not_before') else None,
             inventory_fresh,publication_complete,source,run_id))
        db.execute("""update public.auction_runs set summary=coalesce(summary,'{}') || %s
            where id=%s""", (Jsonb({'scrape_coverage': {source: coverage}}), run_id))
    # Après le commit, hors de la transaction qui clôt le run : une panne ici ne doit rien défaire.
    # Seulement après un inventaire complet réussi (jamais sur un inventaire partiel).
    if inventory_complete and not denied:
        _withdraw_missing_sales(db_url, run_id, source)


def _withdraw_missing_sales(db_url: str, run_id: str, source: str) -> None:
    """Retire les ventes absentes des deux derniers inventaires complets (src.source_absence)."""
    result = withdraw_missing_sales(db_url, source, connect=_postgres_connect)
    if result is None:
        return
    try:
        with _postgres_connect(db_url) as db:
            db.execute("""update public.auction_runs set summary=coalesce(summary,'{}') || %s
                where id=%s""", (Jsonb({'source_absence': result}), run_id))
    except Exception as exc:  # le compte rendu du run est secondaire
        print(f'Source absence summary not recorded: {type(exc).__name__}')


def record_source_presence(db, run_id: str, source: str, availability: str, complete: bool) -> None:
    # Only a certified full inventory can establish absence. No deletion follows it.
    # New deployments can provide the compact projection without making the
    # Python rollout depend on migration order. Until that projection exists,
    # retain the legacy raw_payload path byte-for-byte for compatibility with
    # existing views and older databases.
    compact_objects = db.execute(
        "select to_regclass(%s), to_regprocedure(%s), exists(select 1 from pg_catalog.pg_attribute"
        " where attrelid = to_regclass(%s) and attname = 'absent_inventories' and not attisdropped)",
        (
            "app_private.auction_sale_source_presence",
            "app_private.auction_sale_source_presence_json(uuid)",
            "app_private.auction_sale_source_presence",
        ),
    ).fetchone()
    if compact_objects and compact_objects[0] and compact_objects[1]:
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
        if complete and len(compact_objects) > 2 and compact_objects[2]:
            count_absent_inventories(db, run_id, source)
        return
    db.execute("""update public.auction_sales s set raw_payload=jsonb_set(
        coalesce(s.raw_payload,'{}'),'{source_presence}',
        coalesce(s.raw_payload->'source_presence','{}') || jsonb_build_object(%s::text,
          coalesce(s.raw_payload->'source_presence'->%s::text,'{}') || jsonb_build_object(
            'availability',%s::text,'attempted_at',now(),'run_id',%s::text)
          || case when %s then jsonb_build_object(
            'state',case when exists(select 1 from public.auction_collection_items i
              where i.run_id=%s and (i.source_url=s.source_url or i.canonical_source_url=s.source_url))
              then 'present' else 'absent' end,'checked_at',now()) else '{}'::jsonb end))
        where s.source_name=%s or s.raw_payload->'source_presence' ? %s
          or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.observations)='array'
            then s.observations else '[]'::jsonb end) o where o.value->>'source_name'=%s)
          or exists(select 1 from public.auction_collection_items i
          where i.run_id=%s and i.canonical_source_url=s.source_url)""",
        (source,source,availability,run_id,complete,run_id,source,source,source,run_id))


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


def _run_document_reading(env: dict[str, str]) -> int:
    """Short « lecture des pièces » pass after the enrichment queue.

    Bounded and optional: its exit code is reported in the run summary and never
    changes the run status.
    """
    command = [sys.executable, '-m', 'src.document_reading', '--max-sales', '15', '--budget-minutes', '4']
    try:
        result = subprocess.run(command, env=env, timeout=DOCUMENT_READING_BUDGET_SECONDS, check=False)
        return int(result.returncode)
    except Exception:
        return 1


LICITOR_HISTORY_BUDGET_SECONDS = 330
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
    except Exception:
        return 1


def _skip_withdrawn_run(db_url: str, run_id: str, source: str) -> None:
    """Close a scheduled run of a withdrawn source as skipped, without running anything."""
    print(f'Source {source} retirée du catalogue; scheduled run closed without collecting')
    with _postgres_connect(db_url) as db:
        db.execute("""update public.auction_runs set status='succeeded',finished_at=now(),updated_at=now(),
            summary=coalesce(summary,'{}') || %s where id=%s""",
            (Jsonb({'completion_status': 'skipped', 'skipped_reason': 'source_withdrawn'}), run_id))


def execute(run_id: str) -> int:
    run_id = str(UUID(run_id))
    settings = load_settings()
    db_url = str(settings.get('supabase_db_url') or '')
    if not db_url:
        raise RuntimeError('Automatic execution requires transactional PostgreSQL')
    # Claim once even when GitHub dispatch was retried after an uncertain response.
    with _postgres_connect(db_url) as db:
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
        _skip_withdrawn_run(db_url, run_id, source)
        return 0
    register_run(run_id)
    env = {**os.environ, 'PIPELINE_AUTONOMOUS_RUN_ID':run_id, 'PIPELINE_ENRICHMENT_BUDGET_SECONDS':'1200', 'PIPELINE_ENRICHMENT_MAX_JOBS':'180', 'REPLICATE_CANCEL_AFTER':'5m',
           'CADASTRE_ENRICH_ENABLED':'false', 'DPE_ENRICH_ENABLED':'false',
           # A scheduled unit must not sit on the catalogue writer lock for
           # long (its budget is minutes); a busy catalogue fails the unit fast.
           'PIPELINE_LOCK_WAIT_SECONDS':'300'}
    if source == 'enrichment-queue':
        command = [sys.executable,'-m','src.queued_runner','--enrichment-only']
        budget = 25 * 60
    else:
        from src.main import SOURCE_NAMES
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
            env['PETITES_AFFICHES_SOURCE_BUDGET_SECONDS'] = str(budget - 5 * 60)
        if source == LICITOR_SOURCE:
            # Same contract: the detail pages (sequential, spaced) of a national
            # inventory can outlast the scheduler budget, which killed eight runs
            # in a row. The source stops reading details LICITOR_BUDGET_MARGIN_SECONDS
            # before the hard kill, publishes the whole list and resumes next run.
            env['LICITOR_SOURCE_BUDGET_SECONDS'] = str(budget - LICITOR_BUDGET_MARGIN_SECONDS)
    failure = None
    execution_started = datetime.now(UTC)
    try:
        result = subprocess.run(command, env=env, timeout=budget, check=False)
        code = result.returncode
    except subprocess.TimeoutExpired:
        code, failure = 1, 'Execution budget exceeded; committed checkpoints preserved'
    except Exception as exc:
        code, failure = 1, str(exc)[:1000]
    if code == WATCHDOG_EXIT_CODE:
        failure = (
            'Worker watchdog fired: a step stayed blocked until the end of the budget; '
            'see the "WATCHDOG" line and the stage journal in the job log'
        )
    worker_code = code
    reading_code = _run_document_reading(env) if source == 'enrichment-queue' and worker_code == 0 else None
    licitor_history_code = (
        _run_licitor_history_refresh(env)
        if source == 'enrichment-queue' and LICITOR_SOURCE not in withdrawn
        else None
    )
    # Exit 2 from src.main means "published, but an enabled source was empty or
    # failed": the run itself succeeded, so keep it succeeded and hand the
    # warning to the workflow instead of recording a worker failure.
    source_warning = source != 'enrichment-queue' and code == SOURCE_WARNING_EXIT_CODE
    if source_warning:
        code = worker_code = 0
    with _postgres_connect(db_url) as db:
        existing_summary = db.execute('select summary from public.auction_runs where id=%s', (run_id,)).fetchone()[0] or {}
        summary = {"scheduler_budget_seconds":budget,"execution_seconds":(datetime.now(UTC)-execution_started).total_seconds(),
                   "worker_exit_code": SOURCE_WARNING_EXIT_CODE if source_warning else worker_code}
        if source_warning:
            summary["source_warning"] = True
        if reading_code is not None:
            summary["document_reading_exit_code"] = reading_code
        if licitor_history_code is not None:
            summary["licitor_history_exit_code"] = licitor_history_code
        elif source == 'enrichment-queue' and LICITOR_SOURCE in withdrawn:
            summary["licitor_history_skipped"] = "source_withdrawn"
        run_errors: dict[str, list[str]] = {}
        counts: dict[object, object] = {}
        exhausted = 0
        if worker_code:
            run_errors['runner'] = [failure or f'Worker exited with status {worker_code}']
        if source == 'enrichment-queue':
            counts = dict(db.execute("select status,count(*) from public.auction_enrichment_jobs where updated_at>=%s group by status", (execution_started,)).fetchall())
            summary['enrichment_jobs'] = counts
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
        db.execute("""update public.auction_runs set status=%s,finished_at=now(),updated_at=now(),
            errors=coalesce(errors,'{}') || %s,
            summary=coalesce(summary,'{}') || %s
            where id=%s and status in ('queued','running')""",
            ('failed' if code else 'succeeded', Jsonb(run_errors),
             Jsonb(summary),run_id))
        db.execute("update public.auction_runs set summary=coalesce(summary,'{}') || %s where id=%s", (Jsonb(summary),run_id))
    finish_source(db_url, run_id)
    return SOURCE_WARNING_EXIT_CODE if source_warning and not code else code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    raise SystemExit(execute(parser.parse_args().run_id))
