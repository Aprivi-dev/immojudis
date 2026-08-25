from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

try:
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - parser-only installations.
    Jsonb = None

from src.official_sources.base import canonical_sha256
from src.outcome_ingestion.artifact_store import StoredRawArtifact
from src.storage.supabase_client import _postgres_connect

IngestionChannel = Literal["automated", "manual", "partner"]
CaptureTransport = Literal["http", "local_file"]

_JUDILIBRE_V3_SAFE_PROJECTION_KEYS = (
    "schema_version",
    "record_type",
    "judilibre_id",
    "jurisdiction",
    "location",
    "chamber",
    "formation",
    "number",
    "numbers",
    "ecli",
    "nac",
    "decision_date",
    "update_date",
    "decision_type",
    "solution",
    "solution_alt",
    "publication",
    "themes",
    "partial",
    "to_be_deleted",
    "raw_representation_sha256",
    "candidate_grade",
    "review_status",
    "training_eligible",
    "text_storage",
    "personal_identity_features_allowed",
    "extraction_status",
    "extraction_rule_version",
    "claims",
    "ambiguous_claim_types",
    "text_available",
)
_JUDILIBRE_V3_SAFE_PROJECTION_SQL = "jsonb_build_object(" + ", ".join(
    f"'{key}', record.normalized_data->'{key}'"
    for key in _JUDILIBRE_V3_SAFE_PROJECTION_KEYS
) + ")"
_JUDILIBRE_V3_SAFE_KEYS_SQL = "array[" + ", ".join(
    f"'{key}'" for key in _JUDILIBRE_V3_SAFE_PROJECTION_KEYS
) + "]"
_JUDILIBRE_V3_SAFE_ALLOWLIST_SQL = (
    "record.normalized_data ?& "
    + _JUDILIBRE_V3_SAFE_KEYS_SQL
    + " and not exists (select 1 from jsonb_object_keys(record.normalized_data) "
    "as projection_keys(key) where not (projection_keys.key = any("
    + _JUDILIBRE_V3_SAFE_KEYS_SQL
    + ")))"
)


class OutcomeIngestionError(RuntimeError):
    pass


class SourcePolicyError(OutcomeIngestionError):
    pass


@dataclass(frozen=True)
class SourcePolicy:
    id: str
    name: str
    official: bool
    legal_review_status: str
    ingestion_policy: str
    active: bool

    def assert_allows(self, channel: IngestionChannel) -> None:
        if self.legal_review_status != "approved" or not self.active:
            raise SourcePolicyError(f"source policy does not allow ingestion for {self.name}")
        allowed = {
            "automated": {"allowed_automated"},
            "manual": {"allowed_automated", "allowed_manual"},
            "partner": {"partner_only"},
        }[channel]
        if self.ingestion_policy not in allowed:
            raise SourcePolicyError(f"source policy does not allow {channel} ingestion for {self.name}")


@dataclass(frozen=True)
class SuccessfulCapture:
    requested_url: str
    external_record_id: str
    canonical_url: str | None
    stored_artifact: StoredRawArtifact
    connector_version: str
    started_at: datetime
    completed_at: datetime
    published_at: datetime | None = None
    capture_transport: CaptureTransport = "http"
    http_status: int | None = 200
    etag: str | None = None
    last_modified_at: datetime | None = None
    source_cursor: Mapping[str, object] | None = None
    request_method: str | None = "GET"
    request_parameters: Mapping[str, object] | None = None
    metadata: Mapping[str, object] | None = None


@dataclass(frozen=True)
class SourceRecordProjection:
    record_kind: str
    normalized_data: Mapping[str, object]
    extractor_name: str
    extractor_version: str
    schema_version: str
    field_provenance: Mapping[str, object] = field(default_factory=dict)
    decision_date: date | None = None
    source_updated_at: datetime | None = None
    quality_score: str | None = None


@dataclass(frozen=True)
class PersistedSourceRecord:
    source_id: str
    raw_artifact_id: str
    source_fetch_id: str
    artifact_extraction_id: str
    source_record_id: str
    record_version: int
    inserted_new_version: bool


@dataclass(frozen=True)
class PersistedSourceRecordMatch:
    match_id: str
    inserted_new_candidate: bool


@dataclass(frozen=True)
class SourceSyncCheckpoint:
    source_id: str
    stream_key: str
    source_cursor: dict[str, object]
    watermark_at: datetime | None
    connector_version: str
    revision: int


@dataclass(frozen=True)
class StoredDvfAdjudicationRecord:
    source_record_id: str
    external_record_id: str
    normalized_data: dict[str, object]


@dataclass(frozen=True)
class StoredJudilibreDecisionRecord:
    source_record_id: str
    external_record_id: str
    decision_date: date
    content_hash: str
    normalized_data: dict[str, object]


@dataclass(frozen=True)
class StoredJudilibreCourtResolution:
    court_id: str
    court_code: str
    resolution_method: str
    reference_sha256: str


@dataclass(frozen=True)
class StoredJudilibreAuctionMatchContext:
    case_id: str
    lot_id: str
    round_id: str
    court_id: str
    scheduled_date: date
    date_delta_days: int
    case_number_match: bool
    portalis_number_match: bool


@dataclass(frozen=True)
class StoredAuctionLotMatchContext:
    case_id: str
    lot_id: str
    round_id: str | None
    scheduled_at: date | datetime | None
    scheduled_date_source: str | None
    parcel_ids: tuple[str, ...]
    address: str | None
    city: str | None
    postal_code: str | None
    insee_code: str | None


class OutcomeIngestionRepository:
    def __init__(
        self,
        db_url: str,
        *,
        connect: Callable[[str], Any] = _postgres_connect,
    ) -> None:
        if not db_url.strip():
            raise OutcomeIngestionError("SUPABASE_DB_URL is required for Outcome ingestion")
        self._db_url = db_url
        self._connect = connect

    @classmethod
    def from_settings(
        cls,
        settings: Mapping[str, Any],
        *,
        connect: Callable[[str], Any] = _postgres_connect,
    ) -> OutcomeIngestionRepository:
        return cls(str(settings.get("supabase_db_url") or ""), connect=connect)

    def require_source_policy(self, source_name: str, channel: IngestionChannel) -> SourcePolicy:
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                policy = _load_source_policy(cursor, source_name)
        policy.assert_allows(channel)
        return policy

    def source_record_exists(
        self,
        *,
        source_name: str,
        external_record_id: str,
    ) -> bool:
        if not source_name.strip() or not external_record_id.strip():
            raise ValueError("source name and external record id are required")
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select exists (
                      select 1
                      from public.judicial_source_records record
                      join public.data_sources source on source.id = record.source_id
                      where source.name = %s
                        and record.external_record_id = %s
                      limit 1
                    )
                    """,
                    (source_name.strip(), external_record_id.strip()),
                )
                row = cursor.fetchone()
        return bool(row and row[0])

    def source_record_ids_exist(
        self,
        source_name: str,
        external_record_ids: Iterable[str],
        *,
        chunk_size: int = 1_000,
    ) -> set[str]:
        if not source_name.strip():
            raise ValueError("source name is required")
        if chunk_size < 1 or chunk_size > 10_000:
            raise ValueError("source-record lookup chunk size must be between 1 and 10000")
        unique_ids = tuple(
            dict.fromkeys(
                cleaned
                for value in external_record_ids
                if isinstance(value, str) and (cleaned := value.strip())
            )
        )
        if not unique_ids:
            return set()

        existing: set[str] = set()
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                for start in range(0, len(unique_ids), chunk_size):
                    chunk = unique_ids[start : start + chunk_size]
                    cursor.execute(
                        """
                        select distinct record.external_record_id
                        from public.judicial_source_records record
                        join public.data_sources source on source.id = record.source_id
                        where source.name = %s
                          and record.external_record_id = any(%s::text[])
                          and not exists (
                            select 1
                            from public.source_purge_events purge
                            where purge.source_id = record.source_id
                              and (
                                purge.source_record_id = record.id
                                or purge.external_record_id = record.external_record_id
                              )
                              and purge.event_type in (
                                'deletion_requested', 'deletion_completed',
                                'redaction_requested', 'redaction_completed',
                                'retention_expired'
                              )
                          )
                        """,
                        (source_name.strip(), list(chunk)),
                    )
                    existing.update(str(row[0]) for row in cursor.fetchall())
        return existing

    def persist_successful_record(
        self,
        *,
        source_name: str,
        channel: IngestionChannel,
        capture: SuccessfulCapture,
        projection: SourceRecordProjection,
    ) -> PersistedSourceRecord:
        _validate_capture(capture)
        if Jsonb is None:
            raise OutcomeIngestionError("psycopg is required for Outcome ingestion writes")
        normalized_data = dict(projection.normalized_data)
        output_hash = canonical_sha256(normalized_data)

        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                policy = _load_source_policy(cursor, source_name)
                policy.assert_allows(channel)
                raw_artifact_id = _insert_or_get_raw_artifact(cursor, policy, capture)
                source_fetch_id = _insert_source_fetch(cursor, policy, capture, raw_artifact_id)
                extraction_id = _insert_or_get_extraction(
                    cursor,
                    raw_artifact_id=raw_artifact_id,
                    source_fetch_id=source_fetch_id,
                    projection=projection,
                    normalized_data=normalized_data,
                    output_hash=output_hash,
                )
                source_record_id, record_version, inserted = _insert_or_get_source_record(
                    cursor,
                    policy=policy,
                    capture=capture,
                    projection=projection,
                    normalized_data=normalized_data,
                    normalized_hash=output_hash,
                    raw_artifact_id=raw_artifact_id,
                    source_fetch_id=source_fetch_id,
                    extraction_id=extraction_id,
                )
            connection.commit()
        return PersistedSourceRecord(
            source_id=policy.id,
            raw_artifact_id=raw_artifact_id,
            source_fetch_id=source_fetch_id,
            artifact_extraction_id=extraction_id,
            source_record_id=source_record_id,
            record_version=record_version,
            inserted_new_version=inserted,
        )

    def load_checkpoint(self, *, source_name: str, stream_key: str) -> SourceSyncCheckpoint | None:
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                policy = _load_source_policy(cursor, source_name)
                cursor.execute(
                    """
                    select source_cursor, watermark_at, connector_version, revision
                    from public.source_sync_checkpoints
                    where source_id = %s and stream_key = %s
                    """,
                    (policy.id, stream_key),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return SourceSyncCheckpoint(
            source_id=policy.id,
            stream_key=stream_key,
            source_cursor=dict(row[0] or {}),
            watermark_at=row[1],
            connector_version=str(row[2]),
            revision=int(row[3]),
        )

    def advance_checkpoint(
        self,
        *,
        source_name: str,
        channel: IngestionChannel,
        stream_key: str,
        expected_revision: int | None,
        source_cursor: Mapping[str, object],
        watermark_at: datetime,
        connector_version: str,
        last_successful_fetch_id: str | None = None,
    ) -> SourceSyncCheckpoint:
        if Jsonb is None:
            raise OutcomeIngestionError("psycopg is required for Outcome ingestion writes")
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                policy = _load_source_policy(cursor, source_name)
                policy.assert_allows(channel)
                cursor.execute(
                    """
                    select source_cursor, watermark_at, connector_version, revision
                    from app_private.upsert_outcome_source_checkpoint(
                      %s, %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        policy.id,
                        stream_key,
                        expected_revision,
                        Jsonb(dict(source_cursor)),
                        watermark_at,
                        connector_version,
                        last_successful_fetch_id,
                    ),
                )
                row = cursor.fetchone()
            connection.commit()
        if row is None:
            raise OutcomeIngestionError("source checkpoint persistence failed")
        return SourceSyncCheckpoint(
            source_id=policy.id,
            stream_key=stream_key,
            source_cursor=dict(row[0] or {}),
            watermark_at=row[1],
            connector_version=str(row[2]),
            revision=int(row[3]),
        )

    def record_source_deletion(
        self,
        *,
        source_name: str,
        external_record_id: str,
        event_at: datetime,
        reason_code: str,
        connector_version: str,
    ) -> str:
        """Record and enqueue a purge even if the source has since been disabled."""
        if Jsonb is None:
            raise OutcomeIngestionError("psycopg is required for Outcome ingestion writes")
        evidence_hash = canonical_sha256(
            {
                "source_name": source_name,
                "external_record_id": external_record_id,
                "event_at": event_at,
                "reason_code": reason_code,
            }
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                policy = _load_source_policy(cursor, source_name)
                cursor.execute(
                    """
                    select id, source_fetch_id, raw_artifact_id
                    from public.judicial_source_records
                    where source_id = %s and external_record_id = %s
                    order by record_version desc
                    limit 1
                    """,
                    (policy.id, external_record_id),
                )
                prior = cursor.fetchone()
                source_record_id = str(prior[0]) if prior is not None else None
                source_fetch_id = str(prior[1]) if prior is not None and prior[1] is not None else None
                raw_artifact_id = str(prior[2]) if prior is not None and prior[2] is not None else None
                cursor.execute(
                    """
                    insert into public.source_purge_events (
                      source_id, source_fetch_id, raw_artifact_id, source_record_id,
                      external_record_id, event_type, reason_code, request_reference,
                      evidence_hash, details, event_at
                    )
                    select %s, %s, %s, %s, %s, 'deletion_requested', %s,
                      'judilibre.transactionalhistory', %s, %s, %s
                    where not exists (
                      select 1 from public.source_purge_events
                      where source_id = %s and evidence_hash = %s
                    )
                    returning id
                    """,
                    (
                        policy.id,
                        source_fetch_id,
                        raw_artifact_id,
                        source_record_id,
                        external_record_id,
                        reason_code,
                        evidence_hash,
                        Jsonb({"connector_version": connector_version}),
                        event_at,
                        policy.id,
                        evidence_hash,
                    ),
                )
                purge_row = cursor.fetchone()
                if purge_row is None:
                    cursor.execute(
                        "select id from public.source_purge_events where source_id = %s and evidence_hash = %s",
                        (policy.id, evidence_hash),
                    )
                    purge_row = cursor.fetchone()
                if purge_row is None:
                    raise OutcomeIngestionError("source deletion event persistence failed")
                purge_event_id = str(purge_row[0])
                cursor.execute(
                    """
                    insert into public.ingestion_jobs (
                      source_id, job_kind, stream_key, idempotency_key, payload, priority
                    ) values (%s, 'source.purge', 'deletions', %s, %s, 100)
                    on conflict (source_id, job_kind, idempotency_key) do nothing
                    """,
                    (
                        policy.id,
                        evidence_hash,
                        Jsonb(
                            {
                                "schema_version": "source_purge_job_v1",
                                "purge_event_id": purge_event_id,
                                "external_record_id": external_record_id,
                                "source_record_id": source_record_id,
                                "raw_artifact_id": raw_artifact_id,
                            }
                        ),
                    ),
                )
            connection.commit()
        return purge_event_id

    def append_match_candidate(
        self,
        *,
        source_record_id: str,
        match_score: str,
        match_method: str,
        match_signals: Mapping[str, object],
        case_id: str | None = None,
        lot_id: str | None = None,
        round_id: str | None = None,
        outcome_id: str | None = None,
    ) -> str:
        if Jsonb is None:
            raise OutcomeIngestionError("psycopg is required for Outcome ingestion writes")
        if not any((case_id, lot_id, round_id, outcome_id)):
            raise ValueError("a source-record match requires at least one target")
        lock_key = _match_target_lock_key(
            source_record_id=source_record_id,
            case_id=case_id,
            lot_id=lot_id,
            round_id=round_id,
            outcome_id=outcome_id,
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("select pg_advisory_xact_lock(%s)", (lock_key,))
                cursor.execute(
                    """
                    select match_row.id
                    from public.source_record_matches match_row
                    where match_row.source_record_id = %s
                      and match_row.case_id is not distinct from %s
                      and match_row.lot_id is not distinct from %s
                      and match_row.round_id is not distinct from %s
                      and match_row.outcome_id is not distinct from %s
                      and not exists (
                        select 1
                        from public.source_record_matches successor
                        where successor.supersedes_match_id = match_row.id
                      )
                    order by match_row.created_at desc, match_row.id desc
                    limit 1
                    """,
                    (source_record_id, case_id, lot_id, round_id, outcome_id),
                )
                row = cursor.fetchone()
                if row is None:
                    cursor.execute(
                        """
                        insert into public.source_record_matches (
                          source_record_id, case_id, lot_id, round_id, outcome_id,
                          match_score, match_method, match_signals, status
                        ) values (%s, %s, %s, %s, %s, %s, %s, %s, 'candidate')
                        returning id
                        """,
                        (
                            source_record_id,
                            case_id,
                            lot_id,
                            round_id,
                            outcome_id,
                            match_score,
                            match_method,
                            Jsonb(dict(match_signals)),
                        ),
                    )
                    row = cursor.fetchone()
            connection.commit()
        if row is None:
            raise OutcomeIngestionError("source-record match persistence failed")
        return str(row[0])

    def append_judilibre_match_candidate(
        self,
        *,
        source_record_id: str,
        expected_source_content_hash: str,
        expected_court_id: str,
        expected_decision_date: date,
        max_date_delta_days: int,
        case_id: str,
        lot_id: str,
        round_id: str,
        match_score: str,
        match_method: str,
        match_signals: Mapping[str, object],
    ) -> PersistedSourceRecordMatch:
        """Atomically revalidate and append a review-only Judilibre candidate."""

        if Jsonb is None:
            raise OutcomeIngestionError("psycopg is required for Outcome ingestion writes")
        if not re.fullmatch(r"[0-9a-f]{64}", expected_source_content_hash):
            raise ValueError("Judilibre source projection hash must be SHA-256")
        if not 0 <= max_date_delta_days <= 30:
            raise ValueError("Judilibre date delta must be between 0 and 30 days")
        if match_method not in {
            "exact_case_number",
            "exact_portalis_number",
            "composite",
        }:
            raise ValueError("Judilibre match method is not review-safe")
        if re.fullmatch(r"(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)", match_score) is None:
            raise ValueError("Judilibre match score must be between 0 and 1")
        _validate_judilibre_match_signals(
            match_signals,
            expected_source_content_hash=expected_source_content_hash,
            match_method=match_method,
        )
        if match_signals.get("source_record_sha256") != canonical_sha256(
            {
                "schema_version": "judilibre_source_record_reference_v1",
                "source_record_id": source_record_id,
            }
        ):
            raise ValueError("Judilibre source-record provenance is inconsistent")
        lock_key = _match_target_lock_key(
            source_record_id=source_record_id,
            case_id=None,
            lot_id=None,
            round_id=None,
            outcome_id=None,
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("select pg_advisory_xact_lock(%s)", (lock_key,))
                # The reviewed matcher must decide against one stable catalogue
                # and source-policy snapshot. SHARE blocks concurrent catalogue,
                # source-version and purge writes until this tiny transaction
                # either appends the candidate or fails closed.
                cursor.execute(
                    """
                    lock table
                      public.artifact_extractions,
                      public.auction_cases,
                      public.auction_lots,
                      public.auction_rounds,
                      public.data_sources,
                      public.judicial_source_records,
                      public.outcome_courts,
                      public.source_purge_events,
                      public.tribunals
                    in share mode
                    """
                )
                # Serialize all match writers without a SHARE -> ROW EXCLUSIVE
                # upgrade, which could deadlock two different source records.
                cursor.execute(
                    """
                    lock table public.source_record_matches
                    in share row exclusive mode
                    """
                )
                cursor.execute(
                    "select "
                    + _JUDILIBRE_V3_SAFE_PROJECTION_SQL
                    + """ as normalized_data, record.decision_date
                    from public.judicial_source_records record
                    join public.data_sources source on source.id = record.source_id
                    join public.artifact_extractions extraction
                      on extraction.id = record.artifact_extraction_id
                    where record.id = %s
                      and record.content_hash = %s
                      and source.name = 'judilibre'
                      and source.official
                      and source.active
                      and source.legal_review_status = 'approved'
                      and source.ingestion_policy = 'allowed_automated'
                      and record.record_kind = 'judicial_decision_candidate'
                      and not record.training_eligible
                      and record.normalized_data->>'schema_version'
                        = 'judilibre_decision_candidate_v3'
                      and record.normalized_data->>'record_type'
                        = 'judicial_decision_candidate'
                      and record.normalized_data->>'judilibre_id'
                        = record.external_record_id
                      and lower(record.normalized_data->>'jurisdiction') = 'tj'
                      and nullif(btrim(record.normalized_data->>'location'), '') is not null
                      and record.normalized_data->>'decision_date'
                        = record.decision_date::text
                      and record.normalized_data @> '{
                        "candidate_grade": "C",
                        "review_status": "pending",
                        "training_eligible": false,
                        "personal_identity_features_allowed": false,
                        "extraction_status": "candidate_facts_extracted",
                        "ambiguous_claim_types": [],
                        "to_be_deleted": false,
                        "text_storage": "private_raw_artifact",
                        "text_available": true
                      }'::jsonb
                      and record.normalized_data->'ambiguous_claim_types' = '[]'::jsonb
                      and """
                    + _JUDILIBRE_V3_SAFE_ALLOWLIST_SQL
                    + """
                      and record.normalized_data->>'raw_representation_sha256'
                        ~ '^[0-9a-f]{64}$'
                      and extraction.extraction_status = 'succeeded'
                      and extraction.extractor_name = 'judilibre_candidate_extraction'
                      and extraction.extractor_version = '3'
                      and extraction.schema_version = 'judilibre_decision_candidate_v3'
                      and extraction.output_hash = record.content_hash
                      and extraction.field_provenance->>'hash_version'
                        = 'judilibre-evidence-sha256-v1'
                      and jsonb_typeof(extraction.field_provenance->'claims') = 'object'
                      and jsonb_typeof(record.normalized_data->'claims') = 'array'
                      and jsonb_array_length(record.normalized_data->'claims') between 1 and 7
                      and not exists (
                        select 1
                        from jsonb_array_elements(
                          case
                            when jsonb_typeof(record.normalized_data->'claims') = 'array'
                              then record.normalized_data->'claims'
                            else '[]'::jsonb
                          end
                        ) claim
                        where coalesce(
                          extraction.field_provenance->'claims'
                            ->(claim->>'claim_id')->>'evidence_sha256',
                          ''
                        ) <> claim->>'evidence_hash'
                          or coalesce(
                            extraction.field_provenance->'claims'
                              ->(claim->>'claim_id')->>'raw_artifact_sha256',
                            ''
                          ) <> record.normalized_data->>'raw_representation_sha256'
                          or coalesce(
                            extraction.field_provenance->'claims'
                              ->(claim->>'claim_id')->>'hash_version',
                            ''
                          ) <> 'judilibre-evidence-sha256-v1'
                      )
                      and not exists (
                        select 1
                        from public.judicial_source_records newer
                        where newer.source_id = record.source_id
                          and newer.external_record_id = record.external_record_id
                          and newer.record_version > record.record_version
                      )
                      and not exists (
                        select 1
                        from public.source_purge_events purge
                        where purge.source_id = record.source_id
                          and (
                            purge.source_record_id = record.id
                            or purge.external_record_id = record.external_record_id
                          )
                          and purge.event_type in (
                            'deletion_requested', 'deletion_completed',
                            'redaction_requested', 'redaction_completed',
                            'retention_expired'
                          )
                      )
                    for share of record, source, extraction
                    """,
                    (source_record_id, expected_source_content_hash),
                )
                source_row = cursor.fetchone()
                if source_row is None or not isinstance(source_row[1], date):
                    raise OutcomeIngestionError(
                        "Judilibre source candidate is no longer current and eligible for review matching"
                    )
                normalized_data = dict(source_row[0] or {})
                source_decision_date = source_row[1]
                if source_decision_date != expected_decision_date:
                    raise OutcomeIngestionError(
                        "Judilibre source decision date changed before match persistence"
                    )
                current_court_resolutions = _load_current_judilibre_court_resolutions(
                    cursor,
                    location=normalized_data.get("location"),
                )
                if len(current_court_resolutions) != 1:
                    raise OutcomeIngestionError(
                        "Judilibre court resolution is no longer unique"
                    )
                current_court = current_court_resolutions[0]
                if (
                    current_court.court_id != expected_court_id
                    or current_court.resolution_method
                    != match_signals.get("court_resolution_method")
                    or current_court.reference_sha256
                    != match_signals.get("court_resolution_reference_sha256")
                ):
                    raise OutcomeIngestionError(
                        "Judilibre court resolution changed before persistence"
                    )
                source_claims = normalized_data.get("claims")
                if not isinstance(source_claims, list):
                    raise OutcomeIngestionError(
                        "Judilibre source claims changed before match persistence"
                    )
                source_claim_types = sorted(
                    str(claim.get("claim_type"))
                    for claim in source_claims
                    if isinstance(claim, Mapping)
                )
                if (
                    len(source_claim_types) != len(source_claims)
                    or match_signals.get("claim_types") != source_claim_types
                    or match_signals.get("claims_manifest_sha256")
                    != canonical_sha256(
                        {
                            "schema_version": "judilibre_claim_manifest_v1",
                            "claims": source_claims,
                        }
                    )
                ):
                    raise OutcomeIngestionError(
                        "Judilibre claim manifest changed before match persistence"
                    )

                cursor.execute(
                    """
                    select
                      case_row.id,
                      lot.id,
                      round_row.id,
                      round_row.court_id,
                      (
                        round_row.scheduled_at
                        at time zone round_row.local_timezone
                      )::date as scheduled_date,
                      case_row.court_case_number,
                      case_row.portalis_number
                    from public.auction_rounds round_row
                    join public.auction_lots lot on lot.id = round_row.lot_id
                    join public.auction_cases case_row
                      on case_row.id = lot.auction_case_id
                    join public.outcome_courts court_row
                      on court_row.id = round_row.court_id
                    where case_row.id = %s
                      and lot.id = %s
                      and round_row.id = %s
                      and case_row.court_id = %s
                      and round_row.court_id = %s
                      and lot.active
                      and court_row.active
                      and round_row.scheduled_at is not null
                    for share of case_row, lot, round_row, court_row
                    """,
                    (
                        case_id,
                        lot_id,
                        round_id,
                        expected_court_id,
                        expected_court_id,
                    ),
                )
                target_row = cursor.fetchone()
                if target_row is None or not isinstance(target_row[4], date):
                    raise OutcomeIngestionError(
                        "Judilibre auction target is no longer matchable"
                    )
                scheduled_date = target_row[4]
                date_delta_days = abs((scheduled_date - source_decision_date).days)
                if date_delta_days > max_date_delta_days:
                    raise OutcomeIngestionError(
                        "Judilibre auction target moved outside the bounded date window"
                    )

                references = _judilibre_projection_references(normalized_data)
                case_number_match = (
                    _normalize_match_reference(target_row[5]) in references
                )
                portalis_number_match = (
                    _normalize_match_reference(target_row[6]) in references
                )
                if (
                    match_signals.get("case_number") is not case_number_match
                    or match_signals.get("portalis_number") is not portalis_number_match
                    or match_signals.get("hearing_date_exact")
                    is not (date_delta_days == 0)
                    or match_signals.get("hearing_date_delta_days") != date_delta_days
                ):
                    raise OutcomeIngestionError(
                        "Judilibre match signals changed before persistence"
                    )
                if not (case_number_match or portalis_number_match or date_delta_days == 0):
                    raise OutcomeIngestionError(
                        "Judilibre auction target does not have enough objective signals"
                    )
                expected_score, expected_method = (
                    ("0.9800" if date_delta_days == 0 else "0.9400", "exact_portalis_number")
                    if portalis_number_match
                    else (
                        ("0.9500" if date_delta_days == 0 else "0.9000", "exact_case_number")
                        if case_number_match
                        else ("0.7500", "composite")
                    )
                )
                if match_score != expected_score or match_method != expected_method:
                    raise OutcomeIngestionError(
                        "Judilibre match score or method is not canonical"
                    )
                if match_signals.get("case_reference_manifest_sha256") != canonical_sha256(
                    {
                        "schema_version": "judilibre_case_reference_manifest_v1",
                        "references": references,
                    }
                ):
                    raise OutcomeIngestionError(
                        "Judilibre case-reference manifest changed before persistence"
                    )
                if match_signals.get("target_context_sha256") != canonical_sha256(
                    {
                        "schema_version": "judilibre_target_context_v1",
                        "case_id": str(target_row[0]),
                        "lot_id": str(target_row[1]),
                        "round_id": str(target_row[2]),
                        "court_id": str(target_row[3]),
                        "scheduled_date": scheduled_date,
                    }
                ):
                    raise OutcomeIngestionError(
                        "Judilibre target-context manifest changed before persistence"
                    )

                # Recompute the objective top rank inside the write transaction.
                # The source-scoped advisory lock prevents two matcher runs from
                # persisting competing proposals for the same decision.
                cursor.execute(
                    """
                    with eligible as (
                      select
                        case_row.id as case_id,
                        lot.id as lot_id,
                        round_row.id as round_id,
                        case
                          when regexp_replace(
                            lower(btrim(coalesce(case_row.portalis_number, ''))),
                            '\\s+', ' ', 'g'
                          ) = any(%s::text[]) then 2
                          when regexp_replace(
                            lower(btrim(coalesce(case_row.court_case_number, ''))),
                            '\\s+', ' ', 'g'
                          ) = any(%s::text[]) then 1
                          else 0
                        end as reference_rank,
                        abs((
                          round_row.scheduled_at
                          at time zone round_row.local_timezone
                        )::date - %s::date) as date_delta_days
                      from public.auction_rounds round_row
                      join public.auction_lots lot on lot.id = round_row.lot_id
                      join public.auction_cases case_row
                        on case_row.id = lot.auction_case_id
                      join public.outcome_courts court_row
                        on court_row.id = round_row.court_id
                      where lot.active
                        and court_row.active
                        and round_row.court_id = %s
                        and case_row.court_id = %s
                        and round_row.scheduled_at is not null
                        and (
                          round_row.scheduled_at
                          at time zone round_row.local_timezone
                        )::date between %s::date - %s and %s::date + %s
                    ), ranked as (
                      select
                        eligible.*,
                        count(*) over (
                          partition by reference_rank, date_delta_days
                        ) as tied_at_rank
                      from eligible
                      where reference_rank > 0 or date_delta_days = 0
                    )
                    select
                      case_id,
                      lot_id,
                      round_id,
                      reference_rank,
                      date_delta_days,
                      tied_at_rank,
                      (
                        select count(distinct reference_case.case_id)
                        from eligible reference_case
                        where reference_case.reference_rank > 0
                      ) as exact_reference_case_count
                    from ranked
                    order by
                      reference_rank desc,
                      date_delta_days,
                      case_id,
                      lot_id,
                      round_id
                    limit 1
                    """,
                    (
                        list(references),
                        list(references),
                        source_decision_date,
                        expected_court_id,
                        expected_court_id,
                        source_decision_date,
                        max_date_delta_days,
                        source_decision_date,
                        max_date_delta_days,
                    ),
                )
                objective_top = cursor.fetchone()
                expected_reference_rank = 2 if portalis_number_match else (
                    1 if case_number_match else 0
                )
                if (
                    objective_top is None
                    or tuple(str(value) for value in objective_top[:3])
                    != (case_id, lot_id, round_id)
                    or int(objective_top[3]) != expected_reference_rank
                    or int(objective_top[4]) != date_delta_days
                ):
                    raise OutcomeIngestionError(
                        "Judilibre auction target is no longer the objective top candidate"
                    )
                if int(objective_top[5]) != 1:
                    raise OutcomeIngestionError(
                        "Judilibre auction target is ambiguous at the objective top rank"
                    )
                if int(objective_top[6]) > 1:
                    raise OutcomeIngestionError(
                        "Judilibre exact case references resolve to conflicting cases"
                    )

                cursor.execute(
                    """
                    select
                      match_row.id,
                      match_row.match_score,
                      match_row.match_method,
                      match_row.match_signals
                    from public.source_record_matches match_row
                    where match_row.source_record_id = %s
                      and match_row.case_id = %s
                      and match_row.lot_id = %s
                      and match_row.round_id = %s
                      and match_row.outcome_id is null
                    order by match_row.created_at desc, match_row.id desc
                    limit 1
                    """,
                    (source_record_id, case_id, lot_id, round_id),
                )
                existing = cursor.fetchone()
                if existing is not None:
                    if (
                        str(existing[1]) != match_score
                        or str(existing[2]) != match_method
                        or canonical_sha256(existing[3] or {})
                        != canonical_sha256(dict(match_signals))
                    ):
                        raise OutcomeIngestionError(
                            "Existing Judilibre match history differs from the current objective candidate"
                        )
                    result = PersistedSourceRecordMatch(
                        match_id=str(existing[0]),
                        inserted_new_candidate=False,
                    )
                else:
                    cursor.execute(
                        """
                        insert into public.source_record_matches (
                          source_record_id, case_id, lot_id, round_id, outcome_id,
                          match_score, match_method, match_signals, status
                        ) values (
                          %s, %s, %s, %s, null, %s, %s, %s, 'candidate'
                        )
                        returning id
                        """,
                        (
                            source_record_id,
                            case_id,
                            lot_id,
                            round_id,
                            match_score,
                            match_method,
                            Jsonb(dict(match_signals)),
                        ),
                    )
                    inserted = cursor.fetchone()
                    if inserted is None:
                        raise OutcomeIngestionError(
                            "Judilibre match candidate persistence failed"
                        )
                    result = PersistedSourceRecordMatch(
                        match_id=str(inserted[0]),
                        inserted_new_candidate=True,
                    )
            connection.commit()
        return result

    def load_active_dvf_adjudication_records(
        self,
        *,
        limit: int | None,
        after_source_record_id: str | None = None,
    ) -> list[StoredDvfAdjudicationRecord]:
        if limit is not None and limit < 1:
            raise ValueError("DVF source-record limit must be positive")
        if after_source_record_id is not None and not after_source_record_id.strip():
            raise ValueError("DVF source-record cursor cannot be blank")
        normalized_cursor = (
            str(UUID(after_source_record_id))
            if after_source_record_id is not None
            else None
        )
        limit_clause = "" if limit is None else "limit %s"
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor_position: tuple[datetime, str] | None = None
                if normalized_cursor is not None:
                    cursor.execute(
                        """
                        select record.created_at, record.id
                        from public.judicial_source_records record
                        join public.data_sources source on source.id = record.source_id
                        where record.id = %s::uuid
                          and source.name = 'dvf_dgfip'
                        limit 1
                        """,
                        (normalized_cursor,),
                    )
                    cursor_row = cursor.fetchone()
                    if cursor_row is None:
                        raise OutcomeIngestionError(
                            "DVF source-record cursor does not exist"
                        )
                    if not isinstance(cursor_row[0], datetime):
                        raise OutcomeIngestionError(
                            "DVF source-record cursor has no valid creation timestamp"
                        )
                    cursor_position = (cursor_row[0], str(cursor_row[1]))
                cursor_clause = (
                    ""
                    if cursor_position is None
                    else (
                        "and (record.created_at, record.id) "
                        "> (%s::timestamptz, %s::uuid)"
                    )
                )
                parameters: tuple[object, ...] = (
                    *(cursor_position or ()),
                    *((limit,) if limit is not None else ()),
                )
                cursor.execute(
                    f"""
                    select record.id, record.external_record_id, record.normalized_data
                    from public.judicial_source_records record
                    join public.data_sources source on source.id = record.source_id
                    where source.name = 'dvf_dgfip'
                      and source.active
                      and source.legal_review_status = 'approved'
                      and source.ingestion_policy = 'allowed_automated'
                      and record.record_kind = 'auction_result_candidate'
                      and not record.training_eligible
                      and record.normalized_data->>'schema_version'
                        = 'dvf_adjudication_candidate_v1'
                      and record.normalized_data->>'mutation_nature' = 'Adjudication'
                      {cursor_clause}
                      and not exists (
                        select 1
                        from public.judicial_source_records newer
                        where newer.source_id = record.source_id
                          and newer.external_record_id = record.external_record_id
                          and newer.record_version > record.record_version
                      )
                      and not exists (
                        select 1
                        from public.source_purge_events purge
                        where purge.source_id = record.source_id
                          and (
                            purge.source_record_id = record.id
                            or purge.external_record_id = record.external_record_id
                          )
                          and purge.event_type in (
                            'deletion_requested', 'deletion_completed',
                            'redaction_requested', 'redaction_completed',
                            'retention_expired'
                          )
                      )
                    order by record.created_at, record.id
                    {limit_clause}
                    """,
                    parameters,
                )
                rows = cursor.fetchall()
        return [
            StoredDvfAdjudicationRecord(
                source_record_id=str(row[0]),
                external_record_id=str(row[1]),
                normalized_data=dict(row[2] or {}),
            )
            for row in rows
        ]

    def require_judilibre_matching_schema(self) -> None:
        """Fail before scanning when the reviewed matching graph is incomplete."""

        required_tables = (
            "public.judicial_source_records",
            "public.artifact_extractions",
            "public.source_record_matches",
            "public.source_purge_events",
            "public.data_sources",
            "public.outcome_courts",
            "public.tribunals",
            "public.auction_cases",
            "public.auction_lots",
            "public.auction_rounds",
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select
                      to_regclass('public.judicial_source_records'),
                      to_regclass('public.artifact_extractions'),
                      to_regclass('public.source_record_matches'),
                      to_regclass('public.source_purge_events'),
                      to_regclass('public.data_sources'),
                      to_regclass('public.outcome_courts'),
                      to_regclass('public.tribunals'),
                      to_regclass('public.auction_cases'),
                      to_regclass('public.auction_lots'),
                      to_regclass('public.auction_rounds')
                    """
                )
                row = cursor.fetchone()
        missing = [
            table
            for index, table in enumerate(required_tables)
            if row is None or row[index] is None
        ]
        if missing:
            raise OutcomeIngestionError(
                "Judilibre matching schema is incomplete; apply versioned migrations for: "
                + ", ".join(missing)
            )

    def has_matchable_judilibre_rounds(self) -> bool:
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select exists (
                      select 1
                      from public.auction_rounds round_row
                      join public.auction_lots lot on lot.id = round_row.lot_id
                      join public.outcome_courts court_row on court_row.id = round_row.court_id
                      where lot.active
                        and court_row.active
                        and round_row.scheduled_at is not null
                      limit 1
                    )
                    """
                )
                row = cursor.fetchone()
        return bool(row and row[0])

    def load_active_judilibre_decision_records(
        self,
        *,
        limit: int,
        after_source_record_id: str | None = None,
    ) -> list[StoredJudilibreDecisionRecord]:
        """Load only current, non-purged, non-training Judilibre claim candidates.

        This query deliberately excludes raw artifacts and extraction prose. The
        matcher receives only the minimized projection written by the reviewed
        Judilibre extractor.
        """

        if limit < 1 or limit > 10_000:
            raise ValueError("Judilibre source-record page size must be between 1 and 10000")
        if after_source_record_id is not None and not after_source_record_id.strip():
            raise ValueError("Judilibre source-record cursor cannot be blank")
        normalized_cursor = (
            str(UUID(after_source_record_id))
            if after_source_record_id is not None
            else None
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor_position: tuple[datetime, str] | None = None
                if normalized_cursor is not None:
                    cursor.execute(
                        """
                        select record.created_at, record.id
                        from public.judicial_source_records record
                        join public.data_sources source on source.id = record.source_id
                        where record.id = %s::uuid
                          and source.name = 'judilibre'
                        limit 1
                        """,
                        (normalized_cursor,),
                    )
                    cursor_row = cursor.fetchone()
                    if cursor_row is None:
                        raise OutcomeIngestionError(
                            "Judilibre source-record cursor does not exist"
                        )
                    if not isinstance(cursor_row[0], datetime):
                        raise OutcomeIngestionError(
                            "Judilibre source-record cursor has no valid creation timestamp"
                        )
                    cursor_position = (cursor_row[0], str(cursor_row[1]))
                cursor_clause = (
                    ""
                    if cursor_position is None
                    else (
                        "and (record.created_at, record.id) "
                        "> (%s::timestamptz, %s::uuid)"
                    )
                )
                cursor.execute(
                    f"""
                    select
                      record.id,
                      record.external_record_id,
                      record.decision_date,
                      record.content_hash,
                      {_JUDILIBRE_V3_SAFE_PROJECTION_SQL} as normalized_data
                    from public.judicial_source_records record
                    join public.data_sources source on source.id = record.source_id
                    join public.artifact_extractions extraction
                      on extraction.id = record.artifact_extraction_id
                    where source.name = 'judilibre'
                      and source.official
                      and source.active
                      and source.legal_review_status = 'approved'
                      and source.ingestion_policy = 'allowed_automated'
                      and record.record_kind = 'judicial_decision_candidate'
                      and not record.training_eligible
                      and record.decision_date is not null
                      and record.normalized_data->>'schema_version'
                        = 'judilibre_decision_candidate_v3'
                      and record.normalized_data->>'record_type'
                        = 'judicial_decision_candidate'
                      and record.normalized_data->>'judilibre_id'
                        = record.external_record_id
                      and lower(record.normalized_data->>'jurisdiction') = 'tj'
                      and nullif(btrim(record.normalized_data->>'location'), '') is not null
                      and record.normalized_data->>'decision_date'
                        = record.decision_date::text
                      and record.normalized_data->>'raw_representation_sha256'
                        ~ '^[0-9a-f]{{64}}$'
                      and extraction.extraction_status = 'succeeded'
                      and extraction.extractor_name = 'judilibre_candidate_extraction'
                      and extraction.extractor_version = '3'
                      and extraction.schema_version = 'judilibre_decision_candidate_v3'
                      and extraction.output_hash = record.content_hash
                      and extraction.field_provenance->>'hash_version'
                        = 'judilibre-evidence-sha256-v1'
                      and jsonb_typeof(extraction.field_provenance->'claims') = 'object'
                      and record.normalized_data @> '{{
                        "candidate_grade": "C",
                        "review_status": "pending",
                        "training_eligible": false,
                        "personal_identity_features_allowed": false,
                        "extraction_status": "candidate_facts_extracted",
                        "ambiguous_claim_types": [],
                        "to_be_deleted": false,
                        "text_storage": "private_raw_artifact",
                        "text_available": true
                      }}'::jsonb
                      and record.normalized_data->'ambiguous_claim_types' = '[]'::jsonb
                      and {_JUDILIBRE_V3_SAFE_ALLOWLIST_SQL}
                      and jsonb_typeof(record.normalized_data->'claims') = 'array'
                      and jsonb_array_length(record.normalized_data->'claims') between 1 and 7
                      and not exists (
                        select 1
                        from jsonb_array_elements(
                          case
                            when jsonb_typeof(record.normalized_data->'claims') = 'array'
                              then record.normalized_data->'claims'
                            else '[]'::jsonb
                          end
                        ) claim
                        where jsonb_typeof(claim) <> 'object'
                          or claim->>'claim_type' not in (
                            'starting_price_eur', 'hammer_price_eur', 'procedural_event'
                          )
                          or coalesce(claim->>'claim_id', '') !~ '^[0-9a-f]{{64}}$'
                          or coalesce(claim->>'evidence_hash', '') !~ '^[0-9a-f]{{64}}$'
                          or nullif(btrim(claim->>'normalized_value'), '') is null
                          or coalesce(
                            extraction.field_provenance->'claims'
                              ->(claim->>'claim_id')->>'evidence_sha256',
                            ''
                          ) <> claim->>'evidence_hash'
                          or coalesce(
                            extraction.field_provenance->'claims'
                              ->(claim->>'claim_id')->>'raw_artifact_sha256',
                            ''
                          ) <> record.normalized_data->>'raw_representation_sha256'
                          or coalesce(
                            extraction.field_provenance->'claims'
                              ->(claim->>'claim_id')->>'hash_version',
                            ''
                          ) <> 'judilibre-evidence-sha256-v1'
                      )
                      and (
                        select count(*) = count(distinct claim->>'claim_type')
                        from jsonb_array_elements(
                          case
                            when jsonb_typeof(record.normalized_data->'claims') = 'array'
                              then record.normalized_data->'claims'
                            else '[]'::jsonb
                          end
                        ) claim
                      )
                      {cursor_clause}
                      and not exists (
                        select 1
                        from public.judicial_source_records newer
                        where newer.source_id = record.source_id
                          and newer.external_record_id = record.external_record_id
                          and newer.record_version > record.record_version
                      )
                      and not exists (
                        select 1
                        from public.source_purge_events purge
                        where purge.source_id = record.source_id
                          and (
                            purge.source_record_id = record.id
                            or purge.external_record_id = record.external_record_id
                          )
                          and purge.event_type in (
                            'deletion_requested', 'deletion_completed',
                            'redaction_requested', 'redaction_completed',
                            'retention_expired'
                          )
                      )
                    order by record.created_at, record.id
                    limit %s
                    """,
                    (*cursor_position, limit) if cursor_position is not None else (limit,),
                )
                rows = cursor.fetchall()
        return [
            StoredJudilibreDecisionRecord(
                source_record_id=str(row[0]),
                external_record_id=str(row[1]),
                decision_date=row[2],
                content_hash=str(row[3]),
                normalized_data=dict(row[4] or {}),
            )
            for row in rows
            if isinstance(row[2], date)
        ]

    def load_judilibre_court_resolutions(
        self,
        *,
        location: str,
    ) -> list[StoredJudilibreCourtResolution]:
        """Resolve a Judilibre location to a canonical Outcome court.

        Exact Outcome court codes are accepted directly. ``tj<INSEE>`` codes
        otherwise require a current, approved Ministry of Justice structure
        record and an exact normalized name/alias join to the canonical court
        catalogue. Ambiguity is returned to the service and never guessed.
        """

        cleaned_location = location.strip()
        if not cleaned_location or len(cleaned_location) > 128:
            return []
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select court_row.id, court_row.code
                    from public.outcome_courts court_row
                    where court_row.active
                      and lower(btrim(court_row.code)) = lower(btrim(%s))
                    order by court_row.id
                    limit 2
                    """,
                    (cleaned_location,),
                )
                direct_rows = cursor.fetchall()
                if direct_rows:
                    return [
                        StoredJudilibreCourtResolution(
                            court_id=str(row[0]),
                            court_code=str(row[1]),
                            resolution_method="outcome_court_code_exact",
                            reference_sha256=canonical_sha256(
                                {
                                    "schema_version": "judilibre_court_resolution_v1",
                                    "method": "outcome_court_code_exact",
                                    "court_code": str(row[1]),
                                }
                            ),
                        )
                        for row in direct_rows
                    ]

                match = re.fullmatch(
                    r"tj(?P<insee>(?:\d{5}|2[ab]\d{3}))",
                    cleaned_location,
                    flags=re.IGNORECASE,
                )
                if match is None:
                    return []
                insee_code = match.group("insee").upper()
                cursor.execute(
                    """
                    with current_justice_structures as (
                      select record.normalized_data, record.content_hash
                      from public.judicial_source_records record
                      join public.data_sources source on source.id = record.source_id
                      where source.name = 'justice_open_data'
                        and source.official
                        and source.active
                        and source.legal_review_status = 'approved'
                        and source.ingestion_policy = 'allowed_automated'
                        and record.record_kind = 'court_reference_candidate'
                        and not record.training_eligible
                        and record.normalized_data->>'schema_version'
                          = 'justice_court_structure_v1'
                        and record.normalized_data->>'structure_type_code' in ('TJ', 'TGI')
                        and upper(record.normalized_data->>'insee_code') = %s
                        and record.normalized_data @> '{
                          "training_eligible": false,
                          "review_status": "pending",
                          "source_grade": "A"
                        }'::jsonb
                        and not exists (
                          select 1
                          from public.judicial_source_records newer
                          where newer.source_id = record.source_id
                            and newer.external_record_id = record.external_record_id
                            and newer.record_version > record.record_version
                        )
                        and not exists (
                          select 1
                          from public.source_purge_events purge
                          where purge.source_id = record.source_id
                            and (
                              purge.source_record_id = record.id
                              or purge.external_record_id = record.external_record_id
                            )
                            and purge.event_type in (
                              'deletion_requested', 'deletion_completed',
                              'redaction_requested', 'redaction_completed',
                              'retention_expired'
                            )
                        )
                    ), resolved as (
                      select distinct
                        court_row.id,
                        court_row.code,
                        justice_record.content_hash
                      from current_justice_structures justice_record
                      join public.outcome_courts court_row on (
                        court_row.active
                        and btrim(regexp_replace(
                          extensions.unaccent(lower(court_row.name)),
                          '[^a-z0-9]+', ' ', 'g'
                        )) = btrim(regexp_replace(
                          extensions.unaccent(lower(justice_record.normalized_data->>'name')),
                          '[^a-z0-9]+', ' ', 'g'
                        ))
                      )
                      union
                      select distinct
                        court_row.id,
                        court_row.code,
                        justice_record.content_hash
                      from current_justice_structures justice_record
                      join public.tribunals tribunal_row on (
                        btrim(regexp_replace(
                          extensions.unaccent(lower(tribunal_row.canonical_name)),
                          '[^a-z0-9]+', ' ', 'g'
                        )) = btrim(regexp_replace(
                          extensions.unaccent(lower(justice_record.normalized_data->>'name')),
                          '[^a-z0-9]+', ' ', 'g'
                        ))
                        or exists (
                          select 1
                          from jsonb_array_elements_text(
                            case
                              when jsonb_typeof(tribunal_row.aliases) = 'array'
                                then tribunal_row.aliases
                              else '[]'::jsonb
                            end
                          ) alias(value)
                          where btrim(regexp_replace(
                            extensions.unaccent(lower(alias.value)),
                            '[^a-z0-9]+', ' ', 'g'
                          )) = btrim(regexp_replace(
                            extensions.unaccent(lower(justice_record.normalized_data->>'name')),
                            '[^a-z0-9]+', ' ', 'g'
                          ))
                        )
                      )
                      join public.outcome_courts court_row
                        on court_row.code = tribunal_row.code
                       and court_row.active
                    )
                    select id, code, content_hash
                    from resolved
                    order by id
                    limit 2
                    """,
                    (insee_code,),
                )
                rows = cursor.fetchall()
        return [
            StoredJudilibreCourtResolution(
                court_id=str(row[0]),
                court_code=str(row[1]),
                resolution_method="justice_structure_insee_exact_name",
                reference_sha256=str(row[2]),
            )
            for row in rows
        ]

    def load_judilibre_auction_match_contexts(
        self,
        *,
        court_id: str,
        decision_date: date,
        case_references: tuple[str, ...],
        max_date_delta_days: int,
        limit: int,
    ) -> list[StoredJudilibreAuctionMatchContext]:
        if not court_id.strip():
            raise ValueError("Judilibre court id is required")
        if max_date_delta_days < 0 or max_date_delta_days > 30:
            raise ValueError("Judilibre date delta must be between 0 and 30 days")
        if limit < 1 or limit > 5_001:
            raise ValueError("Judilibre context query limit must be between 1 and 5001")
        normalized_references = tuple(
            dict.fromkeys(
                normalized
                for value in case_references
                if (normalized := _normalize_match_reference(value)) is not None
            )
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select
                      case_row.id,
                      lot.id,
                      round_row.id,
                      round_row.court_id,
                      (
                        round_row.scheduled_at
                        at time zone round_row.local_timezone
                      )::date as scheduled_date,
                      abs((
                        round_row.scheduled_at
                        at time zone round_row.local_timezone
                      )::date - %s::date) as date_delta_days,
                      case
                        when cardinality(%s::text[]) = 0 then false
                        else regexp_replace(
                          lower(btrim(coalesce(case_row.court_case_number, ''))),
                          '\\s+', ' ', 'g'
                        ) = any(%s::text[])
                      end as case_number_match,
                      case
                        when cardinality(%s::text[]) = 0 then false
                        else regexp_replace(
                          lower(btrim(coalesce(case_row.portalis_number, ''))),
                          '\\s+', ' ', 'g'
                        ) = any(%s::text[])
                      end as portalis_number_match
                    from public.auction_rounds round_row
                    join public.auction_lots lot on lot.id = round_row.lot_id
                    join public.auction_cases case_row
                      on case_row.id = lot.auction_case_id
                    join public.outcome_courts court_row
                      on court_row.id = round_row.court_id
                    where lot.active
                      and court_row.active
                      and round_row.court_id = %s
                      and case_row.court_id = %s
                      and round_row.scheduled_at is not null
                      and (
                        round_row.scheduled_at
                        at time zone round_row.local_timezone
                      )::date between %s::date - %s and %s::date + %s
                    order by
                      case
                        when cardinality(%s::text[]) > 0 and regexp_replace(
                          lower(btrim(coalesce(case_row.portalis_number, ''))),
                          '\\s+', ' ', 'g'
                        ) = any(%s::text[]) then 0
                        when cardinality(%s::text[]) > 0 and regexp_replace(
                          lower(btrim(coalesce(case_row.court_case_number, ''))),
                          '\\s+', ' ', 'g'
                        ) = any(%s::text[]) then 1
                        else 2
                      end,
                      abs((
                        round_row.scheduled_at
                        at time zone round_row.local_timezone
                      )::date - %s::date),
                      case_row.id,
                      lot.id,
                      round_row.id
                    limit %s
                    """,
                    (
                        decision_date,
                        list(normalized_references),
                        list(normalized_references),
                        list(normalized_references),
                        list(normalized_references),
                        court_id,
                        court_id,
                        decision_date,
                        max_date_delta_days,
                        decision_date,
                        max_date_delta_days,
                        list(normalized_references),
                        list(normalized_references),
                        list(normalized_references),
                        list(normalized_references),
                        decision_date,
                        limit,
                    ),
                )
                rows = cursor.fetchall()
        return [
            StoredJudilibreAuctionMatchContext(
                case_id=str(row[0]),
                lot_id=str(row[1]),
                round_id=str(row[2]),
                court_id=str(row[3]),
                scheduled_date=row[4],
                date_delta_days=int(row[5]),
                case_number_match=bool(row[6]),
                portalis_number_match=bool(row[7]),
            )
            for row in rows
            if isinstance(row[4], date)
        ]

    def has_active_outcome_lots(self) -> bool:
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select exists (
                      select 1 from public.auction_lots where active limit 1
                    )
                    """,
                )
                row = cursor.fetchone()
        return bool(row and row[0])

    def require_dvf_matching_schema(self) -> None:
        required_tables = (
            "public.judicial_source_records",
            "public.source_record_matches",
            "public.auction_lots",
            "public.auction_rounds",
            "public.auction_sales",
            "public.auction_cadastre_parcels",
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select
                      to_regclass('public.judicial_source_records'),
                      to_regclass('public.source_record_matches'),
                      to_regclass('public.auction_lots'),
                      to_regclass('public.auction_rounds'),
                      to_regclass('public.auction_sales'),
                      to_regclass('public.auction_cadastre_parcels')
                    """,
                )
                row = cursor.fetchone()
        missing = [
            table
            for index, table in enumerate(required_tables)
            if row is None or row[index] is None
        ]
        if missing:
            raise OutcomeIngestionError(
                "DVF matching schema is incomplete; apply versioned migrations for: "
                + ", ".join(missing)
            )

    def load_dvf_auction_match_contexts(
        self,
        *,
        sale_date: date,
        parcel_ids: tuple[str, ...],
        address: str | None,
        insee_code: str | None,
        postal_code: str | None,
        city: str | None,
        limit: int,
    ) -> list[StoredAuctionLotMatchContext]:
        if limit < 1:
            raise ValueError("DVF lot-context limit must be positive")
        normalized_parcels = tuple(
            normalized
            for parcel_id in parcel_ids
            if (normalized := re.sub(r"[^A-Z0-9]+", "", parcel_id.upper()))
        )
        candidate_address = address.strip() if address and address.strip() else None
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select
                      lot.auction_case_id,
                      lot.id,
                      round_row.id,
                      coalesce(
                        (
                          round_row.scheduled_at
                          at time zone round_row.local_timezone
                        )::date,
                        (sale.sale_date at time zone 'Europe/Paris')::date
                      ) as scheduled_date,
                      case
                        when round_row.scheduled_at is not null then 'auction_round'
                        when sale.sale_date is not null then 'auction_sale'
                        else null
                      end as scheduled_date_source,
                      coalesce(
                        array_agg(
                          distinct coalesce(
                            nullif(cadastre.parcel_id, ''),
                            nullif(cadastre.parcel_key, '')
                          )
                        ) filter (
                          where coalesce(
                            nullif(cadastre.parcel_id, ''),
                            nullif(cadastre.parcel_key, '')
                          ) is not null
                        ),
                        '{}'::text[]
                      ) as parcel_ids,
                      coalesce(
                        nullif(address.label, ''),
                        nullif(address.street, ''),
                        nullif(sale.address, '')
                      ) as address,
                      coalesce(nullif(address.city, ''), nullif(sale.city, '')) as city,
                      coalesce(
                        nullif(address.postal_code, ''),
                        nullif(sale.postal_code, '')
                      ) as postal_code,
                      coalesce(
                        nullif(address.insee_code, ''),
                        nullif(max(cadastre.code_insee), '')
                      ) as insee_code
                    from public.auction_lots lot
                    join public.auction_cases case_row on case_row.id = lot.auction_case_id
                    left join public.auction_sales sale on sale.id = lot.auction_sale_id
                    left join public.outcome_addresses address on address.id = lot.address_id
                    left join lateral (
                      select
                        candidate_round.id,
                        candidate_round.scheduled_at,
                        candidate_round.local_timezone
                      from public.auction_rounds candidate_round
                      where candidate_round.lot_id = lot.id
                      order by
                        abs(
                          (
                            candidate_round.scheduled_at
                            at time zone candidate_round.local_timezone
                          )::date - %s::date
                        ) nulls last,
                        candidate_round.sequence_number desc
                      limit 1
                    ) round_row on true
                    left join public.auction_cadastre_parcels cadastre
                      on cadastre.source_url = sale.source_url
                    where lot.active
                      and (
                        (
                          cardinality(%s::text[]) > 0
                          and exists (
                            select 1
                            from public.auction_cadastre_parcels candidate_parcel
                            where candidate_parcel.source_url = sale.source_url
                              and regexp_replace(
                                upper(
                                  coalesce(
                                    nullif(candidate_parcel.parcel_id, ''),
                                    nullif(candidate_parcel.parcel_key, '')
                                  )
                                ),
                                '[^A-Z0-9]',
                                '',
                                'g'
                              ) = any(%s::text[])
                          )
                        )
                        or (
                          coalesce(
                            (
                              round_row.scheduled_at
                              at time zone round_row.local_timezone
                            )::date,
                            (sale.sale_date at time zone 'Europe/Paris')::date
                          )
                            between %s::date - 30 and %s::date + 30
                          and (
                            (
                              %s::text is not null
                              and btrim(
                                regexp_replace(
                                  extensions.unaccent(
                                    lower(
                                      coalesce(
                                        nullif(address.label, ''),
                                        nullif(address.street, ''),
                                        nullif(sale.address, '')
                                      )
                                    )
                                  ),
                                  '[^a-z0-9]+',
                                  ' ',
                                  'g'
                                )
                              ) = btrim(
                                regexp_replace(
                                  extensions.unaccent(lower(%s::text)),
                                  '[^a-z0-9]+',
                                  ' ',
                                  'g'
                                )
                              )
                            )
                            or (
                              %s::text is not null
                              and (
                                address.insee_code = %s
                                or exists (
                                  select 1
                                  from public.auction_cadastre_parcels insee_parcel
                                  where insee_parcel.source_url = sale.source_url
                                    and insee_parcel.code_insee = %s
                                )
                              )
                            )
                            or (
                              %s::text is not null
                              and coalesce(address.postal_code, sale.postal_code) = %s
                            )
                            or (
                              %s::text is not null
                              and lower(coalesce(address.city, sale.city)) = lower(%s::text)
                            )
                          )
                        )
                      )
                    group by
                      lot.auction_case_id,
                      lot.id,
                      round_row.id,
                      round_row.scheduled_at,
                      round_row.local_timezone,
                      sale.sale_date,
                      sale.source_url,
                      address.label,
                      address.street,
                      sale.address,
                      address.city,
                      sale.city,
                      address.postal_code,
                      sale.postal_code,
                      address.insee_code
                    order by
                      case
                        when cardinality(%s::text[]) > 0 and exists (
                          select 1
                          from public.auction_cadastre_parcels ranked_parcel
                          where ranked_parcel.source_url = sale.source_url
                            and regexp_replace(
                              upper(
                                coalesce(
                                  nullif(ranked_parcel.parcel_id, ''),
                                  nullif(ranked_parcel.parcel_key, '')
                                )
                              ),
                              '[^A-Z0-9]',
                              '',
                              'g'
                            ) = any(%s::text[])
                        ) then 0
                        else 1
                      end,
                      case
                        when %s::text is not null
                          and btrim(
                            regexp_replace(
                              extensions.unaccent(
                                lower(
                                  coalesce(
                                    nullif(address.label, ''),
                                    nullif(address.street, ''),
                                    nullif(sale.address, '')
                                  )
                                )
                              ),
                              '[^a-z0-9]+',
                              ' ',
                              'g'
                            )
                          ) = btrim(
                            regexp_replace(
                              extensions.unaccent(lower(%s::text)),
                              '[^a-z0-9]+',
                              ' ',
                              'g'
                            )
                          ) then 0
                        else 1
                      end,
                      abs(
                        coalesce(
                          (
                            round_row.scheduled_at
                            at time zone round_row.local_timezone
                          )::date,
                          (sale.sale_date at time zone 'Europe/Paris')::date
                        ) - %s::date
                      ) nulls last,
                      lot.id,
                      round_row.id
                    limit %s
                    """,
                    (
                        sale_date,
                        list(normalized_parcels),
                        list(normalized_parcels),
                        sale_date,
                        sale_date,
                        candidate_address,
                        candidate_address,
                        insee_code,
                        insee_code,
                        insee_code,
                        postal_code,
                        postal_code,
                        city,
                        city,
                        list(normalized_parcels),
                        list(normalized_parcels),
                        candidate_address,
                        candidate_address,
                        sale_date,
                        limit,
                    ),
                )
                rows = cursor.fetchall()
        return [
            StoredAuctionLotMatchContext(
                case_id=str(row[0]),
                lot_id=str(row[1]),
                round_id=str(row[2]) if row[2] is not None else None,
                scheduled_at=row[3] if isinstance(row[3], (date, datetime)) else None,
                scheduled_date_source=str(row[4]) if row[4] is not None else None,
                parcel_ids=tuple(
                    str(value)
                    for value in (row[5] or ())
                    if value is not None and str(value).strip()
                ),
                address=str(row[6]) if row[6] is not None else None,
                city=str(row[7]) if row[7] is not None else None,
                postal_code=str(row[8]) if row[8] is not None else None,
                insee_code=str(row[9]) if row[9] is not None else None,
            )
            for row in rows
        ]

    def find_current_source_record_match(
        self,
        *,
        source_record_id: str,
        lot_id: str,
        round_id: str | None,
    ) -> str | None:
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select match_row.id
                    from public.source_record_matches match_row
                    where match_row.source_record_id = %s
                      and match_row.lot_id = %s
                      and match_row.round_id is not distinct from %s
                      and not exists (
                        select 1
                        from public.source_record_matches successor
                        where successor.supersedes_match_id = match_row.id
                      )
                    order by match_row.created_at desc, match_row.id desc
                    limit 1
                    """,
                    (source_record_id, lot_id, round_id),
                )
                row = cursor.fetchone()
        return str(row[0]) if row is not None else None


def request_fingerprint(
    method: str | None,
    url: str,
    parameters: Mapping[str, object] | None = None,
) -> str:
    payload = json.dumps(
        {
            "method": (method or "LOCAL_FILE").upper(),
            "url": _url_without_query(url),
            "parameters": dict(parameters or {}),
        },
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _match_target_lock_key(
    *,
    source_record_id: str,
    case_id: str | None,
    lot_id: str | None,
    round_id: str | None,
    outcome_id: str | None,
) -> int:
    payload = "\x1f".join(
        value or ""
        for value in (
            source_record_id,
            case_id,
            lot_id,
            round_id,
            outcome_id,
        )
    ).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big", signed=True)


def _normalize_match_reference(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"\s+", " ", value.strip()).lower()
    if not normalized or len(normalized) > 128 or any(
        character in normalized for character in ("\x00", "\r", "\n")
    ):
        return None
    return normalized


def _judilibre_projection_references(
    normalized_data: Mapping[str, object],
) -> tuple[str, ...]:
    number = normalized_data.get("number")
    numbers = normalized_data.get("numbers")
    if number is not None and not isinstance(number, str):
        raise OutcomeIngestionError("Judilibre source number has an invalid type")
    if numbers is not None and not isinstance(numbers, list):
        raise OutcomeIngestionError("Judilibre source numbers has an invalid type")
    if isinstance(numbers, list) and any(not isinstance(value, str) for value in numbers):
        raise OutcomeIngestionError("Judilibre source numbers contains a non-text value")
    values: list[object] = [number] if number is not None else []
    values.extend(numbers or [])
    references: list[str] = []
    for value in values:
        normalized = _normalize_match_reference(value)
        if normalized is not None and normalized not in references:
            references.append(normalized)
    return tuple(references)


def _load_current_judilibre_court_resolutions(
    cursor: Any,
    *,
    location: object,
) -> list[StoredJudilibreCourtResolution]:
    """Resolve a court on the caller's already locked transaction snapshot."""

    if not isinstance(location, str):
        return []
    cleaned_location = location.strip()
    if not cleaned_location or len(cleaned_location) > 128:
        return []
    cursor.execute(
        """
        select court_row.id, court_row.code
        from public.outcome_courts court_row
        where court_row.active
          and lower(btrim(court_row.code)) = lower(btrim(%s))
        order by court_row.id
        limit 2
        """,
        (cleaned_location,),
    )
    direct_rows = cursor.fetchall()
    if direct_rows:
        return [
            StoredJudilibreCourtResolution(
                court_id=str(row[0]),
                court_code=str(row[1]),
                resolution_method="outcome_court_code_exact",
                reference_sha256=canonical_sha256(
                    {
                        "schema_version": "judilibre_court_resolution_v1",
                        "method": "outcome_court_code_exact",
                        "court_code": str(row[1]),
                    }
                ),
            )
            for row in direct_rows
        ]

    match = re.fullmatch(
        r"tj(?P<insee>(?:\d{5}|2[ab]\d{3}))",
        cleaned_location,
        flags=re.IGNORECASE,
    )
    if match is None:
        return []
    cursor.execute(
        """
        with current_justice_structures as (
          select record.normalized_data, record.content_hash
          from public.judicial_source_records record
          join public.data_sources source on source.id = record.source_id
          where source.name = 'justice_open_data'
            and source.official
            and source.active
            and source.legal_review_status = 'approved'
            and source.ingestion_policy = 'allowed_automated'
            and record.record_kind = 'court_reference_candidate'
            and not record.training_eligible
            and record.normalized_data->>'schema_version'
              = 'justice_court_structure_v1'
            and record.normalized_data->>'structure_type_code' in ('TJ', 'TGI')
            and upper(record.normalized_data->>'insee_code') = %s
            and record.normalized_data @> '{
              "training_eligible": false,
              "review_status": "pending",
              "source_grade": "A"
            }'::jsonb
            and not exists (
              select 1
              from public.judicial_source_records newer
              where newer.source_id = record.source_id
                and newer.external_record_id = record.external_record_id
                and newer.record_version > record.record_version
            )
            and not exists (
              select 1
              from public.source_purge_events purge
              where purge.source_id = record.source_id
                and (
                  purge.source_record_id = record.id
                  or purge.external_record_id = record.external_record_id
                )
                and purge.event_type in (
                  'deletion_requested', 'deletion_completed',
                  'redaction_requested', 'redaction_completed',
                  'retention_expired'
                )
            )
        ), resolved as (
          select distinct
            court_row.id,
            court_row.code,
            justice_record.content_hash
          from current_justice_structures justice_record
          join public.outcome_courts court_row on (
            court_row.active
            and btrim(regexp_replace(
              extensions.unaccent(lower(court_row.name)),
              '[^a-z0-9]+', ' ', 'g'
            )) = btrim(regexp_replace(
              extensions.unaccent(lower(justice_record.normalized_data->>'name')),
              '[^a-z0-9]+', ' ', 'g'
            ))
          )
          union
          select distinct
            court_row.id,
            court_row.code,
            justice_record.content_hash
          from current_justice_structures justice_record
          join public.tribunals tribunal_row on (
            btrim(regexp_replace(
              extensions.unaccent(lower(tribunal_row.canonical_name)),
              '[^a-z0-9]+', ' ', 'g'
            )) = btrim(regexp_replace(
              extensions.unaccent(lower(justice_record.normalized_data->>'name')),
              '[^a-z0-9]+', ' ', 'g'
            ))
            or exists (
              select 1
              from jsonb_array_elements_text(
                case
                  when jsonb_typeof(tribunal_row.aliases) = 'array'
                    then tribunal_row.aliases
                  else '[]'::jsonb
                end
              ) alias(value)
              where btrim(regexp_replace(
                extensions.unaccent(lower(alias.value)),
                '[^a-z0-9]+', ' ', 'g'
              )) = btrim(regexp_replace(
                extensions.unaccent(lower(justice_record.normalized_data->>'name')),
                '[^a-z0-9]+', ' ', 'g'
              ))
            )
          )
          join public.outcome_courts court_row
            on court_row.code = tribunal_row.code
           and court_row.active
        )
        select id, code, content_hash
        from resolved
        order by id
        limit 2
        """,
        (match.group("insee").upper(),),
    )
    rows = cursor.fetchall()
    return [
        StoredJudilibreCourtResolution(
            court_id=str(row[0]),
            court_code=str(row[1]),
            resolution_method="justice_structure_insee_exact_name",
            reference_sha256=str(row[2]),
        )
        for row in rows
    ]


def _validate_judilibre_match_signals(
    signals: Mapping[str, object],
    *,
    expected_source_content_hash: str,
    match_method: str,
) -> None:
    required_keys = {
        "schema_version",
        "match_rule_version",
        "court",
        "court_resolution_method",
        "court_resolution_reference_sha256",
        "hearing_date",
        "hearing_date_exact",
        "hearing_date_delta_days",
        "case_number",
        "portalis_number",
        "claim_types",
        "claims_manifest_sha256",
        "case_reference_manifest_sha256",
        "source_projection_sha256",
        "target_context_sha256",
        "source_record_version_current_at_scan",
        "source_training_eligible",
        "selection_requires_human_review",
        "automatic_link_allowed",
        "outcome_creation_allowed",
        "training_eligible",
        "claim_value_used_for_matching",
        "price_used_for_matching",
        "text_used_for_matching",
        "address_used_for_matching",
        "personal_identity_used_for_matching",
        "source_record_sha256",
    }
    if set(signals) != required_keys:
        raise ValueError("Judilibre match signals do not match the reviewed schema")
    if signals.get("schema_version") != "judilibre_match_signals_v1":
        raise ValueError("Judilibre match signal schema is unsupported")
    if signals.get("match_rule_version") != "judilibre-review-match-v1":
        raise ValueError("Judilibre match rule version is unsupported")
    if signals.get("court_resolution_method") not in {
        "outcome_court_code_exact",
        "justice_structure_insee_exact_name",
    }:
        raise ValueError("Judilibre court resolution is not objective")
    true_flags = {
        "court",
        "hearing_date",
        "source_record_version_current_at_scan",
        "selection_requires_human_review",
    }
    false_flags = {
        "source_training_eligible",
        "automatic_link_allowed",
        "outcome_creation_allowed",
        "training_eligible",
        "claim_value_used_for_matching",
        "price_used_for_matching",
        "text_used_for_matching",
        "address_used_for_matching",
        "personal_identity_used_for_matching",
    }
    if any(signals.get(key) is not True for key in true_flags) or any(
        signals.get(key) is not False for key in false_flags
    ):
        raise ValueError("Judilibre match safety flags are invalid")
    for key in ("hearing_date_exact", "case_number", "portalis_number"):
        if type(signals.get(key)) is not bool:
            raise ValueError("Judilibre objective signal flags must be booleans")
    date_delta = signals.get("hearing_date_delta_days")
    if type(date_delta) is not int or not 0 <= date_delta <= 30:
        raise ValueError("Judilibre hearing date delta is invalid")
    claim_types = signals.get("claim_types")
    if (
        not isinstance(claim_types, list)
        or not claim_types
        or len(claim_types) != len(set(claim_types))
        or any(
            claim_type
            not in {"starting_price_eur", "hammer_price_eur", "procedural_event"}
            for claim_type in claim_types
        )
    ):
        raise ValueError("Judilibre claim types are invalid")
    for key in (
        "court_resolution_reference_sha256",
        "claims_manifest_sha256",
        "case_reference_manifest_sha256",
        "source_projection_sha256",
        "target_context_sha256",
        "source_record_sha256",
    ):
        if not isinstance(signals.get(key), str) or re.fullmatch(
            r"[0-9a-f]{64}", str(signals.get(key))
        ) is None:
            raise ValueError("Judilibre match provenance must contain SHA-256 only")
    if signals.get("source_projection_sha256") != expected_source_content_hash:
        raise ValueError("Judilibre source projection provenance is inconsistent")
    if match_method == "exact_portalis_number" and signals.get("portalis_number") is not True:
        raise ValueError("Judilibre Portalis match method lacks its exact signal")
    if match_method == "exact_case_number" and signals.get("case_number") is not True:
        raise ValueError("Judilibre case-number match method lacks its exact signal")
    if match_method == "composite" and not (
        signals.get("hearing_date_exact") is True
        and signals.get("case_number") is False
        and signals.get("portalis_number") is False
    ):
        raise ValueError("Judilibre composite match must be a unique exact court/date candidate")


def _load_source_policy(cursor: Any, source_name: str) -> SourcePolicy:
    cursor.execute(
        """
        select id, name, official, legal_review_status, ingestion_policy, active
        from public.data_sources
        where name = %s
        for share
        """,
        (source_name,),
    )
    row = cursor.fetchone()
    if row is None:
        raise SourcePolicyError(f"source is not registered: {source_name}")
    return SourcePolicy(
        id=str(row[0]),
        name=str(row[1]),
        official=bool(row[2]),
        legal_review_status=str(row[3]),
        ingestion_policy=str(row[4]),
        active=bool(row[5]),
    )


def _insert_or_get_raw_artifact(cursor: Any, policy: SourcePolicy, capture: SuccessfulCapture) -> str:
    artifact = capture.stored_artifact
    cursor.execute(
        """
        insert into public.raw_artifacts (
          source_id, external_record_id, canonical_url, storage_object_path,
          mime_type, byte_size, content_hash, published_at, captured_at,
          connector_version, metadata
        ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        on conflict (source_id, content_hash) do nothing
        returning id
        """,
        (
            policy.id,
            capture.external_record_id,
            capture.canonical_url,
            artifact.object_path,
            artifact.mime_type,
            artifact.byte_size,
            artifact.content_hash,
            capture.published_at,
            capture.completed_at,
            capture.connector_version,
            Jsonb(dict(capture.metadata or {}) | {"storage_bucket": artifact.bucket}),
        ),
    )
    row = cursor.fetchone()
    if row is not None:
        return str(row[0])
    cursor.execute(
        "select id from public.raw_artifacts where source_id = %s and content_hash = %s",
        (policy.id, artifact.content_hash),
    )
    row = cursor.fetchone()
    if row is None:
        raise OutcomeIngestionError("raw artifact persistence failed")
    return str(row[0])


def _insert_source_fetch(cursor: Any, policy: SourcePolicy, capture: SuccessfulCapture, artifact_id: str) -> str:
    fetch_status = "succeeded" if capture.capture_transport == "http" else "imported_local"
    cursor.execute(
        """
        insert into public.source_fetches (
          source_id, raw_artifact_id, fetch_status, capture_transport, http_method, requested_url,
          request_fingerprint, http_status, etag, last_modified_at, content_hash,
          byte_size, mime_type, source_cursor, connector_version, started_at, completed_at
        ) values (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s, %s
        ) returning id
        """,
        (
            policy.id,
            artifact_id,
            fetch_status,
            capture.capture_transport,
            capture.request_method.upper() if capture.request_method else None,
            _url_without_query(capture.requested_url),
            request_fingerprint(capture.request_method, capture.requested_url, capture.request_parameters),
            capture.http_status,
            capture.etag,
            capture.last_modified_at,
            capture.stored_artifact.content_hash,
            capture.stored_artifact.byte_size,
            capture.stored_artifact.mime_type,
            Jsonb(dict(capture.source_cursor or {})),
            capture.connector_version,
            capture.started_at,
            capture.completed_at,
        ),
    )
    row = cursor.fetchone()
    if row is None:
        raise OutcomeIngestionError("source fetch persistence failed")
    return str(row[0])


def _insert_or_get_extraction(
    cursor: Any,
    *,
    raw_artifact_id: str,
    source_fetch_id: str,
    projection: SourceRecordProjection,
    normalized_data: dict[str, object],
    output_hash: str,
) -> str:
    field_provenance = dict(projection.field_provenance)
    cursor.execute(
        """
        insert into public.artifact_extractions (
          raw_artifact_id, source_fetch_id, extractor_name, extractor_version,
          schema_version, run_number, extraction_status, extracted_data,
          field_provenance, output_hash, quality_score
        ) values (%s, %s, %s, %s, %s, 1, 'succeeded', %s, %s, %s, %s)
        on conflict (raw_artifact_id, extractor_name, extractor_version, schema_version, run_number)
        do nothing
        returning id
        """,
        (
            raw_artifact_id,
            source_fetch_id,
            projection.extractor_name,
            projection.extractor_version,
            projection.schema_version,
            Jsonb(normalized_data),
            Jsonb(field_provenance),
            output_hash,
            projection.quality_score,
        ),
    )
    row = cursor.fetchone()
    if row is not None:
        return str(row[0])
    cursor.execute(
        """
        select id, output_hash, field_provenance from public.artifact_extractions
        where raw_artifact_id = %s and extractor_name = %s
          and extractor_version = %s and schema_version = %s and run_number = 1
        """,
        (
            raw_artifact_id,
            projection.extractor_name,
            projection.extractor_version,
            projection.schema_version,
        ),
    )
    row = cursor.fetchone()
    if row is None:
        raise OutcomeIngestionError("artifact extraction persistence failed")
    if str(row[1]) != output_hash:
        raise OutcomeIngestionError(
            "artifact extraction is non-deterministic for the same artifact and extractor version"
        )
    if canonical_sha256(row[2] or {}) != canonical_sha256(field_provenance):
        raise OutcomeIngestionError(
            "artifact extraction provenance is non-deterministic for the same artifact and extractor version"
        )
    return str(row[0])


def _insert_or_get_source_record(
    cursor: Any,
    *,
    policy: SourcePolicy,
    capture: SuccessfulCapture,
    projection: SourceRecordProjection,
    normalized_data: dict[str, object],
    normalized_hash: str,
    raw_artifact_id: str,
    source_fetch_id: str,
    extraction_id: str,
) -> tuple[str, int, bool]:
    cursor.execute(
        """
        select id, record_version, content_hash
        from public.judicial_source_records
        where source_id = %s and external_record_id = %s
        order by record_version desc
        limit 1
        for update
        """,
        (policy.id, capture.external_record_id),
    )
    prior = cursor.fetchone()
    if prior is not None and str(prior[2]) == normalized_hash:
        return str(prior[0]), int(prior[1]), False
    version = int(prior[1]) + 1 if prior is not None else 1
    supersedes = str(prior[0]) if prior is not None else None
    cursor.execute(
        """
        insert into public.judicial_source_records (
          source_id, source_fetch_id, raw_artifact_id, artifact_extraction_id,
          record_kind, external_record_id, record_version, decision_date,
          source_updated_at, published_at, canonical_url, normalized_data,
          content_hash, connector_version, training_eligible,
          training_eligibility_reason, supersedes_record_id
        ) values (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, false, 'requires_canonical_match_and_review', %s
        ) returning id
        """,
        (
            policy.id,
            source_fetch_id,
            raw_artifact_id,
            extraction_id,
            projection.record_kind,
            capture.external_record_id,
            version,
            projection.decision_date,
            projection.source_updated_at,
            capture.published_at,
            capture.canonical_url,
            Jsonb(normalized_data),
            normalized_hash,
            capture.connector_version,
            supersedes,
        ),
    )
    row = cursor.fetchone()
    if row is None:
        raise OutcomeIngestionError("source record persistence failed")
    return str(row[0]), version, True


def _validate_capture(capture: SuccessfulCapture) -> None:
    if capture.completed_at < capture.started_at:
        raise ValueError("capture completion must not precede its start")
    if capture.capture_transport == "http":
        if capture.http_status is None or capture.http_status < 200 or capture.http_status >= 300:
            raise ValueError("a successful HTTP capture requires a 2xx status")
        if not capture.request_method or capture.request_method.upper() not in {"GET", "HEAD", "POST"}:
            raise ValueError("unsupported capture request method")
    elif capture.capture_transport == "local_file":
        if capture.http_status is not None or capture.request_method is not None:
            raise ValueError("a local-file import must not claim HTTP metadata")
    else:
        raise ValueError("unsupported capture transport")
    if not re.fullmatch(r"[0-9a-f]{64}", capture.stored_artifact.content_hash):
        raise ValueError("stored artifact hash must be SHA-256")


def _url_without_query(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
