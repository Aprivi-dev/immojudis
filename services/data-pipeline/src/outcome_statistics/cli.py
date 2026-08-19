from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from datetime import UTC, datetime

from dotenv import load_dotenv

from src.config import ROOT_DIR
from src.outcome_statistics.engine import build_statistics_bundle, calculate_period
from src.outcome_statistics.models import StatisticsBundle
from src.outcome_statistics.repository import (
    OutcomeStatisticsRepository,
    OutcomeStatisticsRepositoryError,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Build immutable, evidence-gated national and tribunal statistics. Read-only unless --persist is explicit."
        )
    )
    parser.add_argument(
        "--max-rounds",
        type=_positive_int,
        required=True,
        help="Hard ceiling for the complete mature-round universe; aborts if exceeded.",
    )
    parser.add_argument(
        "--window-months",
        type=int,
        choices=(12, 24, 36),
        action="append",
        dest="windows",
        help="Repeat to select windows. Defaults to 12, 24 and 36.",
    )
    parser.add_argument(
        "--knowledge-cutoff-at",
        type=_iso_datetime,
        default=None,
        help="Timezone-aware ISO-8601 cutoff. Defaults to the current UTC instant.",
    )
    parser.add_argument(
        "--maturity-days",
        type=_maturity_days,
        default=30,
        help="Exclude the most recent incomplete period (default: 30 days).",
    )
    parser.add_argument(
        "--round-kind",
        choices=("initial",),
        default="initial",
        help="Build one isolated round kind only (default: initial).",
    )
    parser.add_argument(
        "--persist",
        action="store_true",
        help="Persist snapshots transactionally. Omit for a read-only dry-run.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_dotenv(ROOT_DIR / ".env")
    if os.getenv("TRIBUNAL_STATISTICS_ENABLED") != "true":
        _print_error("tribunal statistics are disabled; set TRIBUNAL_STATISTICS_ENABLED=true explicitly")
        return 2
    db_url = (os.getenv("SUPABASE_DB_URL") or "").strip()
    if not db_url:
        _print_error("SUPABASE_DB_URL is required")
        return 2

    cutoff = args.knowledge_cutoff_at or datetime.now(UTC)
    computed_at = datetime.now(UTC)
    if cutoff > computed_at:
        _print_error("knowledge cutoff cannot be in the future")
        return 2
    windows = tuple(sorted(set(args.windows or (12, 24, 36))))
    periods = [calculate_period(cutoff, window, args.maturity_days) for window in windows]
    repository = OutcomeStatisticsRepository(db_url)
    try:
        with repository.serialized_source_view():
            rounds = repository.load_rounds(
                period_start=min(period.start for period in periods),
                period_end=max(period.end for period in periods),
                knowledge_cutoff_at=cutoff,
                round_kind=args.round_kind,
                max_rounds=args.max_rounds,
            )
            bundles = tuple(
                build_statistics_bundle(
                    rounds,
                    knowledge_cutoff_at=cutoff,
                    window_months=window,
                    maturity_days=args.maturity_days,
                    round_kind=args.round_kind,
                    computed_at=computed_at,
                )
                for window in windows
            )
            persisted = repository.persist_bundles(bundles) if args.persist else None
    except OutcomeStatisticsRepositoryError:
        _print_error("statistics database operation failed")
        return 2
    except (ArithmeticError, ValueError):
        _print_error("statistics input or computation validation failed")
        return 2

    _print_json(
        {
            "schema_version": "tribunal_statistics_run_v1",
            "mode": "persist" if args.persist else "dry-run",
            "round_kind": args.round_kind,
            "knowledge_cutoff_at": cutoff.isoformat(),
            "maturity_days": args.maturity_days,
            "max_rounds": args.max_rounds,
            "loaded_rounds": len(rounds),
            "windows": [_bundle_summary(bundle) for bundle in bundles],
            "writes": (
                {
                    "snapshots_inserted": persisted.inserted_snapshots,
                    "snapshots_reused": persisted.reused_snapshots,
                    "members_inserted": persisted.inserted_members,
                }
                if persisted
                else {
                    "snapshots_inserted": 0,
                    "snapshots_reused": 0,
                    "members_inserted": 0,
                }
            ),
        }
    )
    return 0


def _bundle_summary(bundle: StatisticsBundle) -> dict[str, object]:
    levels: dict[str, int] = {}
    for snapshot in (bundle.national, *bundle.tribunals):
        levels[snapshot.reliability_status] = levels.get(snapshot.reliability_status, 0) + 1
    return {
        "window_months": bundle.national.period.window_months,
        "period_start": bundle.national.period.start.isoformat(),
        "period_end": bundle.national.period.end.isoformat(),
        "national_eligible_rounds": bundle.national.eligible_round_count,
        "national_unfrozen_round_count": bundle.national.unfrozen_round_count,
        "national_freeze_coverage": bundle.national.freeze_coverage,
        "national_status_sample_size": bundle.national.status_sample_size,
        "national_quality_gate_passed": bundle.national.quality_gate_passed,
        "national_reliability": bundle.national.reliability_status,
        "tribunal_count": len(bundle.tribunals),
        "reliability_counts": dict(sorted(levels.items())),
        "python_preview_source_manifest_hash": bundle.national.source_manifest_hash,
        "python_preview_statistics_hash": bundle.national.statistics_hash,
    }


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _maturity_days(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 365:
        raise argparse.ArgumentTypeError("value must be between 1 and 365")
    return parsed


def _iso_datetime(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("value must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise argparse.ArgumentTypeError("datetime must include a UTC offset")
    return parsed.astimezone(UTC)


def _print_json(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _print_error(message: str) -> None:
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
