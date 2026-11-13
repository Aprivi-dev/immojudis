"""Lecture des pièces en avance, hors du verrou du catalogue (04/11/2026)."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from src import document_backlog as backlog
from src import document_prefetch as prefetch


def _thread_executor(seen: list[float] | None = None):
    def factory(workers: int, host_delay: float):
        if seen is not None:
            seen.append(host_delay)
        return ThreadPoolExecutor(max_workers=workers)

    return factory


def test_workers_come_from_the_environment(monkeypatch) -> None:
    monkeypatch.setenv(prefetch.PREFETCH_WORKERS_ENV, "")
    assert prefetch.prefetch_workers_from_env() == prefetch.DEFAULT_PREFETCH_WORKERS
    monkeypatch.setenv(prefetch.PREFETCH_WORKERS_ENV, "0")
    assert prefetch.prefetch_workers_from_env() == 0
    monkeypatch.setenv(prefetch.PREFETCH_WORKERS_ENV, "99")
    assert prefetch.prefetch_workers_from_env() == prefetch.MAX_PREFETCH_WORKERS
    monkeypatch.setenv(prefetch.PREFETCH_WORKERS_ENV, "abc")
    assert prefetch.prefetch_workers_from_env() == prefetch.DEFAULT_PREFETCH_WORKERS


def test_the_workflow_takes_the_worker_count_from_a_repository_variable() -> None:
    # Couper ou remettre la lecture en avance sans commit (04-05/11/2026 : deux commits pour 0 puis 3). « 0 » est
    # une chaîne non vide : l'expression ne la remplace pas par le défaut.
    workflow = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "data-pipeline.yml"
    text = workflow.read_text(encoding="utf-8")
    assert "DOCUMENT_BACKLOG_PREFETCH_WORKERS: ${{ vars.DOCUMENT_BACKLOG_PREFETCH_WORKERS || '3' }}" in text
    assert str(prefetch.DEFAULT_PREFETCH_WORKERS) == "3"


def test_the_host_delay_is_shared_between_the_processes(monkeypatch) -> None:
    # Three processes each wait three times the delay: one site still sees one request per delay.
    monkeypatch.setenv("PDF_HOST_MIN_DELAY_SECONDS", "2")
    seen: list[float] = []
    prefetcher = prefetch.DocumentPrefetcher(
        ["a"], workers=3, deadline=time.monotonic() + 60, executor_factory=_thread_executor(seen), prefetch=lambda u, r: {}
    )
    prefetcher.close()
    assert seen == [6.0]


def test_the_next_sales_are_prepared_ahead_and_awaited_in_order() -> None:
    started: list[str] = []
    release = {url: threading.Event() for url in "abcdef"}

    def fake(url: str, remaining: float) -> dict:
        started.append(url)
        release[url].wait(5)
        return {"source_url": url}

    prefetcher = prefetch.DocumentPrefetcher(
        list("abcdef"),
        workers=2,
        deadline=time.monotonic() + 60,
        executor_factory=_thread_executor(),
        prefetch=fake,
        lookahead=3,
    )
    prefetcher.start()
    for _ in range(50):
        if len(started) >= 2:
            break
        threading.Event().wait(0.02)
    # Two workers busy, one more sale queued: never more than the lookahead scheduled.
    assert sorted(started) == ["a", "b"]
    assert list(prefetcher._futures) == ["a", "b", "c"]
    release["a"].set()
    prefetcher.wait_for("a")
    assert prefetcher.prepared == 1
    assert "d" in prefetcher._futures and "a" not in prefetcher._futures
    for event in release.values():
        event.set()
    prefetcher.close()


def test_a_sale_not_yet_started_is_left_to_the_locked_pass() -> None:
    gate = threading.Event()

    def fake(url: str, remaining: float) -> dict:
        gate.wait(5)
        return {}

    prefetcher = prefetch.DocumentPrefetcher(
        list("abc"), workers=1, deadline=time.monotonic() + 60, executor_factory=_thread_executor(), prefetch=fake
    )
    prefetcher.start()
    prefetcher.wait_for("b")  # queued behind "a": cancelled, not awaited
    assert prefetcher.prepared == 0
    gate.set()
    prefetcher.close()


def test_a_failing_preparation_never_stops_the_drain() -> None:
    def fake(url: str, remaining: float) -> dict:
        raise RuntimeError("worker died")

    prefetcher = prefetch.DocumentPrefetcher(
        ["a"], workers=1, deadline=time.monotonic() + 60, executor_factory=_thread_executor(), prefetch=fake
    )
    prefetcher.start()
    prefetcher.wait_for("a")
    prefetcher.close()
    assert prefetcher.prepared == 0


def test_no_worker_means_no_executor() -> None:
    def factory(workers: int, delay: float):
        raise AssertionError("no executor without workers")

    prefetcher = prefetch.DocumentPrefetcher(["a"], workers=0, deadline=time.monotonic() + 60, executor_factory=factory)
    prefetcher.start()
    prefetcher.wait_for("a")
    prefetcher.close()


def test_the_drain_waits_for_each_preparation_before_taking_the_lock(monkeypatch) -> None:
    events: list[str] = []

    class _Recorder:
        stats: dict[str, int] = {}

        def start(self) -> None:
            events.append("start")

        def wait_for(self, url: str) -> None:
            events.append(f"wait:{url}")

        def close(self) -> None:
            events.append("close")

    @contextmanager
    def lock(_db, _wait):
        events.append("lock")
        yield SimpleNamespace(ensure_held=lambda: None)

    monkeypatch.setattr(backlog, "load_settings", lambda: {"supabase_db_url": "postgres://test"})
    monkeypatch.setattr(
        backlog, "select_backlog_candidates", lambda _db, _n: [{"source_url": "u1"}, {"source_url": "u2"}]
    )
    monkeypatch.setattr(backlog, "_prefetcher", lambda urls, deadline: _Recorder())
    monkeypatch.setattr(backlog, "_catalogue_lock", lock)
    monkeypatch.setattr(
        backlog,
        "drain_sale",
        lambda _db, candidate, _limits, _deadline, lock=None: backlog.SaleOutcome(
            source_url=candidate["source_url"], source_name="vench", action="processed"
        ),
    )

    backlog.run_document_backlog(backlog.BacklogLimits(budget_seconds=600), sleep=lambda _s: None)

    assert events == ["start", "wait:u1", "lock", "wait:u2", "lock", "close"]


def test_preparation_reads_pages_without_writing_to_the_database(monkeypatch, tmp_path) -> None:
    from src import config, pdf_document_selection, pdf_document_text_cache, pdf_enrichment, pdf_progress
    from src.models import AuctionSale
    from src.pdf_deadline import PdfExtractionDeferred
    from src.storage import supabase_client

    sale = AuctionSale(
        source_name="vench",
        source_url="https://example.test/v",
        documents=[{"label": "PV", "url": "https://example.test/v/pv.pdf"}],
    )
    pdf = tmp_path / "pv.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    rounds: list[str] = []

    def extract(path, document=None):
        rounds.append(str(path))
        if len(rounds) == 1:
            raise PdfExtractionDeferred("OCR budget reached; retry resumes", checkpointed_pages=3, total_pages=9, new_progress_pages=3)
        return {"text": "ok"}

    monkeypatch.setattr(supabase_client, "fetch_sale_for_data_refresh", lambda url: sale)
    monkeypatch.setattr(prefetch, "restore_checkpointed_pages", lambda s, downloaded: None)
    monkeypatch.setattr(
        pdf_enrichment, "download_documents", lambda s, stats=None: [{"url": "u", "file_path": str(pdf)}]
    )
    monkeypatch.setattr(pdf_progress, "restore_pdf_page_caches_from_manifest", lambda *a, **k: 0)
    monkeypatch.setattr(pdf_document_selection, "select_documents_for_extraction", lambda docs, **_: docs)
    monkeypatch.setattr(pdf_document_text_cache, "read_document_text_cache", lambda d, p, **_: None)
    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", extract)
    monkeypatch.setattr(config, "PDF_TEXTS_DIR", Path(tmp_path))

    def forbidden(*_a, **_k):
        raise AssertionError("preparation must not write to the database")

    monkeypatch.setattr(supabase_client, "upsert_sales_to_supabase", forbidden)

    result = prefetch.prefetch_sale_documents(sale.source_url, 60.0)

    assert result["error"] is None
    assert (result["documents"], result["read"], result["deferred_exhausted"]) == (1, 1, 0)
    assert rounds == [str(pdf), str(pdf)]  # the deferred document is resumed from its page cache

    # Still deferred after every round: counted for the drain report instead of being dropped silently.
    rounds.clear()

    def always_deferred(path, document=None):
        rounds.append(str(path))
        raise PdfExtractionDeferred("OCR budget reached; retry resumes", checkpointed_pages=3, total_pages=900, new_progress_pages=3)

    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", always_deferred)
    result = prefetch.prefetch_sale_documents(sale.source_url, 60.0)
    assert (result["read"], result["deferred_exhausted"]) == (0, 1)
    assert len(rounds) == prefetch.MAX_ROUNDS_PER_DOCUMENT


@pytest.mark.parametrize("budget", [0.0])
def test_preparation_stops_at_the_deadline(monkeypatch, budget) -> None:
    from src.models import AuctionSale
    from src.storage import supabase_client

    sale = AuctionSale(source_name="vench", source_url="https://example.test/d", documents=[])
    monkeypatch.setattr(supabase_client, "fetch_sale_for_data_refresh", lambda url: sale)
    result = prefetch.prefetch_sale_documents(sale.source_url, budget)
    assert result["documents"] == 0 and result["error"] is None


def test_worker_processes_start_with_their_share_of_the_host_delay() -> None:
    import os

    executor = prefetch._process_executor(1, 6.0)
    try:
        assert executor.submit(os.getenv, "PDF_HOST_MIN_DELAY_SECONDS").result(timeout=60) == "6.0"
    finally:
        executor.shutdown()


def test_the_lookahead_keeps_workers_busy_while_the_lock_is_held() -> None:
    prefetcher = prefetch.DocumentPrefetcher(
        [f"u{i}" for i in range(30)],
        workers=3,
        deadline=time.monotonic() + 60,
        executor_factory=_thread_executor(),
        prefetch=lambda url, remaining: {},
    )
    prefetcher.start()
    assert len(prefetcher._futures) == 3 * prefetch.LOOKAHEAD_PER_WORKER
    prefetcher.close()


def test_restoring_checkpoints_never_writes_the_sale_manifest(monkeypatch) -> None:
    # 04/11/2026 : un manifeste local écrit en avance devenait périmé et faisait tourner la passe sous verrou en rond.
    from src import config
    from src.models import AuctionSale
    from src.pdf_fact_extraction import write_pdf_text_cache  # noqa: F401 - must not be reached
    from src.storage import supabase_client

    sale = AuctionSale(source_name="vench", source_url="https://example.test/m", documents=[])
    downloaded = [{"url": "https://example.test/m/pv.pdf", "file_path": "/tmp/pv.pdf"}]
    restored_pages: list[tuple] = []
    monkeypatch.setattr(
        config,
        "load_settings",
        lambda: {"supabase_url": "https://db.example", "supabase_service_role_key": "k"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_read_persisted_pdf_rows_rest",
        lambda url, key, urls: [{"updated_at": "2026-11-04T10:00:00Z"}, {"updated_at": "2026-11-04T11:00:00Z"}],
    )
    monkeypatch.setattr(supabase_client, "_validated_persisted_pdf_texts", lambda s, row: None)
    monkeypatch.setattr(
        supabase_client, "_validated_persisted_pdf_progress", lambda s, row: [{"row": row["updated_at"]}]
    )
    monkeypatch.setattr(
        supabase_client,
        "_restore_pdf_page_caches_for_documents",
        lambda restored, docs: restored_pages.append((restored, docs)),
    )

    def forbidden(*_a, **_k):
        raise AssertionError("the sale manifest must not be written ahead of the locked pass")

    monkeypatch.setattr(supabase_client, "restore_persisted_pdf_progress_for_sale", forbidden)
    monkeypatch.setattr("src.pdf_fact_extraction.write_pdf_text_cache", forbidden)

    prefetch.restore_checkpointed_pages(sale, downloaded)

    # The newest checkpoint is used, and only as page caches beside the downloaded files.
    assert restored_pages == [([{"row": "2026-11-04T11:00:00Z"}], downloaded)]


def test_the_prefetcher_totals_its_preparations_for_the_drain_report() -> None:
    outcomes = {
        "a": {"documents": 3, "read": 2, "cached": 1, "deferred_exhausted": 0, "error": None},
        "b": {"documents": 2, "read": 0, "cached": 0, "deferred_exhausted": 2, "error": None},
        "c": {"documents": 0, "read": 0, "cached": 0, "deferred_exhausted": 0, "error": "HTTPError: 503"},
    }

    def fake(url: str, remaining: float) -> dict:
        if url == "d":
            raise RuntimeError("worker died")
        return outcomes[url]

    prefetcher = prefetch.DocumentPrefetcher(
        list("abcd"), workers=1, deadline=time.monotonic() + 60, executor_factory=_thread_executor(), prefetch=fake
    )
    prefetcher.start()
    wait(list(prefetcher._futures.values()), timeout=5)  # all started and finished: none is cancelled below
    for url in "abcd":
        prefetcher.wait_for(url)
    prefetcher.close()

    assert prefetcher.stats == {
        "workers": 1,
        "prepared": 3,
        "documents": 5,
        "read": 2,
        "cached": 1,
        "deferred_exhausted": 2,
        "errors": 2,
    }
