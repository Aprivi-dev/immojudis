"""Keep attachment invalidation correct when another PDF remains readable."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import fitz
import httpx
import pytest

from src.asset_normalization import normalize_asset_features
from src.normalize import normalize_sale

pdf = importlib.import_module("src.pdf_enrichment")
selection = importlib.import_module("src.pdf_document_selection")
facts = importlib.import_module("src.pdf_fact_extraction")


@pytest.mark.parametrize("response_status,independent", [(404, False), (404, True), (503, False)])
def test_terminal_piece_revokes_its_facts_with_another_piece_still_readable(
    monkeypatch, tmp_path: Path, response_status: int, independent: bool,
):
    removed_url = "https://source.example/descriptif.pdf"
    retained_url = "https://source.example/conditions.pdf"
    sale = normalize_sale({
        "source_name": "info_encheres",
        "source_url": "https://source.example/mixed-dossier",
        "documents": [
            {"url": removed_url, "label": "PV descriptif"},
            {"url": retained_url, "label": "Conditions de vente"},
        ],
    })
    settings = pdf.load_settings() | {
        "incremental_enrichment": True,
        "pdf_ocr_enabled": False,
        "pdf_docling_enabled": False,
        "pdf_extractor": "pymupdf",
    }
    monkeypatch.setattr(pdf, "load_settings", lambda: settings)
    monkeypatch.setattr(selection, "load_settings", lambda: settings)
    directories = {}
    for name in ("DOCUMENTS_DIR", "PDF_TEXTS_DIR", "PDF_DOCUMENT_TEXTS_DIR", "DOCLING_TEXTS_DIR"):
        directories[name] = tmp_path / name
        directories[name].mkdir()
        monkeypatch.setattr(pdf, name, directories[name])
    monkeypatch.setattr(facts, "PDF_TEXTS_DIR", directories["PDF_TEXTS_DIR"])
    documents = {}
    for url, text in [
        (removed_url, "Appartement de 50 m², 2 pièces, 1 chambre. Ancien descriptif du logement."),
        (retained_url, "Mise à prix : 30 000 euros. Conditions de vente toujours disponibles."),
    ]:
        with fitz.open() as document:
            page = document.new_page()
            page.insert_text((72, 72), text)
            documents[url] = document.tobytes()
    terminal = False

    def response(url, **kwargs):
        status = response_status if terminal and url == removed_url else 200
        return httpx.Response(
            status,
            content=documents[url] if status == 200 else b"",
            headers={"content-type": "application/pdf" if status == 200 else "text/html"},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(pdf, "_send_pinned_document_request", response)
    original_download = pdf.download_documents
    monkeypatch.setattr(pdf, "download_documents", lambda current, *, stats: original_download(
        current, output_root=directories["DOCUMENTS_DIR"], stats=stats,
    ))
    pdf.enrich_sale_from_pdfs(sale)
    normalize_asset_features(sale)
    assert (sale.surface_m2, sale.rooms_count, sale.bedrooms_count) == (50, 2, 1)
    assert sale.app_surface_m2 == 50
    assert sale.starting_price_eur == 30000
    if independent:
        sale.surface_m2 = 99
        sale.app_surface_m2 = 99
        sale.rooms_count = 9
        sale.bedrooms_count = 4

    # Force a real per-URL HTTP revalidation while retaining the page caches.
    stale = "2020-01-01T00:00:00+00:00"
    for path in directories["DOCUMENTS_DIR"].rglob("*.http.json"):
        metadata = json.loads(path.read_text())
        metadata["checked_at"] = stale
        path.write_text(json.dumps(metadata))
    analysis = sale.raw_payload["document_analysis"]
    for url in analysis["http_checked_at_by_url"]:
        analysis["http_checked_at_by_url"][url] = stale
    analysis["cache_proof"]["verified_at"] = stale
    for item in analysis["cache_proof"]["documents"]:
        item["http_checked_at"] = stale
    terminal = True
    pdf.enrich_sale_from_pdfs(sale)

    if response_status == 503:
        assert "Ancien descriptif" in (sale.raw_text or "")
        normalize_asset_features(sale)
        assert (sale.surface_m2, sale.app_surface_m2, sale.rooms_count, sale.bedrooms_count) == (50, 50, 2, 1)
    else:
        assert sale.raw_payload["document_analysis"]["documents_extracted"] == 1
        assert "Ancien descriptif" not in (sale.raw_text or "")
        expected = (99, 99, 9, 4) if independent else (None, None, None, None)
        assert (sale.surface_m2, sale.app_surface_m2, sale.rooms_count, sale.bedrooms_count) == expected
    assert sale.starting_price_eur == 30000
