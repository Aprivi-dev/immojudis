"""Regression coverage for bounded HTTP revalidation of complete PDF manifests."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import fitz
import httpx

import src.config as config
from src.freshness import documents_are_current, timestamp_is_fresh
from src.models import AuctionSale

pdf_enrichment = importlib.import_module("src.pdf_enrichment")
pdf_document_selection = importlib.import_module("src.pdf_document_selection")
pdf_fact_extraction = importlib.import_module("src.pdf_fact_extraction")


PDF_SETTINGS = {
    "user_agent": "immojudis-http-revalidation-test",
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


def _make_pdf(path: Path, text: str) -> bytes:
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), text)
        document.save(path)
    return path.read_bytes()


def _sale_and_pdf_bytes(tmp_path: Path) -> tuple[AuctionSale, dict[str, bytes]]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    documents: list[dict[str, str]] = []
    pdf_bytes: dict[str, bytes] = {}
    for index in range(16):
        url = f"https://example.test/http-revalidation-{index:02d}.pdf"
        pdf_bytes[url] = _make_pdf(
            tmp_path / f"fixture-{index:02d}.pdf",
            f"Pièce {index:02d}. Surface habitable : {80 + index} m2. "
            "Texte synthétique pour le test de revalidation HTTP.",
        )
        documents.append(
            {
                "label": f"Pièce {index:02d}",
                "url": url,
                "document_type": "pdf",
            }
        )
    return (
        AuctionSale(
            source_name="avoventes",
            source_url="https://example.test/http-revalidation-sale",
            starting_price_eur=100_000,
            property_type="other",
            documents=documents,
        ),
        pdf_bytes,
    )


def _configure_runtime(monkeypatch, pdf_bytes: dict[str, bytes], tmp_path: Path) -> tuple[list[str], dict[str, bool]]:
    documents_dir = tmp_path / "documents"
    pdf_texts_dir = tmp_path / "pdf-texts"
    document_texts_dir = tmp_path / "document-texts"
    docling_texts_dir = tmp_path / "docling-texts"
    for directory in (documents_dir, pdf_texts_dir, document_texts_dir, docling_texts_dir):
        directory.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: PDF_SETTINGS)
    monkeypatch.setattr(pdf_document_selection, "load_settings", lambda: PDF_SETTINGS)
    monkeypatch.setattr(pdf_enrichment, "DOCUMENTS_DIR", documents_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", document_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "DOCLING_TEXTS_DIR", docling_texts_dir)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(config, "PDF_TEXTS_DIR", pdf_texts_dir)

    requests: list[str] = []
    revalidate_only = {"value": False}

    def fake_download_response(
        url: str,
        *,
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> httpx.Response:
        del headers, timeout_seconds
        requests.append(url)
        if url not in pdf_bytes:
            raise AssertionError(f"unexpected synthetic PDF URL: {url}")
        if revalidate_only["value"]:
            return httpx.Response(
                304,
                headers={"etag": '"stable"'},
                request=httpx.Request("GET", url),
            )
        return httpx.Response(
            200,
            headers={"content-type": "application/pdf", "etag": '"stable"'},
            content=pdf_bytes[url],
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(pdf_enrichment, "_download_document_response", fake_download_response)
    real_download_documents = pdf_enrichment.download_documents
    monkeypatch.setattr(
        pdf_enrichment,
        "download_documents",
        lambda sale, *, stats=None: real_download_documents(
            sale,
            output_root=documents_dir,
            stats=stats,
        ),
    )
    return requests, revalidate_only


def _make_all_sidecars_stale(sale: AuctionSale, documents_dir: Path) -> None:
    sale_dir = documents_dir / pdf_enrichment.sale_storage_id(sale)
    for document in sale.documents:
        path = sale_dir / pdf_enrichment._document_filename(document)
        metadata_path = path.with_suffix(path.suffix + ".http.json")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["checked_at"] = "2020-01-01T00:00:00+00:00"
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")


def _proof_by_url(sale: AuctionSale) -> dict[str, dict[str, object]]:
    analysis = sale.raw_payload["document_analysis"]
    return {
        str(item["url"]): item
        for item in analysis["cache_proof"]["documents"]
    }


def test_expired_complete_manifest_revalidates_in_six_six_four_passes(
    monkeypatch,
    tmp_path: Path,
) -> None:
    sale, pdf_bytes = _sale_and_pdf_bytes(tmp_path / "fixtures")
    requests, revalidate_only = _configure_runtime(monkeypatch, pdf_bytes, tmp_path)
    extraction_urls: list[str] = []
    real_extract = pdf_enrichment.extract_attached_document

    def tracked_extract(file: str | Path, *, document: dict[str, str] | None = None) -> dict[str, object]:
        assert document is not None
        extraction_urls.append(document["url"])
        return real_extract(file, document=document)

    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", tracked_extract)

    # Establish a complete modern manifest and its local cache first.
    for _ in range(3):
        pdf_enrichment.enrich_sale_from_pdfs(sale)
    assert documents_are_current(sale)
    assert len(requests) == 16
    assert len(extraction_urls) == 16

    documents_dir = tmp_path / "documents"
    _make_all_sidecars_stale(sale, documents_dir)
    revalidate_only["value"] = True
    urls = [document["url"] for document in sale.documents]
    old_timestamp = "2020-01-01T00:00:00+00:00"
    analysis = sale.raw_payload["document_analysis"]
    analysis["cache_proof"]["verified_at"] = old_timestamp
    for proof_item in analysis["cache_proof"]["documents"]:
        proof_item["http_checked_at"] = old_timestamp

    expected_batches = (urls[:6], urls[6:12], urls[12:])
    for batch_number, expected_batch in enumerate(expected_batches, start=1):
        pdf_enrichment.enrich_sale_from_pdfs(sale)
        assert requests[16 + sum(len(batch) for batch in expected_batches[: batch_number - 1]) :] == list(
            expected_batch
        )
        proof = _proof_by_url(sale)
        assert len(proof) == 16
        for url in expected_batch:
            assert proof[url]["http_checked_at"] != old_timestamp
            assert timestamp_is_fresh(proof[url]["http_checked_at"])
        for url in urls[: sum(len(batch) for batch in expected_batches[:batch_number])]:
            assert timestamp_is_fresh(proof[url]["http_checked_at"])
        for url in urls[sum(len(batch) for batch in expected_batches[:batch_number]) :]:
            assert proof[url]["http_checked_at"] == old_timestamp, (batch_number, url, proof[url])
        assert documents_are_current(sale) is (batch_number == 3)
        cache_path = tmp_path / "pdf-texts" / f"{pdf_enrichment.sale_storage_id(sale)}.json"
        assert len(json.loads(cache_path.read_text(encoding="utf-8"))) == 16

    # A 304 keeps the existing bytes and local text; it does not trigger a
    # second extraction. With all per-document checks fresh, the next pass is
    # a no-op and performs no network request.
    assert len(extraction_urls) == 16
    before_noop_requests = len(requests)
    pdf_enrichment.enrich_sale_from_pdfs(sale)
    assert len(requests) == before_noop_requests
    assert len(extraction_urls) == 16
    assert documents_are_current(sale)
