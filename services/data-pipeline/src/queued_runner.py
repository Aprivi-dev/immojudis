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
from src.config import PDF_TEXTS_DIR, EncheresPubliquesAccessNotAuthorized, load_settings
from src.dpe import enrich_dpe_sales
from src.encheres_publiques_guard import require_encheres_publiques_sale_access
from src.enrichment.extract_structured import (
    LLMEnrichmentDeferred,
    enrich_sale_with_llm,
    has_current_fact_analysis,
    needs_fact_extraction,
)
from src.enrichment.llm_client import cancel_provider_output_refusal_jobs, create_llm_client
from src.enrichment.operational_display import refresh_operational_display
from src.freshness import document_fingerprint, documents_are_current
from src.geocode import geocode_sale
from src.information_agent_evidence import run_information_agent_evidence_batch
from src.llm_requests import (
    LLMRequestBudgetExhausted,
    LLMRequestDeterministicCooldown,
    llm_request_context,
)
from src.llm_task_deadline import LLMTaskDeadlineExceeded, llm_task_deadline_scope
from src.main import (
    SOURCE_NAMES,
    PipelineOptions,
    _needs_llm_display_description_refresh,
    run_llm_description_backfill,
    run_pipeline,
)
from src.pdf_enrichment import (
    PDF_FINALIZATION_MARGIN_SECONDS,
    PdfDeadlineExceeded,
    PdfExtractionDeferred,
    enrich_sale_from_pdfs,
    pdf_deadline_scope,
    sale_storage_id,
)
from src.pdf_failure_diagnostics import format_pdf_failure_diagnostics
from src.pdf_progress import manifest_is_complete, read_modern_cache
from src.pipeline_usage import PipelineBudgetExhausted, QueueJobDeferred, defer_budget_jobs
from src.queue_job_state import finish_job as _finish_claim
from src.sale_procedure import classify_sale_procedure
from src.source_detail_worker import run_source_detail_jobs
from src.source_task_deadline import source_task_deadline_scope
from src.storage.supabase_client import (
    claim_auction_enrichment_jobs_family_from_supabase,
    claim_auction_enrichment_jobs_from_supabase,
    connect,
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
    pdf_enrichment_input_hash_for_sale,
    persist_pdf_document_checkpoint_to_supabase,
    persist_pdf_progress_checkpoint_to_supabase,
    read_pdf_job_states_for_sale,
    restore_persisted_pdf_progress_for_sale,
    retry_fact_claims_to_supabase,
    upsert_cadastre_parcels_to_supabase,
    upsert_dpe_diagnostics_to_supabase,
    upsert_sales_to_supabase,
)
from src.tribunal import fill_tribunal

# Alias de compatibilité : des tests patchent ce nom de module.
_postgres_connect = connect

LOGGER = logging.getLogger(__name__)
VALID_SOURCES = {"all", *SOURCE_NAMES}
LLM_BACKFILL_SOURCE = "llm-description-backfill"
SOURCE_DETAIL_FAMILY = "source_detail"
ENRICHMENT_FAMILY = "enrichment"
# Keep a bounded general-enrichment lane even while source-detail is larger.
# Four slots preserve source-detail priority while reserving 25% of worker
# claims for display/fact/PDF jobs instead of allowing a persistent detail
# backlog to reduce the general lane to one claim in six.
ENRICHMENT_FAMILY_CYCLE = (SOURCE_DETAIL_FAMILY,) * 3 + (ENRICHMENT_FAMILY,)
ENRICHMENT_MAX_JOBS = 180
ENRICHMENT_BUDGET_SECONDS = 1200
PDF_FINALIZATION_MARGIN_FRACTION = PDF_FINALIZATION_MARGIN_SECONDS / ENRICHMENT_BUDGET_SECONDS
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
_ENRICHMENT_JOB_LOG_TYPES = frozenset(
    {
        "pdf",
        "fact_claims",
        "fact_extraction",
        "display_description",
        SOURCE_DETAIL_FAMILY,
        "unknown",
    }
)
_WORKER_CLAIMED_JOB_IDS: ContextVar[set[str] | None] = ContextVar(
    "worker_claimed_job_ids",
    default=None,
)
_WORKER_DEFERRED_JOB_IDS: ContextVar[set[str] | None] = ContextVar(
    "worker_deferred_job_ids",
    default=None,
)
_WORKER_LLM_BUDGET_EXHAUSTED: ContextVar[bool | None] = ContextVar(
    "worker_llm_budget_exhausted",
    default=None,
)


def _job_transition_outcome(*, requested: dict[str, object], persisted: bool) -> str:
    if not persisted:
        return "lease_lost"
    if requested.get("cancelled"):
        return "cancelled"
    return "completed" if requested.get("succeeded") else "failed"


def _log_worker_job_transition(
    job: dict[str, object],
    *,
    outcome: str,
) -> None:
    started_at = job.pop("_worker_started_at_monotonic", None)
    if not isinstance(started_at, (int, float)):
        return
    raw_job_type = str(job.get("job_type") or "").strip().casefold()
    job_type = raw_job_type if raw_job_type in _ENRICHMENT_JOB_LOG_TYPES else "unknown"
    LOGGER.info(
        "Enrichment job transition: job_type=%s outcome=%s elapsed_seconds=%.1f",
        job_type,
        outcome,
        max(time.monotonic() - float(started_at), 0.0),
    )


def _finish_job(job: dict[str, object], **kwargs: object) -> bool:
    try:
        persisted = _finish_claim(
            job,
            finish_impl=finish_auction_enrichment_job_in_supabase,
            **kwargs,
        )
    except Exception:
        _log_worker_job_transition(job, outcome="finish_failed")
        raise
    _log_worker_job_transition(
        job,
        outcome=_job_transition_outcome(requested=kwargs, persisted=bool(persisted)),
    )
    return persisted


def _defer_enrichment_jobs(
    jobs: list[dict[str, object]],
    error: PipelineBudgetExhausted | QueueJobDeferred,
) -> None:
    try:
        defer_budget_jobs(jobs, error)
    except Exception:
        for job in jobs:
            _log_worker_job_transition(job, outcome="defer_failed")
        raise
    for job in jobs:
        _log_worker_job_transition(job, outcome="deferred")


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
    started_at = time.monotonic()
    for job in jobs:
        if isinstance(job, dict):
            job.setdefault("_worker_started_at_monotonic", started_at)
    claimed_job_ids = _WORKER_CLAIMED_JOB_IDS.get()
    if claimed_job_ids is None:
        return
    claimed_job_ids.update(
        str(job.get("id"))
        for job in jobs
        if job.get("id") is not None and str(job.get("id")).strip()
    )


def _record_worker_deferred_job_ids(jobs: list[dict[str, object]]) -> None:
    deferred_job_ids = _WORKER_DEFERRED_JOB_IDS.get()
    if deferred_job_ids is None:
        return
    deferred_job_ids.update(
        str(job.get("id"))
        for job in jobs
        if job.get("id") is not None and str(job.get("id")).strip()
    )


def _pdf_finalization_margin_seconds(budget_seconds: int | float) -> float:
    """Reserve the production 60-second margin, scaled for short test runs."""
    budget = max(0.0, float(budget_seconds))
    return min(PDF_FINALIZATION_MARGIN_SECONDS, budget * PDF_FINALIZATION_MARGIN_FRACTION)


def _persist_pdf_progress_before_defer(
    sale: object,
    sale_jobs: list[dict[str, object]],
    error: PdfExtractionDeferred,
) -> bool:
    """Persist a page checkpoint before releasing a progressed PDF claim."""
    raw_payload = getattr(sale, "raw_payload", None)
    analysis = raw_payload.get("document_analysis") if isinstance(raw_payload, dict) else None
    has_checkpoint = isinstance(analysis, dict) and bool(analysis.get("document_progress"))
    has_in_memory_checkpoint = bool(getattr(error, "partial_pdf_texts", None))
    if not error.progress_made and not has_checkpoint and not has_in_memory_checkpoint:
        return True
    pdf_job = next(
        (job for job in sale_jobs if str(job.get("job_type") or "") == "pdf"),
        None,
    )
    try:
        persisted = _persist_pdf_checkpoint_for_sale(sale, error=error, pdf_job=pdf_job)
    except Exception as checkpoint_error:
        LOGGER.warning("PDF documentary checkpoint failed before defer: %s", checkpoint_error)
        return False
    if not persisted:
        LOGGER.warning("PDF documentary checkpoint was not durable before defer")
    return persisted


def _persist_pdf_checkpoint_for_sale(
    sale: object,
    *,
    error: object | None = None,
    pdf_job: dict[str, object] | None = None,
) -> bool:
    """Persist modern in-memory evidence, with a legacy-cache fallback."""
    raw_payload = getattr(sale, "raw_payload", None)
    direct_texts = getattr(error, "partial_pdf_texts", None)
    if direct_texts is not None or getattr(error, "partial_status_error", None) is not None:
        analysis = getattr(error, "partial_analysis", None) or (raw_payload.get("document_analysis") if isinstance(raw_payload, dict) else None)
        return False if not isinstance(analysis, dict) or not analysis or not isinstance(direct_texts, list) or not direct_texts else persist_pdf_progress_checkpoint_to_supabase(sale, analysis=analysis, pdf_texts=direct_texts, pdf_job=pdf_job)
    analysis = getattr(error, "partial_analysis", None) or (raw_payload.get("document_analysis") if isinstance(raw_payload, dict) else None)
    pdf_texts = None
    try:
        pdf_texts = read_modern_cache(PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json")
    except (OSError, TypeError, ValueError):
        pdf_texts = []
    if isinstance(analysis, dict) and pdf_texts:
        return persist_pdf_progress_checkpoint_to_supabase(
            sale,
            analysis=analysis,
            pdf_texts=pdf_texts,
            pdf_job=pdf_job,
        )
    return persist_pdf_document_checkpoint_to_supabase(sale, pdf_job=pdf_job)


def _consume_pdf_retry_after_checkpoint_failure(
    sale_jobs: list[dict[str, object]],
    error: BaseException,
) -> None:
    """Fail only PDF work when progressed evidence could not be persisted."""
    pdf_jobs = [job for job in sale_jobs if str(job.get("job_type") or "") == "pdf"]
    dependent_jobs = [job for job in sale_jobs if str(job.get("job_type") or "") != "pdf"]
    checkpoint_error = getattr(error, "partial_cache_error", None)
    detail = checkpoint_error or error
    message = _pdf_checkpoint_failure_message(detail)
    for job in pdf_jobs:
        _finish_job(job, succeeded=False, error_message=message)
    if dependent_jobs:
        deferred = QueueJobDeferred("Dependent enrichment deferred until the PDF checkpoint is durable")
        _record_worker_deferred_job_ids(dependent_jobs)
        _defer_enrichment_jobs(dependent_jobs, deferred)


def _pdf_checkpoint_failure_message(error: object) -> str:
    text = str(error)
    prefix = "PDF document checkpoint was not persisted; retry required"
    return text if text.startswith(prefix) else f"{prefix}: {text}"


def _pdf_evidence_is_terminal_for_facts(sale: object) -> bool:
    """Return whether the current PDF pass has no extractable fact evidence.
    ``documents_are_current`` deliberately treats an all-terminal result as
    fresh so the worker does not redownload the same blocked/empty/skipped
    URLs forever.  That freshness signal must not be mistaken for a usable
    fact context: an explicit fact job still needs to be cancelled for
    review when every listed document is excluded and no document was
    extracted.
    """
    documents = getattr(sale, "documents", None)
    raw_payload = getattr(sale, "raw_payload", None)
    if not isinstance(documents, list) or not documents or not isinstance(raw_payload, dict):
        return False
    if not documents_are_current(sale):
        return False
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict):
        return False
    try:
        extracted = int(analysis.get("documents_extracted") or 0)
        failed = int(analysis.get("failed_documents") or 0)
    except (OverflowError, TypeError, ValueError):
        return False
    if extracted != 0 or failed != 0:
        return False
    document_urls = {
        str(document.get("url") or "").strip()
        for document in documents
        if isinstance(document, dict) and str(document.get("url") or "").strip()
    }
    if not document_urls:
        return False
    excluded_urls: set[str] = set()
    for key in ("skipped_document_urls", "blocked_document_urls", "terminal_document_urls"):
        values = analysis.get(key)
        if values is None:
            continue
        if not isinstance(values, (list, tuple, set)):
            return False
        excluded_urls.update(
            str(url).strip()
            for url in values
            if str(url).strip()
        )
    return document_urls.issubset(excluded_urls)


def _pdf_failure_reached_retry_cap(
    sale: object,
    source_url: str,
    *,
    settings: dict[str, object] | None = None,
) -> bool:
    """Return true only for a current revision with an observed exhausted job.
    A missing eligible job is ambiguous: the PDF job may not have been
    generated yet, the queue read may have failed, or a newer revision may be
    waiting. Require a concrete latest PDF row for this input revision at its
    attempt cap before cancelling a fact claim. The persisted analysis marker
    is intentionally not required: a download can fail before the per-document
    failure marker is written, while the queue row still proves exhaustion.
    """
    documents = getattr(sale, "documents", None)
    raw_payload = getattr(sale, "raw_payload", None)
    if not isinstance(documents, list) or not isinstance(raw_payload, dict):
        return False
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict) or analysis.get("input_fingerprint") != document_fingerprint(documents):
        return False
    try:
        current_input_hash = pdf_enrichment_input_hash_for_sale(sale, settings)
        states = read_pdf_job_states_for_sale(source_url, include_terminal=True)
    except Exception as exc:
        LOGGER.info("Could not inspect PDF retry state for %s: %s", source_url, exc)
        return False
    current_states = [
        row for row in states
        if str(row.get("input_hash") or "") == current_input_hash
    ]
    if not current_states:
        return False
    latest = max(
        current_states,
        key=lambda row: (
            str(row.get("created_at") or ""),
            str(row.get("updated_at") or ""),
        ),
    )
    try:
        attempt_count = int(latest.get("attempt_count") or 0)
        max_attempts = int(latest.get("max_attempts") or 0)
    except (OverflowError, TypeError, ValueError):
        return False
    if latest.get("status") != "failed" or max_attempts <= 0 or attempt_count < max_attempts:
        return False
    checked_at = str(analysis.get("checked_at") or "")
    latest_at = str(latest.get("updated_at") or latest.get("created_at") or "")
    return not checked_at or not latest_at or latest_at >= checked_at


def _is_llm_budget_exhausted(error: PipelineBudgetExhausted) -> bool:
    if isinstance(error, LLMRequestBudgetExhausted):
        return True
    message = str(error).lower()
    return "budget exhausted" in message or "budget is exhausted" in message


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
    def record_detail_deferred(job_ids: list[str]) -> None:
        _record_worker_deferred_job_ids([{"id": job_id} for job_id in job_ids])

    handled_detail_jobs = run_source_detail_jobs(
        detail_jobs,
        settings=settings,
        clients=provider_clients,
        on_deferred=record_detail_deferred,
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
        try:
            # The general queue RPC does not join auction_source_state. Keep
            # this fail-closed boundary before fact replay, PDF restoration,
            # LLM calls, or the final catalogue upsert. QueueJobDeferred
            # restores the claim without spending its retry attempt.
            require_encheres_publiques_sale_access(
                source_name=sale.source_name,
                source_url=sale.source_url,
                source_urls=sale.source_urls,
                documents=sale.documents,
                settings=settings,
            )
        except EncheresPubliquesAccessNotAuthorized:
            access_deferred = QueueJobDeferred(
                "Encheres Publiques access authorization required before general enrichment"
            )
            _record_worker_deferred_job_ids(sale_jobs)
            _defer_enrichment_jobs(sale_jobs, access_deferred)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info("Enrichment prerequisite deferred for %s: %s", source_url, access_deferred)
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
        pdf_stage_error = False
        try:
            if sale.documents:
                restore_persisted_pdf_progress_for_sale(sale)
            if "pdf" in job_types and sale.documents and not documents_are_current(sale):
                pdf_stage_error = True
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
                    diagnostics = analysis.get("failed_document_diagnostics")
                    if isinstance(diagnostics, list):
                        fragments = [
                            format_pdf_failure_diagnostics(item)
                            for item in diagnostics[:3]
                            if isinstance(item, dict)
                        ]
                        if fragments:
                            detail += f"; {'; '.join(fragments)}"
                    raise RuntimeError(f"Document extraction incomplete; retry required: {detail}")
                if not manifest_is_complete(analysis, sale.documents):
                    # Persist the merged document checkpoint before releasing
                    # the claim. The PDF budget is per pass, so this durable
                    # row is what lets the next worker select the next URLs
                    # instead of repeating the same first six documents.
                    pdf_job = next(
                        (job for job in sale_jobs if str(job.get("job_type") or "") == "pdf"),
                        None,
                    )
                    checkpointed = _persist_pdf_checkpoint_for_sale(
                        sale,
                        pdf_job=pdf_job,
                    )
                    if not checkpointed:
                        raise RuntimeError(
                            "PDF document checkpoint was not persisted; retry required"
                        )
                    raise QueueJobDeferred(
                        "PDF document manifest is partial; continue the next bounded pass"
                    )
                pdf_stage_error = False
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
                # A verified fact manifest may be reused after the ephemeral
                # PDF text cache is gone. Compute this before the PDF
                # prerequisite branch so that strict cache freshness does not
                # cancel an already current fact pass.
                facts_current = (
                    has_current_fact_analysis(sale)
                    if fact_extraction_planned
                    else True
                )
                facts_needed = fact_extraction_planned and not facts_current
                # A fact pass cannot build a trustworthy context until the PDF
                # worker has populated the document cache.  When the PDF job
                # is in this claim it is handled above; otherwise return the
                # fact/display claim to the queue without spending its retry.
                # This avoids turning an ordinary worker ordering race into a
                # growing retry-exhausted backlog.
                terminal_pdf_evidence = facts_needed and _pdf_evidence_is_terminal_for_facts(sale)
                missing_pdf_prerequisite = (
                    facts_needed
                    and sale.documents
                    and "pdf" not in job_types
                    and not documents_are_current(sale)
                )
                pdf_retry_exhausted = (
                    missing_pdf_prerequisite
                    and _pdf_failure_reached_retry_cap(sale, source_url, settings=settings)
                )
                if terminal_pdf_evidence or missing_pdf_prerequisite:
                    if missing_pdf_prerequisite and not pdf_retry_exhausted and has_eligible_pdf_job_for_sale(source_url):
                        raise QueueJobDeferred(
                            "Fact extraction deferred: PDF text cache is missing or incomplete"
                        )
                    if missing_pdf_prerequisite and not pdf_retry_exhausted and not manifest_is_complete(
                        sale.raw_payload.get("document_analysis"), sale.documents
                    ):
                        raise QueueJobDeferred(
                            "Fact extraction deferred: PDF document manifest is still partial"
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
                            error_message=(
                                "review_required: PDF extraction retry budget exhausted"
                                if pdf_retry_exhausted
                                else (
                                "review_required: no extractable PDF evidence"
                                if terminal_pdf_evidence
                                else "review_required: PDF prerequisite unavailable"
                                )
                            ),
                        )
                    mark_enrichment_jobs_terminal(fact_jobs)
                    sale_jobs = [job for job in sale_jobs if job.get("job_type") != "fact_extraction"]
                    if not sale_jobs:
                        continue
                    job_types = {str(job.get("job_type") or "") for job in sale_jobs}
                    fact_extraction_planned = False
                    facts_current = True
                # Fact cancellation can leave a PDF-only claim. Do not let
                # the original outer branch turn that claim into an
                # unintended display LLM call just because its description is
                # absent. A display job that remains in the filtered group
                # still takes the normal independent path.
                if job_types & {"fact_extraction", "display_description"}:
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
                sale.raw_payload.pop("source_content_change_reason", None)
                sale.raw_payload.pop("source_operational_changed", None)
            if sale.latitude is None or sale.longitude is None:
                geocode_sale(sale)
            fill_tribunal(sale)
            classify_sale_procedure(sale)
            normalize_asset_features(sale)
            upsert_sales_to_supabase([sale], refresh_last_seen=False)
        except EncheresPubliquesAccessNotAuthorized as exc:
            # A non-EP source may redirect a document to Encheres Publiques
            # after the sale-level admission guard.  Treat that boundary as
            # authorization coordination, never as a failed PDF attempt:
            # release every claim and let the configured access gate be fixed
            # before any retry is consumed.
            access_deferred = QueueJobDeferred(
                "Encheres Publiques access authorization required before PDF download"
            )
            _record_worker_deferred_job_ids(sale_jobs)
            _defer_enrichment_jobs(sale_jobs, access_deferred)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info(
                "Enrichment deferred after an unauthorized Encheres Publiques document target for %s: %s",
                source_url,
                exc,
            )
            continue
        except PdfDeadlineExceeded as exc:
            # The worker cutoff is coordination, even when no page finished.
            # Release the claim and restore its attempt so a slow PDF cannot
            # become a false OCR failure or consume the bounded retry budget.
            if not _persist_pdf_progress_before_defer(sale, sale_jobs, exc):
                _consume_pdf_retry_after_checkpoint_failure(sale_jobs, exc)
                mark_enrichment_jobs_terminal(sale_jobs)
                continue
            _record_worker_deferred_job_ids(sale_jobs)
            _defer_enrichment_jobs(sale_jobs, exc)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info(
                "PDF extraction deferred at worker deadline after %s/%s pages for %s",
                exc.checkpointed_pages,
                exc.total_pages,
                source_url,
            )
            continue
        except PdfExtractionDeferred as exc:
            if exc.progress_made:
                # OCR page checkpoints are real work, but they are not a
                # completed document. Requeue without consuming this job's
                # retry budget so the next worker continues from the page
                # cache. Only this sale's jobs are deferred.
                if not _persist_pdf_progress_before_defer(sale, sale_jobs, exc):
                    _consume_pdf_retry_after_checkpoint_failure(sale_jobs, exc)
                    mark_enrichment_jobs_terminal(sale_jobs)
                    continue
                _record_worker_deferred_job_ids(sale_jobs)
                _defer_enrichment_jobs(sale_jobs, exc)
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
                # page must consume the PDF retry; otherwise an unreadable
                # first page would loop forever. Dependent LLM claims retain
                # their attempts because they still have no usable evidence.
                checkpointed = _persist_pdf_progress_before_defer(sale, sale_jobs, exc)
                message = (
                    _pdf_checkpoint_failure_message(exc)
                    if not checkpointed
                    else f"{exc}; no new page progress, retry budget consumed"
                )
                LOGGER.warning("PDF extraction made no progress for %s", source_url)
                pdf_jobs = [job for job in sale_jobs if job.get("job_type") == "pdf"]
                dependent_jobs = [job for job in sale_jobs if job.get("job_type") != "pdf"]
                for job in pdf_jobs:
                    _finish_job(job, succeeded=False, error_message=message)
                if dependent_jobs and pdf_jobs:
                    deferred = QueueJobDeferred(
                        "Dependent enrichment deferred until the PDF retry state is resolved"
                    )
                    _record_worker_deferred_job_ids(dependent_jobs)
                    _defer_enrichment_jobs(dependent_jobs, deferred)
                elif not pdf_jobs:
                    for job in dependent_jobs:
                        _finish_job(job, succeeded=False, error_message=message)
                mark_enrichment_jobs_terminal(sale_jobs)
            continue
        except LLMTaskDeadlineExceeded as exc:
            # The shared worker cutoff also covers provider cadence, creation
            # and polling. Release every still-owned claim in this batch;
            # no following sale may start another paid request after the cutoff.
            _record_worker_deferred_job_ids(pending_enrichment_jobs)
            _defer_enrichment_jobs(pending_enrichment_jobs, exc)
            LOGGER.info("LLM worker deadline reached; remaining enrichment claims deferred: %s", exc)
            return len(enrichment_jobs) if family == ENRICHMENT_FAMILY else handled_detail_jobs
        except QueueJobDeferred as exc:
            # Prerequisite coordination is a queue state, not a failed
            # extraction.  The helper releases the claim and restores the
            # attempt count while preserving a bounded wake-up time.
            _record_worker_deferred_job_ids(sale_jobs)
            _defer_enrichment_jobs(sale_jobs, exc)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info("Enrichment prerequisite deferred for %s: %s", source_url, exc)
            continue
        except LLMEnrichmentDeferred as exc:
            _record_worker_deferred_job_ids(sale_jobs)
            _defer_enrichment_jobs(sale_jobs, exc)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info("Fact analysis checkpointed; remaining chunks deferred: %s", source_url)
            continue
        except LLMRequestDeterministicCooldown as exc:
            # A deterministic output failure belongs to one exact sale/prompt
            # key. Do not let its cooldown stall unrelated healthy sales from
            # the same claimed batch.
            _record_worker_deferred_job_ids(sale_jobs)
            _defer_enrichment_jobs(sale_jobs, exc)
            mark_enrichment_jobs_terminal(sale_jobs)
            LOGGER.info("Deterministic LLM request cooldown deferred: %s", source_url)
            continue
        except PipelineBudgetExhausted as exc:
            _record_worker_deferred_job_ids(pending_enrichment_jobs)
            _defer_enrichment_jobs(pending_enrichment_jobs, exc)
            LOGGER.info("Enrichment deferred without consuming retry attempts: %s", exc)
            # The family claim is intentionally kept as a handled queue
            # outcome for legacy direct callers.  A bounded worker marks the
            # general lane unavailable for the remainder of this run when the
            # provider budget is exhausted, so it does not claim another job
            # that can only be deferred again.
            if (
                family == ENRICHMENT_FAMILY
                and _is_llm_budget_exhausted(exc)
                and _WORKER_LLM_BUDGET_EXHAUSTED.get() is not None
            ):
                _WORKER_LLM_BUDGET_EXHAUSTED.set(True)
            # A general-lane budget exhaustion is a handled queue outcome. The
            # bounded lane worker must continue its detail slots, while the
            # default mixed-batch API keeps its historical handled-job count.
            return len(enrichment_jobs) if family == ENRICHMENT_FAMILY else handled_detail_jobs
        except Exception as exc:
            if cancel_provider_output_refusal_jobs(
                exc, sale_jobs, finish_job=_finish_job, mark_terminal=mark_enrichment_jobs_terminal
            ):
                continue
            LOGGER.exception("Enrichment queue failed for %s: %s", source_url, exc)
            analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
            try:
                pdf_failed_documents = int(analysis.get("failed_documents") or 0) if isinstance(analysis, dict) else 0
            except (OverflowError, TypeError, ValueError):
                pdf_failed_documents = 0
            dependent_jobs = [
                job
                for job in sale_jobs
                if str(job.get("job_type") or "") != "pdf"
            ]
            pdf_failure = "pdf" in job_types and (pdf_stage_error or pdf_failed_documents > 0)
            pdf_jobs = [job for job in sale_jobs if str(job.get("job_type") or "") == "pdf"]
            checkpoint_persisted = True
            if pdf_failure:
                try:
                    persisted = _persist_pdf_checkpoint_for_sale(
                        sale,
                        pdf_job=pdf_jobs[0] if pdf_jobs else None,
                    )
                except Exception as checkpoint_exc:
                    persisted = False
                    LOGGER.warning(
                        "PDF documentary checkpoint failed for %s; keeping the PDF retry authoritative: %s",
                        source_url,
                        checkpoint_exc,
                    )
                if not persisted:
                    checkpoint_persisted = False
                    LOGGER.warning(
                        "PDF documentary checkpoint was not durable for %s; no dependent claim will be spent",
                        source_url,
                    )
            if pdf_failure and dependent_jobs:
                pdf_error_message = _pdf_checkpoint_failure_message(exc) if not checkpoint_persisted else str(exc)
                for job in pdf_jobs:
                    _finish_job(
                        job,
                        succeeded=False,
                        error_message=pdf_error_message,
                    )
                deferred = QueueJobDeferred(
                    "Dependent enrichment deferred until the PDF retry state is resolved"
                )
                _record_worker_deferred_job_ids(dependent_jobs)
                _defer_enrichment_jobs(dependent_jobs, deferred)
                mark_enrichment_jobs_terminal(sale_jobs)
                LOGGER.info(
                    "Deferred dependent enrichment after PDF failure for %s: %s",
                    source_url,
                    exc,
                )
                continue
            for job in sale_jobs:
                error_message = (
                    _pdf_checkpoint_failure_message(exc)
                    if not checkpoint_persisted and str(job.get("job_type") or "") == "pdf"
                    else str(exc)
                )
                _finish_job(job,
                    succeeded=False,
                    error_message=error_message,
                )
            mark_enrichment_jobs_terminal(sale_jobs)
            continue
        for job in sale_jobs:
            _finish_job(job,
                succeeded=True,
            )
        mark_enrichment_jobs_terminal(sale_jobs)
    return handled_detail_jobs + len(enrichment_jobs)


def _run_enrichment_queue_batch_with_deadline(
    *,
    limit: int,
    family: str,
    provider_clients: dict[str, object],
    worker_deadline: float,
    finalization_margin_seconds: float,
) -> int:
    """Run one claim with task cutoffs that leave worker finalization time."""

    pdf_deadline = worker_deadline - finalization_margin_seconds
    if time.monotonic() >= pdf_deadline:
        # Recheck immediately before the claim RPC as the outer worker check
        # can race with a batch that finishes at the cutoff.
        return 0
    with (
        pdf_deadline_scope(pdf_deadline),
        source_task_deadline_scope(pdf_deadline),
        llm_task_deadline_scope(pdf_deadline),
    ):
        return run_enrichment_queue_batch(
            limit=limit,
            family=family,
            provider_clients=provider_clients,
        )


def run_enrichment_queue_worker(
    *,
    max_jobs: int | None = None,
    budget_seconds: int | None = None,
) -> int:
    """Run one worker and emit an optional post-claim status snapshot."""
    claimed_token = _WORKER_CLAIMED_JOB_IDS.set(set())
    deferred_token = _WORKER_DEFERRED_JOB_IDS.set(set())
    budget_token = _WORKER_LLM_BUDGET_EXHAUSTED.set(False)
    try:
        return _run_enrichment_queue_worker(
            max_jobs=max_jobs,
            budget_seconds=budget_seconds,
        )
    finally:
        try:
            claimed_job_ids = _WORKER_CLAIMED_JOB_IDS.get() or set()
            status_counts = _log_worker_claim_status_snapshot(claimed_job_ids)
            _log_worker_outcome_summary(claimed_job_ids, status_counts)
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
            _WORKER_LLM_BUDGET_EXHAUSTED.reset(budget_token)
            _WORKER_DEFERRED_JOB_IDS.reset(deferred_token)
            _WORKER_CLAIMED_JOB_IDS.reset(claimed_token)


def _run_enrichment_queue_worker(
    *,
    max_jobs: int | None = None,
    budget_seconds: int | None = None,
) -> int:
    """Run one fair, bounded queue worker.

    The bounded cycle is three source-detail jobs followed by one general
    enrichment job. When the queue snapshot shows a larger general backlog, the
    worker temporarily alternates the two lanes while retaining at least one
    source-detail slot every other position. Detail claims are grouped into
    small bounded RPC batches, but the jobs remain sequential inside
    ``run_source_detail_jobs`` so provider politeness and sale revision
    ordering are unchanged. An empty preferred lane immediately gives its slot
    to the other lane. A deferred general claim remains a queue outcome for
    compatibility with direct callers. Once the bounded worker sees an actual
    provider-budget exhaustion, it stops claiming the general lane for this
    run and spends its remaining fixed budget on source-detail work.

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
    # Do not start a fresh claim in the finalization margin.  A claim can
    # otherwise arrive after the last PDF cutoff and spend the margin merely
    # being deferred, even though it did no useful work.
    finalization_margin_seconds = _pdf_finalization_margin_seconds(budget_seconds)
    claim_deadline = deadline - finalization_margin_seconds
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
        now = time.monotonic()
        if now >= claim_deadline:
            stop_reason = "budget" if now >= deadline else "finalization_margin"
            break
        if _WORKER_LLM_BUDGET_EXHAUSTED.get():
            # A budget exception restores every claimed job's attempt and
            # gives it a future wake-up.  Do not immediately claim another
            # general job that will hit the same guard; use the remaining
            # fixed worker budget for source-detail work instead.
            preferred = SOURCE_DETAIL_FAMILY
            alternate = None
        else:
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
        count = _run_enrichment_queue_batch_with_deadline(
            limit=preferred_limit,
            family=preferred,
            provider_clients=provider_clients,
            worker_deadline=deadline,
            finalization_margin_seconds=finalization_margin_seconds,
        )
        batch_elapsed = max(time.monotonic() - batch_started_at, 0.0)
        elapsed_by_family[preferred] += batch_elapsed
        max_batch_elapsed_by_family[preferred] = max(
            max_batch_elapsed_by_family[preferred],
            batch_elapsed,
        )
        claimed_family = preferred if count else None
        if not count and alternate is not None:
            now = time.monotonic()
            if now >= claim_deadline:
                stop_reason = "budget" if now >= deadline else "finalization_margin"
                break
            alternate_limit = _enrichment_claim_limit(
                alternate,
                slot=slot,
                remaining=max_jobs - handled,
                family_cycle=family_cycle,
            )
            claim_batches += 1
            batch_started_at = time.monotonic()
            count = _run_enrichment_queue_batch_with_deadline(
                limit=alternate_limit,
                family=alternate,
                provider_clients=provider_clients,
                worker_deadline=deadline,
                finalization_margin_seconds=finalization_margin_seconds,
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
        # still consumes exactly two positions in the lane cycle.
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


def _log_worker_claim_status_snapshot(job_ids: set[str]) -> dict[str, int] | None:
    github_run_id = os.getenv("GITHUB_RUN_ID") or "local"
    LOGGER.info("Worker claimed ids: run=%s ids=%s", github_run_id, sorted(job_ids))
    if not job_ids:
        LOGGER.info(
            "Enrichment worker claim status snapshot: github_run_id=%s "
            "claimed_jobs=0 snapshot=not_applicable",
            github_run_id,
        )
        return {}
    status_counts = _read_worker_claim_status_counts(job_ids)
    if status_counts is None:
        LOGGER.info(
            "Enrichment worker claim status snapshot unavailable: github_run_id=%s "
            "claimed_jobs=%s",
            github_run_id,
            len(job_ids),
        )
        return None
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
    return status_counts


def _log_worker_outcome_summary(
    job_ids: set[str],
    status_counts: dict[str, int] | None,
) -> None:
    """Log terminal statuses separately from queue outcomes and deferrals.

    ``run_enrichment_queue_batch`` returns a claim outcome count for backwards
    compatibility.  It is not a success count: a claimed job may be failed,
    cancelled, or restored to ``queued`` after a bounded deferral.  The final
    read-only status snapshot is therefore the source for terminal counts;
    deferred IDs are reported as requests made by this worker and are kept
    separate from observed queued rows when the optional read is unavailable.
    """
    github_run_id = os.getenv("GITHUB_RUN_ID") or "local"
    deferred_job_ids = _WORKER_DEFERRED_JOB_IDS.get() or set()
    if status_counts is None:
        LOGGER.info(
            "Enrichment worker outcome summary: github_run_id=%s claimed=%s "
            "deferred_requested=%s status_snapshot=unavailable",
            github_run_id,
            len(job_ids),
            len(deferred_job_ids),
        )
        return
    observed = sum(status_counts.values())
    missing = max(len(job_ids) - observed, 0)
    LOGGER.info(
        "Enrichment worker outcome summary: github_run_id=%s claimed=%s "
        "completed=%s failed=%s cancelled=%s deferred_requested=%s "
        "observed_queued=%s observed_running=%s observed_other=%s missing=%s",
        github_run_id,
        len(job_ids),
        status_counts.get("completed", 0),
        status_counts.get("failed", 0),
        status_counts.get("cancelled", 0),
        len(deferred_job_ids),
        status_counts.get("queued", 0),
        status_counts.get("running", 0),
        sum(
            count
            for status, count in status_counts.items()
            if status not in WORKER_OBSERVED_STATUS_KEYS
        ),
        missing,
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
    the other family.  An unavailable read is handled by the caller with a
    neutral cycle so a transient telemetry failure cannot starve one family.
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

    The two lanes alternate when the estimated due general backlog is larger.
    If the optional read is unavailable, use the neutral 1:1 cycle instead of
    silently falling back to source-detail priority.  A degraded database
    connection must not turn a transient telemetry failure into starvation of
    display, fact, or PDF jobs.  The estimate is advisory and cannot make a
    family unclaimable: every preferred-lane miss immediately tries the
    alternate family.  When the estimate is available and source-detail is
    larger, source-detail remains guaranteed at least every fourth slot.
    The SQL claim still applies its per-source round-robin ordering inside the
    detail lane.
    """
    if not due_counts:
        return GENERAL_BACKLOG_RELIEF_CYCLE
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


def _run_as_script() -> int:
    if "--enrichment-only" in sys.argv:
        # Detail claims are bounded batches, while each job is still processed
        # sequentially so GitHub serializes writers and the queue lease stays
        # visible in the worker summary.
        claim_outcomes = run_enrichment_queue_worker()
        print(
            f'Enrichment worker recorded {claim_outcomes} bounded claim outcomes; '
            'terminal statuses are reported separately'
        )
        return 0
    return main()


if __name__ == "__main__":
    from src.catalogue_lock import catalogue_writer_lock

    # The queue worker writes sales like the pipeline does; share its lock.
    with catalogue_writer_lock(label="enrichment queue worker"):
        sys.exit(_run_as_script())
