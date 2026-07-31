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
    JudilibreClient,
    JudilibreDecision,
    JudilibreHistoryCursor,
    JudilibreHistoryPage,
    JudilibreSearchQuery,
    JudilibreTransaction,
)
from src.outcome_ingestion.repository import OutcomeIngestionRepository, PersistedSourceRecord
from src.outcome_ingestion.service import JsonSourceRecord, OutcomeSourceIngestionService

JUDILIBRE_SOURCE_NAME = "judilibre"
JUDILIBRE_CONNECTOR_VERSION = "judilibre-outcome/4"
JUDILIBRE_EXTRACTOR_VERSION = "2"
JUDILIBRE_NORMALIZED_SCHEMA = "judilibre_decision_candidate_v2"
JUDILIBRE_DECISION_PAGE_BASE_URL = "https://www.courdecassation.fr/decision"
JUDILIBRE_SEARCH_MAX_RESULTS = 500
JUDILIBRE_SEARCH_MAX_WINDOW_DAYS = 31
JUDILIBRE_SEARCH_PROFILE_VERSION = "1"
JUDILIBRE_HISTORY_COHORT_EXTENSION_PAGES_BEFORE_TERMINAL_DRAIN = 100


@dataclass(frozen=True)
class JudilibreSearchProfile:
    profile_id: str
    query: str
    version: str = JUDILIBRE_SEARCH_PROFILE_VERSION
    fields: tuple[str, ...] = ("dispositif", "motivations", "expose", "sommaire")
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
            profile_id="saisie_immobiliere_v1",
            query="saisie immobilière",
        ),
        JudilibreSearchProfile(
            profile_id="vente_forcee_v1",
            query="vente forcée",
        ),
        JudilibreSearchProfile(
            profile_id="adjudication_v1",
            query="adjudication",
        ),
        JudilibreSearchProfile(
            profile_id="surenchere_v1",
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


def normalized_judilibre_decision(decision: JudilibreDecision) -> dict[str, object]:
    """Minimized analytical projection; the full text stays in private Storage."""
    return {
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
        "extraction_status": "pending",
    }


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
                normalized_data=normalized_judilibre_decision(decision),
                connector_version=JUDILIBRE_CONNECTOR_VERSION,
                extractor_name="judilibre_metadata_projection",
                extractor_version=JUDILIBRE_EXTRACTOR_VERSION,
                schema_version=JUDILIBRE_NORMALIZED_SCHEMA,
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
        max_results: int,
    ) -> JudilibreSearchSyncSummary:
        resolved_profile = validate_judilibre_search_request(
            profile=profile,
            date_start=date_start,
            date_end=date_end,
            max_results=max_results,
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
        page_size = min(getattr(self.client, "page_size", SEARCH_MAX_PAGE_SIZE), max_results)
        if not 1 <= page_size <= SEARCH_MAX_PAGE_SIZE:
            raise OfficialSourceConfigurationError("Judilibre client search page size is invalid")

        pages = 0
        reported_total: int | None = None
        selected: list[tuple[str, int, int]] = []
        seen_ids: set[str] = set()
        page_index = 0
        while True:
            query = JudilibreSearchQuery(
                query=resolved_profile.query,
                field=list(resolved_profile.fields),
                operator="exact",
                jurisdiction=list(resolved_profile.jurisdictions),
                date_start=date_start,
                date_end=date_end,
                sort="date",
                order="asc",
                page=page_index,
                page_size=page_size,
                resolve_references=False,
            )
            page = self.client.search(query)
            pages += 1
            if page.page != page_index or page.page_size != page_size:
                raise OfficialSourceConfigurationError("Judilibre search response changed the requested pagination")
            if page.relaxed:
                raise OfficialSourceConfigurationError(
                    "Judilibre relaxed the targeted search; refusing imprecise results"
                )
            if reported_total is None:
                reported_total = page.total
            elif page.total != reported_total:
                raise OfficialSourceConfigurationError("Judilibre search total changed during pagination")
            if len(page.results) > page_size:
                raise OfficialSourceConfigurationError("Judilibre search returned more metadata than requested")
            if page.next_page and not page.results:
                raise OfficialSourceConfigurationError("Judilibre search continued after an empty metadata page")

            if reported_total > max_results:
                return JudilibreSearchSyncSummary(
                    pages=pages,
                    metadata_examined=len(page.results),
                    reported_total=reported_total,
                    truncated=True,
                )

            for page_rank, result in enumerate(page.results):
                if result.id in seen_ids:
                    raise OfficialSourceConfigurationError("Judilibre search returned a duplicate decision identifier")
                if result.decision_date is None or not date_start <= result.decision_date <= date_end:
                    raise OfficialSourceConfigurationError(
                        "Judilibre search returned a decision outside the requested date window"
                    )
                if result.jurisdiction is None or result.jurisdiction.lower() not in resolved_profile.jurisdictions:
                    raise OfficialSourceConfigurationError(
                        "Judilibre search returned a decision outside the profile jurisdiction"
                    )
                seen_ids.add(result.id)
                selected.append((result.id, page_index, page_rank))

            if len(selected) > reported_total:
                raise OfficialSourceConfigurationError(
                    "Judilibre search returned more metadata than its reported total"
                )
            if len(selected) == reported_total:
                if page.next_page:
                    raise OfficialSourceConfigurationError(
                        "Judilibre search cursor continued beyond its reported total"
                    )
                break
            if not page.next_page:
                raise OfficialSourceConfigurationError(
                    "Judilibre search ended before all reported metadata was examined"
                )
            page_index += 1

        stored = unchanged = deletions = 0
        last_fetch_id: str | None = None
        for result_rank, (decision_id, result_page, page_rank) in enumerate(selected):
            provenance = {
                "discovery_mode": "targeted_search",
                "profile_id": resolved_profile.profile_id,
                "profile_version": resolved_profile.version,
                "profile_hash": resolved_profile.fingerprint,
                "resolved_query": resolved_query,
                "result_page": result_page,
                "page_rank": page_rank,
                "result_rank": result_rank,
                "reported_total": reported_total,
            }
            persisted = self.fetch_decision(
                decision_id,
                policy_checked=True,
                source_cursor=provenance,
                request_provenance={
                    "discovery_profile": resolved_profile.definition(),
                    "discovery_profile_hash": resolved_profile.fingerprint,
                    "discovery_query": resolved_query,
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
                "reported_total": reported_total,
                "max_results": max_results,
                "metadata_complete": True,
            },
            watermark_at=watermark,
            connector_version=JUDILIBRE_CONNECTOR_VERSION,
            last_successful_fetch_id=last_fetch_id,
        )
        return JudilibreSearchSyncSummary(
            pages=pages,
            metadata_examined=len(selected),
            reported_total=reported_total,
            selected_decisions=len(selected),
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
    return f"targeted_search:{profile.profile_id}:{date_start.isoformat()}:{date_end.isoformat()}"


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
