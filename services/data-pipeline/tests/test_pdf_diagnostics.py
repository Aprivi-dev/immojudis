"""Le diagnostic Docling lit les PDF avec le profil et la décision OCR de l'enrichissement, sans copie."""

from __future__ import annotations

import pymupdf

from src import pdf_diagnostics, pdf_enrichment


def _write_pdf(path, text: str) -> None:
    path.parent.mkdir(parents=True)
    with pymupdf.open() as document:
        page = document.new_page()
        if text:
            page.insert_text((72, 72), text)
        document.save(path)


def test_diagnostics_follow_the_enrichment_docling_rule(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PDF_DOCLING_OCR_MODE", "never")  # the diagnostic always describes the automatic mode
    monkeypatch.setenv("PDF_DOCLING_THRESHOLD_CHARS", "20")
    _write_pdf(tmp_path / "sale-a" / "scan.pdf", "")
    _write_pdf(tmp_path / "sale-b" / "texte.pdf", "Cahier des conditions de vente, lot unique.")

    rows = {row["sale_id"]: row for row in pdf_diagnostics.build_pdf_diagnostics(tmp_path)}

    assert rows["sale-a"]["docling_ocr_auto"] is True
    assert rows["sale-a"]["diagnostic_reason"] == "scanned_small_pdf_requires_docling_ocr"
    assert rows["sale-b"]["docling_ocr_auto"] is False
    assert rows["sale-b"]["first_pages_text_chars"] == pdf_enrichment._profile_pdf_for_docling(
        tmp_path / "sale-b" / "texte.pdf"
    )["first_pages_text_chars"]
