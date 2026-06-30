from decimal import Decimal
import sys
import types

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


def test_needs_heavy_enrichment_skips_complete_sale() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        property_type="apartment",
        app_surface_m2=Decimal("42"),
        occupancy_status="vacant",
        rooms_count=2,
        raw_text="Appartement libre de 42 m2.",
    )

    assert main._needs_heavy_enrichment(sale) is False


def test_needs_heavy_enrichment_keeps_incomplete_sale() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        property_type="apartment",
        documents=[{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
    )

    assert main._needs_heavy_enrichment(sale) is True


def test_run_pipeline_upserts_light_sale_before_pdf_enrichment(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "touch_last_seen_for_content_hashes", lambda hashes: 0)
    monkeypatch.setattr(main, "touch_last_seen_for_source_urls", lambda urls: 0)
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult([_raw_sale()], []))
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", lambda sale: calls.append("pdf") or (_raise_pdf()))
    monkeypatch.setattr(main, "enrich_sale_with_llm", lambda *args, **kwargs: main.LLMEnrichmentStats())
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)

    def upsert_sales(sales: list[AuctionSale]) -> int:
        calls.append("upsert")
        assert sales[0].latitude is not None
        assert sales[0].last_run_id == "run-1"
        return len(sales)

    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert_sales)
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales: calls.append("observations") or len(sales))

    assert main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=True)) == 0
    assert calls.index("upsert") < calls.index("pdf")


def _settings() -> dict[str, object]:
    return {
        "incremental_enrichment": False,
        "pipeline_pdf_workers": 1,
        "pipeline_enrich_workers": 1,
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


def _fake_geocode(sale: AuctionSale) -> AuctionSale:
    sale.latitude = Decimal("44.84")
    sale.longitude = Decimal("-0.57")
    return sale


def _raise_pdf() -> None:
    raise RuntimeError("pdf boom")
