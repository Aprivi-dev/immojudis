"""Safe, structured diagnostics for failed PDF extraction.

The extractor payloads contain page text and paths alongside the failure
markers.  Queue and cloud logs only need the small, stable part of that
payload: the extraction state, page numbers, and known failure reasons.  This
module deliberately has no dependency on the extractor so it can be used at
the persistence and queue boundaries without accidentally serialising PDF
content.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

KNOWN_PDF_FAILURE_REASONS = frozenset(
    {
        "decorative_edge_after_ocr",
        "empty_page_not_proven_blank",
        "extractor_exception",
        "ocr_failed",
        "visual_blank_after_ocr",
    }
)

_FAILURE_STATUSES = frozenset({"failed", "incomplete"})
_NON_FAILURE_PAGE_STATUSES = frozenset(
    {"blank", "blank_excluded", "blank_page_excluded", "visual_blank_excluded"}
)
_MAX_PAGE_NUMBER = 100_000


def _safe_page_number(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1 or value > _MAX_PAGE_NUMBER:
        return None
    return value


def _safe_page_numbers(value: object) -> list[int]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return sorted({page for page in (_safe_page_number(item) for item in value) if page is not None})


def _safe_reason(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    reason = value.strip().lower()
    return reason if reason in KNOWN_PDF_FAILURE_REASONS else None


def _safe_exception_type(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    safe = "".join(char for char in value if char.isascii() and (char.isalnum() or char in "._"))
    return safe[:64] or None


def summarize_pdf_failure(payload: Mapping[str, object] | None) -> dict[str, object]:
    """Return only safe scalar diagnostics from one extractor payload.

    A reason is copied only from the finite set emitted by the extractor.  A
    failed payload with no recognised reason receives ``unknown`` because the
    payload does not contain enough evidence to name the cause. Pages marked
    as intentionally excluded blank pages are not treated as failures unless
    an explicit ``failed_pages`` marker contradicts that status.
    """

    if not isinstance(payload, Mapping):
        return {
            "status": "failed",
            "failed_pages": [],
            "failure_reasons": ["unknown"],
            "page_count": 0,
        }

    raw_status = str(payload.get("extraction_status") or "").strip().lower()
    if raw_status not in {"extracted", "incomplete", "failed", "empty"}:
        raw_status = ""
    explicit_failed_pages = _safe_page_numbers(payload.get("failed_pages"))
    pages = payload.get("pages")
    page_records = pages if isinstance(pages, Sequence) and not isinstance(pages, (str, bytes, bytearray)) else []
    failed_pages = set(explicit_failed_pages)
    reasons: set[str] = set()

    payload_reason = _safe_reason(payload.get("failure_reason"))
    if payload_reason:
        reasons.add(payload_reason)

    for page in page_records:
        if not isinstance(page, Mapping):
            continue
        page_number = _safe_page_number(page.get("page"))
        page_status = str(page.get("status") or page.get("extraction_status") or "").strip().lower()
        if page_status in _NON_FAILURE_PAGE_STATUSES and page_number not in explicit_failed_pages:
            continue
        is_failed = (
            page_number in failed_pages
            or page_status in _FAILURE_STATUSES
            or page.get("retryable") is True
        )
        if not is_failed:
            continue
        if page_number is not None:
            failed_pages.add(page_number)
        reason = _safe_reason(page.get("failure_reason"))
        if reason:
            reasons.add(reason)

    failure_signal = bool(failed_pages) or raw_status in _FAILURE_STATUSES or payload.get("complete") is False
    if failure_signal and not reasons:
        reasons.add("unknown")

    if failed_pages or payload.get("complete") is False:
        status = "incomplete"
    elif raw_status:
        status = raw_status
    elif payload.get("complete") is True:
        status = "extracted"
    else:
        status = "unknown"

    page_count = _safe_page_number(payload.get("page_count"))
    if page_count is None:
        page_count = len(page_records)
    result: dict[str, object] = {
        "status": status,
        "failed_pages": sorted(failed_pages),
        "failure_reasons": sorted(reasons),
        "page_count": page_count,
    }
    exception_type = _safe_exception_type(payload.get("exception_type"))
    if exception_type:
        result["exception_type"] = exception_type
    return result


def format_pdf_failure_diagnostics(diagnostics: Mapping[str, object] | None) -> str:
    """Format a bounded, content-free diagnostic fragment for a log line."""

    if not isinstance(diagnostics, Mapping):
        diagnostics = summarize_pdf_failure(None)
    elif "status" not in diagnostics:
        diagnostics = summarize_pdf_failure(diagnostics)
    raw_status = diagnostics.get("status")
    status = raw_status if isinstance(raw_status, str) else "unknown"
    if status not in {"extracted", "incomplete", "failed", "empty", "unknown"}:
        status = "unknown"
    pages = _safe_page_numbers(diagnostics.get("failed_pages"))
    raw_reasons = diagnostics.get("failure_reasons", [])
    if isinstance(raw_reasons, str):
        raw_reasons = [raw_reasons]
    if not isinstance(raw_reasons, Sequence):
        raw_reasons = []
    reasons = [
        reason
        for reason in raw_reasons
        if isinstance(reason, str) and (reason in KNOWN_PDF_FAILURE_REASONS or reason == "unknown")
    ]
    if len(pages) > 20:
        page_text = ",".join(str(page) for page in pages[:20]) + f",...(+{len(pages) - 20};total={len(pages)})"
    else:
        page_text = ",".join(str(page) for page in pages) or "none"
    reason_text = ",".join(sorted(set(reasons))) or "unknown"
    exception_type = _safe_exception_type(diagnostics.get("exception_type"))
    suffix = f" exception_type={exception_type}" if exception_type else ""
    return f"status={status} failed_pages={page_text} reasons={reason_text}{suffix}"


def pdf_extraction_exception_marker(url: object, exception_type: object = None) -> dict[str, object]:
    """Build a safe payload marker when the extractor raises before a payload."""

    return {
        "url": str(url or ""),
        "extraction_status": "failed",
        "failure_reason": "extractor_exception",
        "exception_type": _safe_exception_type(exception_type),
    }
