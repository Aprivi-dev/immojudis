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
DOCUMENT_LOGGER = logging.getLogger("src.pdf_enrichment")

_PDF_DOCUMENT_LOG_TYPES = frozenset(
    {
        "pdf",
        "doc",
        "docx",
        "pv_huissier",
        "pv_notaire",
        "proces_verbal",
        "diagnostics_techniques",
        "cahier_conditions_vente",
        "conditions_vente",
        "annonce_vente",
        "bail",
        "procedure_saisie",
        "cadastre",
        "other",
        "unknown",
    }
)

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
    effective_deadline = (
        min(current_deadline, deadline)
        if current_deadline is not None
        else deadline
    )
    token = _PDF_DOCUMENT_OCR_DEADLINE.set(effective_deadline)
    try:
        yield
    finally:
        _PDF_DOCUMENT_OCR_DEADLINE.reset(token)


def pdf_document_ocr_budget_remaining() -> float | None:
    deadline = _PDF_DOCUMENT_OCR_DEADLINE.get()
    if deadline is None:
        return None
    return deadline - time.monotonic()


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


def log_pdf_document_transition(
    document: dict[str, object],
    *,
    status: str,
    started_at: float,
    pages: int | None = None,
    error_type: str | None = None,
) -> None:
    """Emit bounded document timing without URLs, text, or provider payloads."""

    raw_document_type = str(document.get("document_type") or document.get("type") or "").strip().casefold()
    document_type = raw_document_type if raw_document_type in _PDF_DOCUMENT_LOG_TYPES else "unknown"
    DOCUMENT_LOGGER.info(
        "PDF document transition: document_type=%s status=%s elapsed_seconds=%.1f "
        "pages=%s error_type=%s",
        document_type,
        status,
        max(time.monotonic() - started_at, 0.0),
        pages if pages is not None else "unknown",
        error_type or "none",
    )


def select_pdf_deadline_exception(
    message: str,
    *,
    worker_remaining: float | None,
    **kwargs: int,
) -> BaseException:
    """Choose the worker or document cutoff after an interruptible OCR timeout."""

    if worker_remaining is None or worker_remaining > 0:
        document_remaining = pdf_document_ocr_budget_remaining()
        if document_remaining is not None and document_remaining <= 0:
            return PdfDocumentOcrBudgetExceeded(
                message.replace("bounded deadline", "OCR document budget"),
                **kwargs,
            )
    return PdfDeadlineExceeded(message, **kwargs)


def ensure_pdf_ocr_deadline(
    *,
    worker_deadline: Callable[..., float | None],
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> float | None:
    """Apply the worker and per-document OCR cutoffs to one OCR step."""

    worker_remaining = worker_deadline(
        operation=operation,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )
    document_remaining = ensure_pdf_document_ocr_budget(
        operation=operation,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )
    remaining_values = [value for value in (worker_remaining, document_remaining) if value is not None]
    return min(remaining_values) if remaining_values else None


def deadline_bounded_timeout(
    timeout_seconds: float,
    *,
    ensure_deadline: Callable[..., float | None],
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> tuple[float, bool]:
    """Recompute a subprocess or HTTP timeout after preparation work."""

    requested_timeout = max(0.001, float(timeout_seconds))
    remaining = ensure_deadline(
        operation=operation,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )
    if remaining is None:
        return requested_timeout, False
    return max(0.001, min(requested_timeout, remaining)), remaining <= requested_timeout


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
        # PyMuPDF's native OCR call has no timeout. During a bounded queue pass
        # use the interruptible tesseract subprocess instead.
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
            # Preserve the native text layer on mixed pages and OCR only the
            # image regions. ``full=True`` recreates the entire page and can
            # discard or duplicate authoritative digital text.
            full=False,
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
                # The interruptible fallback OCRs a raster of the whole page.
                # Keep the native layer as well so a mixed page does not lose
                # its digital header/footer or structured labels.
                text = "\n".join(
                    part for part in (clean_text(fallback), clean_text(result.stdout)) if part
                )
                return {
                    "text": text,
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
    except (deadline_exception, *deadline_exceptions):
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
