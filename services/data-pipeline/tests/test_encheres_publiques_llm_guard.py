from __future__ import annotations

from types import SimpleNamespace

import pytest

from src import main
from src.sources.common import ScrapeResult


def _settings() -> dict[str, object]:
    return {
        "llm_enabled": True,
        "llm_prompt_version": "test-prompt",
        "replicate_model": "test-model",
        "pipeline_llm_workers": 1,
    }


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
    monkeypatch.setattr(main, "finalize_sale_for_app", lambda sale, *, geocode: None)
    monkeypatch.setattr(main, "mark_past_sales", lambda sales: SimpleNamespace(marked_past=0))
    monkeypatch.setattr(main, "export_sales", lambda sales: ("sales.json", "sales.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "create_llm_client", lambda: pytest.fail("unauthorized sale must not create an LLM client"))
    for name in (
        "settle_source_change_without_documents",
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
