import subprocess
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from src import autonomous_runner


@pytest.mark.parametrize(
    "source,returncode,previous_completion,expected_budget,expected_completion",
    [
        ("licitor", 0, "complete", 50 * 60, "complete"),
        ("petites_affiches", 1, "partial_success", 35 * 60, "partial_success"),
    ],
)
def test_automatic_run_keeps_publication_budget_and_partial_result(
    monkeypatch, source, returncode, previous_completion, expected_budget, expected_completion
) -> None:
    run_id = "00000000-0000-0000-0000-000000000001"
    updates = []
    subprocess_calls = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: (source,))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({"completion_status": previous_completion},))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **kwargs: subprocess_calls.append((command, kwargs)) or SimpleNamespace(returncode=returncode),
    )

    assert autonomous_runner.execute(run_id) == returncode
    assert subprocess_calls[0][1]["timeout"] == expected_budget
    assert updates[0][2].obj["completion_status"] == expected_completion
    assert updates[0][0] == ("failed" if returncode else "succeeded")


@pytest.mark.parametrize("exhausted", [0, 1])
def test_exhausted_enrichment_job_keeps_run_partial_when_worker_completed_jobs(
    monkeypatch, exhausted
) -> None:
    run_id = "00000000-0000-0000-0000-000000000002"
    updates = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("completed", 31), ("failed", 10)])
            if "select id,job_type,attempt_count,max_attempts" in statement:
                return SimpleNamespace(fetchall=lambda: [
                    ("job-exhausted", "pdf", 4, 4),
                ])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (exhausted,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda _command, **_kwargs: SimpleNamespace(returncode=0),
    )

    assert autonomous_runner.execute(run_id) == 0
    assert updates[0][0] == "succeeded"
    assert updates[0][2].obj["enrichment_jobs_exhausted"] == exhausted
    assert updates[0][2].obj["enrichment_jobs_completed"] == 31
    assert updates[0][2].obj["completion_status"] == "partial_success"
    if exhausted:
        assert updates[0][1].obj["enrichment_jobs"] == [
            "1 enrichment job(s) exhausted their retry budget"
        ]
        assert updates[0][2].obj["enrichment_jobs_exhausted_details"] == [
            {
                "job_id": "job-exhausted",
                "job_type": "pdf",
                "attempt_count": 4,
                "max_attempts": 4,
            }
        ]


def test_systemic_worker_failure_keeps_nonzero_code_with_exhausted_signal(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000003"
    updates = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("completed", 2), ("failed", 1)])
            if "select id,job_type,attempt_count,max_attempts" in statement:
                return SimpleNamespace(fetchall=lambda: [("job-exhausted", "pdf", 4, 4)])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (1,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda _command, **_kwargs: SimpleNamespace(returncode=7),
    )

    assert autonomous_runner.execute(run_id) == 7
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"] == ["Worker exited with status 7"]
    assert updates[0][1].obj["enrichment_jobs"] == [
        "1 enrichment job(s) exhausted their retry budget"
    ]
    assert updates[0][2].obj["worker_exit_code"] == 7
    assert updates[0][2].obj["completion_status"] == "interrupted"


def test_exhausted_enrichment_without_completed_job_stays_failed(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000004"
    updates = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("failed", 1)])
            if "select id,job_type,attempt_count,max_attempts" in statement:
                return SimpleNamespace(fetchall=lambda: [("job-exhausted", "pdf", 4, 4)])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (1,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda _command, **_kwargs: SimpleNamespace(returncode=0),
    )

    assert autonomous_runner.execute(run_id) == 1
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"] == [
        "Exhausted enrichment jobs reported without worker progress"
    ]
    assert updates[0][2].obj["completion_status"] == "retry_exhausted"


def test_worker_timeout_remains_failed_and_visible(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000005"
    updates = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("licitor",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda _command, **_kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(cmd="worker", timeout=10)
        ),
    )

    assert autonomous_runner.execute(run_id) == 1
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"] == [
        "Execution budget exceeded; committed checkpoints preserved"
    ]
    assert updates[0][2].obj["worker_exit_code"] == 1
    assert updates[0][2].obj["completion_status"] == "interrupted"
