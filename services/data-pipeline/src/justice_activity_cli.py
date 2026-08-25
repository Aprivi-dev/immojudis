from __future__ import annotations

import argparse
import json
import os
from collections.abc import Sequence
from datetime import UTC, date, datetime
from pathlib import Path

from src.config import RAW_DIR, load_settings
from src.justice_activity_pipeline import (
    JusticeActivityPipelineError,
    JusticeActivityRepository,
    build_coverage_report,
    build_judicial_region_reference,
    enrich_court_judicial_regions,
    match_activity_records,
)
from src.official_sources.justice_activity import (
    JusticeActivityClient,
    parse_justice_activity_html,
)
from src.official_sources.justice_open_data import (
    parse_justice_competences_csv,
    validate_justice_competence_semantics,
)

_DEFAULT_COMPETENCES_PATH = (
    RAW_DIR / "outcome_sources" / "justice_courts" / "resource-e2a1941b-observed-competences.csv"
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate historical StatJur activity and produce an ImmoJudis coverage report.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--html", type=Path, help="Previously captured official T1 HTML fragment.")
    source.add_argument("--fetch", action="store_true", help="Fetch the reviewed StatJur endpoint.")
    parser.add_argument("--year", type=int, help="Activity year; latest published year when fetching.")
    parser.add_argument("--source-version", help="Required with --html, for example v26.02.2.")
    parser.add_argument("--as-of", type=date.fromisoformat, default=date.today())
    parser.add_argument("--persist", action="store_true", help="Append the validated snapshot to Supabase.")
    parser.add_argument("--pilot-count", type=int, default=5, choices=range(3, 6))
    parser.add_argument(
        "--competences",
        type=Path,
        default=_DEFAULT_COMPETENCES_PATH,
        help="Official Justice commune/court reference used to derive appellate regions.",
    )
    parser.add_argument("--output", type=Path, help="Optional JSON report path.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings()
    db_url = str(settings.get("supabase_db_url") or "")
    enabled = os.getenv("JUSTICE_ACTIVITY_ENABLED", "false").casefold() in {"1", "true", "yes", "on"}
    if args.fetch and not enabled:
        raise JusticeActivityPipelineError("JUSTICE_ACTIVITY_ENABLED=true is required for StatJur network access")
    if args.persist and not enabled:
        raise JusticeActivityPipelineError("JUSTICE_ACTIVITY_ENABLED=true is required for persistence")
    if args.persist and not db_url:
        raise JusticeActivityPipelineError("SUPABASE_DB_URL is required for persistence")

    if args.html:
        if args.year is None or not args.source_version:
            raise JusticeActivityPipelineError("--html requires --year and --source-version")
        result = parse_justice_activity_html(
            args.html.read_bytes(),
            activity_year=args.year,
            source_version=args.source_version,
        )
    else:
        with JusticeActivityClient() as client:
            available_years = client.available_years()
            year = args.year or max(available_years)
            result = client.fetch_year(
                year,
                source_version=client.source_version(),
                available_years=available_years,
            )

    fetched_at = datetime.now(UTC)
    repository = JusticeActivityRepository()
    if db_url:
        courts, catalogue_counts, catalogue_total_sales = repository.load_courts_and_catalogue_counts(
            db_url,
            as_of=args.as_of,
        )
        if args.competences.exists():
            competence_result = parse_justice_competences_csv(args.competences)
            validate_justice_competence_semantics(competence_result)
            courts = enrich_court_judicial_regions(
                courts,
                build_judicial_region_reference(competence_result.records),
            )
        matches = match_activity_records(result.records, courts)
        report = build_coverage_report(
            result=result,
            matches=matches,
            catalogue_counts=catalogue_counts,
            catalogue_total_sales=catalogue_total_sales,
            generated_at=fetched_at,
            pilot_count=args.pilot_count,
        )
        persisted = (
            repository.persist(db_url, result=result, matches=matches, fetched_at=fetched_at) if args.persist else None
        )
        payload: dict[str, object] = {
            "mode": "persist" if args.persist else "dry-run",
            "writes": len(matches) + 1 if persisted and persisted.inserted else 0,
            "report": report.as_dict(),
            "persistence": (persisted.__dict__ if persisted else None),
        }
    else:
        if args.persist:
            raise JusticeActivityPipelineError("SUPABASE_DB_URL is required for persistence")
        payload = {
            "mode": "validate-only",
            "writes": 0,
            "sourceVersion": result.source_version,
            "activityYear": result.activity_year,
            "sourceRows": len(result.records),
            "contentHash": result.content_hash,
            "warning": "SUPABASE_DB_URL absent: court matching and pilot selection were not run.",
        }

    rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
