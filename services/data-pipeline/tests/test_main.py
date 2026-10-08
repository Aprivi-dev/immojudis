import hashlib
import json
import sys
import types
from datetime import UTC, datetime
from decimal import Decimal
from threading import Lock

import pytest

from src.config import EncheresPubliquesAccessNotAuthorized
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.sources.common import ScrapeResult

try:
    from src import main
except ModuleNotFoundError as exc:
    if exc.name != "pandas":
        raise
    sys.modules.pop("src.main", None)
    export_stub = types.ModuleType("src.export")
    export_stub.export_sales = lambda sales: ("out.json", "out.csv")
    sys.modules["src.export"] = export_stub
    from src import main

    del sys.modules["src.export"]


@pytest.fixture(autouse=True)
def _disable_real_expired_sale_cleanup(monkeypatch) -> None:
    monkeypatch.delenv("GITHUB_ENV", raising=False)
    monkeypatch.setattr(main, "delete_expired_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_secondary_sales_in_supabase", lambda sales: 0)
    monkeypatch.setattr(
        main,
        "bridge_auction_sales_before_cleanup",
        lambda settings: types.SimpleNamespace(
            scanned_count=0,
            created_count=0,
            reused_count=0,
        ),
    )


def test_needs_heavy_enrichment_skips_complete_sale(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_settings", lambda: {**_settings(), "llm_prompt_version": "auction_llm_v5"})
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        property_type="apartment",
        app_surface_m2=Decimal("42"),
        occupancy_status="vacant",
        rooms_count=2,
        raw_text="Appartement libre de 42 m2.",
    )

    assert main._needs_heavy_enrichment(sale, use_llm=False) is False
    assert main._needs_heavy_enrichment(sale, use_llm=True) is True
    sale.raw_payload["llm_display_description"] = "Appartement libre de 42 m2. " * 4
    assert main._needs_heavy_enrichment(sale, use_llm=True) is True
    sale.raw_payload["llm_display_quality_version"] = DISPLAY_QUALITY_VERSION
    sale.raw_payload["llm_display_status"] = "accepted"
    sale.raw_payload["llm_prompt_version"] = "auction_llm_v5"
    assert main._needs_heavy_enrichment(sale, use_llm=True) is False


def test_known_source_urls_from_raw_sales_includes_primary_and_aliases() -> None:
    assert main._known_source_urls_from_raw_sales([
        {
            "source_url": "https://example.test/primary",
            "source_urls": ["https://example.test/alias"],
        },
        {
            "source_url": "https://example.test/primary",
            "source_urls": {"secondary": "https://example.test/other"},
        },
    ]) == [
        "https://example.test/alias",
        "https://example.test/other",
        "https://example.test/primary",
    ]


def test_known_payload_hydration_fails_closed_without_rich_row() -> None:
    source_url = "https://example.test/known"
    known = {source_url: {"raw_payload": {"source_checks": {source_url: {}}}}}
    loaded: set[str] = set()

    def missing_fetch(**_kwargs):
        return {}

    with pytest.raises(RuntimeError, match="no complete rows"):
        main._hydrate_known_payloads_for_rows(
            [{"source_url": source_url}],
            known,
            loaded,
            fetch_details=missing_fetch,
            lock=Lock(),
        )

    assert loaded == set()
    assert known[source_url]["raw_payload"] == {"source_checks": {source_url: {}}}


def test_known_payload_hydration_marks_aliases_returned_by_fetch_as_loaded() -> None:
    alias_url = "https://example.test/alias"
    canonical_url = "https://example.test/canonical"
    known = {
        alias_url: {"raw_payload": {"source_presence": {}}},
        canonical_url: {"raw_payload": {"source_presence": {}}},
    }
    hydrated = {
        alias_url: {"raw_payload": {"source_sale_schedule": {"alias": True}}},
        canonical_url: {"raw_payload": {"source_sale_schedule": {"canonical": True}}},
    }
    loaded: set[str] = set()
    calls: list[dict[str, object]] = []

    def fetch_details(**kwargs):
        calls.append(kwargs)
        return hydrated

    main._hydrate_known_payloads_for_rows(
        [{"source_url": alias_url}],
        known,
        loaded,
        fetch_details=fetch_details,
        lock=Lock(),
    )
    main._hydrate_known_payloads_for_rows(
        [{"source_url": canonical_url}],
        known,
        loaded,
        fetch_details=fetch_details,
        lock=Lock(),
    )

    assert len(calls) == 1
    assert loaded == {alias_url, canonical_url}
    assert known[canonical_url] == hydrated[canonical_url]


def test_run_scraper_uses_killable_source_worker_when_enabled(monkeypatch) -> None:
    calls: dict[str, object] = {}
    expected = ScrapeResult([], [], {"coverage_complete": True})

    def fake_isolated(source, **kwargs):
        calls["source"] = source
        calls.update(kwargs)
        return expected, 0.2

    monkeypatch.setattr(main, "run_source_in_subprocess", fake_isolated)
    settings = {
        **_settings(),
        "source_process_isolation": True,
        "source_scrape_timeout_seconds": 17,
    }
    def progressive_publisher(rows):
        del rows

    result = main._run_scraper(
        "vench",
        lambda: (_ for _ in ()).throw(AssertionError("thread fallback must not run")),
        settings,
        {"https://example.test/vente": "sig"},
        {"https://example.test/vente": {"title": "Known"}},
        progressive_publisher,
    )

    assert result == (expected, 0.2)
    assert calls == {
        "source": "vench",
        "known": {"https://example.test/vente": "sig"},
        "known_details": {"https://example.test/vente": {"title": "Known"}},
        "max_pages": 1,
        "fetch_detail_heavy": True,
        "timeout_seconds": 17.0,
        "on_batch": progressive_publisher,
    }


@pytest.mark.parametrize("source", ["encheres_publiques", "all"])
def test_enabled_scrapers_refuses_ep_before_returning_a_fetch_callable(source: str) -> None:
    settings = {
        **_settings(),
        "enable_encheres_publiques_benchmark": source == "all",
        "encheres_publiques_access_authorized": False,
    }

    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        main._enabled_scrapers(source, settings, {}, {})


def test_enabled_scrapers_requires_both_ep_switches_before_exposing_source() -> None:
    settings = {
        **_settings(),
        "enable_encheres_publiques_benchmark": True,
        "encheres_publiques_access_authorized": True,
    }

    scrapers = main._enabled_scrapers("encheres_publiques", settings, {}, {})

    assert set(scrapers) == {"encheres_publiques"}


def test_pipeline_refuses_ep_before_creating_a_run_without_authorization(monkeypatch) -> None:
    settings = {
        **_settings(),
        "enable_encheres_publiques_benchmark": False,
        "encheres_publiques_access_authorized": False,
    }
    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: pytest.fail("run must not be created"))

    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        main.run_pipeline(main.PipelineOptions(source="encheres_publiques", upsert=True))


def test_run_scraper_keeps_thread_callable_when_isolation_disabled() -> None:
    expected = ScrapeResult([], [], {"coverage_complete": True})

    result = main._run_scraper(
        "vench",
        lambda: expected,
        {**_settings(), "source_process_isolation": False},
        {},
        {},
    )

    assert result[0] == expected
    assert result[1] >= 0


def test_run_scraper_isolates_avoventes_by_default(monkeypatch) -> None:
    expected = ScrapeResult([], [], {"coverage_complete": True})
    isolated_calls: list[str] = []

    monkeypatch.setattr(
        main,
        "run_source_in_subprocess",
        lambda source, **kwargs: isolated_calls.append(source) or (expected, 0.1),
    )

    result = main._run_scraper(
        "avoventes",
        lambda: (_ for _ in ()).throw(AssertionError("thread fallback must not run")),
        {**_settings(), "source_process_isolation": True, "source_scrape_timeout_seconds": 17},
        {},
        {},
    )

    assert result[0] == expected
    assert isolated_calls == ["avoventes"]


def test_run_scraper_keeps_other_sources_on_original_thread_path(monkeypatch) -> None:
    expected = ScrapeResult([], [], {"coverage_complete": True})
    isolated_calls: list[str] = []

    monkeypatch.setattr(
        main,
        "run_source_in_subprocess",
        lambda source, **kwargs: isolated_calls.append(source) or (expected, 0.1),
    )

    result = main._run_scraper(
        "notaires",
        lambda: expected,
        {**_settings(), "source_process_isolation": True},
        {},
        {},
    )

    assert result[0] == expected
    assert isolated_calls == []


def test_document_facts_version_forces_one_time_pdf_reanalysis(tmp_path, monkeypatch) -> None:
    sale = AuctionSale(
        source_name="info_encheres",
        source_url="https://www.info-encheres.com/vente-6008.html",
        property_type="house",
        app_surface_m2=Decimal("375"),
        occupancy_status="occupied",
        rooms_count=2,
        starting_price_eur=Decimal("11"),
        documents=[
            {
                "label": "Cahier des conditions de la vente",
                "url": "https://www.info-encheres.com/upload/cahier-6008.pdf",
            }
        ],
        content_hash="known-content",
    )

    assert main._needs_structured_heavy_enrichment(sale) is True
    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is False

    sale.raw_payload["document_facts_version"] = "document_facts_v1_starting_price"

    assert main._needs_structured_heavy_enrichment(sale) is True
    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is False

    sale.raw_payload["document_facts_version"] = main.DOCUMENT_FACTS_VERSION
    _materialize_current_pdf_proof(sale, tmp_path, monkeypatch)

    assert main._needs_structured_heavy_enrichment(sale) is False
    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is True


def test_heavy_current_rechecks_documents_after_policy_blocked_incremental_hit() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://www.licitor.com/annonce/policy-blocked-current",
        documents=[{"label": "PV", "url": "https://www.licitor.com/data/pub/media/pv.pdf"}],
        content_hash="known-content",
        raw_payload={
            "document_facts_version": main.DOCUMENT_FACTS_VERSION,
            "document_analysis": {
                "coverage_status": "partial",
                "documents_listed": 1,
                "documents_extracted": 0,
                "failed_documents": 0,
                "blocked_documents": 1,
                "blocked_document_urls": ["https://www.licitor.com/data/pub/media/pv.pdf"],
                "blocked_document_reasons": [{
                    "url": "https://www.licitor.com/data/pub/media/pv.pdf",
                    "reason": "robots.txt disallows fetching this Licitor document",
                }],
                "input_fingerprint": document_fingerprint([
                    {"label": "PV", "url": "https://www.licitor.com/data/pub/media/pv.pdf"}
                ]),
                "checked_at": datetime.now(UTC).isoformat(),
            },
        },
    )

    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is True

    sale.documents.append({"label": "CCV", "url": "https://www.licitor.com/data/pub/media/ccv.pdf"})

    assert main._heavy_enrichment_already_current(sale, {"known-content"}, use_llm=False) is False


def test_heavy_enrichment_does_not_skip_stale_llm_description(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_settings", lambda: {**_settings(), "llm_prompt_version": "auction_llm_v5"})
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente-stale",
        property_type="apartment",
        app_surface_m2=Decimal("42"),
        occupancy_status="vacant",
        rooms_count=2,
        raw_text="Appartement libre de 42 m2.",
        content_hash="same-content",
        raw_payload={
            "llm_display_description": "Ancienne synthèse. " * 5,
            "llm_prompt_version": "auction_llm_v4",
        },
    )

    assert main._needs_heavy_enrichment(sale, use_llm=True) is True
    assert main._heavy_enrichment_already_current(sale, {"same-content"}, use_llm=True) is False

    sale.raw_payload["llm_display_quality_version"] = DISPLAY_QUALITY_VERSION
    sale.raw_payload["llm_display_status"] = "accepted"
    sale.raw_payload["llm_prompt_version"] = "auction_llm_v5"
    assert main._heavy_enrichment_already_current(sale, {"same-content"}, use_llm=True) is True


def test_merge_pdf_stats_deduplicates_policy_blocked_urls() -> None:
    total = main.PdfEnrichmentStats(
        blocked_document_urls=["https://www.licitor.com/data/pub/media/pv.pdf"]
    )
    item = main.PdfEnrichmentStats(
        blocked_document_urls=[
            "https://www.licitor.com/data/pub/media/pv.pdf",
            "https://www.licitor.com/data/pub/media/conditions.pdf",
            "https://www.licitor.com/data/pub/media/conditions.pdf",
        ]
    )

    main._merge_pdf_stats(total, item)

    assert total.blocked_document_urls == [
        "https://www.licitor.com/data/pub/media/pv.pdf",
        "https://www.licitor.com/data/pub/media/conditions.pdf",
    ]


def test_merge_pdf_stats_deduplicates_permanent_document_failures() -> None:
    total = main.PdfEnrichmentStats(
        permanent_document_failures=[
            {"url": "https://documents.example/missing.pdf", "reason": "not_found"}
        ]
    )
    item = main.PdfEnrichmentStats(
        permanent_document_failures=[
            {"url": "https://documents.example/missing.pdf", "reason": "not_found"},
            {"url": "https://documents.example/html.pdf", "reason": "unsupported_response"},
        ]
    )

    main._merge_pdf_stats(total, item)

    assert total.permanent_document_failures == [
        {"url": "https://documents.example/missing.pdf", "reason": "not_found"},
        {"url": "https://documents.example/html.pdf", "reason": "unsupported_response"},
    ]


def test_needs_heavy_enrichment_keeps_incomplete_sale() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        property_type="apartment",
        documents=[{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
    )

    assert main._needs_heavy_enrichment(sale) is True


def test_pdf_target_limit_prioritizes_missing_surface_with_official_documents() -> None:
    partner_only = AuctionSale(
        source_name="licitor",
        source_url="https://www.licitor.com/annonce/partner-only.html",
        property_type="house",
        status="upcoming",
        documents=[
            {
                "label": "Voir le dossier complet avec",
                "url": "https://app-pro.la-loupe.immo/ext-partenaire/licitor/token/",
                "type": "pdf",
            }
        ],
    )
    official_documents = AuctionSale(
        source_name="info_encheres",
        source_url="https://www.info-encheres.com/vente-pv.html",
        property_type="apartment",
        status="upcoming",
        documents=[
            {
                "label": "Procès-verbal descriptif",
                "url": "https://www.info-encheres.com/upload/pvd.pdf",
                "type": "pv_descriptif",
            }
        ],
    )

    selected = main._limit_pdf_targets(
        [partner_only, official_documents],
        {"pipeline_pdf_max_targets": 1},
    )

    assert selected == [official_documents]


def test_run_pipeline_upserts_light_sale_before_pdf_enrichment(monkeypatch) -> None:
    calls: list[str] = []
    raw_sale = _raw_sale()
    raw_sale["document_analysis"] = {
        "progress_schema_version": main.PDF_PROGRESS_SCHEMA_VERSION,
        "manifest_complete": False,
    }

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([raw_sale], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(
        main,
        "restore_persisted_pdf_progress_for_sale",
        lambda sale: calls.append("restore") or [],
    )
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or (_raise_pdf()))
    monkeypatch.setattr(main, "enrich_sale_with_llm", lambda *args, **kwargs: main.LLMEnrichmentStats())
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)

    def upsert_sales(sales: list[AuctionSale]) -> int:
        calls.append("upsert")
        if "geocode" in calls:
            assert sales[0].latitude is not None
        else:
            assert sales[0].latitude is None
        assert sales[0].last_run_id == "run-1"
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=True)) == 0
    assert calls.index("upsert") < calls.index("pdf")
    assert calls.index("upsert") < calls.index("restore") < calls.index("pdf")
    assert calls.count("restore") == 1
    assert calls.index("upsert") < calls.index("geocode")
    assert calls.count("upsert") == 2


@pytest.mark.parametrize(
    ("restore_progress", "analysis", "expected_restores"),
    [
        (False, {"progress_schema_version": 1, "manifest_complete": False}, 0),
        (True, {"manifest_complete": False}, 0),
        (True, {"progress_schema_version": 1, "manifest_complete": True}, 0),
        (True, {"progress_schema_version": 1, "manifest_complete": False}, 1),
    ],
    ids=["offline", "legacy", "complete", "modern-partial"],
)
def test_pdf_target_restores_only_online_modern_partial_progress(
    monkeypatch, restore_progress, analysis, expected_restores
) -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/partial-pdf",
        raw_payload={"document_analysis": analysis},
    )
    calls: list[str] = []
    stats = main.PdfEnrichmentStats()
    monkeypatch.setattr(
        main, "restore_persisted_pdf_progress_for_sale", lambda sale: calls.append("restore") or []
    )
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or stats)

    assert main._enrich_pdf_target(sale, restore_progress=restore_progress) is stats
    assert calls == (["restore", "pdf"] if expected_restores else ["pdf"])


def test_pdf_target_checks_ep_access_before_restoration(monkeypatch) -> None:
    sale = AuctionSale(
        source_name="encheres_publiques",
        source_url="https://www.encheres-publiques.com/ventes/immobilier/123",
        raw_payload={"document_analysis": {"progress_schema_version": 1, "manifest_complete": False}},
    )
    monkeypatch.delenv("ENCHERES_PUBLIQUES_ACCESS_AUTHORIZED", raising=False)
    monkeypatch.delenv("ENABLE_ENCHERES_PUBLIQUES_BENCHMARK", raising=False)
    monkeypatch.setattr(
        main, "restore_persisted_pdf_progress_for_sale", lambda sale: pytest.fail("EP cache must not be read")
    )
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: pytest.fail("EP must not be fetched"))

    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        main._enrich_pdf_target(sale, restore_progress=True)


def test_pdf_target_keeps_ocr_after_bounded_persisted_lookup_timeout(monkeypatch) -> None:
    from src.storage import supabase_client as storage

    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/partial-pdf-timeout",
        documents=[{"url": "https://example.test/partial-pdf-timeout/pv.pdf"}],
        raw_payload={"document_analysis": {"progress_schema_version": 1, "manifest_complete": False}},
    )
    calls: list[str] = []
    monkeypatch.setattr(storage, "load_settings", lambda: {
        "supabase_url": "https://supabase.test",
        "supabase_service_role_key": "test-only",
    })

    def timed_out_lookup(*args, **kwargs):
        calls.append("lookup")
        assert kwargs["timeout"].connect == 5.0
        assert kwargs["timeout"].read == 15.0
        raise storage.httpx.ReadTimeout("test-only persisted checkpoint timeout")

    monkeypatch.setattr(storage.httpx, "get", timed_out_lookup)
    stats = main.PdfEnrichmentStats()
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or stats)
    token = storage._PUBLICATION_CONNECTION.set(None)
    try:
        assert main._enrich_pdf_target(sale, restore_progress=True) is stats
    finally:
        storage._PUBLICATION_CONNECTION.reset(token)
    assert calls == ["lookup", "pdf"]


def test_light_pipeline_geocodes_and_reupserts_when_heavy_enrichment_disabled(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)

    def upsert_sales(sales: list[AuctionSale]) -> int:
        calls.append("upsert")
        if "geocode" in calls:
            assert sales[0].latitude is not None
        else:
            assert sales[0].latitude is None
        assert sales[0].last_run_id == "run-1"
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == ["upsert", "observations", "geocode", "upsert", "observations"]


@pytest.mark.parametrize(
    "source,limit,global_cleanup", [("all", None, True), ("avoventes", None, False), ("all", 10, False), ("agrasc", None, False)]
)
def test_pipeline_deletes_expired_sales_after_supabase_publication(monkeypatch, source, limit, global_cleanup) -> None:
    summary_capture: dict[str, object] = {}
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: summary_capture.update(summary),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "scrape_agrasc_aquitaine_result", lambda: ScrapeResult(
        [{**_raw_sale(), "source_name": "agrasc"}], [],
        {"coverage_complete": False, "scoped_inventory_complete": True},
    ))
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(
        main,
        "bridge_auction_sales_before_cleanup",
        lambda settings: (
            calls.append("bridge") or types.SimpleNamespace(scanned_count=3, created_count=3, reused_count=0)
        ),
    )
    monkeypatch.setattr(
        main,
        "reconcile_duplicate_sales_in_supabase",
        lambda **kwargs: calls.append("reconcile") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_secondary_sales_in_supabase",
        lambda sales: calls.append("delete_secondary") or 1,
    )
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: calls.append("mark_past") or 0)
    monkeypatch.setattr(main, "delete_expired_sales_in_supabase", lambda: calls.append("delete_expired") or 3)
    monkeypatch.setattr(
        main,
        "delete_vench_sales_without_surface_in_supabase",
        lambda: calls.append("delete_vench") or 0,
    )
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert (
        main.run_pipeline(
            main.PipelineOptions(source=source, limit=limit, use_llm=False, heavy_enrichment=False, upsert=True)
        )
        == 0
    )
    expected_cleanup = [
        "bridge",
        "delete_secondary",
        "reconcile",
        "mark_past",
        "delete_expired",
        "delete_vench",
    ]
    if global_cleanup:
        assert calls[-6:] == expected_cleanup
    else:
        assert "bridge" not in calls
        assert "delete_secondary" not in calls
    assert summary_capture["deleted_expired_sales"] == (3 if global_cleanup else 0)
    assert summary_capture["deleted_secondary_sales"] == (1 if global_cleanup else 0)
    assert summary_capture["outcome_bridge_scanned"] == (3 if global_cleanup else 0)
    if source == "agrasc":
        assert summary_capture["stage_status"]["collection"] == "scoped_complete"
        assert summary_capture["completion_status"] == "partial_success"
        assert not any(name in calls for name in expected_cleanup)


@pytest.mark.parametrize("collection_failed", [False, True])
def test_pipeline_skips_every_cleanup_when_outcome_bridge_fails(monkeypatch, collection_failed) -> None:
    finish_calls: list[tuple[str, dict[str, object], dict[str, list[str]]]] = []
    cleanup_calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_calls.append((status, summary, errors)),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(
        main,
        "scrape_avoventes_aquitaine_result",
        lambda known=None: ScrapeResult([_raw_sale()], ["source validation failed"] if collection_failed else []),
    )
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(
        main,
        "bridge_auction_sales_before_cleanup",
        lambda settings: (_ for _ in ()).throw(RuntimeError("bridge incomplete")),
    )
    monkeypatch.setattr(
        main,
        "reconcile_duplicate_sales_in_supabase",
        lambda **kwargs: cleanup_calls.append("reconcile") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_secondary_sales_in_supabase",
        lambda sales: cleanup_calls.append("delete_secondary") or 0,
    )
    monkeypatch.setattr(
        main,
        "mark_past_sales_in_supabase",
        lambda: cleanup_calls.append("mark_past") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_expired_sales_in_supabase",
        lambda: cleanup_calls.append("delete_expired") or 0,
    )
    monkeypatch.setattr(
        main,
        "delete_vench_sales_without_surface_in_supabase",
        lambda: cleanup_calls.append("delete_vench") or 0,
    )

    result = main.run_pipeline(
        main.PipelineOptions(source="all", use_llm=False, heavy_enrichment=False, upsert=True)
    )

    assert result == 1
    assert cleanup_calls == []
    assert finish_calls[-1][0] == "failed"
    if collection_failed:
        assert finish_calls[-1][1]["completion_status"] == "partial_success"
        assert finish_calls[-1][1]["stage_status"]["publication"] == "partial"
        assert finish_calls[-1][2]["collection"] == ["Collection incomplete; catalogue cleanup is disabled."]
        assert "supabase" not in finish_calls[-1][2]
    else:
        assert finish_calls[-1][2]["supabase"] == ["bridge incomplete"]


def test_pipeline_returns_failure_when_final_supabase_publication_fails(monkeypatch) -> None:
    finish_calls: list[tuple[str, dict[str, list[str]]]] = []
    upsert_calls = 0

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_calls.append((status, errors)),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    def upsert_sales(sales: list[AuctionSale]) -> int:
        nonlocal upsert_calls
        upsert_calls += 1
        if upsert_calls == 2:
            raise RuntimeError("final publication rejected")
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)

    result = main.run_pipeline(
        main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True)
    )

    assert result == 1
    assert finish_calls[-1][0] == "failed"
    assert finish_calls[-1][1]["supabase"] == ["final publication rejected"]


def test_pipeline_recovers_when_only_early_supabase_publication_fails(monkeypatch) -> None:
    finish_statuses: list[str] = []
    upsert_calls = 0

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_statuses.append(status),
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    def upsert_sales(sales: list[AuctionSale]) -> int:
        nonlocal upsert_calls
        upsert_calls += 1
        if upsert_calls == 1:
            raise RuntimeError("temporary early publication failure")
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)

    result = main.run_pipeline(
        main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True)
    )

    assert result == 0
    assert finish_statuses[-1] == "succeeded"
    assert upsert_calls == 2


def test_pipeline_skips_redundant_final_sale_upsert_when_unchanged(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", lambda sale: calls.append("geocode") or sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "classify_sale_procedure", lambda sale: sale)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(
        main, "upsert_sales_to_supabase", lambda sales: calls.append(f"upsert:{len(sales)}") or len(sales)
    )
    monkeypatch.setattr(
        main,
        "upsert_observations_to_supabase",
        lambda sales: calls.append(f"observations:{len(sales)}") or len(sales),
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == ["upsert:1", "observations:1", "geocode"]


def test_pipeline_enriches_cadastre_after_final_geocode(monkeypatch) -> None:
    calls: list[str] = []
    settings = _settings()
    settings.update(
        {
            "cadastre_enrich_enabled": True,
            "cadastre_api_url": "https://apicarto.test/cadastre/parcelle",
            "cadastre_source_ign": "PCI",
            "cadastre_max_parcels": 4,
            "cadastre_timeout_seconds": 10,
        }
    )

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    def enrich_cadastre(sales, settings):
        calls.append("cadastre_enrich")
        assert sales[0].latitude == Decimal("44.84")
        assert settings["cadastre_enrich_enabled"] is True
        return [{"source_url": sales[0].source_url, "parcel_key": "33063-AB-0123"}]

    monkeypatch.setattr(main, "enrich_cadastre_sales", enrich_cadastre)
    monkeypatch.setattr(
        main,
        "upsert_cadastre_parcels_to_supabase",
        lambda rows: calls.append(f"cadastre_upsert:{len(rows)}") or len(rows),
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == [
        "upsert",
        "observations",
        "geocode",
        "cadastre_enrich",
        "upsert",
        "observations",
        "cadastre_upsert:1",
    ]


def test_pipeline_enriches_dpe_after_final_geocode(monkeypatch) -> None:
    calls: list[str] = []
    settings = _settings()
    settings.update(
        {
            "dpe_enrich_enabled": True,
            "dpe_api_url": "https://data.ademe.test/lines",
            "dpe_geo_radius_m": 120,
            "dpe_max_results": 5,
            "dpe_timeout_seconds": 12,
        }
    )

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    def enrich_dpe(sales, settings):
        calls.append("dpe_enrich")
        assert sales[0].latitude == Decimal("44.84")
        assert settings["dpe_enrich_enabled"] is True
        return [{"source_url": sales[0].source_url, "diagnostic_number": "2133E0178774F"}]

    monkeypatch.setattr(main, "enrich_dpe_sales", enrich_dpe)
    monkeypatch.setattr(
        main,
        "upsert_dpe_diagnostics_to_supabase",
        lambda rows: calls.append(f"dpe_upsert:{len(rows)}") or len(rows),
    )

    assert (
        main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True))
        == 0
    )
    assert calls == [
        "upsert",
        "observations",
        "geocode",
        "dpe_enrich",
        "upsert",
        "observations",
        "dpe_upsert:1",
    ]


@pytest.mark.parametrize("autonomous", [False, True])
def test_incremental_skip_only_skips_heavy_enrichment_not_publication(
    tmp_path, monkeypatch, autonomous
) -> None:
    if autonomous:
        monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "test-autonomous")
    else:
        monkeypatch.delenv("PIPELINE_AUTONOMOUS_RUN_ID", raising=False)
    calls: list[str] = []
    settings = _settings()
    settings["incremental_enrichment"] = True
    raw = {**_raw_sale(), "document_facts_version": main.DOCUMENT_FACTS_VERSION, "_known_unchanged": True}
    fixture_sale = main.normalize_sale(raw)
    _materialize_current_pdf_proof(fixture_sale, tmp_path, monkeypatch)
    raw["document_analysis"] = fixture_sale.raw_payload["document_analysis"]

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set(hashes))
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([raw], []))
    _fake_geocode.calls = calls
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or (_raise_pdf()))
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales: calls.append("upsert") or len(sales))
    monkeypatch.setattr(
        main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales)
    )

    assert main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=True)) == 0
    assert "pdf" not in calls
    assert ("geocode" in calls) is (not autonomous)
    assert calls.count("upsert") == 2


def test_pipeline_generates_llm_description_when_heavy_enrichment_is_disabled(monkeypatch) -> None:
    calls: list[str] = []
    settings = _settings()
    settings["incremental_enrichment"] = True

    raw = {
        **_raw_sale(),
        "surface_m2": "42",
        "rooms_count": 2,
        "occupancy_status": "vacant",
        "document_facts_version": main.DOCUMENT_FACTS_VERSION,
        "source_blocks": {"description": "Appartement libre de 42 m2."},
    }

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([raw], []))

    def fake_fetch(hashes, **kwargs):
        if kwargs.get("require_llm_description"):
            return set()
        return set(hashes)

    monkeypatch.setattr(main, "fetch_enriched_content_hashes", fake_fetch)
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or (_raise_pdf()))
    monkeypatch.setattr(
        main,
        "enrich_sale_with_llm",
        lambda *args, **kwargs: calls.append("llm") or main.LLMEnrichmentStats(analyzed=1, valid_json=1),
    )
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    assert (
        main.run_pipeline(
            main.PipelineOptions(
                source="avoventes",
                use_llm=True,
                heavy_enrichment=False,
                upsert=True,
            )
        )
        == 0
    )
    assert "pdf" not in calls
    assert calls == ["llm"]


def test_pipeline_requires_current_llm_description_for_incremental_skip(monkeypatch) -> None:
    captured: dict[str, object] = {}
    settings = _settings()
    settings["incremental_enrichment"] = True

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: None)
    monkeypatch.setattr(main, "enrich_sale_with_llm", lambda *args, **kwargs: main.LLMEnrichmentStats())
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales, **kwargs: len(sales))
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **kwargs: len(sales))

    def fake_fetch(hashes, **kwargs):
        captured["hashes"] = hashes
        captured["kwargs"] = kwargs
        return set(hashes)

    monkeypatch.setattr(main, "fetch_enriched_content_hashes", fake_fetch)

    assert main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=True, upsert=True)) == 0
    assert captured["kwargs"] == {
        "require_llm_description": True,
        "prompt_version": "auction_llm_v5",
    }


def test_parse_args_can_select_llm_description_backfill() -> None:
    options = main.parse_args(
        [
            "--backfill-llm-descriptions",
            "--limit",
            "7",
            "--backfill-statuses",
            "active,upcoming,unknown",
        ]
    )

    assert options.llm_backfill is True
    assert options.limit == 7
    assert options.llm_backfill_statuses == ("active", "upcoming", "unknown")


def test_unpublishable_sale_cannot_use_paid_llm() -> None:
    missing_price_and_surface = AuctionSale(
        source_name="notaires",
        source_url="https://example.test/unpublishable",
        title="Annonce sans prix ni surface",
    )
    publishable = AuctionSale(
        source_name="notaires",
        source_url="https://example.test/publishable",
        starting_price_eur=10_000,
    )

    assert main._can_use_paid_llm(missing_price_and_surface) is False
    assert main._can_use_paid_llm(publishable) is True


def test_run_llm_description_backfill_marks_failed_sales(monkeypatch) -> None:
    settings = _settings()
    settings.update(
        {
            "pipeline_llm_backfill_max_targets": 2,
            "pipeline_enrich_workers": 1,
            "pipeline_llm_workers": 1,
            "pipeline_llm_backfill_progress_every": 5,
            "llm_prompt_version": "auction_llm_v6_display",
        }
    )
    stale = AuctionSale(
        source_name="notaires",
        starting_price_eur=10000,
        source_url="https://example.test/stale",
        title="Maison 85 m²",
        raw_payload={"source_blocks": {"description": "Maison avec jardin."}},
    )
    failed = AuctionSale(
        source_name="notaires",
        starting_price_eur=10000,
        source_url="https://example.test/failed",
        title="Appartement",
        raw_payload={"source_blocks": {"description": "Appartement."}},
    )
    calls: list[str] = []
    progress_summaries: list[dict[str, object]] = []
    finish_summaries: list[dict[str, object]] = []

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-backfill")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda *args, **kwargs: (calls.append("finish"), finish_summaries.append(args[2])),
    )
    monkeypatch.setattr(
        main,
        "update_run_progress_in_supabase",
        lambda run_id, summary, errors=None: (
            calls.append(f"progress:{summary['completed']}"),
            progress_summaries.append(summary),
        ),
    )
    monkeypatch.setattr(main, "fetch_sales_needing_llm_descriptions", lambda **kwargs: [stale, failed])
    monkeypatch.setattr(main, "create_llm_client", lambda: object())

    def fake_enrich(sale, client=None):
        calls.append(f"llm:{sale.source_url.rsplit('/', 1)[-1]}")
        if sale is stale:
            stats = main.LLMEnrichmentStats(analyzed=1, valid_json=1)
            sale.raw_payload["llm_display_description"] = "Maison avec jardin proche du centre."
            sale.raw_payload["llm_prompt_version"] = "auction_llm_v6_display"
        else:
            stats = main.LLMEnrichmentStats(
                analyzed=1,
                errors=1,
                error_messages=["LLM extraction failed [notaires] https://example.test/failed"],
            )
        return stats

    monkeypatch.setattr(main, "enrich_sale_with_llm", fake_enrich)

    def fake_upsert(sales: list[AuctionSale], *, refresh_last_seen: bool) -> int:
        assert refresh_last_seen is False
        calls.append(f"upsert:{len(sales)}")
        assert len(sales) == 1
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", fake_upsert)

    assert (
        main.run_llm_description_backfill(
            main.PipelineOptions(llm_backfill=True, upsert=True, limit=7)
        )
        == 1
    )
    assert calls.count("upsert:1") == 2
    assert calls[-1] == "finish"
    assert failed.raw_payload["llm_display_error_count"] == 1
    assert progress_summaries
    assert all(summary["limit"] == 7 for summary in progress_summaries)
    assert finish_summaries[-1]["limit"] == 7


def test_run_llm_description_backfill_persists_limit_when_no_sales(monkeypatch) -> None:
    settings = {**_settings(), "pipeline_llm_backfill_max_targets": 20}
    finished: list[dict[str, object]] = []

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "fetch_sales_needing_llm_descriptions", lambda **_: [])
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finished.append(summary),
    )

    assert (
        main.run_llm_description_backfill(
            main.PipelineOptions(llm_backfill=True, upsert=True, limit=7, run_id="run-backfill")
        )
        == 0
    )
    assert len(finished) == 1
    assert finished[0]["mode"] == "llm_description_backfill"
    assert finished[0]["limit"] == 7
    assert finished[0]["selected"] == 0
    assert finished[0]["processed"] == 0
    assert finished[0]["updated"] == 0
    assert finished[0]["prompt_version"] == settings["llm_prompt_version"]
    assert finished[0]["statuses"] == ["active", "upcoming"]
    assert finished[0]["skipped_unauthorized"] == 0


def test_llm_backfill_progress_is_batched() -> None:
    assert main._should_update_llm_backfill_progress(0, total=20, every=5) is False
    assert main._should_update_llm_backfill_progress(4, total=20, every=5) is False
    assert main._should_update_llm_backfill_progress(5, total=20, every=5) is True
    assert main._should_update_llm_backfill_progress(19, total=20, every=5) is False
    assert main._should_update_llm_backfill_progress(20, total=20, every=5) is True


def test_known_unchanged_detail_is_hydrated_from_known_sale() -> None:
    raw = {
        "_known_unchanged": True,
        "source_url": "https://example.test/vente",
        "source_name": "vench",
        "title": "",
    }
    known = {
        "https://example.test/vente": {
            "title": "Appartement connu",
            "latitude": 44.84,
            "longitude": -0.57,
            "visit_dates": ["2027-01-05 10:00"],
            "lawyer_name": "Me Test",
            "lawyer_contact": "contact@example.test",
            "raw_payload": {
                "source_blocks": {"visites": "Sur rendez-vous"},
                "source_images": ["https://example.test/photo.jpg"],
            },
        }
    }

    assert main._hydrate_known_unchanged_sales([raw], known) == 1
    assert raw["title"] == "Appartement connu"
    assert raw["latitude"] == 44.84
    assert raw["visit_dates"] == ["2027-01-05 10:00"]
    assert raw["lawyer_name"] == "Me Test"
    assert raw["source_blocks"] == {"visites": "Sur rendez-vous"}


def test_sparse_known_hydration_preserves_unchanged_coordinates_and_investment() -> None:
    source_url = "https://example.test/sparse-known"
    raw = {
        "_known_unchanged": True,
        "source_url": source_url,
        "source_name": "vench",
    }
    known = {
        source_url: {
            "latitude": 44.84,
            "longitude": -0.57,
            "risk_notes": "Adresse à confirmer",
            "investment_score": 7.4,
            "investment_summary": "Bonne liquidité",
            "raw_payload": {},
        }
    }

    assert main._hydrate_known_unchanged_sales([raw], known) == 1

    assert raw["latitude"] == 44.84
    assert raw["longitude"] == -0.57
    assert raw["risk_notes"] == "Adresse à confirmer"
    assert raw["investment_score"] == 7.4
    assert raw["investment_summary"] == "Bonne liquidité"


def test_sparse_known_hydration_preserves_geocode_and_tribunal_evidence() -> None:
    source_url = "https://example.test/sparse-evidence"
    geocode = {
        "provider": "ban_geoplateforme",
        "accepted": True,
        "citycode": "33063",
    }
    tribunal_assignment = {
        "status": "verified",
        "insee_code": "33063",
        "court_name": "Tribunal judiciaire de Bordeaux",
    }
    raw = {
        "_known_unchanged": True,
        "source_url": source_url,
        "source_name": "vench",
    }
    known = {
        source_url: {
            "raw_payload": {
                "geocode": geocode,
                "tribunal_assignment": tribunal_assignment,
            },
        }
    }

    assert main._hydrate_known_unchanged_sales([raw], known) == 1

    assert raw["geocode"] == geocode
    assert raw["tribunal_assignment"] == tribunal_assignment


def test_sparse_known_hydration_preserves_sale_schedule_and_date_precision() -> None:
    source_url = "https://example.test/sparse-retention"
    retention_metadata = {
        "source_sale_schedule": {
            "opens_at": "2027-03-15T10:00:00Z",
            "closes_at": "2027-03-15T14:00:00Z",
        },
        "date_precision": "day",
        "sale_date_precision": "source_day",
    }
    known = {source_url: {"raw_payload": retention_metadata}}

    unchanged = {
        "_known_unchanged": True,
        "source_detail_status": "complete",
        "source_url": source_url,
        "source_name": "vench",
    }
    failed = {
        "_detail_fetch_failed": True,
        "source_detail_status": "failed",
        "source_url": source_url,
        "source_name": "vench",
    }
    sparse = {
        "source_detail_status": "restricted",
        "source_url": source_url,
        "source_name": "vench",
    }

    assert main._hydrate_known_unchanged_sales([unchanged, failed], known) == 1
    main._preserve_known_enrichment_payloads([sparse], known)

    for sale in (unchanged, failed, sparse):
        for key, value in retention_metadata.items():
            assert sale[key] == value


def test_fresh_complete_source_does_not_restore_stale_source_metadata() -> None:
    source_url = "https://example.test/fresh-land-source"
    known = {
        source_url: {
            "raw_payload": {
                "source_sale_schedule": {"closes_at": "2027-03-15T14:00:00Z"},
                "date_precision": "day",
                "sale_date_precision": "source_day",
                "operator_land_surface_conflict": True,
                "operator_land_surface_scope": "copropriété",
                "source_display_constraints": ["Surface terrain à vérifier"],
            }
        }
    }
    fresh = {
        "source_detail_status": "complete",
        "source_name": "agrasc",
        "source_url": source_url,
        "sale_date": "2027-04-20T12:00:00Z",
        "description": "La nouvelle source décrit le bien sans conflit de surface.",
    }
    sparse = {
        "source_detail_status": "restricted",
        "source_name": "agrasc",
        "source_url": source_url,
    }

    main._preserve_known_enrichment_payloads([fresh], known)
    main._preserve_known_enrichment_payloads([sparse], known)

    assert "source_sale_schedule" not in fresh
    assert "date_precision" not in fresh
    assert "sale_date_precision" not in fresh
    assert "operator_land_surface_conflict" not in fresh
    assert "operator_land_surface_scope" not in fresh
    assert "source_display_constraints" not in fresh
    assert sparse["operator_land_surface_conflict"] is True
    assert sparse["operator_land_surface_scope"] == "copropriété"
    assert sparse["source_display_constraints"] == ["Surface terrain à vérifier"]

    assert sparse["source_sale_schedule"] == {"closes_at": "2027-03-15T14:00:00Z"}
    assert sparse["date_precision"] == "day"
    assert sparse["sale_date_precision"] == "source_day"


def test_known_pdf_surface_is_preserved_before_incremental_publication() -> None:
    raw = {
        "source_url": "https://www.info-encheres.com/vente-6009.html",
        "source_name": "info_encheres",
        "property_type": "Appartement",
    }
    known = {
        raw["source_url"]: {
            "surface_m2": 3.78,
            "carrez_surface_m2": 3.78,
            "app_surface_m2": None,
            "app_surface_kind": None,
            "surface_scope": "partial",
            "surface_source": "pdf",
            "surface_confidence": 0.45,
            "surface_evidence": "Mesurage incomplet : 3,78 m².",
            "raw_payload": {
                "surface_extraction": {"source": "pdf", "value_m2": "3.78"},
                "document_analysis": {"coverage_status": "rich", "documents_extracted": 3},
            },
        }
    }

    preserved = main._preserve_known_enrichment_payloads([raw], known)

    assert preserved == 8
    assert raw["surface_m2"] == 3.78
    assert raw["carrez_surface_m2"] == 3.78
    assert raw["surface_scope"] == "partial"
    assert raw["surface_source"] == "pdf"
    assert raw["surface_extraction"] == {"source": "pdf", "value_m2": "3.78"}
    assert raw["document_analysis"]["documents_extracted"] == 3


def test_cold_worker_roundtrip_keeps_pdf_provenance_and_matching_source_facts() -> None:
    source_url = "https://example.test/cold-roundtrip/source-confirmed"
    document = {"url": "https://example.test/cold-roundtrip/pv.pdf", "label": "PV"}
    # These values were projected by the old PDF pass and are independently
    # confirmed by the new source payload.  The snapshot must therefore be
    # available if a later PDF replacement invalidates the projection.
    source_facts = {
        "raw_text": "Appartement 3 pièces, 2 chambres, libre.",
        "starting_price_eur": 180000,
        "surface_m2": 82.5,
        "habitable_surface_m2": 80.0,
        "carrez_surface_m2": 79.0,
        "land_surface_m2": 120.0,
        "app_surface_m2": 80.0,
        "app_surface_kind": "habitable",
        "surface_scope": "total",
        "surface_source": "source_listing",
        "surface_confidence": 0.94,
        "surface_evidence": "Surface habitable : 80 m²",
        "rooms_count": 3,
        "bedrooms_count": 2,
        "occupancy_status": "vacant",
        "sale_date": "2027-02-15T14:00:00+01:00",
        "visit_dates": ["2027-02-01 10:00"],
        "property_type": "apartment",
        "description": "Appartement confirmé par la source.",
        "risk_notes": "DPE à vérifier",
    }
    pdf_markers = {
        "pdf_fact_provenance": {
            "rooms_count": {
                "value": 3,
                "source": "pdf",
                "payload_keys": ["pdf_rooms_candidates"],
            }
        },
        "pdf_sale_date_extraction": {"value": source_facts["sale_date"], "source": "pdf"},
        "pdf_visit_dates_extraction": {"visit_dates": source_facts["visit_dates"], "source": "pdf"},
        "pdf_energy_diagnostics": {"dpe_class": "C", "source": "pdf"},
        "pdf_energy_diagnostics_candidates": [{"dpe_class": "C", "document_url": document["url"]}],
        "pdf_surface_candidates": [{"value": source_facts["surface_m2"], "document_url": document["url"]}],
        "pdf_land_surface_candidates": [{"value": source_facts["land_surface_m2"], "document_url": document["url"]}],
        "pdf_rooms_candidates": [{"value": source_facts["rooms_count"], "document_url": document["url"]}],
        "pdf_bedrooms_candidates": [{"value": source_facts["bedrooms_count"], "document_url": document["url"]}],
        "pdf_occupancy_candidates": [{"value": source_facts["occupancy_status"], "document_url": document["url"]}],
        "pdf_multi_lot_guard": {"status": "clear"},
    }
    raw = {
        "source_name": "licitor",
        "source_url": source_url,
        "documents": [document],
        **source_facts,
    }
    known = {
        source_url: {
            "source_name": "licitor",
            "source_url": source_url,
            "documents": [document],
            **source_facts,
            "raw_payload": pdf_markers,
        }
    }

    main._preserve_known_enrichment_payloads([raw], known)

    snapshot = raw["source_factual_snapshot"]
    assert {key: snapshot[key] for key in source_facts} == source_facts
    assert "pdf_fact_provenance" not in snapshot
    assert "pdf_rooms_candidates" not in snapshot
    assert raw["rooms_count"] == pdf_markers["pdf_rooms_candidates"][0]["value"]
    for key, value in pdf_markers.items():
        assert raw[key] == value

    # Reconstruct the next cold worker from the row that would be returned by
    # auction_sales.  It must receive both the source snapshot and PDF trace;
    # no PDF read is needed to keep the confirmed value stable.
    persisted_row = {
        **known[source_url],
        "raw_payload": {**pdf_markers, "source_factual_snapshot": snapshot},
    }
    cold_raw = {
        "source_name": "licitor",
        "source_url": source_url,
        "_known_unchanged": True,
    }
    main._hydrate_known_unchanged_sales([cold_raw], {source_url: persisted_row})
    main._preserve_known_enrichment_payloads([cold_raw], {source_url: persisted_row})

    assert cold_raw["source_factual_snapshot"] == snapshot
    assert cold_raw["pdf_fact_provenance"] == pdf_markers["pdf_fact_provenance"]
    assert cold_raw["rooms_count"] == source_facts["rooms_count"]
    assert cold_raw["surface_m2"] == source_facts["surface_m2"]


def test_cold_worker_preserves_vench_source_contract_from_bounded_snapshot() -> None:
    source_url = "https://example.test/vench/source-contract"
    contract = {
        "source_property_features": {"energy": {"dpe_class": "D"}},
        "source_property_feature_evidence": {"energy": [{"text": "DPE D"}]},
        "source_property_features_meta": {"version": "source_features_v2"},
        "source_procedure_profile": {"family": "judicial", "confidence": 0.9},
        "source_field_observations": {"sale_date": {"state": "observed"}},
        "source_evidence": {"sale_date": [{"value": "2027-02-15"}]},
        "source_evidence_provenance": {"sale_date": {"source": "vench"}},
        "source_energy_diagnostics": {"dpe_class": "D"},
    }
    raw = {"source_name": "vench", "source_url": source_url}
    known = {source_url: {"raw_payload": contract}}

    main._preserve_known_enrichment_payloads([raw], known)

    for key, value in contract.items():
        assert raw[key] == value


def test_known_pdf_price_resolution_is_preserved_until_source_price_changes() -> None:
    source_url = "https://www.info-encheres.com/vente-6008.html"
    raw = {
        "source_url": source_url,
        "source_name": "info_encheres",
        "starting_price_eur": "11 €",
    }
    extraction = {
        "version": "document_facts_v1_starting_price",
        "source": "pdf",
        "status": "resolved",
        "value_eur": 10500.0,
        "rejected_source_price_eur": 11.0,
        "selected_value_eur": 10500.0,
    }
    known = {
        source_url: {
            "starting_price_eur": 10500,
            "raw_payload": {
                "starting_price_extraction": extraction,
                "document_facts_version": "document_facts_v1_starting_price",
            },
        }
    }

    preserved = main._preserve_known_enrichment_payloads([raw], known)

    assert preserved == 3
    assert raw["starting_price_eur"] == Decimal("10500")
    assert raw["starting_price_extraction"] == extraction
    assert raw["document_facts_version"] == "document_facts_v1_starting_price"

    changed_raw = {
        "source_url": source_url,
        "source_name": "info_encheres",
        "starting_price_eur": "12 000 €",
    }

    assert main._preserve_known_enrichment_payloads([changed_raw], known) == 0
    assert changed_raw["starting_price_eur"] == "12 000 €"
    assert "starting_price_extraction" not in changed_raw
    assert "document_facts_version" not in changed_raw


def test_pipeline_aborts_before_publication_when_known_sale_lookup_fails(monkeypatch) -> None:
    settings = _settings()
    settings["incremental_enrichment"] = True
    finish_calls: list[tuple[str, dict[str, object], dict[str, list[str]]]] = []

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(
        main,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finish_calls.append((status, summary, errors)),
    )
    monkeypatch.setattr(
        main,
        "fetch_known_sale_details",
        lambda: (_ for _ in ()).throw(RuntimeError("known sale query timed out")),
    )
    monkeypatch.setattr(
        main,
        "scrape_avoventes_aquitaine_result",
        lambda known=None: (_ for _ in ()).throw(AssertionError("scraping must not start")),
    )

    result = main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=True))

    assert result == 1
    assert finish_calls == [
        (
            "failed",
            {"stage": "known_sale_lookup"},
            {
                "avoventes": [],
                "licitor": [],
                "vench": [],
                "info_encheres": [],
                "encheres_publiques": [],
                "petites_affiches": [],
                "cessions_etat": [],
                "agrasc": [],
                "encheres_immobilieres": [],
                "notaires": [],
                "supabase": ["known sale query timed out"],
            },
        )
    ]


def _settings() -> dict[str, object]:
    return {
        "incremental_enrichment": False,
        "pipeline_pdf_workers": 1,
        "pipeline_enrich_workers": 1,
        "pipeline_llm_workers": 1,
        "pipeline_llm_backfill_progress_every": 5,
        "pipeline_llm_failure_cooldown_hours": 24,
        "pipeline_pdf_max_targets": 0,
        "pipeline_llm_max_targets": 0,
        "enable_licitor_benchmark": False,
        "enable_vench_benchmark": False,
        "enable_info_encheres_benchmark": False,
        "enable_encheres_publiques_benchmark": False,
        "enable_petites_affiches_benchmark": False,
        "enable_cessions_etat_benchmark": False,
        "enable_agrasc_benchmark": False,
        "enable_encheres_immobilieres_benchmark": False,
        "enable_notaires_benchmark": False,
        "licitor_max_pages": 1,
        "vench_max_pages": 1,
        "info_encheres_max_pages": 1,
        "encheres_publiques_max_pages": 1,
        "cessions_etat_max_pages": 1,
        "encheres_immobilieres_max_pages": 1,
        "notaires_max_pages": 1,
        "llm_prompt_version": "auction_llm_v5",
    }


def _raw_sale() -> dict[str, object]:
    return {
        "source_name": "avoventes",
        "source_url": "https://example.test/vente",
        "address": "1 rue Test",
        "city": "Bordeaux",
        "postal_code": "33000",
        "property_type": "apartment",
        "sale_date": "10 janvier 2027 à 9h00",
        "starting_price_eur": "100 000 €",
        "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
    }


def _materialize_current_pdf_proof(sale: AuctionSale, tmp_path, monkeypatch) -> None:
    """Give freshness checks the same complete evidence as a real PDF pass."""
    from src.pdf_document_selection import _store_document_analysis_status
    from src.pdf_enrichment import sale_storage_id
    from src.pdf_progress import PDF_TEXT_CACHE_VERSION

    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    text = "Preuve PDF stable pour la fixture."
    payload = {
        "url": sale.documents[0]["url"],
        "label": sale.documents[0].get("label"),
        "text": text,
        "sha256": hashlib.sha256(b"fixture-pdf-bytes").hexdigest(),
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "text_chars": len(text),
        "text_present": True,
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "complete": True,
        "extraction_status": "extracted",
        "extraction_method": "fixture",
        "failed_pages": [],
        "page_count": 1,
        "http_checked_at": datetime.now(UTC).isoformat(),
    }
    _store_document_analysis_status(sale, sale.documents, [payload])
    (tmp_path / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([payload]),
        encoding="utf-8",
    )


def _fake_geocode(sale: AuctionSale) -> AuctionSale:
    try:
        main_calls = _fake_geocode.calls
    except AttributeError:
        main_calls = None
    if isinstance(main_calls, list):
        main_calls.append("geocode")
    sale.latitude = Decimal("44.84")
    sale.longitude = Decimal("-0.57")
    return sale


def _raise_pdf() -> None:
    raise RuntimeError("pdf boom")


def test_prepared_batch_survives_interruption_on_next_listing(monkeypatch):
    sales = [AuctionSale(source_name='avoventes', source_url=f'https://example.test/{i}',
                         starting_price_eur=10000) for i in range(26)]
    monkeypatch.setattr(main, 'load_settings', _settings)
    monkeypatch.setattr(main, 'create_run_in_supabase', lambda *a, **kw: 'batch-run')
    monkeypatch.setattr(main, 'fetch_known_sale_details', lambda: {})
    monkeypatch.setattr(main, 'fetch_enriched_content_hashes', lambda *a, **kw: set())
    monkeypatch.setattr(main, '_enabled_scrapers', lambda *a, **kw: {})
    monkeypatch.setattr(main, 'merge_duplicate_sales', lambda rows: sales)
    committed = []
    def prepare(sale, **kw):
        if sale is sales[-1]:
            raise KeyboardInterrupt('runner interrupted')
    monkeypatch.setattr(main, '_finalize_sale_for_app', prepare)
    monkeypatch.setattr(main, 'upsert_sales_to_supabase', lambda rows: committed.extend(rows) or len(rows))
    monkeypatch.setattr(main, 'upsert_observations_to_supabase', lambda rows: len(rows))
    with pytest.raises(KeyboardInterrupt):
        main.run_pipeline(main.PipelineOptions(use_llm=False))
    assert committed == sales[:25]


def test_surface_context_deduplicates_copied_fields_without_losing_distinct_evidence():
    repeated = 'Chambre 12 m². Chambre 12 m².'
    sale = AuctionSale(source_name='test', source_url='https://example.test/context',
                       description=repeated, raw_text=repeated,
                       raw_payload={'source_description': repeated, 'source_blocks': {'extra': 'Terrain 500 m².'}})
    assert main._surface_reasoning_context_for_sale(sale) == repeated + '\nTerrain 500 m².'


def test_mismatched_detail_never_rehydrates_previous_contaminated_content():
    raw = {'source_url': 'https://example.test/9486', 'description': 'List card',
           'source_identity_mismatch': True, '_detail_fetch_failed': True}
    known = {raw['source_url']: {'description': 'Wrong property 9490 with a longer description',
                               'surface_m2': 999, 'raw_payload': {'llm_display_description': 'Wrong summary'}}}
    assert main._hydrate_known_unchanged_sales([raw], known) == 0
    assert main._preserve_known_enrichment_payloads([raw], known) == 0
    assert raw['description'] == 'List card'
    assert 'surface_m2' not in raw
    assert 'llm_display_description' not in raw


def test_superseded_enrichment_checkpoint_is_skipped(monkeypatch):
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/superseded",
        starting_price_eur=10000,
    )
    monkeypatch.setattr(main, "_finalize_sale_for_app", lambda sale, **kwargs: None)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda sales, **kwargs: 0)

    assert main._checkpoint_enrichment(sale) is False
