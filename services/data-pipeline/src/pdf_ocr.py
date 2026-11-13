from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time
from contextlib import contextmanager
from contextvars import ContextVar

import pymupdf as fitz

from src.normalize import clean_text
from src.pdf_deadline import PdfDeadlineExceeded, PdfExtractionDeferred, ensure_pdf_deadline, pdf_deadline_remaining
from src.pdf_page_analysis import VISUAL_BLANK_INK_RATIO_MAX, VISUAL_BLANK_INK_THRESHOLD, page_text_confidence

OCR_NO_TEXT_METHOD = "ocr_tesseract_no_text"
# Tesseract n'a rien lu sur une page qui porte de l'encre : « vide » n'est pas prouvé (page scannée de travers,
# trop pâle, tampon, plan…). La page reste à reprendre ; le motif et l'indicateur sont dans l'enregistrement.
OCR_NO_TEXT_UNVERIFIED_METHOD = "ocr_no_text_unverified"
OCR_ROTATED_METHOD = "ocr_tesseract_rotated"
OCR_ROTATION_DEGREES = 90
OCR_INK_SAMPLE_MAX_PIXELS = 200_000
# Troisième lecture d'une page encrée que les deux premières n'ont pas lue : Tesseract en mode « texte épars »
# (--psm 11) cherche le texte partout sur l'image et donne une confiance par mot. Sur une page de texte, il rend
# des dizaines de mots sûrs ; sur une page de photos ou un plan, seulement du bruit de faible confiance (mesuré le
# 03/11/2026 sur des PV avoventes et licitor : 0 mot sûr sur chaque page de photos, 29 à 101 sur une page de texte).
OCR_SPARSE_METHOD = "ocr_tesseract_sparse"
# Trois lectures sans un seul mot sûr : la page est une image sans texte (photographies du bien, plan). Elle est
# réglée (plus de nouvelle tentative, qui donnerait le même résultat) et gardée telle quelle dans le PDF source.
OCR_PICTURE_NO_TEXT_METHOD = "ocr_picture_no_text"
OCR_SPARSE_PAGE_SEGMENTATION_MODE = "11"
OCR_SPARSE_WORD_MIN_CONFIDENCE = 70.0
OCR_SPARSE_WORD_MIN_LETTERS = 3
OCR_SPARSE_MIN_CONFIDENT_WORDS = 3
OCR_SPARSE_TEXT_MIN_CONFIDENCE = 60.0
# Tesseract (OpenMP) lance par défaut un fil par cœur. Deux OCR simultanés (deux workers d'enrichissement sur un
# runner de 4 vCPU) se disputent alors les cœurs : mesuré le 03/11/2026, 6 pages × 2 flux prennent 301 s dont 10
# pages coupées à 60 s (« ocr_failed », puis report du document), contre 9,8 s et aucun échec avec un seul fil.
# Un seul fil est aussi plus rapide pour un OCR isolé. Une valeur déjà fixée dans l'environnement est respectée.
OCR_THREAD_LIMIT = "1"
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


class PdfDocumentOcrBudgetExceeded(PdfExtractionDeferred):
    """One OCR-heavy document yielded after its bounded pass budget."""


# The worker cutoff and the per-document budget stop the OCR of a page: never swallowed as an OCR failure.
_DEADLINE_ERRORS = (PdfDeadlineExceeded, PdfDocumentOcrBudgetExceeded)


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


def _deadline_exception(message: str, **kwargs: int) -> BaseException:
    """Choose the worker or document cutoff after an interruptible OCR timeout."""

    worker_remaining = pdf_deadline_remaining()
    if worker_remaining is None or worker_remaining > 0:
        document_remaining = pdf_document_ocr_budget_remaining()
        if document_remaining is not None and document_remaining <= 0:
            return PdfDocumentOcrBudgetExceeded(
                message.replace("bounded deadline", "OCR document budget"),
                **kwargs,
            )
    return PdfDeadlineExceeded(message, **kwargs)


def _ensure_ocr_deadline(
    *,
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> float | None:
    """Apply the worker and per-document OCR cutoffs to one OCR step."""

    worker_remaining = ensure_pdf_deadline(
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
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> tuple[float, bool]:
    """Recompute a subprocess or HTTP timeout after preparation work (worker cutoff and OCR document budget)."""

    requested_timeout = max(0.001, float(timeout_seconds))
    remaining = _ensure_ocr_deadline(
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
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> dict[str, object]:
    """Run OCR bounded by the worker cutoff and the OCR document budget."""
    tessdata = settings.get("pdf_ocr_tessdata")
    remaining = _ensure_ocr_deadline(
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
    except _DEADLINE_ERRORS:
        raise
    except Exception as exc:
        LOGGER.debug("PDF OCR unavailable or failed: %s", exc)
    return _extract_page_text_with_tesseract_result(
        page,
        fallback=fallback,
        settings=settings,
        tessdata=tessdata,
        timeout=60.0,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )


def _pixmap_is_uniformly_light(pixmap: object) -> bool | None:
    """Vrai si l'image rendue est presque uniformément claire ; ``None`` si elle ne peut pas être mesurée.

    Mêmes seuils que ``pdf_page_analysis.visual_page_profile`` (encre sous ``VISUAL_BLANK_INK_THRESHOLD`` sur au
    plus ``VISUAL_BLANK_INK_RATIO_MAX`` des pixels), sur un échantillon de pixels : l'image de l'OCR est grande.
    """
    try:
        samples = pixmap.samples  # type: ignore[attr-defined]
        channels = max(int(pixmap.n), 1)  # type: ignore[attr-defined]
        pixel_count = int(pixmap.width) * int(pixmap.height)  # type: ignore[attr-defined]
    except (AttributeError, TypeError, ValueError):
        return None
    if not samples or pixel_count <= 0:
        return None
    step = max(1, pixel_count // OCR_INK_SAMPLE_MAX_PIXELS)
    inked = measured = 0
    for pixel in range(0, pixel_count, step):
        offset = pixel * channels
        if offset + channels > len(samples):
            break
        measured += 1
        if min(samples[offset : offset + channels]) < VISUAL_BLANK_INK_THRESHOLD:
            inked += 1
    if not measured:
        return None
    return inked / measured <= VISUAL_BLANK_INK_RATIO_MAX


def tesseract_environment(tessdata: object = None) -> dict[str, str]:
    """Environment of one Tesseract subprocess: single-threaded unless the operator chose otherwise."""
    env = os.environ.copy()
    if tessdata:
        env["TESSDATA_PREFIX"] = str(tessdata)
    if not clean_text(env.get("OMP_THREAD_LIMIT")):
        env["OMP_THREAD_LIMIT"] = OCR_THREAD_LIMIT
    return env


def _has_word(text: str | None) -> bool:
    """At least one token of three letters or digits (a sideways table may hold only numbers): the
    rotated pass is speculative, and on a page of photographs it returns two-character noise
    ("fh", "€T") that must not count as a read page."""
    return any(
        sum(character.isalnum() for character in token) >= OCR_SPARSE_WORD_MIN_LETTERS
        for token in (text or "").split()
    )


def sparse_ocr_words(tsv: str | None) -> list[tuple[int, int, int, int, float, str]]:
    """Words of a Tesseract TSV output: (block, paragraph, line, word, confidence, text)."""
    words: list[tuple[int, int, int, int, float, str]] = []
    for line in (tsv or "").splitlines()[1:]:
        columns = line.split("\t")
        if len(columns) != 12 or not columns[11].strip():
            continue
        try:
            block, paragraph, row, word = (int(value) for value in columns[2:6])
            confidence = float(columns[10])
        except ValueError:
            continue
        words.append((block, paragraph, row, word, confidence, columns[11].strip()))
    return words


def sparse_ocr_confident_word_count(words: list[tuple[int, int, int, int, float, str]]) -> int:
    """Words Tesseract is sure of and that look like words (at least three letters)."""
    return sum(
        1
        for *_, confidence, text in words
        if confidence >= OCR_SPARSE_WORD_MIN_CONFIDENCE
        and sum(character.isalpha() for character in text) >= OCR_SPARSE_WORD_MIN_LETTERS
    )


def sparse_ocr_text(words: list[tuple[int, int, int, int, float, str]]) -> str:
    """Text of the sufficiently confident words, one line per Tesseract line."""
    lines: dict[tuple[int, int, int], list[str]] = {}
    for block, paragraph, row, _word, confidence, text in words:
        if confidence >= OCR_SPARSE_TEXT_MIN_CONFIDENCE:
            lines.setdefault((block, paragraph, row), []).append(text)
    return "\n".join(" ".join(parts) for _, parts in sorted(lines.items()))


def _extract_page_text_with_tesseract_result(
    page: fitz.Page,
    *,
    fallback: str,
    settings: dict[str, object],
    tessdata: object,
    timeout: float,
    checkpointed_pages: int,
    total_pages: int,
    new_progress_pages: int,
) -> dict[str, object]:
    deadline_bounded = False
    try:
        _ensure_ocr_deadline(
            operation="rendering OCR page",
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "page.png")
            pixmap = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
            _ensure_ocr_deadline(
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
            env = tesseract_environment(tessdata)
            result = subprocess.run(
                ["tesseract", image_path, "stdout", "-l", str(settings["pdf_ocr_language"])],
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                check=False,
            )
            _ensure_ocr_deadline(
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
            if result.returncode == 0:
                # Tesseract found no text. La page n'est déclarée « vide » (réglée, sans nouvelle tentative) que
                # si l'image rendue est presque uniformément claire ; le texte natif éventuel est gardé, avec la
                # confiance d'une lecture native puisque l'OCR n'y a rien ajouté. Sinon la page porte de l'encre :
                # une seconde passe pivotée (page scannée de côté) ; si elle ne lit rien non plus, la page reste à
                # reprendre (ocr_no_text_unverified) au lieu d'être classée vide sans preuve.
                if _pixmap_is_uniformly_light(pixmap) is True:
                    return {
                        "text": fallback,
                        "method": OCR_NO_TEXT_METHOD,
                        "confidence": page_text_confidence(fallback, method="pymupdf_text"),
                        "status": "extracted" if clean_text(fallback) else "no_text",
                        "retryable": False,
                    }
                rotated_path = os.path.join(tmpdir, "page-rotated.png")
                _ensure_ocr_deadline(
                    operation="rendering rotated OCR page",
                    checkpointed_pages=checkpointed_pages,
                    total_pages=total_pages,
                    new_progress_pages=new_progress_pages,
                )
                page.get_pixmap(
                    matrix=fitz.Matrix(3, 3).prerotate(OCR_ROTATION_DEGREES), alpha=False
                ).save(rotated_path)
                timeout, deadline_bounded = deadline_bounded_timeout(
                    timeout,
                    operation="starting rotated OCR subprocess",
                    checkpointed_pages=checkpointed_pages,
                    total_pages=total_pages,
                    new_progress_pages=new_progress_pages,
                )
                rotated = subprocess.run(
                    ["tesseract", rotated_path, "stdout", "-l", str(settings["pdf_ocr_language"])],
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    env=env,
                    check=False,
                )
                _ensure_ocr_deadline(
                    operation="finishing rotated OCR subprocess",
                    checkpointed_pages=checkpointed_pages,
                    total_pages=total_pages,
                    new_progress_pages=new_progress_pages,
                )
                if rotated.returncode == 0 and _has_word(rotated.stdout):
                    text = "\n".join(
                        part for part in (clean_text(fallback), clean_text(rotated.stdout)) if part
                    )
                    return {
                        "text": text,
                        "method": OCR_ROTATED_METHOD,
                        "confidence": page_text_confidence(rotated.stdout, method="ocr_tesseract"),
                        "status": "extracted",
                        "retryable": False,
                    }
                if rotated.returncode == 0:
                    # Troisième lecture, en texte épars, de l'image droite : elle lit un texte que la mise en
                    # page automatique a manqué, ou prouve qu'il n'y en a pas (photographies, plan).
                    timeout, deadline_bounded = deadline_bounded_timeout(
                        timeout,
                        operation="starting sparse OCR subprocess",
                        checkpointed_pages=checkpointed_pages,
                        total_pages=total_pages,
                        new_progress_pages=new_progress_pages,
                    )
                    sparse = subprocess.run(
                        [
                            "tesseract",
                            image_path,
                            "stdout",
                            "-l",
                            str(settings["pdf_ocr_language"]),
                            "--psm",
                            OCR_SPARSE_PAGE_SEGMENTATION_MODE,
                            "tsv",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                        env=env,
                        check=False,
                    )
                    _ensure_ocr_deadline(
                        operation="finishing sparse OCR subprocess",
                        checkpointed_pages=checkpointed_pages,
                        total_pages=total_pages,
                        new_progress_pages=new_progress_pages,
                    )
                    if sparse.returncode == 0:
                        words = sparse_ocr_words(sparse.stdout)
                        confident_words = sparse_ocr_confident_word_count(words)
                        sparse_text = clean_text(sparse_ocr_text(words)) if confident_words else None
                        if confident_words >= OCR_SPARSE_MIN_CONFIDENT_WORDS and sparse_text:
                            text = "\n".join(part for part in (clean_text(fallback), sparse_text) if part)
                            return {
                                "text": text,
                                "method": OCR_SPARSE_METHOD,
                                "confidence": page_text_confidence(sparse_text, method="ocr_tesseract"),
                                "status": "extracted",
                                "retryable": False,
                                "sparse_confident_words": confident_words,
                            }
                        return {
                            "text": fallback,
                            "method": OCR_PICTURE_NO_TEXT_METHOD,
                            "confidence": page_text_confidence(fallback, method="pymupdf_text"),
                            "status": "extracted" if clean_text(fallback) else "no_text",
                            "retryable": False,
                            "sparse_confident_words": confident_words,
                        }
                    LOGGER.debug("Sparse Tesseract OCR returned %s: %s", sparse.returncode, sparse.stderr)
                return {
                    "text": fallback,
                    "method": OCR_NO_TEXT_UNVERIFIED_METHOD,
                    "confidence": page_text_confidence(fallback, method="pymupdf_text"),
                    "status": "extracted" if clean_text(fallback) else "failed",
                    "retryable": True,
                    "failure_reason": "ocr_no_text_unverified",
                }
            LOGGER.debug("Tesseract OCR returned %s: %s", result.returncode, result.stderr)
    except subprocess.TimeoutExpired as exc:
        if deadline_bounded:
            raise _deadline_exception(
                "PDF bounded deadline reached during OCR; retry resumes from checkpoint",
                checkpointed_pages=checkpointed_pages,
                total_pages=total_pages,
                new_progress_pages=new_progress_pages,
            ) from exc
        _ensure_ocr_deadline(
            operation="checking deadline after OCR timeout",
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
        LOGGER.debug("Tesseract OCR timed out after %.1fs", timeout)
    except _DEADLINE_ERRORS:
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
