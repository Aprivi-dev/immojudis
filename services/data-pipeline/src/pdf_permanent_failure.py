"""Pièce documentaire qui ne pourra jamais être lue (lot 2b, n° 35).

Rejouer le job d'une pièce trop longue, trop lourde, chiffrée ou corrompue ne fait que répéter le même échec jusqu'à
la lettre morte (``pipeline.enrichment.exhausted``). L'échec est donc rangé dans ``permanent_document_failures`` : le
job réussit et la pièce est révoquée.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf as fitz


class PermanentDocumentFailure(ValueError):
    """A document URL is known not to be usable by the PDF extractor.

    Raised by the download (HTTP 404, access denied, not a document) and by the extraction when the piece itself
    can never be read: ``too_many_pages``, ``document_too_large``, ``encrypted_document`` or ``corrupt_document``.
    """

    def __init__(self, reason: str, message: str | None = None) -> None:
        super().__init__(message or reason)
        self.reason = reason


def open_pdf_or_fail(file: str | Path) -> fitz.Document:
    """Ouvre le PDF ; un fichier corrompu ou vide est un échec permanent (sans le chemin dans le message)."""
    try:
        return fitz.open(file)
    except (fitz.FileDataError, fitz.EmptyFileError) as exc:
        raise PermanentDocumentFailure("corrupt_document", "PDF cannot be opened (corrupt or empty file)") from exc


def ensure_pdf_is_readable(document: fitz.Document, *, hard_limit: int) -> None:
    """Refuse un PDF protégé par mot de passe ou de plus de ``hard_limit`` pages."""
    if document.needs_pass and not document.authenticate(""):
        raise PermanentDocumentFailure("encrypted_document", "PDF is protected by a password")
    if document.page_count > hard_limit:
        raise PermanentDocumentFailure("too_many_pages", f"PDF exceeds the {hard_limit}-page safety limit")
