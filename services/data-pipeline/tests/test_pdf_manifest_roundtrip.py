"""End-to-end bounded PDF manifest progression using local synthetic PDFs."""

from __future__ import annotations

import importlib
import json
import os
import tempfile
from pathlib import Path

os.environ.setdefault("PYTHON_DOTENV_DISABLED", "1")

import fitz
import httpx

import src.config as config

_SCRATCH_ROOT = Path(tempfile.mkdtemp(prefix="immojudis-pdf-manifest-"))
_SCRATCH_DOCUMENTS = _SCRATCH_ROOT / "documents"
_SCRATCH_PDF_TEXTS = _SCRATCH_ROOT / "pdf-texts"
_SCRATCH_DOCUMENT_TEXTS = _SCRATCH_ROOT / "document-texts"
_SCRATCH_DOCLING_TEXTS = _SCRATCH_ROOT / "docling-texts"
_CONFIG_DIR_NAMES = (
    "DATA_DIR",
    "RAW_DIR",
    "PROCESSED_DIR",
    "DOCUMENTS_DIR",
    "PDF_TEXTS_DIR",
    "PDF_DOCUMENT_TEXTS_DIR",
    "DOCLING_TEXTS_DIR",
    "LLM_EXTRACTIONS_DIR",
)
_ORIGINAL_CONFIG_DIRS = {name: getattr(config, name) for name in _CONFIG_DIR_NAMES}
for _name, _value in {
    "DATA_DIR": _SCRATCH_ROOT,
    "RAW_DIR": _SCRATCH_ROOT / "raw",
    "PROCESSED_DIR": _SCRATCH_ROOT / "processed",
    "DOCUMENTS_DIR": _SCRATCH_DOCUMENTS,
    "PDF_TEXTS_DIR": _SCRATCH_PDF_TEXTS,
    "PDF_DOCUMENT_TEXTS_DIR": _SCRATCH_DOCUMENT_TEXTS,
    "DOCLING_TEXTS_DIR": _SCRATCH_DOCLING_TEXTS,
    "LLM_EXTRACTIONS_DIR": _SCRATCH_ROOT / "llm-extractions",
}.items():
    setattr(config, _name, _value)

pdf_enrichment = importlib.import_module("src.pdf_enrichment")
pdf_document_selection = importlib.import_module("src.pdf_document_selection")
pdf_fact_extraction = importlib.import_module("src.pdf_fact_extraction")
documents_are_current = importlib.import_module("src.freshness").documents_are_current
AuctionSale = importlib.import_module("src.models").AuctionSale
_pdf_progress = importlib.import_module("src.pdf_progress")
PDF_PROGRESS_SCHEMA_VERSION = _pdf_progress.PDF_PROGRESS_SCHEMA_VERSION
PDF_TEXT_CACHE_VERSION = _pdf_progress.PDF_TEXT_CACHE_VERSION

# The scratch paths above protect module import from repository data. Restore
# the process-wide defaults immediately; the test applies its own paths with
# monkeypatch so collecting this file cannot redirect other tests.
for _name, _value in _ORIGINAL_CONFIG_DIRS.items():
    setattr(config, _name, _value)
for _module in (pdf_enrichment, pdf_fact_extraction):
    for _name in ("DOCUMENTS_DIR", "PDF_TEXTS_DIR", "PDF_DOCUMENT_TEXTS_DIR", "DOCLING_TEXTS_DIR"):
        if hasattr(_module, _name) and _name in _ORIGINAL_CONFIG_DIRS:
            setattr(_module, _name, _ORIGINAL_CONFIG_DIRS[_name])


_PDF_SETTINGS = {
    "user_agent": "immojudis-local-pdf-manifest-test",
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
        url = f"https://example.test/manifest-{index:02d}.pdf"
        path = tmp_path / f"manifest-{index:02d}.pdf"
        text = (
            f"Pièce documentaire {index:02d}. "
            f"Surface habitable : {80 + index} m2. "
            "Texte suffisamment long pour rester sur le chemin PyMuPDF."
        )
        pdf_bytes[url] = _make_pdf(path, text)
        documents.append(
            {
                "label": f"Pièce documentaire {index:02d}",
                "url": url,
                "document_type": "other",
            }
        )
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/manifest-sale",
        starting_price_eur=100_000,
        property_type="other",
        documents=documents,
    )
    return sale, pdf_bytes


def _configure_pdf_runtime(monkeypatch, pdf_bytes: dict[str, bytes], tmp_path: Path) -> list[str]:
    documents_dir = tmp_path / "documents"
    pdf_texts_dir = tmp_path / "pdf-texts"
    document_texts_dir = tmp_path / "document-texts"
    docling_texts_dir = tmp_path / "docling-texts"
    for directory in (documents_dir, pdf_texts_dir, document_texts_dir, docling_texts_dir):
        directory.mkdir(parents=True, exist_ok=True)

    settings = dict(_PDF_SETTINGS)
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: settings)
    monkeypatch.setattr(pdf_document_selection, "load_settings", lambda: settings)
    monkeypatch.setattr(pdf_enrichment, "DOCUMENTS_DIR", documents_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", document_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "DOCLING_TEXTS_DIR", docling_texts_dir)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(config, "PDF_TEXTS_DIR", pdf_texts_dir)

    download_urls: list[str] = []

    def fake_download_response(url: str, *, headers: dict[str, str], timeout_seconds: float) -> httpx.Response:
        del headers, timeout_seconds
        download_urls.append(url)
        if url not in pdf_bytes:
            raise AssertionError(f"unexpected synthetic PDF URL: {url}")
        return httpx.Response(
            200,
            headers={"content-type": "application/pdf"},
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
    return download_urls


def test_manifest_roundtrip_progresses_six_six_four_with_real_extraction(monkeypatch, tmp_path: Path) -> None:
    sale, pdf_bytes = _sale_and_pdf_bytes(tmp_path / "fixtures")
    download_urls = _configure_pdf_runtime(monkeypatch, pdf_bytes, tmp_path)
    extraction_urls: list[str] = []
    real_extract = pdf_enrichment.extract_attached_document

    def tracked_extract(file: str | Path, *, document: dict[str, str] | None = None) -> dict[str, object]:
        assert document is not None
        extraction_urls.append(document["url"])
        return real_extract(file, document=document)

    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", tracked_extract)

    expected_counts = (6, 12, 16)
    observed_last_success: list[str | None] = []
    for pass_number, expected_count in enumerate(expected_counts, start=1):
        stats = pdf_enrichment.enrich_sale_from_pdfs(sale)
        analysis = sale.raw_payload["document_analysis"]
        observed_last_success.append(analysis.get("last_successful_check_at"))
        cache_path = pdf_enrichment.PDF_TEXTS_DIR / f"{pdf_enrichment.sale_storage_id(sale)}.json"
        cache = json.loads(cache_path.read_text(encoding="utf-8"))

        assert len(cache) == expected_count
        assert {item["url"] for item in cache} == {document["url"] for document in sale.documents[:expected_count]}
        assert all(item["cache_version"] == PDF_TEXT_CACHE_VERSION for item in cache)
        assert all(item["complete"] is True for item in cache)
        assert all(item["extraction_status"] == "extracted" for item in cache)
        assert all(item["failed_pages"] == [] for item in cache)
        assert all(len(item["sha256"]) == 64 and set(item["sha256"]) <= set("0123456789abcdef") for item in cache)
        assert analysis["progress_schema_version"] == PDF_PROGRESS_SCHEMA_VERSION
        assert len(analysis["document_progress"]) == expected_count
        assert len(analysis["cache_proof"]["documents"]) == expected_count
        assert stats.documents_processed == expected_count - (expected_counts[pass_number - 2] if pass_number > 1 else 0)
        assert len(download_urls) == expected_count
        assert len(extraction_urls) == expected_count
        assert documents_are_current(sale) is (expected_count == 16)

    assert observed_last_success[0] is None
    assert observed_last_success[1] is None
    assert observed_last_success[2]
    assert len(set(extraction_urls)) == 16
    assert extraction_urls == download_urls

    # A fresh no-op pass must not download or extract an already complete
    # manifest while retaining the aggregate evidence.
    stats = pdf_enrichment.enrich_sale_from_pdfs(sale)
    assert stats.documents_processed == 0
    assert stats.document_cache_hits == 0
    assert len(download_urls) == 16
    assert len(extraction_urls) == 16
    assert documents_are_current(sale)

    # Expiring the whole 16-document HTTP manifest must revalidate only the
    # next six URLs per pass. The aggregate text cache is reused, while the
    # manifest remains incomplete until the final four have been checked.
    for metadata_path in (
        pdf_enrichment.DOCUMENTS_DIR / pdf_enrichment.sale_storage_id(sale)
    ).glob("*.http.json"):
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["checked_at"] = "2020-01-01T00:00:00+00:00"
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    pending_counts: list[int] = []
    for expected_pending in (10, 4, 0):
        stats = pdf_enrichment.enrich_sale_from_pdfs(sale)
        analysis = sale.raw_payload["document_analysis"]
        pending_counts.append(len(analysis["http_revalidation_pending_urls"]))
        assert stats.document_cache_hits == (6 if expected_pending else 4)
        assert documents_are_current(sale) is (expected_pending == 0)
    assert pending_counts == [10, 4, 0]
    assert len(download_urls) == 32
    assert len(extraction_urls) == 16
