"""Échéance d'une passe du worker PDF : l'instant (horloge monotone) où la passe doit rendre la main.

Le lanceur la pose pour un lot (``pdf_deadline_scope`` : ``src.queued_runner``, ``src.document_prefetch``) ; le
téléchargement et la lecture des pièces (``src.pdf_enrichment``) comme l'OCR (``src.pdf_ocr``) la vérifient entre
deux étapes. Atteinte, elle lève ``PdfDeadlineExceeded`` : la pièce reprend au passage suivant depuis ses pages déjà
enregistrées, sans consommer d'essai.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta

_PDF_DEADLINE: ContextVar[float | None] = ContextVar("pdf_enrichment_deadline", default=None)


class PdfExtractionDeferred(ValueError):
    """A bounded OCR pass stopped after checkpointing and should continue later."""

    def __init__(
        self,
        message: str,
        *,
        checkpointed_pages: int,
        total_pages: int,
        new_progress_pages: int,
    ) -> None:
        super().__init__(message)
        self.checkpointed_pages = checkpointed_pages
        self.total_pages = total_pages
        self.new_progress_pages = new_progress_pages
        self.progress_made = new_progress_pages > 0
        self.next_attempt_at = datetime.now(UTC) + timedelta(minutes=30)


class PdfDeadlineExceeded(PdfExtractionDeferred):
    """The worker cutoff was reached; release the claim without spending retry."""


@contextmanager
def pdf_deadline_scope(deadline: float | None):
    """Set a task-local monotonic cutoff for one queue batch."""

    token = _PDF_DEADLINE.set(float(deadline) if deadline is not None else None)
    try:
        yield
    finally:
        _PDF_DEADLINE.reset(token)


def pdf_deadline_remaining() -> float | None:
    deadline = _PDF_DEADLINE.get()
    if deadline is None:
        return None
    return deadline - time.monotonic()


def ensure_pdf_deadline(
    *,
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> float | None:
    """Seconds left before the worker cutoff (``None`` without one); raises once it is reached."""
    remaining = pdf_deadline_remaining()
    if remaining is not None and remaining <= 0:
        raise PdfDeadlineExceeded(
            f"PDF worker deadline reached during {operation}; retry resumes from checkpoint",
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
    return remaining
