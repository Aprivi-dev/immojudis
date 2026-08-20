from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable, Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import date, datetime
from itertools import islice
from pathlib import Path
from threading import local
from typing import Any, Literal

from src.config import load_settings
from src.official_sources.base import OfficialSourceError
from src.official_sources.encheres_publiques_open_data import (
    parse_encheres_publiques_courts_csv,
    parse_encheres_publiques_csv,
)
from src.official_sources.judilibre import JudilibreClient
from src.official_sources.justice_open_data import (
    parse_justice_open_data_csv,
    validate_justice_competence_semantics,
)
from src.outcome_ingestion.adapters import (
    dvf_adjudication_to_json_record,
    encheres_publiques_to_json_record,
    justice_open_data_to_json_record,
)
from src.outcome_ingestion.artifact_store import RawArtifactStorageError, SupabaseRawArtifactStore
from src.outcome_ingestion.dvf_adjudication import iter_dvf_adjudication_candidates
from src.outcome_ingestion.dvf_matching import (
    DVF_MATCH_PAGE_SIZE_DEFAULT,
    DVF_MATCH_PAGE_SIZE_MAX,
    DvfAdjudicationMatchingService,
)
from src.outcome_ingestion.judilibre_ingestion import (
    JUDILIBRE_SEARCH_MAX_RESULTS,
    JUDILIBRE_SEARCH_MAX_RESULTS_PER_WINDOW,
    JUDILIBRE_SEARCH_PROFILES,
    JudilibreOutcomeIngestor,
    validate_judilibre_search_request,
)
from src.outcome_ingestion.repository import (
    OutcomeIngestionError,
    OutcomeIngestionRepository,
    PersistedSourceRecord,
)
from src.outcome_ingestion.service import JsonSourceRecord, OutcomeSourceIngestionService

LocalSource = Literal["dvf-adjudications", "justice", "encheres-hearings", "encheres-courts"]
LOCAL_SOURCES: tuple[LocalSource, ...] = (
    "dvf-adjudications",
    "justice",
    "encheres-hearings",
    "encheres-courts",
)
SOURCE_POLICIES: dict[LocalSource, tuple[str, Literal["automated", "manual"]]] = {
    "dvf-adjudications": ("dvf_dgfip", "automated"),
    "justice": ("justice_open_data", "automated"),
    "encheres-hearings": ("encheres_publiques_open_data", "manual"),
    "encheres-courts": ("encheres_publiques_open_data", "manual"),
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate or ingest Outcome Graph evidence from reviewed source connectors."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    plan = commands.add_parser("plan", help="Print activation gates without reading credentials.")
    plan.set_defaults(handler=_run_plan)

    validate = commands.add_parser("validate-local", help="Parse a local source file without DB writes.")
    _add_local_source_args(validate, require_bound=False)
    validate.set_defaults(handler=_run_validate_local)

    ingest = commands.add_parser(
        "ingest-local",
        help="Persist reviewed source candidates through private Storage and append-only provenance.",
    )
    _add_local_source_args(ingest, require_bound=True)
    ingest.add_argument(
        "--workers",
        type=_bounded_ingest_workers,
        default=1,
        help="Bounded parallel Storage/DB writers (1..8; default: 1).",
    )
    ingest.set_defaults(handler=_run_ingest_local)

    fetch = commands.add_parser("judilibre-fetch", help="Fetch and persist one Judilibre decision.")
    fetch.add_argument("decision_id")
    fetch.set_defaults(handler=_run_judilibre_fetch)

    sync = commands.add_parser(
        "judilibre-sync",
        help="Synchronize Judilibre transactional history and deletion events.",
    )
    sync.add_argument("--since", default=None, help="Required for the first sync (ISO-8601).")
    sync.add_argument("--stream-key", default="transactional_history")
    sync.add_argument("--max-pages", type=_positive_int, default=100)
    sync.add_argument("--max-records", type=_positive_int, default=None)
    sync.set_defaults(handler=_run_judilibre_sync)

    search_sync = commands.add_parser(
        "judilibre-search-sync",
        help="Discover Judilibre decisions through a bounded judicial-sale profile.",
    )
    search_sync.add_argument(
        "--profile",
        choices=tuple(JUDILIBRE_SEARCH_PROFILES),
        required=True,
    )
    search_sync.add_argument("--date-start", type=_iso_calendar_date, required=True)
    search_sync.add_argument("--date-end", type=_iso_calendar_date, required=True)
    search_sync.add_argument(
        "--max-results-per-window",
        type=_judilibre_max_results_per_window,
        required=True,
        help=f"Maximum results accepted for one adaptive window (1..{JUDILIBRE_SEARCH_MAX_RESULTS_PER_WINDOW}).",
    )
    search_sync.add_argument(
        "--max-total-results",
        dest="max_total_results",
        type=_judilibre_max_total_results,
        required=True,
        help=f"Maximum results accepted across the complete search (1..{JUDILIBRE_SEARCH_MAX_RESULTS}).",
    )
    search_sync.set_defaults(handler=_run_judilibre_search_sync)

    match_dvf = commands.add_parser(
        "match-dvf",
        help="Queue explainable DVF-to-lot match candidates; dry-run unless --persist is explicit.",
    )
    match_bound = match_dvf.add_mutually_exclusive_group(required=True)
    match_bound.add_argument(
        "--limit",
        type=_positive_int,
        help="Global maximum source records scanned across all pages in this run.",
    )
    match_bound.add_argument(
        "--all",
        action="store_true",
        help="Explicitly acknowledge scanning every active persisted DVF candidate.",
    )
    match_dvf.add_argument(
        "--context-limit",
        type=_positive_int,
        default=250,
        help="Maximum lot/round contexts evaluated per DVF candidate.",
    )
    match_dvf.add_argument(
        "--page-size",
        type=_dvf_match_page_size,
        default=DVF_MATCH_PAGE_SIZE_DEFAULT,
        help=("Source records fetched per page; --limit remains the global run ceiling."),
    )
    match_dvf.add_argument(
        "--after-source-record-id",
        default=None,
        help="Resume after the last source-record UUID returned by a prior bounded run.",
    )
    match_dvf.add_argument(
        "--persist",
        action="store_true",
        help="Append review candidates. Omit for a read-only dry-run.",
    )
    match_dvf.set_defaults(handler=_run_match_dvf)
    return parser


def _add_local_source_args(parser: argparse.ArgumentParser, *, require_bound: bool) -> None:
    parser.add_argument("source", choices=LOCAL_SOURCES)
    parser.add_argument("path", type=Path)
    if require_bound:
        bound = parser.add_mutually_exclusive_group(required=True)
        bound.add_argument("--limit", type=_positive_int)
        bound.add_argument(
            "--all",
            action="store_true",
            help="Explicitly acknowledge an unbounded import.",
        )
    else:
        parser.add_argument("--limit", type=_positive_int, default=None)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _bounded_ingest_workers(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > 8:
        raise argparse.ArgumentTypeError("value must not exceed 8")
    return parsed


def _iso_calendar_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("value must be an ISO calendar date (YYYY-MM-DD)") from exc


def _judilibre_max_results_per_window(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > JUDILIBRE_SEARCH_MAX_RESULTS_PER_WINDOW:
        raise argparse.ArgumentTypeError(f"value must not exceed {JUDILIBRE_SEARCH_MAX_RESULTS_PER_WINDOW}")
    return parsed


def _judilibre_max_total_results(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > JUDILIBRE_SEARCH_MAX_RESULTS:
        raise argparse.ArgumentTypeError(f"value must not exceed {JUDILIBRE_SEARCH_MAX_RESULTS}")
    return parsed


def _dvf_match_page_size(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > DVF_MATCH_PAGE_SIZE_MAX:
        raise argparse.ArgumentTypeError(f"value must not exceed {DVF_MATCH_PAGE_SIZE_MAX}")
    return parsed


def _run_plan(_args: argparse.Namespace) -> int:
    _print_json(
        {
            "schema_version": "outcome_source_activation_plan_v1",
            "sources": {
                "judilibre": {
                    "channel": "automated",
                    "default_state": "disabled_pending_legal_and_piste",
                    "requires": [
                        "approved active data_sources policy",
                        "PISTE KeyId or OAuth2 credentials",
                        "JUDILIBRE_ENABLED=true",
                        "SUPABASE_DB_URL",
                        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
                        "private outcome-raw-artifacts bucket",
                    ],
                },
                "dvf_dgfip": {
                    "channel": "automated",
                    "record_kind": "auction_result_candidate",
                    "training_eligible": False,
                },
                "justice_open_data": {
                    "channel": "automated",
                    "record_kinds": ["territorial_jurisdiction", "court_reference_candidate"],
                    "training_eligible": False,
                },
                "encheres_publiques_open_data": {
                    "channel": "manual",
                    "default_state": "inactive_pending_review",
                    "record_kinds": ["auction_hearing_candidate", "court_reference_candidate"],
                    "training_eligible": False,
                },
            },
        }
    )
    return 0


def _run_validate_local(args: argparse.Namespace) -> int:
    count = 0
    kinds: dict[str, int] = {}
    first_external_id: str | None = None
    for record in _bounded_records(_local_records(args.source, args.path), args.limit):
        count += 1
        kinds[record.record_kind] = kinds.get(record.record_kind, 0) + 1
        first_external_id = first_external_id or record.external_record_id
    _print_json(
        {
            "mode": "validate-local",
            "source": args.source,
            "path": str(args.path),
            "records": count,
            "record_kinds": kinds,
            "first_external_id": first_external_id,
            "training_eligible": False,
            "writes": 0,
        }
    )
    return 0


def _run_ingest_local(args: argparse.Namespace) -> int:
    settings = load_settings()
    source_name, channel = SOURCE_POLICIES[args.source]
    repository = OutcomeIngestionRepository.from_settings(settings)
    # Fail before parsing or Storage writes if the legal/source policy is closed.
    repository.require_source_policy(source_name, channel)
    limit = None if args.all else args.limit
    stored = unchanged = 0
    records = _bounded_records(_local_records(args.source, args.path), limit)

    def count_result(persisted: PersistedSourceRecord) -> None:
        nonlocal stored, unchanged
        if persisted.inserted_new_version:
            stored += 1
        else:
            unchanged += 1

    if args.workers == 1:
        service = OutcomeSourceIngestionService(
            repository=repository,
            artifact_store=SupabaseRawArtifactStore.from_settings(settings),
        )
        for record in records:
            count_result(service.ingest_json_record(record, channel=channel))
    else:
        worker_state = local()

        def ingest_record(record: JsonSourceRecord) -> PersistedSourceRecord:
            service = getattr(worker_state, "service", None)
            if service is None:
                service = OutcomeSourceIngestionService(
                    repository=OutcomeIngestionRepository.from_settings(settings),
                    artifact_store=SupabaseRawArtifactStore.from_settings(settings),
                )
                worker_state.service = service
            return service.ingest_json_record(record, channel=channel)

        with ThreadPoolExecutor(max_workers=args.workers, thread_name_prefix="outcome-ingest") as executor:
            for persisted in executor.map(ingest_record, records):
                count_result(persisted)
    _print_json(
        {
            "mode": "ingest-local",
            "source": source_name,
            "workers": args.workers,
            "stored_versions": stored,
            "unchanged_versions": unchanged,
            "training_eligible": False,
        }
    )
    return 0


def _run_judilibre_fetch(args: argparse.Namespace) -> int:
    ingestor, client = _live_judilibre_ingestor()
    try:
        persisted = ingestor.fetch_decision(args.decision_id)
    finally:
        client.close()
    _print_json(
        {
            "mode": "judilibre-fetch",
            "decision_id": args.decision_id,
            "deleted": persisted is None,
            "stored_new_version": persisted.inserted_new_version if persisted else False,
        }
    )
    return 0


def _run_judilibre_sync(args: argparse.Namespace) -> int:
    ingestor, client = _live_judilibre_ingestor()
    try:
        summary = ingestor.sync(
            since=args.since,
            stream_key=args.stream_key,
            max_pages=args.max_pages,
            max_records=args.max_records,
        )
    finally:
        client.close()
    _print_json({"mode": "judilibre-sync", **summary.__dict__})
    return 0


def _run_judilibre_search_sync(args: argparse.Namespace) -> int:
    # Validate every load bound before reading credentials, opening Storage or
    # constructing a network-capable client.
    if args.max_results_per_window > args.max_total_results:
        raise ValueError("max_results_per_window must not exceed max_total_results")
    profile = validate_judilibre_search_request(
        profile=args.profile,
        date_start=args.date_start,
        date_end=args.date_end,
        max_results=args.max_total_results,
    )
    ingestor, client = _live_judilibre_ingestor()
    try:
        summary = ingestor.sync_targeted_search(
            profile=profile,
            date_start=args.date_start,
            date_end=args.date_end,
            max_results_per_window=args.max_results_per_window,
            max_total_results=args.max_total_results,
        )
    finally:
        client.close()
    _print_json(
        {
            "mode": "judilibre-search-sync",
            "profile": profile.profile_id,
            "date_start": args.date_start,
            "date_end": args.date_end,
            "max_results_per_window": args.max_results_per_window,
            "max_total_results": args.max_total_results,
            **summary.__dict__,
        }
    )
    return 0


def _run_match_dvf(args: argparse.Namespace) -> int:
    settings = load_settings()
    repository = OutcomeIngestionRepository.from_settings(settings)
    if args.persist:
        repository.require_source_policy("dvf_dgfip", "automated")
    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=None if args.all else args.limit,
        context_limit=args.context_limit,
        persist=bool(args.persist),
        after_source_record_id=args.after_source_record_id,
        page_size=args.page_size,
    )
    _print_json(
        {
            "mode": "match-dvf",
            **asdict(summary),
            "writes": summary.writes,
            "persist_requested": bool(args.persist),
        }
    )
    return 0


def _live_judilibre_ingestor() -> tuple[JudilibreOutcomeIngestor, JudilibreClient]:
    settings = load_settings()
    repository = OutcomeIngestionRepository.from_settings(settings)
    # The DB approval gate is checked before constructing anything capable of
    # writing or making a source request. The client independently requires the
    # explicit JUDILIBRE_ENABLED runtime gate and PISTE credentials.
    repository.require_source_policy("judilibre", "automated")
    artifact_store = SupabaseRawArtifactStore.from_settings(settings)
    client = JudilibreClient.from_settings(settings)
    service = OutcomeSourceIngestionService(repository=repository, artifact_store=artifact_store)
    return (
        JudilibreOutcomeIngestor(client=client, repository=repository, service=service),
        client,
    )


def _local_records(source: LocalSource, path: Path) -> Iterator[JsonSourceRecord]:
    if source == "dvf-adjudications":
        for candidate in iter_dvf_adjudication_candidates(path):
            yield dvf_adjudication_to_json_record(candidate)
        return
    if source == "justice":
        parsed = parse_justice_open_data_csv(path)
        if parsed.quality.dataset_kind == "justice_court_competence":
            validate_justice_competence_semantics(parsed)
        for record in parsed.records:
            yield justice_open_data_to_json_record(record)
        return
    parser = parse_encheres_publiques_csv if source == "encheres-hearings" else parse_encheres_publiques_courts_csv
    parsed = parser(path)
    for record in parsed.records:
        yield encheres_publiques_to_json_record(record)


def _bounded_records(
    records: Iterable[JsonSourceRecord],
    limit: int | None,
) -> Iterator[JsonSourceRecord]:
    return iter(records) if limit is None else islice(records, limit)


def _json_default(value: object) -> object:
    if isinstance(value, (date, datetime, Path)):
        return value.isoformat() if not isinstance(value, Path) else str(value)
    raise TypeError(f"cannot serialize {type(value).__name__}")


def _print_json(payload: Mapping[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=_json_default))


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except (OfficialSourceError, OutcomeIngestionError, RawArtifactStorageError, ValueError) as exc:
        print(f"outcome source command failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
