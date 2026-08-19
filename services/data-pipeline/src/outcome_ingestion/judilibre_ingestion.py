from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from urllib.parse import quote

from src.official_sources.base import OfficialSourceConfigurationError, canonical_sha256
from src.official_sources.judilibre import (
    HISTORY_MAX_PAGE_SIZE,
    HISTORY_MIN_PAGE_SIZE,
    SEARCH_MAX_PAGE_SIZE,
    SEARCH_MAX_RESULTS,
    JudilibreClient,
    JudilibreDecision,
    JudilibreHistoryCursor,
    JudilibreHistoryPage,
    JudilibreSearchPage,
    JudilibreSearchQuery,
    JudilibreTransaction,
)
from src.outcome_ingestion.judilibre_extraction import (
    JudilibreExtractionResult,
    extract_judilibre_candidate_facts,
)
from src.outcome_ingestion.repository import OutcomeIngestionRepository, PersistedSourceRecord
from src.outcome_ingestion.service import JsonSourceRecord, OutcomeSourceIngestionService

JUDILIBRE_SOURCE_NAME = "judilibre"
JUDILIBRE_CONNECTOR_VERSION = "judilibre-outcome/5"
JUDILIBRE_EXTRACTOR_VERSION = "3"
JUDILIBRE_NORMALIZED_SCHEMA = "judilibre_decision_candidate_v3"
JUDILIBRE_DECISION_PAGE_BASE_URL = "https://www.courdecassation.fr/decision"
JUDILIBRE_SEARCH_MAX_RESULTS = SEARCH_MAX_RESULTS
JUDILIBRE_SEARCH_MAX_RESULTS_PER_WINDOW = 500
JUDILIBRE_SEARCH_MAX_WINDOW_DAYS = 31
JUDILIBRE_SEARCH_PROFILE_VERSION = "2"
JUDILIBRE_HISTORY_COHORT_EXTENSION_PAGES_BEFORE_TERMINAL_DRAIN = 100


@dataclass(frozen=True)
class JudilibreSearchProfile:
    profile_id: str
    query: str
    version: str = JUDILIBRE_SEARCH_PROFILE_VERSION
    fields: tuple[str, ...] = ("dispositif", "motivations", "expose", "summary")
    jurisdictions: tuple[str, ...] = ("tj",)
    operator: str = "exact"

    def definition(self) -> dict[str, object]:
        return {
            "profile_id": self.profile_id,
            "version": self.version,
            "query": self.query,
            "field": list(self.fields),
            "operator": self.operator,
            "jurisdiction": list(self.jurisdictions),
        }

    @property
    def fingerprint(self) -> str:
        return canonical_sha256(self.definition())


JUDILIBRE_SEARCH_PROFILES: dict[str, JudilibreSearchProfile] = {
    profile.profile_id: profile
    for profile in (
        JudilibreSearchProfile(
            profile_id="saisie_immobiliere_v2",
            query="saisie immobilière",
        ),
        JudilibreSearchProfile(
            profile_id="vente_forcee_v2",
            query="vente forcée",
        ),
        JudilibreSearchProfile(
            profile_id="adjudication_v2",
            query="adjudication",
        ),
        JudilibreSearchProfile(
            profile_id="adjuge_v2",
            query="adjuge",
            fields=("dispositif",),
        ),
        JudilibreSearchProfile(
            profile_id="mise_a_prix_v2",
            query="mise à prix",
        ),
        JudilibreSearchProfile(
            profile_id="surenchere_v2",
            query="surenchère",
        ),
    )
}


@dataclass(frozen=True)
class JudilibreSyncSummary:
    pages: int = 0
    created_or_updated: int = 0
    deletions: int = 0
    stored_versions: int = 0
    unchanged_versions: int = 0
    ignored_untracked: int = 0
    scan_complete: bool = False
    checkpoint_advanced: bool = False


@dataclass(frozen=True)
class JudilibreSearchSyncSummary:
    pages: int = 0
    metadata_examined: int = 0
    reported_total: int = 0
    selected_decisions: int = 0
    deletions: int = 0
    stored_versions: int = 0
    unchanged_versions: int = 0
    truncated: bool = False
    checkpoint_advanced: bool = False


@dataclass(frozen=True)
class _JudilibreHistorySegment:
    pages: tuple[JudilibreHistoryPage, ...]
    transactions: tuple[tuple[JudilibreHistoryPage, JudilibreTransaction], ...]
    scan_complete: bool
    resume_at: str | None = None
    committed_through_event_at: str | None = None


@dataclass(frozen=True)
class _JudilibreSearchSelection:
    decision_id: str
    metadata_sha256: str
    metadata_includes_number: bool
    resolved_query: dict[str, object]
    leaf_window: dict[str, str]
    split_path: tuple[str, ...]
    result_page: int
    page_rank: int
    reported_total: int
    metadata_count: int
    metadata_ids_sha256: str


@dataclass(frozen=True)
class _JudilibreSearchScan:
    pages: int
    metadata_examined: int
    reported_total: int
    root_window: dict[str, str]
    split_plan: tuple[dict[str, object], ...]
    split_plan_hash: str
    selections: tuple[_JudilibreSearchSelection, ...]


def validate_judilibre_search_request(
    *,
    profile: str | JudilibreSearchProfile,
    date_start: date,
    date_end: date,
    max_results: int,
    today: date | None = None,
) -> JudilibreSearchProfile:
    if isinstance(profile, str):
        try:
            resolved_profile = JUDILIBRE_SEARCH_PROFILES[profile]
        except KeyError as exc:
            raise ValueError("unknown Judilibre targeted-search profile") from exc
    elif isinstance(profile, JudilibreSearchProfile):
        registered = JUDILIBRE_SEARCH_PROFILES.get(profile.profile_id)
        if registered != profile:
            raise ValueError("Judilibre targeted-search profile must be registered")
        resolved_profile = profile
    else:
        raise ValueError("Judilibre targeted-search profile is required")
    if not isinstance(date_start, date) or isinstance(date_start, datetime):
        raise ValueError("date_start must be a calendar date")
    if not isinstance(date_end, date) or isinstance(date_end, datetime):
        raise ValueError("date_end must be a calendar date")
    if date_start > date_end:
        raise ValueError("date_start must be before or equal to date_end")
    if (date_end - date_start).days + 1 > JUDILIBRE_SEARCH_MAX_WINDOW_DAYS:
        raise ValueError(f"Judilibre targeted-search window must not exceed {JUDILIBRE_SEARCH_MAX_WINDOW_DAYS} days")
    if date_end > (today or date.today()):
        raise ValueError("date_end must not be in the future")
    if not isinstance(max_results, int) or isinstance(max_results, bool):
        raise ValueError("max_results must be an integer")
    if not 1 <= max_results <= JUDILIBRE_SEARCH_MAX_RESULTS:
        raise ValueError(f"max_results must be between 1 and {JUDILIBRE_SEARCH_MAX_RESULTS}")
    return resolved_profile


def _resolve_targeted_search_limits(
    *,
    max_results: int | None,
    max_results_per_window: int | None,
    max_total_results: int | None,
) -> tuple[int, int]:
    if max_results is not None:
        if max_results_per_window is not None or max_total_results is not None:
            raise ValueError("max_results cannot be combined with explicit Judilibre search limits")
        _validate_search_limit(
            name="max_results",
            value=max_results,
            upper_bound=JUDILIBRE_SEARCH_MAX_RESULTS,
        )
        return min(max_results, JUDILIBRE_SEARCH_MAX_RESULTS_PER_WINDOW), max_results
    if max_results_per_window is None or max_total_results is None:
        raise ValueError("max_results_per_window and max_total_results are both required")
    _validate_search_limit(
        name="max_results_per_window",
        value=max_results_per_window,
        upper_bound=JUDILIBRE_SEARCH_MAX_RESULTS_PER_WINDOW,
    )
    _validate_search_limit(
        name="max_total_results",
        value=max_total_results,
        upper_bound=JUDILIBRE_SEARCH_MAX_RESULTS,
    )
    if max_results_per_window > max_total_results:
        raise ValueError("max_results_per_window must not exceed max_total_results")
    return max_results_per_window, max_total_results


def _validate_search_limit(*, name: str, value: int, upper_bound: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    if not 1 <= value <= upper_bound:
        raise ValueError(f"{name} must be between 1 and {upper_bound}")


def normalized_judilibre_decision(
    decision: JudilibreDecision,
    *,
    extraction: JudilibreExtractionResult | None = None,
) -> dict[str, object]:
    """Minimized analytical projection; the full text stays in private Storage."""
    resolved_extraction = extraction or extract_judilibre_candidate_facts(decision)
    projection: dict[str, object] = {
        "schema_version": JUDILIBRE_NORMALIZED_SCHEMA,
        "record_type": "judicial_decision_candidate",
        "judilibre_id": decision.id,
        "jurisdiction": decision.jurisdiction,
        "location": decision.location,
        "chamber": decision.chamber,
        "formation": decision.formation,
        "number": decision.number,
        "numbers": decision.numbers,
        "ecli": decision.ecli,
        "nac": decision.nac,
        "decision_date": decision.decision_date.isoformat() if decision.decision_date else None,
        "update_date": decision.update_date.isoformat() if decision.update_date else None,
        "decision_type": decision.type,
        "solution": decision.solution,
        "solution_alt": decision.solution_alt,
        "publication": decision.publication,
        "themes": decision.themes,
        "partial": decision.partial,
        "to_be_deleted": decision.to_be_deleted,
        # Make source-record versioning sensitive to corrections in private raw
        # fields without projecting the text or any personal identity.
        "raw_representation_sha256": decision.canonical_sha256(),
        "candidate_grade": "C",
        "review_status": "pending",
        "training_eligible": False,
        "text_storage": "private_raw_artifact",
        "personal_identity_features_allowed": False,
    }
    projection.update(resolved_extraction.normalized_fields())
    return projection


class JudilibreOutcomeIngestor:
    def __init__(
        self,
        *,
        client: JudilibreClient,
        repository: OutcomeIngestionRepository,
        service: OutcomeSourceIngestionService,
    ) -> None:
        self.client = client
        self.repository = repository
        self.service = service

    def fetch_decision(
        self,
        decision_id: str,
        *,
        policy_checked: bool = False,
        expected_search_metadata_sha256: str | None = None,
        expected_search_metadata_includes_number: bool = False,
        source_event_at: datetime | None = None,
        source_cursor: Mapping[str, object] | None = None,
        request_provenance: Mapping[str, object] | None = None,
    ) -> PersistedSourceRecord | None:
        if not policy_checked:
            self.repository.require_source_policy(JUDILIBRE_SOURCE_NAME, "automated")
        started_at = datetime.now(UTC)
        decision = self.client.decision(decision_id, resolve_references=False)
        if decision.id != decision_id.strip():
            raise OfficialSourceConfigurationError("Judilibre returned an unexpected decision identifier")
        if (
            expected_search_metadata_sha256 is not None
            and _decision_metadata_sha256(
                decision,
                include_number=expected_search_metadata_includes_number,
            )
            != expected_search_metadata_sha256
        ):
            raise OfficialSourceConfigurationError(
                "Judilibre decision metadata changed after the targeted search"
            )
        if decision.is_deletion:
            self.repository.record_source_deletion(
                source_name=JUDILIBRE_SOURCE_NAME,
                external_record_id=decision.id,
                event_at=(
                    _ensure_utc(source_event_at)
                    if source_event_at is not None
                    else _decision_update_datetime(decision) or datetime.now(UTC)
                ),
                reason_code="judilibre_to_be_deleted",
                connector_version=JUDILIBRE_CONNECTOR_VERSION,
            )
            return None

        raw_payload = decision.model_dump(mode="json", by_alias=True, exclude_none=False)
        extraction = extract_judilibre_candidate_facts(decision)
        request_parameters = dict(request_provenance or {})
        request_parameters.update({"id": decision.id, "resolve_references": False})
        return self.service.ingest_json_record(
            JsonSourceRecord(
                source_name=JUDILIBRE_SOURCE_NAME,
                external_record_id=decision.id,
                requested_url=f"{self.client.base_url}/decision",
                canonical_url=f"{JUDILIBRE_DECISION_PAGE_BASE_URL}/{quote(decision.id, safe='')}",
                record_kind="judicial_decision_candidate",
                raw_payload=raw_payload,
                normalized_data=normalized_judilibre_decision(decision, extraction=extraction),
                connector_version=JUDILIBRE_CONNECTOR_VERSION,
                extractor_name="judilibre_candidate_extraction",
                extractor_version=JUDILIBRE_EXTRACTOR_VERSION,
                schema_version=JUDILIBRE_NORMALIZED_SCHEMA,
                field_provenance=extraction.field_provenance(),
                decision_date=decision.decision_date,
                source_updated_at=_decision_update_datetime(decision),
                # A decision date is not proof of first public availability.
                # Leave publication unknown unless Judilibre supplies it.
                published_at=None,
                request_parameters=request_parameters,
                source_cursor=source_cursor,
            ),
            channel="automated",
            captured_at=started_at,
        )

    def sync_targeted_search(
        self,
        *,
        profile: str | JudilibreSearchProfile,
        date_start: date,
        date_end: date,
        max_results: int | None = None,
        max_results_per_window: int | None = None,
        max_total_results: int | None = None,
    ) -> JudilibreSearchSyncSummary:
        resolved_per_window_limit, resolved_total_limit = _resolve_targeted_search_limits(
            max_results=max_results,
            max_results_per_window=max_results_per_window,
            max_total_results=max_total_results,
        )
        resolved_profile = validate_judilibre_search_request(
            profile=profile,
            date_start=date_start,
            date_end=date_end,
            max_results=resolved_total_limit,
        )
        self.repository.require_source_policy(JUDILIBRE_SOURCE_NAME, "automated")
        resolved_query = _resolved_search_query(
            profile=resolved_profile,
            date_start=date_start,
            date_end=date_end,
        )
        stream_key = _targeted_search_stream_key(
            profile=resolved_profile,
            date_start=date_start,
            date_end=date_end,
        )
        checkpoint = self.repository.load_checkpoint(
            source_name=JUDILIBRE_SOURCE_NAME,
            stream_key=stream_key,
        )
        page_size = min(
            getattr(self.client, "page_size", SEARCH_MAX_PAGE_SIZE),
            resolved_per_window_limit,
        )
        if not 1 <= page_size <= SEARCH_MAX_PAGE_SIZE:
            raise OfficialSourceConfigurationError("Judilibre client search page size is invalid")
        scan = _collect_targeted_search_metadata(
            client=self.client,
            profile=resolved_profile,
            date_start=date_start,
            date_end=date_end,
            max_results_per_window=resolved_per_window_limit,
            max_total_results=resolved_total_limit,
            page_size=page_size,
        )

        stored = unchanged = deletions = 0
        last_fetch_id: str | None = None
        for result_rank, selection in enumerate(scan.selections):
            provenance = {
                "discovery_mode": "targeted_search",
                "profile_id": resolved_profile.profile_id,
                "profile_version": resolved_profile.version,
                "profile_hash": resolved_profile.fingerprint,
                "resolved_query": selection.resolved_query,
                "root_window": scan.root_window,
                "leaf_window": selection.leaf_window,
                "split_path": list(selection.split_path),
                "root_reported_total": scan.reported_total,
                "leaf_reported_total": selection.reported_total,
                "split_plan_hash": scan.split_plan_hash,
                "metadata_count": selection.metadata_count,
                "metadata_ids_sha256": selection.metadata_ids_sha256,
                "metadata_stability_passes": 2,
                "result_page": selection.result_page,
                "page_rank": selection.page_rank,
                "result_rank": result_rank,
                "reported_total": selection.reported_total,
            }
            persisted = self.fetch_decision(
                selection.decision_id,
                policy_checked=True,
                expected_search_metadata_sha256=selection.metadata_sha256,
                expected_search_metadata_includes_number=selection.metadata_includes_number,
                source_cursor=provenance,
                request_provenance={
                    "discovery_profile": resolved_profile.definition(),
                    "discovery_profile_hash": resolved_profile.fingerprint,
                    "discovery_query": selection.resolved_query,
                    "discovery_root_window": scan.root_window,
                    "discovery_leaf_window": selection.leaf_window,
                    "discovery_split_path": list(selection.split_path),
                    "discovery_root_reported_total": scan.reported_total,
                    "discovery_leaf_reported_total": selection.reported_total,
                    "discovery_split_plan_hash": scan.split_plan_hash,
                    "discovery_metadata_count": selection.metadata_count,
                    "discovery_metadata_ids_sha256": selection.metadata_ids_sha256,
                    "discovery_metadata_stability_passes": 2,
                },
            )
            if persisted is None:
                deletions += 1
            elif persisted.inserted_new_version:
                stored += 1
                last_fetch_id = persisted.source_fetch_id
            else:
                unchanged += 1
                last_fetch_id = persisted.source_fetch_id

        watermark = _date_at_utc_midnight(date_end + timedelta(days=1))
        if watermark is None:  # pragma: no cover - date_end is validated above.
            raise OfficialSourceConfigurationError("Judilibre search watermark is missing")
        self.repository.advance_checkpoint(
            source_name=JUDILIBRE_SOURCE_NAME,
            channel="automated",
            stream_key=stream_key,
            expected_revision=checkpoint.revision if checkpoint else None,
            source_cursor={
                "discovery_mode": "targeted_search",
                "profile_id": resolved_profile.profile_id,
                "profile_version": resolved_profile.version,
                "profile_hash": resolved_profile.fingerprint,
                "resolved_query": resolved_query,
                "root_window": scan.root_window,
                "split_plan": list(scan.split_plan),
                "split_plan_hash": scan.split_plan_hash,
                "root_reported_total": scan.reported_total,
                "reported_total": scan.reported_total,
                "max_results_per_window": resolved_per_window_limit,
                "max_total_results": resolved_total_limit,
                "metadata_stability_passes": 2,
                "metadata_complete": True,
            },
            watermark_at=watermark,
            connector_version=JUDILIBRE_CONNECTOR_VERSION,
            last_successful_fetch_id=last_fetch_id,
        )
        return JudilibreSearchSyncSummary(
            pages=scan.pages,
            metadata_examined=scan.metadata_examined,
            reported_total=scan.reported_total,
            selected_decisions=len(scan.selections),
            deletions=deletions,
            stored_versions=stored,
            unchanged_versions=unchanged,
            checkpoint_advanced=True,
        )

    def sync(
        self,
        *,
        since: str | date | datetime | None = None,
        stream_key: str = "transactional_history",
        max_pages: int = 100,
        max_records: int | None = None,
    ) -> JudilibreSyncSummary:
        if max_pages < 1:
            raise ValueError("max_pages must be positive")
        if max_records is not None and max_records < 1:
            raise ValueError("max_records must be positive when provided")
        if not stream_key.strip():
            raise ValueError("stream_key must not be empty")
        self.repository.require_source_policy(JUDILIBRE_SOURCE_NAME, "automated")
        checkpoint = self.repository.load_checkpoint(
            source_name=JUDILIBRE_SOURCE_NAME,
            stream_key=stream_key,
        )
        if checkpoint is not None:
            _validate_loaded_history_checkpoint(
                source_cursor=checkpoint.source_cursor,
                watermark_at=getattr(checkpoint, "watermark_at", None),
            )
        cursor = _initial_cursor(
            checkpoint_cursor=checkpoint.source_cursor if checkpoint else None,
            since=since,
            page_size=self.client.history_page_size,
        )

        pages = created_or_updated = deletions = stored = unchanged = ignored_untracked = 0
        last_fetch_id: str | None = None
        # next_page contains an opaque, short-lived Elasticsearch search_after
        # tuple. Consume it only inside this run. A durable segment boundary can
        # therefore be written only between complete event-time cohorts.
        segment = _collect_history_segment(
            client=self.client,
            cursor=cursor,
            max_pages=max_pages,
            max_records=max_records,
        )
        buffered_pages = list(segment.pages)
        selected_transactions = list(segment.transactions)
        pages = len(buffered_pages)

        # query_date is generated independently on each page and the API does
        # not expose a point-in-time snapshot. Carry the earliest timestamp
        # across bounded segments so the terminal promotion intentionally
        # overlaps concurrent writes instead of skipping them.
        segment_query_date = _segment_query_date(buffered_pages)
        scan_query_date = _scan_query_date(
            checkpoint_cursor=checkpoint.source_cursor if checkpoint else None,
            pages=buffered_pages,
        )

        # The history is a national change feed. Discovery happens exclusively
        # through bounded profiles; this batch gate keeps maintenance limited to
        # active Judilibre identifiers that Immojudis already follows.
        tracked_ids = self.repository.source_record_ids_exist(
            JUDILIBRE_SOURCE_NAME,
            (transaction.id for _, transaction in selected_transactions),
        )
        tombstoned_in_run: set[str] = set()
        for page, transaction in selected_transactions:
            if transaction.id not in tracked_ids or transaction.id in tombstoned_in_run:
                ignored_untracked += 1
                continue
            event_at = _parse_datetime(transaction.date)
            if transaction.is_deletion:
                self.repository.record_source_deletion(
                    source_name=JUDILIBRE_SOURCE_NAME,
                    external_record_id=transaction.id,
                    event_at=event_at,
                    reason_code="judilibre_transaction_deleted",
                    connector_version=JUDILIBRE_CONNECTOR_VERSION,
                )
                tombstoned_in_run.add(transaction.id)
                deletions += 1
                continue
            created_or_updated += 1
            persisted = self.fetch_decision(
                transaction.id,
                policy_checked=True,
                source_event_at=event_at,
                source_cursor={
                    "stream_key": stream_key,
                    "history_query_date": page.query_date,
                    "transaction_action": transaction.action,
                    "transaction_date": transaction.date,
                },
            )
            if persisted is None:
                tombstoned_in_run.add(transaction.id)
                deletions += 1
            elif persisted.inserted_new_version:
                stored += 1
                last_fetch_id = persisted.source_fetch_id
            else:
                unchanged += 1
                last_fetch_id = persisted.source_fetch_id

        checkpoint_advanced = False
        scan_complete = segment.scan_complete
        if buffered_pages and scan_query_date is not None:
            scan_origin = _history_scan_origin(
                checkpoint_cursor=checkpoint.source_cursor if checkpoint else None,
                initial_cursor=cursor,
            )
            if scan_complete:
                checkpoint_cursor: dict[str, object] = {
                    "schema_version": "judilibre_history_checkpoint_v2",
                    "date": scan_query_date,
                    "page_size": cursor.page_size,
                    "scan_complete": True,
                }
                checkpoint_watermark = _parse_datetime(scan_query_date)
                if checkpoint_watermark < _cursor_boundary_datetime(scan_origin):
                    raise OfficialSourceConfigurationError("Judilibre history watermark moved backwards")
            else:
                if segment.resume_at is None or segment.committed_through_event_at is None:
                    raise OfficialSourceConfigurationError(
                        "partial Judilibre segment is missing its durable time boundary"
                    )
                durable_resume_at = min(
                    (segment.resume_at, segment_query_date),
                    key=_parse_datetime,
                )
                if _parse_datetime(durable_resume_at) <= _cursor_boundary_datetime(cursor.date):
                    raise OfficialSourceConfigurationError("Judilibre durable history cursor did not make progress")
                checkpoint_cursor = {
                    "schema_version": "judilibre_history_checkpoint_v2",
                    "date": durable_resume_at,
                    "page_size": cursor.page_size,
                    "scan_complete": False,
                    "scan_origin": scan_origin,
                    "committed_through_event_at": segment.committed_through_event_at,
                    "scan_watermark": scan_query_date,
                }
                checkpoint_watermark = (
                    getattr(checkpoint, "watermark_at", None)
                    if checkpoint is not None and getattr(checkpoint, "watermark_at", None) is not None
                    else _cursor_boundary_datetime(scan_origin)
                )
                if checkpoint_watermark != _cursor_boundary_datetime(scan_origin):
                    raise OfficialSourceConfigurationError(
                        "incomplete Judilibre checkpoint attempted to promote its watermark"
                    )
            self.repository.advance_checkpoint(
                source_name=JUDILIBRE_SOURCE_NAME,
                channel="automated",
                stream_key=stream_key,
                expected_revision=checkpoint.revision if checkpoint else None,
                source_cursor=checkpoint_cursor,
                watermark_at=checkpoint_watermark,
                connector_version=JUDILIBRE_CONNECTOR_VERSION,
                last_successful_fetch_id=last_fetch_id,
            )
            checkpoint_advanced = True

        return JudilibreSyncSummary(
            pages=pages,
            created_or_updated=created_or_updated,
            deletions=deletions,
            stored_versions=stored,
            unchanged_versions=unchanged,
            ignored_untracked=ignored_untracked,
            scan_complete=scan_complete,
            checkpoint_advanced=checkpoint_advanced,
        )


def _resolved_search_query(
    *,
    profile: JudilibreSearchProfile,
    date_start: date,
    date_end: date,
) -> dict[str, object]:
    return {
        "query": profile.query,
        "field": list(profile.fields),
        "operator": profile.operator,
        "jurisdiction": list(profile.jurisdictions),
        "date_start": date_start.isoformat(),
        "date_end": date_end.isoformat(),
        "sort": "date",
        "order": "asc",
        "resolve_references": False,
    }


def _targeted_search_stream_key(
    *,
    profile: JudilibreSearchProfile,
    date_start: date,
    date_end: date,
) -> str:
    return (
        f"targeted_search:{profile.profile_id}:{profile.version}:"
        f"{profile.fingerprint}:{date_start.isoformat()}:{date_end.isoformat()}"
    )


def _collect_targeted_search_metadata(
    *,
    client: JudilibreClient,
    profile: JudilibreSearchProfile,
    date_start: date,
    date_end: date,
    max_results_per_window: int,
    max_total_results: int,
    page_size: int,
) -> _JudilibreSearchScan:
    pages = 0
    metadata_examined = 0
    leaf_reported_total = 0
    root_reported_total: int | None = None
    selections: list[_JudilibreSearchSelection] = []
    seen_ids: set[str] = set()
    split_plan: list[dict[str, object]] = []
    root_window = _search_window(date_start, date_end)

    def collect_window(
        window_start: date,
        window_end: date,
        *,
        split_path: tuple[str, ...],
        root: bool = False,
    ) -> None:
        nonlocal pages, metadata_examined, leaf_reported_total, root_reported_total
        resolved_query = _resolved_search_query(
            profile=profile,
            date_start=window_start,
            date_end=window_end,
        )
        page_index = 0
        page = search_page(
            window_start=window_start,
            window_end=window_end,
            page_index=page_index,
        )
        reported_total = page.total
        if root:
            root_reported_total = reported_total
            if reported_total > max_total_results:
                raise OfficialSourceConfigurationError(
                    "Judilibre targeted search exceeds max_total_results; refusing incomplete results"
                )

        if reported_total > max_results_per_window:
            if window_start == window_end:
                raise OfficialSourceConfigurationError(
                    "Judilibre targeted search exceeds max_results_per_window for a single day; "
                    "refusing incomplete results"
                )
            midpoint = window_start + timedelta(days=(window_end - window_start).days // 2)
            collect_window(window_start, midpoint, split_path=(*split_path, "left"))
            collect_window(
                midpoint + timedelta(days=1),
                window_end,
                split_path=(*split_path, "right"),
            )
            return

        leaf_reported_total += reported_total
        leaf_window = _search_window(window_start, window_end)
        if leaf_reported_total > max_total_results:
            raise OfficialSourceConfigurationError(
                "Judilibre adaptive search exceeds max_total_results; refusing incomplete results"
            )

        def scan_leaf(
            first_page: JudilibreSearchPage | None = None,
        ) -> tuple[list[str], list[str], list[tuple[str, str, bool, int, int]]]:
            current_page_index = 0
            current_page = first_page or search_page(
                window_start=window_start,
                window_end=window_end,
                page_index=0,
                expected_total=reported_total,
            )
            ordered_ids: list[str] = []
            ordered_metadata_sha256: list[str] = []
            positions: list[tuple[str, str, bool, int, int]] = []
            while True:
                for page_rank, result in enumerate(current_page.results):
                    metadata_sha256 = _decision_metadata_sha256(result)
                    ordered_ids.append(result.id)
                    ordered_metadata_sha256.append(metadata_sha256)
                    positions.append(
                        (
                            result.id,
                            metadata_sha256,
                            result.number is not None,
                            current_page_index,
                            page_rank,
                        )
                    )

                if len(ordered_ids) > reported_total:
                    raise OfficialSourceConfigurationError(
                        "Judilibre search returned more metadata than its reported total"
                    )
                if len(ordered_ids) == reported_total:
                    if current_page.next_page:
                        raise OfficialSourceConfigurationError(
                            "Judilibre search cursor continued beyond its reported total"
                        )
                    return ordered_ids, ordered_metadata_sha256, positions
                if not current_page.next_page:
                    raise OfficialSourceConfigurationError(
                        "Judilibre search ended before all reported metadata was examined"
                    )
                current_page_index += 1
                current_page = search_page(
                    window_start=window_start,
                    window_end=window_end,
                    page_index=current_page_index,
                    expected_total=reported_total,
                )

        first_pass_ids, first_pass_metadata_sha256, first_pass_positions = scan_leaf(page)
        second_pass_ids, second_pass_metadata_sha256, _ = scan_leaf()
        if (
            second_pass_ids != first_pass_ids
            or second_pass_metadata_sha256 != first_pass_metadata_sha256
        ):
            raise OfficialSourceConfigurationError(
                "Judilibre leaf metadata changed between stability passes"
            )

        metadata_ids_sha256 = canonical_sha256({"ordered_decision_ids": first_pass_ids})
        metadata_count = len(first_pass_ids)
        split_plan.append(
            {
                "leaf_window": leaf_window,
                "split_path": list(split_path),
                "leaf_reported_total": reported_total,
                "metadata_count": metadata_count,
                "metadata_ids_sha256": metadata_ids_sha256,
                "metadata_stability_passes": 2,
            }
        )
        for (
            decision_id,
            metadata_sha256,
            metadata_includes_number,
            result_page,
            page_rank,
        ) in first_pass_positions:
            if decision_id in seen_ids:
                raise OfficialSourceConfigurationError(
                    "Judilibre search returned a duplicate decision identifier"
                )
            seen_ids.add(decision_id)
            selections.append(
                _JudilibreSearchSelection(
                    decision_id=decision_id,
                    metadata_sha256=metadata_sha256,
                    metadata_includes_number=metadata_includes_number,
                    resolved_query=resolved_query,
                    leaf_window=leaf_window,
                    split_path=split_path,
                    result_page=result_page,
                    page_rank=page_rank,
                    reported_total=reported_total,
                    metadata_count=metadata_count,
                    metadata_ids_sha256=metadata_ids_sha256,
                )
            )
        metadata_examined += metadata_count

    def search_page(
        *,
        window_start: date,
        window_end: date,
        page_index: int,
        expected_total: int | None = None,
    ) -> JudilibreSearchPage:
        nonlocal pages
        query = JudilibreSearchQuery(
            query=profile.query,
            field=list(profile.fields),
            operator=profile.operator,
            jurisdiction=list(profile.jurisdictions),
            date_start=window_start,
            date_end=window_end,
            sort="date",
            order="asc",
            page=page_index,
            page_size=page_size,
            resolve_references=False,
        )
        page = client.search(query)
        pages += 1
        if page.page != page_index or page.page_size != page_size:
            raise OfficialSourceConfigurationError("Judilibre search response changed the requested pagination")
        if page.relaxed:
            raise OfficialSourceConfigurationError(
                "Judilibre relaxed the targeted search; refusing imprecise results"
            )
        if expected_total is not None and page.total != expected_total:
            raise OfficialSourceConfigurationError("Judilibre search total changed during pagination")
        if len(page.results) > page_size:
            raise OfficialSourceConfigurationError("Judilibre search returned more metadata than requested")
        if page.next_page and not page.results:
            raise OfficialSourceConfigurationError("Judilibre search continued after an empty metadata page")
        if page_index * page_size + len(page.results) < page.total and not page.next_page:
            raise OfficialSourceConfigurationError(
                "Judilibre search ended before all reported metadata was examined"
            )
        for result in page.results:
            _validate_targeted_search_result(
                result_decision_date=result.decision_date,
                result_jurisdiction=result.jurisdiction,
                window_start=window_start,
                window_end=window_end,
                jurisdictions=profile.jurisdictions,
            )
        return page

    collect_window(date_start, date_end, split_path=(), root=True)
    if root_reported_total is None:  # pragma: no cover - the root always issues one request.
        raise OfficialSourceConfigurationError("Judilibre targeted search did not report a total")
    if leaf_reported_total != root_reported_total:
        raise OfficialSourceConfigurationError(
            "Judilibre search totals changed across adaptive date windows"
        )
    split_plan_definition = {
        "root_window": root_window,
        "root_reported_total": root_reported_total,
        "leaves": split_plan,
    }
    return _JudilibreSearchScan(
        pages=pages,
        metadata_examined=metadata_examined,
        reported_total=root_reported_total,
        root_window=root_window,
        split_plan=tuple(split_plan),
        split_plan_hash=canonical_sha256(split_plan_definition),
        selections=tuple(selections),
    )


def _validate_targeted_search_result(
    *,
    result_decision_date: date | None,
    result_jurisdiction: str | None,
    window_start: date,
    window_end: date,
    jurisdictions: tuple[str, ...],
) -> None:
    if result_decision_date is None or not window_start <= result_decision_date <= window_end:
        raise OfficialSourceConfigurationError(
            "Judilibre search returned a decision outside the requested date window"
        )
    if result_jurisdiction is None or result_jurisdiction.lower() not in jurisdictions:
        raise OfficialSourceConfigurationError(
            "Judilibre search returned a decision outside the profile jurisdiction"
        )


def _decision_metadata_sha256(
    decision: object,
    *,
    include_number: bool | None = None,
) -> str:
    """Hash the minimal public contract shared by /search and /decision."""

    number = getattr(decision, "number", None)
    metadata: dict[str, object] = {
        "schema_version": "judilibre_search_decision_metadata_v1",
        "id": getattr(decision, "id", None),
        "decision_date": getattr(decision, "decision_date", None),
        "jurisdiction": getattr(decision, "jurisdiction", None),
        "location": getattr(decision, "location", None),
    }
    if include_number is True or (include_number is None and number is not None):
        metadata["number"] = number
    return canonical_sha256(metadata)


def _search_window(date_start: date, date_end: date) -> dict[str, str]:
    return {
        "date_start": date_start.isoformat(),
        "date_end": date_end.isoformat(),
    }


def _collect_history_segment(
    *,
    client: JudilibreClient,
    cursor: JudilibreHistoryCursor,
    max_pages: int,
    max_records: int | None,
) -> _JudilibreHistorySegment:
    pages: list[JudilibreHistoryPage] = []
    selected: list[tuple[JudilibreHistoryPage, JudilibreTransaction]] = []
    current = cursor
    seen_cursors: set[tuple[str, int, str | None]] = set()
    previous_event_at: datetime | None = None
    cutoff_at: datetime | None = None
    cutoff_raw: str | None = None
    cohort_extension_pages = 0
    drain_to_terminal = False

    while True:
        if cutoff_at is not None and not drain_to_terminal:
            if cohort_extension_pages >= JUDILIBRE_HISTORY_COHORT_EXTENSION_PAGES_BEFORE_TERMINAL_DRAIN:
                # No durable tie-breaker exists inside one timestamp. Draining
                # this already-open ephemeral chain is the only lossless escape
                # from a permanently retrying oversized cohort.
                drain_to_terminal = True
            cohort_extension_pages += 1
        marker = (current.date, current.page_size, current.from_id)
        if marker in seen_cursors:
            raise OfficialSourceConfigurationError("Judilibre returned a repeated history cursor")
        seen_cursors.add(marker)
        page = client.transactional_history(current)
        pages.append(page)

        for transaction in page.transactions:
            event_at = _parse_datetime(transaction.date)
            if previous_event_at is not None and event_at < previous_event_at:
                raise OfficialSourceConfigurationError("Judilibre history events are not ordered chronologically")
            previous_event_at = event_at
            if cutoff_at is not None and event_at > cutoff_at and not drain_to_terminal:
                return _JudilibreHistorySegment(
                    pages=tuple(pages),
                    transactions=tuple(selected),
                    scan_complete=False,
                    resume_at=transaction.date,
                    committed_through_event_at=cutoff_raw,
                )
            selected.append((page, transaction))
            if not drain_to_terminal and cutoff_at is None and max_records is not None and len(selected) >= max_records:
                cutoff_at = event_at
                cutoff_raw = transaction.date
            elif cutoff_at is not None and event_at == cutoff_at:
                cutoff_raw = transaction.date

        following = (
            _validated_next_history_cursor(
                page=page,
                current=current,
                client=client,
            )
            if page.next_page
            else None
        )
        if following is None:
            return _JudilibreHistorySegment(
                pages=tuple(pages),
                transactions=tuple(selected),
                scan_complete=True,
            )
        if not drain_to_terminal and cutoff_at is None and len(pages) >= max_pages:
            if not selected:  # Judilibre forbids continuing an empty page.
                raise OfficialSourceConfigurationError(
                    "Judilibre history page budget ended without a durable event boundary"
                )
            cutoff_at = _parse_datetime(selected[-1][1].date)
            cutoff_raw = selected[-1][1].date
        current = following


def _scan_query_date(
    *,
    checkpoint_cursor: Mapping[str, object] | None,
    pages: list[JudilibreHistoryPage],
) -> str | None:
    values = [page.query_date for page in pages]
    if checkpoint_cursor and checkpoint_cursor.get("scan_complete") is False:
        prior = checkpoint_cursor.get("scan_watermark")
        if not isinstance(prior, str):
            raise OfficialSourceConfigurationError("incomplete Judilibre checkpoint is missing its scan watermark")
        _parse_datetime(prior)
        values.append(prior)
    if not values:
        return None
    return min(values, key=_parse_datetime)


def _segment_query_date(pages: list[JudilibreHistoryPage]) -> str:
    if not pages:
        raise OfficialSourceConfigurationError("Judilibre history segment is missing its query timestamp")
    return min((page.query_date for page in pages), key=_parse_datetime)


def _validated_next_history_cursor(
    *,
    page: JudilibreHistoryPage,
    current: JudilibreHistoryCursor,
    client: JudilibreClient,
) -> JudilibreHistoryCursor:
    following = page.next_cursor(
        base_url=client.base_url,
        history_path=getattr(client, "transactional_history_path", "/transactionalhistory"),
        default_page_size=current.page_size,
    )
    if following is None:  # pragma: no cover - guarded by page.next_page.
        raise OfficialSourceConfigurationError("Judilibre history continuation is missing")
    if _cursor_boundary_datetime(following.date) != _cursor_boundary_datetime(current.date):
        raise OfficialSourceConfigurationError("Judilibre history cursor changed the synchronization boundary")
    if following.page_size != current.page_size:
        raise OfficialSourceConfigurationError("Judilibre history cursor changed the requested page size")
    if following.from_id == current.from_id:
        raise OfficialSourceConfigurationError("Judilibre returned a repeated history cursor")
    return following


def _history_scan_origin(
    *,
    checkpoint_cursor: Mapping[str, object] | None,
    initial_cursor: JudilibreHistoryCursor,
) -> str:
    if checkpoint_cursor and checkpoint_cursor.get("scan_complete") is False:
        origin = checkpoint_cursor.get("scan_origin")
        if not isinstance(origin, str):
            raise OfficialSourceConfigurationError("incomplete Judilibre checkpoint is missing its scan origin")
        _cursor_boundary_datetime(origin)
        return origin
    return initial_cursor.date


def _validate_loaded_history_checkpoint(
    *,
    source_cursor: Mapping[str, object],
    watermark_at: datetime | None,
) -> None:
    if "from_id" in source_cursor:
        raise OfficialSourceConfigurationError("durable Judilibre checkpoints must not contain an ephemeral from_id")
    schema_version = source_cursor.get("schema_version")
    scan_complete = source_cursor.get("scan_complete", True)
    if not isinstance(scan_complete, bool):
        raise OfficialSourceConfigurationError("Judilibre checkpoint scan_complete state is invalid")
    if schema_version is None:
        allowed_keys = {"date", "page_size"}
        if set(source_cursor) != allowed_keys:
            raise OfficialSourceConfigurationError("legacy Judilibre checkpoint has unexpected or missing fields")
    else:
        if schema_version != "judilibre_history_checkpoint_v2":
            raise OfficialSourceConfigurationError("Judilibre checkpoint has an unsupported schema")
        allowed_keys = (
            {"schema_version", "date", "page_size", "scan_complete"}
            if scan_complete
            else {
                "schema_version",
                "date",
                "page_size",
                "scan_complete",
                "scan_origin",
                "committed_through_event_at",
                "scan_watermark",
            }
        )
        if set(source_cursor) != allowed_keys:
            raise OfficialSourceConfigurationError("Judilibre checkpoint has unexpected or missing fields")

    checkpoint_date = source_cursor.get("date")
    checkpoint_page_size = source_cursor.get("page_size")
    if not isinstance(checkpoint_date, str):
        raise OfficialSourceConfigurationError("Judilibre checkpoint is missing its date")
    if (
        not isinstance(checkpoint_page_size, int)
        or isinstance(checkpoint_page_size, bool)
        or not HISTORY_MIN_PAGE_SIZE <= checkpoint_page_size <= HISTORY_MAX_PAGE_SIZE
    ):
        raise OfficialSourceConfigurationError("Judilibre checkpoint page size is invalid")

    checkpoint_boundary = _cursor_boundary_datetime(checkpoint_date)
    if scan_complete:
        if watermark_at is None or _ensure_utc(watermark_at) != checkpoint_boundary:
            raise OfficialSourceConfigurationError("complete Judilibre checkpoint watermark does not match its date")
        return

    scan_origin = source_cursor.get("scan_origin")
    scan_watermark = source_cursor.get("scan_watermark")
    committed_through = source_cursor.get("committed_through_event_at")
    if not all(isinstance(value, str) for value in (scan_origin, scan_watermark, committed_through)):
        raise OfficialSourceConfigurationError("incomplete Judilibre checkpoint is missing its temporal state")
    origin_boundary = _cursor_boundary_datetime(str(scan_origin))
    scan_watermark_boundary = _parse_datetime(str(scan_watermark))
    committed_boundary = _parse_datetime(str(committed_through))
    if (
        checkpoint_boundary <= origin_boundary
        or committed_boundary < origin_boundary
        or committed_boundary >= checkpoint_boundary
        or scan_watermark_boundary < origin_boundary
    ):
        raise OfficialSourceConfigurationError("incomplete Judilibre checkpoint has an inconsistent temporal boundary")
    if watermark_at is None or _ensure_utc(watermark_at) != origin_boundary:
        raise OfficialSourceConfigurationError(
            "incomplete Judilibre checkpoint promoted or lost its scan-origin watermark"
        )


def _initial_cursor(
    *,
    checkpoint_cursor: dict[str, object] | None,
    since: str | date | datetime | None,
    page_size: int,
) -> JudilibreHistoryCursor:
    if checkpoint_cursor:
        checkpoint_date = checkpoint_cursor.get("date")
        checkpoint_page_size = checkpoint_cursor.get("page_size", page_size)
        scan_complete = checkpoint_cursor.get("scan_complete", True)
        if not isinstance(scan_complete, bool):
            raise OfficialSourceConfigurationError("Judilibre checkpoint scan_complete state is invalid")
        if scan_complete is False:
            if "from_id" in checkpoint_cursor:
                raise OfficialSourceConfigurationError(
                    "durable Judilibre checkpoints must not contain an ephemeral from_id"
                )
            if not isinstance(checkpoint_date, str):
                raise OfficialSourceConfigurationError(
                    "incomplete Judilibre checkpoint is missing its resume timestamp"
                )
            _parse_datetime(checkpoint_date)
        if isinstance(checkpoint_date, str):
            return JudilibreHistoryCursor(
                date=checkpoint_date,
                page_size=int(checkpoint_page_size),
                from_id=None,
            )
    if since is None:
        raise ValueError("since is required for the first Judilibre synchronization")
    value = since.isoformat() if isinstance(since, (date, datetime)) else str(since)
    return JudilibreHistoryCursor(date=value, page_size=page_size)


def _decision_update_datetime(decision: JudilibreDecision) -> datetime | None:
    if decision.update_datetime is not None:
        return _ensure_utc(decision.update_datetime)
    return _date_at_utc_midnight(decision.update_date)


def _date_at_utc_midnight(value: date | None) -> datetime | None:
    return datetime.combine(value, time.min, tzinfo=UTC) if value is not None else None


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Judilibre timestamps must include a timezone")
    return parsed.astimezone(UTC)


def _cursor_boundary_datetime(value: str) -> datetime:
    try:
        parsed_date = date.fromisoformat(value)
    except ValueError:
        return _parse_datetime(value)
    if value == parsed_date.isoformat():
        return _date_at_utc_midnight(parsed_date)  # type: ignore[return-value]
    return _parse_datetime(value)


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("Judilibre timestamps must include a timezone")
    return value.astimezone(UTC)
