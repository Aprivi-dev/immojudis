from __future__ import annotations

from datetime import timedelta

import pytest

from src.outcome_ingestion.artifact_store import RawArtifactStorageError
from src.outcome_ingestion.retention import (
    ClaimedPurgeJob,
    OutcomeRetentionError,
    OutcomeRetentionWorker,
    PurgeTarget,
    _uuid_text,
)

JOB = ClaimedPurgeJob(
    id="00000000-0000-0000-0000-000000000001",
    source_id="00000000-0000-0000-0000-000000000002",
    lease_token="00000000-0000-0000-0000-000000000003",
    purge_event_id="00000000-0000-0000-0000-000000000004",
    attempts=1,
    max_attempts=5,
)


def _target(*, completed: bool = False) -> PurgeTarget:
    return PurgeTarget(
        request_event_id=JOB.purge_event_id,
        latest_event_id=JOB.purge_event_id,
        latest_event_type="deletion_completed" if completed else "deletion_requested",
        external_record_id="private-external-id",
        raw_artifact_id="00000000-0000-0000-0000-000000000005",
        source_record_id="00000000-0000-0000-0000-000000000006",
        object_paths=("judilibre/a/first.json", "judilibre/a/second.json"),
    )


class FakeRepository:
    def __init__(self, *, target: PurgeTarget, orphan_paths: tuple[str, ...] = ()) -> None:
        self.jobs = [JOB]
        self.target = target
        self.orphan_paths = orphan_paths
        self.completed: list[tuple[ClaimedPurgeJob, PurgeTarget, str]] = []
        self.failed: list[tuple[ClaimedPurgeJob, PurgeTarget | None, str]] = []

    def enqueue_expired_judilibre_artifacts(
        self,
        *,
        retention_period: timedelta,
        limit: int,
    ) -> int:
        assert retention_period == timedelta(days=730)
        assert limit in {1, 10}
        return 2

    def claim_purge_job(self, *, worker_id: str) -> ClaimedPurgeJob | None:
        assert worker_id == "worker-1"
        return self.jobs.pop(0) if self.jobs else None

    def load_purge_target(self, job: ClaimedPurgeJob) -> PurgeTarget:
        assert job is JOB
        return self.target

    def complete_purge_job(
        self,
        *,
        job: ClaimedPurgeJob,
        target: PurgeTarget,
        worker_id: str,
    ) -> None:
        self.completed.append((job, target, worker_id))

    def fail_purge_job(
        self,
        *,
        job: ClaimedPurgeJob,
        worker_id: str,
        target: PurgeTarget | None,
        error_code: str,
    ) -> None:
        assert worker_id == "worker-1"
        self.failed.append((job, target, error_code))

    def load_orphan_object_paths(
        self,
        *,
        grace_period: timedelta,
        limit: int,
    ) -> tuple[str, ...]:
        assert grace_period == timedelta(hours=24)
        assert limit == 100
        return self.orphan_paths

    def existing_storage_object_count(self, _paths: tuple[str, ...]) -> int:
        return 0


class FakeArtifactStore:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[list[str]] = []

    def remove_paths(self, paths: list[str]) -> int:
        self.calls.append(paths)
        if self.fail:
            raise RawArtifactStorageError("safe failure")
        return len(paths)


def test_worker_physically_purges_before_completing_and_runs_orphan_janitor() -> None:
    repository = FakeRepository(
        target=_target(),
        orphan_paths=("judilibre/orphan/object.json",),
    )
    store = FakeArtifactStore()

    summary = OutcomeRetentionWorker(
        repository=repository,  # type: ignore[arg-type]
        artifact_store=store,  # type: ignore[arg-type]
        worker_id="worker-1",
    ).run(
        max_jobs=10,
        orphan_grace_period=timedelta(hours=24),
        orphan_limit=100,
    )

    assert summary.jobs_claimed == 1
    assert summary.retention_jobs_enqueued == 2
    assert summary.jobs_succeeded == 1
    assert summary.jobs_failed == 0
    assert summary.purge_objects_requested == 2
    assert summary.orphan_objects_deleted == 1
    assert store.calls == [
        ["judilibre/a/first.json", "judilibre/a/second.json"],
        ["judilibre/orphan/object.json"],
    ]
    assert repository.completed == [(JOB, repository.target, "worker-1")]
    assert repository.failed == []


def test_worker_retries_storage_failure_without_completing_the_job() -> None:
    repository = FakeRepository(target=_target())
    store = FakeArtifactStore(fail=True)

    summary = OutcomeRetentionWorker(
        repository=repository,  # type: ignore[arg-type]
        artifact_store=store,  # type: ignore[arg-type]
        worker_id="worker-1",
    ).run(
        max_jobs=1,
        orphan_grace_period=timedelta(hours=24),
        orphan_limit=100,
    )

    assert summary.jobs_failed == 1
    assert repository.completed == []
    assert repository.failed == [(JOB, repository.target, "storage_delete_failed")]


def test_completed_purge_is_idempotent_and_does_not_delete_again() -> None:
    repository = FakeRepository(target=_target(completed=True))
    store = FakeArtifactStore()

    summary = OutcomeRetentionWorker(
        repository=repository,  # type: ignore[arg-type]
        artifact_store=store,  # type: ignore[arg-type]
        worker_id="worker-1",
    ).run(
        max_jobs=1,
        orphan_grace_period=timedelta(hours=24),
        orphan_limit=100,
    )

    assert summary.jobs_succeeded == 1
    assert summary.purge_objects_requested == 0
    assert store.calls == []


def test_uuid_validation_is_log_safe() -> None:
    with pytest.raises(OutcomeRetentionError, match="job id is invalid") as raised:
        _uuid_text("private invalid value", "job id")
    assert "private invalid value" not in str(raised.value)
