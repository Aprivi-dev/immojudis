from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

try:
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - parser-only installations.
    Jsonb = None

from src.official_sources.base import canonical_sha256
from src.outcome_ingestion.artifact_store import (
    RawArtifactStorageError,
    SupabaseRawArtifactStore,
)
from src.storage.supabase_client import _postgres_connect

PURGE_WORKER_VERSION = "outcome-retention/1"


class OutcomeRetentionError(RuntimeError):
    """Log-safe failure raised by the private Outcome retention worker."""


@dataclass(frozen=True)
class ClaimedPurgeJob:
    id: str
    source_id: str
    lease_token: str
    purge_event_id: str
    attempts: int
    max_attempts: int


@dataclass(frozen=True)
class PurgeTarget:
    request_event_id: str
    latest_event_id: str
    latest_event_type: str
    external_record_id: str | None
    raw_artifact_id: str | None
    source_record_id: str | None
    object_paths: tuple[str, ...]

    @property
    def already_completed(self) -> bool:
        return self.latest_event_type in {"deletion_completed", "redaction_completed"}


@dataclass
class RetentionRunSummary:
    retention_jobs_enqueued: int = 0
    jobs_claimed: int = 0
    jobs_succeeded: int = 0
    jobs_failed: int = 0
    purge_objects_requested: int = 0
    orphan_objects_deleted: int = 0


class OutcomeRetentionRepository:
    def __init__(self, db_url: str, *, connect: Any = _postgres_connect) -> None:
        if not db_url.strip():
            raise OutcomeRetentionError("SUPABASE_DB_URL is required for Outcome retention")
        self._db_url = db_url
        self._connect = connect

    def claim_purge_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int = 300,
    ) -> ClaimedPurgeJob | None:
        if not worker_id.strip() or len(worker_id) > 200:
            raise ValueError("worker_id must contain between 1 and 200 characters")
        if not 30 <= lease_seconds <= 3600:
            raise ValueError("lease_seconds must be between 30 and 3600")
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select id, source_id, lease_token, payload, attempts, max_attempts
                    from app_private.claim_outcome_ingestion_job(
                      %s, %s, null, 'source.purge'
                    )
                    """,
                    (worker_id, lease_seconds),
                )
                row = cursor.fetchone()
            connection.commit()
        if row is None:
            return None
        payload = dict(row[3] or {})
        if payload.get("schema_version") != "source_purge_job_v1":
            raise OutcomeRetentionError("claimed purge job has an unsupported payload schema")
        return ClaimedPurgeJob(
            id=_uuid_text(row[0], "job id"),
            source_id=_uuid_text(row[1], "source id"),
            lease_token=_uuid_text(row[2], "lease token"),
            purge_event_id=_uuid_text(payload.get("purge_event_id"), "purge event id"),
            attempts=int(row[4]),
            max_attempts=int(row[5]),
        )

    def enqueue_expired_judilibre_artifacts(
        self,
        *,
        retention_period: timedelta,
        limit: int,
    ) -> int:
        """Queue physical deletion of old raw JSON while retaining safe projections."""
        if Jsonb is None:
            raise OutcomeRetentionError("psycopg is required for Outcome retention writes")
        if retention_period < timedelta(days=30):
            raise ValueError("raw artifact retention must be at least 30 days")
        if not 1 <= limit <= 1_000:
            raise ValueError("retention enqueue limit must be between 1 and 1000")
        inserted = 0
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select artifact.id, artifact.source_id, artifact.content_hash
                    from public.raw_artifacts artifact
                    join public.data_sources source on source.id = artifact.source_id
                    where source.name = 'judilibre'
                      and artifact.captured_at <= now() - (%s * interval '1 second')
                      and not exists (
                        select 1
                        from public.source_purge_events purge
                        where purge.source_id = artifact.source_id
                          and purge.raw_artifact_id = artifact.id
                          and purge.event_type in (
                            'deletion_requested', 'deletion_completed',
                            'redaction_requested', 'redaction_completed',
                            'retention_expired'
                          )
                      )
                      and not exists (
                        select 1
                        from public.source_purge_events hold
                        where hold.source_id = artifact.source_id
                          and hold.raw_artifact_id = artifact.id
                          and hold.event_type = 'legal_hold_applied'
                          and not exists (
                            select 1
                            from public.source_purge_events released
                            where released.supersedes_event_id = hold.id
                              and released.event_type = 'legal_hold_released'
                          )
                      )
                    order by artifact.captured_at, artifact.id
                    limit %s
                    for update of artifact skip locked
                    """,
                    (int(retention_period.total_seconds()), limit),
                )
                candidates = list(cursor.fetchall())
                for artifact_id, source_id, content_hash in candidates:
                    evidence_hash = canonical_sha256(
                        {
                            "raw_artifact_id": str(artifact_id),
                            "content_hash": str(content_hash),
                            "retention_seconds": int(retention_period.total_seconds()),
                            "worker_version": PURGE_WORKER_VERSION,
                        }
                    )
                    cursor.execute(
                        """
                        insert into public.source_purge_events (
                          source_id, raw_artifact_id, event_type, reason_code,
                          request_reference, evidence_hash, details
                        ) values (
                          %s, %s, 'retention_expired',
                          'judilibre_raw_retention_24_months',
                          'outcome-retention-worker', %s, %s
                        )
                        returning id
                        """,
                        (
                            source_id,
                            artifact_id,
                            evidence_hash,
                            Jsonb(
                                {
                                    "schema_version": "source_retention_expiry_v1",
                                    "retention_days": int(retention_period.days),
                                    "worker_version": PURGE_WORKER_VERSION,
                                }
                            ),
                        ),
                    )
                    event_row = cursor.fetchone()
                    if event_row is None:
                        raise OutcomeRetentionError("retention event persistence failed")
                    cursor.execute(
                        """
                        insert into public.ingestion_jobs (
                          source_id, job_kind, stream_key, idempotency_key,
                          payload, priority
                        ) values (%s, 'source.purge', 'retention', %s, %s, 50)
                        on conflict (source_id, job_kind, idempotency_key) do nothing
                        """,
                        (
                            source_id,
                            evidence_hash,
                            Jsonb(
                                {
                                    "schema_version": "source_purge_job_v1",
                                    "purge_event_id": str(event_row[0]),
                                    "raw_artifact_id": str(artifact_id),
                                }
                            ),
                        ),
                    )
                    inserted += 1
            connection.commit()
        return inserted

    def load_purge_target(self, job: ClaimedPurgeJob) -> PurgeTarget:
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    with recursive event_chain as (
                      select event.*
                      from public.source_purge_events event
                      where event.id = %s
                        and event.source_id = %s
                        and event.event_type in (
                          'deletion_requested', 'redaction_requested', 'retention_expired'
                        )
                      union all
                      select successor.*
                      from public.source_purge_events successor
                      join event_chain prior on successor.supersedes_event_id = prior.id
                    )
                    select id, event_type, external_record_id, raw_artifact_id, source_record_id
                    from event_chain
                    order by event_at desc, created_at desc, id desc
                    limit 1
                    """,
                    (job.purge_event_id, job.source_id),
                )
                latest = cursor.fetchone()
                if latest is None:
                    raise OutcomeRetentionError("purge request is missing or invalid")
                external_record_id = str(latest[2]) if latest[2] is not None else None
                raw_artifact_id = str(latest[3]) if latest[3] is not None else None
                source_record_id = str(latest[4]) if latest[4] is not None else None
                cursor.execute(
                    """
                    select distinct artifact.storage_object_path
                    from public.raw_artifacts artifact
                    where artifact.source_id = %s
                      and (
                        (%s::uuid is not null and artifact.id = %s::uuid)
                        or (
                          %s::text is not null
                          and (
                            artifact.external_record_id = %s::text
                            or exists (
                              select 1
                              from public.judicial_source_records record
                              where record.raw_artifact_id = artifact.id
                                and record.source_id = artifact.source_id
                                and record.external_record_id = %s::text
                            )
                          )
                        )
                      )
                    order by artifact.storage_object_path
                    """,
                    (
                        job.source_id,
                        raw_artifact_id,
                        raw_artifact_id,
                        external_record_id,
                        external_record_id,
                        external_record_id,
                    ),
                )
                object_paths = tuple(str(row[0]) for row in cursor.fetchall())
        return PurgeTarget(
            request_event_id=job.purge_event_id,
            latest_event_id=_uuid_text(latest[0], "latest purge event id"),
            latest_event_type=str(latest[1]),
            external_record_id=external_record_id,
            raw_artifact_id=raw_artifact_id,
            source_record_id=source_record_id,
            object_paths=object_paths,
        )

    def complete_purge_job(
        self,
        *,
        job: ClaimedPurgeJob,
        target: PurgeTarget,
        worker_id: str,
    ) -> None:
        if Jsonb is None:
            raise OutcomeRetentionError("psycopg is required for Outcome retention writes")
        evidence_hash = canonical_sha256(
            {
                "request_event_id": target.request_event_id,
                "latest_event_id": target.latest_event_id,
                "object_path_hashes": [canonical_sha256(path) for path in target.object_paths],
                "worker_version": PURGE_WORKER_VERSION,
            }
        )
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                if not target.already_completed:
                    cursor.execute(
                        """
                        insert into public.source_purge_events (
                          source_id, external_record_id, raw_artifact_id, source_record_id,
                          event_type, reason_code, request_reference, evidence_hash,
                          details, supersedes_event_id
                        ) values (
                          %s, %s, %s, %s, 'deletion_completed',
                          'physical_storage_purge_completed', 'outcome-retention-worker',
                          %s, %s, %s
                        )
                        on conflict (supersedes_event_id)
                          where supersedes_event_id is not null
                        do nothing
                        """,
                        (
                            job.source_id,
                            target.external_record_id,
                            target.raw_artifact_id,
                            target.source_record_id,
                            evidence_hash,
                            Jsonb(
                                {
                                    "schema_version": "source_purge_completion_v1",
                                    "storage_object_count": len(target.object_paths),
                                    "worker_version": PURGE_WORKER_VERSION,
                                }
                            ),
                            target.latest_event_id,
                        ),
                    )
                cursor.execute(
                    """
                    select id
                    from app_private.complete_outcome_ingestion_job(%s, %s, %s)
                    """,
                    (job.id, worker_id, job.lease_token),
                )
                if cursor.fetchone() is None:
                    raise OutcomeRetentionError("purge job completion failed")
            connection.commit()

    def fail_purge_job(
        self,
        *,
        job: ClaimedPurgeJob,
        worker_id: str,
        target: PurgeTarget | None,
        error_code: str,
        retry_delay_seconds: int = 60,
    ) -> None:
        if Jsonb is None:
            raise OutcomeRetentionError("psycopg is required for Outcome retention writes")
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                if (
                    job.attempts >= job.max_attempts
                    and target is not None
                    and not target.already_completed
                ):
                    cursor.execute(
                        """
                        insert into public.source_purge_events (
                          source_id, external_record_id, raw_artifact_id, source_record_id,
                          event_type, reason_code, request_reference, evidence_hash,
                          details, supersedes_event_id
                        ) values (
                          %s, %s, %s, %s, 'purge_failed', %s,
                          'outcome-retention-worker', %s, %s, %s
                        )
                        on conflict (supersedes_event_id)
                          where supersedes_event_id is not null
                        do nothing
                        """,
                        (
                            job.source_id,
                            target.external_record_id,
                            target.raw_artifact_id,
                            target.source_record_id,
                            error_code,
                            canonical_sha256(
                                {
                                    "request_event_id": target.request_event_id,
                                    "error_code": error_code,
                                    "worker_version": PURGE_WORKER_VERSION,
                                }
                            ),
                            Jsonb(
                                {
                                    "schema_version": "source_purge_failure_v1",
                                    "worker_version": PURGE_WORKER_VERSION,
                                }
                            ),
                            target.latest_event_id,
                        ),
                    )
                cursor.execute(
                    """
                    select id
                    from app_private.fail_outcome_ingestion_job(
                      %s, %s, %s, 'OutcomeRetentionError', %s,
                      'Outcome artifact purge failed.', %s
                    )
                    """,
                    (job.id, worker_id, job.lease_token, error_code, retry_delay_seconds),
                )
                if cursor.fetchone() is None:
                    raise OutcomeRetentionError("purge job failure transition failed")
            connection.commit()

    def load_orphan_object_paths(
        self,
        *,
        grace_period: timedelta,
        limit: int,
    ) -> tuple[str, ...]:
        if grace_period < timedelta(hours=1):
            raise ValueError("orphan grace period must be at least one hour")
        if not 1 <= limit <= 1_000:
            raise ValueError("orphan limit must be between 1 and 1000")
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select object.name
                    from storage.objects object
                    left join public.raw_artifacts artifact
                      on artifact.storage_object_path = object.name
                    where object.bucket_id = 'outcome-raw-artifacts'
                      and object.created_at <= now() - (%s * interval '1 second')
                      and artifact.id is null
                    order by object.created_at, object.id
                    limit %s
                    """,
                    (int(grace_period.total_seconds()), limit),
                )
                return tuple(str(row[0]) for row in cursor.fetchall())

    def existing_storage_object_count(self, paths: tuple[str, ...]) -> int:
        if not paths:
            return 0
        if len(paths) > 1_000:
            raise ValueError("storage verification accepts at most 1000 paths")
        with self._connect(self._db_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    select count(*)
                    from storage.objects object
                    where object.bucket_id = 'outcome-raw-artifacts'
                      and object.name = any(%s::text[])
                    """,
                    (list(paths),),
                )
                row = cursor.fetchone()
        return int(row[0]) if row is not None else 0


class OutcomeRetentionWorker:
    def __init__(
        self,
        *,
        repository: OutcomeRetentionRepository,
        artifact_store: SupabaseRawArtifactStore,
        worker_id: str,
    ) -> None:
        self.repository = repository
        self.artifact_store = artifact_store
        self.worker_id = worker_id

    def run(
        self,
        *,
        max_jobs: int,
        orphan_grace_period: timedelta,
        orphan_limit: int,
    ) -> RetentionRunSummary:
        if not 1 <= max_jobs <= 1_000:
            raise ValueError("max_jobs must be between 1 and 1000")
        summary = RetentionRunSummary()
        summary.retention_jobs_enqueued = self.repository.enqueue_expired_judilibre_artifacts(
            retention_period=timedelta(days=730),
            limit=max_jobs,
        )
        for _ in range(max_jobs):
            job = self.repository.claim_purge_job(worker_id=self.worker_id)
            if job is None:
                break
            summary.jobs_claimed += 1
            target: PurgeTarget | None = None
            try:
                target = self.repository.load_purge_target(job)
                if not target.already_completed:
                    for start in range(0, len(target.object_paths), 100):
                        batch = list(target.object_paths[start : start + 100])
                        summary.purge_objects_requested += self.artifact_store.remove_paths(batch)
                    if self.repository.existing_storage_object_count(target.object_paths) != 0:
                        raise RawArtifactStorageError("private raw artifact deletion failed")
                self.repository.complete_purge_job(
                    job=job,
                    target=target,
                    worker_id=self.worker_id,
                )
                summary.jobs_succeeded += 1
            except Exception as exc:
                error_code = (
                    "storage_delete_failed"
                    if isinstance(exc, RawArtifactStorageError)
                    else "purge_worker_failed"
                )
                self.repository.fail_purge_job(
                    job=job,
                    worker_id=self.worker_id,
                    target=target,
                    error_code=error_code,
                )
                summary.jobs_failed += 1

        orphan_paths = self.repository.load_orphan_object_paths(
            grace_period=orphan_grace_period,
            limit=orphan_limit,
        )
        for start in range(0, len(orphan_paths), 100):
            summary.orphan_objects_deleted += self.artifact_store.remove_paths(
                list(orphan_paths[start : start + 100])
            )
        if self.repository.existing_storage_object_count(orphan_paths) != 0:
            raise RawArtifactStorageError("private orphan artifact deletion failed")
        return summary


def _uuid_text(value: object, label: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        raise OutcomeRetentionError(f"{label} is invalid") from None
