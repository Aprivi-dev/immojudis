"""Persisted PDF row normalisation, Postgres reads and job re-keying, plus the enrichment revision helpers."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.normalize import clean_text
from src.storage.pdf_checkpoint_rules import _is_sha256

PDF_EXTRACTION_PROVIDER = "pdf_text"
PDF_EXTRACTION_MODEL = "docling+pymupdf+tesseract"
PDF_EXTRACTION_SCHEMA_VERSION = "pdf_text_v2_page_level"


def _fresh_complete_pdf_fingerprint(sale: AuctionSale, *, documents_current: bool) -> str | None:
    """Hash only stable proof fields after a fresh complete PDF result."""

    if not documents_current or not sale.documents:
        return None
    analysis = sale.raw_payload.get("document_analysis") or {}
    if not isinstance(analysis, dict):
        return None
    try:
        extracted_documents = int(analysis.get("documents_extracted") or 0)
    except (OverflowError, TypeError, ValueError):
        return None
    if extracted_documents <= 0:
        # A robots/terminal-only result can be current without proving a PDF
        # extraction; it must not rotate dependent LLM work.
        return None
    document_urls = {
        clean_text(document.get("url"))
        for document in sale.documents
        if isinstance(document, dict) and clean_text(document.get("url"))
    }
    if not document_urls:
        return None
    excluded_urls: set[str] = set()
    for key in ("blocked_document_urls", "skipped_document_urls", "terminal_document_urls"):
        values = analysis.get(key)
        if values is None:
            continue
        if not isinstance(values, (list, tuple, set)):
            return None
        normalized_values = {clean_text(value) for value in values if clean_text(value)}
        if not normalized_values.issubset(document_urls):
            return None
        excluded_urls.update(normalized_values)
    expected_urls = document_urls - excluded_urls
    # ``documents_are_current`` can legitimately be true when every listed
    # document is terminal. That state still provides no PDF evidence for a
    # dependent fact/display revision.
    if not expected_urls:
        return None
    proof = analysis.get("cache_proof")
    proof_documents = proof.get("documents") if isinstance(proof, dict) else None
    if (
        not isinstance(proof, dict)
        or proof.get("version") != 1
        or proof.get("input_fingerprint") != document_fingerprint(sale.documents)
        or not isinstance(proof_documents, list)
        or not proof_documents
    ):
        return None
    proof_by_url: dict[str, dict[str, object]] = {}
    for item in proof_documents:
        if not isinstance(item, dict):
            return None
        item_url = clean_text(item.get("url"))
        if not item_url or item_url in proof_by_url:
            return None
        if item_url not in document_urls or item_url not in expected_urls:
            if item_url not in excluded_urls:
                return None
            continue
        proof_by_url[item_url] = item
    if set(proof_by_url) != expected_urls:
        return None
    stable_documents: list[dict[str, object]] = []
    for item_url in sorted(expected_urls):
        item = proof_by_url[item_url]
        if not (
            item.get("extraction_status") == "extracted"
            and item.get("complete") is True
            and not item.get("failed_pages")
            and clean_text(item.get("sha256"))
            and clean_text(item.get("text_sha256"))
            and _is_sha256(item.get("sha256"))
            and _is_sha256(item.get("text_sha256"))
            and item.get("text_present") is True
        ):
            return None
        stable_documents.append(
            {
                "url": item_url,
                "sha256": clean_text(item.get("sha256")),
                "text_sha256": clean_text(item.get("text_sha256")),
                "text_chars": item.get("text_chars"),
                "text_present": item.get("text_present") is True,
                "extraction_status": clean_text(item.get("extraction_status")),
                "complete": item.get("complete") is True,
                "failed_pages": item.get("failed_pages") or [],
            }
        )
    try:
        serialized = json.dumps(
            sorted(stable_documents, key=lambda item: str(item["url"])),
            sort_keys=True,
        ).encode()
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(serialized).hexdigest()


def _enrichment_revision_for_sale(
    sale: AuctionSale,
    settings: dict[str, object],
    *,
    documents_current: bool,
) -> str:
    """Build the revision shared by enqueueing and prerequisite checks."""

    complete_pdf_fingerprint = _fresh_complete_pdf_fingerprint(
        sale,
        documents_current=documents_current,
    )
    checks = sale.raw_payload.get("source_checks") or {}
    analysis = sale.raw_payload.get("document_analysis") or {}
    revision_parts: list[object] = [
        document_fingerprint(sale.documents),
        sorted(
            (str(profile.get("url") or ""), str(profile.get("sha256") or ""))
            for profile in analysis.get("profiles", [])
            if isinstance(profile, dict)
        ),
        str(settings.get("llm_prompt_version") or ""),
        str(settings.get("replicate_model") or ""),
        settings.get("llm_fact_prompt_version"),
        settings.get("llm_display_prompt_version"),
        sorted(
            (url, check.get("fingerprint"))
            for url, check in checks.items()
            if isinstance(check, dict)
        ),
    ]
    if complete_pdf_fingerprint is not None:
        # ``checked_at`` and proof timestamps are operational metadata.
        # Stable proof content rotates dependants once without creating a
        # new revision on every ordinary scan.
        revision_parts.append(["complete_pdf_fingerprint", complete_pdf_fingerprint])
    return hashlib.sha256(json.dumps(revision_parts, sort_keys=True).encode()).hexdigest()


_PERSISTED_PDF_ROW_COLUMNS = (
    "source_url",
    "provider",
    "model",
    "input_hash",
    "schema_version",
    "result",
    "updated_at",
)


def _normalize_persisted_pdf_row(row: object) -> dict[str, object] | None:
    if isinstance(row, dict):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (list, tuple)):
        if len(row) == 1 and isinstance(row[0], dict):
            return {str(key): value for key, value in row[0].items()}
        if len(row) == len(_PERSISTED_PDF_ROW_COLUMNS):
            return dict(zip(_PERSISTED_PDF_ROW_COLUMNS, row, strict=True))
    try:
        return {column: row[column] for column in _PERSISTED_PDF_ROW_COLUMNS}  # type: ignore[index]
    except (KeyError, IndexError, TypeError):
        return None


def _read_persisted_pdf_rows_postgres(connection: Any, source_urls: list[str]) -> list[dict[str, object]]:
    cursor = connection.execute(
        """
        select extracted.source_url, extracted.provider, extracted.model,
               extracted.input_hash, extracted.schema_version, extracted.result,
               extracted.updated_at
        from unnest(%s::text[]) as requested(source_url)
        cross join lateral (
            select candidate.source_url, candidate.provider, candidate.model,
                   candidate.input_hash, candidate.schema_version, candidate.result,
                   candidate.updated_at
            from public.auction_extractions as candidate
            where candidate.source_url = requested.source_url
              and candidate.provider = %s
              and candidate.model = %s
              and candidate.schema_version = %s
            order by candidate.updated_at desc
            limit 5
        ) as extracted
        order by extracted.updated_at desc
        """,
        (source_urls, PDF_EXTRACTION_PROVIDER, PDF_EXTRACTION_MODEL, PDF_EXTRACTION_SCHEMA_VERSION),
    )
    return [normalized for row in cursor.fetchall() if (normalized := _normalize_persisted_pdf_row(row)) is not None]


def _rekey_pdf_job_after_checkpoint_with_connection(
    connection: Any,
    sale: AuctionSale,
    pdf_job: dict[str, object],
    *,
    input_hash: str,
) -> None:
    """Move one claimed PDF retry to the hash made durable by its checkpoint.

    A partial pass can update document profiles and file SHA values before the
    claimed queue row is released.  Rekey that same row only after the
    checkpoint and extraction proof have been written, so the retry budget
    continues to describe the generation that actually processed the sale.
    """

    if str(pdf_job.get("job_type") or "") != "pdf":
        return
    job_id = clean_text(pdf_job.get("id"))
    old_hash = clean_text(pdf_job.get("input_hash"))
    source_url = clean_text(sale.source_url)
    if not job_id or not old_hash or not source_url or old_hash == input_hash:
        return
    try:
        attempt_count = int(pdf_job.get("attempt_count") or 0)
    except (OverflowError, TypeError, ValueError):
        return
    locked_at = pdf_job.get("locked_at")
    lease_clause = ""
    lease_parameters: tuple[object, ...] = ()
    if locked_at is not None:
        lease_clause = " and locked_at=%s"
        lease_parameters = (locked_at,)

    cancel_sql = """
        update public.auction_enrichment_jobs
           set status='cancelled', locked_at=null,
               last_error='superseded after durable PDF checkpoint', updated_at=now()
         where id=%s
           and source_url=%s
           and job_type='pdf'
           and status='running'
           and input_hash=%s
           and attempt_count=%s
        """ + lease_clause
    cancel_parameters = (job_id, source_url, old_hash, attempt_count, *lease_parameters)

    def find_existing_generation() -> Any:
        return connection.execute(
            """
            select id
              from public.auction_enrichment_jobs
             where source_url=%s
               and job_type='pdf'
               and input_hash=%s
               and id<>%s
             order by created_at desc, id desc
             limit 1
             for update
            """,
            (source_url, input_hash, job_id),
        ).fetchone()

    # A source refresh may already have materialized this post-checkpoint
    # generation. Inspect it before changing the predecessor's unique key;
    # otherwise the update can fail on the queue uniqueness constraint.
    existing = find_existing_generation()
    if existing is not None:
        connection.execute(cancel_sql, cancel_parameters)
        return

    # No current row exists, so move the unique key without creating a second
    # PDF generation. The sale row is already locked by the durable
    # checkpoint transaction, which serializes the normal enqueue path.
    update_sql = """
        update public.auction_enrichment_jobs
           set input_hash=%s, updated_at=now()
         where id=%s
           and source_url=%s
           and job_type='pdf'
           and status='running'
           and input_hash=%s
           and attempt_count=%s
        """ + lease_clause + " returning id"
    update_parameters = (input_hash, job_id, source_url, old_hash, attempt_count, *lease_parameters)
    try:
        transaction = getattr(connection, "transaction", None)
        if callable(transaction):
            # A concurrent source refresh can insert the new unique key after
            # the pre-check. Keep that 23505 inside a savepoint so the durable
            # documentary checkpoint can still commit and retire our claim.
            with transaction():
                updated = connection.execute(update_sql, update_parameters).fetchone()
        else:
            updated = connection.execute(update_sql, update_parameters).fetchone()
    except Exception as exc:
        if getattr(exc, "sqlstate", None) != "23505" or not callable(transaction):
            raise
        if find_existing_generation() is None:
            raise
        connection.execute(cancel_sql, cancel_parameters)
        return
    if updated is None:
        # A lost lease is never rekeyed. The conditional cancellation still
        # preserves the same lease and attempt guards if a new generation is
        # already present.
        if find_existing_generation() is not None:
            connection.execute(cancel_sql, cancel_parameters)
