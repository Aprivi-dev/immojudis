from __future__ import annotations

# ruff: noqa: I001

import hashlib
import importlib
import json
import logging
import subprocess
import sys
import tempfile
import time
import unicodedata
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse, urlsplit, urlunsplit

import fitz
import httpx

from src.config import DOCLING_TEXTS_DIR, DOCUMENTS_DIR, PDF_DOCUMENT_TEXTS_DIR, PDF_TEXTS_DIR, load_settings
from src.document_politeness import (
    DocumentPoliteness,
    DocumentRobotsDisallowed,
    fetch_robots_document,
    pause_within_deadline,
)
from src.freshness import invalidate_analysis, timestamp_is_fresh
from src.models import AuctionSale
from src.normalize import (
    clean_text,
    normalize_sale,
)
from src.pdf_document_transport import (  # noqa: F401
    PublicDocumentTarget,  # noqa: F401
    _PinnedHTTPTransport,
    _PinnedNetworkBackend,  # noqa: F401
    EncheresPubliquesAccessNotAuthorized,
    require_encheres_publiques_documents_access as require_ep_documents,
    require_encheres_publiques_url_access as require_ep_url,
)
from src.pdf_document_transport import (
    is_safe_public_document_url as _is_safe_public_document_url,  # noqa: F401
)
from src.pdf_document_transport import (
    resolve_public_document_target as _resolve_public_document_target,
)
from src.pdf_document_types import (
    DEFAULT_DOCUMENT_GROUPS,  # noqa: F401
    DOCUMENT_TYPE_ALIASES,  # noqa: F401
    GENERIC_DOCUMENT_TYPES,  # noqa: F401
    PDF_ANNOUNCE_GROUP,  # noqa: F401
    PDF_BAIL_GROUP,  # noqa: F401
    PDF_CADASTRE_GROUP,  # noqa: F401
    PDF_CONDITIONS_GROUP,  # noqa: F401
    PDF_DESCRIPTION_GROUP,  # noqa: F401
    PDF_DIAGNOSTICS_GROUP,  # noqa: F401
    _canonical_document_type,  # noqa: F401
    _normalize_document_classifier_text,  # noqa: F401
    classify_document_type,  # noqa: F401
)
from src.pdf_failure_diagnostics import format_pdf_failure_diagnostics, pdf_extraction_exception_marker
from src.pdf_ocr import (
    PdfDeadlineExceeded,
    PdfDocumentOcrBudgetExceeded,
    PdfExtractionDeferred,
    _PDF_DOCUMENT_OCR_DEADLINE,  # noqa: F401
    _PDF_DOCUMENT_LOG_TYPES,  # noqa: F401
    deadline_bounded_timeout as _deadline_bounded_timeout_impl,
    ensure_pdf_document_ocr_budget as _ensure_pdf_document_ocr_budget,
    ensure_pdf_ocr_deadline as _ensure_pdf_ocr_deadline_impl,
    extract_page_text_with_ocr_result as _extract_page_text_with_ocr_result_impl,
    log_pdf_document_transition as _log_pdf_document_transition,
    pdf_document_ocr_budget_remaining,  # noqa: F401
    pdf_document_ocr_budget_scope,
    pdf_ocr_document_budget_seconds as _pdf_ocr_document_budget_seconds,
    select_pdf_deadline_exception as _select_pdf_deadline_exception,
)
from src.pdf_page_analysis import (
    VISUAL_BLANK_INK_RATIO_MAX,  # noqa: F401
    VISUAL_BLANK_INK_THRESHOLD,  # noqa: F401
    VISUAL_BLANK_RENDER_MAX_DIMENSION,  # noqa: F401
    _is_objectively_blank_page,
    _page_has_substantial_image,
    _page_requires_retry,
    _page_text_confidence,
    _visual_page_profile,
)
from src.pdf_page_analysis import (
    is_decorative_edge_only_page as _is_decorative_edge_only_page,  # noqa: F401
)
from src.pdf_word_documents import extract_docx_document, extract_legacy_word_document
from src.pdf_progress import PDF_TEXT_CACHE_VERSION, checkpoint_partial_pdf_progress, merge_pdf_cache, restore_pdf_page_caches_from_manifest, stale_complete_document_urls
from src.pdf_fact_scope import _clear_pdf_derived_source_description, _clear_pdf_fact_projections

LOGGER = logging.getLogger(__name__)

DOCUMENT_REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}

MAX_DOCUMENT_REDIRECTS = 5

# Deterministic PDF facts include page/document candidates and multi-lot
# decisions; bump this marker when projection semantics change.
DOCUMENT_FACTS_VERSION = "document_facts_v3_pdf_scope_diagnostics"

# Keep a fixed margin for queue finalization after a bounded PDF pass.
PDF_FINALIZATION_MARGIN_SECONDS = 60.0

_PDF_DEADLINE: ContextVar[float | None] = ContextVar("pdf_enrichment_deadline", default=None)


@dataclass
class PdfEnrichmentStats:
    downloaded: int = 0
    errors: int = 0
    raw_text_enriched: int = 0
    document_cache_hits: int = 0
    document_cache_misses: int = 0
    documents_processed: int = 0
    blocked_document_urls: list[str] = field(default_factory=list)
    permanent_document_failures: list[dict[str, str]] = field(default_factory=list)


class PermanentDocumentFailure(ValueError):
    """A document URL is known not to be usable by the PDF extractor."""

    def __init__(self, reason: str, message: str | None = None) -> None:
        super().__init__(message or reason)
        self.reason = reason


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


def _pdf_deadline_exception(message: str, **kwargs: int) -> BaseException:
    return _select_pdf_deadline_exception(message, worker_remaining=pdf_deadline_remaining(), **kwargs)


def _ensure_pdf_deadline(
    *,
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> float | None:
    remaining = pdf_deadline_remaining()
    if remaining is not None and remaining <= 0:
        raise PdfDeadlineExceeded(
            f"PDF worker deadline reached during {operation}; retry resumes from checkpoint",
            checkpointed_pages=checkpointed_pages,
            total_pages=total_pages,
            new_progress_pages=new_progress_pages,
        )
    return remaining


def _ensure_pdf_ocr_deadline(
    *,
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> float | None:
    return _ensure_pdf_ocr_deadline_impl(
        worker_deadline=_ensure_pdf_deadline,
        operation=operation,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )


def _deadline_bounded_timeout(
    timeout_seconds: float,
    *,
    operation: str,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> tuple[float, bool]:
    return _deadline_bounded_timeout_impl(
        timeout_seconds,
        ensure_deadline=_ensure_pdf_ocr_deadline,
        operation=operation,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )


def enrich_sale_from_pdfs(sale: AuctionSale) -> PdfEnrichmentStats:
    stats = PdfEnrichmentStats()
    _ensure_pdf_deadline(operation="starting document download")
    downloaded_documents = download_documents(sale, stats=stats)
    restore_pdf_page_caches_from_manifest(PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json", downloaded_documents, cache_root=PDF_DOCUMENT_TEXTS_DIR, ocr_enabled=bool(load_settings()["pdf_ocr_enabled"]), ocr_language=str(load_settings()["pdf_ocr_language"]))
    _invalidate_replaced_document_facts(sale, downloaded_documents)
    pdf_texts: list[dict[str, object]] = []
    failed_document_diagnostics: list[dict[str, object]] = []
    for document in _select_documents_for_extraction(downloaded_documents, sale=sale, revalidate_urls={str(item.get("url") or "") for item in downloaded_documents}):
        _ensure_pdf_deadline(operation="starting document extraction")
        document_started_at = time.monotonic()
        file_path = Path(document["file_path"])
        try:
            cached_payload = (
                _read_document_text_cache(document, file_path) if load_settings()["incremental_enrichment"] else None
            )
            if cached_payload:
                stats.document_cache_hits += 1
                pdf_texts.append(cached_payload)
                _log_pdf_document_transition(
                    document,
                    status="cache_hit",
                    started_at=document_started_at,
                    pages=int(cached_payload.get("page_count") or 0),
                )
                continue
            stats.document_cache_misses += 1
            payload = extract_attached_document(file_path, document=document)
        except PdfExtractionDeferred as exc:
            _log_pdf_document_transition(
                document,
                status="deferred",
                started_at=document_started_at,
                pages=exc.checkpointed_pages,
                error_type=type(exc).__name__,
            )
            checkpoint_partial_pdf_progress(file_path, document, error=exc, total_pages=exc.total_pages, cache_root=PDF_DOCUMENT_TEXTS_DIR, manifest_path=PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json", current_texts=pdf_texts, sale=sale, analysis=sale.raw_payload.get("document_analysis"), documents=sale.documents, downloaded_documents=downloaded_documents, ocr_enabled=bool(load_settings()["pdf_ocr_enabled"]), ocr_language=str(load_settings()["pdf_ocr_language"]), merge_cache=merge_pdf_cache, write_cache=_write_pdf_text_cache, store_status=_store_document_analysis_status)
            raise
        except Exception as exc:
            _log_pdf_document_transition(
                document,
                status="failed",
                started_at=document_started_at,
                error_type=type(exc).__name__,
            )
            marker = pdf_extraction_exception_marker(document.get("url"), type(exc).__name__)
            LOGGER.warning("PDF text extraction failed for %s: %s", file_path, format_pdf_failure_diagnostics(marker))
            failed_document_diagnostics.append(marker)
            stats.errors += 1
            continue
        payload.update(
            {
                "label": document.get("label", ""),
                "url": document.get("url", ""),
                "type": document.get("type", "pdf"),
                "document_type": _canonical_document_type(
                    document.get("document_type") or document.get("type"),
                    label=document.get("label"),
                    url=document.get("url"),
                ),
                "file_path": str(file_path),
            }
        )
        if payload.get("complete") is False or str(payload.get("extraction_status") or "").lower() in {
            "incomplete",
            "failed",
        }:
            # Keep the partial payload and its successful-page provenance for
            # the next pass, while making the run visibly incomplete to queue
            # and quality callers.
            stats.errors += 1
        _write_document_text_cache(document, file_path, payload)
        stats.documents_processed += 1
        pdf_texts.append(payload)
        _log_pdf_document_transition(
            document,
            status=("completed" if payload.get("complete") is not False and str(payload.get("extraction_status") or "").lower() not in {"incomplete", "failed"} else "incomplete"),
            started_at=document_started_at,
            pages=int(payload.get("page_count") or 0),
        )
    merged_pdf_texts = merge_pdf_cache(PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json", pdf_texts, analysis=sale.raw_payload.get("document_analysis"), documents=sale.documents, downloaded_documents=downloaded_documents, blocked_document_urls=stats.blocked_document_urls, permanent_document_failures=stats.permanent_document_failures)
    if merged_pdf_texts or stats.blocked_document_urls or stats.permanent_document_failures:
        _write_pdf_text_cache(sale, merged_pdf_texts)
        terminal_urls = set(stats.blocked_document_urls) | {
            item.get("url") for item in stats.permanent_document_failures if item.get("url")
        }
        if terminal_urls:
            # Revoke a terminal piece even when another PDF remains readable.
            # Unbound projections may depend on the revoked text; rebuild them
            # from the retained texts. Explicit proofs from other URLs survive.
            sale.raw_text = clean_text((sale.raw_text or "").split("--- PDF TEXT ENRICHMENT ---", 1)[0])
            declared_urls = {item.get("url") for item in sale.documents if item.get("url")}
            if declared_urls and declared_urls.issubset(terminal_urls):
                _clear_pdf_fact_projections(sale)
            else:
                traces = sale.raw_payload.get("pdf_fact_provenance") or {}
                if not isinstance(traces, dict):
                    traces = {}
                affected = {
                    key for key, trace in traces.items()
                    if isinstance(trace, dict)
                    and (not trace.get("document_url") or trace.get("document_url") in terminal_urls)
                }
                if "surface_m2" in affected:
                    affected.update({"app_surface_m2", "app_surface_kind"})
                _clear_pdf_fact_projections(sale, fields=affected)
                _clear_pdf_derived_source_description(sale, None)
            invalidate_analysis(sale.raw_payload, "document_access_changed")
        before = sale.raw_text or ""
        enrich_sale_from_pdf_text(sale, merged_pdf_texts)
        if len(sale.raw_text or "") > len(before):
            stats.raw_text_enriched += 1
    _store_document_analysis_status(
        sale,
        downloaded_documents,
        pdf_texts,
        merged_pdf_texts=merged_pdf_texts,
        blocked_document_urls=stats.blocked_document_urls,
        permanent_document_failures=stats.permanent_document_failures,
        failed_document_diagnostics=failed_document_diagnostics,
    )
    return stats


def _invalidate_replaced_document_facts(sale: AuctionSale, documents: list[dict]) -> None:
    previous = sale.raw_payload.get("document_analysis") or {}
    hashes = {profile.get("url"): profile.get("sha256") for profile in previous.get("profiles", [])}
    changed = any(hashes.get(doc.get("url")) and doc.get("sha256")
                  and hashes[doc.get("url")] != doc["sha256"] for doc in documents)
    # A failed download or a bounded pass does not prove that a source removed
    # a piece. Only the complete source manifest can establish that absence.
    current_urls = {doc.get("url") for doc in sale.documents if isinstance(doc, dict) and doc.get("url")}
    removed = sale.raw_payload.get("source_detail_status") == "complete" and bool(set(hashes) - current_urls)
    if not changed and not removed:
        return
    built_pdf = sale.surface_source == "pdf" or (sale.raw_payload.get("surface_extraction") or {}).get("source") == "pdf"
    land_pdf = (sale.raw_payload.get("land_surface_extraction") or {}).get("source") == "pdf"
    projection_state = _clear_pdf_fact_projections(sale)
    preserved_projection_fields = projection_state.get("preserved", set())
    invalidate_analysis(sale.raw_payload, "document_manifest_changed" if removed else "document_bytes_changed")
    sale.raw_payload["superseded_document_analysis"] = previous
    snapshot = sale.raw_payload.get("source_factual_snapshot") or {
        "source_name": sale.source_name, "source_url": sale.source_url,
    }
    factual = normalize_sale(snapshot)
    fields = []
    if built_pdf:
        fields += [
            field
            for field in (
                "surface_m2", "habitable_surface_m2", "carrez_surface_m2", "app_surface_m2",
                "app_surface_kind", "surface_scope", "surface_source", "surface_confidence", "surface_evidence",
            )
            if field not in preserved_projection_fields
        ]
    if land_pdf:
        if "land_surface_m2" not in preserved_projection_fields:
            fields += ["land_surface_m2"]
    if sale.raw_payload.get("starting_price_extraction"):
        if "starting_price_eur" not in preserved_projection_fields:
            fields += ["starting_price_eur"]
    if sale.raw_payload.get("pdf_sale_date_extraction"):
        if "sale_date" not in preserved_projection_fields:
            fields += ["sale_date"]
    if sale.raw_payload.get("pdf_visit_dates_extraction"):
        if "visit_dates" not in preserved_projection_fields:
            fields += ["visit_dates"]
    for key in fields:
        setattr(sale, key, getattr(factual, key))
        sale.raw_payload.pop(key, None)
    for key in (
        "surface_extraction",
        "surface_analysis",
        "land_surface_extraction",
        "starting_price_extraction",
        "pdf_sale_date_extraction",
        "pdf_energy_diagnostics",
        "pdf_energy_diagnostics_candidates",
        "pdf_surface_candidates",
        "pdf_land_surface_candidates",
        "pdf_rooms_candidates",
        "pdf_bedrooms_candidates",
        "pdf_occupancy_candidates",
        "pdf_multi_lot_guard",
        "pdf_visit_dates_extraction",
        "pdf_fact_provenance",
    ):
        sale.raw_payload.pop(key, None)
    if "raw_text" in snapshot:
        sale.raw_text = clean_text(snapshot.get("raw_text"))
    else:
        sale.raw_text = clean_text((sale.raw_text or "").split("--- PDF TEXT ENRICHMENT ---", 1)[0])


def download_documents(
    sale: AuctionSale,
    output_root: Path = DOCUMENTS_DIR,
    stats: PdfEnrichmentStats | None = None,
) -> list[dict[str, str]]:
    settings = load_settings()
    require_ep_documents(sale.documents, settings)
    sale_id = _sale_storage_id(sale)
    sale_dir = output_root / sale_id
    sale_dir.mkdir(parents=True, exist_ok=True)

    headers = {
        "User-Agent": str(settings["user_agent"]),
        "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6",
        "Referer": sale.source_url,
    }
    downloaded: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for document in _select_documents_for_extraction(sale.documents, sale=sale, revalidate_urls=stale_complete_document_urls(sale.raw_payload.get("document_analysis"), sale.documents, sale_dir, _document_filename)):
        _ensure_pdf_deadline(operation="selecting document")
        url = document.get("url")
        document_type = _canonical_document_type(
            document.get("document_type") or document.get("type"),
            label=document.get("label"),
            url=url,
        )
        if not url or document_type == "other" or url in seen_urls:
            continue
        seen_urls.add(url)
        if _is_robots_disallowed_licitor_document(url):
            LOGGER.info("Skipping robots-disallowed Licitor document %s", url)
            if stats is not None:
                stats.blocked_document_urls.append(url)
            continue

        filename = _document_filename(document)
        file_path = sale_dir / filename
        if (
            file_path.exists()
            and _document_file_format(
                file_path.read_bytes(),
                url=url,
                content_type=None,
            )
            is None
        ):
            LOGGER.info("Discarding unsupported document cache entry %s", file_path)
            file_path.unlink(missing_ok=True)
        metadata_path = file_path.with_suffix(file_path.suffix + ".http.json")
        try:
            metadata = json.loads(metadata_path.read_text())
        except (OSError, ValueError):
            metadata = {}
        if (
            metadata.get("failure_class") == "permanent"
            and timestamp_is_fresh(metadata.get("checked_at"))
        ):
            reason = str(metadata.get("failure_reason") or "permanent_document_failure")
            LOGGER.info("Skipping cached permanently unusable document %s: %s", url, reason)
            if stats is not None:
                stats.permanent_document_failures.append({"url": url, "reason": reason})
            continue
        request_headers = dict(headers)
        if file_path.exists():
            if metadata.get("etag"):
                request_headers["If-None-Match"] = metadata["etag"]
            if metadata.get("last_modified"):
                request_headers["If-Modified-Since"] = metadata["last_modified"]
        if not file_path.exists() or not timestamp_is_fresh(metadata.get("checked_at")):
            download_error: Exception | None = None
            permanent_failures: list[PermanentDocumentFailure] = []
            try:
                for candidate_url in _document_url_variants(url):
                    _ensure_pdf_deadline(operation="starting document request")
                    try:
                        response = _download_document_response(
                            candidate_url,
                            headers=request_headers,
                            timeout_seconds=float(settings["request_timeout_seconds"]),
                        )
                        status_code = int(getattr(response, "status_code", 200))
                        if status_code == 304 and file_path.exists():
                            metadata["checked_at"] = datetime.now(UTC).isoformat()
                            metadata_path.write_text(json.dumps(metadata))
                            download_error = None
                            break
                        if status_code in {401, 403}:
                            raise PermanentDocumentFailure(
                                "access_denied",
                                f"document endpoint returned HTTP {status_code}",
                            )
                        if status_code in {404, 410}:
                            raise PermanentDocumentFailure(
                                "not_found",
                                f"document endpoint returned HTTP {status_code}",
                            )
                        response.raise_for_status()
                        response_headers = getattr(response, "headers", {})
                        content_type = response_headers.get("content-type", "")
                        content = _bounded_document_content(
                            response,
                            max_bytes=int(settings["pdf_max_download_mb"]) * 1024 * 1024,
                        )
                        file_format = _document_file_format(
                            content,
                            url=candidate_url,
                            content_type=content_type,
                        )
                        if file_format is None:
                            raise PermanentDocumentFailure(
                                "unsupported_response",
                                "response is not a supported document "
                                f"(content-type={content_type or 'unknown'})",
                            )
                    except (PdfDeadlineExceeded, EncheresPubliquesAccessNotAuthorized):
                        raise
                    except PermanentDocumentFailure as exc:
                        permanent_failures.append(exc)
                        download_error = exc
                        continue
                    except Exception as exc:
                        download_error = exc
                        continue
                    if candidate_url != url:
                        LOGGER.info("PDF URL Unicode variant succeeded for %s", url)
                    if file_path.exists():
                        previous = file_path.read_bytes()
                        if previous != content:
                            invalidate_analysis(sale.raw_payload, "document_bytes_changed")
                            archive = sale_dir / "versions"
                            archive.mkdir(exist_ok=True)
                            (archive / (hashlib.sha256(previous).hexdigest() + file_path.suffix)).write_bytes(previous)
                    temporary = file_path.with_suffix(file_path.suffix + ".tmp")
                    temporary.write_bytes(content)
                    temporary.replace(file_path)
                    metadata = {
                        "checked_at": datetime.now(UTC).isoformat(),
                        "etag": response_headers.get("etag"),
                        "last_modified": response_headers.get("last-modified"),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                    metadata_path.write_text(json.dumps(metadata))
                    if stats:
                        stats.downloaded += 1
                    download_error = None
                    break
            except (PdfDeadlineExceeded, EncheresPubliquesAccessNotAuthorized):
                raise
            except Exception as exc:
                download_error = exc
            if download_error is not None:
                variants = _document_url_variants(url)
                if permanent_failures and len(permanent_failures) == len(variants):
                    reason = permanent_failures[-1].reason
                    LOGGER.info("Skipping permanently unusable document %s: %s", url, reason)
                    metadata_path.write_text(
                        json.dumps(
                            {
                                "checked_at": datetime.now(UTC).isoformat(),
                                "failure_class": "permanent",
                                "failure_reason": reason,
                            }
                        )
                    )
                    if stats is not None:
                        stats.permanent_document_failures.append({"url": url, "reason": reason})
                else:
                    LOGGER.warning("PDF download failed for %s: %s", url, download_error)
                    if stats:
                        stats.errors += 1
                continue
        _ensure_pdf_deadline(operation="finalizing downloaded document")
        enriched_document = dict(document)
        file_format = (
            _document_file_format(
                file_path.read_bytes(),
                url=url,
                content_type=None,
            )
            or "unknown"
        )
        enriched_document["type"] = file_format
        enriched_document["file_format"] = file_format
        enriched_document["document_type"] = document_type
        enriched_document["file_path"] = str(file_path)
        enriched_document["sha256"] = hashlib.sha256(file_path.read_bytes()).hexdigest()
        enriched_document["http_checked_at"] = str(metadata.get("checked_at") or "")
        document["sha256"] = enriched_document["sha256"]
        downloaded.append(enriched_document)
    return downloaded


def _looks_like_pdf_bytes(content: bytes) -> bool:
    return b"%PDF-" in content[:1024]


def _bounded_document_content(response: object, *, max_bytes: int) -> bytes:
    headers = getattr(response, "headers", {}) or {}
    raw_length = headers.get("content-length") if hasattr(headers, "get") else None
    if raw_length:
        try:
            if int(raw_length) > max_bytes:
                raise ValueError(f"document exceeds the {max_bytes}-byte download limit")
        except ValueError as exc:
            if "exceeds" in str(exc):
                raise
    content = bytes(getattr(response, "content", b""))
    if len(content) > max_bytes:
        raise ValueError(f"document exceeds the {max_bytes}-byte download limit")
    return content


def _document_file_format(content: bytes, *, url: str, content_type: str | None) -> str | None:
    if _looks_like_pdf_bytes(content):
        return "pdf"
    suffix = Path(urlparse(url).path).suffix.lower()
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    if content.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") and (
        suffix == ".doc" or normalized_content_type == "application/msword"
    ):
        return "doc"
    if content.startswith(b"PK\x03\x04") and (
        suffix == ".docx"
        or normalized_content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        return "docx"
    return None


def _document_url_variants(url: str) -> list[str]:
    variants = [url]
    for form in ("NFC", "NFD"):
        normalized = _normalize_document_url(url, form=form)
        if normalized not in variants:
            variants.append(normalized)
    return variants


def _normalize_document_url(url: str, *, form: str) -> str:
    parsed = urlsplit(url)
    safe_segment_chars = ":@-._~!$&'()*+,;="
    normalized_segments = [
        quote(unicodedata.normalize(form, unquote(segment)), safe=safe_segment_chars)
        for segment in parsed.path.split("/")
    ]
    normalized_query = unicodedata.normalize(form, parsed.query)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            "/".join(normalized_segments),
            normalized_query,
            parsed.fragment,
        )
    )


def _is_robots_disallowed_licitor_document(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {"www.licitor.com", "licitor.com"}:
        return False
    path = parsed.path
    return path.startswith("/data/pub/doc/") or path.startswith("/data/pub/media/")


def _download_document_response(
    url: str,
    *,
    headers: dict[str, str],
    timeout_seconds: float,
) -> httpx.Response:
    _ensure_pdf_deadline(operation="starting document redirect chain")
    current_url = url
    for redirect_count in range(MAX_DOCUMENT_REDIRECTS + 1):
        require_ep_url(current_url, load_settings())
        _ensure_pdf_deadline(operation="following document redirect")
        try:
            # robots.txt and the per-host delay apply to every hop, including
            # redirects to another origin.
            _DOCUMENT_POLITENESS.wait_turn(current_url)
        except DocumentRobotsDisallowed as exc:
            raise PermanentDocumentFailure("robots_disallowed", str(exc)) from exc
        _ensure_pdf_deadline(operation="starting document HTTP request")
        response = _send_pinned_document_request(
            current_url,
            headers=headers,
            timeout_seconds=timeout_seconds,
        )
        status_code = int(getattr(response, "status_code", 200))
        if status_code not in DOCUMENT_REDIRECT_STATUS_CODES:
            return response
        if redirect_count >= MAX_DOCUMENT_REDIRECTS:
            raise ValueError(f"too many document redirects: {url}")
        location = response.headers.get("location")
        if not location:
            return response
        current_url = urljoin(current_url, location)
    raise ValueError(f"too many document redirects: {url}")


def _send_pinned_document_request(
    url: str,
    *,
    headers: dict[str, str],
    timeout_seconds: float,
) -> httpx.Response:
    requested_timeout = float(timeout_seconds)
    _ensure_pdf_deadline(operation="starting document HTTP request")
    require_ep_url(url, load_settings())
    target = _resolve_public_document_target(url)
    timeout_seconds, deadline_bounded = _deadline_bounded_timeout(
        requested_timeout,
        operation="connecting to document host",
    )
    transport = _PinnedHTTPTransport(target)
    try:
        with httpx.Client(
            transport=transport,
            follow_redirects=False,
            timeout=timeout_seconds,
            trust_env=False,
        ) as client:
            with client.stream("GET", target.url, headers=headers) as response:
                content = _read_document_stream(response, int(load_settings()["pdf_max_download_mb"]) * 1024 * 1024)
                _ensure_pdf_deadline(operation="reading document response")
                response_headers = dict(response.headers)
                response_headers.pop("content-encoding", None)
                response_headers["content-length"] = str(len(content))
                return httpx.Response(response.status_code, headers=response_headers, content=content, request=response.request)
    except httpx.TimeoutException as exc:
        if deadline_bounded:
            raise PdfDeadlineExceeded(
                "PDF worker deadline reached during document download; retry resumes",
                checkpointed_pages=0,
                total_pages=0,
                new_progress_pages=0,
            ) from exc
        raise


def _fetch_document_robots(robots_url: str) -> httpx.Response:
    return fetch_robots_document(robots_url, send=_send_pinned_document_request, settings=load_settings())


def _document_pause(seconds: float) -> None:
    pause_within_deadline(seconds, lambda: _ensure_pdf_deadline(operation="waiting between document requests"))


_DOCUMENT_POLITENESS = DocumentPoliteness(
    user_agent=lambda: str(load_settings()["user_agent"]),
    fetch_robots=_fetch_document_robots,
    sleep=_document_pause,
)


def _read_document_stream(response: httpx.Response, max_bytes: int) -> bytes:
    parts = []
    size = 0
    chunks = iter(response.iter_bytes(chunk_size=64 * 1024))
    while True:
        # A healthy peer can keep a read stream alive indefinitely by sending
        # small chunks.  The transport's read timeout is therefore not enough
        # to enforce the worker cutoff; check the task-local deadline between
        # every chunk as well.
        _ensure_pdf_deadline(operation="reading document chunk")
        try:
            chunk = next(chunks)
        except StopIteration:
            break
        _ensure_pdf_deadline(operation="received document chunk")
        size += len(chunk)
        if size > max_bytes:
            raise ValueError(f"document exceeds the {max_bytes}-byte download limit")
        parts.append(chunk)
    return b"".join(parts)


def extract_attached_document(
    file: str | Path,
    document: dict[str, str] | None = None,
) -> dict[str, object]:
    path = Path(file)
    file_format = str((document or {}).get("file_format") or path.suffix.lstrip(".")).lower()
    if file_format == "pdf":
        return extract_pdf_document(path, document=document)
    if file_format == "doc":
        return extract_legacy_word_document(path)
    if file_format == "docx":
        return extract_docx_document(path)
    raise ValueError(f"unsupported attached document format: {file_format or 'unknown'}")


def extract_pdf_text(file: str | Path, document: dict[str, str] | None = None) -> str:
    return str(extract_pdf_document(file, document=document).get("text") or "")


def extract_pdf_document(file: str | Path, document: dict[str, str] | None = None) -> dict[str, object]:
    path = Path(file)
    _ensure_pdf_deadline(operation="opening PDF document")
    settings = load_settings()
    max_bytes = int(settings["pdf_max_download_mb"]) * 1024 * 1024
    if path.stat().st_size > max_bytes:
        raise ValueError(f"document exceeds the {max_bytes}-byte extraction limit")
    pages = extract_pdf_pages(path)
    page_text = clean_text("\n".join(str(page["text"]) for page in pages if page.get("text"))) or ""
    text = page_text
    extraction_method = "pymupdf_pages"
    docling_text = ""
    if str(settings["pdf_extractor"]) == "docling":
        _ensure_pdf_deadline(operation="starting Docling extraction")
        timeout = _adaptive_docling_timeout(path, document=document, settings=settings)
        _ensure_pdf_deadline(operation="starting bounded Docling extraction")
        docling_text = extract_pdf_text_with_docling(path, timeout_seconds=timeout)
        if docling_text:
            extraction_method = "docling"
            if len(docling_text) >= len(page_text):
                text = docling_text
        else:
            LOGGER.warning("Docling returned no text for %s; falling back to PyMuPDF/Tesseract", path)
    if (
        settings["pdf_docling_enabled"]
        and str(settings["pdf_extractor"]) == "auto"
        and len(text) < int(settings["pdf_docling_threshold_chars"])
    ):
        _ensure_pdf_deadline(operation="starting automatic Docling extraction")
        docling_text = extract_pdf_text_with_docling(path)
        if len(docling_text) > len(text):
            text = docling_text
            extraction_method = "docling_auto"

    _ensure_pdf_deadline(operation="finalizing PDF document")
    sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    failed_pages = [
        int(page["page"])
        for page in pages
        if _page_requires_retry(page, ocr_enabled=bool(settings["pdf_ocr_enabled"]))
    ]
    blank_pages = [
        int(page["page"])
        for page in pages
        if str(page.get("status") or page.get("extraction_status") or "")
        in {"blank_excluded", "blank_page_excluded", "visual_blank_excluded"}
    ]
    visual_blank_pages = [
        int(page["page"])
        for page in pages
        if str(page.get("status") or page.get("extraction_status") or "") == "visual_blank_excluded"
    ]
    page_confidences = [
        float(page.get("confidence") or 0)
        for page in pages
        if page.get("text")
        and not _page_requires_retry(page, ocr_enabled=bool(settings["pdf_ocr_enabled"]))
    ]
    confidence = round(sum(page_confidences) / len(page_confidences), 3) if page_confidences else 0.0
    return {
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "text": text,
        "pages": pages,
        "sha256": sha256,
        "page_count": len(pages),
        "text_chars": len(text),
        "page_text_chars": len(page_text),
        "ocr_pages": sum(1 for page in pages if str(page.get("method") or "").startswith("ocr_")),
        "empty_pages": sum(1 for page in pages if not clean_text(page.get("text"))),
        "blank_pages": blank_pages,
        "visual_blank_pages": visual_blank_pages,
        "failed_pages": failed_pages,
        "complete": not failed_pages,
        "extraction_status": "extracted" if not failed_pages else "incomplete",
        "extraction_method": extraction_method,
        "confidence": confidence,
    }


def extract_pdf_text_with_docling(file: str | Path, timeout_seconds: float | None = None) -> str:
    path = Path(file)
    remaining = _ensure_pdf_deadline(operation="reading Docling cache")
    cached = _read_docling_cache(path)
    if cached is not None:
        return cached
    settings = load_settings()
    timeout = float(timeout_seconds if timeout_seconds is not None else settings["pdf_docling_timeout_seconds"] or 0)
    if remaining is not None:
        if timeout <= 0:
            timeout = remaining
        else:
            timeout = min(timeout, remaining)
    if timeout > 0:
        text = _extract_pdf_text_with_docling_subprocess(path, timeout)
        if text:
            _write_docling_cache(path, text)
        return text
    text = _extract_pdf_text_with_docling_direct(path)
    if text:
        _write_docling_cache(path, text)
    return text


def _extract_pdf_text_with_docling_direct(path: Path) -> str:
    try:
        _ensure_docling_available()
    except PdfDeadlineExceeded:
        raise
    except Exception as exc:
        LOGGER.warning("Docling is unavailable: %s", exc)
        return ""
    try:
        settings = load_settings()
        profile = _profile_pdf_for_docling(path)
        do_ocr = _should_docling_ocr(path, settings, profile=profile)
        chunk_pages = _docling_chunk_pages(settings, do_ocr)
        if profile["page_count"] > chunk_pages:
            text = _extract_docling_pdf_in_chunks(path, do_ocr, profile, settings)
        else:
            converter = _build_docling_converter(do_ocr, settings)
            text = _convert_docling_pdf(converter, path)
    except PdfDeadlineExceeded:
        raise
    except Exception as exc:
        LOGGER.warning("Docling extraction failed for %s: %s", path, exc)
        return ""
    return text


def _ensure_docling_available() -> None:
    for module_name in (
        "docling.datamodel.base_models",
        "docling.datamodel.pipeline_options",
        "docling.document_converter",
    ):
        importlib.import_module(module_name)


def _build_docling_converter(do_ocr: bool, settings: dict[str, object]) -> object:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions(
        do_ocr=do_ocr,
        do_table_structure=False,
        document_timeout=float(settings["pdf_docling_timeout_seconds"] or 0) or None,
        force_backend_text=True,
        generate_page_images=False,
        generate_picture_images=False,
    )
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)})


def _convert_docling_pdf(converter: object, path: Path) -> str:
    result = converter.convert(str(path), raises_on_error=False)
    if not result.input.valid:
        LOGGER.warning("Docling rejected invalid PDF backend input for %s", path)
        return ""
    return clean_text(result.document.export_to_markdown()) or ""


def _extract_docling_pdf_in_chunks(
    path: Path,
    do_ocr: bool,
    profile: dict[str, float | int],
    settings: dict[str, object],
) -> str:
    chunk_pages = _docling_chunk_pages(settings, do_ocr)
    parts: list[str] = []
    converter = _build_docling_converter(do_ocr, settings)
    with tempfile.TemporaryDirectory(prefix="auction-docling-") as tmp_dir:
        tmp_root = Path(tmp_dir)
        for start in range(1, int(profile["page_count"]) + 1, chunk_pages):
            end = min(start + chunk_pages - 1, int(profile["page_count"]))
            chunk_path = _write_pdf_page_chunk(path, tmp_root, start, end)
            text = _convert_docling_pdf(converter, chunk_path)
            if text:
                parts.append(f"--- pages {start}-{end} ---\n{text}")
    return clean_text("\n\n".join(parts)) or ""


def _write_pdf_page_chunk(path: Path, output_dir: Path, start_page: int, end_page: int) -> Path:
    output_path = output_dir / f"{path.stem}-{start_page}-{end_page}.pdf"
    with fitz.open(path) as source, fitz.open() as chunk:
        chunk.insert_pdf(source, from_page=start_page - 1, to_page=end_page - 1)
        chunk.save(output_path, garbage=4, deflate=True, clean=True)
    return output_path


def _docling_chunk_pages(settings: dict[str, object], do_ocr: bool) -> int:
    key = "pdf_docling_ocr_chunk_pages" if do_ocr else "pdf_docling_chunk_pages"
    return max(1, int(settings[key]))


def _extract_pdf_text_with_docling_subprocess(path: Path, timeout: float) -> str:
    _ensure_pdf_deadline(operation="preparing Docling subprocess")
    DOCLING_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = _docling_cache_path(path).with_suffix(".tmp.txt")
    command = [sys.executable, "-m", "src.pdf_enrichment", "--docling-extract", str(path), str(output_path)]
    timeout, deadline_bounded = _deadline_bounded_timeout(
        timeout,
        operation="starting Docling subprocess",
    )
    try:
        result = subprocess.run(
            command,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        if deadline_bounded:
            raise PdfDeadlineExceeded(
                "PDF worker deadline reached during Docling extraction; retry resumes",
                checkpointed_pages=0,
                total_pages=0,
                new_progress_pages=0,
            ) from exc
        _ensure_pdf_deadline(operation="checking deadline after Docling timeout")
        LOGGER.warning("Docling extraction timed out after %.0fs for %s", timeout, path)
        return ""
    _ensure_pdf_deadline(operation="finishing Docling extraction")
    if result.returncode != 0:
        stderr = clean_text(result.stderr)[-1000:] if result.stderr else ""
        LOGGER.warning("Docling extraction subprocess failed for %s: %s", path, stderr)
        return ""
    if not output_path.exists():
        return ""
    text = clean_text(output_path.read_text(encoding="utf-8")) or ""
    output_path.unlink(missing_ok=True)
    return text


def extract_pdf_pages(file: str | Path) -> list[dict[str, object]]:
    pages: list[dict[str, object]] = []
    _ensure_pdf_deadline(operation="opening PDF pages")
    settings = load_settings()
    max_pages = int(settings["pdf_max_extract_pages"])
    hard_limit = int(settings.get("pdf_max_total_pages", 300))
    with pdf_document_ocr_budget_scope(_pdf_ocr_document_budget_seconds(settings)), fitz.open(file) as document:
        if document.page_count > hard_limit:
            raise ValueError(f"PDF exceeds the {hard_limit}-page safety limit")
        # Long text PDFs are inexpensive. Only OCR consumes the per-pass budget.
        cache_key = hashlib.sha256(Path(file).read_bytes() + str((settings["pdf_ocr_enabled"], settings["pdf_ocr_language"], PDF_TEXT_CACHE_VERSION)).encode()).hexdigest()
        cache_dir = PDF_DOCUMENT_TEXTS_DIR / "pages" / cache_key
        ocr_attempts = 0
        new_progress_pages = 0
        for index, page in enumerate(document, start=1):
            _ensure_pdf_deadline(
                operation=f"starting PDF page {index}",
                checkpointed_pages=index - 1,
                total_pages=document.page_count,
                new_progress_pages=new_progress_pages,
            )
            cache_path = cache_dir / f"{index}.json"
            if cache_path.exists():
                try:
                    cached = json.loads(cache_path.read_text(encoding="utf-8"))
                    if (
                        cached.get("page") == index
                        and isinstance(cached.get("text"), str)
                        and not _page_requires_retry(cached, ocr_enabled=bool(settings["pdf_ocr_enabled"]))
                    ):
                        pages.append(cached)
                        continue
                except (OSError, ValueError, AttributeError):
                    pass
            raw_text = page.get_text("text") or ""
            if _is_objectively_blank_page(page, raw_text):
                pages.append(
                    {
                        "page": index,
                        "text": "",
                        "chars": 0,
                        "raw_text_chars": 0,
                        "method": "blank_page",
                        "confidence": 1.0,
                        "status": "blank_excluded",
                        "retryable": False,
                    }
                )
                cache_dir.mkdir(parents=True, exist_ok=True)
                temporary = cache_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(pages[-1], ensure_ascii=False), encoding="utf-8")
                temporary.replace(cache_path)
                new_progress_pages += 1
                continue
            method = "pymupdf_text"
            confidence = _page_text_confidence(raw_text, method=method)
            text = raw_text
            status = "extracted" if clean_text(raw_text) else "failed"
            failure_reason = "empty_page_not_proven_blank" if not clean_text(raw_text) else None
            needs_ocr = _should_try_ocr(raw_text, page=page)
            if needs_ocr:
                _ensure_pdf_deadline(
                    operation=f"checking OCR budget for page {index}",
                    checkpointed_pages=index - 1,
                    total_pages=document.page_count,
                    new_progress_pages=new_progress_pages,
                )
                _ensure_pdf_document_ocr_budget(
                    operation=f"checking OCR budget for page {index}",
                    checkpointed_pages=index - 1,
                    total_pages=document.page_count,
                    new_progress_pages=new_progress_pages,
                )
                if ocr_attempts >= max_pages:
                    raise PdfExtractionDeferred(
                        f"OCR pass budget reached; {index - 1}/{document.page_count} pages checkpointed; retry resumes",
                        checkpointed_pages=index - 1,
                        total_pages=document.page_count,
                        new_progress_pages=new_progress_pages,
                    )
                ocr_attempts += 1
                result = _extract_page_text_with_ocr_result(
                    page,
                    fallback=raw_text,
                    checkpointed_pages=index - 1,
                    total_pages=document.page_count,
                    new_progress_pages=new_progress_pages,
                )
                text = str(result["text"])
                method = str(result["method"])
                confidence = float(result["confidence"])
            cleaned = clean_text(text) or ""
            visual_profile: dict[str, object] = {}
            original_status: str | None = None
            original_failure_reason: str | None = None
            if method == "fallback_text":
                status = "failed"
                failure_reason = "ocr_failed"
            elif cleaned:
                status = "extracted"
                failure_reason = None
            else:
                status = "failed"
                failure_reason = failure_reason or "empty_page_not_proven_blank"
            if status == "failed" and not cleaned and method == "fallback_text":
                visual_profile = _visual_page_profile(page)
                if visual_profile.get("quasi_empty") is True:
                    original_status = status
                    original_failure_reason = failure_reason
                    status = "visual_blank_excluded"
                    failure_reason = (
                        "decorative_edge_after_ocr"
                        if visual_profile.get("decorative_edge_only") is True
                        else "visual_blank_after_ocr"
                    )
            page_record: dict[str, object] = {
                "page": index,
                "text": cleaned,
                "chars": len(cleaned),
                "raw_text_chars": len(clean_text(raw_text) or ""),
                "method": method,
                "confidence": confidence,
                "status": status,
                "retryable": status == "failed",
                **({"failure_reason": failure_reason} if failure_reason else {}),
            }
            if visual_profile:
                page_record["visual_analysis"] = visual_profile
            if status == "visual_blank_excluded":
                # Keep the original failed OCR outcome alongside the explicit
                # exclusion. The PDF and its page number/hash remain the
                # source evidence; no rendered image replaces the original.
                page_record.update(
                    {
                        "visual_blank": True,
                        "source_page_preserved": True,
                        "original_status": original_status,
                        "original_failure_reason": original_failure_reason,
                        "original_method": method,
                    }
                )
            pages.append(page_record)
            cache_dir.mkdir(parents=True, exist_ok=True)
            temporary = cache_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(pages[-1], ensure_ascii=False), encoding="utf-8")
            temporary.replace(cache_path)
            if status in {"extracted", "visual_blank_excluded"}:
                new_progress_pages += 1
            _ensure_pdf_deadline(
                operation=f"checkpointing PDF page {index}",
                checkpointed_pages=index,
                total_pages=document.page_count,
                new_progress_pages=new_progress_pages,
            )
            if needs_ocr:
                _ensure_pdf_document_ocr_budget(
                    operation=f"checkpointing OCR page {index}",
                    checkpointed_pages=index,
                    total_pages=document.page_count,
                    new_progress_pages=new_progress_pages,
                )
    _ensure_pdf_deadline(
        operation="finishing PDF pages",
        checkpointed_pages=len(pages),
        total_pages=len(pages),
        new_progress_pages=new_progress_pages,
    )
    return pages


def _should_try_ocr(text: str, *, page: fitz.Page | None = None) -> bool:
    settings = load_settings()
    if not settings["pdf_ocr_enabled"]:
        return False
    if len(clean_text(text) or "") < 80:
        return True
    # Mixed PDFs often have a native header/footer over a scanned page. The
    # text-length gate alone would mark those pages complete and hide the
    # image-only body from fact extraction.
    return page is not None and _page_has_substantial_image(page)


def _extract_page_text_with_ocr(page: fitz.Page, fallback: str) -> str:
    return str(_extract_page_text_with_ocr_result(page, fallback=fallback)["text"])


def _extract_page_text_with_ocr_result(
    page: fitz.Page,
    fallback: str,
    *,
    checkpointed_pages: int = 0,
    total_pages: int = 0,
    new_progress_pages: int = 0,
) -> dict[str, object]:
    return _extract_page_text_with_ocr_result_impl(
        page,
        fallback,
        settings=load_settings(),
        ensure_deadline=_ensure_pdf_ocr_deadline,
        deadline_bounded_timeout=_deadline_bounded_timeout,
        page_text_confidence=_page_text_confidence,
        deadline_exception=PdfDeadlineExceeded,
        deadline_exceptions=(PdfDocumentOcrBudgetExceeded,),
        deadline_exception_factory=_pdf_deadline_exception,
        checkpointed_pages=checkpointed_pages,
        total_pages=total_pages,
        new_progress_pages=new_progress_pages,
    )


def _document_text_cache_path(document: dict[str, str], file_path: Path) -> Path:
    stat = file_path.stat()
    base = "|".join(
        [
            document.get("url", ""),
            str(stat.st_size),
            hashlib.sha256(file_path.read_bytes()).hexdigest(),
        ]
    )
    digest = hashlib.sha256(base.encode("utf-8")).hexdigest()[:24]
    return PDF_DOCUMENT_TEXTS_DIR / f"{digest}.json"


def _read_document_text_cache(document: dict[str, str], file_path: Path) -> dict[str, object] | None:
    try:
        path = _document_text_cache_path(document, file_path)
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not clean_text(payload.get("text")):
        return None
    if payload.get("cache_version") != PDF_TEXT_CACHE_VERSION:
        return None
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        return None
    if str(payload.get("extraction_status") or "").strip().lower() in {"incomplete", "failed"}:
        return None
    if any(
        _page_requires_retry(page, ocr_enabled=bool(load_settings()["pdf_ocr_enabled"]))
        for page in pages
    ):
        return None
    return payload


def _write_document_text_cache(document: dict[str, str], file_path: Path, payload: dict[str, object]) -> Path:
    PDF_DOCUMENT_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _document_text_cache_path(document, file_path)
    payload["cache_version"] = PDF_TEXT_CACHE_VERSION
    if not isinstance(payload.get("pages"), list) and clean_text(payload.get("text")):
        text = clean_text(payload.get("text")) or ""
        payload["pages"] = [
            {
                "page": 1,
                "text": text,
                "chars": len(text),
                "raw_text_chars": len(text),
                "method": "legacy_text",
                "confidence": _page_text_confidence(text, method="fallback_text"),
                "status": "extracted",
                "retryable": False,
            }
        ]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def sale_storage_id(sale: AuctionSale) -> str:
    base = sale.external_id or sale.source_url
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]


def _sale_storage_id(sale: AuctionSale) -> str:
    return sale_storage_id(sale)


def _docling_cache_path(file: Path) -> Path:
    try:
        digest = hashlib.sha256(file.read_bytes()).hexdigest()[:16]
    except OSError:
        digest = hashlib.sha256(str(file.resolve()).encode("utf-8")).hexdigest()[:16]
    return DOCLING_TEXTS_DIR / f"{digest}.txt"


def _read_docling_cache(file: Path) -> str | None:
    path = _docling_cache_path(file)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _write_docling_cache(file: Path, text: str) -> Path:
    DOCLING_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _docling_cache_path(file)
    path.write_text(text, encoding="utf-8")
    return path


def _should_docling_ocr(
    path: Path,
    settings: dict[str, object],
    profile: dict[str, float | int] | None = None,
) -> bool:
    mode = str(settings.get("pdf_docling_ocr_mode") or "auto").lower()
    if mode in {"0", "false", "no", "off", "never"}:
        return False
    if mode in {"1", "true", "yes", "on", "always"}:
        return True
    profile = profile or _profile_pdf_for_docling(path)
    if profile["page_count"] > int(settings["pdf_docling_ocr_max_pages"]):
        LOGGER.info(
            "Skipping Docling OCR for %s: %s pages exceeds limit",
            path,
            profile["page_count"],
        )
        return False
    if profile["size_mb"] > float(settings["pdf_docling_ocr_max_size_mb"]):
        LOGGER.info(
            "Skipping Docling OCR for %s: %.1f MB exceeds limit",
            path,
            profile["size_mb"],
        )
        return False
    return profile["first_pages_text_chars"] < int(settings["pdf_docling_threshold_chars"])


def _profile_pdf_for_docling(path: Path) -> dict[str, float | int]:
    size_mb = path.stat().st_size / 1024 / 1024
    try:
        with fitz.open(path) as document:
            page_count = document.page_count
            first_pages_text_chars = sum(
                len(document[index].get_text("text") or "") for index in range(min(page_count, 5))
            )
    except Exception:
        return {"size_mb": size_mb, "page_count": 0, "first_pages_text_chars": 0}
    return {
        "size_mb": size_mb,
        "page_count": page_count,
        "first_pages_text_chars": first_pages_text_chars,
    }


def _run_docling_extract_cli(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] != "--docling-extract":
        return 2
    input_path = Path(argv[2])
    output_path = Path(argv[3])
    text = _extract_pdf_text_with_docling_direct(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(text, encoding="utf-8")
    return 0 if text else 1


if __name__ == "__main__":
    raise SystemExit(_run_docling_extract_cli(sys.argv))

from src.pdf_document_selection import (  # noqa: E402,F401
    _adaptive_docling_timeout,
    _available_document_group_count,
    _document_candidate_rejection_reason,
    _document_family,
    _document_group_order,
    _document_identity,
    _document_profile,
    _extracted_document_profile,
    _needs_energy_diagnostics,
    _required_document_groups_for_sale,
    _select_documents_for_extraction,
    _store_document_analysis_status,
    _unique_document_groups,
)
from src.pdf_fact_extraction import (  # noqa: E402,F401
    _assign_pdf_land_surface, _assign_pdf_sale_date,
    _assign_pdf_surface, _cadastral_units_to_square_meters,
    _decimal_to_int_or_float, _document_filename,
    _document_land_surface_candidates, _document_surface_candidates,
    _energy_diagnostic_rank, _energy_diagnostic_risk_note,
    _extract_description, _extract_energy_diagnostics_from_documents,
    _extract_energy_diagnostics_with_evidence,
    _extract_land_surface_from_documents,
    _extract_land_surface_with_evidence,
    _extract_occupancy_status, _extract_property_type,
    _extract_risk_notes, _extract_rooms_count,
    _extract_sale_date_from_documents,
    _extract_sale_date_with_evidence,
    _extract_starting_price_from_documents,
    _extract_starting_price_with_evidence,
    _extract_surface,
    _extract_surface_from_documents,
    _extract_surface_with_evidence,
    _extract_visit_dates_from_documents,
    _extract_visit_dates_with_evidence,
    _first_energy_class_match, _has_land_surface_context,
    _has_sale_date_signal,
    _is_land_surface_evidence,
    _is_rooms_false_positive,
    _is_surface_false_positive,
    _land_surface_document_rank,
    _land_surface_match_is_built,
    _land_unit_candidate_rank,
    _merge_pdf_risk_notes,
    _normalize_visit_candidate,
    _parse_decimal_number,
    _reconcile_pdf_starting_price,
    _sale_date_candidate_phrases,
    _sale_date_extraction_rank,
    _should_replace_starting_price_with_document,
    _starting_price_document_rank,
    _surface_document_rank,
    _surface_measurement_scope,
    _visit_candidate_chunks,
    _write_pdf_text_cache,
    enrich_sale_from_pdf_text,
)
