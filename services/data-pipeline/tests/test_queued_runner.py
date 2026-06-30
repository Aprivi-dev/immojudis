from src import queued_runner


def test_queued_runner_cleans_past_sales_without_queued_run(monkeypatch, capsys) -> None:
    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 2)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 3)

    assert queued_runner.main() == 0
    output = capsys.readouterr().out
    assert "Marked past sales: 3" in output
    assert "Marked stale runs failed: 2" in output
