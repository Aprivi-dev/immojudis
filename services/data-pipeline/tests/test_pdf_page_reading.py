"""Reading every PDF page that can be read (audit of 03/11/2026).

Production showed 89 incomplete documents logged ``reasons=unknown``:

* pages of photographs or plans that Tesseract cannot read stayed retryable
  forever under a reason the diagnostics did not know;
* pages a bounded pass had not reached were listed as failed without a reason;
* documents whose every page was read stayed ``incomplete`` because the OCR
  budget yielded after the last page;
* Tesseract timed out under CPU contention (one OpenMP thread per core in each
  of two concurrent workers), leaving transient ``ocr_failed`` pages.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

import src.pdf_enrichment as pdf_enrichment
from src.pdf_failure_diagnostics import format_pdf_failure_diagnostics, summarize_pdf_failure
from src.pdf_progress import (
    PDF_TEXT_CACHE_VERSION,
    is_modern_payload,
    partial_pdf_payload_from_page_cache,
)
from src.storage.pdf_checkpoint_rules import _checkpoint_page_coverage_matches, _checkpoint_pages_match_payload


def _photo_pdf(path: Path, *, text_pages: int = 1, photo_pages: int = 1) -> Path:
    photo = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 400, 300), False)
    photo.set_rect(photo.irect, (90, 140, 200))
    with pymupdf.open() as document:
        for index in range(text_pages):
            page = document.new_page()
            page.insert_text(
                (72, 72),
                f"Proces-verbal descriptif, page {index + 1}. Le bien comprend un sejour, une cuisine "
                "et deux chambres.",
            )
        for _ in range(photo_pages):
            page = document.new_page()
            page.insert_image(pymupdf.Rect(36, 36, 559, 806), pixmap=photo)
        document.save(path)
    return path


@pytest.fixture
def ocr_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", tmp_path / "cache")
    monkeypatch.setenv("PDF_EXTRACTOR", "pymupdf")
    monkeypatch.setenv("PDF_OCR_ENABLED", "true")
    return tmp_path / "cache"


def _extract(path: Path) -> dict[str, object]:
    with pdf_enrichment.pdf_deadline_scope(time.monotonic() + 120):
        return pdf_enrichment.extract_pdf_document(path, document={"label": "PV", "url": "https://example.test/pv.pdf"})


# --- Diagnostics: every failure the extractor records has a name ---------------------------------------------


def test_a_page_without_text_after_two_passes_is_logged_with_its_reason_not_unknown() -> None:
    """``ocr_no_text_unverified`` was emitted by the OCR but missing from the known reasons."""
    diagnostics = summarize_pdf_failure(
        {
            "extraction_status": "incomplete",
            "complete": False,
            "failed_pages": [4],
            "pages": [{"page": 4, "status": "failed", "retryable": True, "failure_reason": "ocr_no_text_unverified"}],
        }
    )

    assert diagnostics["failure_reasons"] == ["ocr_no_text_unverified"]
    assert "unknown" not in format_pdf_failure_diagnostics(diagnostics)


def test_a_picture_page_is_not_a_failure() -> None:
    diagnostics = summarize_pdf_failure(
        {
            "extraction_status": "extracted",
            "complete": True,
            "failed_pages": [],
            "pages": [
                {"page": 1, "status": "extracted", "text": "Texte"},
                {"page": 2, "status": "picture_page_excluded", "failure_reason": "picture_without_text_after_ocr"},
            ],
        }
    )

    assert diagnostics["status"] == "extracted"
    assert diagnostics["failed_pages"] == [] and diagnostics["failure_reasons"] == []


def test_pages_a_bounded_pass_did_not_reach_are_named_pending_not_unknown() -> None:
    """Production: a 112-page diagnostic read up to page 79 by one pass was logged
    ``failed_pages=80..112 reasons=unknown``."""
    diagnostics = summarize_pdf_failure(
        {
            "extraction_status": "incomplete",
            "complete": False,
            "failed_pages": [3, 4],
            "pages": [{"page": 1, "status": "extracted"}, {"page": 2, "status": "extracted"}],
        }
    )

    assert diagnostics["failure_reasons"] == ["pages_pending_next_pass"]


# --- Checkpoints: a fully read document is complete ----------------------------------------------------------


def _checkpoint(cache_root: Path, pdf: Path, pages: list[dict[str, object]]) -> None:
    key = hashlib.sha256(pdf.read_bytes() + str((True, "fra", PDF_TEXT_CACHE_VERSION)).encode()).hexdigest()
    directory = cache_root / "pages" / key
    directory.mkdir(parents=True)
    for page in pages:
        (directory / f"{page['page']}.json").write_text(json.dumps(page), encoding="utf-8")


def _page(number: int, status: str = "extracted", text: str | None = None) -> dict[str, object]:
    text = f"Texte de la page {number}" if text is None else text
    return {"page": number, "text": text, "chars": len(text), "status": status, "retryable": False, "confidence": 0.9}


def test_a_checkpoint_covering_every_page_is_a_complete_extraction(tmp_path) -> None:
    """Production 03/11/2026: 36 live documents ``incomplete`` with no failed page at all."""
    pdf = _photo_pdf(tmp_path / "pv.pdf")
    _checkpoint(tmp_path, pdf, [_page(1), _page(2, "picture_page_excluded", "")])

    payload = partial_pdf_payload_from_page_cache(
        pdf,
        {"url": "https://example.test/pv.pdf", "label": "PV"},
        cache_root=tmp_path,
        total_pages=2,
        ocr_enabled=True,
        ocr_language="fra",
    )

    assert payload is not None
    assert payload["complete"] is True and payload["extraction_status"] == "extracted"
    assert payload["failed_pages"] == [] and payload["picture_pages"] == [2]
    assert "failure_reason" not in payload
    assert is_modern_payload(payload, require_complete=True)
    assert _checkpoint_page_coverage_matches(payload, require_chars=True)
    assert _checkpoint_pages_match_payload(payload, require_chars=True)


def test_a_checkpoint_with_unread_pages_stays_incomplete_and_names_them_pending(tmp_path) -> None:
    pdf = _photo_pdf(tmp_path / "pv.pdf", text_pages=2)
    _checkpoint(tmp_path, pdf, [_page(1)])

    payload = partial_pdf_payload_from_page_cache(
        pdf,
        {"url": "https://example.test/pv.pdf"},
        cache_root=tmp_path,
        total_pages=3,
        ocr_enabled=True,
        ocr_language="fra",
    )

    assert payload is not None
    assert payload["complete"] is False and payload["extraction_status"] == "incomplete"
    assert payload["failed_pages"] == [2, 3]
    assert _checkpoint_page_coverage_matches(payload, require_chars=True)
    assert summarize_pdf_failure(payload)["failure_reasons"] == ["pages_pending_next_pass"]


# --- Page passes: settled pages are kept, transient failures are retried ------------------------------------


def test_a_picture_page_is_read_once_and_reused_from_the_page_cache(ocr_settings, tmp_path, monkeypatch) -> None:
    path = _photo_pdf(tmp_path / "pv.pdf")
    monkeypatch.setattr(
        "src.pdf_enrichment.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""),
    )
    first = _extract(path)
    assert first["complete"] is True and first["picture_pages"] == [2]

    monkeypatch.setattr(
        "src.pdf_enrichment.subprocess.run",
        lambda *args, **kwargs: pytest.fail("a settled picture page must not be OCR'd again"),
    )
    second = _extract(path)

    assert second["complete"] is True and second["pages"][1]["status"] == "picture_page_excluded"


def test_a_page_that_failed_for_a_transient_reason_is_retried_on_the_next_pass(ocr_settings, tmp_path, monkeypatch) -> None:
    path = _photo_pdf(tmp_path / "pv.pdf")

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 60)

    monkeypatch.setattr("src.pdf_enrichment.subprocess.run", timeout)
    first = _extract(path)
    assert first["complete"] is False and first["failed_pages"] == [2]
    assert first["pages"][1]["failure_reason"] == "ocr_failed"
    assert summarize_pdf_failure(first)["failure_reasons"] == ["ocr_failed"]

    monkeypatch.setattr(
        "src.pdf_enrichment.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="Cuisine equipee et sejour", stderr=""),
    )
    second = _extract(path)

    assert second["complete"] is True and second["failed_pages"] == []
    assert "Cuisine equipee" in str(second["text"])


# --- Real Tesseract (when installed, as on the GitHub runner) ------------------------------------------------


def _tesseract_has(language: str) -> bool:
    if not shutil.which("tesseract"):
        return False
    try:
        listed = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return language in listed.stdout.split()


@pytest.mark.skipif(not _tesseract_has("fra"), reason="tesseract with the fra language is not installed")
def test_real_ocr_reads_a_scanned_text_page_and_settles_a_photograph(ocr_settings, tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PDF_OCR_LANGUAGE", "fra")
    with pymupdf.open() as source:
        page = source.new_page()
        page.insert_text(
            (72, 120),
            "PROCES-VERBAL DE DESCRIPTION\nLe bien comprend une cuisine, un sejour et deux chambres.",
            fontsize=14,
        )
        scan = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    photo = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 600, 450), False)
    for row in range(0, 450, 15):
        photo.set_rect(pymupdf.IRect(0, row, 600, row + 15), (40 + row // 3, 120, 220 - row // 3))
    photo.set_rect(pymupdf.IRect(150, 120, 420, 330), (200, 180, 60))
    path = tmp_path / "scan.pdf"
    with pymupdf.open() as document:
        document.new_page().insert_image(pymupdf.Rect(0, 0, 595, 842), pixmap=scan)
        document.new_page().insert_image(pymupdf.Rect(36, 36, 559, 456), pixmap=photo)
        document.save(path)

    payload = _extract(path)

    assert payload["complete"] is True, payload["failed_pages"]
    assert "cuisine" in str(payload["text"]).lower()
    assert payload["pages"][1]["status"] == "picture_page_excluded"
