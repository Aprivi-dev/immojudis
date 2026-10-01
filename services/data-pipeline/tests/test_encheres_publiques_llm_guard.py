from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from src import main, revalidate_displays
from src.config import EncheresPubliquesAccessNotAuthorized
from src.models import AuctionSale
from src.sources.common import ScrapeResult


def _settings() -> dict[str, object]:
    return {
        "llm_enabled": True,
        "llm_prompt_version": "test-prompt",
        "llm_display_prompt_version": "test-display-prompt",
        "replicate_model": "test-model",
        "pipeline_llm_backfill_max_targets": 5,
        "pipeline_llm_workers": 1,
        "pipeline_llm_backfill_progress_every": 5,
    }


def _sale(source_name: str, source_url: str) -> AuctionSale:
    return AuctionSale(
        source_name=source_name,
        source_url=source_url,
        title="Maison",
        description="Maison avec jardin",
        starting_price_eur=100_000,
        raw_payload={"llm_extraction": {"display_description": "Résumé existant"}},
    )


def _guard(calls: list[dict[str, Any]]):
    def check(**kwargs: Any) -> None:
        calls.append(kwargs)
        if kwargs["source_name"] == "encheres_publiques":
            raise EncheresPubliquesAccessNotAuthorized("test authorization required")

    return check


def test_llm_backfill_skips_all_unauthorized_sales_before_client_creation(monkeypatch, capsys) -> None:
    settings = _settings()
    blocked = _sale(
        "encheres_publiques",
        "https://www.encheres-publiques.com/vente/blocked",
    )
    guard_calls: list[dict[str, Any]] = []
    finished: list[tuple[object, ...]] = []

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "fetch_sales_needing_llm_descriptions", lambda **_: [blocked])
    monkeypatch.setattr(main, "require_encheres_publiques_sale_access", _guard(guard_calls))
    monkeypatch.setattr(
        main,
        "create_llm_client",
        lambda: pytest.fail("blocked backfill must not create an LLM client"),
    )
    monkeypatch.setattr(
        main,
        "create_run_in_supabase",
        lambda *args, **kwargs: pytest.fail("no run for skipped targets"),
    )
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args: finished.append(args))

    assert main.run_llm_description_backfill(main.PipelineOptions(llm_backfill=True, upsert=True)) == 0

    assert len(guard_calls) == 1
    assert guard_calls[0]["source_url"] == blocked.source_url
    assert guard_calls[0]["source_urls"] == blocked.source_urls
    assert finished and finished[0][1] == "succeeded"
    assert finished[0][2]["skipped_unauthorized"] == 1
    assert "skipped_unauthorized: 1" in capsys.readouterr().out


def test_llm_backfill_only_enriches_authorized_sales(monkeypatch) -> None:
    settings = _settings()
    allowed = _sale("avoventes", "https://avoventes.fr/vente/allowed")
    blocked = _sale("encheres_publiques", "https://www.encheres-publiques.com/vente/blocked")
    guard_calls: list[dict[str, Any]] = []
    enriched: list[str] = []

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "fetch_sales_needing_llm_descriptions", lambda **_: [blocked, allowed])
    monkeypatch.setattr(main, "require_encheres_publiques_sale_access", _guard(guard_calls))
    monkeypatch.setattr(main, "create_llm_client", lambda: object())

    def enrich(sale: AuctionSale, *, client: object) -> main.LLMEnrichmentStats:
        del client
        enriched.append(sale.source_url)
        return main.LLMEnrichmentStats(analyzed=1, valid_json=1)

    monkeypatch.setattr(main, "enrich_sale_with_llm", enrich)

    assert main.run_llm_description_backfill(main.PipelineOptions(llm_backfill=True, upsert=False)) == 0

    assert enriched == [allowed.source_url]
    assert {call["source_url"] for call in guard_calls} == {allowed.source_url, blocked.source_url}


def test_cached_display_revalidation_skips_unauthorized_sales(monkeypatch) -> None:
    settings = _settings()
    allowed = _sale("avoventes", "https://avoventes.fr/vente/allowed")
    blocked = _sale("encheres_publiques", "https://www.encheres-publiques.com/vente/blocked")
    guard_calls: list[dict[str, Any]] = []
    revalidated: list[str] = []
    persisted: list[str] = []

    monkeypatch.setattr(revalidate_displays, "load_settings", lambda: settings)
    monkeypatch.setattr(
        revalidate_displays,
        "fetch_sales_needing_llm_descriptions",
        lambda **_: [blocked, allowed],
    )
    monkeypatch.setattr(
        revalidate_displays,
        "require_encheres_publiques_sale_access",
        _guard(guard_calls),
    )

    def apply_cached(sale: AuctionSale, **_: object) -> None:
        revalidated.append(sale.source_url)
        sale.raw_payload["revalidated"] = True

    monkeypatch.setattr(revalidate_displays, "apply_cached_llm_extraction_to_sale", apply_cached)
    monkeypatch.setattr(revalidate_displays, "has_current_display", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        revalidate_displays,
        "upsert_sales_to_supabase",
        lambda rows, **_: persisted.append(rows[0].source_url) or 1,
    )

    report = revalidate_displays.revalidate_cached_displays(limit=2)

    assert revalidated == [allowed.source_url]
    assert persisted == [allowed.source_url]
    assert report == {
        "selected": 2,
        "revalidated": 1,
        "rejected": 0,
        "without_cache": 0,
        "persisted": 1,
        "skipped_unauthorized": 1,
    }
    assert {call["source_url"] for call in guard_calls} == {allowed.source_url, blocked.source_url}


def test_ordinary_pipeline_skips_unauthorized_ep_document_before_enrichment(monkeypatch, capsys) -> None:
    settings = {
        **_settings(),
        "incremental_enrichment": False,
        "pipeline_pdf_workers": 1,
        "pipeline_llm_workers": 1,
        "pipeline_pdf_max_targets": 0,
        "pipeline_llm_max_targets": 0,
        "pipeline_enrichment_queue_enabled": False,
        "cadastre_enrich_enabled": False,
        "dpe_enrich_enabled": False,
        "enable_encheres_publiques_benchmark": False,
        "encheres_publiques_access_authorized": False,
    }
    raw_sale = {
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/vente/cross-source-document",
        "title": "Maison",
        "description": "Maison avec jardin",
        "starting_price_eur": 100_000,
        "documents": [
            {
                "label": "PV EP",
                "url": "https://www.encheres-publiques.com/documents/pv.pdf",
                "document_type": "pdf",
            }
        ],
    }
    result = ScrapeResult([raw_sale], [], {"coverage_complete": True})

    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "register_run", lambda _: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "_enabled_scrapers", lambda *args, **kwargs: {"avoventes": lambda: result})
    monkeypatch.setattr(main, "_run_scraper", lambda *args, **kwargs: (result, 0.0))
    monkeypatch.setattr(main, "record_sale_decisions", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "merge_duplicate_sales", lambda sales: sales)
    monkeypatch.setattr(main, "_finalize_sale_for_app", lambda sale, *, geocode: None)
    monkeypatch.setattr(main, "mark_past_sales", lambda sales: SimpleNamespace(marked_past=0))
    monkeypatch.setattr(main, "export_sales", lambda sales: ("sales.json", "sales.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "create_llm_client", lambda: pytest.fail("unauthorized sale must not create an LLM client"))
    for name in (
        "refresh_operational_display",
        "apply_cached_llm_extraction_to_sale",
        "enrich_sale_from_pdfs",
        "enrich_sale_with_llm",
    ):
        monkeypatch.setattr(
            main,
            name,
            lambda *args, _name=name, **kwargs: pytest.fail(f"unauthorized sale reached {_name}"),
        )

    assert main.run_pipeline(
        main.PipelineOptions(source="avoventes", use_llm=True, heavy_enrichment=True, upsert=False)
    ) == 0

    output = capsys.readouterr().out
    assert "- enriched: 1" in output
    assert "timing_enrichment_unauthorized_skipped: 1" in output
