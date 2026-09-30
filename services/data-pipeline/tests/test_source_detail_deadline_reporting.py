"""Exercise deadline reporting across the source and queue worker boundary."""

from src import queued_runner, source_detail_worker
from src.source_task_deadline import SourceTaskDeadlineExceeded


def test_source_deadline_is_reported_in_worker_outcome(monkeypatch, caplog):
    job = {
        "id": "source-deadline-job",
        "job_type": "source_detail",
        "source_url": "https://example.test/auction",
    }
    released = []
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {})
    monkeypatch.setattr(queued_runner, "_read_due_enrichment_family_counts", lambda: {})
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda **kwargs: [job],
    )
    monkeypatch.setattr(
        queued_runner,
        "_read_worker_claim_status_counts",
        lambda job_ids: {"queued": 1},
    )

    def cutoff(operation):
        raise SourceTaskDeadlineExceeded(operation, deadline=1, remaining=-1)

    monkeypatch.setattr(source_detail_worker, "ensure_source_task_deadline", cutoff)
    monkeypatch.setattr(
        source_detail_worker,
        "release_source_detail_job_without_attempt",
        lambda claimed, **kwargs: released.append(claimed["id"]),
    )

    with caplog.at_level("INFO", logger=queued_runner.LOGGER.name):
        assert queued_runner.run_enrichment_queue_worker(max_jobs=1, budget_seconds=1200) == 1

    assert released == ["source-deadline-job"]
    summary = next(
        record.getMessage()
        for record in caplog.records
        if "Enrichment worker outcome summary:" in record.getMessage()
    )
    assert "claimed=1" in summary
    assert "deferred_requested=1" in summary
    assert "observed_queued=1" in summary
    assert "completed=0" in summary
    assert queued_runner._WORKER_DEFERRED_JOB_IDS.get() is None
    assert queued_runner._WORKER_CLAIMED_JOB_IDS.get() is None
