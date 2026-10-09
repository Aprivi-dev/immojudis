from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta

import fitz

from src.normalize import clean_text

LOGGER = logging.getLogger(__name__)

_PDF_DOCUMENT_OCR_DEADLINE: ContextVar[float | None] = ContextVar(
    "pdf_document_ocr_deadline",
    default=None,
)


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


class PdfDocumentOcrBudgetExceeded(PdfExtractionDeferred):
    """One OCR-heavy document yielded after its bounded pass budget."""


@contextmanager
def pdf_document_ocr_budget_scope(budget_seconds: float | None):
    """Bound OCR for one document without extending the worker cutoff."""

    if budget_seconds is None or float(budget_seconds) <= 0:
        yield
        return
    deadline = time.monotonic() + float(budget_seconds)
    current_deadline = _PDF_DOCUMENT_OCR_DEADLINE.get()
    effective_deadline = min(current_deadline, deadline) if current_deadline is not None else deadline
    token = _PDF_DOCUMENT_OCR_DEADLINE.set(effective_deadline)
    try:
        yield
    finally:
        _PDF_DOCUMENT_OCR_DEADLINE.reset(token)


def pdf_document_ocr_budget_remaining() -> float | None:
    deadline = _PDF_DOCUMENT_OCR_DEADLINE.get()
    return None if deadline is None else deadline - time.monotonic()


def pdf_ocr_document_budget_seconds(settings: dict[str, object]) -> float:
    """Return the bounded OCR pass budget; zero disables this guard."""

    if not bool(settings.get("pdf_ocr_enabled")):
        return 0.0
    try:
        return max(0.0, float(settings.get("pdf_ocr_document_budget_seconds", 120.0) or 0.0))
    except (TypeError, ValueError):
        return 120.0


def ensure_pdf_document_ocr_budget(
    *,
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> float | None:
    remaining = pdf_document_ocr_budget_remaining()
    if remaining is not None and remaining <= 0:
        raise PdfDocumentOcrBudgetExceeded(
            f"PDF OCR document budget reached during {operation}; retry resumes from checkpoint",
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
    return remaining


def extract_page_text_with_ocr_result(
    page: fitz.Page,
    fallback: str,
    *,
    settings: dict[str, object],
    ensure_deadline: Callable[..., object],
    deadline_bounded_timeout: Callable[..., tuple[float, bool]],
    page_text_confidence: Callable[..., float],
    deadline_exception: type[BaseException],
    deadline_exceptions: tuple[type[BaseException], ...] = (),
    deadline_exception_factory: Callable[..., BaseException] | None = None,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> dict[str, object]:
    """Run bounded OCR while keeping the enrichment module's deadline contract."""

    tessdata = settings.get("pdf_ocr_tessdata")
    deadline_error_types = (deadline_exception, *deadline_exceptions)
    remaining = ensure_deadline(
        operation="starting OCR",
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )
    if remaining is not None:
        return _extract_page_text_with_tesseract_result(
            page,
            fallback=fallback,
            settings=settings,
            tessdata=tessdata,
            timeout=60.0,
            ensure_deadline=ensure_deadline,
            deadline_bounded_timeout=deadline_bounded_timeout,
            page_text_confidence=page_text_confidence,
            deadline_exception=deadline_exception,
            deadline_exceptions=deadline_exceptions,
            deadline_exception_factory=deadline_exception_factory,
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
    try:
        text_page = page.get_textpage_ocr(
            language=str(settings["pdf_ocr_language"]),
            # Preserve the public page's native text layer on mixed pages.
            full=True,
            tessdata=str(tessdata) if tessdata else None,
        )
        text = page.get_text("text", textpage=text_page)
        if clean_text(text):
            return {
                "text": text,
                "method": "ocr_pymupdf",
                "confidence": page_text_confidence(text, method="ocr_pymupdf"),
                "status": "extracted",
                "retryable": False,
            }
    except deadline_error_types:
        raise
    except Exception as exc:
        LOGGER.debug("PDF OCR unavailable or failed: %s", exc)
    return _extract_page_text_with_tesseract_result(
        page,
        fallback=fallback,
        settings=settings,
        tessdata=tessdata,
        timeout=60.0,
        ensure_deadline=ensure_deadline,
        deadline_bounded_timeout=deadline_bounded_timeout,
        page_text_confidence=page_text_confidence,
        deadline_exception=deadline_exception,
        deadline_exceptions=deadline_exceptions,
        deadline_exception_factory=deadline_exception_factory,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )


def _extract_page_text_with_tesseract_result(
    page: fitz.Page,
    *,
    fallback: str,
    settings: dict[str, object],
    tessdata: object,
    timeout: float,
    ensure_deadline: Callable[..., object],
    deadline_bounded_timeout: Callable[..., tuple[float, bool]],
    page_text_confidence: Callable[..., float],
    deadline_exception: type[BaseException],
    deadline_exceptions: tuple[type[BaseException], ...] = (),
    deadline_exception_factory: Callable[..., BaseException] | None,
    checkpointed_pages: int,
    total_pages: int,
    new_progress_pages: int,
) -> dict[str, object]:
    deadline_bounded = False
    deadline_error_types = (deadline_exception, *deadline_exceptions)
    try:
        ensure_deadline(
            operation="rendering OCR page",
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "page.png")
            pixmap = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
            ensure_deadline(
                operation="preparing OCR image",
                checkpointed_pages=checkpointed_pages,
                total_pages=total_pages,
                new_progress_pages=new_progress_pages,
            )
            pixmap.save(image_path)
            timeout, deadline_bounded = deadline_bounded_timeout(
                timeout,
                operation="starting OCR subprocess",
                checkpointed_pages=checkpointed_pages,
                total_pages=total_pages,
                new_progress_pages=new_progress_pages,
            )
            env = os.environ.copy()
            if tessdata:
                env["TESSDATA_PREFIX"] = str(tessdata)
            result = subprocess.run(
                ["tesseract", image_path, "stdout", "-l", str(settings["pdf_ocr_language"])],
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                check=False,
            )
            ensure_deadline(
                operation="finishing OCR subprocess",
                checkpointed_pages=checkpointed_pages,
                total_pages=total_pages,
                new_progress_pages=new_progress_pages,
            )
            if result.returncode == 0 and clean_text(result.stdout):
                return {
                    "text": result.stdout,
                    "method": "ocr_tesseract",
                    "confidence": page_text_confidence(result.stdout, method="ocr_tesseract"),
                    "status": "extracted",
                    "retryable": False,
                }
            LOGGER.debug("Tesseract OCR returned %s: %s", result.returncode, result.stderr)
    except subprocess.TimeoutExpired as exc:
        if deadline_bounded:
            error_factory = deadline_exception_factory or deadline_exception
            raise error_factory(
                "PDF bounded deadline reached during OCR; retry resumes from checkpoint",
                checkpointed_pages=checkpointed_pages,
                total_pages=total_pages,
                new_progress_pages=new_progress_pages,
            ) from exc
        ensure_deadline(
            operation="checking deadline after OCR timeout",
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
        LOGGER.debug("Tesseract OCR timed out after %.1fs", timeout)
    except deadline_error_types:
        raise
    except Exception as exc:
        LOGGER.debug("Tesseract OCR fallback failed: %s", exc)
    return {
        "text": fallback,
        "method": "fallback_text",
        "confidence": page_text_confidence(fallback, method="fallback_text"),
        "status": "failed",
        "retryable": True,
        "failure_reason": "ocr_failed",
    }
