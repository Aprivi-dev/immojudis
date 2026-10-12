"""Pure validation rules for persisted PDF checkpoints (no I/O, no database).

Split out of ``supabase_client`` (P6-05). Every name is re-exported there, so
existing imports and test patches on ``supabase_client`` keep working.
"""

from __future__ import annotations

import hashlib

from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.normalize import clean_text
from src.pdf_progress import PDF_PROGRESS_SCHEMA_VERSION, document_url, is_modern_payload, modern_progress_entries


def _is_sha256(value: object) -> bool:
    text = clean_text(value) or ""
    return len(text) == 64 and all(character in "0123456789abcdefABCDEF" for character in text)


def _manifest_urls(value: object) -> set[str] | None:
    if value is None:
        return set()
    if not isinstance(value, (list, tuple, set)):
        return None
    urls: set[str] = set()
    for item in value:
        url = clean_text(item)
        if not url:
            return None
        urls.add(url)
    return urls


def _valid_pdf_checkpoint_pages(
    value: object,
    *,
    page_count: object,
    require_chars: bool = False,
) -> bool:
    """Accept only successful page records from the modern extractor cache."""

    if type(page_count) is not int or page_count < 1 or not isinstance(value, list) or not value:
        return False
    seen_pages: set[int] = set()
    for page in value:
        if not isinstance(page, dict):
            return False
        page_number = page.get("page")
        page_text = clean_text(page.get("text")) or ""
        if (
            type(page_number) is not int
            or page_number < 1
            or page_number > page_count
            or page_number in seen_pages
            or not isinstance(page.get("text"), str)
            or (
                require_chars
                and (type(page.get("chars")) is not int or page.get("chars") != len(page_text))
            )
            or (
                page.get("chars") is not None
                and (type(page.get("chars")) is not int or page.get("chars") != len(page_text))
            )
            or clean_text(page.get("status"))
            not in {
                "extracted",
                "blank_page",
                "blank_excluded",
                "blank_page_excluded",
                "visual_blank_excluded",
                "failed",
            }
            or (
                clean_text(page.get("status")) == "failed"
                and page.get("retryable") is not True
            )
            or (
                clean_text(page.get("status")) != "failed"
                and page.get("retryable") is True
            )
        ):
            return False
        seen_pages.add(page_number)
    return True


def _reusable_pdf_checkpoint_pages(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [
        page
        for page in value
        if isinstance(page, dict)
        and clean_text(page.get("status")) != "failed"
        and page.get("retryable") is not True
    ]


def _checkpoint_payload_text_hash(payload: dict[str, object]) -> str | None:
    """Return the canonical hash for a validated modern payload.

    A genuinely textless modern checkpoint uses an explicit empty hash.
    ``clean_text`` turns that marker into ``None`` during comparisons, so
    normalize it only after the payload's modern/page validation has
    succeeded. Non-empty text must carry its explicit hash; this helper never
    derives a replacement hash from the text.
    """

    text = clean_text(payload.get("text")) or ""
    if not text and payload.get("text_chars") == 0:
        return "" if payload.get("text_sha256") == "" and "text_sha256" in payload else None
    return clean_text(payload.get("text_sha256")) if "text_sha256" in payload else None


def _checkpoint_manifest_text_hash(entry: dict[str, object]) -> str | None:
    """Return a manifest hash while preserving the modern empty-text marker."""

    if entry.get("text_present") is False and entry.get("text_chars") == 0:
        return "" if entry.get("text_sha256") == "" and "text_sha256" in entry else None
    return clean_text(entry.get("text_sha256")) if "text_sha256" in entry else None


def _checkpoint_pages_match_payload(
    payload: dict[str, object],
    *,
    require_chars: bool = False,
) -> bool:
    """Tie page text and the aggregate text hash for page based checkpoints."""

    pages = payload.get("pages")
    if not _checkpoint_page_coverage_matches(payload, require_chars=require_chars):
        return False
    assert isinstance(pages, list)
    page_text = clean_text("\n".join(str(page["text"]) for page in sorted(pages, key=lambda item: item["page"]))) or ""
    payload_text = clean_text(payload.get("text")) or ""
    if page_text != payload_text:
        return False
    page_text_hash = hashlib.sha256(page_text.encode("utf-8")).hexdigest() if page_text else ""
    payload_text_hash = _checkpoint_payload_text_hash(payload)
    if payload_text_hash != page_text_hash:
        return False
    return payload_text_hash == page_text_hash


def _checkpoint_page_coverage_matches(
    payload: dict[str, object],
    *,
    require_chars: bool = False,
) -> bool:
    pages = payload.get("pages")
    if not _valid_pdf_checkpoint_pages(
        pages,
        page_count=payload.get("page_count"),
        require_chars=require_chars,
    ):
        return False
    assert isinstance(pages, list)
    failed_pages = payload.get("failed_pages")
    if not isinstance(failed_pages, list):
        return False
    page_numbers = {int(page["page"]) for page in _reusable_pdf_checkpoint_pages(pages)}
    page_count = int(payload["page_count"])
    if any(type(page) is not int or page < 1 or page > page_count for page in failed_pages):
        return False
    if len(set(failed_pages)) != len(failed_pages):
        return False
    missing_pages = sorted(set(range(1, page_count + 1)) - page_numbers)
    status = clean_text(payload.get("extraction_status")) or ""
    if payload.get("complete") is True or status in {"extracted", "empty"}:
        return not missing_pages and not failed_pages
    return sorted(failed_pages) == missing_pages


def _validate_pdf_document_checkpoint_payload(
    sale: AuctionSale,
    analysis: object,
    payload: object,
) -> tuple[dict[str, object], list[dict[str, object]]] | None:
    """Validate a modern aggregate, including the durable page evidence."""

    source_url = clean_text(sale.source_url)
    if not source_url or not isinstance(analysis, dict) or sale.updated_at is None:
        return None
    if (
        analysis.get("progress_schema_version") != PDF_PROGRESS_SCHEMA_VERSION
        or analysis.get("input_fingerprint") != document_fingerprint(sale.documents)
        or not isinstance(analysis.get("manifest_complete"), bool)
    ):
        return None
    progress = modern_progress_entries(analysis, sale.documents)
    if not progress:
        return None
    if not isinstance(payload, list) or not payload:
        return None
    document_urls = {document_url(document) for document in sale.documents if document_url(document)}
    result: list[dict[str, object]] = []
    seen_urls: set[str] = set()
    for item in payload:
        url = document_url(item)
        if (
            not isinstance(item, dict)
            or not url
            or url in seen_urls
            or url not in document_urls
            or not is_modern_payload(item, expected_url=url)
        ):
            return None
        page_based_extraction = clean_text(item.get("extraction_method")) == "pymupdf_pages"
        if not _checkpoint_page_coverage_matches(item, require_chars=True):
            return None
        # PyMuPDF page extraction defines the aggregate text as the ordered
        # page text. Docling may provide a richer aggregate while retaining
        # the page diagnostics, so only the page based path can enforce this
        # exact text/hash relationship.
        if page_based_extraction and not _checkpoint_pages_match_payload(item, require_chars=True):
            return None
        manifest_item = progress.get(url)
        if not isinstance(manifest_item, dict):
            return None
        item_text_hash = _checkpoint_payload_text_hash(item)
        manifest_text_hash = _checkpoint_manifest_text_hash(manifest_item)
        if (
            clean_text(item.get("sha256")) != clean_text(manifest_item.get("sha256"))
            or clean_text(item.get("extraction_status"))
            != clean_text(manifest_item.get("extraction_status"))
            or item.get("complete") is not manifest_item.get("complete")
            or list(item.get("failed_pages") or []) != list(manifest_item.get("failed_pages") or [])
            or item_text_hash is None
            or manifest_text_hash is None
            or item_text_hash != manifest_text_hash
        ):
            return None
        if analysis.get("manifest_complete") is True and item.get("complete") is not True:
            return None
        sanitized = dict(item)
        # A worker-local path is not a durable source of evidence and cannot
        # be reopened by the next worker. Keep the modern text and hashes only.
        sanitized["file_path"] = None
        result.append(sanitized)
        seen_urls.add(url)
    if not result:
        return None
    return dict(analysis), result
