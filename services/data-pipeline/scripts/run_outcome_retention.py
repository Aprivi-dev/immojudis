from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src.config import load_settings  # noqa: E402
from src.outcome_ingestion.artifact_store import (  # noqa: E402
    RawArtifactStorageError,
    SupabaseRawArtifactStore,
)
from src.outcome_ingestion.retention import (  # noqa: E402
    OutcomeRetentionError,
    OutcomeRetentionRepository,
    OutcomeRetentionWorker,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Process bounded Outcome purge jobs and private Storage orphans."
    )
    parser.add_argument("--max-jobs", type=_bounded_jobs, default=100)
    parser.add_argument("--orphan-limit", type=_bounded_orphans, default=100)
    parser.add_argument("--orphan-grace-hours", type=_bounded_grace_hours, default=24)
    return parser


def _bounded_jobs(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 1_000:
        raise argparse.ArgumentTypeError("max jobs must be between 1 and 1000")
    return parsed


def _bounded_orphans(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 1_000:
        raise argparse.ArgumentTypeError("orphan limit must be between 1 and 1000")
    return parsed


def _bounded_grace_hours(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 24 * 30:
        raise argparse.ArgumentTypeError("orphan grace hours must be between 1 and 720")
    return parsed


def run(args: argparse.Namespace) -> dict[str, object]:
    settings = load_settings()
    worker_suffix = str(os.getenv("GITHUB_RUN_ID") or uuid4())[:64]
    worker_id = f"outcome-retention-{worker_suffix}"
    repository = OutcomeRetentionRepository(str(settings.get("supabase_db_url") or ""))
    artifact_store = SupabaseRawArtifactStore.from_settings(settings)
    summary = OutcomeRetentionWorker(
        repository=repository,
        artifact_store=artifact_store,
        worker_id=worker_id,
    ).run(
        max_jobs=args.max_jobs,
        orphan_grace_period=timedelta(hours=args.orphan_grace_hours),
        orphan_limit=args.orphan_limit,
    )
    return {
        "schema_version": "outcome_retention_run_v1",
        "worker_version": "outcome-retention/1",
        **asdict(summary),
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = run(args)
    except (OutcomeRetentionError, RawArtifactStorageError, ValueError) as exc:
        print(f"Outcome retention failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
