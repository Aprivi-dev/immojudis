from __future__ import annotations

import fitz

from src.normalize import normalize_sale
from src.pdf_enrichment import _store_document_analysis_status, extract_pdf_document
from src.pdf_partial_tolerance import (
    failed_page_share_is_tolerable,
    is_tolerated_partial,
    tolerated_partial_documents,
)
from src.pdf_progress import complete_or_terminal_urls
from src.storage.supabase_client import _document_rows_for_sale

URL = "https://example.test/cahier.pdf"
SHA = "a" * 64


def _payload(**overrides):
    payload = {
        "url": URL,
        "sha256": SHA,
        "extraction_status": "incomplete",
        "complete": False,
        "page_count": 77,
        "failed_pages": [52],
        "text": "Cahier des conditions de vente. " * 10,
        "text_chars": 320,
    }
    payload.update(overrides)
    return payload


def _previous(**overrides):
    item = {"url": URL, "sha256": SHA, "extraction_status": "incomplete", "failed_pages": [52]}
    item.update(overrides)
    return item


def test_one_failed_page_per_ten_pages_is_the_limit() -> None:
    assert failed_page_share_is_tolerable([52], 77)
    assert failed_page_share_is_tolerable([1], 10)
    assert not failed_page_share_is_tolerable([1], 9)
    assert not failed_page_share_is_tolerable([1, 2], 19)
    assert not failed_page_share_is_tolerable([], 77)


def test_a_document_is_tolerated_only_after_a_retry_of_the_same_file_failed() -> None:
    # Production case of 12/10/2026: 77 pages, page 52 unreadable twice.
    assert is_tolerated_partial(_payload(), _previous())
    # First read: the failed page must be retried once.
    assert not is_tolerated_partial(_payload(), None)
    # Another file behind the same URL is a new document.
    assert not is_tolerated_partial(_payload(), _previous(sha256="b" * 64))
    # The retry recovered nothing new but failed on another page: not proven.
    assert not is_tolerated_partial(_payload(failed_pages=[53]), _previous())
    # Recovering pages is fine as long as the remaining ones failed before.
    assert is_tolerated_partial(_payload(failed_pages=[52]), _previous(failed_pages=[51, 52]))


def test_too_many_missing_pages_short_documents_or_no_text_stay_incomplete() -> None:
    assert not is_tolerated_partial(_payload(page_count=5, failed_pages=[2]), _previous(failed_pages=[2]))
    assert not is_tolerated_partial(
        _payload(failed_pages=list(range(1, 10))), _previous(failed_pages=list(range(1, 10)))
    )
    assert not is_tolerated_partial(_payload(text="", text_chars=0), _previous())
    assert not is_tolerated_partial(_payload(complete=True, extraction_status="extracted"), _previous())
    assert not is_tolerated_partial(_payload(failed_pages=[]), _previous())


def test_a_tolerated_document_stays_tolerated_while_the_file_is_unchanged() -> None:
    previous_analysis = {
        "cache_proof": {"documents": []},
        "tolerated_partial_documents": [{"url": URL, "sha256": SHA, "page_count": 77, "failed_pages": [52]}],
    }
    assert [item["url"] for item in tolerated_partial_documents([_payload()], previous_analysis)] == [URL]
    changed = _payload(sha256="c" * 64)
    assert tolerated_partial_documents([changed], previous_analysis) == []


def _ten_page_pdf_with_one_scan(path) -> None:
    with fitz.open() as document:
        for number in range(10):
            page = document.new_page()
            if number == 6:
                page.draw_rect(fitz.Rect(72, 72, 200, 200), color=(0, 0, 0), fill=(0, 0, 0))
            else:
                page.insert_text((72, 72), f"Page {number + 1}. Surface habitable : 50 m2. " * 3)
        document.save(path)


def test_a_retried_document_with_one_unreadable_page_out_of_ten_is_settled(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PDF_EXTRACTOR", "pymupdf")
    monkeypatch.setenv("PDF_OCR_ENABLED", "true")
    monkeypatch.setattr(
        "src.pdf_enrichment._extract_page_text_with_ocr_result",
        lambda page, **kwargs: {"text": "", "method": "fallback_text", "confidence": 0.0},
    )
    path = tmp_path / "cahier.pdf"
    _ten_page_pdf_with_one_scan(path)
    document = {"label": "Cahier des conditions de vente", "url": URL, "document_type": "cahier_conditions_vente"}
    sale = normalize_sale(
        {"source_name": "avoventes", "source_url": "https://example.test/vente", "documents": [document]}
    )

    def one_pass():
        payload = extract_pdf_document(path, document=document)
        payload.update({"label": document["label"], "url": URL, "document_type": document["document_type"]})
        _store_document_analysis_status(sale, [document], [payload])
        return payload, sale.raw_payload["document_analysis"]

    payload, analysis = one_pass()
    assert payload["failed_pages"] == [7] and payload["page_count"] == 10
    # First read: still a failure to retry.
    assert analysis["failed_documents"] == 1
    assert analysis["tolerated_partial_documents"] == []
    assert URL not in analysis["terminal_document_urls"]

    payload, analysis = one_pass()
    # The retry failed on the same page: settled, never promoted.
    assert analysis["failed_documents"] == 0
    assert analysis["failed_document_urls"] == []
    assert analysis["documents_extracted"] == 0
    assert analysis["tolerated_partial_documents"] == [
        {"url": URL, "sha256": payload["sha256"], "page_count": 10, "failed_pages": [7]}
    ]
    assert URL in analysis["terminal_document_urls"]
    assert URL in complete_or_terminal_urls(analysis, sale.documents)
    assert analysis["coverage_status"] == "partial"
    assert "Quelques pages de certaines pièces sont restées illisibles" in analysis["warning"]
    assert analysis["profiles"][0]["extraction_status"] == "incomplete"

    rows = _document_rows_for_sale(sale, pdf_texts=[payload])
    assert [row["extraction_status"] for row in rows] == ["partial"]
    assert rows[0]["raw_payload"]["extraction"]["failed_pages"] == [7]
