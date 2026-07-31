from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
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
    cursor.execute(
        """
        insert into public.artifact_extractions (
          raw_artifact_id, source_fetch_id, extractor_name, extractor_version,
          schema_version, run_number, extraction_status, extracted_data,
          field_provenance, output_hash, quality_score
        ) values (%s, %s, %s, %s, %s, 1, 'succeeded', %s, '{}'::jsonb, %s, %s)
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
            output_hash,
            projection.quality_score,
        ),
    )
    row = cursor.fetchone()
    if row is not None:
        return str(row[0])
    cursor.execute(
        """
        select id from public.artifact_extractions
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
