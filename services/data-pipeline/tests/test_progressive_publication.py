"""Early publication of collected batches: a database failure there must not end the source scrape."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from src import main
from src.catalogue_lock import CatalogueLockLost


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


# --- catalogue writer lock lost (D9) -------------------------------------------


def _lock_lost() -> None:
    raise CatalogueLockLost("The catalogue writer lock of pipeline (all) may have been lost")


def test_a_lost_lock_skips_the_progressive_publication(monkeypatch) -> None:
    run = _run()
    monkeypatch.setattr(main, "catalogue_lock_lost", lambda: True)
    monkeypatch.setattr(main, "_hydrate_run_payloads", lambda *args: pytest.fail("nothing is written without the lock"))
    monkeypatch.setattr(main, "publish_factual_batch", lambda *args: pytest.fail("nothing is written without the lock"))

    main._publish_progressive_batch(run, [{"source_url": "https://example.test/a"}])


def test_a_lost_lock_stops_the_collection_before_its_next_batch(monkeypatch) -> None:
    run = _run()
    run.settings = {"pipeline_pdf_workers": 1, "pipeline_llm_workers": 1}
    run.canonical_sales = [SimpleNamespace(source_name="licitor", source_url="https://example.test/a")]
    monkeypatch.setattr(main, "warm_image_validations", lambda sales: None)
    monkeypatch.setattr(main, "_finalize_sale_for_app", lambda sale, geocode: None)
    monkeypatch.setattr(main, "mark_past_sales", lambda batch: SimpleNamespace(marked_past=0))
    monkeypatch.setattr(main, "admit_sales", lambda batch, record: list(batch))
    monkeypatch.setattr(main, "record_sale_decisions", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "ensure_catalogue_lock_held", _lock_lost)
    monkeypatch.setattr(
        main.retention_tombstones, "publish_batch", lambda *args: pytest.fail("no batch is published without the lock")
    )

    with pytest.raises(CatalogueLockLost):
        main._prepare_and_publish_early(run)

    assert not run.errors.get("supabase")


def test_a_lost_lock_stops_the_final_publication(monkeypatch) -> None:
    run = _run()
    monkeypatch.setattr(main, "ensure_catalogue_lock_held", _lock_lost)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda *args: pytest.fail("nothing is written without the lock"))

    with pytest.raises(CatalogueLockLost):
        main._publish_run(run)


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
