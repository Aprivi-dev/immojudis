from __future__ import annotations

import logging
import os
import sys
import time
from collections import defaultdict
from contextvars import ContextVar
from urllib.parse import urlsplit

from src.admission import is_expired
from src.asset_normalization import normalize_asset_features
from src.cadastre import enrich_cadastre_sales
from src.config import load_settings
from src.dpe import enrich_dpe_sales
from src.enrichment.extract_structured import (
    LLMEnrichmentDeferred,
    enrich_sale_with_llm,
    has_current_fact_analysis,
    needs_fact_extraction,
)
from src.enrichment.llm_client import create_llm_client
from src.enrichment.operational_display import refresh_operational_display
from src.freshness import documents_are_current
from src.geocode import geocode_sale
from src.information_agent_evidence import run_information_agent_evidence_batch
from src.llm_requests import LLMRequestDeterministicCooldown, llm_request_context
from src.main import (
    SOURCE_NAMES,
    PipelineOptions,
    _needs_llm_display_description_refresh,
    run_llm_description_backfill,
    run_pipeline,
)
from src.pdf_enrichment import PdfExtractionDeferred, enrich_sale_from_pdfs
from src.pipeline_usage import PipelineBudgetExhausted, QueueJobDeferred, defer_budget_jobs
from src.sale_procedure import classify_sale_procedure
from src.source_detail_worker import run_source_detail_jobs
from src.storage.supabase_client import (
    _postgres_connect,
    claim_auction_enrichment_jobs_family_from_supabase,
    claim_auction_enrichment_jobs_from_supabase,
    fail_stale_running_runs_in_supabase,
    fetch_next_data_refresh_request_from_supabase,
    fetch_next_queued_run_from_supabase,
    fetch_sale_for_data_refresh,
    finish_auction_enrichment_job_in_supabase,
    finish_data_refresh_request_in_supabase,
    finish_run_in_supabase,
    has_active_running_run_in_supabase,
    has_eligible_pdf_job_for_sale,
    mark_past_sales_in_supabase,
    retry_fact_claims_to_supabase,
    upsert_cadastre_parcels_to_supabase,
    upsert_dpe_diagnostics_to_supabase,
    upsert_sales_to_supabase,
)
from src.tribunal import fill_tribunal

LOGGER = logging.getLogger(__name__)
VALID_SOURCES = {"all", *SOURCE_NAMES}
LLM_BACKFILL_SOURCE = "llm-description-backfill"
SOURCE_DETAIL_FAMILY = "source_detail"
ENRICHMENT_FAMILY = "enrichment"
ENRICHMENT_FAMILY_CYCLE = (SOURCE_DETAIL_FAMILY,) * 5 + (ENRICHMENT_FAMILY,)
ENRICHMENT_MAX_JOBS = 90
ENRICHMENT_BUDGET_SECONDS = 1200
ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE = 2
ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_MAX = 5
GENERAL_BACKLOG_RELIEF_CYCLE = (
    SOURCE_DETAIL_FAMILY,
    ENRICHMENT_FAMILY,
)
WORKER_OBSERVED_STATUS_KEYS = (
    "completed",
    "failed",
    "cancelled",
    "queued",
    "running",
)
_WORKER_CLAIMED_JOB_IDS: ContextVar[set[str] | None] = ContextVar(
    "worker_claimed_job_ids",
    default=None,
)


def main() -> int:
    stale_failed = fail_stale_running_runs_in_supabase()
    if has_active_running_run_in_supabase():
        print(
            "Another Immojudis data run is already active. "
            f"Marked stale runs failed: {stale_failed}. Skipping this worker."
        )
        return 0

    run = fetch_next_queued_run_from_supabase()
    if not run:
        settings = load_settings()
        evidence_processed = run_information_agent_evidence_batch(
            limit=int(settings.get("information_agent_evidence_batch_size") or 5)
        )
        if evidence_processed:
            print(
                f"Processed information-agent evidence: {evidence_processed}. "
                f"Marked stale runs failed: {stale_failed}."
            )
            return 0
        refresh_request = fetch_next_data_refresh_request_from_supabase()
        if refresh_request:
            return run_data_refresh_request(refresh_request)
        if settings.get("pipeline_enrichment_queue_enabled"):
            handled = run_enrichment_queue_batch(
                limit=int(settings.get("pipeline_enrichment_queue_batch_size") or 10)
            )
            if handled:
                cleaned = mark_past_sales_in_supabase()
                print(
                    f"Handled enrichment queue jobs: {handled}. "
                    f"Marked past sales: {cleaned}. Marked stale runs failed: {stale_failed}."
                )
                return 0
        if settings.get("pipeline_idle_llm_backfill_enabled"):
            backfill_result = run_llm_description_backfill(
                PipelineOptions(
                    llm_backfill=True,
                    upsert=True,
                    limit=int(settings["pipeline_llm_backfill_max_targets"]),
                )
            )
            if backfill_result != 0:
                return backfill_result
        cleaned = mark_past_sales_in_supabase()
        print(
            f"No queued Immojudis data run found. "
            f"Marked past sales: {cleaned}. Marked stale runs failed: {stale_failed}."
        )
        return 0

    run_id = str(run.get("id") or "")
    source = str(run.get("source") or "all")
    # The run flag is authoritative: a no-LLM run must not spend Replicate credit.
    use_llm = bool(run.get("use_llm", True))

    if not run_id:
        print("Queued run has no id; skipping.")
        return 1

    if source == LLM_BACKFILL_SOURCE:
        print(f"Running queued Immojudis LLM description backfill: {run_id}")
        return run_llm_description_backfill(
            PipelineOptions(
                llm_backfill=True,
                use_llm=True,
                upsert=True,
                run_id=run_id,
                limit=_queued_backfill_limit(run),
            )
        )

    if source not in VALID_SOURCES:
        message = f"Invalid queued source: {source}"
        finish_run_in_supabase(run_id, "failed", {"runner": "github_actions_queue"}, {"runner": [message]})
        print(message)
        return 1

    heavy_enrichment = use_llm
    print(f"Running queued Immojudis data pipeline: {run_id} ({source}, llm={use_llm}, heavy={heavy_enrichment})")
    try:
        return run_pipeline(
            PipelineOptions(
                source=source,
                use_llm=use_llm,
                heavy_enrichment=heavy_enrichment,
                upsert=True,
                run_id=run_id,
            )
        )
    except Exception as exc:
        LOGGER.exception("Queued run failed: %s", exc)
        finish_run_in_supabase(
            run_id,
            "failed",
            {"runner": "github_actions_queue"},
            {"runner": [str(exc)]},
        )
        return 1


def _queued_backfill_limit(run: dict[str, object]) -> int | None:
    summary = run.get("summary")
    if not isinstance(summary, dict):
        return None
    value = summary.get("limit")
    if isinstance(value, int):
        return max(1, min(100, value))
    if isinstance(value, str) and value.strip().isdigit():
        return max(1, min(100, int(value)))
    return None


def run_data_refresh_request(request: dict[str, object]) -> int:
    request_id = str(request.get("id") or "")
    source_url = str(request.get("source_url") or "")
    request_kind = str(request.get("request_kind") or "full")
    if request_kind not in {"cadastre", "dpe", "full"}:
        message = f"Invalid data refresh kind: {request_kind}"
        finish_data_refresh_request_in_supabase(request_id, "failed", {"runner": "data_refresh_queue"}, message)
        print(message)
        return 1

    sale = fetch_sale_for_data_refresh(source_url)
    if sale is None:
        message = f"Sale not found for data refresh: {source_url}"
        finish_data_refresh_request_in_supabase(request_id, "failed", {"runner": "data_refresh_queue"}, message)
        print(message)
        return 1

    settings = load_settings()
    summary: dict[str, object] = {
        "runner": "data_refresh_queue",
        "request_kind": request_kind,
        "source_url": source_url,
    }
    print(f"Running Immojudis data refresh: {request_id} ({request_kind}, {source_url})")
    try:
        if request_kind in {"cadastre", "full"}:
            cadastre_rows = enrich_cadastre_sales([sale], settings=settings)
            summary["cadastre_rows"] = len(cadastre_rows)
            summary["cadastre_upserted"] = upsert_cadastre_parcels_to_supabase(cadastre_rows)
        if request_kind in {"dpe", "full"}:
            dpe_rows = enrich_dpe_sales([sale], settings=settings)
            summary["dpe_rows"] = len(dpe_rows)
            summary["dpe_upserted"] = upsert_dpe_diagnostics_to_supabase(dpe_rows)
    except Exception as exc:
        LOGGER.exception("Data refresh request failed: %s", exc)
        finish_data_refresh_request_in_supabase(request_id, "failed", summary, str(exc))
        return 1

    finish_data_refresh_request_in_supabase(request_id, "completed", summary)
    print(f"Completed Immojudis data refresh: {request_id}")
    return 0


def _finish_job(job: dict[str, object], **kwargs) -> None:
    # A worker whose lease expired must not finish a later worker's attempt.
    if job.get("attempt_count") is not None:
        kwargs["attempt_count"] = int(job["attempt_count"])
    if job.get("locked_at") is not None:
        kwargs["locked_at"] = job["locked_at"]
    finish_auction_enrichment_job_in_supabase(str(job.get("id") or ""), **kwargs)


def _claim_enrichment_queue_jobs(*, limit: int, family: str | None) -> list[dict[str, object]]:
    if family is None:
        # Keep the old call shape for manual/legacy callers and for workers
        # deployed before the family RPC migration.
        jobs = claim_auction_enrichment_jobs_from_supabase(limit=limit)
    else:
        if family not in {SOURCE_DETAIL_FAMILY, ENRICHMENT_FAMILY}:
            raise ValueError(f"Unknown enrichment queue family: {family!r}")
        jobs = claim_auction_enrichment_jobs_family_from_supabase(family=family, limit=limit)
    _record_worker_claimed_job_ids(jobs)
    return jobs


def _record_worker_claimed_job_ids(jobs: list[dict[str, object]]) -> None:
    claimed_job_ids = _WORKER_CLAIMED_JOB_IDS.get()
    if claimed_job_ids is None:
        return
    claimed_job_ids.update(
        str(job.get("id"))
        for job in jobs
        if job.get("id") is not None and str(job.get("id")).strip()
    )


def run_enrichment_queue_batch(
    *,
    limit: int,
    family: str | None = None,
    provider_clients: dict[str, object] | None = None,
) -> int:
    jobs = _claim_enrichment_queue_jobs(limit=limit, family=family)
    if not jobs:
        return 0
    settings = load_settings()
    if family == SOURCE_DETAIL_FAMILY:
        detail_jobs = [job for job in jobs if str(job.get("job_type") or "") == SOURCE_DETAIL_FAMILY]
        enrichment_jobs: list[dict[str, object]] = []
    elif family == ENRICHMENT_FAMILY:
        detail_jobs = []
        enrichment_jobs = [job for job in jobs if str(job.get("job_type") or "") != SOURCE_DETAIL_FAMILY]
    else:
        detail_jobs = [job for job in jobs if str(job.get("job_type") or "") == SOURCE_DETAIL_FAMILY]
        enrichment_jobs = [job for job in jobs if str(job.get("job_type") or "") != SOURCE_DETAIL_FAMILY]

    pending_enrichment_jobs = list(enrichment_jobs)

    def mark_enrichment_jobs_terminal(terminal_jobs: list[dict[str, object]]) -> None:
        terminal_ids = {id(job) for job in terminal_jobs}
        pending_enrichment_jobs[:] = [
            job for job in pending_enrichment_jobs if id(job) not in terminal_ids
        ]

    # Source details are deliberately completed before grouping the remaining
    # enrichment work.  Each regular group fetches its sale again below, so a
    # PDF/LLM job never writes a stale pre-detail catalogue snapshot.
    handled_detail_jobs = run_source_detail_jobs(
        detail_jobs,
        settings=settings,
        clients=provider_clients,
    )
    if not enrichment_jobs:
        return handled_detail_jobs

    jobs_by_sale: dict[str, list[dict[str, object]]] = defaultdict(list)
    for job in enrichment_jobs:
        source_url = str(job.get("source_url") or "")
        if source_url:
            jobs_by_sale[source_url].append(job)

    prompt_version = str(settings.get("llm_prompt_version") or "")
    llm_client = None

    for source_url, sale_jobs in jobs_by_sale.items():
        try:
            sale = fetch_sale_for_data_refresh(source_url)
        except Exception as exc:
            for job in sale_jobs:
                _finish_job(job, succeeded=False, error_message=str(exc))
            mark_enrichment_jobs_terminal(sale_jobs)
            continue
        if sale is None:
            for job in sale_jobs:
                _finish_job(job,
                    succeeded=False,
                    error_message="sale not found",
                )
            mark_enrichment_jobs_terminal(sale_jobs)
            continue
        job_types = {str(job.get("job_type") or "") for job in sale_jobs}
        fact_claim_jobs = [job for job in sale_jobs if str(job.get("job_type") or "") == "fact_claims"]
        regular_jobs = [job for job in sale_jobs if str(job.get("job_type") or "") != "fact_claims"]
        if fact_claim_jobs:
            for job in fact_claim_jobs:
                try:
                    snapshot = job.get("fact_claims_snapshot")
                    if snapshot is None:
                        # Jobs created before the snapshot column was deployed
                        # retain the bounded legacy fallback path.
                        retry_fact_claims_to_supabase(sale)
                    else:
                        retry_fact_claims_to_supabase(sale, snapshot=snapshot)
                except Exception as exc:
                    LOGGER.exception("Fact claims replay failed for %s: %s", source_url, exc)
                    _finish_job(job, succeeded=False, error_message=str(exc))
                else:
                    _finish_job(job, succeeded=True)
            mark_enrichment_jobs_terminal(fact_claim_jobs)
            sale_jobs = regular_jobs
            job_types = {str(job.get("job_type") or "") for job in sale_jobs}
            if not sale_jobs:
                continue
        if is_expired(sale) or sale.status in {'cancelled', 'withdrawn', 'adjudicated', 'quarantined'}:
            for job in sale_jobs:
                _finish_job(job, succeeded=True)
            mark_enrichment_jobs_terminal(sale_jobs)
            continue
        if job_types & {"fact_extraction", "display_description"} and settings.get("llm_enabled", True) is False:
            for job in sale_jobs:
                _finish_job(
                    job,
                    succeeded=False,
                    cancelled=True,
                    error_message="LLM disabled; no Replicate call made",
                )
            mark_enrichment_jobs_terminal(sale_jobs)
            continue
        try:
            if "pdf" in job_types and sale.documents and not documents_are_current(sale):
                pdf_stats = enrich_sale_from_pdfs(sale)
                analysis = sale.raw_payload.get("document_analysis") or {}
                if pdf_stats.errors or analysis.get("failed_documents"):
                    failed_urls = analysis.get("failed_document_urls") or []
                    failed_paths = [
                        f"{urlsplit(str(url)).hostname}{urlsplit(str(url)).path}"[:180]
                        for url in failed_urls[:3]
                    ]
                    detail = f"{pdf_stats.errors} extraction errors, {analysis.get('failed_documents', 0)} failed documents"
                    if failed_paths:
                        detail += f" ({', '.join(failed_paths)})"
                    raise RuntimeError(f"Document extraction incomplete; retry required: {detail}")
            if job_types & {"fact_extraction", "display_description"}:
                refresh_operational_display(sale)
                # The early scan upsert enqueues a safety-net job before the
                # inline Qwen call. If the final upsert already persisted the
                # current synthesis, completing that job without another paid
                # prediction prevents duplicate Replicate spend.
                description_current = bool(sale.raw_payload.get("llm_display_description")) and not sale.raw_payload.get("source_content_changed") and not _needs_llm_display_description_refresh(
                    sale,
                    prompt_version=prompt_version,
                )
                fact_extraction_planned = (
                    "fact_extraction" in job_types or needs_fact_extraction(sale)
                )
                # A fact pass cannot build a trustworthy context until the PDF
                # worker has populated the document cache.  When the PDF job
                # is in this claim it is handled above; otherwise return the
                # fact/display claim to the queue without spending its retry.
                # This avoids turning an ordinary worker ordering race into a
                # growing retry-exhausted backlog.
                if (
                    fact_extraction_planned
                    and sale.documents
                    and "pdf" not in job_types
                    and not documents_are_current(sale)
                ):
                    if has_eligible_pdf_job_for_sale(source_url):
                        raise QueueJobDeferred(
                            "Fact extraction deferred: PDF text cache is missing or incomplete"
                        )
                    # A terminal/missing PDF prerequisite cannot advance on
                    # the next wake-up. Keep that fact pass visible for review
                    # while allowing an independent display job to proceed.
                    fact_jobs = [job for job in sale_jobs if job.get("job_type") == "fact_extraction"]
                    for job in fact_jobs:
                        _finish_job(
                            job,
                            succeeded=False,
                            cancelled=True,
                            error_message="review_required: PDF prerequisite unavailable",
                        )
                    mark_enrichment_jobs_terminal(fact_jobs)
                    sale_jobs = [job for job in sale_jobs if job.get("job_type") != "fact_extraction"]
                    if not sale_jobs:
                        continue
                    job_types = {str(job.get("job_type") or "") for job in sale_jobs}
                    fact_extraction_planned = False
                facts_current = (
                    has_current_fact_analysis(sale)
                    if fact_extraction_planned
                    else True
                )
                facts_needed = fact_extraction_planned and not facts_current
                if not description_current or facts_needed:
                    if llm_client is None:
                        llm_client = create_llm_client()
                    with llm_request_context(
                        source_url=source_url,
                        job_id=str(sale_jobs[0]["id"]),
                        reason="new_fact_evidence" if facts_needed else "missing_or_stale_display",
                    ):
                        llm_stats = enrich_sale_with_llm(
                            sale, client=llm_client,
                            extraction_mode="structured_then_display" if facts_needed else "display_description",
                        )
                    if llm_stats.unavailable or not llm_stats.valid_json or getattr(llm_stats, "errors", 0):
                        detail = (
                            llm_stats.error_messages[-1]
                            if llm_stats.error_messages
                            else "LLM extraction incomplete"
                        )
                        raise RuntimeError(detail)
                    if not sale.raw_payload.get("llm_display_description") or _needs_llm_display_description_refresh(sale, prompt_version=prompt_version):
                        raise RuntimeError("Missing or stale display description")
                    if fact_extraction_planned and not (sale.raw_payload.get("llm_fact_coverage") or {}).get("complete"):
                        raise RuntimeError("Fact extraction coverage incomplete")
            if "display_description" in job_types or "fact_extraction" in job_types:
                sale.raw_payload.pop("source_content_changed", None)
                sale.raw_payload.pop("source_operational_changed", None)
            if sale.latitude is None or sale.longitude is None:
                geocode_sale(sale)
            fill_tribunal(sale)
            classify_sale_procedure(sale)
            normalize_asset_features(sale)
            upsert_sales_to_supabase([sale], refresh_last_seen=False)
        except PdfExtractionDeferred as exc:
            if exc.progress_made:
                # OCR page checkpoints are real work, but they are not a
                # completed document. Requeue without consuming this job's
                # retry budget so the next worker continues from the page
                # cache. Only this sale's jobs are deferred.
                defer_budget_jobs(sale_jobs, exc)
                mark_enrichment_jobs_terminal(sale_jobs)
                LOGGER.info(
                    "PDF extraction deferred after %s/%s pages for %s; %s new pages checkpointed",
                    exc.checkpointed_pages,
                    exc.total_pages,
                    source_url,
                    exc.new_progress_pages,
                )
            else:
                # A budget stop with no newly successful or explicitly blank
                # page must consume a normal bounded retry; otherwise a
                # permanently unreadable first page would loop forever.
                message = f"{exc}; no new page progress, retry budget consumed"
                LOGGER.warning("PDF extraction made no progress for %s", source_url)
                for job in sale_jobs:
                    _finish_job(job, succeeded=False, error_message=message)
                mark_enrichment_jobs_terminal(sale_jobs)
            continue
        except QueueJobDeferred as exc:
            # Prerequisite coordination is a queue state, not a failed
            # extraction.  The helper releases the claim and restores the
            # attempt count while preserving a bounded wake-up time.
            defer_budget_jobs(sale_jobs, exc)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info("Enrichment prerequisite deferred for %s: %s", source_url, exc)
            continue
        except LLMEnrichmentDeferred as exc:
            defer_budget_jobs(sale_jobs, exc)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info("Fact analysis checkpointed; remaining chunks deferred: %s", source_url)
            continue
        except LLMRequestDeterministicCooldown as exc:
            # A deterministic output failure belongs to one exact sale/prompt
            # key. Do not let its cooldown stall unrelated healthy sales from
            # the same claimed batch.
            defer_budget_jobs(sale_jobs, exc)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info("Deterministic LLM request cooldown deferred: %s", source_url)
            continue
        except PipelineBudgetExhausted as exc:
            defer_budget_jobs(pending_enrichment_jobs, exc)
            LOGGER.info("Enrichment deferred without consuming retry attempts: %s", exc)
            # A general-lane budget exhaustion is a handled queue outcome. The
            # bounded lane worker must continue its detail slots, while the
            # default mixed-batch API keeps its historical handled-job count.
            return len(enrichment_jobs) if family == ENRICHMENT_FAMILY else handled_detail_jobs
        except Exception as exc:
            LOGGER.exception("Enrichment queue failed for %s: %s", source_url, exc)
            for job in sale_jobs:
                _finish_job(job,
                    succeeded=False,
                    error_message=str(exc),
                )
            mark_enrichment_jobs_terminal(sale_jobs)
            continue
        for job in sale_jobs:
            _finish_job(job,
                succeeded=True,
            )
        mark_enrichment_jobs_terminal(sale_jobs)
    return handled_detail_jobs + len(enrichment_jobs)


def run_enrichment_queue_worker(
    *,
    max_jobs: int | None = None,
    budget_seconds: int | None = None,
) -> int:
    """Run one worker and emit an optional post-claim status snapshot."""
    token = _WORKER_CLAIMED_JOB_IDS.set(set())
    try:
        return _run_enrichment_queue_worker(
            max_jobs=max_jobs,
            budget_seconds=budget_seconds,
        )
    finally:
        try:
            _log_worker_claim_status_snapshot(_WORKER_CLAIMED_JOB_IDS.get() or set())
        except Exception as exc:
            # Status telemetry is best effort. In particular, do not let a
            # failure in this post-worker read replace a worker exception.
            LOGGER.warning(
                "Enrichment worker claim status snapshot failed; "
                "ignoring telemetry error: %s",
                exc,
                exc_info=True,
            )
        finally:
            _WORKER_CLAIMED_JOB_IDS.reset(token)


def _run_enrichment_queue_worker(
    *,
    max_jobs: int | None = None,
    budget_seconds: int | None = None,
) -> int:
    """Run one fair, bounded queue worker.

    The historical cycle is five source-detail jobs followed by one general
    enrichment job. When the queue snapshot shows a larger general backlog, the
    worker temporarily alternates the two lanes while retaining at least one
    source-detail slot every other position. Detail claims are grouped into
    small bounded RPC batches, but the jobs remain sequential inside
    ``run_source_detail_jobs`` so provider politeness and sale revision
    ordering are unchanged. An empty preferred lane immediately gives its slot
    to the other lane. A deferred general job counts as handled so an
    exhausted AI budget cannot terminate the remaining source-detail work.

    The claim batch size is deliberately independent from the job budget. It
    reduces claim overhead without increasing the worker's maximum work or
    making a detail job run concurrently. Increase it only after the emitted
    per-lane duration and lease metrics show that the full batch fits safely
    inside the queue lease.
    """
    if max_jobs is None:
        max_jobs = min(
            ENRICHMENT_MAX_JOBS,
            max(1, int(os.getenv("PIPELINE_ENRICHMENT_MAX_JOBS", str(ENRICHMENT_MAX_JOBS)))),
        )
    else:
        max_jobs = min(ENRICHMENT_MAX_JOBS, max(1, int(max_jobs)))
    if budget_seconds is None:
        budget_seconds = min(
            ENRICHMENT_BUDGET_SECONDS,
            max(60, int(os.getenv("PIPELINE_ENRICHMENT_BUDGET_SECONDS", str(ENRICHMENT_BUDGET_SECONDS)))),
        )
    else:
        budget_seconds = max(0, min(ENRICHMENT_BUDGET_SECONDS, int(budget_seconds)))

    started_at = time.monotonic()
    deadline = started_at + budget_seconds
    handled = 0
    handled_by_family = {SOURCE_DETAIL_FAMILY: 0, ENRICHMENT_FAMILY: 0}
    elapsed_by_family = {SOURCE_DETAIL_FAMILY: 0.0, ENRICHMENT_FAMILY: 0.0}
    max_batch_elapsed_by_family = {SOURCE_DETAIL_FAMILY: 0.0, ENRICHMENT_FAMILY: 0.0}
    claim_batches = 0
    stop_reason = "max_jobs"
    provider_clients: dict[str, object] = {}
    due_counts = _read_due_enrichment_family_counts()
    family_cycle = _enrichment_family_cycle(due_counts)
    LOGGER.info(
        "Enrichment worker lane cycle: source_detail=%s enrichment=%s due_estimate=%s",
        family_cycle.count(SOURCE_DETAIL_FAMILY),
        family_cycle.count(ENRICHMENT_FAMILY),
        due_counts,
    )
    slot = 0
    while handled < max_jobs:
        if time.monotonic() >= deadline:
            stop_reason = "budget"
            break
        preferred = family_cycle[slot % len(family_cycle)]
        alternate = ENRICHMENT_FAMILY if preferred == SOURCE_DETAIL_FAMILY else SOURCE_DETAIL_FAMILY
        preferred_limit = _enrichment_claim_limit(
            preferred,
            slot=slot,
            remaining=max_jobs - handled,
            family_cycle=family_cycle,
        )
        claim_batches += 1
        batch_started_at = time.monotonic()
        count = run_enrichment_queue_batch(
            limit=preferred_limit,
            family=preferred,
            provider_clients=provider_clients,
        )
        batch_elapsed = max(time.monotonic() - batch_started_at, 0.0)
        elapsed_by_family[preferred] += batch_elapsed
        max_batch_elapsed_by_family[preferred] = max(
            max_batch_elapsed_by_family[preferred],
            batch_elapsed,
        )
        claimed_family = preferred if count else None
        if not count:
            alternate_limit = _enrichment_claim_limit(
                alternate,
                slot=slot,
                remaining=max_jobs - handled,
                family_cycle=family_cycle,
            )
            claim_batches += 1
            batch_started_at = time.monotonic()
            count = run_enrichment_queue_batch(
                limit=alternate_limit,
                family=alternate,
                provider_clients=provider_clients,
            )
            batch_elapsed = max(time.monotonic() - batch_started_at, 0.0)
            elapsed_by_family[alternate] += batch_elapsed
            max_batch_elapsed_by_family[alternate] = max(
                max_batch_elapsed_by_family[alternate],
                batch_elapsed,
            )
            claimed_family = alternate if count else None
        if not count:
            # Neither family is currently claimable. Avoid spinning against
            # paused/empty queues until the next scheduled worker.
            stop_reason = "queues_empty"
            break
        handled += count
        if claimed_family is not None:
            handled_by_family[claimed_family] += count
        # Advance by jobs, rather than by claim calls, so a detail batch of two
        # still consumes exactly two positions in the five-to-one cycle.
        slot += count
    elapsed_seconds = max(time.monotonic() - started_at, 0.0)
    handled_per_hour = (handled * 3600 / elapsed_seconds) if elapsed_seconds else 0.0
    claimed_job_count = len(_WORKER_CLAIMED_JOB_IDS.get() or ())
    LOGGER.info(
        "Enrichment worker summary: github_run_id=%s handled=%s handled_source_detail=%s "
        "handled_enrichment=%s claimed_jobs=%s "
        "claim_batches=%s elapsed_seconds=%.1f source_detail_seconds=%.1f "
        "source_detail_max_batch_seconds=%.1f source_detail_avg_seconds_per_job=%.1f "
        "enrichment_seconds=%.1f handled_per_hour=%.1f stop=%s "
        "source_detail_claim_batch_size=%s",
        os.getenv("GITHUB_RUN_ID") or "local",
        handled,
        handled_by_family[SOURCE_DETAIL_FAMILY],
        handled_by_family[ENRICHMENT_FAMILY],
        claimed_job_count,
        claim_batches,
        elapsed_seconds,
        elapsed_by_family[SOURCE_DETAIL_FAMILY],
        max_batch_elapsed_by_family[SOURCE_DETAIL_FAMILY],
        (
            elapsed_by_family[SOURCE_DETAIL_FAMILY]
            / handled_by_family[SOURCE_DETAIL_FAMILY]
            if handled_by_family[SOURCE_DETAIL_FAMILY]
            else 0.0
        ),
        elapsed_by_family[ENRICHMENT_FAMILY],
        handled_per_hour,
        stop_reason,
        _enrichment_claim_batch_size(SOURCE_DETAIL_FAMILY),
    )
    return handled


def _read_worker_claim_status_counts(job_ids: set[str]) -> dict[str, int] | None:
    """Read observed statuses for this worker's unique claimed job IDs.

    This is optional telemetry. It uses a short, read-only connection with no
    retry path so an unavailable database never extends the worker lease or
    changes queue behavior.
    """
    if not job_ids:
        return {}
    try:
        settings = load_settings()
        db_url = str(settings.get("supabase_db_url") or "")
        if not db_url:
            return None
        with _postgres_connect(
            db_url,
            connect_timeout=3,
            retry_delays=(),
        ) as connection:
            connection.execute("set transaction read only")
            connection.execute("set local lock_timeout = '1000ms'")
            connection.execute("set local statement_timeout = '3000ms'")
            rows = connection.execute(
                """
                select status, count(*)
                  from public.auction_enrichment_jobs
                 where id = any(%s::uuid[])
                 group by status
                """,
                (sorted(job_ids),),
            ).fetchall()
    except Exception as exc:
        LOGGER.warning(
            "Could not read enrichment worker claim statuses: %s",
            exc,
        )
        return None
    return {str(status): int(count or 0) for status, count in rows}


def _log_worker_claim_status_snapshot(job_ids: set[str]) -> None:
    github_run_id = os.getenv("GITHUB_RUN_ID") or "local"
    if not job_ids:
        LOGGER.info(
            "Enrichment worker claim status snapshot: github_run_id=%s "
            "claimed_jobs=0 snapshot=not_applicable",
            github_run_id,
        )
        return
    status_counts = _read_worker_claim_status_counts(job_ids)
    if status_counts is None:
        LOGGER.info(
            "Enrichment worker claim status snapshot unavailable: github_run_id=%s "
            "claimed_jobs=%s",
            github_run_id,
            len(job_ids),
        )
        return
    known_counts = {
        status: status_counts.get(status, 0)
        for status in WORKER_OBSERVED_STATUS_KEYS
    }
    other_count = sum(
        count
        for status, count in status_counts.items()
        if status not in WORKER_OBSERVED_STATUS_KEYS
    )
    observed_count = sum(known_counts.values()) + other_count
    missing_count = max(len(job_ids) - observed_count, 0)
    LOGGER.info(
        "Enrichment worker claim status snapshot: github_run_id=%s "
        "claimed_jobs=%s observed_status_completed=%s observed_status_failed=%s "
        "observed_status_cancelled=%s observed_status_queued=%s "
        "observed_status_running=%s observed_status_other=%s "
        "observed_status_missing=%s",
        github_run_id,
        len(job_ids),
        known_counts["completed"],
        known_counts["failed"],
        known_counts["cancelled"],
        known_counts["queued"],
        known_counts["running"],
        other_count,
        missing_count,
    )


def _read_due_enrichment_family_counts() -> dict[str, int]:
    """Read a cheap due-backlog estimate without changing queue state.

    The worker is already required to have a transactional database connection
    for autonomous execution.  Keeping this small read-only query here avoids
    adding another RPC or making the SQL claim function decide the worker's
    lane ratio.  This estimate intentionally does not duplicate every claim
    eligibility join (retention, source state, and superseded revisions).  It
    is only a lane-ratio hint: every claim still applies the authoritative SQL
    eligibility checks, and an empty preferred lane immediately falls back to
    the other family.  An unavailable read falls back to the conservative
    historical source-detail-first cycle.
    """
    settings = load_settings()
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        return {}
    try:
        # This count only changes the lane ratio. Never spend the worker budget
        # on the regular write-connection retry sequence for optional telemetry.
        with _postgres_connect(db_url, connect_timeout=3, retry_delays=()) as connection:
            connection.execute("set transaction read only")
            connection.execute("set local lock_timeout = '1000ms'")
            connection.execute("set local statement_timeout = '3000ms'")
            rows = connection.execute(
                """
                select case when job_type = 'source_detail'
                            then 'source_detail' else 'enrichment' end as family,
                       count(*)
                  from public.auction_enrichment_jobs
                 where (
                         status in ('queued', 'failed')
                         or (
                              status = 'running'
                              and coalesce(locked_at, updated_at)
                                  < statement_timestamp() - interval '30 minutes'
                            )
                       )
                   and next_attempt_at <= statement_timestamp()
                   and attempt_count < max_attempts
                 group by 1
                """
            ).fetchall()
    except Exception as exc:
        LOGGER.warning("Could not read enrichment queue lane counts: %s", exc)
        return {}
    return {str(family): int(count or 0) for family, count in rows}


def _enrichment_family_cycle(due_counts: dict[str, int]) -> tuple[str, ...]:
    """Choose a bounded lane ratio from one due-backlog estimate.

    The two lanes alternate only when the estimated due general backlog is
    larger.  The estimate is advisory and cannot make a family unclaimable:
    every preferred-lane miss immediately tries the alternate family.
    Source-detail therefore remains guaranteed at least every other slot, while
    a large general backlog cannot be drained at the historical one-in-six rate.
    The SQL claim still applies its per-source round-robin ordering inside the
    detail lane.
    """
    source_detail = max(0, int(due_counts.get(SOURCE_DETAIL_FAMILY, 0)))
    enrichment = max(0, int(due_counts.get(ENRICHMENT_FAMILY, 0)))
    if enrichment > source_detail:
        return GENERAL_BACKLOG_RELIEF_CYCLE
    return ENRICHMENT_FAMILY_CYCLE


def _enrichment_claim_batch_size(family: str) -> int:
    """Return a bounded claim size for one queue family.

    Only source-detail jobs are grouped. General jobs stay one per claim so a
    long PDF/LLM task cannot reserve an unnecessarily large batch. Invalid or
    out-of-range environment values fall back to the conservative default.
    """
    if family != SOURCE_DETAIL_FAMILY:
        return 1
    raw_value = os.getenv(
        "PIPELINE_ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE",
        str(ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE),
    )
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        value = ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE
    return max(1, min(ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_MAX, value))


def _enrichment_claim_limit(
    family: str,
    *,
    slot: int,
    remaining: int,
    family_cycle: tuple[str, ...] = ENRICHMENT_FAMILY_CYCLE,
) -> int:
    """Bound one claim by both its batch size and its fair-cycle positions."""
    if family != SOURCE_DETAIL_FAMILY:
        return min(1, remaining)
    cycle_position = slot % len(family_cycle)
    detail_positions = 0
    while (
        detail_positions < len(family_cycle)
        and family_cycle[(cycle_position + detail_positions) % len(family_cycle)]
        == SOURCE_DETAIL_FAMILY
    ):
        detail_positions += 1
    # A preferred general claim can be empty.  The alternate detail lane still
    # needs one legal claim position even when the schedule points at general
    # enrichment for this slot.
    if detail_positions == 0:
        detail_positions = 1
    return min(_enrichment_claim_batch_size(family), detail_positions, remaining)


if __name__ == "__main__":
    if "--enrichment-only" in sys.argv:
        # Detail claims are bounded batches, while each job is still processed
        # sequentially so GitHub serializes writers and the queue lease stays
        # visible in the worker summary.
        handled = run_enrichment_queue_worker()
        print(f'Enrichment worker handled {handled} claimed jobs within its bounded budget')
        sys.exit(0)
    sys.exit(main())
