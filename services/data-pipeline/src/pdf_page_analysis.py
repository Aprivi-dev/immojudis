"""Conservative visual checks for PDF pages whose OCR returned no text."""

from __future__ import annotations

import fitz

from src.normalize import clean_text


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
