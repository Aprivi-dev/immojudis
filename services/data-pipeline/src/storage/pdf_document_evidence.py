"""Per-document PDF evidence recovered from ``auction_extractions``.

The strict cold-cache recovery (``_validated_persisted_pdf_texts``) restores a
sale's text only when its whole manifest is complete: one skipped, blocked or
partially read attachment disables it for every other document of the sale.
A publication worker that does not hold the local PDF cache (GitHub runners
restore one cache entry per day and cannot overwrite it) then rewrote every
``auction_documents`` row of that sale as ``unknown``/``pending`` although the
text of most attachments had been extracted and persisted earlier.

This module reads only per-document *metadata* (never the text itself) of the
latest persisted extraction rows, validates each document independently, and
lets the document projection report what was really read. It never feeds the
local text cache, the fact extractors or the LLM context: those keep the
strict, sale-level path.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.normalize import clean_text
from src.pdf_progress import PDF_TEXT_CACHE_VERSION
from src.storage.pdf_checkpoint_rules import _is_sha256
from src.storage.pdf_persistence_rows import (
    PDF_EXTRACTION_MODEL,
    PDF_EXTRACTION_PROVIDER,
    PDF_EXTRACTION_SCHEMA_VERSION,
)

LOGGER = logging.getLogger(__name__)

# Rows per sale inspected, newest first. Each row is one sale revision; the
# newest row that mentions a document URL is authoritative for that URL.
PERSISTED_DOCUMENT_ROWS_PER_SALE = 3
PERSISTED_DOCUMENT_EVIDENCE_STATUSES = frozenset({"extracted", "incomplete", "empty"})

_EVIDENCE_SQL = """
select distinct on (extracted.source_url, item ->> 'url')
       extracted.source_url,
       item ->> 'url' as document_url,
       item ->> 'sha256' as sha256,
       item ->> 'cache_version' as cache_version,
       item ->> 'extraction_status' as extraction_status,
       item ->> 'extraction_method' as extraction_method,
       item ->> 'complete' as complete,
       item ->> 'text_chars' as text_chars,
       char_length(coalesce(item ->> 'text', '')) as text_length,
       case when jsonb_typeof(item -> 'failed_pages') = 'array'
            then jsonb_array_length(item -> 'failed_pages') else 0 end as failed_pages,
       case when jsonb_typeof(item -> 'pages') = 'array'
            then jsonb_array_length(item -> 'pages') else null end as page_count,
       extracted.updated_at
  from unnest(%s::text[]) as requested(source_url)
  cross join lateral (
        select candidate.source_url, candidate.result, candidate.updated_at
          from public.auction_extractions as candidate
         where candidate.source_url = requested.source_url
           and candidate.provider = %s
           and candidate.model = %s
           and candidate.schema_version = %s
         order by candidate.updated_at desc
         limit %s
  ) as extracted
  cross join lateral jsonb_array_elements(
        case when jsonb_typeof(extracted.result) = 'array'
             then extracted.result else '[]'::jsonb end
  ) as item
 where item ->> 'url' is not null
 order by extracted.source_url, item ->> 'url', extracted.updated_at desc
"""

_EVIDENCE_COLUMNS = (
    "source_url",
    "document_url",
    "sha256",
    "cache_version",
    "extraction_status",
    "extraction_method",
    "complete",
    "text_chars",
    "text_length",
    "failed_pages",
    "page_count",
    "updated_at",
)


def read_persisted_document_evidence(
    connection: Any,
    sales: list[AuctionSale],
) -> dict[str, list[dict[str, object]]]:
    """Return validated per-document evidence keyed by sale ``source_url``.

    Optional recovery: any read failure leaves the ordinary pending rows.
    """

    by_url = {clean_text(sale.source_url): sale for sale in sales if clean_text(sale.source_url)}
    if connection is None or not by_url:
        return {}
    try:
        cursor = connection.execute(
            _EVIDENCE_SQL,
            (
                sorted(by_url),
                PDF_EXTRACTION_PROVIDER,
                PDF_EXTRACTION_MODEL,
                PDF_EXTRACTION_SCHEMA_VERSION,
                PERSISTED_DOCUMENT_ROWS_PER_SALE,
            ),
        )
        rows = cursor.fetchall()
    except Exception as exc:  # pragma: no cover - defensive, logged
        LOGGER.warning("Persisted per-document PDF evidence lookup failed; keeping pending rows: %s", exc)
        return {}
    evidence: dict[str, list[dict[str, object]]] = {}
    for raw in rows:
        row = _row_dict(raw)
        if row is None:
            continue
        sale = by_url.get(clean_text(row.get("source_url")))
        if sale is None:
            continue
        item = validated_document_evidence(sale, row)
        if item is not None:
            evidence.setdefault(sale.source_url, []).append(item)
    return evidence


def _row_dict(raw: object) -> dict[str, object] | None:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, (list, tuple)) and len(raw) == len(_EVIDENCE_COLUMNS):
        return dict(zip(_EVIDENCE_COLUMNS, raw, strict=True))
    return None


def _as_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (OverflowError, TypeError, ValueError):
        return None


def validated_document_evidence(sale: AuctionSale, row: dict[str, object]) -> dict[str, object] | None:
    """Validate one persisted document entry against the current sale.

    The entry must belong to a current attachment URL, carry the current cache
    format, a real byte hash and a text length that matches its counter. A
    current manifest that knows another byte hash for the URL wins.
    """

    url = clean_text(row.get("document_url"))
    documents = sale.documents if isinstance(sale.documents, list) else []
    labels = {
        clean_text(document.get("url")): document.get("label")
        for document in documents
        if isinstance(document, dict) and clean_text(document.get("url"))
    }
    if not url or url not in labels:
        return None
    if row.get("cache_version") != PDF_TEXT_CACHE_VERSION:
        return None
    sha256 = clean_text(row.get("sha256"))
    if not _is_sha256(sha256):
        return None
    status = (clean_text(row.get("extraction_status")) or "").casefold()
    if status not in PERSISTED_DOCUMENT_EVIDENCE_STATUSES:
        return None
    complete = str(row.get("complete") or "").strip().casefold() == "true"
    text_chars = _as_int(row.get("text_chars"))
    text_length = _as_int(row.get("text_length"))
    failed_pages = _as_int(row.get("failed_pages")) or 0
    if text_length is None:
        return None
    if text_chars is None:
        text_chars = text_length
    if text_chars != text_length:
        return None
    if status == "extracted" and (not complete or failed_pages or text_chars <= 0):
        return None
    if status == "empty" and (not complete or text_chars != 0):
        return None
    if status == "incomplete":
        complete = False
    known_sha = _current_known_sha(sale, url)
    if known_sha and known_sha != sha256:
        return None
    page_count = _as_int(row.get("page_count"))
    return {
        "url": url,
        "label": labels.get(url),
        "sha256": sha256,
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "extraction_status": status,
        "extraction_method": clean_text(row.get("extraction_method")),
        "complete": complete,
        "failed_pages": [],
        "failed_page_count": failed_pages,
        "text_chars": text_chars,
        "page_count": page_count,
        "file_path": None,
        "_persisted_pdf_proof": True,
        "_persisted_document_proof": True,
        "_persisted_verified_at": _isoformat(row.get("updated_at")),
    }


def _isoformat(value: object) -> str | None:
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else clean_text(value)


def _current_known_sha(sale: AuctionSale, url: str) -> str | None:
    """Byte hash the current manifest or document list records for ``url``."""

    for document in sale.documents or []:
        if isinstance(document, dict) and clean_text(document.get("url")) == url:
            sha = clean_text(document.get("sha256"))
            if _is_sha256(sha):
                return sha
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict) or analysis.get("input_fingerprint") != document_fingerprint(sale.documents):
        return None
    for key in ("profiles",):
        for profile in analysis.get(key) or []:
            if isinstance(profile, dict) and clean_text(profile.get("url")) == url:
                sha = clean_text(profile.get("sha256"))
                if _is_sha256(sha):
                    return sha
    proof = analysis.get("cache_proof")
    proof_documents = proof.get("documents") if isinstance(proof, dict) else None
    for item in proof_documents if isinstance(proof_documents, list) else []:
        if isinstance(item, dict) and clean_text(item.get("url")) == url:
            sha = clean_text(item.get("sha256"))
            if _is_sha256(sha):
                return sha
    return None


def merge_document_evidence(
    local_items: list[dict[str, object]],
    persisted_items: list[dict[str, object]] | None,
) -> list[dict[str, object]]:
    """Local cache entries win; persisted evidence fills the missing URLs."""

    merged = [item for item in local_items if isinstance(item, dict)]
    known = {clean_text(item.get("url")) for item in merged if clean_text(item.get("url"))}
    for item in persisted_items or []:
        url = clean_text(item.get("url"))
        if url and url not in known:
            merged.append(item)
            known.add(url)
    return merged


def with_document_evidence(
    connection: Any,
    sales: list[AuctionSale],
    persisted_pdf_texts: dict[str, list[dict[str, object]]],
    load_local: Callable[[AuctionSale], list[dict[str, object]]],
) -> dict[str, list[dict[str, object]]]:
    """Strict whole-sale payloads, plus per-document evidence for the other sales."""

    evidence = read_persisted_document_evidence(
        connection,
        [sale for sale in sales if sale.source_url not in persisted_pdf_texts],
    )
    if not evidence:
        return persisted_pdf_texts
    merged = dict(persisted_pdf_texts)
    for sale in sales:
        if sale.source_url in evidence:
            merged[sale.source_url] = merge_document_evidence(load_local(sale), evidence[sale.source_url])
    return merged
