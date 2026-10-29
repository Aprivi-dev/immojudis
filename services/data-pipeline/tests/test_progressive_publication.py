"""Early publication of collected batches: a database failure there must not end the source scrape."""

from __future__ import annotations

from src import main


def _run() -> main._PipelineRun:
    return main._PipelineRun(
        options=main.PipelineOptions(),
        settings={},
        run_id="run-1",
        known_details={"https://example.test/a": {"_signature": "x"}},
    )


def test_a_batch_is_hydrated_then_published(monkeypatch) -> None:
    run = _run()
    calls: list[str] = []
    monkeypatch.setattr(main, "_hydrate_run_payloads", lambda run_, rows: calls.append("hydrate"))
    monkeypatch.setattr(
        main,
        "publish_factual_batch",
        lambda run_id, rows, known, errors: calls.append(f"publish:{run_id}:{len(rows)}"),
    )

    main._publish_progressive_batch(run, [{"source_url": "https://example.test/a"}])

    assert calls == ["hydrate", "publish:run-1:1"]
    assert not run.errors.get("supabase")


def test_a_failed_hydration_skips_the_early_publication_and_keeps_the_source_running(monkeypatch) -> None:
    run = _run()
    published: list[int] = []

    def broken(run_, rows):
        raise RuntimeError("terminating connection due to administrator command")

    monkeypatch.setattr(main, "_hydrate_run_payloads", broken)
    monkeypatch.setattr(main, "publish_factual_batch", lambda *args: published.append(1))

    # Does not raise: the source keeps collecting; the final stages publish its rows.
    main._publish_progressive_batch(run, [{"source_url": "https://example.test/a"}])

    assert published == []
    assert run.errors["supabase"] == ["progressive publication skipped: terminating connection due to administrator command"]


def test_a_failed_evidence_write_skips_the_early_publication_and_keeps_the_source_running(monkeypatch) -> None:
    run = _run()

    def timed_out(run_id, rows, known, errors):
        raise RuntimeError("canceling statement due to statement timeout")

    monkeypatch.setattr(main, "_hydrate_run_payloads", lambda run_, rows: None)
    monkeypatch.setattr(main, "publish_factual_batch", timed_out)

    # Used to end the source (« avoventes source batch callback failed: canceling statement due to statement timeout »).
    main._publish_progressive_batch(run, [{"source_url": "https://example.test/a"}])

    assert run.errors["supabase"] == ["progressive publication skipped: canceling statement due to statement timeout"]
