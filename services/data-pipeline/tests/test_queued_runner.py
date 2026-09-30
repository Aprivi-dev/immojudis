import sys
import time
import types
from contextlib import nullcontext
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from src import pdf_enrichment
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
from src.freshness import document_fingerprint
from src.llm_task_deadline import LLMTaskDeadlineExceeded, llm_task_deadline_remaining
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.source_task_deadline import source_task_deadline_remaining

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

READ_DUE_ENRICHMENT_FAMILY_COUNTS = queued_runner._read_due_enrichment_family_counts


@pytest.fixture(autouse=True)
def no_active_running_run(monkeypatch) -> None:
    monkeypatch.setattr(queued_runner, "has_active_running_run_in_supabase", lambda: False)
    monkeypatch.setattr(queued_runner, "_read_due_enrichment_family_counts", lambda: {})


def test_queued_runner_skips_when_another_run_is_active(monkeypatch, capsys) -> None:
    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 1)
    monkeypatch.setattr(queued_runner, "has_active_running_run_in_supabase", lambda: True)

    assert queued_runner.main() == 0
    output = capsys.readouterr().out
    assert "already active" in output
    assert "Marked stale runs failed: 1" in output


def test_queued_runner_cleans_past_sales_without_queued_run(monkeypatch, capsys) -> None:
    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 2)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(
        queued_runner,
        "load_settings",
        lambda: {"pipeline_idle_llm_backfill_enabled": False, "pipeline_llm_backfill_max_targets": 20},
    )
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 3)

    assert queued_runner.main() == 0
    output = capsys.readouterr().out
    assert "Marked past sales: 3" in output
    assert "Marked stale runs failed: 2" in output


def test_queued_runner_can_backfill_llm_descriptions_when_idle(monkeypatch) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(
        queued_runner,
        "load_settings",
        lambda: {"pipeline_idle_llm_backfill_enabled": True, "pipeline_llm_backfill_max_targets": 7},
    )
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_backfill(options):
        captured["llm_backfill"] = options.llm_backfill
        captured["limit"] = options.limit
        captured["upsert"] = options.upsert
        return 0

    monkeypatch.setattr(queued_runner, "run_llm_description_backfill", fake_backfill)

    assert queued_runner.main() == 0
    assert captured == {"llm_backfill": True, "limit": 7, "upsert": True}


def test_queued_runner_processes_queued_llm_backfill_run(monkeypatch, capsys) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(
        queued_runner,
        "fetch_next_queued_run_from_supabase",
        lambda: {
            "id": "run-backfill",
            "source": "llm-description-backfill",
            "summary": {"limit": 11},
        },
    )
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_backfill(options):
        captured["run_id"] = options.run_id
        captured["llm_backfill"] = options.llm_backfill
        captured["use_llm"] = options.use_llm
        captured["limit"] = options.limit
        return 0

    monkeypatch.setattr(queued_runner, "run_llm_description_backfill", fake_backfill)

    assert queued_runner.main() == 0
    assert captured == {
        "run_id": "run-backfill",
        "llm_backfill": True,
        "use_llm": True,
        "limit": 11,
    }
    assert "LLM description backfill" in capsys.readouterr().out


def test_queued_runner_defaults_missing_llm_flag_to_automatic(monkeypatch, capsys) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: {"id": "run-1", "source": "all"})
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_run_pipeline(options):
        captured["use_llm"] = options.use_llm
        captured["heavy_enrichment"] = options.heavy_enrichment
        return 0

    monkeypatch.setattr(queued_runner, "run_pipeline", fake_run_pipeline)

    assert queued_runner.main() == 0
    assert captured == {"use_llm": True, "heavy_enrichment": True}
    assert "llm=True" in capsys.readouterr().out


def test_queued_runner_respects_disabled_llm_on_queued_scroll(monkeypatch, capsys) -> None:
    captured = {}

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(
        queued_runner,
        "fetch_next_queued_run_from_supabase",
        lambda: {"id": "run-legacy", "source": "all", "use_llm": False},
    )
    monkeypatch.setattr(queued_runner, "fetch_next_data_refresh_request_from_supabase", lambda: None)
    monkeypatch.setattr(queued_runner, "mark_past_sales_in_supabase", lambda: 0)

    def fake_run_pipeline(options):
        captured["use_llm"] = options.use_llm
        captured["heavy_enrichment"] = options.heavy_enrichment
        return 0

    monkeypatch.setattr(queued_runner, "run_pipeline", fake_run_pipeline)

    assert queued_runner.main() == 0
    assert captured == {"use_llm": False, "heavy_enrichment": False}
    assert "llm=False" in capsys.readouterr().out


def test_queued_runner_processes_data_refresh_when_no_full_run(monkeypatch, capsys) -> None:
    finished = []
    calls = []
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/sale",
        city="Bordeaux",
        latitude=44.84,
        longitude=-0.57,
    )

    monkeypatch.setattr(queued_runner, "fail_stale_running_runs_in_supabase", lambda: 0)
    monkeypatch.setattr(queued_runner, "fetch_next_queued_run_from_supabase", lambda: None)
    monkeypatch.setattr(
        queued_runner,
        "fetch_next_data_refresh_request_from_supabase",
        lambda: {
            "id": "refresh-1",
            "source_url": "https://example.test/sale",
            "request_kind": "full",
        },
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"cadastre_api_url": "https://cadastre.test"})
    monkeypatch.setattr(
        queued_runner,
        "enrich_cadastre_sales",
        lambda sales, settings: calls.append(("cadastre", sales[0].source_url)) or [{"source_url": sales[0].source_url}],
    )
    monkeypatch.setattr(
        queued_runner,
        "enrich_dpe_sales",
        lambda sales, settings: calls.append(("dpe", sales[0].source_url)) or [{"source_url": sales[0].source_url}],
    )
    monkeypatch.setattr(queued_runner, "upsert_cadastre_parcels_to_supabase", lambda rows: len(rows))
    monkeypatch.setattr(queued_runner, "upsert_dpe_diagnostics_to_supabase", lambda rows: len(rows))
    monkeypatch.setattr(
        queued_runner,
        "finish_data_refresh_request_in_supabase",
        lambda request_id, status, summary=None, error_message=None: finished.append(
            (request_id, status, summary, error_message)
        ),
    )

    assert queued_runner.main() == 0
    assert calls == [
        ("cadastre", "https://example.test/sale"),
        ("dpe", "https://example.test/sale"),
    ]
    assert finished == [
        (
            "refresh-1",
            "completed",
            {
                "runner": "data_refresh_queue",
                "request_kind": "full",
                "source_url": "https://example.test/sale",
                "cadastre_rows": 1,
                "cadastre_upserted": 1,
                "dpe_rows": 1,
                "dpe_upserted": 1,
            },
            None,
        )
    ]
    assert "Completed Immojudis data refresh: refresh-1" in capsys.readouterr().out


def test_enrichment_queue_runs_pdf_before_fact_extraction_and_completes_jobs(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/enrichment-success",
            "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
        }
    )
    calls: list[str] = []
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {"id": "job-pdf", "source_url": sale.source_url, "job_type": "pdf"},
            {"id": "job-facts", "source_url": sale.source_url, "job_type": "fact_extraction"},
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    # This ordering test mocks the extractor itself; the progression and
    # strict-manifest contract is covered by the bounded-pass tests.
    monkeypatch.setattr(queued_runner, "manifest_is_complete", lambda *_args: True)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", lambda current: calls.append("pdf") or SimpleNamespace(errors=0))
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda current, client, **kwargs: calls.append("facts_then_display")
            or current.raw_payload.update({"llm_display_description": "Description vérifiée. " * 5, "llm_display_quality_version": DISPLAY_QUALITY_VERSION, "llm_display_status": "accepted", "llm_prompt_version": queued_runner.load_settings()["llm_prompt_version"], "llm_display_prompt_version": "auction_display_v9_public_summary", "llm_fact_coverage": {"complete": True}})
        or SimpleNamespace(unavailable=False, valid_json=1, error_messages=[]),
    )
    monkeypatch.setattr(queued_runner, "geocode_sale", lambda current: calls.append("geocode"))
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: calls.append("normalize"))
    monkeypatch.setattr(
        queued_runner,
        "upsert_sales_to_supabase",
        lambda sales, refresh_last_seen: calls.append("upsert") or len(sales),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=10) == 2
    assert calls == ["pdf", "facts_then_display", "geocode", "normalize", "upsert"]
    assert finished == [("job-pdf", True, None), ("job-facts", True, None)]


def test_enrichment_queue_reuses_verified_facts_when_ephemeral_pdf_cache_is_missing(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/verified-facts-cache-loss",
            "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
        }
    )
    sale.raw_payload.update(
        {
            "llm_display_description": "Description documentaire déjà vérifiée. " * 5,
            "source_content_changed": False,
        }
    )
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [{"id": "job-facts", "source_url": sale.source_url, "job_type": "fact_extraction"}],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda current: None)
    monkeypatch.setattr(queued_runner, "needs_fact_extraction", lambda current: True)
    monkeypatch.setattr(queued_runner, "has_current_fact_analysis", lambda current: True)
    monkeypatch.setattr(queued_runner, "documents_are_current", lambda current: False)
    monkeypatch.setattr(queued_runner, "has_eligible_pdf_job_for_sale", lambda source_url: False)
    monkeypatch.setattr(queued_runner, "_needs_llm_display_description_refresh", lambda *args, **kwargs: False)
    monkeypatch.setattr(
        queued_runner,
        "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("verified facts must not invoke the LLM")),
    )
    monkeypatch.setattr(queued_runner, "fill_tribunal", lambda current: None)
    monkeypatch.setattr(queued_runner, "classify_sale_procedure", lambda current: None)
    monkeypatch.setattr(queued_runner, "geocode_sale", lambda current: None)
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: None)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda sales, refresh_last_seen: len(sales))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1) == 1
    assert finished == [("job-facts", True, None)]


def test_enrichment_queue_cancels_preexisting_terminal_pdf_fact_job_without_llm(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/terminal-facts",
            "documents": [{"label": "PV", "url": "https://www.licitor.com/data/pv.pdf"}],
        }
    )
    document_url = sale.documents[0]["url"]
    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": document_fingerprint(sale.documents),
        # Candidate filtering can produce a terminal skipped-only result
        # without a positive listed count, while the sale still has URLs.
        "documents_listed": 0,
        "documents_extracted": 0,
        "failed_documents": 0,
        "blocked_documents": 0,
        "blocked_document_urls": [],
        "blocked_document_reasons": [],
        "skipped_documents": 1,
        "skipped_document_urls": [document_url],
        "skipped_document_reasons": [{"url": document_url, "reason": "candidate_rejected"}],
        "terminal_document_urls": [],
        "coverage_status": "partial",
    }
    finished: list[tuple[str, bool, str | None, bool]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [{"id": "job-facts", "source_url": sale.source_url, "job_type": "fact_extraction"}],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda current: None)
    monkeypatch.setattr(
        queued_runner,
        "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("terminal PDF facts must not invoke the LLM")),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None, cancelled=False: finished.append(
            (job_id, succeeded, error_message, cancelled)
        ),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1) == 1
    assert finished == [
        ("job-facts", False, "review_required: no extractable PDF evidence", True)
    ]


def test_enrichment_queue_cancels_terminal_facts_but_keeps_display_independent(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/terminal-pdf-batch",
            "documents": [{"label": "PV", "url": "https://www.licitor.com/data/pv.pdf"}],
        }
    )
    document_url = sale.documents[0]["url"]
    calls: list[str] = []
    finished: list[tuple[str, bool, str | None, bool]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {"id": "job-pdf", "source_url": sale.source_url, "job_type": "pdf"},
            {"id": "job-facts", "source_url": sale.source_url, "job_type": "fact_extraction"},
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)

    def terminal_pdf(current_sale):
        calls.append("pdf")
        current_sale.raw_payload["document_analysis"] = {
            "checked_at": datetime.now(UTC).isoformat(),
            "input_fingerprint": document_fingerprint(current_sale.documents),
            "progress_schema_version": 1,
            "manifest_complete": True,
            "documents_listed": 1,
            "documents_extracted": 0,
            "failed_documents": 0,
            "blocked_documents": 1,
            "blocked_document_urls": [document_url],
            "blocked_document_reasons": [{"url": document_url, "reason": "robots"}],
            "skipped_documents": 0,
            "skipped_document_urls": [],
            "terminal_document_urls": [],
            "coverage_status": "partial",
        }
        return SimpleNamespace(errors=0)

    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", terminal_pdf)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda current: None)
    monkeypatch.setattr(
        queued_runner,
        "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("PDF-only terminal batch must not invoke the LLM")),
    )
    monkeypatch.setattr(queued_runner, "geocode_sale", lambda current: None)
    monkeypatch.setattr(queued_runner, "fill_tribunal", lambda current: None)
    monkeypatch.setattr(queued_runner, "classify_sale_procedure", lambda current: None)
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: None)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda sales, refresh_last_seen: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None, cancelled=False: finished.append(
            (job_id, succeeded, error_message, cancelled)
        ),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=2) == 2
    assert calls == ["pdf", "upsert"]
    assert finished == [
        ("job-facts", False, "review_required: no extractable PDF evidence", True),
        ("job-pdf", True, None, False),
    ]


def test_enrichment_queue_completes_pdf_job_when_documents_are_policy_blocked(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/policy-blocked",
            "documents": [{
                "label": "PV descriptif",
                "url": "https://www.licitor.com/data/pub/media/annonce/pv.pdf",
            }],
        }
    )
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [{"id": "job-pdf", "source_url": sale.source_url, "job_type": "pdf"}],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)

    def policy_blocked_pdf(current_sale):
        current_sale.raw_payload["document_analysis"] = {
            "checked_at": datetime.now(UTC).isoformat(),
            "input_fingerprint": document_fingerprint(current_sale.documents),
            "progress_schema_version": 1,
            "manifest_complete": True,
            "failed_documents": 0,
            "failed_document_urls": [],
            "blocked_documents": 1,
            "blocked_document_urls": [current_sale.documents[0]["url"]],
            "blocked_document_reasons": [{
                "url": current_sale.documents[0]["url"],
                "reason": "robots.txt disallows fetching this Licitor document",
            }],
            "skipped_document_urls": [],
            "terminal_document_urls": [],
            "coverage_status": "partial",
        }
        return SimpleNamespace(errors=0)

    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", policy_blocked_pdf)
    monkeypatch.setattr(queued_runner, "geocode_sale", lambda current: None)
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: None)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda sales, refresh_last_seen: len(sales))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1) == 1
    assert finished == [("job-pdf", True, None)]


def test_enrichment_queue_marks_every_sale_job_failed_on_extraction_error(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/enrichment-failure",
        }
    )
    finished: list[tuple[str, bool, str | None]] = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {"id": "job-facts", "source_url": sale.source_url, "job_type": "fact_extraction"},
            {"id": "job-display", "source_url": sale.source_url, "job_type": "display_description"},
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda current, client, **kwargs: SimpleNamespace(
            unavailable=False,
            valid_json=0,
            error_messages=["invalid structured response"],
        ),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=10) == 2
    assert finished == [
        ("job-facts", False, "invalid structured response"),
        ("job-display", False, "invalid structured response"),
    ]


def test_enrichment_queue_does_not_pay_twice_for_scan_description(monkeypatch) -> None:
    prompt_version = "auction_llm_v10_structured_display"
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/already-summarized",
        description="Appartement de 42 m² situé à Bordeaux.",
            raw_payload={
                "llm_display_description": "Appartement de 42 m² situé à Bordeaux. " * 3,
                "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
                "llm_display_status": "accepted",
                "llm_prompt_version": prompt_version,
                "llm_display_prompt_version": "auction_display_v9_public_summary",
            },
    )
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {
                "id": "job-display",
                "source_url": sale.source_url,
                "job_type": "display_description",
            }
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(
        queued_runner,
        "load_settings",
        lambda: {
            "llm_extraction_mode": "display_description",
            "llm_prompt_version": prompt_version,
        },
    )
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Replicate must not be called twice")),
    )
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: current)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda sales, refresh_last_seen: len(sales))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=10) == 1
    assert finished == [("job-display", True, None)]


def test_enrichment_queue_replays_fact_claims_without_llm_or_catalogue_write(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://example.test/fact-claims-retry",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    replayed: list[str] = []
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {
                "id": "job-fact-claims",
                "source_url": sale.source_url,
                "job_type": "fact_claims",
            }
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    # A sale can pass the retention boundary after its job was leased. Its
    # source observation still needs to be persisted before the lease ends.
    monkeypatch.setattr(queued_runner, "is_expired", lambda current: True)
    monkeypatch.setattr(
        queued_runner,
        "retry_fact_claims_to_supabase",
        lambda current: replayed.append(current.source_url) or 1,
    )
    monkeypatch.setattr(
        queued_runner,
        "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("fact claim replay must not invoke the LLM")),
    )
    monkeypatch.setattr(
        queued_runner,
        "upsert_sales_to_supabase",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("fact claim replay must not rewrite catalogue")),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1) == 1
    assert replayed == [sale.source_url]
    assert finished == [("job-fact-claims", True, None)]


def test_enrichment_queue_does_not_complete_mixed_claim_job_when_replay_fails(monkeypatch) -> None:
    prompt_version = "fact-claims-mixed-test"
    fact_claim_snapshot = [
        {
            "field_key": "property.occupancy_status",
            "value_jsonb": "vacant",
            "source_url": "https://example.test/fact-claims-mixed-retry",
            "evidence_locator": {"field": "occupation"},
            "evidence_kind": "source_listing",
        }
    ]
    sale = AuctionSale(
        source_name="info_encheres",
        source_url="https://example.test/fact-claims-mixed-retry",
        description="Maison libre de toute occupation.",
        latitude=44.84,
        longitude=-0.57,
        raw_payload={
            "llm_display_description": "Description finale vérifiée. " * 5,
            "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
            "llm_display_status": "accepted",
            "llm_prompt_version": prompt_version,
            "llm_display_prompt_version": "auction_display_v9_public_summary",
        },
    )
    finished: list[tuple[str, bool, str | None]] = []
    replay_kwargs: list[dict[str, object]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: [
            {
                "id": "job-fact-claims",
                "source_url": sale.source_url,
                "job_type": "fact_claims",
                "fact_claims_snapshot": fact_claim_snapshot,
            },
            {
                "id": "job-display",
                "source_url": sale.source_url,
                "job_type": "display_description",
            },
        ],
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda source_url: sale)
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": prompt_version})
    monkeypatch.setattr(
        queued_runner,
        "retry_fact_claims_to_supabase",
        lambda current, **kwargs: replay_kwargs.append(kwargs)
        or (_ for _ in ()).throw(RuntimeError("claim replay unavailable")),
    )
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("display is already current")),
    )
    monkeypatch.setattr(queued_runner, "fill_tribunal", lambda current: None)
    monkeypatch.setattr(queued_runner, "classify_sale_procedure", lambda current: None)
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda current: None)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda sales, refresh_last_seen: len(sales))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None: finished.append((job_id, succeeded, error_message)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=2) == 2
    assert finished == [
        ("job-fact-claims", False, "claim replay unavailable"),
        ("job-display", True, None),
    ]
    assert replay_kwargs == [{"snapshot": fact_claim_snapshot}]


def test_enrichment_worker_uses_five_to_one_lane_cycle(monkeypatch) -> None:
    calls: list[tuple[int, str]] = []

    def fake_batch(*, limit: int, family: str, provider_clients: dict | None = None) -> int:
        calls.append((limit, family))
        return 1

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner.run_enrichment_queue_worker(max_jobs=6, budget_seconds=1200) == 6
    assert calls == [
        (2, queued_runner.SOURCE_DETAIL_FAMILY),
        (2, queued_runner.SOURCE_DETAIL_FAMILY),
        (2, queued_runner.SOURCE_DETAIL_FAMILY),
        (2, queued_runner.SOURCE_DETAIL_FAMILY),
        (1, queued_runner.SOURCE_DETAIL_FAMILY),
        (1, queued_runner.ENRICHMENT_FAMILY),
    ]


def test_due_lane_count_timeout_falls_back_without_stalling_worker(monkeypatch) -> None:
    commands: list[str] = []

    def execute(sql: str):
        commands.append(sql.strip().lower())
        if sql.lstrip().lower().startswith("select"):
            raise TimeoutError("statement timeout")
        return None

    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://local"})
    monkeypatch.setattr(
        queued_runner,
        "_postgres_connect",
        lambda db_url, **kwargs: nullcontext(SimpleNamespace(execute=execute)),
    )

    assert READ_DUE_ENRICHMENT_FAMILY_COUNTS() == {}
    assert commands[:3] == [
        "set transaction read only",
        "set local lock_timeout = '1000ms'",
        "set local statement_timeout = '3000ms'",
    ]
    assert commands[3].startswith("select case when job_type")
    assert queued_runner._enrichment_family_cycle({}) == queued_runner.ENRICHMENT_FAMILY_CYCLE


def test_worker_claim_status_snapshot_reads_unique_ids_without_retries(monkeypatch) -> None:
    calls: list[tuple[str, object]] = []

    def execute(sql: str, params=None):
        calls.append((sql.strip().lower(), params))
        if sql.lstrip().lower().startswith("select status"):
            return SimpleNamespace(
                fetchall=lambda: [("completed", 1), ("failed", 1), ("queued", 1)]
            )
        return SimpleNamespace(fetchall=lambda: [])

    connection = SimpleNamespace(execute=execute)
    connect_kwargs = {}
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://local"})

    def connect(db_url: str, **kwargs):
        connect_kwargs.update(kwargs)
        return nullcontext(connection)

    monkeypatch.setattr(queued_runner, "_postgres_connect", connect)

    assert queued_runner._read_worker_claim_status_counts({"job-b", "job-a"}) == {
        "completed": 1,
        "failed": 1,
        "queued": 1,
    }
    assert connect_kwargs == {"connect_timeout": 3, "retry_delays": ()}
    assert [sql for sql, _ in calls[:3]] == [
        "set transaction read only",
        "set local lock_timeout = '1000ms'",
        "set local statement_timeout = '3000ms'",
    ]
    query, params = calls[3]
    assert query.startswith("select status, count(*)")
    assert "where id = any(%s::uuid[])" in query
    assert params == (["job-a", "job-b"],)


def test_worker_claim_status_snapshot_failure_is_optional(monkeypatch) -> None:
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://local"})
    monkeypatch.setattr(
        queued_runner,
        "_postgres_connect",
        lambda db_url, **kwargs: (_ for _ in ()).throw(TimeoutError("snapshot timeout")),
    )

    assert queued_runner._read_worker_claim_status_counts({"job-a"}) is None


def test_worker_claim_status_snapshot_cannot_mask_worker_exception(monkeypatch) -> None:
    worker_error = RuntimeError("worker failed")

    def fail_worker(**kwargs):
        raise worker_error

    monkeypatch.setattr(queued_runner, "_run_enrichment_queue_worker", fail_worker)
    monkeypatch.setattr(
        queued_runner,
        "_log_worker_claim_status_snapshot",
        lambda job_ids: (_ for _ in ()).throw(RuntimeError("telemetry failed")),
    )

    with pytest.raises(RuntimeError, match="worker failed"):
        queued_runner.run_enrichment_queue_worker(max_jobs=1, budget_seconds=60)
    assert queued_runner._WORKER_CLAIMED_JOB_IDS.get() is None


def test_worker_reports_handled_jobs_and_isolates_claim_snapshot_context(monkeypatch, caplog) -> None:
    snapshots: list[set[str]] = []
    run_calls = iter([2, 0, 0])
    claim_results = iter([
        [{"id": "job-a"}, {"id": "job-b"}],
        [],
        [],
    ])

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda **kwargs: next(claim_results),
    )

    def fake_batch(**kwargs) -> int:
        count = next(run_calls)
        queued_runner._claim_enrichment_queue_jobs(
            limit=kwargs["limit"],
            family=kwargs["family"],
        )
        return count

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)
    monkeypatch.setattr(
        queued_runner,
        "_read_worker_claim_status_counts",
        lambda job_ids: snapshots.append(set(job_ids))
        or {"completed": 1, "failed": 1},
    )
    monkeypatch.setenv("GITHUB_RUN_ID", "run-398")

    with caplog.at_level("INFO", logger=queued_runner.LOGGER.name):
        assert queued_runner.run_enrichment_queue_worker(max_jobs=2, budget_seconds=1200) == 2
        assert queued_runner.run_enrichment_queue_worker(max_jobs=1, budget_seconds=1200) == 0

    summary = next(
        record.getMessage()
        for record in caplog.records
        if "Enrichment worker summary" in record.getMessage()
    )
    assert "github_run_id=run-398" in summary
    assert "handled=2" in summary
    assert "handled_source_detail=2" in summary
    assert "completed=2" not in summary
    snapshot = next(
        record.getMessage()
        for record in caplog.records
        if "claim status snapshot:" in record.getMessage()
        and "unavailable" not in record.getMessage()
    )
    assert "observed_status_completed=1" in snapshot
    assert "observed_status_failed=1" in snapshot
    assert snapshots == [{"job-a", "job-b"}]
    assert queued_runner._WORKER_CLAIMED_JOB_IDS.get() is None
    assert any(
        "claimed_jobs=0 snapshot=not_applicable" in record.getMessage()
        for record in caplog.records
    )


def test_enrichment_worker_groups_detail_claims_without_exceeding_job_budget(monkeypatch) -> None:
    calls: list[tuple[int, str]] = []

    def fake_batch(*, limit: int, family: str, provider_clients: dict | None = None) -> int:
        calls.append((limit, family))
        return limit

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner.run_enrichment_queue_worker(max_jobs=6, budget_seconds=1200) == 6
    assert calls == [
        (2, queued_runner.SOURCE_DETAIL_FAMILY),
        (2, queued_runner.SOURCE_DETAIL_FAMILY),
        (1, queued_runner.SOURCE_DETAIL_FAMILY),
        (1, queued_runner.ENRICHMENT_FAMILY),
    ]


def test_enrichment_worker_reliefs_larger_general_backlog_without_starving_details(monkeypatch) -> None:
    calls: list[tuple[int, str]] = []
    monkeypatch.setattr(
        queued_runner,
        "_read_due_enrichment_family_counts",
        lambda: {
            queued_runner.SOURCE_DETAIL_FAMILY: 2_586,
            queued_runner.ENRICHMENT_FAMILY: 3_386,
        },
    )

    def fake_batch(*, limit: int, family: str, provider_clients: dict | None = None) -> int:
        calls.append((limit, family))
        return limit

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner.run_enrichment_queue_worker(max_jobs=8, budget_seconds=1200) == 8
    assert [family for _, family in calls] == [
        queued_runner.SOURCE_DETAIL_FAMILY,
        queued_runner.ENRICHMENT_FAMILY,
    ] * 4
    assert all(limit == 1 for limit, _ in calls)
    assert sum(family == queued_runner.SOURCE_DETAIL_FAMILY for _, family in calls) == 4
    assert sum(family == queued_runner.ENRICHMENT_FAMILY for _, family in calls) == 4
    assert len(calls) == 8


def test_enrichment_family_cycle_keeps_historical_ratio_when_details_are_larger() -> None:
    cycle = queued_runner._enrichment_family_cycle(
        {
            queued_runner.SOURCE_DETAIL_FAMILY: 3_386,
            queued_runner.ENRICHMENT_FAMILY: 2_586,
        }
    )

    assert cycle == queued_runner.ENRICHMENT_FAMILY_CYCLE
    assert cycle.count(queued_runner.SOURCE_DETAIL_FAMILY) == 5
    assert cycle.count(queued_runner.ENRICHMENT_FAMILY) == 1


def test_enrichment_worker_can_fallback_to_detail_when_relief_general_slot_is_empty(monkeypatch) -> None:
    calls: list[tuple[int, str]] = []
    monkeypatch.setattr(
        queued_runner,
        "_read_due_enrichment_family_counts",
        lambda: {
            queued_runner.SOURCE_DETAIL_FAMILY: 10,
            queued_runner.ENRICHMENT_FAMILY: 20,
        },
    )

    def fake_batch(*, limit: int, family: str, provider_clients: dict | None = None) -> int:
        calls.append((limit, family))
        return 0 if family == queued_runner.ENRICHMENT_FAMILY else limit

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner.run_enrichment_queue_worker(max_jobs=2, budget_seconds=1200) == 2
    assert calls == [
        (1, queued_runner.SOURCE_DETAIL_FAMILY),
        (1, queued_runner.ENRICHMENT_FAMILY),
        (1, queued_runner.SOURCE_DETAIL_FAMILY),
    ]


def test_worker_stops_general_claims_after_llm_budget_exhaustion_and_keeps_caps(monkeypatch) -> None:
    calls: list[tuple[int, str]] = []
    budget_exhausted = False
    monkeypatch.setattr(
        queued_runner,
        "_read_due_enrichment_family_counts",
        lambda: {
            queued_runner.SOURCE_DETAIL_FAMILY: 10,
            queued_runner.ENRICHMENT_FAMILY: 20,
        },
    )

    def fake_batch(*, limit: int, family: str, provider_clients: dict | None = None) -> int:
        nonlocal budget_exhausted
        calls.append((limit, family))
        if family == queued_runner.ENRICHMENT_FAMILY:
            assert not budget_exhausted
            budget_exhausted = True
            # This is the state set by run_enrichment_queue_batch after it
            # restores the claimed general jobs for a provider budget stop.
            queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.set(True)
        return 1

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert (
        queued_runner.run_enrichment_queue_worker(
            max_jobs=queued_runner.ENRICHMENT_MAX_JOBS + 10,
            budget_seconds=queued_runner.ENRICHMENT_BUDGET_SECONDS + 10,
        )
        == queued_runner.ENRICHMENT_MAX_JOBS
    )
    assert len(calls) == queued_runner.ENRICHMENT_MAX_JOBS
    assert calls[0][1] == queued_runner.SOURCE_DETAIL_FAMILY
    assert calls[1][1] == queued_runner.ENRICHMENT_FAMILY
    assert sum(family == queued_runner.ENRICHMENT_FAMILY for _, family in calls) == 1
    assert all(family == queued_runner.SOURCE_DETAIL_FAMILY for _, family in calls[2:])
    assert all(limit == 1 for limit, _ in calls)
    assert queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.get() is None


def test_worker_budget_breaker_uses_real_batch_and_keeps_detail_claims(monkeypatch, caplog) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/worker-budget-breaker",
            "description": "Maison",
        }
    )
    general_job = {
        "id": "general-budget-job",
        "source_url": sale.source_url,
        "job_type": "display_description",
        "attempt_count": 2,
        "locked_at": "2026-09-30T08:00:00+00:00",
    }
    claim_calls: list[tuple[str, int]] = []
    deferred: list[tuple[list[dict[str, object]], BaseException]] = []
    detail_number = 0
    general_claims = 0

    monkeypatch.setattr(
        queued_runner,
        "_read_due_enrichment_family_counts",
        lambda: {
            queued_runner.SOURCE_DETAIL_FAMILY: 10,
            queued_runner.ENRICHMENT_FAMILY: 20,
        },
    )

    def claim(*, family: str, limit: int) -> list[dict[str, object]]:
        nonlocal detail_number, general_claims
        claim_calls.append((family, limit))
        if family == queued_runner.ENRICHMENT_FAMILY:
            general_claims += 1
            if general_claims > 1:
                raise AssertionError("general lane was claimed after budget exhaustion")
            return [general_job]
        detail_number += 1
        return [
            {
                "id": f"detail-{detail_number}",
                "source_url": f"https://example.test/detail-{detail_number}",
                "job_type": queued_runner.SOURCE_DETAIL_FAMILY,
                "attempt_count": 1,
                "locked_at": "2026-09-30T08:00:00+00:00",
            }
        ]

    monkeypatch.setattr(queued_runner, "claim_auction_enrichment_jobs_family_from_supabase", claim)
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)
    monkeypatch.setattr(queued_runner, "needs_fact_extraction", lambda _: False)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            queued_runner.LLMRequestBudgetExhausted("Hourly request limit reached")
        ),
    )
    monkeypatch.setattr(
        queued_runner,
        "run_source_detail_jobs",
        lambda jobs, *, settings, clients, on_deferred=None: len(jobs),
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs, error: deferred.append((jobs, error)),
    )
    # Keep the assertion on actual transitions separate from terminal status:
    # an unavailable read must not invent completed jobs.
    monkeypatch.setattr(queued_runner, "_read_worker_claim_status_counts", lambda _: None)

    with caplog.at_level("INFO", logger=queued_runner.LOGGER.name):
        assert queued_runner.run_enrichment_queue_worker(max_jobs=4, budget_seconds=1200) == 4

    assert [family for family, _ in claim_calls] == [
        queued_runner.SOURCE_DETAIL_FAMILY,
        queued_runner.ENRICHMENT_FAMILY,
        queued_runner.SOURCE_DETAIL_FAMILY,
        queued_runner.SOURCE_DETAIL_FAMILY,
    ]
    assert general_claims == 1
    assert len(deferred) == 1
    assert deferred[0][0] == [general_job]
    assert isinstance(deferred[0][1], queued_runner.LLMRequestBudgetExhausted)
    assert general_job["attempt_count"] == 2
    assert general_job["locked_at"] == "2026-09-30T08:00:00+00:00"
    outcome = next(
        record.getMessage()
        for record in caplog.records
        if "Enrichment worker outcome summary" in record.getMessage()
    )
    assert "claimed=4" in outcome
    assert "deferred_requested=1" in outcome
    assert "status_snapshot=unavailable" in outcome
    assert "completed=" not in outcome
    assert queued_runner._WORKER_CLAIMED_JOB_IDS.get() is None
    assert queued_runner._WORKER_DEFERRED_JOB_IDS.get() is None
    assert queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.get() is None


def test_worker_does_not_fallback_to_general_after_budget_breaker_when_details_empty(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        queued_runner,
        "_read_due_enrichment_family_counts",
        lambda: {
            queued_runner.SOURCE_DETAIL_FAMILY: 10,
            queued_runner.ENRICHMENT_FAMILY: 20,
        },
    )

    def fake_batch(*, limit: int, family: str, provider_clients: dict | None = None) -> int:
        calls.append(family)
        if family == queued_runner.ENRICHMENT_FAMILY:
            queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.set(True)
            return 1
        return 0

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner.run_enrichment_queue_worker(max_jobs=2, budget_seconds=1200) == 1
    assert calls == [
        queued_runner.SOURCE_DETAIL_FAMILY,
        queued_runner.ENRICHMENT_FAMILY,
        queued_runner.SOURCE_DETAIL_FAMILY,
    ]
    assert queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.get() is None


def test_worker_outcome_summary_separates_statuses_from_deferred_requests(caplog) -> None:
    deferred_token = queued_runner._WORKER_DEFERRED_JOB_IDS.set({"job-b", "job-d"})
    try:
        with caplog.at_level("INFO", logger=queued_runner.LOGGER.name):
            queued_runner._log_worker_outcome_summary(
                {"job-a", "job-b", "job-c", "job-d"},
                {"completed": 1, "failed": 1, "cancelled": 1, "queued": 1},
            )
    finally:
        queued_runner._WORKER_DEFERRED_JOB_IDS.reset(deferred_token)

    summary = next(
        record.getMessage()
        for record in caplog.records
        if "Enrichment worker outcome summary" in record.getMessage()
    )
    assert "claimed=4" in summary
    assert "completed=1" in summary
    assert "failed=1" in summary
    assert "cancelled=1" in summary
    assert "deferred_requested=2" in summary
    assert "observed_queued=1" in summary
    assert "missing=0" in summary


def test_source_detail_claim_batch_size_is_bounded_and_invalid_values_are_safe(monkeypatch) -> None:
    monkeypatch.setenv("PIPELINE_ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE", "99")
    assert queued_runner._enrichment_claim_batch_size(queued_runner.SOURCE_DETAIL_FAMILY) == 5

    monkeypatch.setenv("PIPELINE_ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE", "invalid")
    assert queued_runner._enrichment_claim_batch_size(queued_runner.SOURCE_DETAIL_FAMILY) == 2
    assert queued_runner._enrichment_claim_batch_size(queued_runner.ENRICHMENT_FAMILY) == 1


def test_enrichment_worker_logs_lane_counts_and_stop_reason(monkeypatch, caplog) -> None:
    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", lambda **kwargs: 0)

    with caplog.at_level("INFO", logger=queued_runner.LOGGER.name):
        assert queued_runner.run_enrichment_queue_worker(max_jobs=1, budget_seconds=1200) == 0

    summary = next(record.getMessage() for record in caplog.records if "Enrichment worker summary" in record.getMessage())
    assert "handled=0" in summary
    assert "handled_source_detail=0" in summary
    assert "handled_enrichment=0" in summary
    assert "claim_batches=2" in summary
    assert "stop=queues_empty" in summary


def test_worker_pdf_deadline_is_scoped_and_leaves_finalization_margin(monkeypatch) -> None:
    observed_remaining: list[float | None] = []

    def fake_batch(**_kwargs) -> int:
        observed_remaining.append(pdf_enrichment.pdf_deadline_remaining())
        return 0

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner._run_enrichment_queue_worker(max_jobs=1, budget_seconds=1200) == 0
    assert observed_remaining
    assert all(
        value is not None
        and 0 < value <= 1200 - queued_runner._pdf_finalization_margin_seconds(1200)
        for value in observed_remaining
    )
    assert pdf_enrichment.pdf_deadline_remaining() is None


def test_worker_pdf_deadline_scope_resets_when_batch_raises(monkeypatch) -> None:
    observed_remaining: list[float | None] = []

    def failing_batch(**_kwargs) -> int:
        observed_remaining.append(pdf_enrichment.pdf_deadline_remaining())
        raise RuntimeError("batch failed")

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", failing_batch)

    with pytest.raises(RuntimeError, match="batch failed"):
        queued_runner._run_enrichment_queue_worker(max_jobs=1, budget_seconds=1200)
    assert observed_remaining and observed_remaining[0] is not None
    assert pdf_enrichment.pdf_deadline_remaining() is None
    assert source_task_deadline_remaining() is None
    assert llm_task_deadline_remaining() is None


def test_worker_source_and_llm_deadline_scopes_use_existing_finalization_margin(monkeypatch) -> None:
    observed_remaining: list[tuple[float | None, float | None]] = []

    def fake_batch(**_kwargs) -> int:
        observed_remaining.append((source_task_deadline_remaining(), llm_task_deadline_remaining()))
        return 0

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)
    started = time.monotonic()
    queued_runner._run_enrichment_queue_batch_with_deadline(
        limit=1,
        family=queued_runner.SOURCE_DETAIL_FAMILY,
        provider_clients={},
        worker_deadline=started + 10,
        finalization_margin_seconds=2,
    )

    assert observed_remaining
    assert all(remaining is not None and 0 < remaining <= 8 for remaining in observed_remaining[0])
    assert source_task_deadline_remaining() is None
    assert llm_task_deadline_remaining() is None


def test_worker_does_not_claim_inside_pdf_finalization_margin(monkeypatch) -> None:
    calls: list[dict[str, object]] = []
    timestamps = iter([100.0, 158.0, 158.0])
    monkeypatch.setattr(queued_runner.time, "monotonic", lambda: next(timestamps))
    monkeypatch.setattr(
        queued_runner,
        "run_enrichment_queue_batch",
        lambda **kwargs: calls.append(kwargs) or 1,
    )

    assert queued_runner._run_enrichment_queue_worker(max_jobs=1, budget_seconds=60) == 0
    assert calls == []


def test_worker_short_budget_keeps_a_scaled_pdf_margin_and_processes_job(monkeypatch) -> None:
    observed_remaining: list[float | None] = []

    def fake_batch(**_kwargs) -> int:
        observed_remaining.append(pdf_enrichment.pdf_deadline_remaining())
        return 1

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner._run_enrichment_queue_worker(max_jobs=1, budget_seconds=60) == 1
    assert observed_remaining and observed_remaining[0] is not None
    assert 0 < observed_remaining[0] <= 60 - queued_runner._pdf_finalization_margin_seconds(60)
    assert queued_runner._pdf_finalization_margin_seconds(60) < queued_runner.PDF_FINALIZATION_MARGIN_SECONDS


def test_enrichment_worker_gives_empty_lane_slot_to_other_family(monkeypatch) -> None:
    calls: list[str] = []

    def fake_batch(*, limit: int, family: str, provider_clients: dict | None = None) -> int:
        calls.append(family)
        return 0 if family == queued_runner.SOURCE_DETAIL_FAMILY else 1

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", fake_batch)

    assert queued_runner.run_enrichment_queue_worker(max_jobs=1, budget_seconds=1200) == 1
    assert calls == [queued_runner.SOURCE_DETAIL_FAMILY, queued_runner.ENRICHMENT_FAMILY]


def test_enrichment_worker_reuses_provider_clients_between_detail_claims(monkeypatch) -> None:
    jobs = iter(
        [
            {"id": "detail-1", "job_type": "source_detail"},
            {"id": "detail-2", "job_type": "source_detail"},
        ]
    )
    observed_maps: list[dict[str, object]] = []
    observed_clients: list[object] = []

    def claim(*, family: str, limit: int) -> list[dict[str, object]]:
        if family != queued_runner.SOURCE_DETAIL_FAMILY:
            return []
        try:
            return [next(jobs)]
        except StopIteration:
            return []

    def process_details(*args, settings, clients, on_deferred=None) -> int:
        observed_maps.append(clients)
        client = clients.setdefault(
            "https://provider.test",
            SimpleNamespace(
                _access_denials=1,
                _retry_not_before="2099-01-01T00:00:00+00:00",
            ),
        )
        observed_clients.append(client)
        return 1

    monkeypatch.setattr(queued_runner, "claim_auction_enrichment_jobs_family_from_supabase", claim)
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {})
    monkeypatch.setattr(queued_runner, "run_source_detail_jobs", process_details)

    assert queued_runner.run_enrichment_queue_worker(max_jobs=2, budget_seconds=1200) == 2
    assert observed_maps[0] is observed_maps[1]
    assert observed_clients[0] is observed_clients[1]
    assert observed_clients[1]._access_denials == 1
    assert observed_clients[1]._retry_not_before == "2099-01-01T00:00:00+00:00"


def test_general_budget_deferral_is_a_handled_lane_outcome(monkeypatch) -> None:
    from src.pipeline_usage import PipelineBudgetExhausted

    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/general-budget",
            "description": "Maison",
        }
    )
    job = {
        "id": "job-general-budget",
        "source_url": sale.source_url,
        "job_type": "fact_extraction",
        "attempt_count": 1,
        "locked_at": "2026-09-13T08:00:00+00:00",
    }
    deferred: list[tuple[list[dict[str, object]], PipelineBudgetExhausted]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            PipelineBudgetExhausted("Daily AI budget exhausted")
        ),
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs, error: deferred.append((jobs, error)),
    )

    worker_token = queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.set(False)
    try:
        assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
        assert queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.get() is True
    finally:
        queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.reset(worker_token)
    assert len(deferred) == 1
    assert deferred[0][0] == [job]
    assert isinstance(deferred[0][1], PipelineBudgetExhausted)


@pytest.mark.parametrize(
    "error_factory",
    [
        lambda: queued_runner.LLMEnrichmentDeferred("fact checkpoint deferred"),
        lambda: queued_runner.LLMRequestDeterministicCooldown("deterministic cooldown"),
    ],
    ids=["fact_checkpoint", "deterministic_cooldown"],
)
def test_non_budget_deferrals_do_not_open_general_breaker(monkeypatch, error_factory) -> None:
    from src.llm_cache import LLMCacheUnavailable

    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/non-budget-defer",
            "description": "Maison",
        }
    )
    job = {
        "id": "job-non-budget-defer",
        "source_url": sale.source_url,
        "job_type": "fact_extraction",
        "attempt_count": 2,
        "locked_at": "2026-09-13T08:00:00+00:00",
    }
    deferred: list[tuple[list[dict[str, object]], BaseException]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: (_ for _ in ()).throw(error_factory()),
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs, error: deferred.append((jobs, error)),
    )

    worker_token = queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.set(False)
    try:
        assert queued_runner.run_enrichment_queue_batch(
            limit=1, family=queued_runner.ENRICHMENT_FAMILY
        ) == 1
        assert queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.get() is False
    finally:
        queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.reset(worker_token)
    assert deferred and deferred[0][0] == [job]

    # Cache transport failures are also queue deferrals, but must not look like
    # provider budget exhaustion to the worker breaker.
    cache_error = LLMCacheUnavailable("LLM durable cache read unavailable")
    worker_token = queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.set(False)
    try:
        monkeypatch.setattr(
            queued_runner,
            "enrich_sale_with_llm",
            lambda *args, **kwargs: (_ for _ in ()).throw(cache_error),
        )
        deferred.clear()
        assert queued_runner.run_enrichment_queue_batch(
            limit=1, family=queued_runner.ENRICHMENT_FAMILY
        ) == 1
        assert queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.get() is False
    finally:
        queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.reset(worker_token)
    assert deferred and deferred[0][0] == [job]


def test_fact_job_waits_for_pdf_cache_without_consuming_attempt(monkeypatch) -> None:
    from src.pipeline_usage import QueueJobDeferred

    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-prerequisite",
            "description": "Maison",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    job = {
        "id": "job-fact-before-pdf",
        "source_url": sale.source_url,
        "job_type": "fact_extraction",
        "attempt_count": 2,
        "locked_at": "2026-09-13T08:00:00+00:00",
    }
    deferred = []
    finished = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)
    monkeypatch.setattr(queued_runner, "has_eligible_pdf_job_for_sale", lambda _: True)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs, error: deferred.append((jobs, error)),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(
        limit=1, family=queued_runner.ENRICHMENT_FAMILY
    ) == 1
    assert deferred and deferred[0][0] == [job]
    assert isinstance(deferred[0][1], QueueJobDeferred)
    assert "PDF text cache" in str(deferred[0][1])
    assert finished == []


def test_fact_job_stops_waiting_when_pdf_prerequisite_is_terminal(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-terminal",
            "description": "Maison",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": document_fingerprint(sale.documents),
        "progress_schema_version": 1,
        "manifest_complete": True,
        "documents_listed": 1,
        "documents_extracted": 0,
        "failed_documents": 0,
        "blocked_documents": 1,
        "blocked_document_urls": [sale.documents[0]["url"]],
        "blocked_document_reasons": [{"url": sale.documents[0]["url"], "reason": "robots"}],
        "skipped_document_urls": [],
        "terminal_document_urls": [],
    }
    job = {
        "id": "job-fact-terminal-pdf",
        "source_url": sale.source_url,
        "job_type": "fact_extraction",
        "attempt_count": 2,
        "locked_at": "2026-09-13T08:00:00+00:00",
    }
    finished = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)
    monkeypatch.setattr(queued_runner, "has_eligible_pdf_job_for_sale", lambda _: False)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(
        limit=1, family=queued_runner.ENRICHMENT_FAMILY
    ) == 1
    assert len(finished) == 1
    assert finished[0][0] == job["id"]
    assert finished[0][1]["cancelled"] is True
    assert finished[0][1]["error_message"].startswith("review_required:")


def test_fact_job_with_partial_pdf_manifest_is_deferred_without_llm(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-partial-manifest",
            "description": "Maison",
            "documents": [
                {"label": "PV", "url": "https://example.test/pv.pdf"},
                {"label": "CCV", "url": "https://example.test/ccv.pdf"},
            ],
        }
    )
    first_url, second_url = [document["url"] for document in sale.documents]
    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": document_fingerprint(sale.documents),
        "progress_schema_version": 1,
        "manifest_complete": False,
        "failed_documents": 0,
        "failed_document_urls": [],
        "pending_document_urls": [second_url],
        "document_progress": [],
        "blocked_document_urls": [],
        "skipped_document_urls": [],
        "terminal_document_urls": [],
    }
    job = {
        "id": "job-fact-partial-pdf",
        "source_url": sale.source_url,
        "job_type": "fact_extraction",
        "attempt_count": 1,
        "locked_at": "2026-09-30T08:00:00+00:00",
    }
    deferred = []
    finished = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)
    monkeypatch.setattr(queued_runner, "has_eligible_pdf_job_for_sale", lambda _: True)
    monkeypatch.setattr(
        queued_runner,
        "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("partial PDF evidence must not invoke the LLM")),
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs, error: deferred.append((jobs, error)),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    assert deferred and deferred[0][0] == [job]
    assert finished == []
    assert first_url not in sale.raw_payload["document_analysis"]["pending_document_urls"]
    assert second_url in sale.raw_payload["document_analysis"]["pending_document_urls"]


def test_fact_job_with_current_exhausted_pdf_failure_is_reviewed_without_llm(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-exhausted",
            "description": "Maison",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    checked_at = datetime.now(UTC).isoformat()
    document_url = sale.documents[0]["url"]
    sale.raw_payload["document_analysis"] = {
        "checked_at": checked_at,
        "input_fingerprint": document_fingerprint(sale.documents),
        "progress_schema_version": 1,
        "manifest_complete": False,
        "failed_documents": 1,
        "failed_document_urls": [document_url],
        "pending_document_urls": [document_url],
        "document_progress": [],
        "blocked_document_urls": [],
        "skipped_document_urls": [],
        "terminal_document_urls": [],
    }
    job = {
        "id": "job-fact-exhausted-pdf",
        "source_url": sale.source_url,
        "job_type": "fact_extraction",
        "attempt_count": 1,
        "locked_at": "2026-09-30T08:00:00+00:00",
    }
    finished = []
    deferred = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(
        queued_runner,
        "pdf_enrichment_input_hash_for_sale",
        lambda *_args, **_kwargs: "pipeline_v2:current",
    )
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)
    monkeypatch.setattr(
        queued_runner,
        "read_pdf_job_states_for_sale",
        lambda _, **_kwargs: [{
            "status": "failed",
            "attempt_count": 4,
            "max_attempts": 4,
            "input_hash": "pipeline_v2:current",
            "updated_at": checked_at,
        }],
    )
    monkeypatch.setattr(
        queued_runner,
        "has_eligible_pdf_job_for_sale",
        lambda _: (_ for _ in ()).throw(AssertionError("exhausted PDF state must not recheck eligibility")),
    )
    monkeypatch.setattr(
        queued_runner,
        "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("exhausted PDF evidence must not invoke the LLM")),
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs, error: deferred.append((jobs, error)),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    assert deferred == []
    assert finished == [
        (
            job["id"],
            {
                "succeeded": False,
                "cancelled": True,
                "error_message": "review_required: PDF extraction retry budget exhausted",
                "attempt_count": job["attempt_count"],
                "locked_at": job["locked_at"],
            },
        )
    ]


def test_pdf_retry_cap_ignores_exhausted_previous_generation(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-generation-boundary",
            "description": "Maison",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    document_url = sale.documents[0]["url"]
    checked_at = "2026-09-30T09:00:00+00:00"
    sale.raw_payload["document_analysis"] = {
        "checked_at": checked_at,
        "input_fingerprint": document_fingerprint(sale.documents),
        "failed_documents": 1,
        "failed_document_urls": [document_url],
    }
    monkeypatch.setattr(
        queued_runner,
        "pdf_enrichment_input_hash_for_sale",
        lambda *_args, **_kwargs: "pipeline_v2:current",
    )
    states = [
        {
            "status": "failed",
            "attempt_count": 4,
            "max_attempts": 4,
            "input_hash": "pipeline_v2:old",
            "created_at": "2026-09-29T09:00:00+00:00",
            "updated_at": "2026-09-30T12:00:00+00:00",
        },
        {
            "status": "queued",
            "attempt_count": 0,
            "max_attempts": 4,
            "input_hash": "pipeline_v2:current",
            "created_at": "2026-09-30T09:30:00+00:00",
            "updated_at": "2026-09-30T09:30:00+00:00",
        },
    ]
    monkeypatch.setattr(
        queued_runner,
        "read_pdf_job_states_for_sale",
        lambda _, **_kwargs: states,
    )

    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)

    states[1].update(
        {
            "status": "failed",
            "attempt_count": 4,
            "updated_at": "2026-09-30T10:00:00+00:00",
        }
    )
    assert queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)


def test_pdf_retry_cap_accepts_current_exhaustion_without_failure_marker(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-download-failure-before-marker",
            "description": "Maison",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    document_url = sale.documents[0]["url"]
    checked_at = "2026-09-30T09:00:00+00:00"
    sale.raw_payload["document_analysis"] = {
        "checked_at": checked_at,
        "input_fingerprint": document_fingerprint(sale.documents),
        "progress_schema_version": 1,
        "manifest_complete": False,
        # The download failed before analysis could attach a URL-level marker.
        "failed_documents": 0,
        "failed_document_urls": [],
        "pending_document_urls": [document_url],
    }
    monkeypatch.setattr(
        queued_runner,
        "pdf_enrichment_input_hash_for_sale",
        lambda *_args, **_kwargs: "pipeline_v2:current",
    )
    states = [
        {
            "status": "failed",
            "attempt_count": 4,
            "max_attempts": 4,
            "input_hash": "pipeline_v2:old",
            "created_at": "2026-09-29T09:00:00+00:00",
            "updated_at": "2026-09-30T12:00:00+00:00",
        },
        {
            "status": "queued",
            "attempt_count": 0,
            "max_attempts": 4,
            "input_hash": "pipeline_v2:current",
            "created_at": "2026-09-30T09:30:00+00:00",
            "updated_at": "2026-09-30T09:30:00+00:00",
        },
    ]
    monkeypatch.setattr(
        queued_runner,
        "read_pdf_job_states_for_sale",
        lambda _, **_kwargs: states,
    )

    # A newer queued generation with the same input revision is still
    # actionable, so it must prevent fact cancellation.
    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)

    states[1].update(
        {
            "status": "failed",
            "attempt_count": 4,
            "updated_at": "2026-09-30T10:00:00+00:00",
        }
    )
    # The exact current row proves exhaustion even though the analysis has no
    # failed_documents/failed_document_urls marker.
    assert queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)

    # Missing or unreadable queue state is inconclusive and must leave the
    # dependent claim waiting for a later PDF observation.
    monkeypatch.setattr(queued_runner, "read_pdf_job_states_for_sale", lambda _, **_kwargs: [])
    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)
    monkeypatch.setattr(
        queued_runner,
        "read_pdf_job_states_for_sale",
        lambda _, **_kwargs: (_ for _ in ()).throw(RuntimeError("queue unavailable")),
    )
    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)


def test_partial_pdf_checkpoint_failure_consumes_pdf_retry(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-checkpoint-persistence",
            "description": "Maison",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    document_url = sale.documents[0]["url"]
    sale.raw_payload["document_analysis"] = {
        "checked_at": "2026-09-30T09:00:00+00:00",
        "input_fingerprint": document_fingerprint(sale.documents),
        "progress_schema_version": 1,
        "manifest_complete": False,
        "failed_documents": 0,
        "failed_document_urls": [],
        "pending_document_urls": [document_url],
        "document_progress": [],
        "blocked_document_urls": [],
        "skipped_document_urls": [],
        "terminal_document_urls": [],
    }
    job = {
        "id": "job-pdf-checkpoint-persistence",
        "source_url": sale.source_url,
        "job_type": "pdf",
        "attempt_count": 2,
        "locked_at": "2026-09-30T08:00:00+00:00",
    }
    finished = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "restore_persisted_pdf_progress_for_sale", lambda _: [])
    monkeypatch.setattr(queued_runner, "documents_are_current", lambda _: False)
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_from_pdfs",
        lambda _: SimpleNamespace(errors=0),
    )
    monkeypatch.setattr(queued_runner, "manifest_is_complete", lambda *_args: False)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(
        limit=1, family=queued_runner.ENRICHMENT_FAMILY
    ) == 1
    assert finished == [
        (
            job["id"],
            {
                "succeeded": False,
                "error_message": "PDF document checkpoint was not persisted; retry required",
                "attempt_count": job["attempt_count"],
                "locked_at": job["locked_at"],
            },
        )
    ]


def test_shared_pdf_and_fact_claim_defers_fact_attempt_after_pdf_failure(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-fact-shared-failure",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    document_url = sale.documents[0]["url"]
    jobs = [
        {
            "id": "job-pdf-shared-failure",
            "source_url": sale.source_url,
            "job_type": "pdf",
            "attempt_count": 2,
            "locked_at": "2026-09-30T08:00:00+00:00",
        },
        {
            "id": "job-facts-shared-failure",
            "source_url": sale.source_url,
            "job_type": "fact_extraction",
            "attempt_count": 2,
            "locked_at": "2026-09-30T08:00:00+00:00",
        },
    ]
    finished = []
    deferred = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_from_supabase",
        lambda limit: jobs,
    )
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)

    def failed_pdf(current_sale):
        current_sale.raw_payload["document_analysis"] = {
            "checked_at": datetime.now(UTC).isoformat(),
            "input_fingerprint": document_fingerprint(current_sale.documents),
            "progress_schema_version": 1,
            "manifest_complete": False,
            "failed_documents": 0,
            "failed_document_urls": [document_url],
            "pending_document_urls": [document_url],
            "blocked_document_urls": [],
            "skipped_document_urls": [],
            "terminal_document_urls": [],
            "document_progress": [],
            "cache_proof": {"version": 1, "documents": []},
            "profiles": [],
        }
        raise RuntimeError("Document extraction incomplete; retry required")

    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", failed_pdf)
    monkeypatch.setattr(
        queued_runner,
        "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("PDF failure must block the LLM")),
    )
    monkeypatch.setattr(
        queued_runner,
        "upsert_sales_to_supabase",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("failed PDF must not publish")),
    )
    checkpoint_calls = []
    monkeypatch.setattr(
        queued_runner,
        "persist_pdf_document_checkpoint_to_supabase",
        lambda current_sale, **_kwargs: checkpoint_calls.append(current_sale.source_url) or False,
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs_to_defer, error: deferred.append((jobs_to_defer, error)),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=2) == 2
    assert [job["id"] for job in deferred[0][0]] == [jobs[1]["id"]]
    assert [job_id for job_id, _kwargs in finished] == [jobs[0]["id"]]
    assert finished[0][1]["succeeded"] is False
    assert checkpoint_calls == [sale.source_url]


def test_general_budget_does_not_defer_completed_fact_claim_job(monkeypatch) -> None:
    from src.pipeline_usage import PipelineBudgetExhausted

    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://example.test/mixed-budget",
            "description": "Maison",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    fact_job = {
        "id": "job-fact-claims",
        "source_url": sale.source_url,
        "job_type": "fact_claims",
        "attempt_count": 2,
        "locked_at": "2026-09-13T08:00:00+00:00",
    }
    display_job = {
        "id": "job-display",
        "source_url": sale.source_url,
        "job_type": "display_description",
        "attempt_count": 1,
        "locked_at": "2026-09-13T08:00:00+00:00",
    }
    deferred: list[tuple[list[dict[str, object]], PipelineBudgetExhausted]] = []
    finished: list[tuple[str, bool, str | None]] = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [fact_job, display_job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "retry_fact_claims_to_supabase", lambda _: 1)
    monkeypatch.setattr(queued_runner, "refresh_operational_display", lambda _: None)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            PipelineBudgetExhausted("Daily AI budget exhausted")
        ),
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs, error: deferred.append((jobs, error)),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, succeeded, error_message=None, **kwargs: finished.append(
            (job_id, succeeded, error_message)
        ),
    )

    assert queued_runner.run_enrichment_queue_batch(
        limit=2, family=queued_runner.ENRICHMENT_FAMILY
    ) == 2
    assert len(deferred) == 1
    assert deferred[0][0] == [display_job]
    assert isinstance(deferred[0][1], PipelineBudgetExhausted)
    assert finished == [("job-fact-claims", True, None)]


@pytest.mark.parametrize('progress_made,should_defer', [(True, True), (False, False)])
def test_pdf_checkpoint_deferral_does_not_complete_or_loop_without_progress(
    monkeypatch,
    progress_made,
    should_defer,
) -> None:
    from src.pdf_enrichment import PdfExtractionDeferred

    sale = normalize_sale(
        {
            'source_name': 'avoventes',
            'source_url': 'https://example.test/pdf-checkpoint',
            'description': 'Maison',
            'documents': [{'label': 'PV', 'url': 'https://example.test/pv.pdf'}],
        }
    )
    job = {
        'id': 'job-pdf-checkpoint',
        'source_url': sale.source_url,
        'job_type': 'pdf',
        'attempt_count': 2,
        'locked_at': '2026-09-13T08:00:00+00:00',
    }
    deferred = []
    finished = []
    error = PdfExtractionDeferred(
        'OCR pass budget reached; 75/100 pages checkpointed; retry resumes',
        checkpointed_pages=75,
        total_pages=100,
        new_progress_pages=1 if progress_made else 0,
    )

    monkeypatch.setattr(
        queued_runner,
        'claim_auction_enrichment_jobs_family_from_supabase',
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, 'load_settings', lambda: {'llm_prompt_version': 'test'})
    monkeypatch.setattr(queued_runner, 'fetch_sale_for_data_refresh', lambda _: sale)
    monkeypatch.setattr(queued_runner, 'enrich_sale_from_pdfs', lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
    monkeypatch.setattr(queued_runner, 'defer_budget_jobs', lambda jobs, exc: deferred.append((jobs, exc)))
    monkeypatch.setattr(
        queued_runner,
        'finish_auction_enrichment_job_in_supabase',
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    assert bool(deferred) is should_defer
    assert finished == [] if should_defer else finished[0][1]['succeeded'] is False


def test_pdf_no_progress_consumes_only_pdf_retry_in_shared_claim(monkeypatch) -> None:
    from src.pdf_enrichment import PdfExtractionDeferred
    from src.pipeline_usage import QueueJobDeferred

    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-no-progress-shared",
            "description": "Maison",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    jobs = [
        {
            "id": "job-pdf-no-progress",
            "source_url": sale.source_url,
            "job_type": "pdf",
            "attempt_count": 2,
            "locked_at": "2026-09-30T08:00:00+00:00",
        },
        {
            "id": "job-facts-no-progress",
            "source_url": sale.source_url,
            "job_type": "fact_extraction",
            "attempt_count": 2,
            "locked_at": "2026-09-30T08:00:00+00:00",
        },
        {
            "id": "job-display-no-progress",
            "source_url": sale.source_url,
            "job_type": "display_description",
            "attempt_count": 1,
            "locked_at": "2026-09-30T08:00:00+00:00",
        },
    ]
    deferred = []
    finished = []
    error = PdfExtractionDeferred(
        "OCR pass budget reached without a new page",
        checkpointed_pages=0,
        total_pages=1,
        new_progress_pages=0,
    )
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: jobs,
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(
        queued_runner,
        "enrich_sale_from_pdfs",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda jobs_to_defer, exc: deferred.append((jobs_to_defer, exc)),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(
        limit=3, family=queued_runner.ENRICHMENT_FAMILY
    ) == 3
    assert [job["id"] for job in deferred[0][0]] == [jobs[1]["id"], jobs[2]["id"]]
    assert isinstance(deferred[0][1], QueueJobDeferred)
    assert [job_id for job_id, _kwargs in finished] == [jobs[0]["id"]]
    assert finished[0][1]["succeeded"] is False


def test_pdf_deadline_deferral_restores_claim_without_consuming_retry(monkeypatch) -> None:
    from src.pdf_enrichment import PdfDeadlineExceeded

    sale = normalize_sale(
        {
            'source_name': 'avoventes',
            'source_url': 'https://example.test/pdf-deadline',
            'description': 'Maison',
            'documents': [{'label': 'PV', 'url': 'https://example.test/pv.pdf'}],
        }
    )
    job = {
        'id': 'job-pdf-deadline',
        'source_url': sale.source_url,
        'job_type': 'pdf',
        'attempt_count': 2,
        'locked_at': '2026-09-30T08:00:00+00:00',
    }
    deferred: list[tuple[list[dict[str, object]], BaseException]] = []
    finished: list[tuple[str, dict[str, object]]] = []
    error = PdfDeadlineExceeded(
        'PDF worker deadline reached; retry resumes from checkpoint',
        checkpointed_pages=0,
        total_pages=8,
        new_progress_pages=0,
    )

    monkeypatch.setattr(
        queued_runner,
        'claim_auction_enrichment_jobs_family_from_supabase',
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, 'load_settings', lambda: {'llm_prompt_version': 'test'})
    monkeypatch.setattr(queued_runner, 'fetch_sale_for_data_refresh', lambda _: sale)
    monkeypatch.setattr(
        queued_runner,
        'enrich_sale_from_pdfs',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )
    monkeypatch.setattr(queued_runner, 'defer_budget_jobs', lambda jobs, exc: deferred.append((jobs, exc)))
    monkeypatch.setattr(
        queued_runner,
        'finish_auction_enrichment_job_in_supabase',
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    assert deferred == [([job], error)]
    assert finished == []


def test_llm_deadline_defers_all_owned_claims_and_stops_the_batch(monkeypatch) -> None:
    sales = {
        url: normalize_sale({'source_name': 'avoventes', 'source_url': url, 'description': 'Maison'})
        for url in ('https://example.test/llm-deadline-1', 'https://example.test/llm-deadline-2')
    }
    jobs = [
        {'id': f'job-llm-deadline-{index}', 'source_url': url, 'job_type': 'display_description',
         'attempt_count': 2, 'locked_at': '2026-09-30T08:00:00+00:00'}
        for index, url in enumerate(sales, 1)
    ]
    error = LLMTaskDeadlineExceeded('polling prediction', deadline=1, remaining=-1)
    deferred = []
    fetched = []
    calls = []
    finished = []
    monkeypatch.setattr(
        queued_runner, 'claim_auction_enrichment_jobs_family_from_supabase',
        lambda *, family, limit: jobs,
    )
    monkeypatch.setattr(queued_runner, 'load_settings', lambda: {'llm_prompt_version': 'test'})
    monkeypatch.setattr(
        queued_runner, 'fetch_sale_for_data_refresh',
        lambda url: fetched.append(url) or sales[url],
    )
    monkeypatch.setattr(queued_runner, 'refresh_operational_display', lambda _: None)
    monkeypatch.setattr(queued_runner, 'create_llm_client', lambda: object())

    def expire(sale, **kwargs):
        calls.append(sale.source_url)
        raise error

    monkeypatch.setattr(queued_runner, 'enrich_sale_with_llm', expire)
    monkeypatch.setattr(queued_runner, 'defer_budget_jobs', lambda claimed, exc: deferred.append((list(claimed), exc)))
    monkeypatch.setattr(
        queued_runner, 'finish_auction_enrichment_job_in_supabase',
        lambda *args, **kwargs: finished.append((args, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=2, family=queued_runner.ENRICHMENT_FAMILY) == 2
    assert calls == [jobs[0]['source_url']]
    assert fetched == [jobs[0]['source_url']]
    assert deferred == [(jobs, error)]
    assert finished == []


def test_failed_pdf_job_records_document_path_without_query_token(monkeypatch) -> None:
    sale = normalize_sale({
        "source_name": "vench",
        "source_url": "https://www.vench.fr/vente-123.html",
        "documents": [{"label": "PV", "url": "https://documents.test/pv.pdf?token=secret"}],
    })
    job = {"id": "job-pdf", "source_url": sale.source_url, "job_type": "pdf", "attempt_count": 1}
    finished = []

    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: [job],
    )
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _url: sale)

    def fail_pdf_extract(current_sale):
        current_sale.raw_payload["document_analysis"] = {
            "failed_documents": 1,
            "failed_document_urls": ["https://documents.test/pv.pdf?token=secret"],
            "failed_document_diagnostics": [{
                "url": "https://documents.test/pv.pdf?token=secret",
                "status": "incomplete",
                "failed_pages": [2, 4],
                "failure_reasons": ["ocr_failed", "empty_page_not_proven_blank"],
                "text": "private PDF text",
            }],
        }
        return SimpleNamespace(errors=1)

    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", fail_pdf_extract)
    monkeypatch.setattr(
        queued_runner, "upsert_sales_to_supabase",
        lambda *args, **kwargs: pytest.fail("partial PDF facts must not be published"),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    message = finished[0][1]["error_message"]
    assert "1 extraction errors, 1 failed documents" in message
    assert "documents.test/pv.pdf" in message
    assert "status=incomplete failed_pages=2,4" in message
    assert "reasons=empty_page_not_proven_blank,ocr_failed" in message
    assert "token=secret" not in message
    assert "private PDF text" not in message
