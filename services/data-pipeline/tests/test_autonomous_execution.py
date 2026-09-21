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


@pytest.mark.parametrize("exhausted,expected_status", [(0, "succeeded"), (1, "failed")])
def test_retryable_enrichment_jobs_do_not_fail_the_batch(monkeypatch, exhausted, expected_status) -> None:
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

    assert autonomous_runner.execute(run_id) == (1 if exhausted else 0)
    assert updates[0][0] == expected_status
    assert updates[0][2].obj["enrichment_jobs_exhausted"] == exhausted
    assert updates[0][2].obj["completion_status"] == ("retry_exhausted" if exhausted else "partial_success")
