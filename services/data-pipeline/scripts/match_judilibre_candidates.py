from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src.config import load_settings  # noqa: E402
from src.outcome_ingestion.judilibre_matching import (  # noqa: E402
    JUDILIBRE_MATCH_CONTEXT_LIMIT_DEFAULT,
    JUDILIBRE_MATCH_CONTEXT_LIMIT_MAX,
    JUDILIBRE_MATCH_DATE_DELTA_DAYS_DEFAULT,
    JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX,
    JUDILIBRE_MATCH_PAGE_SIZE_DEFAULT,
    JUDILIBRE_MATCH_PAGE_SIZE_MAX,
    JUDILIBRE_MATCH_SOURCE_LIMIT_MAX,
    JudilibreDecisionMatchingService,
)
from src.outcome_ingestion.repository import (  # noqa: E402
    OutcomeIngestionError,
    OutcomeIngestionRepository,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Build bounded, review-only Judilibre-to-auction match candidates. "
            "The command is read-only unless --persist is explicit."
        )
    )
    parser.add_argument(
        "--limit",
        type=_bounded_source_limit,
        required=True,
        help="Global maximum current Judilibre source records scanned.",
    )
    parser.add_argument(
        "--page-size",
        type=_bounded_page_size,
        default=JUDILIBRE_MATCH_PAGE_SIZE_DEFAULT,
        help="Current source-record rows loaded per page.",
    )
    parser.add_argument(
        "--context-limit",
        type=_bounded_context_limit,
        default=JUDILIBRE_MATCH_CONTEXT_LIMIT_DEFAULT,
        help="Maximum auction contexts accepted for one decision.",
    )
    parser.add_argument(
        "--max-date-delta-days",
        type=_bounded_date_delta,
        default=JUDILIBRE_MATCH_DATE_DELTA_DAYS_DEFAULT,
        help="Maximum absolute distance between decision and hearing dates.",
    )
    parser.add_argument(
        "--after-source-record-id",
        default=None,
        help="Resume after an internal source-record UUID from a prior bounded run.",
    )
    parser.add_argument(
        "--persist",
        action="store_true",
        help=(
            "Append candidate rows requiring human review. Never confirms a match, "
            "creates an outcome or changes training eligibility."
        ),
    )
    return parser


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _bounded_source_limit(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > JUDILIBRE_MATCH_SOURCE_LIMIT_MAX:
        raise argparse.ArgumentTypeError(
            f"value must not exceed {JUDILIBRE_MATCH_SOURCE_LIMIT_MAX}"
        )
    return parsed


def _bounded_page_size(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > JUDILIBRE_MATCH_PAGE_SIZE_MAX:
        raise argparse.ArgumentTypeError(
            f"value must not exceed {JUDILIBRE_MATCH_PAGE_SIZE_MAX}"
        )
    return parsed


def _bounded_context_limit(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > JUDILIBRE_MATCH_CONTEXT_LIMIT_MAX:
        raise argparse.ArgumentTypeError(
            f"value must not exceed {JUDILIBRE_MATCH_CONTEXT_LIMIT_MAX}"
        )
    return parsed


def _bounded_date_delta(value: str) -> int:
    parsed = int(value)
    if not 0 <= parsed <= JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX:
        raise argparse.ArgumentTypeError(
            "value must be between 0 and "
            f"{JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX}"
        )
    return parsed


def run(args: argparse.Namespace) -> dict[str, Any]:
    settings = load_settings()
    repository = OutcomeIngestionRepository.from_settings(settings)
    if args.persist:
        # Persistence is gated twice: explicit CLI intent and an active,
        # approved automated-source policy in the database.
        repository.require_source_policy("judilibre", "automated")
    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=args.limit,
        context_limit=args.context_limit,
        max_date_delta_days=args.max_date_delta_days,
        page_size=args.page_size,
        after_source_record_id=args.after_source_record_id,
        persist=bool(args.persist),
    )
    return {
        "schema_version": "judilibre_match_diagnostic_v1",
        "mode": "judilibre-review-candidate-matching",
        **asdict(summary),
        "writes": summary.writes,
        "persist_requested": bool(args.persist),
        "review_required": True,
        "raw_text_read": False,
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = run(args)
    except (OutcomeIngestionError, ValueError) as exc:
        print(f"Judilibre matching command failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
