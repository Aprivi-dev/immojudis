"""Bounded manual drain of the attached-document backlog."""

from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal

import pytest

from src import document_backlog as backlog
from src.models import AuctionSale
from src.pdf_enrichment import DOCUMENT_FACTS_VERSION


def _sale(url: str, **fields: object) -> AuctionSale:
    fields.setdefault("raw_payload", {"document_facts_version": DOCUMENT_FACTS_VERSION})
    return AuctionSale(
        source_name="vench",
        source_url=url,
        starting_price_eur=Decimal("50000"),
        documents=[{"label": "PV descriptif", "url": f"{url}/pv.pdf"}],
        **fields,
    )


def test_limits_are_validated_and_clamped() -> None:
    default = backlog.limits_from_inputs(None, "", None)
    assert (default.max_sales, default.budget_seconds, default.max_passes) == (200, 7200.0, 4)

    clamped = backlog.limits_from_inputs("99999", "999", "50")
    assert clamped.max_sales == backlog.MAX_SALES_LIMIT
    assert clamped.budget_seconds == backlog.MAX_BUDGET_MINUTES * 60
    assert clamped.max_passes == backlog.MAX_PASSES_LIMIT

    garbage = backlog.limits_from_inputs("abc", "-3", "0")
    assert (garbage.max_sales, garbage.budget_seconds, garbage.max_passes) == (200, 60.0, 1)


def test_queries_select_upcoming_sales_and_only_pdf_jobs() -> None:
    sql = " ".join(backlog.CANDIDATES_SQL.split())
    # Sales with documents never tried first, then the soonest sale; an undated sale (State tender whose
    # deadline is only in its documents) counts as ending within a week instead of coming last.
    assert (
        "order by (p.source_url is null and exists (select 1 from public.auction_documents d"
        " where d.source_url = s.source_url)), (coalesce(p.untried_documents, jsonb_array_length(s.documents)) = 0),"
    ) in sql
    assert "coalesce(s.sale_date, now() + interval '7 days')," in sql
    assert "(s.sale_date is null), s.sale_date" not in sql
    assert "(s.sale_date is null or s.sale_date >= now())" in sql
    # Run after every enrichment tick: a sale tried within a day waits, so a failing document is not
    # downloaded again each time.
    assert "a.job_type = 'pdf' and a.updated_at >= now() - interval '1 day'" in sql
    # A document read except for a few pages ("partial") is settled.
    assert "not in ('extracted', 'empty', 'partial')" in sql
    # A sale whose every source is withdrawn from the catalogue (Vench, Petites Affiches) is hidden and its queue
    # jobs wait a day: it must not take a slot of the selection. Same rule and switch as the database.
    assert (
        "and not app_private.sale_is_fully_withdrawn( s.source_name, s.observations,"
        " (select app_private.catalogue_withdrawn_sources()) )"
    ) in sql
    # Documents all read with older extraction rules are read again from the cache (quality audit of
    # 03/11/2026), after the documents never read, and a deferred re-read keeps its deadline.
    assert "or coalesce(s.raw_payload->>'document_facts_version', '') <> %s" in sql
    assert "and not ( a.status = 'queued' and a.next_attempt_at <= now() and ( a.attempt_count = 0" in sql
    assert "or ( p.source_url is null and coalesce(s.raw_payload->>'document_facts_version', '') <> %s )" in sql
    # Only a real attempt waits a day (04/11/2026: 0 of 270 sales selected). A cancelled job (superseded when a
    # collection invalidates the reading) tried nothing, and a completed reading replaced by a newer
    # generation is out of date.
    assert "and a.status <> 'cancelled'" in sql
    assert (
        "and not ( a.status = 'completed' and exists ( select 1 from public.auction_enrichment_jobs b"
        " where b.source_url = a.source_url and b.job_type = 'pdf' and b.created_at > a.created_at ) )"
    ) in sql
    assert sql.count("%s") == 5
    claim = " ".join(backlog.CLAIM_JOB_SQL.split())
    assert "j.job_type = 'pdf'" in claim and "for update of j, s skip locked" in claim
    ensure = " ".join(backlog.ENSURE_JOB_SQL.split())
    assert "where auction_enrichment_jobs.status <> 'running'" in ensure


class _Fake:
    """In-memory stand-in for the database helpers of one drain."""

    def __init__(
        self, monkeypatch, sales: dict[str, list[AuctionSale | None]], states: dict[str, list[tuple[str, str]]]
    ):
        self.sales = sales
        self.states = states
        self.processed: list[str] = []
        self.reprojected: list[str] = []
        self.ensured: list[str] = []
        self.current: set[str] = set()
        self.extracted: dict[str, list[int]] = {}
        monkeypatch.setattr(backlog, "_fetch_sale", self.fetch)
        monkeypatch.setattr(backlog, "ensure_pdf_job", self.ensure)
        monkeypatch.setattr(backlog, "claim_pdf_job", lambda _db, job_id: {"id": job_id, "job_type": "pdf"})
        monkeypatch.setattr(backlog, "read_job_state", self.state)
        monkeypatch.setattr(backlog, "read_document_counts", self.counts)
        monkeypatch.setattr(backlog, "_process_job", lambda job, deadline: self.processed.append(job["id"]))
        monkeypatch.setattr(backlog, "_reproject", lambda sale: self.reprojected.append(sale.source_url))
        monkeypatch.setattr(backlog, "_input_hash", lambda sale: "hash")
        monkeypatch.setattr(backlog, "documents_are_current", lambda sale: sale.source_url in self.current)
        monkeypatch.setattr(backlog, "_settled_documents", lambda sale: len(self.processed))

    def fetch(self, url):
        queue = self.sales[url]
        return queue.pop(0) if len(queue) > 1 else queue[0]

    def ensure(self, _db, url, _hash):
        self.ensured.append(url)
        return f"job:{url}"

    def state(self, _db, job_id):
        queue = self.states[job_id.removeprefix("job:")]
        return queue.pop(0) if len(queue) > 1 else queue[0]

    def counts(self, _db, url):
        queue = self.extracted.setdefault(url, [0])
        value = queue.pop(0) if len(queue) > 1 else queue[0]
        return {"extracted": value, "pending": 1}


def test_partial_manifest_is_continued_then_completed(monkeypatch) -> None:
    url = "https://example.test/a"
    before = _sale(url)
    after = _sale(url, occupancy_status="vacant")
    fake = _Fake(
        monkeypatch,
        {url: [before, before, after]},
        {url: [("queued", "PDF document manifest is partial; continue the next bounded pass"), ("completed", "")]},
    )
    fake.extracted[url] = [0, 2]

    outcome = backlog.drain_sale("db", {"source_url": url, "source_name": "vench"}, backlog.BacklogLimits(), 1e18)

    assert outcome.action == "processed"
    assert outcome.passes == 2
    assert fake.processed == [f"job:{url}", f"job:{url}"]
    assert outcome.new_facts == ["occupancy_status"]
    assert (outcome.documents_extracted_before, outcome.documents_extracted_after) == (0, 2)
    assert fake.reprojected == []  # a completed job already published the sale
    assert outcome.error is None


def test_a_superseded_pass_is_followed_to_the_newer_generation(monkeypatch) -> None:
    url = "https://example.test/superseded"
    stale = _sale(url, raw_payload={"document_facts_version": "document_facts_v4_occupancy_dates_prices"})
    fresh = _sale(url, occupancy_status="vacant")
    fake = _Fake(
        monkeypatch,
        {url: [stale, stale, stale, fresh]},
        {url: [("cancelled", "Superseded by a newer input revision"), ("completed", "")]},
    )

    outcome = backlog.drain_sale("db", {"source_url": url, "source_name": "avoventes"}, backlog.BacklogLimits(), 1e18)

    assert outcome.passes == 2
    assert fake.ensured == [url, url]  # the newer generation is (re)queued and processed
    assert outcome.new_facts == ["occupancy_status"]
    assert outcome.error is None


def test_a_cancelled_pass_for_another_reason_ends_the_sale(monkeypatch) -> None:
    url = "https://example.test/removed"
    stale = _sale(url, raw_payload={"document_facts_version": "document_facts_v4_occupancy_dates_prices"})
    fake = _Fake(monkeypatch, {url: [stale]}, {url: [("cancelled", "Listing removed, expired or explicitly cancelled")]})

    outcome = backlog.drain_sale("db", {"source_url": url, "source_name": "avoventes"}, backlog.BacklogLimits(), 1e18)

    assert outcome.passes == 1
    assert fake.ensured == [url]


def test_failed_pass_without_progress_is_recorded_and_republished(monkeypatch) -> None:
    url = "https://example.test/b"
    fake = _Fake(
        monkeypatch, {url: [_sale(url)]}, {url: [("failed", "Document extraction incomplete; retry required")]}
    )
    monkeypatch.setattr(backlog, "_settled_documents", lambda sale: 0)

    outcome = backlog.drain_sale("db", {"source_url": url, "source_name": "vench"}, backlog.BacklogLimits(), 1e18)

    assert outcome.passes == 1
    assert outcome.error.startswith("Document extraction incomplete")
    assert fake.reprojected == [url]


def test_current_documents_only_rewrite_the_projection(monkeypatch) -> None:
    url = "https://example.test/c"
    fake = _Fake(monkeypatch, {url: [_sale(url)]}, {url: [("completed", "")]})
    fake.current.add(url)

    outcome = backlog.drain_sale("db", {"source_url": url, "source_name": "vench"}, backlog.BacklogLimits(), 1e18)

    assert outcome.action == "reprojected"
    assert fake.processed == [] and fake.ensured == []
    assert fake.reprojected == [url]


def test_documents_read_with_older_rules_are_read_again(monkeypatch) -> None:
    url = "https://example.test/stale"
    stale = _sale(url, raw_payload={"document_facts_version": "document_facts_v4_occupancy_dates_prices"})
    fresh = _sale(url, occupancy_status="occupied")
    fake = _Fake(monkeypatch, {url: [stale, stale, fresh]}, {url: [("completed", "")]})
    fake.current.add(url)  # every document is read and cached

    outcome = backlog.drain_sale("db", {"source_url": url, "source_name": "vench"}, backlog.BacklogLimits(), 1e18)

    assert outcome.action == "processed"
    assert fake.ensured == [url] and fake.processed == [f"job:{url}"]
    assert outcome.new_facts == ["occupancy_status"]


def test_selection_passes_the_current_facts_version(monkeypatch) -> None:
    seen: list[tuple] = []

    class _Connection:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, parameters=None):
            if parameters is not None:
                seen.append(parameters)
            return self

        def fetchall(self):
            return []

    monkeypatch.setattr(backlog, "_connect", lambda _db: _Connection())
    assert backlog.select_backlog_candidates("db", 7) == []
    assert seen[0][2:] == (DOCUMENT_FACTS_VERSION, DOCUMENT_FACTS_VERSION, 7)


def test_one_failing_sale_never_stops_the_run(monkeypatch) -> None:
    good, bad = "https://example.test/good", "https://example.test/bad"
    fake = _Fake(
        monkeypatch, {good: [_sale(good)], bad: [_sale(bad)]}, {good: [("completed", "")], bad: [("completed", "")]}
    )
    original_ensure = fake.ensure

    def ensure(db, url, input_hash):
        if url == bad:
            raise RuntimeError("database hiccup")
        return original_ensure(db, url, input_hash)

    monkeypatch.setattr(backlog, "ensure_pdf_job", ensure)
    monkeypatch.setattr(backlog, "load_settings", lambda: {"supabase_db_url": "postgres://test"})
    monkeypatch.setattr(
        backlog,
        "select_backlog_candidates",
        lambda _db, limit: [
            {"source_url": bad, "source_name": "vench"},
            {"source_url": good, "source_name": "licitor"},
        ][:limit],
    )

    monkeypatch.setattr(backlog, "_catalogue_lock", _free_lock())
    report = backlog.run_document_backlog(backlog.BacklogLimits(max_sales=5))
    summary = report.as_dict()

    assert [item.source_url for item in report.outcomes] == [bad, good]
    assert report.outcomes[0].error == "database hiccup"
    assert summary["sales_with_errors"] == 1
    assert report.outcomes[0].action == "error"
    assert summary["sales_processed"] == 1
    assert summary["by_source"]["vench"]["errors"] == 1


def test_budget_stops_before_the_next_sale(monkeypatch) -> None:
    monkeypatch.setattr(backlog, "load_settings", lambda: {"supabase_db_url": "postgres://test"})
    monkeypatch.setattr(
        backlog, "select_backlog_candidates", lambda _db, limit: [{"source_url": "https://example.test/x"}]
    )
    monkeypatch.setattr(backlog, "drain_sale", lambda *args: pytest.fail("no sale may start after the budget"))

    report = backlog.run_document_backlog(backlog.BacklogLimits(budget_seconds=0))

    assert report.stop_reason == "budget" and report.outcomes == []


def test_missing_database_url_is_an_explicit_error(monkeypatch) -> None:
    monkeypatch.setattr(backlog, "load_settings", lambda: {})
    with pytest.raises(RuntimeError, match="SUPABASE_DB_URL"):
        backlog.run_document_backlog(backlog.BacklogLimits())


def test_step_summary_is_written_in_french(monkeypatch, tmp_path) -> None:
    summary_path = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_path))
    report = backlog.BacklogReport(
        outcomes=[
            backlog.SaleOutcome(
                source_url="u",
                source_name="avoventes",
                action="processed",
                documents_extracted_before=1,
                documents_extracted_after=4,
                new_facts=["occupancy_status"],
                seconds=12.0,
            )
        ]
    )

    backlog._write_step_summary(report.as_dict())

    text = summary_path.read_text(encoding="utf-8")
    assert "Documents lus : 3" in text
    assert "| avoventes | 1 | 3 | 0 |" in text
    assert "occupancy_status (1)" in text


def test_queue_batch_accepts_pre_claimed_jobs_without_claiming(monkeypatch) -> None:
    from src import queued_runner

    monkeypatch.setattr(
        queued_runner,
        "_claim_enrichment_queue_jobs",
        lambda **_kwargs: pytest.fail("pre-claimed jobs must not trigger a queue claim"),
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {})
    monkeypatch.setattr(queued_runner, "run_source_detail_jobs", lambda *args, **kwargs: 0)
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _url: None)
    finished: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queued_runner, "_finish_job", lambda job, **kwargs: finished.append((job["id"], kwargs)) or True
    )

    handled = queued_runner.run_enrichment_queue_batch(
        limit=1,
        family=queued_runner.ENRICHMENT_FAMILY,
        claimed_jobs=[{"id": "j1", "job_type": "pdf", "source_url": "https://example.test/gone"}],
    )

    assert handled == 1
    assert finished == [("j1", {"succeeded": False, "error_message": "sale not found"})]


def _free_lock(taken: list | None = None, *, lost_after: int | None = None):
    """A lock that is always free; with ``lost_after``, its heartbeat fails during that sale (1-based)."""
    from src.catalogue_lock import CatalogueLockHandle

    calls: list[int] = []

    @contextmanager
    def lock(db_url, wait_seconds):
        if taken is not None:
            taken.append(wait_seconds)
        calls.append(1)
        handle = CatalogueLockHandle("document backlog")
        if lost_after is not None and len(calls) == lost_after:
            handle.mark_lost()
        yield handle

    return lock


def _two_candidates(monkeypatch) -> None:
    monkeypatch.setattr(backlog, "load_settings", lambda: {"supabase_db_url": "postgres://test"})
    monkeypatch.setattr(
        backlog,
        "select_backlog_candidates",
        lambda _db, limit: [
            {"source_url": "https://a", "source_name": "vench"},
            {"source_url": "https://b", "source_name": "vench"},
        ],
    )
    monkeypatch.setattr(
        backlog,
        "drain_sale",
        lambda db, candidate, limits, deadline: backlog.SaleOutcome(
            source_url=candidate["source_url"], source_name="vench", action="processed"
        ),
    )


def test_the_catalogue_lock_is_taken_per_sale_with_the_remaining_budget(monkeypatch) -> None:
    _two_candidates(monkeypatch)
    taken: list[float] = []
    monkeypatch.setattr(backlog, "_catalogue_lock", _free_lock(taken))

    report = backlog.run_document_backlog(backlog.BacklogLimits(budget_seconds=600), sleep=lambda _s: None)

    assert len(report.outcomes) == 2
    assert len(taken) == 2
    assert all(60 <= wait <= 600 for wait in taken)


def test_the_drain_pauses_so_a_waiting_collection_takes_the_lock(monkeypatch) -> None:
    _two_candidates(monkeypatch)
    monkeypatch.setattr(backlog, "_catalogue_lock", _free_lock())
    monkeypatch.setattr(backlog, "LOCK_YIELD_EVERY_SECONDS", 0.0)
    pauses: list[float] = []

    backlog.run_document_backlog(backlog.BacklogLimits(budget_seconds=600), sleep=pauses.append)

    assert pauses == [backlog.LOCK_YIELD_PAUSE_SECONDS] * 2
    assert backlog.LOCK_YIELD_PAUSE_SECONDS > 15  # longer than the lock poll


def test_a_lock_that_never_frees_stops_the_drain_cleanly(monkeypatch) -> None:
    from src.catalogue_lock import CatalogueLockTimeout

    _two_candidates(monkeypatch)

    @contextmanager
    def busy(db_url, wait_seconds):
        raise CatalogueLockTimeout("busy")
        yield

    monkeypatch.setattr(backlog, "_catalogue_lock", busy)

    report = backlog.run_document_backlog(backlog.BacklogLimits(budget_seconds=600), sleep=lambda _s: None)

    assert report.outcomes == []
    assert report.stop_reason == "catalogue_lock"


def test_a_lost_lock_stops_the_drain_before_the_next_sale(monkeypatch) -> None:
    _two_candidates(monkeypatch)
    monkeypatch.setattr(backlog, "_catalogue_lock", _free_lock(lost_after=1))

    report = backlog.run_document_backlog(backlog.BacklogLimits(budget_seconds=600), sleep=lambda _s: None)

    assert [outcome.source_url for outcome in report.outcomes] == ["https://a"]
    assert report.stop_reason == backlog.LOCK_LOST_STOP_REASON


def test_a_lost_lock_fails_the_job_with_a_clear_message(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        backlog,
        "run_document_backlog",
        lambda _limits: backlog.BacklogReport(stop_reason=backlog.LOCK_LOST_STOP_REASON),
    )
    monkeypatch.setattr(backlog, "_run_document_reading", lambda: pytest.fail("nothing runs after a lost lock"))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)

    assert backlog.main([]) != 0
    assert "::error title=Verrou du catalogue perdu::" in capsys.readouterr().out
