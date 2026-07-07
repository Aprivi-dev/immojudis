from __future__ import annotations

import logging
import sys

from src.cadastre import enrich_cadastre_sales
from src.config import load_settings
from src.dpe import enrich_dpe_sales
from src.main import SOURCE_NAMES, PipelineOptions, run_llm_description_backfill, run_pipeline
from src.storage.supabase_client import (
    fail_stale_running_runs_in_supabase,
    fetch_next_data_refresh_request_from_supabase,
    fetch_next_queued_run_from_supabase,
    fetch_sale_for_data_refresh,
    finish_data_refresh_request_in_supabase,
    finish_run_in_supabase,
    mark_past_sales_in_supabase,
    upsert_cadastre_parcels_to_supabase,
    upsert_dpe_diagnostics_to_supabase,
)

LOGGER = logging.getLogger(__name__)
VALID_SOURCES = {"all", *SOURCE_NAMES}
LLM_BACKFILL_SOURCE = "llm-description-backfill"


def main() -> int:
    stale_failed = fail_stale_running_runs_in_supabase()
    run = fetch_next_queued_run_from_supabase()
    if not run:
        refresh_request = fetch_next_data_refresh_request_from_supabase()
        if refresh_request:
            return run_data_refresh_request(refresh_request)
        settings = load_settings()
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
    # Every queued scroll must produce the public AI display description. Older
    # queued rows may still carry use_llm=false, so the worker treats the flag as
    # legacy metadata and enforces the current product rule here.
    use_llm = True

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


if __name__ == "__main__":
    sys.exit(main())
