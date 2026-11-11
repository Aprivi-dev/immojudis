"""Bounded, manual drain of the attached-document (PDF) backlog.

``python -m src.document_backlog --max-sales 200 --budget-minutes 120``

The general enrichment worker shares a 20-minute budget between source
details, display descriptions (rate-limited LLM calls) and PDF jobs, and a PDF
job is created only when a sale is republished: in practice most attachments
were never read. This runner only does document work:

* it selects actionable sales whose attachments are not read yet and were
  not tried within a day (it also runs after each enrichment tick), upcoming
  sales first (soonest sale date; an undated sale counts as ending within a
  week), then sales with useful pending documents
  (conditions of sale, descriptive report, diagnostics, cadastre/urbanism);
* it (re)queues the sale's current PDF job generation, including a completed,
  cancelled or retry-exhausted one (the manual run is the explicit retry);
* it leases that one job and processes it with the normal queue code
  (``run_enrichment_queue_batch``): same downloads, robots.txt and per-host
  delay, OCR, page checkpoints, publication guard and job transitions;
* a deferred pass (partial manifest of six documents, OCR page budget of a
  long scanned report) is continued immediately, up to ``--max-passes``
  passes per sale;
* every error stays attached to its job/document; the run itself never fails
  because one sale or one document failed.

Sales whose documents are already current only get their document projection
rewritten (no network), which repairs rows still shown as ``unknown``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from src.config import load_settings
from src.freshness import documents_are_current
from src.models import AuctionSale
from src.normalize import clean_text
from src.pdf_enrichment import DOCUMENT_FACTS_VERSION
from src.pdf_pass_outcomes import waits_for_its_deadline

if TYPE_CHECKING:
    from src.catalogue_lock import CatalogueLockHandle

LOGGER = logging.getLogger(__name__)

DEFAULT_MAX_SALES = 200
MAX_SALES_LIMIT = 1000
DEFAULT_BUDGET_MINUTES = 120
# The GitHub job stops at 180 minutes; keep room for setup and finalization.
MAX_BUDGET_MINUTES = 150
DEFAULT_MAX_PASSES = 4
MAX_PASSES_LIMIT = 8
# The catalogue writer lock is held per sale, never for the whole run: a
# scheduled collection waits at most 300 s for it (autonomous runner). After
# two minutes of work the run pauses longer than the 15 s lock poll so that a
# waiting collection takes the lock; the drain then waits for it to finish.
LOCK_YIELD_EVERY_SECONDS = 120.0
LOCK_YIELD_PAUSE_SECONDS = 20.0
# The lock heartbeat failed during a sale: the drain stops before the next one and exits non-zero.
LOCK_LOST_STOP_REASON = "catalogue_lock_lost"
# Priority used for (re)queued PDF generations; the ordinary enqueue uses 30.
BACKLOG_PDF_PRIORITY = 40
# Plafond de relecture : au plus ce nombre de lectures pdf terminées par vente en 24 heures, quelle que soit
# l'empreinte de la tâche. Deux et non une : une vente lue le matin puis réellement invalidée par une collecte
# (pièce changée, #415) est relue le jour même.
MAX_COMPLETED_READS_PER_DAY = 2
ACTIONABLE_STATUSES = ("active", "unknown", "upcoming", "postponed")
USEFUL_DOCUMENT_TYPES = (
    "cahier_conditions_vente",
    "conditions_vente",
    "pv_huissier",
    "pv_notaire",
    "proces_verbal",
    "diagnostics_techniques",
    "cadastre",
)
# Facts the PDF extractors project onto a sale (see pdf_fact_extraction).
FACT_FIELDS = (
    "sale_date",
    "occupancy_status",
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
    "rooms_count",
    "bedrooms_count",
    "starting_price_eur",
    "visit_dates",
)
FACT_PAYLOAD_KEYS = (
    "pdf_energy_diagnostics",
    "pdf_offer_deadline_extraction",
    "pdf_sale_date_extraction",
    "pdf_visit_dates_extraction",
)

CANDIDATES_SQL = """
with pending as (
    select d.source_url,
           count(*) as pending_documents,
           count(*) filter (
               where d.document_type = any(%s)
                  or coalesce(d.label, '') ilike '%%urbanisme%%'
           ) as useful_pending,
           count(*) filter (where coalesce(d.extraction_status, 'pending') = 'pending') as untried_documents
      from public.auction_documents d
     where coalesce(d.extraction_status, 'pending') not in ('extracted', 'empty', 'partial')
     group by d.source_url
)
select s.source_url, s.source_name, s.sale_date,
       coalesce(p.pending_documents, jsonb_array_length(s.documents)) as pending_documents,
       coalesce(p.useful_pending, 0) as useful_pending,
       coalesce(p.untried_documents, jsonb_array_length(s.documents)) as untried_documents
  from public.auction_sales s
  left join pending p on p.source_url = s.source_url
 where s.status = any(%s)
   and jsonb_typeof(s.documents) = 'array'
   and jsonb_array_length(s.documents) > 0
   and s.retention_deadline_materialized
   and (s.retention_deadline is null or s.retention_deadline > now())
   and (s.sale_date is null or s.sale_date >= now())
   -- Toutes les sources de la vente sont retirées du catalogue (Vench, Petites Affiches) : elle est masquée et
   -- la file reporte ses tâches d'un jour (src/source_withdrawal.py). La choisir prenait une place de la
   -- sélection pour rien. Même règle et même interrupteur que la base (catalogue_withdrawn).
   and not app_private.sale_is_fully_withdrawn(
         s.source_name, s.observations, (select app_private.catalogue_withdrawn_sources())
       )
   -- Pièces non lues, ou toutes lues avec des règles plus anciennes que DOCUMENT_FACTS_VERSION : la tâche pdf les
   -- relit depuis le cache, sans nouveau téléchargement (relecture de l'audit qualité du 03/11/2026).
   and (
         p.source_url is not null
         or not exists (select 1 from public.auction_documents d where d.source_url = s.source_url)
         or coalesce(s.raw_payload->>'document_facts_version', '') <> %s
       )
   and not exists (
         select 1 from public.auction_enrichment_jobs a
          where a.source_url = s.source_url
            and a.status = 'running'
            and coalesce(a.locked_at, a.updated_at) >= now() - interval '30 minutes'
       )
   -- Tried within a day: wait. The drain runs after every enrichment tick (about 27 a day), so a document
   -- that keeps failing must not be downloaded again each time.
   -- Une relecture remise en file (tâche pdf « queued » et due) reste éligible : rien n'est retéléchargé, et un
   -- report (accès refusé, source retirée, nouvel essai) garde son échéance.
   -- Seul un essai réel fait attendre (04/11/2026 : 0 vente choisie sur 270 à relire). Une tâche annulée
   -- (« Superseded by a newer input revision » quand la collecte invalide la lecture) n'a rien essayé ; une
   -- tâche due jamais tentée non plus ; une lecture terminée qu'une génération plus récente remplace est
   -- dépassée. Elles bloquaient la vente un jour entier.
   and not exists (
         select 1 from public.auction_enrichment_jobs a
          where a.source_url = s.source_url
            and a.job_type = 'pdf'
            and a.updated_at >= now() - interval '1 day'
            and a.status <> 'cancelled'
            and not (
                  a.status = 'queued'
                  and a.next_attempt_at <= now()
                  and (
                        a.attempt_count = 0
                        or (
                              p.source_url is null
                              and coalesce(s.raw_payload->>'document_facts_version', '') <> %s
                            )
                      )
                )
            and not (
                  a.status = 'completed'
                  and exists (
                        select 1 from public.auction_enrichment_jobs b
                         where b.source_url = a.source_url
                           and b.job_type = 'pdf'
                           and b.created_at > a.created_at
                      )
                )
       )
   -- Plafond de relecture. Chaque lecture terminée écrit une nouvelle date de vérification, donc une nouvelle
   -- empreinte et une tâche neuve : ni les 4 essais ni la garde ci-dessus (une lecture terminée ne bloque plus
   -- dès qu'une tâche plus récente existe) ne bornent une vente qui reste à relire après chaque lecture. Le
   -- 11/11/2026, 3 ventes prenaient ainsi 104 des 200 lectures terminées en 48 heures, une par tick. Le compte
   -- porte sur les lectures terminées, par le vidage ou par la file : une tâche annulée, en échec ou reportée
   -- n'a rien lu et ne compte pas. La tâche en file reste servie par la voie générale, à son rang.
   and (
         select count(*) from public.auction_enrichment_jobs c
          where c.source_url = s.source_url
            and c.job_type = 'pdf'
            and c.status = 'completed'
            and c.completed_at >= now() - interval '24 hours'
       ) < %s
 -- Documents never tried come first: a sale whose only unread documents
 -- already failed (and will likely fail again) must not starve them.
 -- A sale without a date ranks as if it ended within a week: for a State tender (Cessions de
 -- l'État) the offer deadline is only in the conditions of sale, so ranking it last left its
 -- attachments unread for weeks (02/11/2026: 36 of 41 such sales).
 -- Une relecture passe après les pièces jamais lues.
 order by (p.source_url is null and exists (select 1 from public.auction_documents d where d.source_url = s.source_url)),
          (coalesce(p.untried_documents, jsonb_array_length(s.documents)) = 0),
          coalesce(s.sale_date, now() + interval '7 days'), coalesce(p.useful_pending, 0) desc, s.source_url
 limit %s
"""

ENSURE_JOB_SQL = """
insert into public.auction_enrichment_jobs
       (source_url, job_type, input_hash, priority, status, next_attempt_at)
values (%s, 'pdf', %s, %s, 'queued', now())
on conflict (source_url, job_type, input_hash) do update
   set status = 'queued',
       attempt_count = case
           when auction_enrichment_jobs.status in ('completed', 'cancelled')
             or auction_enrichment_jobs.attempt_count >= auction_enrichment_jobs.max_attempts
           then 0 else auction_enrichment_jobs.attempt_count end,
       created_at = case
           when auction_enrichment_jobs.status in ('completed', 'cancelled')
           then now() else auction_enrichment_jobs.created_at end,
       next_attempt_at = now(),
       locked_at = null,
       completed_at = null,
       last_error = null,
       priority = greatest(auction_enrichment_jobs.priority, excluded.priority),
       updated_at = now()
 where auction_enrichment_jobs.status <> 'running'
returning id
"""

CLAIM_JOB_SQL = """
with candidate as (
    select j.id
      from public.auction_enrichment_jobs j
      join public.auction_sales s on s.source_url = j.source_url
     where j.id = %s
       and j.job_type = 'pdf'
       and (
             j.status in ('queued', 'failed')
             or (j.status = 'running'
                 and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes')
           )
       and j.attempt_count < j.max_attempts
       and s.status = any(%s)
       and s.retention_deadline_materialized
       and (s.retention_deadline is null or s.retention_deadline > now())
       and not exists (
             select 1 from public.auction_enrichment_jobs a
              where a.source_url = j.source_url
                and a.id <> j.id
                and a.status = 'running'
                and coalesce(a.locked_at, a.updated_at) >= now() - interval '30 minutes'
           )
     for update of j, s skip locked
)
update public.auction_enrichment_jobs j
   set status = 'running',
       attempt_count = j.attempt_count + 1,
       locked_at = statement_timestamp(),
       updated_at = statement_timestamp(),
       last_error = null
  from candidate c
 where c.id = j.id
returning j.id, j.source_url, j.job_type, j.status, j.priority, j.input_hash,
          j.attempt_count, j.max_attempts, j.next_attempt_at, j.locked_at,
          j.created_at, j.updated_at, j.detail_source_name, j.detail_source_url,
          j.request_origin
"""

JOB_STATE_SQL = "select status, last_error from public.auction_enrichment_jobs where id = %s"

# Fins de passe comptées dans le bilan (queued_runner.py, storage/pdf_persistence_rows.py). Une passe partielle
# laisse sa tâche en file avec PARTIAL_MANIFEST_ERROR, ou la voit remplacée après son point d'étape durable.
PARTIAL_MANIFEST_ERROR = "pdf document manifest is partial"
DURABLE_CHECKPOINT_SUPERSEDED = "superseded after durable pdf checkpoint"
REFUSED_CHECKPOINT_ERROR = "pdf document checkpoint was not persisted"


def is_partial_pass(status: str, last_error: str) -> bool:
    error = last_error.lower()
    return (status == "queued" and PARTIAL_MANIFEST_ERROR in error) or (
        status == "cancelled" and DURABLE_CHECKPOINT_SUPERSEDED in error
    )


def is_refused_checkpoint(last_error: str) -> bool:
    return REFUSED_CHECKPOINT_ERROR in last_error.lower()

DOCUMENT_COUNTS_SQL = """
select coalesce(extraction_status, 'pending'), count(*)
  from public.auction_documents
 where source_url = %s
 group by 1
"""


@dataclass(frozen=True)
class BacklogLimits:
    max_sales: int = DEFAULT_MAX_SALES
    budget_seconds: float = DEFAULT_BUDGET_MINUTES * 60
    max_passes: int = DEFAULT_MAX_PASSES


@dataclass
class SaleOutcome:
    source_url: str
    source_name: str
    action: str
    passes: int = 0
    documents_extracted_before: int = 0
    documents_extracted_after: int = 0
    documents_total: int = 0
    new_facts: list[str] = field(default_factory=list)
    error: str | None = None
    seconds: float = 0.0
    # Rendement (alerte pipeline.documents_backlog.low_yield) : passes conclues sur un manifeste partiel, points
    # d'étape refusés, et pièces toutes lues avec les règles actuelles à la fin du vidage.
    partial_passes: int = 0
    refused_checkpoints: int = 0
    read_complete: bool = False


@dataclass
class BacklogReport:
    outcomes: list[SaleOutcome] = field(default_factory=list)
    stop_reason: str = "candidates_exhausted"
    elapsed_seconds: float = 0.0
    # Temps passé à attendre le verrou du catalogue, retranché de la durée évaluée par l'alerte de rendement.
    lock_wait_seconds: float = 0.0
    prefetch: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        from src.document_backlog_yield import partial_pass_share

        processed = [item for item in self.outcomes if item.action == "processed"]
        passes = sum(item.passes for item in self.outcomes)
        partial_passes = sum(item.partial_passes for item in self.outcomes)
        facts: dict[str, int] = {}
        for item in self.outcomes:
            for name in item.new_facts:
                facts[name] = facts.get(name, 0) + 1
        by_source: dict[str, dict[str, int]] = {}
        for item in self.outcomes:
            bucket = by_source.setdefault(
                item.source_name,
                {"sales": 0, "documents_read": 0, "errors": 0},
            )
            bucket["sales"] += 1
            bucket["documents_read"] += max(0, item.documents_extracted_after - item.documents_extracted_before)
            bucket["errors"] += 1 if item.error else 0
        return {
            "stop_reason": self.stop_reason,
            "elapsed_seconds": round(self.elapsed_seconds, 1),
            "lock_wait_seconds": round(self.lock_wait_seconds, 1),
            "sales_seen": len(self.outcomes),
            "sales_processed": len(processed),
            "sales_reprojected": sum(1 for item in self.outcomes if item.action == "reprojected"),
            "sales_with_errors": sum(1 for item in self.outcomes if item.error),
            "documents_read": sum(
                max(0, item.documents_extracted_after - item.documents_extracted_before)
                for item in self.outcomes
            ),
            "average_seconds_per_processed_sale": (
                round(sum(item.seconds for item in processed) / len(processed), 1) if processed else 0.0
            ),
            "sales_read": sum(1 for item in processed if item.read_complete),
            "passes": passes,
            "partial_passes": partial_passes,
            "partial_pass_share": partial_pass_share(passes, partial_passes),
            "refused_checkpoints": sum(item.refused_checkpoints for item in self.outcomes),
            "prefetch": dict(self.prefetch),
            "facts_added": dict(sorted(facts.items())),
            "by_source": dict(sorted(by_source.items())),
        }


def _bounded_int(value: object, default: int, low: int, high: int) -> int:
    try:
        parsed = int(str(value).strip()) if clean_text(value) else default
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


def limits_from_inputs(
    max_sales: object = None,
    budget_minutes: object = None,
    max_passes: object = None,
) -> BacklogLimits:
    return BacklogLimits(
        max_sales=_bounded_int(max_sales, DEFAULT_MAX_SALES, 1, MAX_SALES_LIMIT),
        budget_seconds=60.0 * _bounded_int(budget_minutes, DEFAULT_BUDGET_MINUTES, 1, MAX_BUDGET_MINUTES),
        max_passes=_bounded_int(max_passes, DEFAULT_MAX_PASSES, 1, MAX_PASSES_LIMIT),
    )


def _connect(db_url: str) -> Any:
    from src.storage.supabase_client import connect

    return connect(db_url)


def candidate_parameters(limit: int) -> tuple[object, ...]:
    """Paramètres de ``CANDIDATES_SQL``, dans l'ordre de ses jokers."""
    return (
        list(USEFUL_DOCUMENT_TYPES),
        list(ACTIONABLE_STATUSES),
        DOCUMENT_FACTS_VERSION,
        DOCUMENT_FACTS_VERSION,
        MAX_COMPLETED_READS_PER_DAY,
        int(limit),
    )


def select_backlog_candidates(db_url: str, limit: int) -> list[dict[str, Any]]:
    with _connect(db_url) as connection:
        connection.execute("set transaction read only")
        connection.execute("set local statement_timeout = '30s'")
        rows = connection.execute(CANDIDATES_SQL, candidate_parameters(limit)).fetchall()
    return [
        {
            "source_url": row[0],
            "source_name": row[1],
            "sale_date": row[2],
            "pending_documents": int(row[3] or 0),
            "useful_pending": int(row[4] or 0),
        }
        for row in rows
    ]


def ensure_pdf_job(db_url: str, source_url: str, input_hash: str) -> str | None:
    with _connect(db_url) as connection:
        row = connection.execute(ENSURE_JOB_SQL, (source_url, input_hash, BACKLOG_PDF_PRIORITY)).fetchone()
    return str(row[0]) if row else None


_CLAIM_COLUMNS = (
    "id",
    "source_url",
    "job_type",
    "status",
    "priority",
    "input_hash",
    "attempt_count",
    "max_attempts",
    "next_attempt_at",
    "locked_at",
    "created_at",
    "updated_at",
    "detail_source_name",
    "detail_source_url",
    "request_origin",
)


def claim_pdf_job(db_url: str, job_id: str) -> dict[str, Any] | None:
    with _connect(db_url) as connection:
        row = connection.execute(CLAIM_JOB_SQL, (job_id, list(ACTIONABLE_STATUSES))).fetchone()
    if not row:
        return None
    job = dict(zip(_CLAIM_COLUMNS, row, strict=True))
    job["id"] = str(job["id"])
    return job


def read_job_state(db_url: str, job_id: str) -> tuple[str, str]:
    with _connect(db_url) as connection:
        row = connection.execute(JOB_STATE_SQL, (job_id,)).fetchone()
    if not row:
        return "missing", ""
    return str(row[0] or ""), str(row[1] or "")


def read_document_counts(db_url: str, source_url: str) -> dict[str, int]:
    with _connect(db_url) as connection:
        rows = connection.execute(DOCUMENT_COUNTS_SQL, (source_url,)).fetchall()
    return {str(status): int(count or 0) for status, count in rows}


def _fact_snapshot(sale: AuctionSale | None) -> dict[str, object]:
    if sale is None:
        return {}
    snapshot: dict[str, object] = {}
    for name in FACT_FIELDS:
        value = getattr(sale, name, None)
        if isinstance(value, Decimal):
            value = str(value)
        snapshot[name] = value
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    for key in FACT_PAYLOAD_KEYS:
        snapshot[key] = json.dumps(payload.get(key), sort_keys=True, default=str) if payload.get(key) else None
    return snapshot


def new_facts(before: dict[str, object], after: dict[str, object]) -> list[str]:
    """Fields that gained or changed a value between two snapshots."""

    return sorted(
        name
        for name, value in after.items()
        if value not in (None, "", [], {}) and value != before.get(name)
    )


def _process_job(job: dict[str, Any], *, deadline: float) -> None:
    from src.queued_runner import (
        ENRICHMENT_FAMILY,
        _pdf_finalization_margin_seconds,
        _run_enrichment_queue_batch_with_deadline,
    )

    remaining = max(0.0, deadline - time.monotonic())
    _run_enrichment_queue_batch_with_deadline(
        limit=1,
        family=ENRICHMENT_FAMILY,
        provider_clients={},
        worker_deadline=deadline,
        finalization_margin_seconds=_pdf_finalization_margin_seconds(remaining),
        claimed_jobs=[job],
    )


def _reproject(sale: AuctionSale) -> None:
    from src.storage.supabase_client import upsert_sales_to_supabase

    upsert_sales_to_supabase([sale], refresh_last_seen=False)


def _fetch_sale(source_url: str) -> AuctionSale | None:
    from src.storage.supabase_client import fetch_sale_for_data_refresh

    return fetch_sale_for_data_refresh(source_url)


def _read_with_current_rules(sale: AuctionSale) -> bool:
    """Every attachment is read (or terminal) and its facts come from the current extraction rules."""
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    return payload.get("document_facts_version") == DOCUMENT_FACTS_VERSION and documents_are_current(sale)


def _input_hash(sale: AuctionSale) -> str:
    from src.storage.supabase_client import pdf_enrichment_input_hash_for_sale

    return pdf_enrichment_input_hash_for_sale(sale)


def _settled_documents(sale: AuctionSale | None) -> int:
    """Documents of the current manifest that are read or terminal."""
    if sale is None or not isinstance(sale.raw_payload, dict):
        return 0
    from src.pdf_progress import complete_or_terminal_urls

    return len(complete_or_terminal_urls(sale.raw_payload.get("document_analysis"), sale.documents))


def _extracted(counts: dict[str, int]) -> int:
    return int(counts.get("extracted", 0))


def _ensure_held(lock: CatalogueLockHandle | None) -> None:
    """Raise ``CatalogueLockLost`` before a write when the heartbeat of the sale's lock failed."""
    if lock is not None:
        lock.ensure_held()


def drain_sale(
    db_url: str,
    candidate: dict[str, Any],
    limits: BacklogLimits,
    deadline: float,
    *,
    lock: CatalogueLockHandle | None = None,
) -> SaleOutcome:
    """Read one sale's attachments under its catalogue lock.

    The lock is checked before each pass and before each projection rewrite: once its heartbeat failed,
    nothing more is written and ``run_document_backlog`` stops before the next sale.
    """
    from src.catalogue_lock import CatalogueLockLost

    source_url = str(candidate["source_url"])
    outcome = SaleOutcome(source_url=source_url, source_name=str(candidate.get("source_name") or ""), action="skipped")
    started = time.monotonic()
    try:
        before_counts = read_document_counts(db_url, source_url)
        outcome.documents_extracted_before = _extracted(before_counts)
        sale = _fetch_sale(source_url)
        if sale is None or not sale.documents:
            outcome.action = "missing"
            return outcome
        before_facts = _fact_snapshot(sale)
        if _read_with_current_rules(sale):
            _ensure_held(lock)
            _reproject(sale)
            outcome.action = "reprojected"
        else:
            job_id = ensure_pdf_job(db_url, source_url, _input_hash(sale))
            if job_id is None:
                outcome.action = "busy"
                return outcome
            outcome.action = "processed"
            settled = _settled_documents(sale)
            final_status = ""
            for _ in range(limits.max_passes):
                if time.monotonic() >= deadline:
                    break
                _ensure_held(lock)
                job = claim_pdf_job(db_url, job_id)
                if job is None:
                    break
                outcome.passes += 1
                _process_job(job, deadline=deadline)
                final_status, last_error = read_job_state(db_url, job_id)
                outcome.partial_passes += int(is_partial_pass(final_status, last_error))
                outcome.refused_checkpoints += int(is_refused_checkpoint(last_error))
                refreshed = _fetch_sale(source_url)
                settled_now = _settled_documents(refreshed)
                progressed = settled_now > settled
                settled = max(settled, settled_now)
                if final_status == "failed":
                    # The failure stays on the job and in the document
                    # manifest. Keep going only while passes still settle new
                    # documents; the job retry budget bounds the loop.
                    outcome.error = last_error[:300] or "PDF job failed"
                    if not progressed:
                        break
                elif final_status == "cancelled" and "superseded" in last_error.lower():
                    # The pass wrote the sale, whose new input revision (a durable checkpoint, a re-keyed
                    # manifest) replaced the job. Follow the newer generation below instead of leaving the
                    # sale half read until the next drain (04/11/2026: most re-reads stopped there).
                    pass
                elif (
                    final_status != "queued"
                    or "authorization required" in last_error
                    or waits_for_its_deadline(last_error)
                ):
                    # ``queued`` is a deferral with a durable checkpoint: the
                    # next six documents of a partial manifest, or the next
                    # OCR pages of a long scanned report. Anything else ends.
                    # Une tâche qui attend une échéance (rien à revalider, écriture écartée) finit aussi : la
                    # remettre en file tout de suite effacerait son échéance pour rejouer la même passe.
                    break
                if refreshed is None or _read_with_current_rules(refreshed):
                    break
                # A durable checkpoint can re-key the job to the generation it
                # has just written; follow that generation.
                job_id = ensure_pdf_job(db_url, source_url, _input_hash(refreshed)) or job_id
            if outcome.passes and final_status != "completed":
                # Partial or failed passes only write the checkpoint; publish
                # the document projection so the rows show what was read.
                refreshed = _fetch_sale(source_url)
                if refreshed is not None:
                    _ensure_held(lock)
                    _reproject(refreshed)
        after_sale = _fetch_sale(source_url)
        outcome.new_facts = new_facts(before_facts, _fact_snapshot(after_sale))
        outcome.read_complete = outcome.action == "processed" and (
            after_sale is not None and _read_with_current_rules(after_sale)
        )
        after_counts = read_document_counts(db_url, source_url)
        outcome.documents_extracted_after = _extracted(after_counts)
        outcome.documents_total = sum(after_counts.values())
    except CatalogueLockLost as exc:
        # Nothing more is written for this sale; the caller sees the lost lock and stops before the next one.
        LOGGER.error("Document backlog stopped writing %s: %s", source_url, exc)
        outcome.error = str(exc)[:300]
        if outcome.action == "skipped":
            outcome.action = "error"
    except Exception as exc:  # one sale never stops the drain
        LOGGER.exception("Document backlog failed for %s: %s", source_url, exc)
        outcome.error = str(exc)[:300]
        if outcome.action == "skipped":
            outcome.action = "error"
    finally:
        outcome.seconds = time.monotonic() - started
    return outcome


@contextmanager
def _catalogue_lock(db_url: str, wait_seconds: float) -> Iterator[CatalogueLockHandle]:
    from src.catalogue_lock import catalogue_writer_lock

    with catalogue_writer_lock(db_url, label="document backlog", wait_seconds=wait_seconds) as lock:
        yield lock


def run_document_backlog(
    limits: BacklogLimits, *, db_url: str | None = None, sleep=time.sleep
) -> BacklogReport:
    settings = load_settings()
    db_url = db_url or str(settings.get("supabase_db_url") or "")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required for the document backlog")
    started = time.monotonic()
    deadline = started + limits.budget_seconds
    report = BacklogReport()
    candidates = select_backlog_candidates(db_url, limits.max_sales)
    LOGGER.info(
        "Document backlog: %s candidate sales (max_sales=%s budget=%ss max_passes=%s)",
        len(candidates),
        limits.max_sales,
        int(limits.budget_seconds),
        limits.max_passes,
    )
    from src.catalogue_lock import CatalogueLockLost, CatalogueLockTimeout

    # Les ventes suivantes sont téléchargées et lues hors du verrou pendant que la courante est publiée
    # (src/document_prefetch.py) : le verrou ne couvre plus que la passe, qui trouve les pages déjà lues.
    prefetcher = _prefetcher([str(item["source_url"]) for item in candidates], deadline)
    prefetcher.start()
    last_yield = time.monotonic()
    try:
        for index, candidate in enumerate(candidates, start=1):
            if time.monotonic() >= deadline:
                report.stop_reason = "budget"
                break
            if time.monotonic() - last_yield >= LOCK_YIELD_EVERY_SECONDS:
                sleep(LOCK_YIELD_PAUSE_SECONDS)
                last_yield = time.monotonic()
            # Never prepared and processed at the same time: the locked pass writes the same caches.
            prefetcher.wait_for(str(candidate["source_url"]))
            waiting_since = time.monotonic()
            try:
                # A collection may hold the lock for its whole 35-minute budget.
                with _catalogue_lock(db_url, max(60.0, deadline - time.monotonic())) as lock:
                    report.lock_wait_seconds += time.monotonic() - waiting_since
                    outcome = drain_sale(db_url, candidate, limits, deadline, lock=lock)
            except CatalogueLockTimeout as exc:
                report.lock_wait_seconds += time.monotonic() - waiting_since
                LOGGER.warning("Document backlog stopped: %s", exc)
                report.stop_reason = "catalogue_lock"
                break
            report.outcomes.append(outcome)
            LOGGER.info(
                "Document backlog %s/%s %s %s: action=%s passes=%s extracted %s->%s/%s facts=%s%s (%.1fs)",
                index,
                len(candidates),
                outcome.source_name,
                outcome.source_url,
                outcome.action,
                outcome.passes,
                outcome.documents_extracted_before,
                outcome.documents_extracted_after,
                outcome.documents_total,
                ",".join(outcome.new_facts) or "-",
                f" error={outcome.error}" if outcome.error else "",
                outcome.seconds,
            )
            # The heartbeat failed while this sale was published: the next sale must not start.
            try:
                lock.ensure_held()
            except CatalogueLockLost as exc:
                LOGGER.error("Document backlog stopped: %s", exc)
                report.stop_reason = LOCK_LOST_STOP_REASON
                break
    finally:
        prefetcher.close()
    report.prefetch = dict(prefetcher.stats)
    report.elapsed_seconds = time.monotonic() - started
    return report


def _prefetcher(source_urls: list[str], deadline: float) -> Any:
    from src.document_prefetch import DocumentPrefetcher, prefetch_workers_from_env

    return DocumentPrefetcher(source_urls, workers=prefetch_workers_from_env(), deadline=deadline)


def _write_step_summary(summary: dict[str, Any]) -> None:
    path = os.getenv("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = [
        "### Pièces jointes : vidage du stock",
        "",
        f"- Arrêt : `{summary['stop_reason']}` après {summary['elapsed_seconds']} s",
        f"- Ventes vues : {summary['sales_seen']} (traitées {summary['sales_processed']}, "
        f"projection réécrite {summary['sales_reprojected']}, en erreur {summary['sales_with_errors']})",
        f"- Documents lus : {summary['documents_read']}",
        f"- Temps moyen par vente traitée : {summary['average_seconds_per_processed_sale']} s",
        f"- Ventes lues (toutes les pièces à jour) : {summary['sales_read']}",
        f"- Passes : {summary['passes']}, dont partielles {summary['partial_passes']} "
        f"({round(100 * summary['partial_pass_share'])} %) ; points d'étape refusés : {summary['refused_checkpoints']}",
    ]
    prefetch = summary.get("prefetch") or {}
    if prefetch:
        lines.append(
            f"- Lecture en avance : {prefetch.get('workers', 0)} processus, {prefetch.get('prepared', 0)} ventes "
            f"préparées, {prefetch.get('read', 0)} pièces lues, {prefetch.get('deferred_exhausted', 0)} encore "
            f"reportées, {prefetch.get('errors', 0)} erreurs"
        )
    low_yield = summary.get("low_yield") or {}
    if low_yield.get("evaluated"):
        state = "ouverte" if low_yield.get("active") else "non déclenchée"
        reasons = ", ".join(low_yield.get("reasons") or []) or "-"
        lines.append(f"- Alerte `{low_yield.get('alert_key')}` : {state} ({reasons}) ; enregistrement : "
                     f"`{low_yield.get('sync', '-')}`")
    lines += [
        "",
        "| Source | Ventes | Documents lus | Erreurs |",
        "| --- | ---: | ---: | ---: |",
    ]
    for source, bucket in summary["by_source"].items():
        lines.append(f"| {source} | {bucket['sales']} | {bucket['documents_read']} | {bucket['errors']} |")
    if summary["facts_added"]:
        lines += ["", "Faits ajoutés ou corrigés : " + ", ".join(f"{k} ({v})" for k, v in summary["facts_added"].items())]
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    except OSError as exc:
        LOGGER.warning("Could not write the GitHub step summary: %s", exc)


def _record_yield(summary: dict[str, Any]) -> None:
    """Bilan de rendement dans le journal, puis alerte pipeline.documents_backlog.low_yield (src.document_backlog_yield)."""
    from src.document_backlog_yield import evaluate_low_yield, sync_low_yield_alert

    LOGGER.info(
        "Document backlog yield: %.0fs, %s sales read of %s processed, %s passes (%s partial, share %s), "
        "%s refused checkpoints, prefetch %s",
        summary["elapsed_seconds"],
        summary["sales_read"],
        summary["sales_processed"],
        summary["passes"],
        summary["partial_passes"],
        summary["partial_pass_share"],
        summary["refused_checkpoints"],
        summary["prefetch"] or "-",
    )
    evaluation = evaluate_low_yield(summary)
    db_url = str(load_settings().get("supabase_db_url") or "")
    evaluation["sync"] = sync_low_yield_alert(db_url, summary, evaluation)
    summary["low_yield"] = evaluation


def _run_document_reading() -> dict[str, int] | str:
    """Read the dossiers whose texts this pass (or an earlier one) persisted.

    Optional and bounded: a provider or budget failure never fails the drain.
    """
    from src.document_reading import reading_enabled, run_document_readings

    if not reading_enabled():
        return "disabled"
    db_url = str(load_settings().get("supabase_db_url") or "")
    try:
        return run_document_readings(
            db_url,
            max_sales=_bounded_int(os.getenv("DOCUMENT_READING_MAX_SALES"), 40, 1, 500),
            budget_seconds=60.0 * _bounded_int(os.getenv("DOCUMENT_READING_BUDGET_MINUTES"), 20, 1, 120),
        )
    except Exception as exc:  # noqa: BLE001 - reported in the summary, never fatal
        LOGGER.warning("Document reading stopped: %s", exc)
        return f"error: {type(exc).__name__}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-sales", default=os.getenv("DOCUMENT_BACKLOG_MAX_SALES"))
    parser.add_argument("--budget-minutes", default=os.getenv("DOCUMENT_BACKLOG_BUDGET_MINUTES"))
    parser.add_argument("--max-passes", default=os.getenv("DOCUMENT_BACKLOG_MAX_PASSES"))
    args = parser.parse_args(argv)
    limits = limits_from_inputs(args.max_sales, args.budget_minutes, args.max_passes)
    report = run_document_backlog(limits)
    summary = report.as_dict()
    lock_lost = report.stop_reason == LOCK_LOST_STOP_REASON
    _record_yield(summary)
    summary["document_reading"] = "skipped" if lock_lost else _run_document_reading()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    _write_step_summary(summary)
    if lock_lost:
        from src.catalogue_lock import LOCK_LOST_EXIT_CODE

        print(
            "::error title=Verrou du catalogue perdu::the catalogue writer lock may have been lost "
            "(heartbeat failed); the document backlog stopped before the next sale.",
            flush=True,
        )
        return LOCK_LOST_EXIT_CODE
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    # Document passes publish sales like the queue worker: each sale takes the
    # catalogue writer lock (see LOCK_YIELD_EVERY_SECONDS).
    sys.exit(main())
