"""Bounded, manual drain of the attached-document (PDF) backlog.

``python -m src.document_backlog --max-sales 200 --budget-minutes 120``

The general enrichment worker shares a 20-minute budget between source
details, display descriptions (rate-limited LLM calls) and PDF jobs, and a PDF
job is created only when a sale is republished: in practice most attachments
were never read. This runner only does document work:

* it selects actionable sales whose attachments are not read yet, upcoming
  sales first (soonest sale date), then sales with useful pending documents
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
from typing import Any

from src.config import load_settings
from src.freshness import documents_are_current
from src.models import AuctionSale
from src.normalize import clean_text

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
# Priority used for (re)queued PDF generations; the ordinary enqueue uses 30.
BACKLOG_PDF_PRIORITY = 40
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
   and (
         p.source_url is not null
         or not exists (select 1 from public.auction_documents d where d.source_url = s.source_url)
       )
   and not exists (
         select 1 from public.auction_enrichment_jobs a
          where a.source_url = s.source_url
            and a.status = 'running'
            and coalesce(a.locked_at, a.updated_at) >= now() - interval '30 minutes'
       )
 -- Documents never tried come first: a sale whose only unread documents
 -- already failed (and will likely fail again) must not starve them.
 order by (coalesce(p.untried_documents, jsonb_array_length(s.documents)) = 0),
          (s.sale_date is null), s.sale_date, coalesce(p.useful_pending, 0) desc, s.source_url
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


@dataclass
class BacklogReport:
    outcomes: list[SaleOutcome] = field(default_factory=list)
    stop_reason: str = "candidates_exhausted"
    elapsed_seconds: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        processed = [item for item in self.outcomes if item.action == "processed"]
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


def select_backlog_candidates(db_url: str, limit: int) -> list[dict[str, Any]]:
    with _connect(db_url) as connection:
        connection.execute("set transaction read only")
        connection.execute("set local statement_timeout = '30s'")
        rows = connection.execute(
            CANDIDATES_SQL,
            (list(USEFUL_DOCUMENT_TYPES), list(ACTIONABLE_STATUSES), int(limit)),
        ).fetchall()
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


def drain_sale(db_url: str, candidate: dict[str, Any], limits: BacklogLimits, deadline: float) -> SaleOutcome:
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
        if documents_are_current(sale):
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
                job = claim_pdf_job(db_url, job_id)
                if job is None:
                    break
                outcome.passes += 1
                _process_job(job, deadline=deadline)
                final_status, last_error = read_job_state(db_url, job_id)
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
                elif final_status != "queued" or "authorization required" in last_error:
                    # ``queued`` is a deferral with a durable checkpoint: the
                    # next six documents of a partial manifest, or the next
                    # OCR pages of a long scanned report. Anything else ends.
                    break
                if refreshed is None or documents_are_current(refreshed):
                    break
                # A durable checkpoint can re-key the job to the generation it
                # has just written; follow that generation.
                job_id = ensure_pdf_job(db_url, source_url, _input_hash(refreshed)) or job_id
            if outcome.passes and final_status != "completed":
                # Partial or failed passes only write the checkpoint; publish
                # the document projection so the rows show what was read.
                refreshed = _fetch_sale(source_url)
                if refreshed is not None:
                    _reproject(refreshed)
        after_sale = _fetch_sale(source_url)
        outcome.new_facts = new_facts(before_facts, _fact_snapshot(after_sale))
        after_counts = read_document_counts(db_url, source_url)
        outcome.documents_extracted_after = _extracted(after_counts)
        outcome.documents_total = sum(after_counts.values())
    except Exception as exc:  # one sale never stops the drain
        LOGGER.exception("Document backlog failed for %s: %s", source_url, exc)
        outcome.error = str(exc)[:300]
        if outcome.action == "skipped":
            outcome.action = "error"
    finally:
        outcome.seconds = time.monotonic() - started
    return outcome


@contextmanager
def _catalogue_lock(db_url: str, wait_seconds: float) -> Iterator[None]:
    from src.catalogue_lock import catalogue_writer_lock

    with catalogue_writer_lock(db_url, label="document backlog", wait_seconds=wait_seconds):
        yield


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
    from src.catalogue_lock import CatalogueLockTimeout

    last_yield = time.monotonic()
    for index, candidate in enumerate(candidates, start=1):
        if time.monotonic() >= deadline:
            report.stop_reason = "budget"
            break
        if time.monotonic() - last_yield >= LOCK_YIELD_EVERY_SECONDS:
            sleep(LOCK_YIELD_PAUSE_SECONDS)
            last_yield = time.monotonic()
        try:
            # A collection may hold the lock for its whole 35-minute budget.
            with _catalogue_lock(db_url, max(60.0, deadline - time.monotonic())):
                outcome = drain_sale(db_url, candidate, limits, deadline)
        except CatalogueLockTimeout as exc:
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
    report.elapsed_seconds = time.monotonic() - started
    return report


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
    summary["document_reading"] = _run_document_reading()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    _write_step_summary(summary)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    # Document passes publish sales like the queue worker: each sale takes the
    # catalogue writer lock (see LOCK_YIELD_EVERY_SECONDS).
    sys.exit(main())
