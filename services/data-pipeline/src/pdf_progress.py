"""Document-level PDF progress and provenance helpers.

This module deliberately has no dependency on the PDF extractor.  It is used
by the selector, the extractor and the cold-cache recovery path, so keeping it
as a leaf prevents the existing ``pdf_enrichment``/selection import cycle from
growing another edge.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from src.freshness import document_fingerprint, timestamp_is_fresh
from src.normalize import clean_text

PDF_TEXT_CACHE_VERSION = "pdf_text_v3_surface_calibration"
PDF_PROGRESS_SCHEMA_VERSION = 1


def document_url(value: object) -> str:
    if isinstance(value, dict):
        return clean_text(value.get("url")) or ""
    return clean_text(value) or ""


def payload_text_sha256(payload: dict[str, Any]) -> str:
    text = clean_text(payload.get("text")) or ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest() if text else ""


def _page_cache_directory(
    file_path: Path,
    cache_root: Path,
    *,
    ocr_enabled: bool,
    ocr_language: str,
) -> Path:
    cache_key = hashlib.sha256(
        file_path.read_bytes()
        + str((bool(ocr_enabled), str(ocr_language), PDF_TEXT_CACHE_VERSION)).encode()
    ).hexdigest()
    return cache_root / "pages" / cache_key


def _valid_cached_page(page: object, expected_page: int | None = None) -> bool:
    if not isinstance(page, dict):
        return False
    if expected_page is not None and page.get("page") != expected_page:
        return False
    if not isinstance(page.get("text"), str) or page.get("retryable") is True:
        return False
    return str(page.get("status") or "") in {
        "extracted",
        "blank_page",
        "blank_excluded",
        "visual_blank_excluded",
    }


def read_checkpointed_pdf_pages(
    file_path: Path,
    cache_root: Path,
    *,
    total_pages: int,
    ocr_enabled: bool,
    ocr_language: str,
) -> list[dict[str, Any]]:
    """Read only successful page records from the durable page cache."""

    if total_pages <= 0:
        return []
    try:
        cache_dir = _page_cache_directory(
            file_path,
            cache_root,
            ocr_enabled=ocr_enabled,
            ocr_language=ocr_language,
        )
    except OSError:
        return []
    pages: list[dict[str, Any]] = []
    for page_number in range(1, total_pages + 1):
        try:
            page = json.loads((cache_dir / f"{page_number}.json").read_text(encoding="utf-8"))
        except (OSError, TypeError, UnicodeError, ValueError, json.JSONDecodeError):
            continue
        if not _valid_cached_page(page, page_number):
            continue
        pages.append(dict(page))
    return pages


def partial_pdf_payload_from_page_cache(
    file_path: Path,
    document: dict[str, Any],
    *,
    cache_root: Path,
    total_pages: int,
    ocr_enabled: bool,
    ocr_language: str,
) -> dict[str, Any] | None:
    """Build modern incomplete evidence from pages already checkpointed."""

    pages = read_checkpointed_pdf_pages(
        file_path,
        cache_root,
        total_pages=total_pages,
        ocr_enabled=ocr_enabled,
        ocr_language=ocr_language,
    )
    if not pages:
        return None
    page_numbers = {int(page["page"]) for page in pages}
    text = clean_text("\n".join(str(page.get("text") or "") for page in pages)) or ""
    failed_pages = [page for page in range(1, total_pages + 1) if page not in page_numbers]
    blank_pages = [
        int(page["page"])
        for page in pages
        if str(page.get("status") or "") in {"blank_page", "blank_excluded", "visual_blank_excluded"}
    ]
    visual_blank_pages = [
        int(page["page"])
        for page in pages
        if str(page.get("status") or "") == "visual_blank_excluded"
    ]
    return {
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "label": document.get("label") or "",
        "url": document_url(document),
        "type": document.get("type") or "pdf",
        "document_type": document.get("document_type") or document.get("type") or "pdf",
        "file_path": str(file_path),
        "text": text,
        "pages": pages,
        "sha256": hashlib.sha256(file_path.read_bytes()).hexdigest(),
        "page_count": total_pages,
        "text_chars": len(text),
        "page_text_chars": sum(int(page.get("chars") or 0) for page in pages),
        "ocr_pages": sum(1 for page in pages if str(page.get("method") or "").startswith("ocr_")),
        "empty_pages": sum(1 for page in pages if not clean_text(page.get("text"))),
        "blank_pages": blank_pages,
        "visual_blank_pages": visual_blank_pages,
        "failed_pages": failed_pages,
        "complete": False,
        "extraction_status": "incomplete",
        "extraction_method": "pymupdf_pages",
        "confidence": round(
            sum(float(page.get("confidence") or 0) for page in pages) / len(pages),
            3,
        ),
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest() if text else "",
        **(
            {"http_checked_at": clean_text(document.get("http_checked_at"))}
            if clean_text(document.get("http_checked_at"))
            else {}
        ),
    }


def restore_pdf_page_cache_from_payload(
    file_path: Path,
    payload: dict[str, Any],
    *,
    cache_root: Path,
    ocr_enabled: bool,
    ocr_language: str,
) -> int:
    """Materialize a verified cold checkpoint into the page cache."""

    if payload.get("_persisted_pdf_proof") is not True:
        return 0
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        return 0
    try:
        if hashlib.sha256(file_path.read_bytes()).hexdigest() != clean_text(payload.get("sha256")):
            return 0
        cache_dir = _page_cache_directory(
            file_path,
            cache_root,
            ocr_enabled=ocr_enabled,
            ocr_language=ocr_language,
        )
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return 0
    restored = 0
    for page in pages:
        page_number = page.get("page") if isinstance(page, dict) else None
        if not isinstance(page_number, int) or not _valid_cached_page(page, page_number):
            continue
        cache_path = cache_dir / f"{page_number}.json"
        temporary = cache_path.with_suffix(".tmp")
        try:
            temporary.write_text(json.dumps(page, ensure_ascii=False), encoding="utf-8")
            temporary.replace(cache_path)
        except OSError:
            temporary.unlink(missing_ok=True)
            continue
        restored += 1
    return restored


def restore_pdf_page_caches_from_manifest(
    manifest_path: Path,
    documents: list[dict[str, Any]],
    *,
    cache_root: Path,
    ocr_enabled: bool,
    ocr_language: str,
) -> int:
    """Restore page caches for persisted modern payloads after download."""

    payloads = read_modern_cache(manifest_path) if manifest_path.exists() else []
    payload_by_url = {
        document_url(payload): payload
        for payload in payloads
        if payload.get("_persisted_pdf_proof") is True and document_url(payload)
    }
    restored = 0
    for document in documents:
        url = document_url(document)
        payload = payload_by_url.get(url)
        file_path = document.get("file_path")
        if not payload or not isinstance(file_path, str) or not file_path:
            continue
        restored += restore_pdf_page_cache_from_payload(
            Path(file_path),
            payload,
            cache_root=cache_root,
            ocr_enabled=ocr_enabled,
            ocr_language=ocr_language,
        )
    return restored


def checkpoint_partial_pdf_progress(
    file_path: Path,
    document: dict[str, Any],
    *,
    error: Any,
    total_pages: int,
    cache_root: Path,
    manifest_path: Path,
    current_texts: list[dict[str, Any]],
    sale: Any,
    analysis: object,
    documents: list[dict[str, Any]],
    downloaded_documents: list[dict[str, Any]],
    ocr_enabled: bool,
    ocr_language: str,
    merge_cache: Callable[..., list[dict[str, Any]]],
    write_cache: Callable[..., object],
    store_status: Callable[..., object],
) -> bool:
    """Finalize an incomplete page pass before its queue exception escapes."""

    payload = partial_pdf_payload_from_page_cache(
        file_path,
        document,
        cache_root=cache_root,
        total_pages=total_pages,
        ocr_enabled=ocr_enabled,
        ocr_language=ocr_language,
    )
    if payload is not None:
        error.partial_payload = dict(payload)
        current_texts.append(payload)
    if not current_texts:
        return False
    merged = merge_cache(
        manifest_path,
        current_texts,
        analysis=analysis,
        documents=documents,
        downloaded_documents=downloaded_documents,
    )
    write_error: Exception | None = None
    if merged:
        try:
            write_cache(sale, merged)
        except Exception as exc:
            # The local aggregate is an optimization. Preserve the original
            # deferred extraction and hand the validated in-memory payload to
            # the queue's direct SQL checkpoint below.
            write_error = exc
    status_error: Exception | None = None
    try:
        store_status(sale, downloaded_documents, current_texts, merged_pdf_texts=merged)
    except Exception as exc:
        status_error = exc
    raw_payload = getattr(sale, "raw_payload", None)
    checkpoint_analysis = raw_payload.get("document_analysis") if isinstance(raw_payload, dict) else None
    if not isinstance(checkpoint_analysis, dict) and isinstance(analysis, dict):
        checkpoint_analysis = analysis
    error.partial_analysis = dict(checkpoint_analysis) if isinstance(checkpoint_analysis, dict) else {}
    error.partial_pdf_texts = [dict(item) for item in merged]
    if write_error is not None:
        error.partial_cache_error = write_error
    if status_error is not None:
        error.partial_status_error = status_error
    return True


def is_sha256(value: object) -> bool:
    text = clean_text(value) or ""
    return len(text) == 64 and all(character in "0123456789abcdefABCDEF" for character in text)


def is_modern_payload(
    payload: object,
    *,
    expected_url: str | None = None,
    require_complete: bool = False,
) -> bool:
    """Return whether a payload can participate in progress recovery.

    The durable writer intentionally still accepts legacy payloads for
    diagnostics.  This predicate is stricter: an entry without explicit
    completion markers, cache version, bytes hash and page status is unknown
    and cannot advance the document cursor.
    """
    if not isinstance(payload, dict):
        return False
    url = document_url(payload)
    if not url or (expected_url is not None and url != expected_url):
        return False
    if payload.get("cache_version") != PDF_TEXT_CACHE_VERSION:
        return False
    if not isinstance(payload.get("complete"), bool):
        return False
    status = (clean_text(payload.get("extraction_status")) or "").casefold()
    if status not in {"extracted", "incomplete", "failed", "empty"}:
        return False
    failed_pages = payload.get("failed_pages")
    if not isinstance(failed_pages, list):
        return False
    if not is_sha256(payload.get("sha256")):
        return False
    raw_text = payload.get("text")
    text = clean_text(raw_text) or ""
    text_chars = payload.get("text_chars")
    if type(text_chars) is not int or text_chars < 0:
        return False
    if text_chars != len(str(raw_text or "")):
        return False
    text_hash = clean_text(payload.get("text_sha256"))
    if text_hash and (not is_sha256(text_hash) or text_hash != payload_text_sha256(payload)):
        return False
    if status == "extracted":
        if payload.get("complete") is not True or failed_pages or not text:
            return False
    elif status == "empty":
        if payload.get("complete") is not True or failed_pages or text:
            return False
    elif payload.get("complete") is True:
        # A complete marker paired with an incomplete/failed status is
        # contradictory and must never become a terminal cursor entry.
        return False
    if require_complete:
        return status in {"extracted", "empty"} and payload.get("complete") is True
    return True


def progress_entry(payload: object) -> dict[str, Any] | None:
    """Create a small manifest entry from a modern text payload."""
    if not is_modern_payload(payload):
        return None
    assert isinstance(payload, dict)
    text = clean_text(payload.get("text")) or ""
    return {
        "label": payload.get("label") or "",
        "url": document_url(payload),
        "document_type": payload.get("document_type") or payload.get("type") or "pdf",
        "cache_version": payload.get("cache_version"),
        "sha256": payload.get("sha256"),
        "text_sha256": clean_text(payload.get("text_sha256")) or payload_text_sha256(payload),
        "text_chars": int(payload.get("text_chars") or len(text)),
        "text_present": bool(text),
        "complete": payload.get("complete") is True,
        "extraction_status": clean_text(payload.get("extraction_status")) or "",
        "failed_pages": list(payload.get("failed_pages") or []),
        "blank_pages": list(payload.get("blank_pages") or []),
        "visual_blank_pages": list(payload.get("visual_blank_pages") or []),
        **(
            {"http_checked_at": checked_at}
            if (checked_at := clean_text(payload.get("http_checked_at")))
            else {}
        ),
    }


def modern_progress_entries(analysis: object, documents: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not isinstance(analysis, dict):
        return {}
    if analysis.get("progress_schema_version") != PDF_PROGRESS_SCHEMA_VERSION:
        return {}
    if analysis.get("input_fingerprint") != document_fingerprint(documents):
        return {}
    document_urls = {document_url(document) for document in documents if document_url(document)}
    current_hashes = {
        document_url(document): clean_text(document.get("sha256"))
        for document in documents
        if document_url(document) and clean_text(document.get("sha256"))
    }
    entries = analysis.get("document_progress")
    if not isinstance(entries, list):
        return {}
    proof = analysis.get("cache_proof")
    proof_documents = proof.get("documents") if isinstance(proof, dict) else None
    if not isinstance(proof_documents, list):
        return {}
    proof_by_url = {
        document_url(item): item
        for item in proof_documents
        if isinstance(item, dict) and document_url(item)
    }
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not is_modern_payload(entry):
            # Manifest entries are metadata rather than full payloads.  Apply
            # the same checks explicitly without requiring a text field.
            if not isinstance(entry, dict):
                continue
            url = document_url(entry)
            if (
                not url
                or url not in document_urls
                or entry.get("cache_version") != PDF_TEXT_CACHE_VERSION
                or not isinstance(entry.get("complete"), bool)
                or entry.get("extraction_status") not in {"extracted", "incomplete", "failed", "empty"}
                or not isinstance(entry.get("failed_pages"), list)
                or not is_sha256(entry.get("sha256"))
                or type(entry.get("text_chars")) is not int
                or entry.get("text_chars") < 0
                or not isinstance(entry.get("text_present"), bool)
            ):
                continue
            entry_text_hash = clean_text(entry.get("text_sha256")) or ""
            if entry_text_hash and not is_sha256(entry_text_hash):
                continue
            if entry.get("extraction_status") in {"extracted", "empty"} and (
                entry.get("complete") is not True or entry.get("failed_pages")
            ):
                continue
            if entry.get("extraction_status") in {"incomplete", "failed"} and entry.get("complete") is True:
                continue
            if entry.get("extraction_status") == "extracted" and (
                entry.get("text_present") is not True
                or entry.get("text_chars") <= 0
                or not entry_text_hash
            ):
                continue
            if entry.get("extraction_status") == "empty" and (
                entry.get("text_present") is not False or entry.get("text_chars") != 0
            ):
                continue
        else:
            url = document_url(entry)
        proof_entry = proof_by_url.get(url)
        if not isinstance(proof_entry, dict) or (
            clean_text(proof_entry.get("sha256")) != clean_text(entry.get("sha256"))
            or clean_text(proof_entry.get("extraction_status")) != clean_text(entry.get("extraction_status"))
            or proof_entry.get("complete") is not entry.get("complete")
            or list(proof_entry.get("failed_pages") or []) != list(entry.get("failed_pages") or [])
            or clean_text(proof_entry.get("text_sha256") or "")
            != clean_text(entry.get("text_sha256") or "")
        ):
            continue
        if current_hashes.get(url) and clean_text(entry.get("sha256")) != current_hashes[url]:
            continue
        if url in document_urls and url not in result:
            result[url] = dict(entry)
    return result


def stale_complete_document_urls(
    analysis: object,
    documents: list[dict[str, Any]],
    cache_dir: Path,
    document_filename: Callable[[dict[str, Any]], str],
) -> set[str]:
    """Return complete or terminal URLs whose HTTP revalidation window expired."""

    entries = modern_progress_entries(analysis, documents)
    complete_urls = {
        url
        for url, entry in entries.items()
        if entry.get("complete") is True and entry.get("extraction_status") in {"extracted", "empty"}
    }
    blocked_urls: set[str] = set()
    terminal_urls: set[str] = set()
    skipped_urls: set[str] = set()
    if isinstance(analysis, dict):
        for key, target in (
            ("blocked_document_urls", blocked_urls),
            ("terminal_document_urls", terminal_urls),
            ("skipped_document_urls", skipped_urls),
        ):
            values = analysis.get(key)
            if isinstance(values, (list, tuple, set)):
                target.update(
                    document_url(value)
                    for value in values
                    if document_url(value)
                )
        permanent_failures = analysis.get("permanent_document_failures")
        if isinstance(permanent_failures, list):
            terminal_urls.update(
                document_url(item.get("url"))
                for item in permanent_failures
                if isinstance(item, dict) and document_url(item.get("url"))
            )
    # Social/media candidates are deterministic prefilter results and should
    # never become a recurring HTTP retry just because the aggregate manifest
    # is old. Other terminal outcomes (robots, 404/403, empty extraction) are
    # HTTP observations and must be checked again after their per-URL TTL.
    revalidation_urls = (complete_urls | blocked_urls | terminal_urls) - skipped_urls
    if not revalidation_urls:
        if isinstance(analysis, dict):
            analysis["http_revalidation_pending_urls"] = []
        return set()
    proof = analysis.get("cache_proof") if isinstance(analysis, dict) else None
    proof_documents = proof.get("documents") if isinstance(proof, dict) else None
    proof_by_url = {
        document_url(item): item
        for item in (proof_documents if isinstance(proof_documents, list) else [])
        if isinstance(item, dict) and document_url(item)
    }
    checked_at_by_url = analysis.get("http_checked_at_by_url") if isinstance(analysis, dict) else None
    stale_urls: set[str] = set()
    for document in documents:
        url = document_url(document)
        if url not in revalidation_urls:
            continue
        file_path = cache_dir / document_filename(document)
        metadata_path = file_path.with_suffix(file_path.suffix + ".http.json")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, TypeError, UnicodeError, ValueError, json.JSONDecodeError):
            metadata = {}
        checked_at = metadata.get("checked_at") if isinstance(metadata, dict) else None
        if not checked_at:
            proof_entry = proof_by_url.get(url)
            checked_at = proof_entry.get("http_checked_at") if isinstance(proof_entry, dict) else None
        if not checked_at and isinstance(checked_at_by_url, dict):
            checked_at = checked_at_by_url.get(url)
        if not timestamp_is_fresh(checked_at):
            stale_urls.add(url)
    if isinstance(analysis, dict):
        previous_pending = analysis.get("http_revalidation_pending_urls")
        retained_pending = {
            document_url(value)
            for value in (previous_pending if isinstance(previous_pending, list) else [])
            if document_url(value)
        }
        analysis["http_revalidation_pending_urls"] = sorted(
            (retained_pending | stale_urls) & revalidation_urls
        )
    return stale_urls


def complete_or_terminal_urls(analysis: object, documents: list[dict[str, Any]]) -> set[str]:
    if not isinstance(analysis, dict):
        return set()
    if analysis.get("input_fingerprint") != document_fingerprint(documents):
        return set()
    document_urls = {document_url(document) for document in documents if document_url(document)}
    entries = modern_progress_entries(analysis, documents)
    complete = {
        url
        for url, entry in entries.items()
        if entry.get("complete") is True and entry.get("extraction_status") in {"extracted", "empty"}
    }
    for key in ("blocked_document_urls", "skipped_document_urls", "terminal_document_urls"):
        values = analysis.get(key)
        if isinstance(values, (list, tuple, set)):
            complete.update(document_url(value) for value in values if document_url(value) in document_urls)
    return complete & document_urls


def pending_document_urls(analysis: object, documents: list[dict[str, Any]]) -> set[str]:
    document_urls = {document_url(document) for document in documents if document_url(document)}
    return document_urls - complete_or_terminal_urls(analysis, documents)


def manifest_is_complete(analysis: object, documents: list[dict[str, Any]]) -> bool:
    if not documents:
        return True
    if not isinstance(analysis, dict):
        return False
    if analysis.get("progress_schema_version") != PDF_PROGRESS_SCHEMA_VERSION:
        return False
    if analysis.get("input_fingerprint") != document_fingerprint(documents):
        return False
    if analysis.get("manifest_complete") is not True:
        return False
    try:
        if int(analysis.get("failed_documents") or 0) != 0:
            return False
    except (TypeError, ValueError, OverflowError):
        return False
    if pending_document_urls(analysis, documents):
        return False

    document_urls = {document_url(document) for document in documents if document_url(document)}
    excluded_urls = set()
    for key in ("blocked_document_urls", "skipped_document_urls", "terminal_document_urls"):
        values = analysis.get(key)
        if not isinstance(values, list):
            return False
        excluded_urls.update(document_url(value) for value in values if document_url(value))
    expected_urls = document_urls - excluded_urls
    if not expected_urls:
        return bool(document_urls == excluded_urls) if document_urls else True

    entries = modern_progress_entries(analysis, documents)
    proof = analysis.get("cache_proof")
    proof_documents = proof.get("documents") if isinstance(proof, dict) else None
    if not isinstance(proof_documents, list):
        return False
    proof_by_url = {
        document_url(item): item
        for item in proof_documents
        if isinstance(item, dict) and document_url(item)
    }
    profiles = analysis.get("profiles")
    if not isinstance(profiles, list):
        return False
    profiles_by_url = {
        document_url(item): item
        for item in profiles
        if isinstance(item, dict) and document_url(item)
    }
    for url in expected_urls:
        entry = entries.get(url)
        proof_item = proof_by_url.get(url)
        profile = profiles_by_url.get(url)
        if not isinstance(entry, dict) or not isinstance(proof_item, dict) or not isinstance(profile, dict):
            return False
        if type(entry.get("text_chars")) is not int or type(proof_item.get("text_chars")) is not int:
            return False
        if type(profile.get("text_chars")) is not int:
            return False
        try:
            entry_text_chars = int(entry.get("text_chars") or 0)
            proof_text_chars = int(proof_item.get("text_chars") or 0)
        except (TypeError, ValueError, OverflowError):
            # A malformed persisted marker is evidence to reprocess, never a
            # reason for the completeness gate to raise during queue handling.
            return False
        if (
            entry.get("complete") is not True
            or entry.get("extraction_status") != "extracted"
            or entry.get("failed_pages")
            or entry.get("text_present") is not True
            or entry_text_chars <= 0
            or not is_sha256(entry.get("sha256"))
            or not is_sha256(entry.get("text_sha256"))
            or proof_item.get("complete") is not True
            or proof_item.get("extraction_status") != "extracted"
            or proof_item.get("failed_pages")
            or proof_item.get("text_present") is not True
            or proof_text_chars <= 0
            or not is_sha256(proof_item.get("sha256"))
            or not is_sha256(proof_item.get("text_sha256"))
            or clean_text(entry.get("sha256")) != clean_text(proof_item.get("sha256"))
            or clean_text(entry.get("text_sha256")) != clean_text(proof_item.get("text_sha256"))
            or profile.get("complete") is not True
            or profile.get("extraction_status") != "extracted"
            or profile.get("failed_pages")
            or clean_text(profile.get("sha256")) != clean_text(entry.get("sha256"))
        ):
            return False
    return True


def normalize_payload_for_cache(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return a writer-compatible modern payload, or ``None`` for legacy data."""
    if not is_modern_payload(payload):
        return None
    normalized = dict(payload)
    normalized["url"] = document_url(payload)
    normalized["text_sha256"] = clean_text(payload.get("text_sha256")) or payload_text_sha256(payload)
    normalized["text_chars"] = int(payload.get("text_chars") or len(clean_text(payload.get("text")) or ""))
    normalized.setdefault("label", "")
    normalized.setdefault("type", "pdf")
    normalized.setdefault("document_type", normalized.get("type") or "pdf")
    normalized.setdefault("file_path", None)
    normalized.setdefault("pages", [])
    normalized.setdefault("failed_pages", [])
    normalized.setdefault("blank_pages", [])
    normalized.setdefault("visual_blank_pages", [])
    return normalized


def merge_modern_payloads(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
    *,
    documents: list[dict[str, Any]] | None = None,
    expected_hashes: dict[str, str] | None = None,
    allowed_previous_urls: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Merge by URL while refusing to downgrade a complete modern entry."""
    document_hashes = {
        document_url(document): clean_text(document.get("sha256"))
        for document in documents or []
        if isinstance(document, dict) and document_url(document)
    }
    if expected_hashes:
        document_hashes.update(
            {url: clean_text(value) for url, value in expected_hashes.items() if url and clean_text(value)}
        )

    def _accept(payload: dict[str, Any]) -> dict[str, Any] | None:
        normalized = normalize_payload_for_cache(payload)
        if normalized is None:
            return None
        url = document_url(normalized)
        if documents is not None:
            expected_hash = document_hashes.get(url)
            if url not in {document_url(document) for document in documents if document_url(document)} or (
                expected_hash and normalized.get("sha256") != expected_hash
            ):
                return None
        return normalized

    merged: dict[str, dict[str, Any]] = {}
    for payload in previous:
        normalized = _accept(payload)
        if normalized is not None and (
            allowed_previous_urls is None or document_url(normalized) in allowed_previous_urls
        ):
            merged[document_url(normalized)] = normalized
    for payload in current:
        normalized = _accept(payload)
        if normalized is None:
            continue
        url = document_url(normalized)
        old = merged.get(url)
        if old is not None and old.get("sha256") == normalized.get("sha256"):
            old_complete = old.get("complete") is True and old.get("extraction_status") in {"extracted", "empty"}
            new_complete = normalized.get("complete") is True and normalized.get("extraction_status") in {"extracted", "empty"}
            if old_complete and not new_complete:
                continue
        merged[url] = normalized
    return [merged[url] for url in sorted(merged)]


def merge_pdf_cache(
    path: Path,
    current: list[dict[str, Any]],
    *,
    analysis: object,
    documents: list[dict[str, Any]],
    downloaded_documents: list[dict[str, Any]] | None = None,
    blocked_document_urls: list[str] | None = None,
    permanent_document_failures: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Merge a bounded extraction pass with its proven aggregate cache."""

    previous = read_modern_cache(path) if path.exists() else []
    previous_progress = modern_progress_entries(analysis, documents)
    expected_hashes = {
        url: str(entry.get("sha256"))
        for url, entry in previous_progress.items()
        if entry.get("sha256")
    }
    expected_hashes.update(
        {
            url: str(document.get("sha256"))
            for document in downloaded_documents or current
            if (url := document_url(document)) and document.get("sha256")
        }
    )
    invalidated_urls = {
        document_url(url)
        for url in blocked_document_urls or []
        if document_url(url)
    }
    invalidated_urls.update(
        document_url(item.get("url"))
        for item in permanent_document_failures or []
        if isinstance(item, dict) and document_url(item.get("url"))
    )
    return merge_modern_payloads(
        previous,
        [payload for payload in current if document_url(payload) not in invalidated_urls],
        documents=documents,
        expected_hashes=expected_hashes,
        allowed_previous_urls=set(previous_progress) - invalidated_urls,
    )


def read_modern_cache(path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, UnicodeError, ValueError, json.JSONDecodeError):
        return []
    if isinstance(payload, dict):
        payload = [payload]
    if not isinstance(payload, list):
        return []
    return [normalized for item in payload if isinstance(item, dict) and (normalized := normalize_payload_for_cache(item)) is not None]
