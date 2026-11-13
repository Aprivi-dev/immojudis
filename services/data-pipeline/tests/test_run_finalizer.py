def test_automatic_non_owner_does_not_finalize_requested_run(monkeypatch):
    from src import run_finalizer

    monkeypatch.delenv("PIPELINE_CURRENT_RUN_ID", raising=False)
    monkeypatch.setenv("REQUESTED_AUTOMATIC", "true")
    monkeypatch.setenv("REQUESTED_RUN_ID", "11111111-1111-4111-8111-111111111111")

    assert run_finalizer.main() == 0


def test_manual_workflow_still_uses_requested_run_fallback(monkeypatch):
    from src import run_finalizer

    calls = []

    class FakeDb:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, statement, parameters):
            calls.append((statement, parameters))

    monkeypatch.delenv("PIPELINE_CURRENT_RUN_ID", raising=False)
    monkeypatch.setenv("REQUESTED_AUTOMATIC", "false")
    monkeypatch.setenv("REQUESTED_RUN_ID", "22222222-2222-4222-8222-222222222222")
    monkeypatch.setattr(run_finalizer, "load_settings", lambda: {"supabase_db_url": "postgres.test"})
    monkeypatch.setattr(run_finalizer, "connect", lambda _url: FakeDb())

    assert run_finalizer.main() == 0
    assert len(calls) == 1
    statement, parameters = calls[0]
    # Same closing rule as the autonomous runner: merge into the report, only while the run is still open.
    assert "summary=coalesce(summary,'{}') || %s" in statement
    assert "status in ('queued','running')" in statement
    assert parameters[0] == "failed"
    assert parameters[2].obj == {"completion_status": "interrupted"}
    assert parameters[-1] == "22222222-2222-4222-8222-222222222222"
