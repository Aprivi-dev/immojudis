from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime

from src.official_sources.base import canonical_json
from src.outcome_ingestion.artifact_store import SupabaseRawArtifactStore
from src.outcome_ingestion.repository import (
    CaptureTransport,
    IngestionChannel,
    OutcomeIngestionRepository,
    PersistedSourceRecord,
    SourceRecordProjection,
    SuccessfulCapture,
)


@dataclass(frozen=True)
class JsonSourceRecord:
    source_name: str
    external_record_id: str
    requested_url: str
    canonical_url: str | None
    record_kind: str
    raw_payload: Mapping[str, object]
    normalized_data: Mapping[str, object]
    connector_version: str
    extractor_name: str
    extractor_version: str
    schema_version: str
    field_provenance: Mapping[str, object] = field(default_factory=dict)
    decision_date: date | None = None
    source_updated_at: datetime | None = None
    published_at: datetime | None = None
    capture_transport: CaptureTransport = "http"
    http_status: int | None = 200
    request_method: str | None = "GET"
    request_parameters: Mapping[str, object] | None = None
    source_cursor: Mapping[str, object] | None = None


class OutcomeSourceIngestionService:
    def __init__(
        self,
        *,
        repository: OutcomeIngestionRepository,
        artifact_store: SupabaseRawArtifactStore,
    ) -> None:
        self.repository = repository
        self.artifact_store = artifact_store

    def ingest_json_record(
        self,
        record: JsonSourceRecord,
        *,
        channel: IngestionChannel,
        captured_at: datetime | None = None,
    ) -> PersistedSourceRecord:
        # The DB policy is checked before any Storage write, then rechecked in
        # the metadata transaction to close policy-change races.
        self.repository.require_source_policy(record.source_name, channel)
        started_at = captured_at or datetime.now(UTC)
        raw_bytes = canonical_json(dict(record.raw_payload))
        stored = self.artifact_store.put_bytes(
            source_name=record.source_name,
            external_record_id=record.external_record_id,
            payload=raw_bytes,
            mime_type="application/json",
        )
        completed_at = datetime.now(UTC)
        return self.repository.persist_successful_record(
            source_name=record.source_name,
            channel=channel,
            capture=SuccessfulCapture(
                requested_url=record.requested_url,
                external_record_id=record.external_record_id,
                canonical_url=record.canonical_url,
                stored_artifact=stored,
                connector_version=record.connector_version,
                started_at=started_at,
                completed_at=completed_at,
                published_at=record.published_at,
                capture_transport=record.capture_transport,
                http_status=record.http_status,
                request_method=record.request_method,
                source_cursor=record.source_cursor,
                request_parameters=record.request_parameters,
            ),
            projection=SourceRecordProjection(
                record_kind=record.record_kind,
                normalized_data=record.normalized_data,
                extractor_name=record.extractor_name,
                extractor_version=record.extractor_version,
                schema_version=record.schema_version,
                field_provenance=record.field_provenance,
                decision_date=record.decision_date,
                source_updated_at=record.source_updated_at,
            ),
        )
