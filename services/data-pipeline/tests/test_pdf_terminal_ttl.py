"""Terminal PDF observations must obey a per-URL TTL."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import fitz
import httpx

from src.models import AuctionSale
from src.normalize import normalize_sale
from src.pdf_progress import stale_complete_document_urls

pdf_enrichment = importlib.import_module("src.pdf_enrichment")
pdf_document_selection = importlib.import_module("src.pdf_document_selection")
queued_runner = importlib.import_module("src.queued_runner")


def _sale(source_url: str, documents: list[dict[str, str]]) -> AuctionSale:
    return normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": source_url,
            "status": "upcoming",
            "documents": documents,
        }
    )


def _settings() -> dict[str, object]:
    return {
        "user_agent": "immojudis-terminal-ttl-test",
        "request_timeout_seconds": 5,
        "incremental_enrichment": True,
        "pdf_max_documents_per_sale": 6,
        "pdf_max_download_mb": 25,
        "pdf_max_total_pages": 300,
        "pdf_max_extract_pages": 75,
        "pdf_ocr_enabled": False,
        "pdf_ocr_language": "fra",
        "pdf_ocr_tessdata": None,
        "pdf_extractor": "pymupdf",
        "pdf_docling_enabled": False,
        "pdf_docling_threshold_chars": 1000,
        "pdf_docling_timeout_seconds": 5,
        "pdf_docling_ocr_max_pages": 0,
        "pdf_docling_ocr_max_size_mb": 0,
        "pdf_docling_ocr_mode": "disabled",
        "pdf_docling_chunk_pages": 10,
        "pdf_docling_ocr_chunk_pages": 10,
    }


def _make_metadata_stale(sale: AuctionSale, output_root: Path, timestamp: str) -> None:
    document = sale.documents[0]
    file_path = output_root / pdf_enrichment.sale_storage_id(sale) / pdf_enrichment._document_filename(document)
    metadata_path = file_path.with_suffix(file_path.suffix + ".http.json")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["checked_at"] = timestamp
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")


def _make_pdf(path: Path, text: str) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), text)
        document.save(path)
    return path.read_bytes()


def test_permanent_404_is_retried_only_after_terminal_ttl(monkeypatch, tmp_path: Path) -> None:
    url = "https://source.example/missing.pdf"
    sale = _sale(
        "https://source.example/sale-terminal-ttl",
        [{"label": "PV absent", "url": url, "type": "pdf"}],
    )
    monkeypatch.setattr(pdf_enrichment, "load_settings", _settings)
    monkeypatch.setattr(pdf_document_selection, "load_settings", _settings)
    responses = iter(
        [
            httpx.Response(404, headers={"content-type": "text/html"}),
            httpx.Response(
                200,
                headers={"content-type": "application/pdf"},
                content=b"%PDF-1.4\n%%EOF",
                request=httpx.Request("GET", url),
            ),
        ]
    )
    monkeypatch.setattr(
        pdf_enrichment,
        "_send_pinned_document_request",
        lambda *args, **kwargs: next(responses),
    )

    first_stats = pdf_enrichment.PdfEnrichmentStats()
    assert pdf_enrichment.download_documents(sale, output_root=tmp_path, stats=first_stats) == []
    assert first_stats.permanent_document_failures == [{"url": url, "reason": "not_found"}]
    pdf_document_selection._store_document_analysis_status(
        sale,
        [],
        [],
        permanent_document_failures=first_stats.permanent_document_failures,
    )
    analysis = sale.raw_payload["document_analysis"]
    assert analysis["terminal_document_urls"] == [url]

    def fail_fresh_retry(*args, **kwargs):
        raise AssertionError("fresh terminal observations must not retry")

    monkeypatch.setattr(pdf_enrichment, "_send_pinned_document_request", fail_fresh_retry)
    fresh_stats = pdf_enrichment.PdfEnrichmentStats()
    assert pdf_enrichment.download_documents(sale, output_root=tmp_path, stats=fresh_stats) == []
    assert fresh_stats.permanent_document_failures == []

    stale_timestamp = "2020-01-01T00:00:00+00:00"
    _make_metadata_stale(sale, tmp_path, stale_timestamp)
    analysis["http_checked_at_by_url"][url] = stale_timestamp
    analysis["cache_proof"]["verified_at"] = stale_timestamp
    monkeypatch.setattr(
        pdf_enrichment,
        "_send_pinned_document_request",
        lambda *args, **kwargs: next(responses),
    )
    stale_stats = pdf_enrichment.PdfEnrichmentStats()
    refreshed = pdf_enrichment.download_documents(sale, output_root=tmp_path, stats=stale_stats)
    assert [document["url"] for document in refreshed] == [url]
    assert stale_stats.downloaded == 1


def test_robots_block_is_rechecked_after_ttl_but_social_candidate_stays_skipped(
    monkeypatch,
    tmp_path: Path,
) -> None:
    blocked_url = "https://www.licitor.com/data/pub/media/annonce/pv.pdf"
    social_url = "https://www.facebook.com/auction/123"
    sale = _sale(
        "https://www.licitor.com/annonce/terminal-robots-ttl",
        [
            {"label": "PV bloqué", "url": blocked_url, "type": "pdf"},
            {"label": "Dossier Facebook", "url": social_url, "type": "pdf"},
        ],
    )
    monkeypatch.setattr(pdf_enrichment, "load_settings", _settings)
    monkeypatch.setattr(pdf_document_selection, "load_settings", _settings)
    monkeypatch.setattr(
        pdf_enrichment,
        "_send_pinned_document_request",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("robots-disallowed documents must not reach HTTP")
        ),
    )

    first_stats = pdf_enrichment.PdfEnrichmentStats()
    assert pdf_enrichment.download_documents(sale, output_root=tmp_path, stats=first_stats) == []
    assert first_stats.blocked_document_urls == [blocked_url]
    pdf_document_selection._store_document_analysis_status(
        sale,
        [],
        [],
        blocked_document_urls=first_stats.blocked_document_urls,
    )
    analysis = sale.raw_payload["document_analysis"]
    assert analysis["skipped_document_urls"] == [social_url]
    assert stale_complete_document_urls(
        analysis,
        sale.documents,
        tmp_path / pdf_enrichment.sale_storage_id(sale),
        pdf_enrichment._document_filename,
    ) == set()

    stale_timestamp = "2020-01-01T00:00:00+00:00"
    analysis["http_checked_at_by_url"][blocked_url] = stale_timestamp
    analysis["cache_proof"]["verified_at"] = stale_timestamp
    stale = stale_complete_document_urls(
        analysis,
        sale.documents,
        tmp_path / pdf_enrichment.sale_storage_id(sale),
        pdf_enrichment._document_filename,
    )
    assert stale == {blocked_url}
    stale_stats = pdf_enrichment.PdfEnrichmentStats()
    assert pdf_enrichment.download_documents(sale, output_root=tmp_path, stats=stale_stats) == []
    assert stale_stats.blocked_document_urls == [blocked_url]


def test_terminal_http_refresh_drops_old_pdf_evidence_until_200(
    monkeypatch,
    tmp_path: Path,
) -> None:
    url = "https://source.example/transition.pdf"
    sale = _sale(
        "https://source.example/terminal-transition",
        [{"label": "PV", "url": url, "type": "pdf"}],
    )
    settings = _settings()
    documents_dir = tmp_path / "documents"
    pdf_texts_dir = tmp_path / "pdf-texts"
    document_texts_dir = tmp_path / "document-texts"
    docling_texts_dir = tmp_path / "docling-texts"
    for directory in (documents_dir, pdf_texts_dir, document_texts_dir, docling_texts_dir):
        directory.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: settings)
    monkeypatch.setattr(pdf_document_selection, "load_settings", lambda: settings)
    monkeypatch.setattr(pdf_enrichment, "DOCUMENTS_DIR", documents_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", document_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "DOCLING_TEXTS_DIR", docling_texts_dir)
    pdf_fact_extraction = importlib.import_module("src.pdf_fact_extraction")
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", pdf_texts_dir)

    old_pdf = _make_pdf(tmp_path / "old.pdf", "Ancien texte documentaire.")
    new_pdf = _make_pdf(tmp_path / "new.pdf", "Nouveau texte documentaire après réouverture.")
    responses = iter(
        [
            httpx.Response(
                200,
                headers={"content-type": "application/pdf"},
                content=old_pdf,
                request=httpx.Request("GET", url),
            ),
            httpx.Response(404, headers={"content-type": "text/html"}, request=httpx.Request("GET", url)),
            httpx.Response(
                200,
                headers={"content-type": "application/pdf"},
                content=new_pdf,
                request=httpx.Request("GET", url),
            ),
        ]
    )
    monkeypatch.setattr(
        pdf_enrichment,
        "_send_pinned_document_request",
        lambda *args, **kwargs: next(responses),
    )
    real_download_documents = pdf_enrichment.download_documents
    monkeypatch.setattr(
        pdf_enrichment,
        "download_documents",
        lambda current_sale, *, stats=None: real_download_documents(
            current_sale,
            output_root=documents_dir,
            stats=stats,
        ),
    )

    pdf_enrichment.enrich_sale_from_pdfs(sale)
    assert queued_runner._pdf_evidence_is_terminal_for_facts(sale) is False
    assert sale.raw_payload["document_analysis"]["documents_extracted"] == 1

    stale_timestamp = "2020-01-01T00:00:00+00:00"
    _make_metadata_stale(sale, documents_dir, stale_timestamp)
    analysis = sale.raw_payload["document_analysis"]
    analysis["http_checked_at_by_url"][url] = stale_timestamp
    analysis["cache_proof"]["verified_at"] = stale_timestamp
    for item in analysis["cache_proof"]["documents"]:
        item["http_checked_at"] = stale_timestamp

    pdf_enrichment.enrich_sale_from_pdfs(sale)
    analysis = sale.raw_payload["document_analysis"]
    assert analysis["terminal_document_urls"] == [url]
    assert analysis["documents_extracted"] == 0
    assert queued_runner._pdf_evidence_is_terminal_for_facts(sale) is True
    assert "Ancien texte documentaire." not in (sale.raw_text or "")
    assert "--- PDF TEXT ENRICHMENT ---" not in (sale.raw_text or "")
    cache_path = pdf_texts_dir / f"{pdf_enrichment.sale_storage_id(sale)}.json"
    assert json.loads(cache_path.read_text(encoding="utf-8")) == []

    # The 404 is itself subject to the per-URL TTL.  A fresh terminal
    # observation must remain excluded until a later stale revalidation.
    _make_metadata_stale(sale, documents_dir, stale_timestamp)
    analysis["http_checked_at_by_url"][url] = stale_timestamp
    analysis["cache_proof"]["verified_at"] = stale_timestamp
    for item in analysis["cache_proof"]["documents"]:
        item["http_checked_at"] = stale_timestamp

    pdf_enrichment.enrich_sale_from_pdfs(sale)
    analysis = sale.raw_payload["document_analysis"]
    assert analysis["terminal_document_urls"] == []
    assert analysis["documents_extracted"] == 1
    assert queued_runner._pdf_evidence_is_terminal_for_facts(sale) is False
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert len(cache) == 1
    assert cache[0]["text"] == "Nouveau texte documentaire après réouverture."
