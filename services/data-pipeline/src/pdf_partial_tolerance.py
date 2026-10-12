"""Documents read except for a few pages (owner decision, 12/10/2026).

A document whose OCR fails on a handful of pages used to stay ``incomplete``
forever: every queue pass and every manual drain downloaded it again, retried
the same pages, failed again, and starved documents never read at all (drain
of 12/10/2026: 77 of 98 sales made no progress, 130 documents in that state).

Such a document is now *tolerated*: it joins the existing terminal URLs (like
an empty document or a permanent 404), so it is no longer retried until its
HTTP revalidation window expires. Nothing is promoted to ``extracted``: every
gate that requires a complete extraction stays strict, the missing pages stay
recorded, and the row is shown as ``partial``. Its text keeps feeding what
already accepted partial text (fact projection, document reading).

A document is tolerated only when all of this holds:

* the current read of that exact file (same SHA-256) is ``incomplete`` with
  text and an explicit list of failed pages;
* at most 10 % of its pages failed (so it has at least 10 pages);
* the previous read of the same file already failed on those pages: one retry
  did not recover them.
"""

from __future__ import annotations

from typing import Any

from src.pdf_progress import document_url

# One failed page per started ten pages read: a 77-page conditions of sale
# with one unreadable page is tolerated, a 5-page report with one is not.
MAX_FAILED_PAGE_SHARE_DENOMINATOR = 10


def _failed_pages(payload: dict[str, Any]) -> list[int] | None:
    pages = payload.get("failed_pages")
    if not isinstance(pages, list) or not pages:
        return None
    if any(type(page) is not int or page < 1 for page in pages):
        return None
    return sorted(set(pages))


def _page_count(payload: dict[str, Any]) -> int | None:
    value = payload.get("page_count")
    if type(value) is int and value > 0:
        return value
    pages = payload.get("pages")
    if isinstance(pages, list) and pages:
        return len(pages)
    return None


def _has_text(payload: dict[str, Any]) -> bool:
    if str(payload.get("text") or "").strip():
        return True
    chars = payload.get("text_chars")
    return payload.get("text_present") is True and type(chars) is int and chars > 0


def failed_page_share_is_tolerable(failed_pages: list[int], page_count: int) -> bool:
    return 0 < len(failed_pages) and len(failed_pages) * MAX_FAILED_PAGE_SHARE_DENOMINATOR <= page_count


def previous_reads_by_url(previous_analysis: object) -> dict[str, dict[str, Any]]:
    """The previous pass's per-document proof items, keyed by URL."""
    if not isinstance(previous_analysis, dict):
        return {}
    proof = previous_analysis.get("cache_proof")
    items = proof.get("documents") if isinstance(proof, dict) else None
    return {
        document_url(item): item
        for item in (items if isinstance(items, list) else [])
        if isinstance(item, dict) and document_url(item)
    }


def is_tolerated_partial(payload: object, previous_read: object) -> bool:
    if not isinstance(payload, dict) or not isinstance(previous_read, dict):
        return False
    status = str(payload.get("extraction_status") or "").strip().lower()
    if status != "incomplete" or payload.get("complete") is True:
        return False
    failed = _failed_pages(payload)
    page_count = _page_count(payload)
    sha256 = str(payload.get("sha256") or "").strip()
    if failed is None or page_count is None or not sha256 or not _has_text(payload):
        return False
    if failed[-1] > page_count or not failed_page_share_is_tolerable(failed, page_count):
        return False
    # The same file was read before and already failed on (at least) these
    # pages: the retry of the failed pages did not recover them.
    if str(previous_read.get("sha256") or "").strip() != sha256:
        return False
    if str(previous_read.get("extraction_status") or "").strip().lower() != "incomplete":
        return False
    previous_failed = _failed_pages(previous_read)
    return previous_failed is not None and set(failed) <= set(previous_failed)


def tolerated_partial_url_set(analysis: object) -> set[str]:
    """URLs a document analysis records as read except for a few pages."""
    items = analysis.get("tolerated_partial_documents") if isinstance(analysis, dict) else None
    return {
        document_url(item)
        for item in (items if isinstance(items, list) else [])
        if isinstance(item, dict) and document_url(item)
    }


def tolerated_partial_documents(payloads: list[dict[str, Any]], previous_analysis: object) -> list[dict[str, Any]]:
    """URL, page count and failed pages of every tolerated document."""
    previous = previous_reads_by_url(previous_analysis)
    previously_tolerated = {
        document_url(item): item
        for item in (
            previous_analysis.get("tolerated_partial_documents")
            if isinstance(previous_analysis, dict)
            and isinstance(previous_analysis.get("tolerated_partial_documents"), list)
            else []
        )
        if isinstance(item, dict) and document_url(item)
    }
    tolerated: dict[str, dict[str, Any]] = {}
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        url = document_url(payload)
        if not url:
            continue
        prior = previous.get(url)
        accepted = previously_tolerated.get(url)
        if accepted is not None and str(accepted.get("sha256") or "") == str(payload.get("sha256") or ""):
            # Once tolerated, the same file stays tolerated while it is unchanged.
            prior = {**accepted, "extraction_status": "incomplete"}
        if is_tolerated_partial(payload, prior):
            tolerated[url] = {
                "url": url,
                "sha256": str(payload.get("sha256")),
                "page_count": _page_count(payload),
                "failed_pages": _failed_pages(payload),
            }
    return list(tolerated.values())
