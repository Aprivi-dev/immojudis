import sys
import types

try:
    from src import queued_runner
except ModuleNotFoundError as exc:
    if exc.name != "pandas":
        raise
    sys.modules.pop("src.main", None)
    export_stub = types.ModuleType("src.export")
    export_stub.export_sales = lambda sales: ("out.json", "out.csv")
    sys.modules["src.export"] = export_stub
    from src import queued_runner
    del sys.modules["src.export"]


def test_queued_runner_cleans_past_sales_without_queued_run(monkeypatch, capsys) -> None:
    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 2)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 3)

    assert queued_runner.main() == 0
    output = capsys.readouterr().out
    assert "Marked past sales: 3" in output
    assert "Marked stale runs failed: 2" in output


def test_queued_runner_defaults_missing_llm_flag_to_automatic(monkeypatch, capsys) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: {"id": "run-1", "source": "all"})
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_run_pipeline(options):
        captured["use_llm"] = options.use_llm
        captured["heavy_enrichment"] = options.heavy_enrichment
        return 0

    monkeypatch.setattr(queued_runner, "run_pipeline", fake_run_pipeline)

    assert queued_runner.main() == 0
    assert captured == {"use_llm": True, "heavy_enrichment": True}
    assert "llm=True" in capsys.readouterr().out
