"""Conservative visual checks for PDF pages whose OCR returned no text."""

from __future__ import annotations

import logging
from decimal import Decimal

import fitz

from src.normalize import clean_text

LOGGER = logging.getLogger(__name__)

VISUAL_BLANK_INK_THRESHOLD = 240
VISUAL_BLANK_INK_RATIO_MAX = 0.005
VISUAL_BLANK_RENDER_MAX_DIMENSION = 800
# A native text layer can contain a header, footer, or a few labels while the
# actual page is a scanned image. OCR must still run when the image covers a
# meaningful part of the page. Keep small logos/stamps below this threshold.
PAGE_OCR_IMAGE_COVERAGE_MIN = 0.20


def is_decorative_edge_only_page(page: fitz.Page) -> bool:
    """Recognize a single solid border shape, never a scanned page or map.

    Some diagnostic PDFs end with a blank page whose only visible mark is a
    full-height coloured curve clipped at the page edge. Require one simple
    filled vector shape confined to an outer 15% band, with no text,
    annotations, or embedded images, before excluding that page from retries.
    """

    try:
        if clean_text(page.get_text("text")) or next(page.annots(), None) is not None:
            return False
        if page.get_images(full=True) or page.get_image_info():
            return False
        drawings = page.get_drawings()
        if len(drawings) != 1:
            return False
        drawing = drawings[0]
        if drawing.get("type") != "f" or drawing.get("fill") is None:
            return False
        items = drawing.get("items") or []
        if not 1 <= len(items) <= 8 or any(item[0] not in {"c", "re"} for item in items):
            return False
        shape = drawing.get("rect")
        bounds = page.rect
        if shape is None or bounds.width <= 0 or bounds.height <= 0:
            return False
        side_band = bounds.width * 0.15
        top_band = bounds.height * 0.15
        vertical_edge = shape.height >= bounds.height * 0.85 and (
            shape.x0 >= bounds.x1 - side_band or shape.x1 <= bounds.x0 + side_band
        )
        horizontal_edge = shape.width >= bounds.width * 0.85 and (
            shape.y0 >= bounds.y1 - top_band or shape.y1 <= bounds.y0 + top_band
        )
        return vertical_edge or horizontal_edge
    except Exception:
        return False


def _is_objectively_blank_page(page: fitz.Page, raw_text: str) -> bool:
    """Return true only when a page has no text, image, or vector drawing."""
    if clean_text(raw_text):
        return False
    try:
        if page.get_images(full=True):
            return False
        if page.get_drawings():
            return False
    except Exception:
        # An inspection failure must leave the page eligible for OCR. An empty
        # page cannot be called objectively blank without all three checks.
        return False
    return True


def _page_image_coverage(page: fitz.Page) -> float:
    """Return the approximate fraction of the page covered by images.

    ``Page.get_images`` exposes image resources but not their placement. The
    image-info API includes bounding boxes and lets us distinguish a full-page
    scan from a small logo without rasterising the page. Overlapping images are
    conservatively summed and capped at 100%.
    """
    try:
        page_rect = page.rect
        page_area = float(page_rect.width) * float(page_rect.height)
        if page_area <= 0:
            return 0.0
        covered_area = 0.0
        for info in page.get_image_info():
            bbox = info.get("bbox") if isinstance(info, dict) else None
            if not bbox or len(bbox) != 4:
                continue
            x0, y0, x1, y1 = (float(value) for value in bbox)
            left = max(float(page_rect.x0), min(x0, x1))
            top = max(float(page_rect.y0), min(y0, y1))
            right = min(float(page_rect.x1), max(x0, x1))
            bottom = min(float(page_rect.y1), max(y0, y1))
            if right > left and bottom > top:
                covered_area += (right - left) * (bottom - top)
        return min(1.0, max(0.0, covered_area / page_area))
    except Exception:
        # If placement inspection fails, leave the normal short-text OCR gate
        # in charge. A malformed image must never make a page complete.
        return 0.0


def _page_has_substantial_image(page: fitz.Page) -> bool:
    return _page_image_coverage(page) >= PAGE_OCR_IMAGE_COVERAGE_MIN


def _visual_page_profile(page: fitz.Page) -> dict[str, object]:
    """Measure page ink without retaining a derived image.

    The source PDF remains the evidence of record. This low-resolution
    grayscale pass only distinguishes an OCR-empty near-blank page from an
    image-rich page that may contain information.
    """

    try:
        rect = page.rect
        largest_dimension = max(float(rect.width), float(rect.height), 1.0)
        scale = min(1.0, VISUAL_BLANK_RENDER_MAX_DIMENSION / largest_dimension)
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(scale, scale),
            colorspace=fitz.csGRAY,
            alpha=False,
        )
        channel_count = max(int(pixmap.n), 1)
        samples = pixmap.samples
        pixel_count = int(pixmap.width) * int(pixmap.height)
        if not samples or pixel_count <= 0:
            return {
                "analysis_status": "unavailable",
                "quasi_empty": False,
                "reason": "empty_render",
            }
        ink_pixels = sum(
            1
            for offset in range(0, min(len(samples), pixel_count * channel_count), channel_count)
            if samples[offset] < VISUAL_BLANK_INK_THRESHOLD
        )
        ink_ratio = ink_pixels / pixel_count
        decorative_edge_only = is_decorative_edge_only_page(page)
        return {
            "analysis_status": "measured",
            "quasi_empty": ink_ratio <= VISUAL_BLANK_INK_RATIO_MAX or decorative_edge_only,
            "decorative_edge_only": decorative_edge_only,
            "ink_ratio": round(ink_ratio, 6),
            "ink_threshold": VISUAL_BLANK_INK_THRESHOLD,
            "ink_ratio_max": VISUAL_BLANK_INK_RATIO_MAX,
            "pixel_count": pixel_count,
            "render_scale": round(scale, 4),
        }
    except Exception as exc:
        LOGGER.debug("Visual blank-page analysis failed: %s", exc)
        return {
            "analysis_status": "unavailable",
            "quasi_empty": False,
            "reason": "render_failed",
        }


def _page_requires_retry(page: object, *, ocr_enabled: bool) -> bool:
    if not isinstance(page, dict):
        return True
    status = str(page.get("status") or page.get("extraction_status") or "").strip().lower()
    if status in {"failed", "incomplete", "ocr_failed", "empty"} or page.get("retryable") is True:
        return True
    if status in {"blank_excluded", "blank_page_excluded", "visual_blank_excluded"}:
        return False
    if not clean_text(page.get("text")):
        return True
    # Older caches represented a failed OCR pass as fallback_text. Once OCR is
    # enabled, that text is evidence to retain, never a successful page hit.
    return ocr_enabled and str(page.get("method") or "") == "fallback_text"


def _page_text_confidence(text: str | None, *, method: str) -> float:
    chars = len(clean_text(text) or "")
    if chars == 0:
        return 0.0
    if method == "pymupdf_text":
        base = Decimal("0.92")
    elif method == "ocr_pymupdf":
        base = Decimal("0.74")
    elif method == "ocr_tesseract":
        base = Decimal("0.70")
    else:
        base = Decimal("0.45")
    if chars < 120:
        base -= Decimal("0.18")
    elif chars < 500:
        base -= Decimal("0.08")
    return float(max(Decimal("0.1"), min(Decimal("0.98"), base)))
