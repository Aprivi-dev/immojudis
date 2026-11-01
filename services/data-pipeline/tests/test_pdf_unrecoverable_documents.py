"""Lot 2b, n° 35 : une pièce irrécupérable est un échec permanent avec motif, pas une erreur rejouée jusqu'à la lettre morte."""

from __future__ import annotations

import hashlib
import importlib
from pathlib import Path

import pymupdf
import pytest

from src.normalize import normalize_sale
from src.pdf_enrichment import PermanentDocumentFailure, extract_pdf_document, extract_pdf_pages
from src.pdf_progress import manifest_is_complete

pdf_enrichment = importlib.import_module("src.pdf_enrichment")

URL = "https://source.example/piece.pdf"


@pytest.fixture(autouse=True)
def _settings_and_dirs(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PDF_EXTRACTOR", "pymupdf")
    monkeypatch.setenv("PDF_OCR_ENABLED", "false")
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", tmp_path / "cache")
    monkeypatch.setattr(pdf_enrichment, "PDF_TEXTS_DIR", tmp_path / "texts")


def _pdf(path: Path, *, pages: int = 1, **save_options: object) -> Path:
    with pymupdf.open() as document:
        for number in range(1, pages + 1):
            document.new_page().insert_text((72, 72), f"Page {number} : désignation du bien.")
        document.save(path, **save_options)
    return path


def test_a_pdf_with_too_many_pages_is_a_permanent_failure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_TOTAL_PAGES", "5")
    path = _pdf(tmp_path / "long.pdf", pages=8)

    with pytest.raises(PermanentDocumentFailure, match="5-page safety limit") as caught:
        extract_pdf_pages(path)

    assert caught.value.reason == "too_many_pages"
    assert isinstance(caught.value, ValueError)


def test_a_pdf_heavier_than_the_limit_is_a_permanent_failure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOWNLOAD_MB", "1")
    path = tmp_path / "heavy.pdf"
    path.write_bytes(b"%PDF-1.4\n" + b"0" * (1024 * 1024 + 1))

    with pytest.raises(PermanentDocumentFailure, match="extraction limit") as caught:
        extract_pdf_document(path)

    assert caught.value.reason == "document_too_large"


def test_a_password_protected_pdf_is_a_permanent_failure(tmp_path: Path) -> None:
    path = _pdf(
        tmp_path / "chiffre.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="mot-de-passe", owner_pw="proprietaire"
    )

    with pytest.raises(PermanentDocumentFailure) as caught:
        extract_pdf_pages(path)

    assert caught.value.reason == "encrypted_document"


def test_a_pdf_with_only_an_owner_password_is_still_read(tmp_path: Path) -> None:
    path = _pdf(tmp_path / "proprietaire.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="", owner_pw="o")

    pages = extract_pdf_pages(path)

    assert "désignation du bien" in pages[0]["text"]


@pytest.mark.parametrize("content", [b"%PDF-1.4\nce n'est pas un PDF", b""])
def test_a_corrupt_or_empty_pdf_is_a_permanent_failure_without_the_file_path(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "corrompu.pdf"
    path.write_bytes(content)

    with pytest.raises(PermanentDocumentFailure) as caught:
        extract_pdf_pages(path)

    assert caught.value.reason == "corrupt_document"
    assert str(tmp_path) not in str(caught.value)


@pytest.mark.parametrize(
    ("reason", "prepare"),
    [
        ("encrypted_document", lambda path: _pdf(path, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="u", owner_pw="o")),
        ("corrupt_document", lambda path: path.write_bytes(b"%PDF-1.4\nrien d'exploitable")),
        ("too_many_pages", lambda path: _pdf(path, pages=4)),
    ],
)
def test_an_unrecoverable_piece_settles_the_enrichment_instead_of_failing_the_job(
    tmp_path: Path, monkeypatch, reason: str, prepare
) -> None:
    monkeypatch.setenv("PDF_MAX_TOTAL_PAGES", "3")
    path = tmp_path / "pieces" / "piece.pdf"
    path.parent.mkdir()
    prepare(path)
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/vente-irrecuperable",
            "status": "upcoming",
            "documents": [{"label": "Cahier des conditions de vente", "url": URL, "type": "pdf"}],
        }
    )
    document = dict(sale.documents[0])
    document.update(
        {
            "file_path": str(path),
            "file_format": "pdf",
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "http_checked_at": "2026-10-31T00:00:00+00:00",
        }
    )
    monkeypatch.setattr(pdf_enrichment, "download_documents", lambda *args, **kwargs: [document])

    stats = pdf_enrichment.enrich_sale_from_pdfs(sale)

    assert stats.errors == 0
    assert stats.permanent_document_failures == [{"url": URL, "reason": reason}]
    analysis = sale.raw_payload["document_analysis"]
    assert analysis["permanent_document_failures"] == [{"url": URL, "reason": reason}]
    assert analysis["terminal_document_urls"] == [URL]
    assert not analysis.get("failed_documents")
    assert manifest_is_complete(analysis, sale.documents)
