"""Bounded manual drain of the attached-document backlog."""

from __future__ import annotations

from decimal import Decimal

import pytest

from src import document_backlog as backlog
from src.models import AuctionSale


def _sale(url: str, **fields: object) -> AuctionSale:
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
    assert "order by (s.sale_date is null), s.sale_date" in sql
    assert "(s.sale_date is null or s.sale_date >= now())" in sql
    assert "not in ('extracted', 'empty')" in sql
    claim = " ".join(backlog.CLAIM_JOB_SQL.split())
    assert "j.job_type = 'pdf'" in claim and "for update of j, s skip locked" in claim
    ensure = " ".join(backlog.ENSURE_JOB_SQL.split())
    assert "where auction_enrichment_jobs.status <> 'running'" in ensure


class _Fake:
    """In-memory stand-in for the database helpers of one drain."""

    def __init__(self, monkeypatch, sales: dict[str, list[AuctionSale | None]], states: dict[str, list[tuple[str, str]]]):
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


def test_failed_pass_without_progress_is_recorded_and_republished(monkeypatch) -> None:
    url = "https://example.test/b"
    fake = _Fake(monkeypatch, {url: [_sale(url)]}, {url: [("failed", "Document extraction incomplete; retry required")]})
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


def test_one_failing_sale_never_stops_the_run(monkeypatch) -> None:
    good, bad = "https://example.test/good", "https://example.test/bad"
    fake = _Fake(monkeypatch, {good: [_sale(good)], bad: [_sale(bad)]}, {good: [("completed", "")], bad: [("completed", "")]})
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
    monkeypatch.setattr(queued_runner, "_finish_job", lambda job, **kwargs: finished.append((job["id"], kwargs)) or True)

    handled = queued_runner.run_enrichment_queue_batch(
        limit=1,
        family=queued_runner.ENRICHMENT_FAMILY,
        claimed_jobs=[{"id": "j1", "job_type": "pdf", "source_url": "https://example.test/gone"}],
    )

    assert handled == 1
    assert finished == [("j1", {"succeeded": False, "error_message": "sale not found"})]
