from __future__ import annotations

import logging
from pathlib import Path

import src.pdf_enrichment as pdf_enrichment
from src.normalize import normalize_sale
from src.pdf_document_selection import _store_document_analysis_status
from src.pdf_failure_diagnostics import (
    format_pdf_failure_diagnostics,
    pdf_extraction_exception_marker,
    summarize_pdf_failure,
)


def test_summary_keeps_page_causes_and_drops_pdf_content() -> None:
    payload = {
        "url": "https://example.test/private.pdf?token=secret",
        "text": "private PDF text must never enter diagnostics",
        "extraction_status": "incomplete",
        "complete": False,
        "page_count": 4,
        "failed_pages": [4, 2],
        "pages": [
            {"page": 2, "status": "failed", "retryable": True, "failure_reason": "ocr_failed"},
            {
                "page": 4,
                "status": "failed",
                "retryable": True,
                "failure_reason": "empty_page_not_proven_blank",
            },
        ],
    }

    diagnostics = summarize_pdf_failure(payload)

    assert diagnostics == {
        "status": "incomplete",
        "failed_pages": [2, 4],
        "failure_reasons": ["empty_page_not_proven_blank", "ocr_failed"],
        "page_count": 4,
    }
    formatted = format_pdf_failure_diagnostics(diagnostics)
    assert formatted == (
        "status=incomplete failed_pages=2,4 "
        "reasons=empty_page_not_proven_blank,ocr_failed"
    )
    assert "private" not in repr(diagnostics)
    assert "secret" not in formatted


def test_visual_blank_page_is_not_reported_as_failed() -> None:
    diagnostics = summarize_pdf_failure(
        {
            "extraction_status": "extracted",
            "complete": True,
            "failed_pages": [],
            "pages": [
                {
                    "page": 3,
                    "status": "visual_blank_excluded",
                    "failure_reason": "visual_blank_after_ocr",
                    "original_failure_reason": "ocr_failed",
                    "retryable": False,
                }
            ],
        }
    )

    assert diagnostics["status"] == "extracted"
    assert diagnostics["failed_pages"] == []
    assert diagnostics["failure_reasons"] == []


def test_explicit_failed_page_blocks_blank_exclusion_and_uses_status_fallback() -> None:
    fallback_diagnostics = summarize_pdf_failure(
        {
            "extraction_status": "extracted",
            "complete": True,
            "failed_pages": [],
            "pages": [
                {"page": 3, "extraction_status": "failed", "retryable": False},
            ],
        }
    )

    assert fallback_diagnostics["status"] == "incomplete"
    assert fallback_diagnostics["failed_pages"] == [3]
    assert fallback_diagnostics["failure_reasons"] == ["unknown"]

    contradictory_diagnostics = summarize_pdf_failure(
        {
            "extraction_status": "extracted",
            "complete": True,
            "failed_pages": [3],
            "pages": [
                {"page": 3, "status": "blank_page_excluded", "retryable": False},
                {"page": 4, "status": "blank_page_excluded", "retryable": False},
            ],
        }
    )

    assert contradictory_diagnostics["status"] == "incomplete"
    assert contradictory_diagnostics["failed_pages"] == [3]
    assert contradictory_diagnostics["failure_reasons"] == ["unknown"]


def test_missing_reason_is_unknown_only_when_payload_has_failure() -> None:
    diagnostics = summarize_pdf_failure(
        {
            "extraction_status": "incomplete",
            "complete": False,
            "failed_pages": [7],
            "pages": [{"page": 7, "status": "failed", "retryable": True}],
        }
    )

    assert diagnostics["failed_pages"] == [7]
    assert diagnostics["failure_reasons"] == ["unknown"]


def test_document_analysis_persists_safe_failure_details_and_logs_them(caplog) -> None:
    url = "https://example.test/pv.pdf?token=secret"
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/sale",
            "documents": [{"label": "PV", "url": url, "document_type": "pv_huissier"}],
        }
    )
    payload = {
        "label": "PV",
        "url": url,
        "document_type": "pv_huissier",
        "text": "private PDF text",
        "text_chars": 16,
        "page_count": 2,
        "complete": False,
        "extraction_status": "incomplete",
        "failed_pages": [2],
        "pages": [{"page": 2, "status": "failed", "retryable": True, "failure_reason": "ocr_failed"}],
    }

    with caplog.at_level(logging.WARNING):
        _store_document_analysis_status(
            sale,
            [{"label": "PV", "url": url, "document_type": "pv_huissier"}],
            [payload],
        )

    analysis = sale.raw_payload["document_analysis"]
    assert analysis["failed_document_diagnostics"] == [
        {
            "url": url,
            "status": "incomplete",
            "failed_pages": [2],
            "failure_reasons": ["ocr_failed"],
            "page_count": 2,
        }
    ]
    assert analysis["profiles"][0]["failure_reasons"] == ["ocr_failed"]
    assert "failed_pages=2" in caplog.text
    assert "reasons=ocr_failed" in caplog.text
    assert "private PDF text" not in caplog.text
    assert "token=secret" not in caplog.text


def test_extractor_exception_marker_keeps_only_safe_class_name() -> None:
    marker = pdf_extraction_exception_marker(
        "https://example.test/pv.pdf?token=secret",
        "TimeoutError",
    )

    diagnostics = summarize_pdf_failure(marker)

    assert diagnostics["status"] == "failed"
    assert diagnostics["failed_pages"] == []
    assert diagnostics["failure_reasons"] == ["extractor_exception"]
    assert diagnostics["exception_type"] == "TimeoutError"
    assert "secret" not in repr(diagnostics)
    assert format_pdf_failure_diagnostics(marker) == (
        "status=failed failed_pages=none reasons=extractor_exception exception_type=TimeoutError"
    )


def test_enrichment_exception_logs_safe_marker_and_forwards_it(monkeypatch, tmp_path: Path, caplog) -> None:
    url = "https://example.test/pv.pdf?token=secret"
    document = {
        "label": "PV",
        "url": url,
        "type": "pdf",
        "document_type": "pv_huissier",
        "file_path": str(tmp_path / "pv.pdf"),
    }
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/sale",
            "documents": [{"label": "PV", "url": url, "document_type": "pv_huissier"}],
        }
    )
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        pdf_enrichment,
        "load_settings",
        lambda: {
            "incremental_enrichment": False,
            "pdf_ocr_enabled": False,
            "pdf_ocr_language": "fra",
        },
    )
    monkeypatch.setattr(pdf_enrichment, "download_documents", lambda _sale, stats: [document])
    monkeypatch.setattr(
        pdf_enrichment,
        "_select_documents_for_extraction",
        lambda documents, sale=None, **kwargs: documents,
    )
    monkeypatch.setattr(pdf_enrichment, "_invalidate_replaced_document_facts", lambda *_args: None)
    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", lambda *_args, **_kwargs: (_ for _ in ()).throw(
        TimeoutError("private PDF text must not be logged")
    ))
    monkeypatch.setattr(
        pdf_enrichment,
        "_store_document_analysis_status",
        lambda *_args, **kwargs: captured.update(kwargs),
    )

    with caplog.at_level(logging.WARNING):
        stats = pdf_enrichment.enrich_sale_from_pdfs(sale)

    assert stats.errors == 1
    assert captured["failed_document_diagnostics"] == [
        {
            "url": url,
            "extraction_status": "failed",
            "failure_reason": "extractor_exception",
            "exception_type": "TimeoutError",
        }
    ]
    assert "status=failed" in caplog.text
    assert "exception_type=TimeoutError" in caplog.text
    assert "private PDF text" not in caplog.text
    assert "token=secret" not in caplog.text
