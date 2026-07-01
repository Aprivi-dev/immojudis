from __future__ import annotations

import logging
import sys

from src.main import SOURCE_NAMES, PipelineOptions, run_pipeline
from src.storage.supabase_client import (
    fail_stale_running_runs_in_supabase,
    fetch_next_queued_run_from_supabase,
    finish_run_in_supabase,
    mark_past_sales_in_supabase,
)

LOGGER = logging.getLogger(__name__)
VALID_SOURCES = {"all", *SOURCE_NAMES}


def main() -> int:
    stale_failed = fail_stale_running_runs_in_supabase()
    run = fetch_next_queued_run_from_supabase()
    if not run:
        cleaned = mark_past_sales_in_supabase()
        print(
            f"No queued Immojudis data run found. "
            f"Marked past sales: {cleaned}. Marked stale runs failed: {stale_failed}."
        )
        return 0

    run_id = str(run.get("id") or "")
    source = str(run.get("source") or "all")
    use_llm = run.get("use_llm")
    if not isinstance(use_llm, bool):
        use_llm = True

    if not run_id:
        print("Queued run has no id; skipping.")
        return 1

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


if __name__ == "__main__":
    sys.exit(main())
