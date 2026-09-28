import sys
import types
from types import SimpleNamespace

import pytest

from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
from src.models import AuctionSale
from src.normalize import normalize_sale

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


@pytest.fixture(autouse=True)
def no_active_running_run(monkeypatch) -> None:
    monkeypatch.setattr(queued_runner, "has_active_running_run_in_supabase", lambda: False)


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
            "failed_documents": 0,
            "failed_document_urls": [],
            "blocked_documents": 1,
            "blocked_document_urls": [current_sale.documents[0]["url"]],
            "blocked_document_reasons": [{
                "url": current_sale.documents[0]["url"],
                "reason": "robots.txt disallows fetching this Licitor document",
            }],
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
    assert "processed=0" in summary
    assert "source_detail=0" in summary
    assert "enrichment=0" in summary
    assert "claim_batches=2" in summary
    assert "stop=queues_empty" in summary


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

    def process_details(*args, settings, clients) -> int:
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

    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    assert len(deferred) == 1
    assert deferred[0][0] == [job]
    assert isinstance(deferred[0][1], PipelineBudgetExhausted)


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
        }
        return SimpleNamespace(errors=1)

    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", fail_pdf_extract)
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)),
    )

    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    message = finished[0][1]["error_message"]
    assert "1 extraction errors, 1 failed documents" in message
    assert "documents.test/pv.pdf" in message
    assert "token=secret" not in message
