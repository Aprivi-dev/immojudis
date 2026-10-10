from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

import httpx
from supabase import Client, create_client

try:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - GitHub Actions installs psycopg on Python 3.11.
    psycopg = None
    sql = None
    Jsonb = None

from src.admission import has_price_or_surface, is_catalogue_expired, is_expired, quarantine_reason
from src.asset_normalization import (
    build_auction_features_row,
    build_auction_risk_rows_from_occurrences,
    build_auction_score_factor_rows,
    build_auction_surfaces_row,
    extract_risk_occurrences_from_text,
)
from src.catalogue_readiness import apply_catalogue_readiness
from src.config import LLM_EXTRACTIONS_DIR, PDF_DOCUMENT_TEXTS_DIR, PDF_TEXTS_DIR, load_settings
from src.court_competence import tribunal_reference_rows
from src.dedupe import merge_duplicate_sales
from src.enrichment.display_quality import has_current_display
from src.fact_claims import (
    FACT_CLAIMS_NAMESPACE,
    FACT_CLAIMS_VERSION,
    build_fact_claim_candidates,
    materialize_fact_claim_rows,
)
from src.freshness import document_fingerprint, documents_are_current, timestamp_is_fresh
from src.models import AuctionSale
from src.normalize import clean_text, make_sale_signature
from src.pdf_enrichment import PDF_TEXT_CACHE_VERSION, classify_document_type, sale_storage_id
from src.pdf_progress import (
    PDF_PROGRESS_SCHEMA_VERSION,
    document_url,
    is_modern_payload,
    modern_progress_entries,
)
from src.reviewed_aliases import (
    ReviewedAliasRegistry,
    ReviewedAliasRegistryError,
    load_reviewed_aliases,
    registry_from_rows,
)
from src.urban_planning import build_urban_planning_signal_rows

LOGGER = logging.getLogger(__name__)
POSTGREST_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
POSTGREST_UPSERT_RETRIES = 5
POSTGREST_RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
POSTGREST_MAX_PAYLOAD_DEPTH = 64
CLAIM_RPC_ATTEMPTS = 4
CLAIM_RPC_RETRY_DELAYS = (1.0, 3.0, 5.0)
CLAIM_RPC_MAX_WAIT_SECONDS = 60.0
POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE = 50
POSTGRES_CONNECT_TIMEOUT = 15
POSTGRES_CONNECT_RETRY_DELAYS = (1.0, 3.0, 8.0)
# A blocked statement must fail after two minutes instead of holding the job
# until the role or workflow limit. Long jobs (model training, bulk imports)
# pass their own larger value, or 0 to disable the limit explicitly.
POSTGRES_STATEMENT_TIMEOUT_MS = 120_000
POSTGRES_TRAINING_STATEMENT_TIMEOUT_MS = 900_000
POSTGRES_SHARED_CONNECTION_PING_AFTER_SECONDS = 20.0
POSTGRES_OBSERVATION_BATCH_SIZE = 25
PDF_EXTRACTION_PROVIDER = "pdf_text"
PDF_EXTRACTION_MODEL = "docling+pymupdf+tesseract"
PDF_EXTRACTION_SCHEMA_VERSION = "pdf_text_v2_page_level"
# Persisted PDF payloads contain the complete page text and can be large. Keep
# the recovery lookup bounded while still batching it separately from the
# document materialization write (one lookup per small URL batch, never one
# lookup per sale).
PERSISTED_PDF_LOOKUP_BATCH_SIZE = 5
PERSISTED_PDF_LOOKUP_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
# A documentary checkpoint is a bounded recovery write.  It must not inherit
# the publication connection's longer retry and lock budget: a row lock held
# by another worker must leave enough time for the caller's deadline.
PDF_CHECKPOINT_CONNECT_TIMEOUT = 5
PDF_CHECKPOINT_LOCK_TIMEOUT = "5s"
PDF_CHECKPOINT_STATEMENT_TIMEOUT = "15s"
PDF_CHECKPOINT_QUEUE_OWNER = "python"
EXPIRED_SALE_DELETE_TABLES = (
    "auction_observations",
    "auction_enrichment_jobs",
    "auction_surface_derivations",
    "auction_surface_measurements",
    "auction_documents",
    "auction_extractions",
    "auction_cadastre_parcels",
    "auction_dpe_diagnostics",
    "auction_risk_occurrences",
    "auction_urban_planning_signals",
    "auction_score_factors",
    "auction_risks",
    "auction_features",
    "auction_surfaces",
    "judicial_sales",
    "properties",
    "auction_sales",
)
# The blank-page correction and the writer marker correction each require one
# bounded replay of incomplete/legacy documents. The writer now preserves the
# extractor's explicit markers; old rows without them must pass normal
# extraction again. Keep this deterministic so later scans remain idempotent.
PDF_RETRY_GENERATION = f"{PDF_TEXT_CACHE_VERSION}:decorative_edge_v1:writer_markers_v1"
POSTGRES_JSON_COLUMNS = {
    "source_urls",
    "visit_dates",
    "documents",
    "score_factors",
    "premium_readiness_factors",
    "premium_readiness_blockers",
    "premium_readiness_missing_fields",
    "quality_flags",
    "raw_payload",
    "observations",
    "sale_procedure",
}
UPSERT_COLUMNS = (
    "source_name",
    "source_url",
    "primary_source",
    "source_urls",
    "dedupe_confidence",
    "external_id",
    "tribunal",
    "tribunal_code",
    "sale_venue_type",
    "sale_legal_framework",
    "sale_verification_status",
    "sale_procedure",
    "department",
    "city",
    "address",
    "postal_code",
    "property_type",
    "title",
    "description",
    "surface_m2",
    "habitable_surface_m2",
    "land_surface_m2",
    "carrez_surface_m2",
    "app_surface_m2",
    "app_surface_kind",
    "surface_scope",
    "surface_source",
    "surface_confidence",
    "surface_evidence",
    "rooms_count",
    "bedrooms_count",
    "bathrooms_count",
    "parking_count",
    "has_garden",
    "has_terrace",
    "has_garage",
    "has_pool",
    "has_air_conditioning",
    "has_double_glazing",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "lawyer_name",
    "lawyer_contact",
    "status",
    "adjudication_price_eur",
    "documents",
    "latitude",
    "longitude",
    "occupancy_status",
    "risk_notes",
    "investment_score",
    "investment_summary",
    "score_version",
    "score_confidence",
    "score_factors",
    "premium_readiness_score",
    "premium_readiness_status",
    "premium_readiness_policy_version",
    "premium_readiness_factors",
    "premium_readiness_blockers",
    "premium_readiness_missing_fields",
    "premium_readiness_evaluated_at",
    "quality_flags",
    "raw_text",
    "raw_payload",
    "observations",
    "content_hash",
    "last_run_id",
)
PROPERTY_COLUMNS = (
    "source_url",
    "source_name",
    "primary_source",
    "source_urls",
    "external_id",
    "department",
    "city",
    "postal_code",
    "address",
    "property_type",
    "title",
    "description",
    "surface_m2",
    "habitable_surface_m2",
    "land_surface_m2",
    "carrez_surface_m2",
    "app_surface_m2",
    "app_surface_kind",
    "surface_scope",
    "surface_source",
    "surface_confidence",
    "surface_evidence",
    "rooms_count",
    "bedrooms_count",
    "bathrooms_count",
    "parking_count",
    "has_garden",
    "has_terrace",
    "has_garage",
    "has_pool",
    "has_air_conditioning",
    "has_double_glazing",
    "occupancy_status",
    "latitude",
    "longitude",
    "raw_payload",
)
JUDICIAL_SALE_COLUMNS = (
    "source_url",
    "property_source_url",
    "source_name",
    "primary_source",
    "source_urls",
    "external_id",
    "tribunal",
    "tribunal_code",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "status",
    "adjudication_price_eur",
    "source_lawyer_name",
    "source_lawyer_contact",
    "documents_count",
    "investment_score",
    "investment_summary",
    "score_version",
    "score_confidence",
    "score_factors",
    "quality_flags",
    "content_hash",
    "last_run_id",
    "raw_payload",
)
LLM_BACKFILL_SALE_SELECT = ",".join(
    (
        "id",
        *UPSERT_COLUMNS,
        "first_seen_at",
        "last_seen_at",
        "created_at",
        "updated_at",
    )
)
DEDUPLICATION_SALE_SELECT = ",".join(
    (
        "id",
        *UPSERT_COLUMNS,
        "first_seen_at",
        "last_seen_at",
        "created_at",
        "updated_at",
    )
)


def get_supabase_client() -> Client | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return None
    return create_client(str(url), str(key))


_PUBLICATION_CONNECTION: ContextVar[Any] = ContextVar("publication_connection", default=None)


def _fetch_reviewed_alias_registry(supabase_url: str, api_key: str) -> ReviewedAliasRegistry:
    """Load the reviewed alias relation and fail closed on any RPC failure."""
    publication_connection = _PUBLICATION_CONNECTION.get()
    if publication_connection is not None:
        return load_reviewed_aliases(publication_connection)
    db_url = load_settings().get("supabase_db_url")
    if db_url:
        with _postgres_connect(str(db_url)) as db:
            return load_reviewed_aliases(db)
    try:
        response = _postgrest_request_with_retries(
            "POST",
            f"{supabase_url.rstrip('/')}/rest/v1/rpc/list_reviewed_publication_aliases",
            "reviewed_publication_aliases",
            headers=_rest_headers(api_key, prefer="count=none"),
            json={},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        raise ReviewedAliasRegistryError("Reviewed-alias registry lookup failed") from exc
    if response.is_error:
        raise ReviewedAliasRegistryError(
            f"Reviewed-alias registry lookup failed ({response.status_code})"
        )
    try:
        payload = response.json()
        if not isinstance(payload, list):
            raise ReviewedAliasRegistryError("Malformed reviewed-alias RPC response")
        return registry_from_rows(payload)
    except ReviewedAliasRegistryError:
        raise
    except (ValueError, TypeError) as exc:
        raise ReviewedAliasRegistryError("Malformed reviewed-alias RPC response") from exc


def _transaction_write(table: str, payload: list[dict[str, object]], on_conflict: str | None = None, *, ignore_conflicts: bool = False) -> None:
    connection = _PUBLICATION_CONNECTION.get()
    if not payload:
        return
    columns = list(dict.fromkeys(key for row in payload for key in row))
    names = sql.SQL(", ").join(sql.Identifier(column) for column in columns)
    statement = sql.SQL("insert into {} ({}) select {} from jsonb_populate_recordset(null::{}, %s)").format(
        sql.Identifier("public", table), names, names, sql.Identifier("public", table)
    )
    if on_conflict:
        keys = tuple(key.strip() for key in on_conflict.split(",") if key.strip())
        if not keys:
            raise ValueError("Transaction upsert requires at least one conflict column")
        updates = [] if ignore_conflicts else [column for column in columns if column not in keys]
        statement += sql.SQL(" on conflict ({}) ").format(sql.SQL(", ").join(sql.Identifier(key) for key in keys))
        statement += (sql.SQL("do update set ") + sql.SQL(", ").join(
            sql.SQL("{} = excluded.{}").format(sql.Identifier(column), sql.Identifier(column)) for column in updates
        )) if updates else sql.SQL("do nothing")
    LOGGER.info("Publication write table=%s rows=%s", table, len(payload))
    connection.execute(statement, (Jsonb(_sanitize_postgrest_payload(payload)),))


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


def pdf_enrichment_input_hash_for_sale(
    sale: AuctionSale,
    settings: dict[str, object] | None = None,
) -> str:
    """Return the current queue generation for a sale's PDF prerequisite.

    ``settings`` remains in the signature for callers that also build the
    fact/display revisions. PDF extraction is independent of source checks
    and LLM prompt/model settings, so none of those values may rotate the
    PDF retry budget.
    """

    del settings
    analysis = sale.raw_payload.get("document_analysis") or {}
    if isinstance(analysis, dict):
        profiles = analysis.get("profiles", [])
        last_success = analysis.get("last_successful_check_at") or "initial"
    else:
        profiles = []
        last_success = "initial"
    if not isinstance(profiles, (list, tuple)):
        profiles = []
    profile_fingerprints = sorted(
        (str(profile.get("url") or ""), str(profile.get("sha256") or ""))
        for profile in profiles
        if isinstance(profile, dict)
    )
    document_sha_fingerprints = sorted(
        (str(document.get("url") or ""), str(document.get("sha256") or ""))
        for document in sale.documents
        if isinstance(document, dict)
    )
    revision_parts: list[object] = [
        "pdf_enrichment_v2",
        PDF_TEXT_CACHE_VERSION,
        PDF_RETRY_GENERATION,
        document_fingerprint(sale.documents),
        document_sha_fingerprints,
        profile_fingerprints,
        str(last_success),
    ]
    revision = hashlib.sha256(json.dumps(revision_parts, sort_keys=True).encode()).hexdigest()
    return "pipeline_v2:" + revision


def _coalesce_queued_display_revisions(
    connection: Any,
    jobs: list[dict[str, object]],
) -> set[tuple[str, str, str]]:
    """Re-key one queued display job instead of creating a superseded row.

    A source refresh can arrive while an older display revision is still
    queued.  The claim RPC intentionally preserves that older row as an audit
    cancellation, but doing so for every refresh creates avoidable churn and
    lets the queue spend its capacity cancelling work.  Re-key only queued
    display jobs, never running/failed jobs, and lock the selected row in the
    caller's publication transaction so a concurrent claim cannot race the
    rewrite.  The unique revision constraint still remains the final guard.
    """
    candidates: dict[tuple[str, str], dict[str, object]] = {}
    for job in jobs:
        if job.get("job_type") != "display_description":
            continue
        source_url = str(job.get("source_url") or "")
        input_hash = str(job.get("input_hash") or "")
        if not source_url or not input_hash:
            continue
        candidates[(source_url, "display_description")] = job
    if not candidates:
        return set()

    values = ",".join("(%s,%s,%s,%s)" for _ in candidates)
    params: list[object] = []
    for (source_url, job_type), job in candidates.items():
        params.extend((source_url, job_type, str(job["input_hash"]), int(job.get("priority") or 0)))
    # A claim RPC can lock the same queued row between the candidate scan and
    # the update.  Keep the rewrite in a savepoint so a concurrent unique
    # revision insert cannot abort the publication transaction; the normal
    # insert path below remains the final idempotency guard.
    savepoint = "coalesce_display_revision"
    connection.execute(f"savepoint {savepoint}")
    try:
        rows = connection.execute(
            f"""with incoming(source_url, job_type, input_hash, priority) as (
                  values {values}
                ), candidates as (
                  select queued.id, incoming.input_hash, incoming.priority
                    from incoming
                    cross join lateral (
                      select queued_row.id
                        from public.auction_enrichment_jobs queued_row
                       where queued_row.source_url=incoming.source_url
                         and queued_row.job_type=incoming.job_type
                         and queued_row.status='queued'
                         and queued_row.input_hash <> incoming.input_hash
                       order by queued_row.created_at desc, queued_row.id desc
                       for update skip locked
                       limit 1
                    ) queued
                   where not exists (
                     select 1 from public.auction_enrichment_jobs exact
                      where exact.source_url=incoming.source_url
                        and exact.job_type=incoming.job_type
                        and exact.input_hash=incoming.input_hash
                   )
                ), updated as (
                  update public.auction_enrichment_jobs queued
                     set input_hash=candidates.input_hash,
                         priority=candidates.priority,
                         status='queued',
                         attempt_count=0,
                         locked_at=null,
                         completed_at=null,
                         next_attempt_at=statement_timestamp(),
                         updated_at=statement_timestamp(),
                         last_error=null
                    from candidates
                   where queued.id=candidates.id
                     and queued.status='queued'
                     and queued.input_hash <> candidates.input_hash
                     and not exists (
                       select 1 from public.auction_enrichment_jobs exact
                        where exact.source_url=queued.source_url
                          and exact.job_type=queued.job_type
                          and exact.input_hash=candidates.input_hash
                     )
                  returning queued.source_url, queued.job_type, queued.input_hash
                )
                select source_url, job_type, input_hash from updated""",
            tuple(params),
        ).fetchall()
    except Exception as exc:
        connection.execute(f"rollback to savepoint {savepoint}")
        if psycopg is None or not isinstance(exc, psycopg.errors.UniqueViolation):
            raise
        LOGGER.warning("Queued display revision coalescing lost a concurrent row race; enqueueing a new row")
        rows = []
    finally:
        connection.execute(f"release savepoint {savepoint}")
    return {
        (str(source_url), str(job_type), str(input_hash))
        for source_url, job_type, input_hash in rows
    }


def _enqueue_due_enrichment(sales: list[AuctionSale], url: str, key: str) -> None:
    from src.enrichment.extract_structured import needs_fact_extraction

    settings = load_settings()
    prompt_version = str(settings.get("llm_prompt_version") or "")
    jobs = []
    for sale in sales:
        if sale.status not in {"active", "unknown", "upcoming", "postponed"} or quarantine_reason(sale):
            continue
        documents_current = bool(sale.documents and documents_are_current(sale))
        revision = _enrichment_revision_for_sale(
            sale,
            settings,
            documents_current=documents_current,
        )
        kinds = []
        if sale.documents and not documents_current:
            # A failed document keeps the same retry budget across daily scans.
            kinds.append(("pdf", pdf_enrichment_input_hash_for_sale(sale, settings), 30))
        if not _has_current_llm_description(sale.raw_payload, prompt_version) or sale.raw_payload.get("source_content_changed"):
            kinds.append(("display_description", revision, 20))
        if needs_fact_extraction(sale):
            kinds.append(("fact_extraction", revision, 25))
        for kind, fingerprint, priority in kinds:
            jobs.append({"source_url": sale.source_url, "job_type": kind,
                         "input_hash": fingerprint if kind == "pdf" else "pipeline_v2:" + fingerprint,
                         # Queue ordering applies age and urgency to every generation.
                         "priority": priority})
    if jobs:
        if _PUBLICATION_CONNECTION.get() is not None:
            connection = _PUBLICATION_CONNECTION.get()
            coalesced = _coalesce_queued_display_revisions(connection, jobs)
            coalesced_keys = {
                (source_url, job_type)
                for source_url, job_type, _ in coalesced
            }
            pending = [
                job for job in jobs
                if (
                    str(job.get("source_url") or ""),
                    str(job.get("job_type") or ""),
                ) not in coalesced_keys
            ]
            if pending:
                _transaction_write(
                    "auction_enrichment_jobs",
                    pending,
                    "source_url,job_type,input_hash",
                    ignore_conflicts=True,
                )
        else:
            _postgrest_upsert(url, key, "auction_enrichment_jobs", jobs, "source_url,job_type,input_hash")


def upsert_sales_to_supabase(
    sales: list[AuctionSale],
    *,
    refresh_last_seen: bool = True,
) -> int:
    sales = [
        sale
        for sale in sales
        if has_price_or_surface(sale)
        and not is_expired(sale)
        and not is_catalogue_expired(sale)
    ]
    for sale in sales:
        apply_catalogue_readiness(sale)
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        LOGGER.info("Supabase variables are missing; skipping upsert")
        return 0
    if db_url and _PUBLICATION_CONNECTION.get() is None and len(sales) > 25:
        committed = 0
        for offset in range(0, len(sales), 25):
            committed += upsert_sales_to_supabase(sales[offset:offset + 25], refresh_last_seen=refresh_last_seen)
            LOGGER.info("Publication committed %s/%s sales", committed, len(sales))
        return committed
    if db_url and _PUBLICATION_CONNECTION.get() is None:
        # All product tables for each bounded batch commit together. A failed transaction never falls
        # back to partially committed REST writes.
        submitted_sales = sales
        with _postgres_connect(str(db_url)) as connection:
            connection.execute("select set_config('app.pipeline_queue_owner', 'python', true)")
            connection.execute("set local lock_timeout = '15s'")
            connection.execute("set local statement_timeout = '120s'")
            connection.execute("select pg_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1',0))")
            if refresh_last_seen:
                from src.publication_identity import resolve_publication_identities
                sales = resolve_publication_identities(connection, sales)
                if not sales:
                    return 0
            if not refresh_last_seen:
                sales = _guard_enrichment_revision(connection, sales)
                if not sales:
                    return 0
            written_at = datetime.now(UTC)
            token = _PUBLICATION_CONNECTION.set(connection)
            try:
                result = _write_sale_revisions(
                    sales, settings, refresh_last_seen=refresh_last_seen, written_at=written_at,
                )
            finally:
                _PUBLICATION_CONNECTION.reset(token)
        # The next enrichment write compares the in-memory version with the
        # committed row. Identity resolution may write copies of the caller's
        # sales, so advance both only after the transaction has committed.
        written_urls = {sale.source_url for sale in sales}
        for sale in (*submitted_sales, *sales):
            if sale.source_url in written_urls:
                sale.updated_at = written_at
        return result
    return _write_sale_revisions(sales, settings, refresh_last_seen=refresh_last_seen)


def _write_sale_revisions(
    sales: list[AuctionSale], settings: dict, *, refresh_last_seen: bool,
    written_at: datetime | None = None,
) -> int:
    """Write all catalogue tables inside the caller's admission/version boundary."""
    from src.enrichment.operational_display import refresh_operational_display
    from src.publication_identity import ensure_room_bedroom_consistency

    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    now = (written_at or datetime.now(UTC)).isoformat()
    payload = []
    for sale in sales:
        # Source collectors can observe a price/date/status-only revision after
        # the early publication pass. Resolve that revision at the write
        # boundary so the persisted row and the enqueue decision see the same
        # current display, and so a paid display job is not created first.
        try:
            refresh_operational_display(sale, settings=settings)
        except Exception:
            # A deterministic refresh is an optimization, never a reason to
            # lose the source revision. Leave the invalidation flags intact so
            # the normal enrichment queue reconciles it.
            LOGGER.exception("Operational display refresh failed for %s", sale.source_url)
        # Normalization can happen after identity resolution (for example in
        # a detail/enrichment path).  Recheck the SQL invariant immediately
        # before serializing the parent row so a contradictory pair is stored
        # as evidence plus NULLs instead of aborting the whole publication.
        ensure_room_bedroom_consistency(sale)
        apply_catalogue_readiness(sale)
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in UPSERT_COLUMNS}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        row["updated_at"] = now
        payload.append(row)
    if not payload:
        return 0
    tribunal_rows = [{**row, "updated_at": now} for row in tribunal_reference_rows(sales)]
    if tribunal_rows:
        # The FK target must exist before auction_sales and judicial_sales are
        # written. Only evidence-gated Ministry assignments produce rows here.
        _postgrest_upsert(
            str(url),
            str(key),
            "tribunals",
            tribunal_rows,
            on_conflict="code",
        )
    if _PUBLICATION_CONNECTION.get() is not None:
        _transaction_write("auction_sales", payload, "source_url")
        _write_fact_claims_postgres(sales, _PUBLICATION_CONNECTION.get())
    else:
        _upsert_with_rest(str(url), str(key), payload)
        _write_fact_claims_rest(str(url), str(key), sales)
    _sync_normalized_sale_tables_with_rest(
        str(url),
        str(key),
        sales,
        now,
        refresh_last_seen=refresh_last_seen,
    )
    _upsert_asset_tables_with_rest(str(url), str(key), sales, now)
    _enqueue_due_enrichment(sales, str(url), str(key))
    if refresh_last_seen and _PUBLICATION_CONNECTION.get() is not None:
        from src.collection_evidence import record_sale_decisions
        for run_id in {sale.last_run_id for sale in sales if sale.last_run_id}:
            run_sales = [sale for sale in sales if sale.last_run_id == run_id]
            record_sale_decisions(str(run_id), [sale for sale in run_sales if not quarantine_reason(sale)],
                                  decision="published", connection=_PUBLICATION_CONNECTION.get())
            for sale in (sale for sale in run_sales if quarantine_reason(sale)):
                record_sale_decisions(str(run_id), [sale], decision="quarantined",
                                      reason=quarantine_reason(sale), connection=_PUBLICATION_CONNECTION.get())
    return sum(not quarantine_reason(sale) for sale in sales)


FACT_CLAIMS_COLUMNS = (
    "id",
    "auction_sale_id",
    "field_key",
    "value_jsonb",
    "claim_status",
    "evidence_kind",
    "source_url",
    "evidence_locator",
    "confidence_score",
    "extractor_name",
    "extractor_version",
)
FACT_CLAIMS_RETRY_JOB_TYPE = "fact_claims"
FACT_CLAIMS_RETRY_VERSION = "fact_claims_rest_v2"


class _FactClaimRetryQueueUnavailable(RuntimeError):
    """The one allowed queue insertion did not create durable retry work."""


def _write_fact_claims_postgres(sales: list[AuctionSale], connection: Any) -> int:
    """Insert source-backed candidates in the publication transaction.

    The claim table is introduced after the catalogue tables and is therefore
    checked explicitly.  This keeps older disposable databases usable while a
    migration is rolling out; once present, a failed insert aborts the same
    transaction as the parent sale write.
    """
    eligible_sales = [sale for sale in sales if build_fact_claim_candidates(sale)]
    if not eligible_sales or sql is None or Jsonb is None:
        return 0
    relation = connection.execute("select to_regclass('public.auction_fact_claims')")
    relation_row = relation.fetchone() if relation is not None and hasattr(relation, "fetchone") else None
    if not relation_row or not relation_row[0]:
        return 0
    sale_ids = _sale_ids_for_connection(connection, eligible_sales)
    rows = [
        row
        for sale in eligible_sales
        for row in materialize_fact_claim_rows(sale, sale_ids.get(sale.source_url, ""))
    ]
    if not rows:
        return 0
    _insert_fact_claim_rows(connection, rows)
    LOGGER.info("Fact claims candidates persisted source=postgres rows=%s sales=%s", len(rows), len(eligible_sales))
    return len(rows)


def _write_fact_claims_rest(
    supabase_url: str,
    api_key: str,
    sales: list[AuctionSale],
    *,
    queue_on_failure: bool = True,
) -> int:
    """Persist candidates through PostgREST when direct Postgres is unavailable.

    The catalogue write happens before this additive evidence write on the REST
    path, so a transient PostgREST failure must not make the caller republish
    the catalogue.  Keep the direct attempt bounded, then leave one durable
    job in the existing enrichment queue.  The queue worker retries this
    narrow write without invoking the LLM or rewriting the sale.
    """
    eligible_sales = [sale for sale in sales if build_fact_claim_candidates(sale)]
    if not eligible_sales:
        return 0
    rows: list[dict[str, object]] = []
    try:
        sale_ids = _sale_ids_for_rest(supabase_url, api_key, eligible_sales)
        missing_sales = [sale for sale in eligible_sales if not sale_ids.get(sale.source_url)]
        rows = [
            row
            for sale in eligible_sales
            for row in materialize_fact_claim_rows(sale, sale_ids.get(sale.source_url, ""))
        ]
        if not rows:
            raise RuntimeError("Canonical auction sale id unavailable for fact claims")
        _write_fact_claim_rows_rest(supabase_url, api_key, rows)
        if missing_sales:
            if not queue_on_failure:
                raise RuntimeError("Canonical auction sale id unavailable for fact claims replay")
            missing_queued = _queue_fact_claim_retry_rest(
                supabase_url,
                api_key,
                missing_sales,
                [],
                failure=RuntimeError("Incomplete canonical auction sale id lookup"),
            )
            if not missing_queued:
                raise _FactClaimRetryQueueUnavailable(
                    "Fact claims retry queue unavailable for incomplete canonical sale lookup"
                )
            LOGGER.warning(
                "Fact claims publication deferred for sales with incomplete target lookup queued=%s rows=%s missing_sales=%s",
                missing_queued,
                len(rows),
                len(missing_sales),
            )
        LOGGER.info("Fact claims candidates persisted source=rest rows=%s sales=%s", len(rows), len(eligible_sales))
        return len(rows)
    except _FactClaimRetryQueueUnavailable:
        raise
    except (httpx.HTTPError, RuntimeError, ValueError, TypeError) as exc:
        if not queue_on_failure:
            raise
        queued = _queue_fact_claim_retry_rest(
            supabase_url,
            api_key,
            eligible_sales,
            rows,
            failure=exc,
        )
        # Fact claims are additive telemetry. A transient claims endpoint must
        # not turn a successfully published catalogue row into a retry storm,
        # but it must remain visible and replayable when the queue is available.
        LOGGER.warning(
            "Fact claims publication deferred after catalogue write: error=%s queued=%s rows=%s sales=%s",
            type(exc).__name__,
            queued,
            len(rows),
            len(eligible_sales),
        )
        if not queued:
            raise _FactClaimRetryQueueUnavailable(
                "Fact claims publication failed and retry queue insertion was unavailable"
            ) from exc
        return 0


def retry_fact_claims_to_supabase(
    sale: AuctionSale,
    *,
    snapshot: object | None = None,
) -> int:
    """Replay one queued REST claim write without creating another queue row.

    New jobs carry the exact candidate rows that failed to publish. Resolve the
    current canonical sale id before re-keying those rows, so a deleted and
    recreated sale cannot receive claims under a stale UUID. Legacy jobs with
    no snapshot fall back to the current sale payload, but an empty candidate
    set is an explicit failure rather than a silently successful replay.
    """
    settings = load_settings()
    url = settings.get("supabase_url")
    key = settings.get("supabase_service_role_key")
    if not url or not key:
        raise RuntimeError("Supabase variables are missing; fact claims cannot be replayed")
    if snapshot is None:
        if not build_fact_claim_candidates(sale):
            raise RuntimeError("Fact claims replay snapshot is unavailable and current candidates are empty")
        written = _write_fact_claims_rest(str(url), str(key), [sale], queue_on_failure=False)
    else:
        sale_ids = _sale_ids_for_rest(str(url), str(key), [sale])
        canonical_sale_id = sale_ids.get(sale.source_url)
        if not canonical_sale_id:
            raise RuntimeError("Canonical auction sale id unavailable for fact claims replay")
        rows = _materialize_fact_claim_snapshot(snapshot, canonical_sale_id)
        if not rows:
            raise RuntimeError("Fact claims replay snapshot is malformed or empty")
        written = _write_fact_claim_rows_rest(str(url), str(key), rows)
    if written <= 0:
        raise RuntimeError("Fact claims replay produced no persisted rows")
    return written


def _write_fact_claim_rows_rest(
    supabase_url: str,
    api_key: str,
    rows: list[dict[str, object]],
) -> int:
    """Write materialized candidate rows with no queue side effects."""
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/auction_fact_claims"
    for batch in _postgrest_batches(rows, _postgrest_batch_size("auction_fact_claims")):
        response = _postgrest_request_with_retries(
            "POST",
            endpoint,
            table="auction_fact_claims",
            params={"on_conflict": "id"},
            headers=_rest_headers(api_key, prefer="resolution=ignore-duplicates,return=minimal"),
            json=_sanitize_postgrest_payload(batch),
            timeout=POSTGREST_TIMEOUT,
        )
        if response.is_error:
            raise httpx.HTTPStatusError(
                f"{response.status_code} response from Supabase auction_fact_claims: {response.text}",
                request=response.request,
                response=response,
            )
    return len(rows)


def _materialize_fact_claim_snapshot(
    snapshot: object,
    canonical_sale_id: str,
) -> list[dict[str, object]]:
    """Re-key a queued candidate snapshot for the current canonical sale id."""
    try:
        normalized_sale_id = str(UUID(str(canonical_sale_id)))
    except (TypeError, ValueError, AttributeError):
        raise RuntimeError("Fact claims replay received an invalid canonical sale id") from None
    if not isinstance(snapshot, list):
        raise RuntimeError("Fact claims replay snapshot must be a JSON array")

    rows: list[dict[str, object]] = []
    for candidate in snapshot:
        if not isinstance(candidate, dict):
            raise RuntimeError("Fact claims replay snapshot contains a non-object candidate")
        required = (
            "field_key",
            "value_jsonb",
            "evidence_kind",
            "source_url",
            "evidence_locator",
            "confidence_score",
            "extractor_name",
            "extractor_version",
        )
        missing = [key for key in required if key not in candidate]
        if missing:
            raise RuntimeError(
                "Fact claims replay snapshot candidate is missing " + ", ".join(missing)
            )
        identity = json.dumps(
            {
                "version": FACT_CLAIMS_VERSION,
                "auction_sale_id": normalized_sale_id,
                "field_key": candidate["field_key"],
                "value_jsonb": candidate["value_jsonb"],
                "source_url": candidate["source_url"],
                "evidence_locator": candidate["evidence_locator"],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        rows.append(
            {
                "id": str(uuid5(FACT_CLAIMS_NAMESPACE, identity)),
                "auction_sale_id": normalized_sale_id,
                "field_key": candidate["field_key"],
                "value_jsonb": candidate["value_jsonb"],
                "claim_status": "candidate",
                "evidence_kind": candidate["evidence_kind"],
                "source_url": candidate["source_url"],
                "evidence_locator": candidate["evidence_locator"],
                "confidence_score": candidate["confidence_score"],
                "extractor_name": candidate["extractor_name"],
                "extractor_version": candidate["extractor_version"],
            }
        )
    return rows


def _queue_fact_claim_retry_rest(
    supabase_url: str,
    api_key: str,
    sales: list[AuctionSale],
    rows: list[dict[str, object]],
    *,
    failure: Exception,
) -> bool:
    """Queue one deterministic retry per sale with a single best-effort request.

    The normal claim writer already spent its bounded retry budget. Retrying the
    queue insert with the same policy would double the load during an outage,
    so this fallback makes exactly one request. The candidate snapshot is kept
    on the service-role-only job row; replay rekeys it to the canonical sale id
    and does not depend on the sale's mutable raw payload. The unique queue key
    and claim UUIDs make repeated publication idempotent.
    """
    jobs: list[dict[str, object]] = []
    for sale in sales:
        # Rebuild this sale's candidate set independently of materialized rows.
        # Two sales can share an observed source URL; filtering one batch's
        # rows by URL would otherwise assign one sale's evidence to the other.
        # Candidate rows deliberately omit the canonical id; replay resolves
        # that id at the moment of publication.
        sale_rows = build_fact_claim_candidates(sale)
        if not sale_rows:
            continue
        jobs.append(
            {
                "source_url": sale.source_url,
                "job_type": FACT_CLAIMS_RETRY_JOB_TYPE,
                "priority": 35,
                "input_hash": _fact_claim_retry_input_hash(sale_rows),
                "fact_claims_snapshot": sale_rows,
            }
        )
    if not jobs:
        LOGGER.error(
            "Fact claims retry queue skipped because no candidates were available error=%s",
            type(failure).__name__,
        )
        return False

    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/auction_enrichment_jobs"
    try:
        response = httpx.post(
            endpoint,
            params={"on_conflict": "source_url,job_type,input_hash"},
            headers=_rest_headers(api_key, prefer="resolution=ignore-duplicates,return=minimal"),
            json=_sanitize_postgrest_payload(jobs),
            timeout=30,
        )
    except httpx.HTTPError as exc:
        LOGGER.error(
            "Fact claims retry queue request failed error=%s original=%s",
            type(exc).__name__,
            type(failure).__name__,
        )
        return False
    if response.is_error:
        LOGGER.error(
            "Fact claims retry queue rejected request status=%s original=%s",
            response.status_code,
            type(failure).__name__,
        )
        return False
    LOGGER.info(
        "Fact claims retry queued jobs=%s rows=%s original=%s",
        len(jobs),
        len(rows),
        type(failure).__name__,
    )
    return True


def _fact_claim_retry_input_hash(rows: list[dict[str, object]]) -> str:
    identity = [
        {
            key: row.get(key)
            for key in (
                "id",
                "auction_sale_id",
                "field_key",
                "value_jsonb",
                "source_url",
                "evidence_locator",
            )
        }
        for row in rows
    ]
    identity.sort(
        key=lambda item: json.dumps(
            item,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    )
    serialized = json.dumps(
        identity,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    return f"{FACT_CLAIMS_RETRY_VERSION}:{digest}"


def _sale_ids_for_connection(connection: Any, sales: list[AuctionSale]) -> dict[str, str]:
    # ``auction_sales`` upserts intentionally omit ``id`` so an incoming
    # stale identifier can never overwrite the database identity. Resolve by
    # the immutable publication key after the parent write instead of trusting
    # the in-memory model's optional id.
    resolved: dict[str, str] = {}
    lookup_urls = [sale.source_url for sale in sales if sale.source_url]
    if not lookup_urls:
        return resolved
    result = connection.execute(
        "select id::text, source_url from public.auction_sales where source_url = any(%s)",
        (sorted(set(lookup_urls)),),
    )
    rows = result.fetchall() if result is not None and hasattr(result, "fetchall") else []
    for row in rows:
        if len(row) >= 2 and _is_uuid(row[0]) and row[1]:
            resolved[str(row[1])] = str(UUID(str(row[0])))
    return resolved


def _sale_ids_for_rest(supabase_url: str, api_key: str, sales: list[AuctionSale]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    # The REST upsert also omits ``id``. Always read the committed parent row
    # by source_url so a stale in-memory UUID cannot misattach a claim.
    lookup_urls = [sale.source_url for sale in sales if sale.source_url]
    if not lookup_urls:
        return resolved
    response = _postgrest_request_with_retries(
        "GET",
        f"{supabase_url.rstrip('/')}/rest/v1/auction_sales",
        table="auction_sales_fact_claim_targets",
        params={"select": "id,source_url", "source_url": _postgrest_in_filter(sorted(set(lookup_urls)))},
        headers=_rest_headers(api_key, prefer="count=none"),
        timeout=POSTGREST_TIMEOUT,
    )
    if response.is_error:
        raise httpx.HTTPStatusError(
            f"{response.status_code} response from Supabase auction_sales", request=response.request, response=response
        )
    payload = response.json()
    if not isinstance(payload, list):
        raise ValueError("Malformed auction_sales fact-claim target response")
    for row in payload:
        if isinstance(row, dict) and _is_uuid(row.get("id")) and row.get("source_url"):
            resolved[str(row["source_url"])] = str(UUID(str(row["id"])))
    return resolved


def _insert_fact_claim_rows(connection: Any, rows: list[dict[str, object]]) -> None:
    columns = list(FACT_CLAIMS_COLUMNS)
    names = sql.SQL(", ").join(sql.Identifier(column) for column in columns)
    statement = sql.SQL(
        "insert into {} ({}) select {} from jsonb_populate_recordset(null::{}, %s) "
        "on conflict (id) do nothing"
    ).format(
        sql.Identifier("public", "auction_fact_claims"),
        names,
        names,
        sql.Identifier("public", "auction_fact_claims"),
    )
    connection.execute(statement, (Jsonb(_sanitize_postgrest_payload(rows)),))


def _is_uuid(value: object) -> bool:
    try:
        UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return False
    return True


def _guard_enrichment_revision(connection, sales: list[AuctionSale]) -> list[AuctionSale]:
    """Lock and compare before *any* parent/child write; never recreate a deleted sale."""
    retained = []
    for sale in sorted(sales, key=lambda item: item.source_url):
        current = connection.execute(
            "select updated_at from public.auction_sales where source_url=%s for update",
            (sale.source_url,),
        ).fetchone()
        if current is None or sale.updated_at is None or current[0] != sale.updated_at:
            LOGGER.warning("Discarding obsolete enrichment for %s", sale.source_url)
            continue
        retained.append(sale)
    return retained


def delete_secondary_sales_in_supabase(sales: list[AuctionSale]) -> int:
    """Delete merged source rows only from the post-bridge cleanup phase.

    ``upsert_sales_to_supabase`` deliberately performs no deletion: callers
    must first preserve every catalogue row in the Outcome Graph. The database
    deletion guard remains the final fail-closed protection.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    secondary_urls = _secondary_source_urls(sales)
    if not url or not key or not secondary_urls:
        return 0
    reviewed_aliases = _fetch_reviewed_alias_registry(str(url), str(key))
    protected_urls = reviewed_aliases.protected_source_urls()
    secondary_urls = [source_url for source_url in secondary_urls if source_url not in protected_urls]
    if not secondary_urls:
        return 0

    if db_url:
        try:
            return _delete_secondary_sale_rows_with_postgres(str(db_url), sales)
        except ReviewedAliasRegistryError:
            raise
        except Exception as exc:
            LOGGER.warning(
                "Direct Postgres secondary sale cleanup failed; falling back to REST: %s",
                exc,
            )
    return _delete_secondary_sale_rows(str(url), str(key), sales, registry=reviewed_aliases)


def upsert_cadastre_parcels_to_supabase(rows: list[dict[str, object]]) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; skipping cadastre upsert")
        return 0

    now = datetime.now(UTC).isoformat()
    payload = _deduplicate_conflict_rows([
        _timestamped(dict(row), now)
        for row in rows
        if row.get("source_url") and row.get("parcel_key")
    ], ("source_url", "parcel_key"))
    if not payload:
        return 0

    _postgrest_upsert(
        str(url),
        str(key),
        "auction_cadastre_parcels",
        payload,
        on_conflict="source_url,parcel_key",
    )
    return len(payload)


def upsert_dpe_diagnostics_to_supabase(rows: list[dict[str, object]]) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; skipping DPE upsert")
        return 0

    now = datetime.now(UTC).isoformat()
    payload = _deduplicate_conflict_rows([
        _timestamped(dict(row), now)
        for row in rows
        if row.get("source_url") and row.get("diagnostic_number")
    ], ("source_url", "diagnostic_number"))
    if not payload:
        return 0

    _postgrest_upsert(
        str(url),
        str(key),
        "auction_dpe_diagnostics",
        payload,
        on_conflict="source_url,diagnostic_number",
    )
    return len(payload)


def _deduplicate_conflict_rows(
    rows: list[dict[str, object]], key_columns: tuple[str, ...],
) -> list[dict[str, object]]:
    """Match the result of sequential upserts before sending one PostgREST batch."""
    unique: dict[tuple[object, ...], dict[str, object]] = {}
    for row in rows:
        conflict_key = tuple(row[column] for column in key_columns)
        unique[conflict_key] = {**unique.get(conflict_key, {}), **row}
    if len(unique) != len(rows):
        LOGGER.info("Collapsed %s duplicate upsert rows for %s", len(rows) - len(unique), key_columns)
    return list(unique.values())


def create_run_in_supabase(source: str, use_llm: bool, run_id: str | None = None) -> str | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return None
    if run_id:
        return start_existing_run_in_supabase(run_id, source, use_llm)
    now = datetime.now(UTC).isoformat()
    payload = {
        "status": "running",
        "source": source,
        "use_llm": use_llm,
        "started_at": now,
        "updated_at": now,
    }
    response = _postgrest_request_with_retries(
        "POST",
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        "auction_runs",
        headers=_rest_headers(str(key), prefer="return=representation"),
        json=payload,
        timeout=POSTGREST_TIMEOUT,
    )
    if response.is_error:
        LOGGER.warning("Supabase run creation failed: %s", response.text)
        return None
    rows = response.json()
    return rows[0]["id"] if rows else None


def start_existing_run_in_supabase(run_id: str, source: str, use_llm: bool) -> str | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return run_id
    now = datetime.now(UTC).isoformat()
    payload = {
        "status": "running",
        "source": source,
        "use_llm": use_llm,
        "started_at": now,
        "finished_at": None,
        "updated_at": now,
    }
    try:
        response = _postgrest_request_with_retries(
            "PATCH",
            f"{str(url).rstrip('/')}/rest/v1/auction_runs",
            "auction_runs",
            params={"id": f"eq.{run_id}"},
            headers=_rest_headers(str(key), prefer="return=minimal"),
            json=payload,
            timeout=POSTGREST_TIMEOUT,
        )
    except httpx.TransportError as exc:
        LOGGER.warning("Supabase run start transport failed: %s", exc)
        response = None
    if response is None or response.is_error:
        if response is not None:
            LOGGER.warning("Supabase run start failed (%s): %s", response.status_code, response.text[:200])
        if (response is None or response.status_code in POSTGREST_RETRYABLE_STATUS_CODES) and settings.get("supabase_db_url"):
            with _postgres_connect(str(settings["supabase_db_url"])) as db:
                row = db.execute(
                    """update public.auction_runs
                       set status='running', source=%s, use_llm=%s, started_at=now(),
                           finished_at=null, updated_at=now()
                       where id=%s returning id""",
                    (source, use_llm, run_id),
                ).fetchone()
            return run_id if row else None
        return None
    return run_id


def fetch_next_queued_run_from_supabase() -> dict[str, Any] | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; no queued run can be fetched")
        return None
    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={
            "select": "id,status,source,use_llm,started_at,created_at,summary,errors",
            "status": "eq.queued",
            "order": "created_at.asc",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="return=representation"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase queued run fetch failed: %s", response.text)
        return None
    rows = response.json()
    if not rows:
        return None
    return rows[0]


ENRICHMENT_QUEUE_FAMILIES = frozenset({'source_detail', 'enrichment'})


class QueueClaimDeferred(RuntimeError):
    """A provider requested a wait longer than this worker may block."""

    def __init__(self, request_id: str, retry_not_before: datetime):
        self.request_id = request_id
        self.retry_not_before = retry_not_before
        super().__init__(f"Supabase queue claim deferred until {retry_not_before.isoformat()}")


def _claim_auction_enrichment_jobs_rpc(
    rpc_name: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return []
    response = httpx.post(
        f"{str(url).rstrip('/')}/rest/v1/rpc/{rpc_name}",
        headers=_rest_headers(str(key), prefer="return=representation"),
        json=payload,
        timeout=30,
    )
    if response.is_error:
        response.raise_for_status()
    rows = response.json()
    return [row for row in rows if isinstance(row, dict)]


def claim_auction_enrichment_jobs_from_supabase(
    limit: int = 10,
    *,
    family: str | None = None,
) -> list[dict[str, Any]]:
    """Claim through the historical RPC, or one explicit family when given."""
    if family is not None:
        return claim_auction_enrichment_jobs_family_from_supabase(family=family, limit=limit)
    return _claim_auction_enrichment_jobs_rpc(
        "claim_auction_enrichment_jobs",
        {"p_limit": max(1, min(100, int(limit)))},
    )


def has_eligible_pdf_job_for_sale(source_url: str) -> bool:
    """Check whether a PDF prerequisite can still advance for this sale."""

    return any(
        row.get("status") == "running"
        or int(row.get("attempt_count") or 0) < int(row.get("max_attempts") or 0)
        for row in read_pdf_job_states_for_sale(source_url)
    )


def read_pdf_job_states_for_sale(
    source_url: str,
    *,
    include_terminal: bool = False,
) -> list[dict[str, object]]:
    """Read current PDF retry states without changing queue state.

    The fact worker uses this only to distinguish a genuinely exhausted PDF
    revision from a missing/stale queue row. An empty result deliberately
    remains inconclusive and must not cancel the fact job.
    """

    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        raise RuntimeError("Supabase credentials are required to inspect PDF prerequisites")
    params = {
        "select": "id,status,attempt_count,max_attempts,input_hash,created_at,updated_at",
        "source_url": f"eq.{source_url}",
        "job_type": "eq.pdf",
        "order": "created_at.desc",
        "limit": "100",
    }
    if not include_terminal:
        params["status"] = "in.(queued,running,failed)"
    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_enrichment_jobs",
        params=params,
        headers=_rest_headers(str(key), prefer="return=representation"),
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []


def claim_auction_enrichment_jobs_family_from_supabase(
    family: str,
    limit: int = 1,
) -> list[dict[str, Any]]:
    """Claim one explicit queue family through the idempotent fairness RPC."""
    normalized_family = str(family or "").strip().lower()
    if normalized_family not in ENRICHMENT_QUEUE_FAMILIES:
        raise ValueError(f"Unknown enrichment queue family: {family!r}")
    return _claim_auction_enrichment_jobs_request_rpc(
        normalized_family,
        max(1, min(100, int(limit))),
    )


def _claim_auction_enrichment_jobs_request_rpc(
    family: str,
    limit: int,
) -> list[dict[str, Any]]:
    """Claim one family with a stable UUID across transient HTTP retries.

    The database receipt makes a retry after a committed lease reservation
    replay-only.  A new UUID4 is created once per logical call, never per HTTP
    attempt, so a lost response cannot reserve another queue slot.
    """
    request_id = str(uuid.uuid4())
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return []

    endpoint = f"{str(url).rstrip('/')}/rest/v1/rpc/claim_auction_enrichment_jobs_request"
    payload = {
        "p_request_id": request_id,
        "p_family": family,
        "p_limit": limit,
    }
    for attempt in range(1, CLAIM_RPC_ATTEMPTS + 1):
        try:
            response = httpx.post(
                endpoint,
                headers=_rest_headers(str(key), prefer="return=representation"),
                json=payload,
                timeout=30,
            )
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
            if attempt == CLAIM_RPC_ATTEMPTS:
                raise
            delay = CLAIM_RPC_RETRY_DELAYS[attempt - 1]
            LOGGER.warning(
                "Supabase queue claim transport failed on attempt %s/%s; retrying in %.1fs",
                attempt,
                CLAIM_RPC_ATTEMPTS,
                delay,
            )
            time.sleep(delay)
            continue

        if not response.is_error:
            rows = response.json()
            return [row for row in rows if isinstance(row, dict)]

        diagnostic = _claim_error_diagnostic(response)
        if response.status_code not in POSTGREST_RETRYABLE_STATUS_CODES:
            LOGGER.error(
                "Supabase queue claim failed with HTTP %s on attempt %s/%s: %s",
                response.status_code,
                attempt,
                CLAIM_RPC_ATTEMPTS,
                diagnostic,
            )
            response.raise_for_status()

        retry_after = _claim_retry_after_seconds(response.headers.get("Retry-After"))
        if retry_after is not None and retry_after > CLAIM_RPC_MAX_WAIT_SECONDS:
            retry_not_before = datetime.now(UTC) + timedelta(seconds=retry_after)
            try:
                persisted_not_before = _persist_queue_claim_backoff(
                    settings,
                    retry_not_before,
                )
            except Exception as exc:
                # A long provider delay is only safe to hand to the next
                # worker after it is durable.  Do not silently turn a failed
                # direct write into an unpersisted new-UUID retry.
                LOGGER.exception(
                    "Could not persist queue claim backoff after HTTP %s; request_id=%s",
                    response.status_code,
                    request_id,
                )
                raise RuntimeError(
                    "Cannot persist provider queue claim backoff"
                ) from exc
            LOGGER.warning(
                "Supabase queue claim deferred until %s after HTTP %s Retry-After; request_id=%s",
                persisted_not_before.isoformat(),
                response.status_code,
                request_id,
            )
            raise QueueClaimDeferred(request_id, persisted_not_before)
        if attempt == CLAIM_RPC_ATTEMPTS:
            LOGGER.error(
                "Supabase queue claim failed with HTTP %s on attempt %s/%s: %s",
                response.status_code,
                attempt,
                CLAIM_RPC_ATTEMPTS,
                diagnostic,
            )
            response.raise_for_status()

        delay = max(CLAIM_RPC_RETRY_DELAYS[attempt - 1], retry_after or 0.0)
        LOGGER.warning(
            "Supabase queue claim returned HTTP %s on attempt %s/%s; retrying in %.1fs: %s",
            response.status_code,
            attempt,
            CLAIM_RPC_ATTEMPTS,
            delay,
            diagnostic,
        )
        time.sleep(delay)

    raise RuntimeError("Supabase queue claim failed before request")


def _persist_queue_claim_backoff(
    settings: dict[str, Any],
    retry_not_before: datetime,
) -> datetime:
    """Persist the provider-wide claim gate through the transactional DB.

    The REST endpoint can be the component returning a long Retry-After, so
    this write deliberately uses the existing direct Postgres path.  The
    advisory lock is shared with the claim RPC: a new lease cannot be claimed
    between the gate check and this update.  ``GREATEST`` keeps a concurrent
    or older response from shortening either the durable gate or the next
    scheduler tick.
    """
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required for queue claim backoff")
    if psycopg is None:
        raise RuntimeError("psycopg is required for queue claim backoff")
    with _postgres_connect(db_url) as connection:
        connection.execute(
            "select pg_advisory_xact_lock(hashtextextended(%s, 0))",
            ("immojudis:queue-claim-backoff",),
        )
        row = connection.execute(
            """
            update public.auction_pipeline_control
               set queue_claim_not_before = greatest(
                     coalesce(queue_claim_not_before, %s), %s
                   ),
                   next_enrichment_at = greatest(next_enrichment_at, %s),
                   updated_at = statement_timestamp()
             where id
         returning queue_claim_not_before
            """,
            (retry_not_before, retry_not_before, retry_not_before),
        ).fetchone()
        if not row:
            raise RuntimeError("auction_pipeline_control singleton is missing")
        return row[0]


def _claim_error_diagnostic(response: httpx.Response, max_chars: int = 256) -> str:
    """Log only bounded PostgREST code/message fields, never raw response data."""
    try:
        payload = response.json()
    except Exception:  # pragma: no cover - defensive for test doubles.
        return f"http_{response.status_code}"
    if isinstance(payload, dict):
        fields = [
            str(payload[key]).replace("\x00", " ")
            for key in ("code", "message")
            if payload.get(key) not in (None, "")
        ]
        sanitized = " ".join(" ".join(fields).split())
    else:
        sanitized = f"http_{response.status_code}"
    if not sanitized:
        sanitized = f"http_{response.status_code}"
    return sanitized[:max_chars]


def _claim_retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=UTC)
            seconds = (retry_at - datetime.now(UTC)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            return None
    if not math.isfinite(seconds):
        return None
    if seconds < 0:
        return 0.0
    return seconds


def record_llm_usage_event(event: dict[str, Any]) -> None:
    """Persist LLM telemetry without storing prompts or source documents."""
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return
    try:
        response = httpx.post(
            f"{str(url).rstrip('/')}/rest/v1/llm_usage_events",
            headers=_rest_headers(str(key), prefer="return=minimal"),
            json=event,
            timeout=15,
        )
        response.raise_for_status()
    except Exception as exc:
        LOGGER.warning("Could not persist LLM usage telemetry: %s", exc)


def llm_usage_budget_available(max_calls_per_hour: int) -> bool:
    """Return false when the configured hourly prediction budget is exhausted."""
    if max_calls_per_hour <= 0:
        return True
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return True
    try:
        response = httpx.get(
            f"{str(url).rstrip('/')}/rest/v1/llm_usage_events",
            params={
                "select": "id",
                "created_at": f"gte.{(datetime.now(UTC) - timedelta(hours=1)).isoformat()}",
                "limit": str(max_calls_per_hour + 1),
            },
            headers={**_rest_headers(str(key)), "Prefer": "count=exact"},
            timeout=15,
        )
        response.raise_for_status()
        count_text = response.headers.get("content-range", "").rsplit("/", 1)[-1]
        return count_text == "*" or int(count_text) < max_calls_per_hour
    except Exception as exc:
        LOGGER.warning("Could not check LLM usage budget: %s", exc)
        return True


def finish_auction_enrichment_job_in_supabase(
    job_id: str,
    *,
    succeeded: bool,
    cancelled: bool = False,
    error_message: str | None = None,
    attempt_count: int | None = None,
    locked_at: str | datetime | None = None,
    retry_not_before: str | datetime | None = None,
) -> bool:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key or not job_id:
        return False
    now = datetime.now(UTC)
    status = "cancelled" if cancelled else ("completed" if succeeded else "failed")
    payload: dict[str, Any] = {
        "status": status,
        "completed_at": now.isoformat() if succeeded else None,
        "locked_at": None,
        "last_error": None if succeeded else (error_message or "enrichment failed")[:1000],
        "updated_at": now.isoformat(),
    }
    if not succeeded and not cancelled:
        retry_at = now + timedelta(minutes=30)
        if retry_not_before:
            try:
                requested = retry_not_before if isinstance(retry_not_before, datetime) else datetime.fromisoformat(str(retry_not_before).replace('Z', '+00:00'))
                if requested.tzinfo is not None:
                    retry_at = max(retry_at, requested)
            except ValueError:
                pass
        payload["next_attempt_at"] = retry_at.isoformat()
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/auction_enrichment_jobs",
        params={"select": "id", "id": f"eq.{job_id}", "status": "eq.running",
                **({"locked_at": f"eq.{locked_at.isoformat() if isinstance(locked_at, datetime) else locked_at}"} if locked_at is not None else {}),
                **({"attempt_count": f"eq.{attempt_count}"} if attempt_count is not None else {})},
        headers=_rest_headers(str(key), prefer="return=representation"),
        json=payload,
        timeout=30,
    )
    if response.is_error:
        response.raise_for_status()
    try:
        rows = response.json()
    except (AttributeError, TypeError, ValueError):
        return False
    return (
        isinstance(rows, list)
        and len(rows) == 1
        and isinstance(rows[0], dict)
        and str(rows[0].get("id") or "") == job_id
    )


def fetch_next_data_refresh_request_from_supabase() -> dict[str, Any] | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        LOGGER.info("Supabase variables are missing; no data refresh request can be fetched")
        return None
    endpoint = f"{str(url).rstrip('/')}/rest/v1/data_refresh_requests"
    response = httpx.get(
        endpoint,
        params={
            "select": "id,user_id,sale_id,source_url,request_kind,status,priority,requested_payload,created_at",
            "status": "eq.queued",
            "order": "priority.desc,created_at.asc",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="return=representation"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase data refresh request fetch failed: %s", response.text)
        return None
    rows = response.json()
    if not rows:
        return None

    request = rows[0]
    started_at = datetime.now(UTC).isoformat()
    patch = httpx.patch(
        endpoint,
        params={"id": f"eq.{request['id']}", "status": "eq.queued"},
        headers=_rest_headers(str(key), prefer="return=representation"),
        json={
            "status": "running",
            "started_at": started_at,
            "updated_at": started_at,
        },
        timeout=30,
    )
    if patch.is_error:
        LOGGER.warning("Supabase data refresh request lock failed: %s", patch.text)
        return None
    locked_rows = patch.json()
    return locked_rows[0] if locked_rows else {**request, "status": "running", "started_at": started_at}


def finish_data_refresh_request_in_supabase(
    request_id: str | None,
    status: str,
    result_summary: dict[str, Any] | None = None,
    error_message: str | None = None,
) -> None:
    if not request_id:
        return
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return
    now = datetime.now(UTC).isoformat()
    payload = {
        "status": status,
        "result_summary": result_summary or {},
        "error_message": error_message,
        "completed_at": now if status in {"completed", "failed", "cancelled"} else None,
        "updated_at": now,
    }
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/data_refresh_requests",
        params={"id": f"eq.{request_id}"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=_sanitize_postgrest_payload(payload),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase data refresh request finish failed: %s", response.text)


def fail_stale_running_runs_in_supabase(max_age_minutes: int = 190) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0

    cutoff = datetime.now(UTC) - timedelta(minutes=max_age_minutes)
    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={
            "select": "id,summary,errors,started_at",
            "status": "eq.running",
            "started_at": f"lt.{cutoff.isoformat()}",
        },
        headers=_rest_headers(str(key), prefer="count=none"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase stale run fetch failed: %s", response.text)
        return 0

    rows = response.json()
    for row in rows:
        run_id = str(row.get("id") or "")
        if not run_id:
            continue
        summary = row.get("summary") if isinstance(row.get("summary"), dict) else {}
        errors = row.get("errors") if isinstance(row.get("errors"), dict) else {}
        runner_errors = errors.get("runner") if isinstance(errors.get("runner"), list) else []
        runner_errors = [
            *runner_errors,
            f"Run marqué failed automatiquement après {max_age_minutes} min sans fin GitHub Actions.",
        ]
        summary = {
            **summary,
            "stale_cleanup": {
                "max_age_minutes": max_age_minutes,
                "started_at": row.get("started_at"),
                "cleaned_at": datetime.now(UTC).isoformat(),
            },
        }
        finish_run_in_supabase(run_id, "failed", summary, {**errors, "runner": runner_errors})
    return len(rows)


def has_active_running_run_in_supabase(max_age_minutes: int = 190) -> bool:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return False

    cutoff = datetime.now(UTC) - timedelta(minutes=max_age_minutes)
    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={
            "select": "id",
            "status": "eq.running",
            "started_at": f"gte.{cutoff.isoformat()}",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="count=none"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase active run fetch failed: %s", response.text)
        return False
    return bool(response.json())


def finish_run_in_supabase(
    run_id: str | None,
    status: str,
    summary: dict[str, Any],
    errors: dict[str, list[str]] | None = None,
) -> None:
    if not run_id:
        return
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return
    now = datetime.now(UTC).isoformat()
    payload = {
        "status": status,
        "finished_at": now,
        "updated_at": now,
        "summary": summary,
        "errors": errors or {},
    }
    try:
        response = _postgrest_request_with_retries(
            "PATCH",
            f"{str(url).rstrip('/')}/rest/v1/auction_runs",
            "auction_runs",
            params={"id": f"eq.{run_id}"},
            headers=_rest_headers(str(key), prefer="return=minimal"),
            json=_sanitize_postgrest_payload(payload),
            timeout=POSTGREST_TIMEOUT,
        )
    except httpx.TransportError as exc:
        LOGGER.warning("Supabase run finish transport failed: %s", exc)
        response = None
    if response is None or response.is_error:
        if response is not None:
            LOGGER.warning("Supabase run finish failed (%s): %s", response.status_code, response.text[:200])
        if (response is None or response.status_code in POSTGREST_RETRYABLE_STATUS_CODES) and settings.get("supabase_db_url"):
            with _postgres_connect(str(settings["supabase_db_url"])) as db:
                db.execute(
                    """update public.auction_runs
                       set status=%s, finished_at=now(), updated_at=now(),
                           summary=coalesce(summary,'{}'::jsonb) || %s,
                           errors=coalesce(errors,'{}'::jsonb) || %s
                       where id=%s""",
                    (
                        status,
                        Jsonb(_sanitize_postgrest_payload(summary)),
                        Jsonb(_sanitize_postgrest_payload(errors or {})),
                        run_id,
                    ),
                )


def update_run_progress_in_supabase(
    run_id: str | None,
    summary: dict[str, Any],
    errors: dict[str, list[str]] | None = None,
) -> None:
    if not run_id:
        return
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return
    payload: dict[str, Any] = {
        "summary": summary,
        "updated_at": datetime.now(UTC).isoformat(),
    }
    if errors is not None:
        payload["errors"] = errors
    response = _postgrest_request_with_retries(
        "PATCH",
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        "auction_runs",
        params={"id": f"eq.{run_id}", "status": "eq.running"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=_sanitize_postgrest_payload(payload),
        timeout=POSTGREST_TIMEOUT,
    )
    if response.is_error:
        LOGGER.warning("Supabase run progress update failed: %s", response.text)


def _is_sha256(value: object) -> bool:
    text = clean_text(value) or ""
    return len(text) == 64 and all(character in "0123456789abcdefABCDEF" for character in text)


def _historical_timestamp_is_valid(value: object) -> bool:
    """Accept a persisted verification timestamp without applying the 24h TTL.

    The timestamp describes when the bytes were checked.  Freshness for a new
    extraction remains the responsibility of ``documents_are_current``; this
    guard only rejects malformed or future-dated provenance.
    """
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    return parsed.tzinfo is not None and parsed <= datetime.now(UTC)


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


def _validated_persisted_pdf_manifest(sale: AuctionSale) -> dict[str, object] | None:
    """Validate the complete historical PDF manifest for one reconstructed sale.

    This is deliberately stricter than the normal materialization path.  A
    persisted text fallback is eligible only when every current document has a
    matching profile and cache-proof entry.  It never accepts a mixed/partial
    sibling, a legacy profile, or metadata without a real text hash.
    """
    documents = sale.documents
    if not isinstance(documents, list) or any(not isinstance(document, dict) for document in documents):
        return None
    document_urls = [clean_text(document.get("url")) for document in documents]
    if not document_urls or any(not url for url in document_urls):
        return None
    normalized_document_urls = [str(url) for url in document_urls]
    if len(set(normalized_document_urls)) != len(normalized_document_urls):
        return None
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict):
        return None
    if analysis.get("input_fingerprint") != document_fingerprint(documents):
        return None
    if (
        analysis.get("progress_schema_version") != PDF_PROGRESS_SCHEMA_VERSION
        or analysis.get("manifest_complete") is not True
    ):
        return None
    pending_http = analysis.get("http_revalidation_pending_urls")
    if not isinstance(pending_http, list) or pending_http:
        return None
    if not _historical_timestamp_is_valid(analysis.get("checked_at")):
        return None
    try:
        failed_documents = int(analysis.get("failed_documents") or 0)
    except (OverflowError, TypeError, ValueError):
        return None
    if failed_documents != 0:
        return None

    document_url_set = set(normalized_document_urls)
    excluded_urls: set[str] = set()
    excluded_groups: list[set[str]] = []
    for key in ("blocked_document_urls", "skipped_document_urls", "terminal_document_urls"):
        urls = _manifest_urls(analysis.get(key))
        if urls is None or not urls.issubset(document_url_set):
            return None
        excluded_groups.append(urls)
        excluded_urls.update(urls)
    if any(left & right for index, left in enumerate(excluded_groups) for right in excluded_groups[index + 1:]):
        return None
    # This fallback must never turn a mixed/blocked manifest into a partial
    # materialization.  The ordinary path retains those per-document states;
    # persisted text recovery is reserved for a globally complete manifest.
    if excluded_urls:
        return None
    expected_urls = document_url_set - excluded_urls
    if not expected_urls:
        return None

    proof = analysis.get("cache_proof")
    if not isinstance(proof, dict):
        return None
    if (
        proof.get("version") != 1
        or proof.get("input_fingerprint") != document_fingerprint(documents)
        or not _historical_timestamp_is_valid(proof.get("verified_at"))
    ):
        return None
    proof_documents = proof.get("documents")
    if not isinstance(proof_documents, list):
        return None
    proof_by_url: dict[str, dict[str, object]] = {}
    for item in proof_documents:
        if not isinstance(item, dict):
            return None
        url = clean_text(item.get("url"))
        if not url or url in proof_by_url:
            return None
        proof_by_url[url] = item
    proof_urls = set(proof_by_url)
    if (
        not expected_urls.issubset(proof_urls)
        or not (proof_urls - expected_urls).issubset(excluded_urls)
    ):
        return None

    profiles_payload = analysis.get("profiles")
    if not isinstance(profiles_payload, list):
        return None
    profiles_by_url: dict[str, dict[str, object]] = {}
    for item in profiles_payload:
        if not isinstance(item, dict):
            return None
        url = clean_text(item.get("url"))
        if not url or url in profiles_by_url:
            return None
        profiles_by_url[url] = item
    profile_urls = set(profiles_by_url)
    if (
        not expected_urls.issubset(profile_urls)
        or not (profile_urls - expected_urls).issubset(excluded_urls)
    ):
        return None

    for url in expected_urls:
        proof_item = proof_by_url[url]
        profile = profiles_by_url[url]
        try:
            proof_text_chars = int(proof_item.get("text_chars") or 0)
            profile_text_chars = int(profile.get("text_chars") or 0)
        except (OverflowError, TypeError, ValueError):
            return None
        proof_status = (clean_text(proof_item.get("extraction_status")) or "").casefold()
        profile_status = (clean_text(profile.get("extraction_status")) or "").casefold()
        proof_failed_pages = proof_item.get("failed_pages")
        profile_failed_pages = profile.get("failed_pages")
        if (
            proof_status != "extracted"
            or proof_item.get("complete") is not True
            or bool(proof_failed_pages)
            or proof_item.get("text_present") is not True
            or proof_text_chars <= 0
            or not _is_sha256(proof_item.get("sha256"))
            or not _is_sha256(proof_item.get("text_sha256"))
            or profile_status != "extracted"
            or profile.get("complete") is not True
            or bool(profile_failed_pages)
            or not _is_sha256(profile.get("sha256"))
            or clean_text(profile.get("sha256")) != clean_text(proof_item.get("sha256"))
            or profile_text_chars != proof_text_chars
            or not timestamp_is_fresh(proof_item.get("http_checked_at"))
        ):
            return None

    return {
        "expected_urls": expected_urls,
        "excluded_urls": excluded_urls,
        "terminal_urls": _manifest_urls(analysis.get("terminal_document_urls")) or set(),
        "proof_by_url": proof_by_url,
        "profiles_by_url": profiles_by_url,
        "verified_at": clean_text(proof.get("verified_at")),
    }


def _has_usable_local_pdf_cache(sale: AuctionSale) -> bool:
    """Return true only for a current modern cache with documentary proof.

    Legacy or malformed files must not suppress the SQL recovery path. A
    validated partial modern cache still blocks historical mixing, because the
    extractor can resume from its page records locally.
    """
    payload = _read_json_file(PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json")
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    return _validate_pdf_document_checkpoint_payload(sale, analysis, payload) is not None


def _validated_persisted_pdf_texts(
    sale: AuctionSale,
    extraction_row: dict[str, object],
) -> list[dict[str, object]] | None:
    manifest = _validated_persisted_pdf_manifest(sale)
    if manifest is None:
        return None
    if (
        clean_text(extraction_row.get("source_url")) != sale.source_url
        or extraction_row.get("provider") != PDF_EXTRACTION_PROVIDER
        or extraction_row.get("model") != PDF_EXTRACTION_MODEL
        or extraction_row.get("schema_version") != PDF_EXTRACTION_SCHEMA_VERSION
    ):
        return None
    # ``input_hash`` belongs to the source sale revision and can legitimately
    # change after an operational/factual refresh while the document identity
    # and both persisted byte/text hashes remain unchanged.  The strict
    # document identity is the manifest fingerprint plus the per-document
    # SHA checks below; do not couple this reader to the whole-sale hash.
    result = extraction_row.get("result")
    if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
        return None
    expected_urls = manifest["expected_urls"]
    excluded_urls = manifest["excluded_urls"]
    terminal_urls = manifest["terminal_urls"]
    if not isinstance(expected_urls, set) or not isinstance(excluded_urls, set) or not isinstance(terminal_urls, set):
        return None
    result_by_url: dict[str, dict[str, object]] = {}
    for item in result:
        url = clean_text(item.get("url"))
        if not url or url in result_by_url:
            return None
        result_by_url[url] = item
    result_urls = set(result_by_url)
    if (
        not expected_urls.issubset(result_urls)
        or not (result_urls - expected_urls).issubset(terminal_urls)
    ):
        return None

    proof_by_url = manifest["proof_by_url"]
    if not isinstance(proof_by_url, dict):
        return None
    validated: list[dict[str, object]] = []
    for url in sorted(expected_urls):
        item = result_by_url[url]
        proof_item = proof_by_url.get(url)
        if not isinstance(proof_item, dict):
            return None
        text = clean_text(item.get("text")) or ""
        try:
            text_chars = int(item.get("text_chars") or len(text))
            proof_text_chars = int(proof_item.get("text_chars") or 0)
        except (OverflowError, TypeError, ValueError):
            return None
        computed_text_sha = hashlib.sha256(text.encode("utf-8")).hexdigest() if text else ""
        item_text_sha = clean_text(item.get("text_sha256"))
        if not (
            item.get("cache_version") == PDF_TEXT_CACHE_VERSION
            and (clean_text(item.get("extraction_status")) or "").casefold() == "extracted"
            and item.get("complete") is True
            and not item.get("failed_pages")
            and text
            and text_chars == len(text)
            and text_chars == proof_text_chars
            and clean_text(item.get("sha256")) == clean_text(proof_item.get("sha256"))
            and _is_sha256(item.get("sha256"))
            and _is_sha256(proof_item.get("sha256"))
            and computed_text_sha == clean_text(proof_item.get("text_sha256"))
            and _is_sha256(proof_item.get("text_sha256"))
            and (item_text_sha is None or item_text_sha == computed_text_sha)
        ):
            return None
        sanitized = dict(item)
        # The original local path is not available on the worker that reads
        # this persisted result.  Keep actual text and hashes, but never claim
        # that a path can be opened again.
        sanitized["file_path"] = None
        sanitized["_persisted_pdf_proof"] = True
        sanitized["_persisted_verified_at"] = manifest.get("verified_at")
        validated.append(sanitized)
    return validated


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


def _read_persisted_pdf_rows_rest(
    supabase_url: str,
    api_key: str,
    source_urls: list[str],
) -> list[dict[str, object]]:
    # This lookup is optional recovery work.  It must not inherit the five
    # retry attempts used by durable writes, otherwise a missing/slow cache
    # can consume most of a worker budget before normal pending rows are
    # materialized.
    response = httpx.get(
        f"{supabase_url.rstrip('/')}/rest/v1/auction_extractions",
        params={
            "select": ",".join(_PERSISTED_PDF_ROW_COLUMNS),
            "source_url": _postgrest_in_filter(source_urls),
            "provider": f"eq.{PDF_EXTRACTION_PROVIDER}",
            "model": f"eq.{PDF_EXTRACTION_MODEL}",
            "schema_version": f"eq.{PDF_EXTRACTION_SCHEMA_VERSION}",
            "order": "updated_at.desc",
            "limit": str(min(len(source_urls) * 5, 100)),
        },
        headers=_rest_headers(api_key, prefer="count=none"),
        timeout=PERSISTED_PDF_LOOKUP_TIMEOUT,
    )
    if response.is_error:
        raise RuntimeError(f"Persisted PDF extraction lookup failed ({response.status_code})")
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError("Persisted PDF extraction lookup returned a malformed payload")
    return [normalized for row in payload if (normalized := _normalize_persisted_pdf_row(row)) is not None]


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


def _prepare_pdf_document_checkpoint(
    sale: AuctionSale,
) -> tuple[dict[str, object], list[dict[str, object]]] | None:
    """Return a strict modern checkpoint without accepting legacy cache data."""

    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    payload = _read_json_file(PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json")
    return _validate_pdf_document_checkpoint_payload(sale, analysis, payload)


def _persist_pdf_document_checkpoint_with_connection(
    connection: Any,
    sale: AuctionSale,
    analysis: dict[str, object],
    result: list[dict[str, object]],
    *,
    pdf_job: dict[str, object] | None = None,
) -> bool:
    """Write the documentary checkpoint inside the caller's transaction."""

    source_url = clean_text(sale.source_url)
    expected_updated_at = sale.updated_at
    current = connection.execute(
        "select updated_at from public.auction_sales where source_url=%s for update",
        (source_url,),
    ).fetchone()
    if current is None or current[0] != expected_updated_at:
        LOGGER.warning("Discarding obsolete PDF checkpoint for %s", source_url)
        return False

    updated = connection.execute(
        """
        update public.auction_sales
           set raw_payload = jsonb_set(
                 coalesce(raw_payload, '{}'::jsonb),
                 '{document_analysis}',
                 %s,
                 true
               )
         where source_url=%s
           and updated_at=%s
           and (
                 raw_payload is null
                 or jsonb_typeof(raw_payload) = 'object'
               )
         returning updated_at
        """,
        (
            _postgres_value("raw_payload", _sanitize_postgrest_payload(analysis)),
            source_url,
            expected_updated_at,
        ),
    ).fetchone()
    if updated is None:
        return False
    if updated[0] != expected_updated_at:
        raise RuntimeError("PDF checkpoint changed the source sale revision")

    input_hash = "pdf_checkpoint:" + pdf_enrichment_input_hash_for_sale(sale)
    now = datetime.now(UTC)
    connection.execute(
        """
        insert into public.auction_extractions (
            source_url, provider, model, input_hash, schema_version,
            confidence, result, updated_at
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s)
        on conflict (source_url, provider, input_hash) do update set
            model = excluded.model,
            schema_version = excluded.schema_version,
            confidence = excluded.confidence,
            result = excluded.result,
            updated_at = excluded.updated_at
        """,
        (
            source_url,
            PDF_EXTRACTION_PROVIDER,
            PDF_EXTRACTION_MODEL,
            input_hash,
            PDF_EXTRACTION_SCHEMA_VERSION,
            # ``confidence`` and ``result`` are JSONB on auction_extractions,
            # but their names cannot be added to POSTGRES_JSON_COLUMNS because
            # other publication tables use a numeric confidence column.
            Jsonb(_sanitize_postgrest_payload(_pdf_extraction_confidence(result))),
            Jsonb(_sanitize_postgrest_payload(result)),
            now,
        ),
    )
    if pdf_job is not None:
        _rekey_pdf_job_after_checkpoint_with_connection(
            connection,
            sale,
            pdf_job,
            input_hash=pdf_enrichment_input_hash_for_sale(sale),
        )
    return True


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


def _persist_pdf_document_checkpoint_payload_to_supabase(
    sale: AuctionSale,
    analysis: dict[str, object],
    result: list[dict[str, object]],
    *,
    pdf_job: dict[str, object] | None = None,
) -> bool:
    """Persist only modern PDF evidence after an incomplete extraction.

    The source revision is fenced by ``auction_sales.updated_at``.  The helper
    updates only the nested documentary analysis and writes one PDF extraction
    row. When a currently claimed ``pdf_job`` is supplied, that same queue row
    is rekeyed after the checkpoint so its retry budget follows the durable
    generation. A direct Postgres connection is required so these writes share
    one transaction. When called from an existing publication transaction,
    psycopg's nested transaction context supplies a savepoint.
    """

    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    connection = _PUBLICATION_CONNECTION.get()
    if connection is None and not db_url:
        LOGGER.warning("Skipping PDF checkpoint without a direct Postgres connection")
        return False

    def configure_dedicated_connection(current_connection: Any) -> None:
        """Keep checkpoint settings transaction-local to a new connection."""

        current_connection.execute(
            """
            select set_config('app.pipeline_queue_owner', %s, true),
                   set_config('lock_timeout', %s, true),
                   set_config('statement_timeout', %s, true)
            """,
            (
                PDF_CHECKPOINT_QUEUE_OWNER,
                PDF_CHECKPOINT_LOCK_TIMEOUT,
                PDF_CHECKPOINT_STATEMENT_TIMEOUT,
            ),
        )

    def write(current_connection: Any, *, dedicated: bool) -> bool:
        transaction = getattr(current_connection, "transaction", None)
        if callable(transaction):
            with transaction():
                if dedicated:
                    configure_dedicated_connection(current_connection)
                return _persist_pdf_document_checkpoint_with_connection(
                    current_connection,
                    sale,
                    analysis,
                    result,
                    pdf_job=pdf_job,
                )
        if dedicated:
            configure_dedicated_connection(current_connection)
        return _persist_pdf_document_checkpoint_with_connection(
            current_connection,
            sale,
            analysis,
            result,
            pdf_job=pdf_job,
        )

    if connection is not None:
        # A publication transaction owns its session settings.  In
        # particular, do not overwrite its queue owner or timeout policy.
        return write(connection, dedicated=False)
    with _postgres_connect(
        str(db_url),
        connect_timeout=PDF_CHECKPOINT_CONNECT_TIMEOUT,
        retry_delays=(),
    ) as current_connection:
        return write(current_connection, dedicated=True)


def persist_pdf_document_checkpoint_to_supabase(
    sale: AuctionSale,
    *,
    pdf_job: dict[str, object] | None = None,
) -> bool:
    """Persist the modern aggregate cache after a bounded PDF pass."""

    prepared = _prepare_pdf_document_checkpoint(sale)
    if prepared is None:
        return False
    analysis, result = prepared
    return _persist_pdf_document_checkpoint_payload_to_supabase(
        sale,
        analysis,
        result,
        pdf_job=pdf_job,
    )


def persist_pdf_progress_checkpoint_to_supabase(
    sale: AuctionSale,
    *,
    analysis: dict[str, object],
    pdf_texts: list[dict[str, object]],
    pdf_job: dict[str, object] | None = None,
) -> bool:
    """Persist modern in-memory PDF progress before a deferred extraction.

    The caller must provide the extractor's explicit manifest and page payloads.
    This helper never reads or invents a local cache, promotes a partial
    manifest, or spends a retry.  The same optimistic source-revision and
    optional queue rekey guards as the normal checkpoint apply.
    """

    prepared = _validate_pdf_document_checkpoint_payload(sale, analysis, pdf_texts)
    if prepared is None:
        return False
    validated_analysis, validated_texts = prepared
    return _persist_pdf_document_checkpoint_payload_to_supabase(
        sale,
        validated_analysis,
        validated_texts,
        pdf_job=pdf_job,
    )


def _fetch_persisted_pdf_texts_for_sales(
    sales: list[AuctionSale],
    supabase_url: str,
    api_key: str,
) -> dict[str, list[dict[str, object]]]:
    """Read complete persisted PDF text once per bounded URL batch.

    Only sales with no usable local cache and a complete current manifest are
    candidates.  Any validation failure leaves that sale on the normal
    pending path; a partial persisted result is never mixed into materialized
    rows.
    """
    candidates: dict[str, AuctionSale] = {}
    for sale in sales:
        source_url = clean_text(sale.source_url)
        if not source_url or _has_usable_local_pdf_cache(sale):
            continue
        if _validated_persisted_pdf_manifest(sale) is not None:
            candidates[source_url] = sale
    if not candidates:
        return {}

    persisted_rows: list[dict[str, object]] = []
    source_urls = list(candidates)
    connection = _PUBLICATION_CONNECTION.get()
    for offset in range(0, len(source_urls), PERSISTED_PDF_LOOKUP_BATCH_SIZE):
        batch = source_urls[offset : offset + PERSISTED_PDF_LOOKUP_BATCH_SIZE]
        try:
            if connection is not None:
                persisted_rows.extend(_read_persisted_pdf_rows_postgres(connection, batch))
            else:
                persisted_rows.extend(_read_persisted_pdf_rows_rest(supabase_url, api_key, batch))
        except (RuntimeError, TypeError, ValueError, httpx.HTTPError) as exc:
            LOGGER.warning("Persisted PDF extraction lookup failed; keeping normal pending rows: %s", exc)

    rows_by_source: dict[str, list[dict[str, object]]] = {}
    for row in persisted_rows:
        source_url = clean_text(row.get("source_url"))
        if source_url in candidates:
            rows_by_source.setdefault(source_url, []).append(row)
    validated: dict[str, list[dict[str, object]]] = {}
    for source_url, sale in candidates.items():
        # The SQL/REST paths order newest first.  Sorting again makes the
        # choice deterministic for test doubles and drivers that do not retain
        # the requested order.
        rows = sorted(
            rows_by_source.get(source_url, []),
            key=lambda row: str(row.get("updated_at") or ""),
            reverse=True,
        )
        for row in rows:
            payload = _validated_persisted_pdf_texts(sale, row)
            if payload is not None:
                validated[source_url] = payload
                break
    return validated


def _validated_persisted_pdf_progress(
    sale: AuctionSale,
    extraction_row: dict[str, object],
) -> list[dict[str, object]] | None:
    """Validate a partial modern PDF checkpoint for a cold worker.

    This path is intentionally separate from ``_validated_persisted_pdf_texts``:
    it can restore only the modern per-document entries represented by the
    current progress manifest. It never makes a partial manifest current and
    never feeds the strict complete fallback.
    """
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return None
    if (
        analysis.get("progress_schema_version") != PDF_PROGRESS_SCHEMA_VERSION
        or analysis.get("input_fingerprint") != document_fingerprint(sale.documents)
        or analysis.get("manifest_complete") is not False
        or not _historical_timestamp_is_valid(analysis.get("checked_at"))
    ):
        return None
    if (
        clean_text(extraction_row.get("source_url")) != sale.source_url
        or extraction_row.get("provider") != PDF_EXTRACTION_PROVIDER
        or extraction_row.get("model") != PDF_EXTRACTION_MODEL
        or extraction_row.get("schema_version") != PDF_EXTRACTION_SCHEMA_VERSION
    ):
        return None
    result = extraction_row.get("result")
    if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
        return None
    document_urls = {document_url(document) for document in sale.documents if document_url(document)}
    progress = modern_progress_entries(analysis, sale.documents)
    if not progress:
        return None
    result_by_url: dict[str, dict[str, object]] = {}
    for item in result:
        url = document_url(item)
        if not url or url in result_by_url or url not in document_urls:
            return None
        if not is_modern_payload(item, expected_url=url):
            return None
        require_chars = item.get("complete") is not True
        if not _checkpoint_page_coverage_matches(item, require_chars=require_chars):
            return None
        if (
            clean_text(item.get("extraction_method")) == "pymupdf_pages"
            and not _checkpoint_pages_match_payload(item, require_chars=require_chars)
        ):
            return None
        manifest_item = progress.get(url)
        if not isinstance(manifest_item, dict):
            return None
        item_text_hash = _checkpoint_payload_text_hash(item)
        manifest_text_hash = _checkpoint_manifest_text_hash(manifest_item)
        if (
            clean_text(item.get("sha256")) != clean_text(manifest_item.get("sha256"))
            or clean_text(item.get("extraction_status")) != clean_text(manifest_item.get("extraction_status"))
            or item.get("complete") is not manifest_item.get("complete")
            or list(item.get("failed_pages") or []) != list(manifest_item.get("failed_pages") or [])
            or item_text_hash is None
            or manifest_text_hash is None
            or item_text_hash != manifest_text_hash
        ):
            return None
        result_by_url[url] = item
    if not result_by_url:
        return None
    verified_at = (analysis.get("cache_proof") or {}).get("verified_at") if isinstance(analysis.get("cache_proof"), dict) else None
    restored: list[dict[str, object]] = []
    for url in sorted(result_by_url):
        sanitized = dict(result_by_url[url])
        sanitized["file_path"] = None
        sanitized["_persisted_pdf_proof"] = True
        sanitized["_persisted_verified_at"] = verified_at or analysis.get("checked_at")
        restored.append(sanitized)
    return restored


def _restore_pdf_page_caches_for_documents(
    restored: list[dict[str, object]],
    downloaded_documents: list[dict[str, object]],
) -> None:
    """Restore validated page records only beside matching local PDF bytes."""

    documents_by_url = {
        document_url(document): document
        for document in downloaded_documents
        if isinstance(document, dict) and document_url(document)
    }
    if not documents_by_url:
        return
    settings = load_settings()
    ocr_settings = (
        bool(settings.get("pdf_ocr_enabled")),
        str(settings.get("pdf_ocr_language") or "fra+eng"),
        PDF_TEXT_CACHE_VERSION,
    )
    from src.pdf_enrichment import _write_document_text_cache

    for payload in restored:
        url = document_url(payload)
        document = documents_by_url.get(url)
        file_path_value = document.get("file_path") if isinstance(document, dict) else None
        file_path = Path(str(file_path_value)) if file_path_value else None
        pages = payload.get("pages") if isinstance(payload, dict) else None
        if (
            not isinstance(document, dict)
            or file_path is None
            or not file_path.is_file()
            or not _valid_pdf_checkpoint_pages(
                pages,
                page_count=payload.get("page_count") if isinstance(payload, dict) else None,
            )
        ):
            LOGGER.warning("Skipping local PDF page restoration without a verified file for %s", url)
            continue
        reusable_pages = _reusable_pdf_checkpoint_pages(pages)
        if not reusable_pages:
            LOGGER.warning("Skipping local PDF page restoration without reusable pages for %s", url)
            continue
        try:
            file_bytes = file_path.read_bytes()
            file_sha = hashlib.sha256(file_bytes).hexdigest()
        except OSError as exc:
            LOGGER.warning("Could not read local PDF for page restoration %s: %s", url, exc)
            continue
        expected_sha = clean_text(payload.get("sha256"))
        if expected_sha != file_sha or clean_text(document.get("sha256")) != file_sha:
            LOGGER.warning("Skipping PDF page restoration after SHA mismatch for %s", url)
            continue
        cache_key = hashlib.sha256(file_bytes + str(ocr_settings).encode()).hexdigest()
        page_dir = PDF_DOCUMENT_TEXTS_DIR / "pages" / cache_key
        try:
            page_dir.mkdir(parents=True, exist_ok=True)
            for page in reusable_pages:
                page_path = page_dir / f"{page['page']}.json"
                if page_path.exists():
                    continue
                temporary = page_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(page, ensure_ascii=False), encoding="utf-8")
                temporary.replace(page_path)
            local_payload = dict(payload)
            local_payload["file_path"] = str(file_path)
            _write_document_text_cache(document, file_path, local_payload)
        except (OSError, TypeError, ValueError) as exc:
            LOGGER.warning("Could not materialize persisted PDF pages for %s: %s", url, exc)


def restore_persisted_pdf_progress_for_sale(
    sale: AuctionSale,
    *,
    downloaded_documents: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    """Restore modern complete or partial PDF text before a cold queue pass."""
    if not clean_text(sale.source_url) or _has_usable_local_pdf_cache(sale):
        return []
    settings = load_settings()
    supabase_url = settings.get("supabase_url")
    api_key = settings.get("supabase_service_role_key")
    if not supabase_url or not api_key:
        return []
    source_url = clean_text(sale.source_url)
    rows: list[dict[str, object]] = []
    connection = _PUBLICATION_CONNECTION.get()
    try:
        if connection is not None:
            rows = _read_persisted_pdf_rows_postgres(connection, [source_url])
        else:
            rows = _read_persisted_pdf_rows_rest(str(supabase_url), str(api_key), [source_url])
    except (RuntimeError, TypeError, ValueError, httpx.HTTPError) as exc:
        LOGGER.warning("Cold PDF progress lookup failed; keeping pending documents: %s", exc)
        return []
    rows = sorted(rows, key=lambda row: str(row.get("updated_at") or ""), reverse=True)
    restored: list[dict[str, object]] | None = None
    for row in rows:
        restored = _validated_persisted_pdf_texts(sale, row)
        if restored is not None:
            break
        restored = _validated_persisted_pdf_progress(sale, row)
        if restored is not None:
            break
    if not restored:
        return []
    from src.pdf_fact_extraction import _write_pdf_text_cache

    try:
        _write_pdf_text_cache(sale, restored)
    except (KeyError, OSError, TypeError, ValueError) as exc:
        LOGGER.warning("Could not materialize cold PDF progress for %s: %s", source_url, exc)
        return []
    if downloaded_documents:
        _restore_pdf_page_caches_for_documents(restored, downloaded_documents)
    return restored


def upsert_documents_to_supabase(
    sales: list[AuctionSale],
    *,
    persisted_pdf_texts: dict[str, list[dict[str, object]]] | None = None,
    prune_stale: bool = False,
) -> int:
    sales = [sale for sale in sales if has_price_or_surface(sale) and not is_expired(sale)]
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    if persisted_pdf_texts is None:
        persisted_pdf_texts = _fetch_persisted_pdf_texts_for_sales(sales, str(url), str(key))
    rows = [
        row
        for sale in sales
        for row in _document_rows_for_sale(
            sale,
            pdf_texts=persisted_pdf_texts.get(sale.source_url),
        )
    ]
    if rows:
        rows = _unique_rows_by_keys(rows, ("source_url", "document_url"))
        _postgrest_upsert(
            str(url),
            str(key),
            "auction_documents",
            rows,
            on_conflict="source_url,document_url",
        )
    if prune_stale:
        _prune_stale_document_rows(str(url), str(key), sales)
    return len(rows)


def _restore_persisted_pdf_text_caches(
    sales: list[AuctionSale],
    persisted_pdf_texts: dict[str, list[dict[str, object]]],
) -> None:
    """Materialize validated historical PDF text after extraction upsert.

    The validated payload is already used for the document rows.  Delaying the
    local write until after ``auction_extractions`` is upserted keeps this
    recovery path from manufacturing a second current extraction row in the
    same publication.  The writer is atomic; a cache failure is an
    optimization failure and leaves the publication on its normal queue path.
    """
    if not persisted_pdf_texts:
        return
    from src.pdf_fact_extraction import _write_pdf_text_cache

    for sale in sales:
        source_url = clean_text(sale.source_url)
        payload = persisted_pdf_texts.get(source_url)
        if not payload:
            continue
        try:
            _write_pdf_text_cache(sale, payload)
        except (KeyError, OSError, TypeError, ValueError) as exc:
            LOGGER.warning("Could not restore persisted PDF cache for %s: %s", source_url, exc)


def upsert_extractions_to_supabase(sales: list[AuctionSale]) -> int:
    sales = [sale for sale in sales if has_price_or_surface(sale) and not is_expired(sale)]
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    rows = [row for sale in sales for row in _extraction_rows_for_sale(sale)]
    if not rows:
        return 0
    _postgrest_upsert(str(url), str(key), "auction_extractions", rows, on_conflict="source_url,provider,input_hash")
    return len(rows)


def upsert_observations_to_supabase(sales: list[AuctionSale]) -> int:
    sales = [
        sale for sale in sales
        if has_price_or_surface(sale)
        and not is_expired(sale)
        and sale.status != 'quarantined'
        and not quarantine_reason(sale)
    ]
    if not sales:
        return 0
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        return 0
    now = datetime.now(UTC).isoformat()

    def _as_utc(value: object) -> datetime | None:
        if isinstance(value, datetime):
            parsed = value
        elif value:
            try:
                parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                return None
        else:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)

    def _content_freshness(observation: dict[str, object], content: object, source_url: str) -> datetime | None:
        # Ranking may use only timestamps carried by this observation. Parent
        # catalogue mutation times are not evidence that its payload is newer.
        candidates: list[object] = [observation.get("observed_at")]
        if isinstance(content, dict):
            candidates.append(content.get("_checkpoint_checked_at"))
            checks = content.get("source_checks")
            if isinstance(checks, dict):
                check = checks.get(source_url)
                if isinstance(check, dict):
                    candidates.append(check.get("checked_at"))
        parsed = [_as_utc(value) for value in candidates]
        valid = [value for value in parsed if value is not None]
        return max(valid) if valid else None

    def _rank(row: dict[str, object], freshness: datetime | None) -> tuple[datetime, int, str]:
        richness = sum(bool(row.get(field)) for field in (
            "source_name", "external_id", "content_hash", "canonical_source_url", "raw_payload"
        ))
        stable = json.dumps(row, sort_keys=True, default=str, separators=(",", ":"))
        return freshness or datetime.min.replace(tzinfo=UTC), richness, stable

    def _merge(current: dict[str, object], incoming: dict[str, object]) -> dict[str, object]:
        current_rank = current.pop("_dedupe_rank")
        incoming_rank = incoming.pop("_dedupe_rank")
        winner, fallback = (
            (incoming, current) if incoming_rank > current_rank else (current, incoming)
        )
        merged = dict(winner)
        for field in ("source_name", "external_id", "content_hash", "canonical_source_url", "raw_payload"):
            if not merged.get(field) and fallback.get(field):
                merged[field] = fallback[field]
        merged["_dedupe_rank"] = max(current_rank, incoming_rank)
        return merged

    rows_by_source_url: dict[str, dict[str, object]] = {}
    for sale in sales:
        observations = sale.observations or [
            {
                "source_name": sale.source_name,
                "source_url": sale.source_url,
                "external_id": sale.external_id,
                "raw_payload": sale.raw_payload,
            }
        ]
        for observation in observations:
            if not isinstance(observation, dict) or not observation.get("source_url"):
                continue
            source_url = str(observation.get("source_url"))
            content = observation.get("raw_payload") or observation
            # Keep the column's ingest/explicit observation meaning; checkpoint
            # evidence ranks duplicates but is not relabeled as observed_at.
            observed_at = _as_utc(observation.get("observed_at"))
            row = {
                "source_name": observation.get("source_name") or sale.source_name,
                "source_url": source_url,
                "external_id": observation.get("external_id"),
                "content_hash": sale.content_hash,
                "canonical_source_url": sale.source_url,
                "raw_payload": content,
                "observed_at": observed_at.isoformat() if observed_at else now,
                "updated_at": now,
            }
            row["_dedupe_rank"] = _rank(row, _content_freshness(observation, content, source_url))
            previous = rows_by_source_url.get(source_url)
            rows_by_source_url[source_url] = _merge(previous, row) if previous is not None else row

    payload = []
    for source_url in sorted(rows_by_source_url):
        row = rows_by_source_url[source_url]
        row.pop("_dedupe_rank", None)
        payload.append(row)
    if not payload:
        return 0
    if db_url:
        try:
            persisted = _postgres_upsert(str(db_url), "auction_observations", payload, on_conflict="source_url")
            return persisted if isinstance(persisted, int) else len(payload)
        except Exception as exc:
            # The direct path is the only path that can lock the parent and
            # child in one transaction.  Falling back here would reintroduce
            # the orphan race this guard is intended to close.
            LOGGER.error("Direct Postgres auction_observations upsert failed; refusing an unguarded REST write: %s", exc)
            raise
    payload = _rest_parented_observation_payload(str(url), str(key), payload)
    if not payload:
        return 0
    _postgrest_upsert(str(url), str(key), "auction_observations", payload, on_conflict="source_url")
    return len(payload)


def fetch_enriched_content_hashes(
    content_hashes: list[str],
    *,
    require_llm_description: bool = False,
    require_document_analysis: bool = False,
    prompt_version: str | None = None,
) -> set[str]:
    """Return the subset of content_hashes already present and enriched in DB.

    Used for incremental runs: an unchanged listing (same content_hash) that was
    already scored does not need to be re-downloaded / re-OCR'd / re-sent to the
    LLM. We require score_version IS NOT NULL so partially-failed rows are
    re-processed. When LLM descriptions are required, a row is only considered
    current if the public display summary exists and was produced with the
    current prompt version.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    unique = [h for h in {h for h in content_hashes if h}]
    if not unique or (not db_url and (not url or not key)):
        return set()

    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales" if url else ""
    found: set[str] = set()
    if db_url:
        try:
            with _postgres_connect(str(db_url)) as db:
                for index in range(0, len(unique), 150):
                    batch = unique[index : index + 150]
                    rows = db.execute(
                        """
                        select content_hash,
                               raw_payload->'document_analysis' as document_analysis,
                               raw_payload->>'llm_display_description' as llm_display_description,
                               raw_payload->>'llm_display_quality_version' as llm_display_quality_version,
                               raw_payload->>'llm_display_status' as llm_display_status,
                               raw_payload->>'llm_prompt_version' as llm_prompt_version,
                               raw_payload->>'llm_display_prompt_version' as llm_display_prompt_version,
                               raw_payload->>'llm_display_model' as llm_display_model
                        from public.auction_sales
                        where content_hash = any(%s::text[])
                          and score_version is not null
                        """,
                        (batch,),
                    ).fetchall()
                    for row in rows:
                        if not isinstance(row, (list, tuple)) or len(row) != 8:
                            raise RuntimeError("Malformed compact enriched-hash PostgreSQL row")
                        value = row[0]
                        compact_payload = {
                            key: payload
                            for key, payload in zip(
                                (
                                    "document_analysis",
                                    "llm_display_description",
                                    "llm_display_quality_version",
                                    "llm_display_status",
                                    "llm_prompt_version",
                                    "llm_display_prompt_version",
                                    "llm_display_model",
                                ),
                                row[1:],
                                strict=True,
                            )
                            if payload is not None
                        }
                        if value and (
                            (not require_llm_description or _has_current_llm_description(compact_payload, prompt_version))
                            and (not require_document_analysis or _has_current_document_analysis(compact_payload))
                        ):
                            found.add(str(value))
            return found
        except Exception as exc:
            # PostgreSQL is the preferred low-egress path, but this lookup is
            # advisory. Preserve the existing Data API fallback if a worker
            # has a stale/misconfigured direct connection.
            LOGGER.warning("Compact enriched-hash PostgreSQL lookup failed; falling back to PostgREST: %s", exc)
            if not url or not key:
                return set()

    for index in range(0, len(unique), 150):
        batch = unique[index : index + 150]
        try:
            response = httpx.get(
                endpoint,
                params={
                    "select": "content_hash,raw_payload",
                    "content_hash": _postgrest_in_filter(batch),
                    "score_version": "not.is.null",
                },
                headers=_rest_headers(str(key), prefer="count=none"),
                timeout=30,
            )
            if response.is_error:
                LOGGER.warning(
                    "Could not fetch enriched hashes (%s): %s", response.status_code, response.text[:200]
                )
                continue
            for row in response.json():
                value = row.get("content_hash")
                if value and (
                    (not require_llm_description or _has_current_llm_description(row.get("raw_payload"), prompt_version))
                    and (not require_document_analysis or _has_current_document_analysis(row.get("raw_payload")))
                ):
                    found.add(str(value))
        except httpx.HTTPError as exc:
            LOGGER.warning("Enriched-hash lookup failed: %s", exc)
    return found


def _has_current_document_analysis(raw_payload: object) -> bool:
    if not isinstance(raw_payload, dict):
        return False
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict):
        return False
    try:
        listed = int(analysis.get("documents_listed") or 0)
        extracted = int(analysis.get("documents_extracted") or 0)
        blocked = int(analysis.get("blocked_documents") or 0)
        failed = int(analysis.get("failed_documents") or 0)
    except (OverflowError, TypeError, ValueError):
        return False
    if listed > 0:
        if extracted > 0:
            return True
        # A robots-policy-only result is intentionally partial, but it is a
        # completed bounded check. Keep it out of the next incremental heavy
        # pass while its persisted evidence is fresh. The downstream
        # heavy-current check still compares that fingerprint with the current
        # sale documents before skipping enrichment. Missing the explicit
        # fields keeps legacy/ambiguous zero-extraction rows eligible.
        if (
            blocked > 0
            and failed == 0
            and analysis.get("coverage_status") == "partial"
            and bool(analysis.get("input_fingerprint"))
            and bool(analysis.get("blocked_document_urls"))
            and bool(analysis.get("blocked_document_reasons"))
            and timestamp_is_fresh(analysis.get("checked_at"))
        ):
            return True
        terminal_urls = analysis.get("terminal_document_urls")
        skipped_urls = analysis.get("skipped_document_urls")
        blocked_urls = analysis.get("blocked_document_urls")
        if (
            failed == 0
            and analysis.get("coverage_status") == "partial"
            and bool(analysis.get("input_fingerprint"))
            and timestamp_is_fresh(analysis.get("checked_at"))
            and isinstance(terminal_urls, list)
            and isinstance(skipped_urls, list)
            and isinstance(blocked_urls, list)
            and len({str(url) for url in [*terminal_urls, *skipped_urls, *blocked_urls] if url}) >= listed
        ):
            return True
    return analysis.get("coverage_status") == "source_only"


def fetch_sales_needing_llm_descriptions(
    *,
    limit: int,
    prompt_version: str,
    statuses: tuple[str, ...] = ("active", "upcoming"),
) -> list[AuctionSale]:
    """Fetch existing DB rows whose public LLM description needs backfill.

    Regular scrape runs only see listings collected during that run. This helper
    lets a bounded worker gradually cover older active/upcoming rows without
    making the main scrape run longer.
    """
    from src.enrichment.extract_structured import needs_fact_extraction

    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key or limit <= 0:
        return []

    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    page_size = max(50, min(250, limit * 4))
    selected: list[AuctionSale] = []
    offset = 0
    failure_cooldown_hours = float(settings.get("pipeline_llm_failure_cooldown_hours") or 24)

    while len(selected) < limit:
        params: dict[str, str] = {
            "select": LLM_BACKFILL_SALE_SELECT,
            "order": "sale_date.asc.nullslast,updated_at.desc.nullslast",
            "limit": str(page_size),
            "offset": str(offset),
        }
        if statuses:
            params["status"] = _postgrest_in_filter(list(statuses))

        try:
            response = httpx.get(
                endpoint,
                params=params,
                headers=_rest_headers(str(key), prefer="count=none"),
                timeout=POSTGREST_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            LOGGER.warning("LLM backfill sale fetch failed: %s", exc)
            break
        if response.is_error:
            LOGGER.warning("LLM backfill sale fetch failed (%s): %s", response.status_code, response.text[:300])
            break

        rows = response.json()
        if not rows:
            break
        for row in rows:
            if _has_current_llm_description(row.get("raw_payload"), prompt_version):
                continue
            if _has_recent_llm_description_failure(
                row.get("raw_payload"),
                prompt_version=prompt_version,
                cooldown_hours=failure_cooldown_hours,
            ):
                continue
            sale = _auction_sale_from_row(row)
            if (
                sale is not None
                and has_price_or_surface(sale)
                and not is_expired(sale)
                and not needs_fact_extraction(sale)
            ):
                selected.append(sale)
            if len(selected) >= limit:
                break
        if len(rows) < page_size:
            break
        offset += page_size

    return selected[:limit]


def _auction_sale_from_row(row: dict[str, Any]) -> AuctionSale | None:
    try:
        return AuctionSale.model_validate(row)
    except Exception as exc:
        LOGGER.warning("Could not hydrate auction sale %s for LLM backfill: %s", row.get("source_url"), exc)
        return None


def reconcile_duplicate_sales_in_supabase(
    *,
    statuses: tuple[str, ...] = ("active", "upcoming", "unknown"),
    limit: int | None = None,
) -> int:
    """Merge historical duplicate rows that are not necessarily in today's scrape.

    The in-run dedupe only sees the current source payload. If a source no
    longer republishes a listing detail, an older duplicate row can remain in
    Supabase. This bounded sweep reuses the same merge rules on existing
    active/upcoming rows, updates the canonical row, then deletes secondary
    source URLs.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        return 0
    max_rows = limit if limit is not None else int(settings.get("dedupe_reconcile_max_rows") or 2000)
    if max_rows <= 0:
        return 0

    reviewed_aliases = _fetch_reviewed_alias_registry(str(url), str(key))
    sales = _fetch_dedupe_candidate_sales(
        str(url),
        str(key),
        statuses=statuses,
        limit=max_rows,
        reviewed_aliases=reviewed_aliases,
    )
    if len(sales) < 2:
        return 0

    merged = merge_duplicate_sales(sales)
    protected_urls = reviewed_aliases.protected_source_urls()
    secondary_urls = [
        source_url
        for source_url in _secondary_source_urls(merged)
        if source_url not in protected_urls
    ]
    if not secondary_urls:
        return 0

    impacted_urls = set(secondary_urls)
    impacted_sales = [
        sale
        for sale in merged
        if any(source_url in impacted_urls for source_url in sale.source_urls if source_url)
    ]
    if not impacted_sales:
        return 0

    now = datetime.now(UTC).isoformat()
    payload = []
    for sale in impacted_sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in UPSERT_COLUMNS}
        row["updated_at"] = now
        row["last_seen_at"] = data.get("last_seen_at") or now
        payload.append(row)

    if db_url:
        try:
            _postgres_upsert(str(db_url), "auction_sales", payload, on_conflict="source_url")
            deleted = _delete_secondary_sale_rows_with_postgres(str(db_url), impacted_sales)
            _sync_normalized_sale_tables_with_rest(str(url), str(key), impacted_sales, now)
            _upsert_asset_tables_with_rest(str(url), str(key), impacted_sales, now)
            return deleted
        except ReviewedAliasRegistryError:
            raise
        except Exception as exc:
            LOGGER.warning("Direct Postgres duplicate reconciliation failed; falling back to REST: %s", exc)

    _upsert_with_rest(str(url), str(key), payload)
    deleted = _delete_secondary_sale_rows(
        str(url),
        str(key),
        impacted_sales,
        registry=reviewed_aliases,
    )
    _sync_normalized_sale_tables_with_rest(str(url), str(key), impacted_sales, now)
    _upsert_asset_tables_with_rest(str(url), str(key), impacted_sales, now)
    return deleted


def _fetch_dedupe_candidate_sales(
    supabase_url: str,
    api_key: str,
    *,
    statuses: tuple[str, ...],
    limit: int,
    reviewed_aliases: ReviewedAliasRegistry | None = None,
) -> list[AuctionSale]:
    reviewed_aliases = reviewed_aliases or _fetch_reviewed_alias_registry(supabase_url, api_key)
    protected_ids = reviewed_aliases.protected_sale_ids()
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/auction_sales"
    rows: list[dict[str, Any]] = []
    offset = 0
    page_size = min(1000, max(100, limit))
    while len(rows) < limit:
        params: dict[str, str] = {
            "select": DEDUPLICATION_SALE_SELECT,
            "order": "sale_date.asc.nullslast,updated_at.desc.nullslast",
            "limit": str(min(page_size, limit - len(rows))),
            "offset": str(offset),
        }
        if statuses:
            params["status"] = _postgrest_in_filter(list(statuses))
        try:
            response = httpx.get(
                endpoint,
                params=params,
                headers=_rest_headers(api_key, prefer="count=none"),
                timeout=POSTGREST_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            LOGGER.warning("Supabase duplicate reconciliation fetch failed: %s", exc)
            break
        if response.is_error:
            LOGGER.warning(
                "Supabase duplicate reconciliation fetch failed (%s): %s",
                response.status_code,
                response.text[:300],
            )
            break
        page_rows = response.json()
        if not page_rows:
            break
        rows.extend(
            row
            for row in page_rows
            if isinstance(row, dict)
            and (not row.get("id") or str(row["id"]) not in protected_ids)
        )
        if len(page_rows) < page_size:
            break
        offset += page_size

    sales: list[AuctionSale] = []
    for row in rows[:limit]:
        sale = _auction_sale_from_row(row)
        if sale is not None:
            sales.append(sale)
    return sales


def _has_current_llm_description(raw_payload: Any, prompt_version: str | None) -> bool:
    settings = load_settings()
    return has_current_display(
        raw_payload,
        prompt_version,
        str(settings.get("llm_display_prompt_version") or "") or None,
        str(settings.get("replicate_model") or "") or None,
    )


def _has_recent_llm_description_failure(
    raw_payload: Any,
    *,
    prompt_version: str,
    cooldown_hours: float,
) -> bool:
    if cooldown_hours <= 0 or not isinstance(raw_payload, dict):
        return False
    if raw_payload.get("llm_display_error_prompt_version") != prompt_version:
        return False
    error_at = raw_payload.get("llm_display_error_at")
    if not isinstance(error_at, str) or not error_at.strip():
        return False
    try:
        parsed = datetime.fromisoformat(error_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return datetime.now(UTC) - parsed.astimezone(UTC) < timedelta(hours=cooldown_hours)


KNOWN_SALE_DETAIL_SELECT = ",".join(
    (
        "id",
        "source_url",
        "source_urls",
        "sale_date",
        "starting_price_eur",
        "visit_dates",
        "lawyer_name",
        "lawyer_contact",
        "status",
        "adjudication_price_eur",
        "score_version",
        "score_confidence",
        "score_factors",
        "quality_flags",
        "latitude",
        "longitude",
        "risk_notes",
        "investment_score",
        "investment_summary",
        "tribunal",
        "tribunal_code",
        "department",
        "city",
        "address",
        "postal_code",
        "property_type",
        "title",
        "description",
        "surface_m2",
        "habitable_surface_m2",
        "land_surface_m2",
        "carrez_surface_m2",
        "app_surface_m2",
        "app_surface_kind",
        "surface_scope",
        "surface_source",
        "surface_confidence",
        "surface_evidence",
        "rooms_count",
        "bedrooms_count",
        "bathrooms_count",
        "parking_count",
        "has_garden",
        "has_terrace",
        "has_garage",
        "has_pool",
        "has_air_conditioning",
        "has_double_glazing",
        "occupancy_status",
        "documents",
        "raw_text",
        "raw_payload",
    )
)
# The REST fallback keeps the historical projection above because PostgREST
# cannot express the JSONB allow-list below.  The direct PostgreSQL preflight
# only needs fields used by the source fallback and enrichment preservation;
# forwarding arbitrary scraper payload keys here was the main source of the
# full-snapshot egress.  Keep the list explicit so a new preservation contract
# has to opt in rather than silently re-expanding every row.
KNOWN_SALE_RAW_PAYLOAD_KEYS = (
    "source_checks",
    "source_checks_by_source",
    "source_presence",
    # Vench's source-contract projection is consumed again when a cold worker
    # restores a known listing.  Keep the complete contract together so a
    # bounded snapshot cannot silently downgrade a paywalled source row.
    "source_property_features",
    "source_property_feature_evidence",
    "source_property_features_meta",
    "source_procedure_profile",
    "source_field_observations",
    "source_evidence",
    "source_evidence_provenance",
    "source_energy_diagnostics",
    "source_sale_schedule",
    "date_precision",
    "sale_date_precision",
    "operator_land_surface_conflict",
    "operator_land_surface_scope",
    "source_display_constraints",
    "source_blocks",
    "source_conflicts",
    "source_images",
    "raw_image_url",
    "source_description",
    "source_factual_snapshot",
    "source_identity_mismatch",
    "source_detail_status",
    "source_content_changed",
    "source_content_change_reason",
    "source_operational_changed",
    "superseded_analysis",
    "superseded_document_analysis",
    "publication_identity_conflict",
    "publication_conflict_evidence",
    "document_analysis",
    "document_facts_version",
    "starting_price_extraction",
    "surface_extraction",
    "surface_analysis",
    "land_surface_extraction",
    "investment_analysis",
    "llm_extraction",
    "llm_fact_extraction",
    "llm_fact_prompt_version",
    "llm_display_prompt_version",
    "llm_fact_coverage",
    "llm_fact_input_key",
    "llm_fact_context_manifest",
    "llm_fact_context_coverage",
    "llm_display_description",
    "llm_display_description_word_count",
    "llm_display_status",
    "llm_display_model",
    "llm_display_origin",
    "llm_display_quality_version",
    "llm_display_source_constraints",
    "llm_display_evidence_check",
    "llm_prompt_version",
    "llm_due_diligence",
    "pdf_fact_provenance",
    "pdf_sale_date_extraction",
    "pdf_visit_dates_extraction",
    "pdf_energy_diagnostics",
    "pdf_energy_diagnostics_candidates",
    "pdf_surface_candidates",
    "pdf_land_surface_candidates",
    "pdf_rooms_candidates",
    "pdf_bedrooms_candidates",
    "pdf_occupancy_candidates",
    "pdf_multi_lot_guard",
    "rooms_bedrooms_conflict_evidence",
    "geocode",
    "tribunal_assignment",
)
# The collection index only needs the source freshness proof.  Enrichment
# payloads are hydrated later for URLs observed during the current run.
KNOWN_SALE_RAW_PAYLOAD_INDEX_KEYS = (
    "source_checks",
    "source_identity_mismatch",
    "source_presence",
)
# PostgreSQL caps a function call at 100 arguments.  A single
# ``jsonb_build_object`` needs two arguments per key, so keep each chunk below
# that limit and merge the chunks before stripping JSON nulls.  This preserves
# the complete allow-list while avoiding a runtime 54023 on the direct worker
# snapshot path.
KNOWN_SALE_RAW_PAYLOAD_PROJECTION_CHUNK_SIZE = 40


def _build_known_sale_raw_payload_projection(keys: tuple[str, ...]) -> str:
    chunks = tuple(
        "jsonb_build_object("
        + ",".join(
            f"'{key}',raw_payload->'{key}'"
            for key in keys[start : start + KNOWN_SALE_RAW_PAYLOAD_PROJECTION_CHUNK_SIZE]
        )
        + ")"
        for start in range(0, len(keys), KNOWN_SALE_RAW_PAYLOAD_PROJECTION_CHUNK_SIZE)
    )
    return "jsonb_strip_nulls(" + " || ".join(chunks) + ") as raw_payload"


KNOWN_SALE_RAW_PAYLOAD_PROJECTION = _build_known_sale_raw_payload_projection(
    KNOWN_SALE_RAW_PAYLOAD_KEYS
)
KNOWN_SALE_RAW_PAYLOAD_INDEX_PROJECTION = _build_known_sale_raw_payload_projection(
    KNOWN_SALE_RAW_PAYLOAD_INDEX_KEYS
)
KNOWN_SALE_POSTGRES_SELECT = ",".join(
    (
        KNOWN_SALE_DETAIL_SELECT.rsplit(",raw_payload", 1)[0],
        KNOWN_SALE_RAW_PAYLOAD_PROJECTION,
    )
)


def _known_sale_postgres_select(
    *,
    compact_presence: bool,
    include_enrichment_payload: bool = True,
) -> str:
    """Build the bounded snapshot projection for the active DB schema.

    The compact source-presence migration replaces the catalogue-view JSON
    expression with a SECURITY DEFINER helper.  Direct worker snapshots read
    ``auction_sales`` rather than those views, so hydrate the same projection
    here only after the helper's presence has been confirmed.
    """
    scalar_projection = KNOWN_SALE_DETAIL_SELECT.rsplit(",raw_payload", 1)[0]
    payload_projection = (
        KNOWN_SALE_RAW_PAYLOAD_PROJECTION
        if include_enrichment_payload
        else KNOWN_SALE_RAW_PAYLOAD_INDEX_PROJECTION
    )
    if not compact_presence:
        return ",".join((scalar_projection, payload_projection))
    compact_payload = (
        "jsonb_set("
        f"{payload_projection.removesuffix(' as raw_payload')},"
        "'{source_presence}',"
        "coalesce(app_private.auction_sale_source_presence_json(id),'{}'::jsonb),"
        "true) as raw_payload"
    )
    return ",".join((scalar_projection, compact_payload))
# Enrichment writes the full record back: a partial SELECT would erase price,
# procedure, dates and other facts that the worker did not actually re-extract.
DATA_REFRESH_SALE_SELECT = ",".join(dict.fromkeys((
    "id", "created_at", "updated_at", "first_seen_at", "last_seen_at", *UPSERT_COLUMNS,
)))

KNOWN_SALE_DETAIL_PAGE_SIZE = 100


def fetch_sale_for_data_refresh(source_url: str) -> AuctionSale | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key or not source_url:
        return None

    response = httpx.get(
        f"{str(url).rstrip('/')}/rest/v1/auction_sales",
        params={
            "select": DATA_REFRESH_SALE_SELECT,
            "source_url": f"eq.{source_url}",
            "limit": "1",
        },
        headers=_rest_headers(str(key), prefer="count=none"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase data refresh sale lookup failed: %s", response.text[:200])
        return None
    rows = response.json()
    if not rows:
        return None
    row = rows[0]
    if not row.get("source_name") or not row.get("source_url"):
        return None
    # A few legacy rows contain SQL NULL rather than the JSON empty arrays
    # required by AuctionSale. Pydantic defaults do not apply to explicit NULL.
    row["visit_dates"] = row.get("visit_dates") or []
    row["documents"] = row.get("documents") or []
    return AuctionSale(**row)


def fetch_known_sale_details(
    *,
    source_urls: list[str] | None = None,
    include_enrichment_payload: bool = False,
) -> dict[str, dict[str, Any]]:
    """Map known source URLs to fallback fields, hydrating payloads on demand.

    The default collection index keeps scalar source facts and freshness proof
    but omits the wide enrichment JSONB.  Pass ``source_urls`` and
    ``include_enrichment_payload=True`` after source discovery to hydrate only
    rows that will be reconciled in this run.  The REST fallback intentionally
    keeps its historical full projection because PostgREST cannot express the
    same reviewed-alias/source_urls predicate safely.
    """
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    requested_urls = _unique_source_urls(source_urls) if source_urls is not None else []
    if source_urls is not None and not requested_urls:
        return {}
    if db_url:
        # The publication runner already requires PostgreSQL. Read its
        # preflight snapshot there too, so a Data API outage cannot stop a
        # collection before the first source is scraped.
        with _postgres_connect(str(db_url)) as db:
            # Keep aliases and every keyset page on one MVCC snapshot.  The
            # previous one-shot SELECT had this property implicitly; setting
            # REPEATABLE READ before the first read preserves it after the
            # egress-bounded pagination change.
            db.execute("set transaction isolation level repeatable read")
            compact_presence = db.execute(
                "select to_regclass(%s), to_regprocedure(%s)",
                (
                    "app_private.auction_sale_source_presence",
                    "app_private.auction_sale_source_presence_json(uuid)",
                ),
            ).fetchone()
            use_compact_presence = bool(
                compact_presence
                and compact_presence[0]
                and compact_presence[1]
            )
            postgres_select = _known_sale_postgres_select(
                compact_presence=use_compact_presence,
                include_enrichment_payload=include_enrichment_payload,
            )
            reviewed_aliases = load_reviewed_aliases(db)
            relevant_aliases = (
                reviewed_aliases.aliases_for_urls(requested_urls)
                if source_urls is not None
                else tuple(reviewed_aliases.by_alias_url.values())
            )
            canonical_ids = sorted({alias.canonical_sale_id for alias in relevant_aliases})
            filter_params: list[object] = []
            where = "id is not null"
            if source_urls is not None:
                source_filters = ["source_url = any(%s::text[])", "source_urls ?| %s"]
                filter_params.extend((requested_urls, requested_urls))
                if canonical_ids:
                    source_filters.append("id = any(%s::uuid[])")
                    filter_params.append(canonical_ids)
                where += " and (" + " or ".join(source_filters) + ")"
            all_rows = []
            last_id: str | None = None
            while True:
                if last_id is None:
                    query = (
                        f"select to_jsonb(sale) from (select {postgres_select} "
                        f"from public.auction_sales where {where} "
                        "order by id limit %s) sale"
                    )
                    params = (*filter_params, KNOWN_SALE_DETAIL_PAGE_SIZE)
                else:
                    query = (
                        f"select to_jsonb(sale) from (select {postgres_select} "
                        f"from public.auction_sales where {where} and id > %s::uuid "
                        "order by id limit %s) sale"
                    )
                    params = (*filter_params, last_id, KNOWN_SALE_DETAIL_PAGE_SIZE)
                rows = db.execute(query, params).fetchall()
                if not rows:
                    break
                all_rows.extend(row[0] for row in rows)
                if len(rows) < KNOWN_SALE_DETAIL_PAGE_SIZE:
                    break
                page_ids = [
                    str(row[0].get("id"))
                    for row in rows
                    if isinstance(row[0], dict) and row[0].get("id")
                ]
                if not page_ids or page_ids[-1] == last_id:
                    raise ReviewedAliasRegistryError(
                        "Known sale detail snapshot could not advance its id cursor"
                    )
                last_id = page_ids[-1]
    else:
        if not url or not key:
            return {}
        reviewed_aliases = _fetch_reviewed_alias_registry(str(url), str(key))
        relevant_aliases = (
            reviewed_aliases.aliases_for_urls(requested_urls)
            if source_urls is not None
            else tuple(reviewed_aliases.by_alias_url.values())
        )
        endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
        all_rows = []
        offset = 0
        while True:
            try:
                response = _postgrest_request_with_retries(
                    "GET",
                    endpoint,
                    "known_sale_details",
                    params={
                        "select": KNOWN_SALE_DETAIL_SELECT,
                        "limit": str(KNOWN_SALE_DETAIL_PAGE_SIZE),
                        "offset": str(offset),
                    },
                    headers=_rest_headers(str(key), prefer="count=none"),
                    timeout=30,
                )
                if response.is_error:
                    raise RuntimeError(
                        f"Could not fetch known sale details ({response.status_code}): {response.text[:200]}"
                    )
                rows = response.json()
                if not isinstance(rows, list):
                    raise ReviewedAliasRegistryError("Malformed auction_sales detail response")
            except httpx.HTTPError as exc:
                raise RuntimeError(f"Known sale detail lookup failed: {exc}") from exc
            all_rows.extend(rows)
            if len(rows) < KNOWN_SALE_DETAIL_PAGE_SIZE:
                break
            offset += KNOWN_SALE_DETAIL_PAGE_SIZE

    for row in all_rows:
        if not isinstance(row, dict):
            raise ReviewedAliasRegistryError("Malformed auction_sales detail row")
        row["_signature"] = make_sale_signature(row.get("sale_date"), row.get("starting_price_eur"), row.get("status"))

    details: dict[str, dict[str, Any]] = {}
    rows_by_id = {
        str(row["id"]): row
        for row in all_rows
        if row.get("id")
    }
    for row in all_rows:
        for source_url in _known_source_urls(row):
            details.setdefault(source_url, row)
    for alias in relevant_aliases:
        canonical = rows_by_id.get(alias.canonical_sale_id)
        if canonical is None or canonical.get("source_url") != alias.canonical_source_url:
            raise ReviewedAliasRegistryError(
                f"Canonical row missing for reviewed alias {alias.alias_source_url}"
            )
        details[alias.alias_source_url] = canonical
    return details


def fetch_known_sale_signatures() -> dict[str, str]:
    """Map source_url → change-signature for already-enriched listings."""
    return {
        source_url: str(row["_signature"])
        for source_url, row in fetch_known_sale_details().items()
        if row.get("_signature") and row.get("score_version")
    }


def _known_source_urls(row: dict[str, Any]) -> list[str]:
    urls = [row.get("source_url")]
    if isinstance(row.get("source_urls"), list):
        urls.extend(row["source_urls"])
    elif isinstance(row.get("source_urls"), dict):
        urls.extend(row["source_urls"].values())
    return [str(url) for url in urls if url]


def touch_last_seen_for_source_urls(source_urls: list[str]) -> int:
    """Refresh last_seen_at for listings whose detail fetch was skipped. Best effort."""
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    unique = [u for u in {u for u in source_urls if u}]
    if not url or not key or not unique:
        return 0

    now = datetime.now(UTC).isoformat()
    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    touched = 0
    for index in range(0, len(unique), 150):
        batch = unique[index : index + 150]
        try:
            response = httpx.patch(
                endpoint,
                params={"source_url": _postgrest_in_filter(batch)},
                headers=_rest_headers(str(key), prefer="return=minimal"),
                json={"last_seen_at": now},
                timeout=30,
            )
            if not response.is_error:
                touched += len(batch)
        except httpx.HTTPError as exc:
            LOGGER.warning("last_seen touch (source_url) failed: %s", exc)
    return touched


def touch_last_seen_for_content_hashes(content_hashes: list[str]) -> int:
    """Refresh last_seen_at for listings skipped by the incremental run, so they
    are not considered stale even though they were not re-upserted. Best effort."""
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    unique = [h for h in {h for h in content_hashes if h}]
    if not url or not key or not unique:
        return 0

    now = datetime.now(UTC).isoformat()
    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    touched = 0
    for index in range(0, len(unique), 150):
        batch = unique[index : index + 150]
        try:
            response = httpx.patch(
                endpoint,
                params={"content_hash": _postgrest_in_filter(batch)},
                headers=_rest_headers(str(key), prefer="return=minimal"),
                json={"last_seen_at": now},
                timeout=30,
            )
            if not response.is_error:
                touched += len(batch)
        except httpx.HTTPError as exc:
            LOGGER.warning("last_seen touch failed: %s", exc)
    return touched


def mark_past_sales_in_supabase() -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    response = httpx.post(
        f"{str(url).rstrip('/')}/rest/v1/rpc/mark_elapsed_auction_sales",
        headers=_rest_headers(str(key), prefer="return=representation"),
        json={}, timeout=30,
    )
    response.raise_for_status()
    return int(response.json() or 0)


def delete_expired_sales_in_supabase(now: datetime | None = None) -> int:
    """Use the same atomic 24-hour policy as the independent scheduled job."""
    settings = load_settings()
    url, key = settings["supabase_url"], settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    deleted = 0
    for _ in range(40):
        response = httpx.post(
            f"{str(url).rstrip('/')}/rest/v1/rpc/purge_expired_auction_sales",
            headers=_rest_headers(str(key), prefer="return=representation"),
            json={"p_now": current.isoformat(), "p_limit": 25}, timeout=120,
        )
        response.raise_for_status()
        result = response.json()
        deleted += int(result["deleted"])
        if result.get("busy") or not result.get("remaining") or not result["deleted"]:
            break
    return deleted


def delete_vench_sales_without_surface_in_supabase() -> int:
    """Compatibility shim: admission replaces destructive source-specific cleanup."""
    return 0


def _delete_sale_rows_by_source_urls(supabase_url: str, api_key: str, source_urls: list[str]) -> int:
    unique = _unique_source_urls(source_urls)
    if not unique:
        return 0
    for table in EXPIRED_SALE_DELETE_TABLES:
        _postgrest_delete_by_source_urls(supabase_url, api_key, table, unique)
    return len(unique)



def _upsert_with_rest(supabase_url: str, api_key: str, payload: list[dict[str, object]]) -> None:
    _postgrest_upsert(supabase_url, api_key, "auction_sales", payload, on_conflict="source_url")


def _delete_secondary_sale_rows(
    supabase_url: str,
    api_key: str,
    sales: list[AuctionSale],
    *,
    registry: ReviewedAliasRegistry | None = None,
) -> int:
    registry = registry or _fetch_reviewed_alias_registry(supabase_url, api_key)
    protected_urls = registry.protected_source_urls()
    secondary_urls = [
        source_url
        for source_url in _secondary_source_urls(sales)
        if source_url not in protected_urls
    ]
    if not secondary_urls:
        return 0
    return _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_sales", secondary_urls)


def _delete_secondary_sale_rows_with_postgres(db_url: str, sales: list[AuctionSale]) -> int:
    if psycopg is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    secondary_urls = _secondary_source_urls(sales)
    if not secondary_urls:
        return 0
    with _postgres_connect(db_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "select pg_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0))"
            )
            # Re-read the relation while holding the publication lock.  The
            # REST snapshot used by the caller is only an early filter; this
            # is the final guard immediately before deleting parent rows.
            reviewed_aliases = load_reviewed_aliases(cursor)
            protected_ids = reviewed_aliases.protected_sale_ids()
            protected_urls = reviewed_aliases.protected_source_urls()
            secondary_urls = [
                source_url
                for source_url in secondary_urls
                if source_url not in protected_urls
            ]
            if not secondary_urls:
                return 0
            rows = cursor.execute(
                """
                select id::text, source_url
                from public.auction_sales
                where source_url = any(%s)
                for update
                """,
                (secondary_urls,),
            ).fetchall()
            deletable = [
                (str(sale_id), source_url)
                for sale_id, source_url in rows
                if str(sale_id) not in protected_ids
                and source_url not in protected_urls
            ]
            if not deletable:
                return 0
            deletable_ids = [sale_id for sale_id, _source_url in deletable]
            deletable_urls = [source_url for _sale_id, source_url in deletable]
            cursor.execute(
                "delete from public.auction_observations where source_url = any(%s)",
                (deletable_urls,),
            )
            cursor.execute(
                "delete from public.auction_sales where id = any(%s::uuid[])",
                (deletable_ids,),
            )
    return len(deletable_ids)


def _rest_parented_observation_payload(
    supabase_url: str,
    api_key: str,
    payload: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Filter REST observations against exact canonical parent rows.

    REST has no transaction spanning the parent read and child write.  The
    production path therefore requires direct PostgreSQL; this fallback still
    fails closed when the parent read is unavailable and relies on the FK for
    the remaining concurrent-delete race.
    """
    canonical_urls = sorted({
        str(row.get('canonical_source_url'))
        for row in payload
        if row.get('canonical_source_url')
    })
    if not canonical_urls:
        return []
    response = _postgrest_request_with_retries(
        "GET",
        f"{supabase_url.rstrip('/')}/rest/v1/auction_sales",
        "auction_sales",
        params={
            "select": "source_url",
            "source_url": _postgrest_in_filter(canonical_urls),
        },
        headers=_rest_headers(api_key, prefer="count=none"),
        timeout=POSTGREST_TIMEOUT,
    )
    if response.is_error:
        raise httpx.HTTPStatusError(
            f"{response.status_code} response from Supabase auction_sales parent check: {response.text}",
            request=response.request,
            response=response,
        )
    rows = response.json()
    existing = {
        str(row.get('source_url'))
        for row in rows
        if isinstance(row, dict) and row.get('source_url')
    }
    return [row for row in payload if str(row.get('canonical_source_url') or '') in existing]


def _parented_observation_payload(connection: Any, payload: list[dict[str, object]]) -> list[dict[str, object]]:
    """Return observations whose canonical URL has a locked catalogue parent.

    An identity merge may quarantine an incoming sale without persisting its
    URL.  Observations are written after the sale call by the collector, so
    this check is deliberately repeated here.  ``FOR KEY SHARE`` keeps a
    concurrent parent deletion from slipping between the check and the child
    upsert; aliases already recorded in ``source_urls`` are rewritten to the
    locked canonical URL.
    """
    canonical_urls = sorted({
        str(row.get('canonical_source_url'))
        for row in payload
        if row.get('canonical_source_url')
    })
    if not canonical_urls:
        return []
    def as_text(value: object) -> str:
        if isinstance(value, bytes):
            return value.decode('utf-8', errors='replace')
        return str(value)

    parents = connection.execute(
        """
        select source_url, source_urls
        from public.auction_sales
        where source_url = any(%s) or source_urls ?| %s
        for key share
        """,
        (canonical_urls, canonical_urls),
    ).fetchall()
    parent_by_candidate: dict[str, set[str]] = {}
    for parent_url, aliases in parents:
        parent = as_text(parent_url)
        parent_by_candidate.setdefault(parent, set()).add(parent)
        if isinstance(aliases, list):
            for alias in aliases:
                if alias:
                    parent_by_candidate.setdefault(as_text(alias), set()).add(parent)

    eligible: list[dict[str, object]] = []
    for row in payload:
        candidate = str(row.get('canonical_source_url') or '')
        matches = parent_by_candidate.get(candidate, set())
        if len(matches) != 1:
            LOGGER.warning(
                "Skipping observation without one locked canonical parent: %s",
                candidate,
            )
            continue
        canonical = next(iter(matches))
        eligible.append({**row, 'canonical_source_url': canonical})
    return eligible


def _postgres_upsert_observations_with_parent_guard(
    db_url: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> int:
    def write_batch(connection: Any, batch: list[dict[str, object]]) -> int:
        eligible = _parented_observation_payload(connection, batch)
        if not eligible:
            return 0
        _transaction_write("auction_observations", eligible, on_conflict)
        return len(eligible)

    if not payload:
        return 0

    connection = _PUBLICATION_CONNECTION.get()
    if connection is not None:
        return sum(
            write_batch(connection, batch)
            for batch in _observation_payload_batches(payload)
        )

    persisted = 0
    # Each batch uses its own transaction. A later timeout therefore leaves
    # earlier observation checkpoints durable and safe to replay idempotently.
    for batch in _observation_payload_batches(payload):
        with _postgres_connect(db_url) as connection:
            token = _PUBLICATION_CONNECTION.set(connection)
            try:
                persisted += write_batch(connection, batch)
            finally:
                _PUBLICATION_CONNECTION.reset(token)
    return persisted


def _observation_payload_batches(
    payload: list[dict[str, object]],
    batch_size: int = POSTGRES_OBSERVATION_BATCH_SIZE,
) -> list[list[dict[str, object]]]:
    """Split observation writes without separating one canonical sale's aliases.

    The caller fills ``canonical_source_url`` from the sale identity. Keeping
    that canonical group together avoids locking and resolving the same parent
    repeatedly while preserving the source URL uniqueness used by the
    idempotent ``ON CONFLICT`` write. A group larger than the bound is split
    because the bound must remain hard. A malformed direct caller without a
    canonical value is grouped by its source URL only; the parent guard still
    rejects that row because it cannot prove a canonical parent.
    """
    if batch_size <= 0:
        raise ValueError("Observation batch size must be positive")
    groups: dict[str, list[dict[str, object]]] = {}
    for row in payload:
        canonical = str(row.get("canonical_source_url") or row.get("source_url") or "")
        groups.setdefault(canonical, []).append(row)

    batches: list[list[dict[str, object]]] = []
    current: list[dict[str, object]] = []
    for group in groups.values():
        if len(group) > batch_size:
            if current:
                batches.append(current)
                current = []
            for offset in range(0, len(group), batch_size):
                batches.append(group[offset : offset + batch_size])
            continue
        if current and len(current) + len(group) > batch_size:
            batches.append(current)
            current = []
        current.extend(group)
    if current:
        batches.append(current)
    return batches


def _postgres_upsert(
    db_url: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> int | None:
    if psycopg is None or sql is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    if not payload:
        return 0
    if table == "auction_observations":
        return _postgres_upsert_observations_with_parent_guard(db_url, payload, on_conflict)
    conflict_columns = tuple(column.strip() for column in on_conflict.split(",") if column.strip())
    if not conflict_columns:
        raise ValueError("Postgres upsert requires at least one conflict column")
    columns = list(payload[0].keys())
    insert_statement = sql.SQL(
        "insert into {} ({}) values ({}) on conflict ({}) do update set {}"
    ).format(
        sql.Identifier("public", table),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
        sql.SQL(", ").join(sql.Identifier(column) for column in conflict_columns),
        sql.SQL(", ").join(
            sql.SQL("{} = excluded.{}").format(sql.Identifier(column), sql.Identifier(column))
            for column in columns
            if column not in conflict_columns
        ),
    )
    rows = [tuple(_postgres_value(column, row.get(column)) for column in columns) for row in payload]
    with _postgres_connect(db_url) as connection:
        with connection.cursor() as cursor:
            cursor.executemany(insert_statement, rows)
    return None


def _statement_timeout_options(db_url: str, statement_timeout_ms: int | None) -> str | None:
    """Server option applying the default statement timeout to the whole session.

    A URL that already carries its own ``options`` keeps full control.
    """
    if statement_timeout_ms is None or "options=" in db_url.lower():
        return None
    return f"-c statement_timeout={max(0, int(statement_timeout_ms))}"


def _postgres_connect(
    db_url: str,
    *,
    connect_timeout: int = POSTGRES_CONNECT_TIMEOUT,
    retry_delays: tuple[float, ...] | None = None,
    statement_timeout_ms: int | None = POSTGRES_STATEMENT_TIMEOUT_MS,
) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    delays = POSTGRES_CONNECT_RETRY_DELAYS if retry_delays is None else retry_delays
    options = _statement_timeout_options(db_url, statement_timeout_ms)
    for attempt, delay in enumerate((0.0, *delays), start=1):
        if delay:
            time.sleep(delay)
        try:
            connect_kwargs: dict[str, Any] = {
                "connect_timeout": connect_timeout,
                "prepare_threshold": None,
            }
            if options:
                connect_kwargs["options"] = options
            return psycopg.connect(db_url, **connect_kwargs)
        except Exception as exc:
            message = str(exc).lower()
            if options and "unsupported startup parameter" in message:
                # Transaction poolers reject startup options. Fall back to a
                # session-level SET once connected (statements that need a
                # guaranteed limit still use SET LOCAL).
                LOGGER.warning("PostgreSQL pooler rejected startup options; using SET statement_timeout")
                connection = psycopg.connect(
                    db_url, connect_timeout=connect_timeout, prepare_threshold=None
                )
                try:
                    connection.execute(f"set statement_timeout = {max(0, int(statement_timeout_ms or 0))}")
                    connection.commit()
                except Exception:
                    connection.close()
                    raise
                return connection
            transient = any(
                marker in message
                for marker in (
                    "checkouttime",
                    "connection pool",
                    "connection timeout",
                    "connection reset",
                    "connection refused",
                    "closed unexpectedly",
                )
            )
            if not transient or attempt > len(delays):
                raise
            LOGGER.warning(
                "Transient PostgreSQL connection failure; retrying attempt=%s/%s: %s",
                attempt,
                len(delays) + 1,
                exc,
            )
    raise AssertionError("unreachable")


def connect(db_url: str, **options: Any) -> Any:
    """Public entry point for opening a direct PostgreSQL connection.

    Every module outside ``src.storage`` goes through here instead of importing
    the private ``_postgres_connect``. The keyword ``options`` are forwarded
    untouched (``connect_timeout``, ``retry_delays``, ``statement_timeout_ms``),
    so the timeouts, startup options, SSL handling and retry behaviour are
    exactly those of ``_postgres_connect``.

    The call is resolved through the module attribute ``_postgres_connect`` at
    call time, so tests that patch ``supabase_client._postgres_connect`` keep
    intercepting every caller, including those that imported ``connect`` by name.
    """
    return _postgres_connect(db_url, **options)


_SHARED_CONNECTIONS: dict[tuple[int, str], tuple[Any, float]] = {}
_SHARED_CONNECTION_LOCK = threading.RLock()


@contextmanager
def _shared_postgres_connection(db_url: str):
    """Yield one autocommit connection per process, instead of one per call.

    Meant for the short single-statement calls made once per LLM prediction or
    per source-detail request. Callers are serialised by a lock, a connection
    that sat idle is pinged before use, and a connection that failed is
    discarded so the next call reconnects.
    """
    key = (os.getpid(), db_url)
    with _SHARED_CONNECTION_LOCK:
        entry = _SHARED_CONNECTIONS.get(key)
        connection = entry[0] if entry else None
        if connection is not None:
            usable = not getattr(connection, "closed", False)
            if usable and time.monotonic() - entry[1] > POSTGRES_SHARED_CONNECTION_PING_AFTER_SECONDS:
                try:
                    connection.execute("select 1")
                except Exception:
                    usable = False
            if not usable:
                _discard_shared_connection(key)
                connection = None
        if connection is None:
            connection = _postgres_connect(db_url)
            connection.autocommit = True
            _SHARED_CONNECTIONS[key] = (connection, time.monotonic())
        try:
            yield connection
        except BaseException as exc:
            # An SQL error in autocommit mode leaves the session usable; a
            # transport failure, cancellation or interrupt does not.
            broken_types = (psycopg.OperationalError, psycopg.InterfaceError) if psycopg else ()
            if not isinstance(exc, Exception) or isinstance(exc, broken_types) or getattr(connection, "closed", False):
                _discard_shared_connection(key)
            raise
        else:
            _SHARED_CONNECTIONS[key] = (connection, time.monotonic())


def _discard_shared_connection(key: tuple[int, str]) -> None:
    entry = _SHARED_CONNECTIONS.pop(key, None)
    if entry is not None:
        try:
            entry[0].close()
        except Exception:
            pass


def _postgres_value(column: str, value: object) -> object:
    value = _sanitize_postgrest_payload(value)
    if value is None:
        return None
    if column in POSTGRES_JSON_COLUMNS:
        return Jsonb(value) if Jsonb is not None else value
    return value


def _secondary_source_urls(sales: list[AuctionSale]) -> list[str]:
    primary_urls = {sale.source_url for sale in sales if sale.source_url}
    urls: list[str] = []
    seen: set[str] = set()
    for sale in sales:
        for source_url in sale.source_urls:
            if source_url in primary_urls or source_url in seen:
                continue
            seen.add(source_url)
            urls.append(source_url)
    return urls


def _sync_normalized_sale_tables_with_rest(
    supabase_url: str,
    api_key: str,
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> None:
    properties = [
        _timestamped(row, now)
        for row in _property_rows_for_sales(sales, now, refresh_last_seen=refresh_last_seen)
    ]
    judicial_sales = [
        _timestamped(row, now)
        for row in _judicial_sale_rows_for_sales(sales, now, refresh_last_seen=refresh_last_seen)
    ]
    if properties:
        _postgrest_upsert(supabase_url, api_key, "properties", properties, on_conflict="source_url")
    if judicial_sales:
        _postgrest_upsert(supabase_url, api_key, "judicial_sales", judicial_sales, on_conflict="source_url")


def _property_rows_for_sales(
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for sale in sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in PROPERTY_COLUMNS}
        row["primary_source"] = row.get("primary_source") or row.get("source_name")
        row["source_urls"] = _normalized_source_urls(sale, data)
        row["raw_payload"] = data.get("raw_payload") if isinstance(data.get("raw_payload"), dict) else {}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        rows.append(row)
    return rows


def _judicial_sale_rows_for_sales(
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for sale in sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in JUDICIAL_SALE_COLUMNS}
        row["property_source_url"] = data.get("source_url")
        row["primary_source"] = row.get("primary_source") or row.get("source_name")
        row["source_urls"] = _normalized_source_urls(sale, data)
        row["visit_dates"] = data.get("visit_dates") if isinstance(data.get("visit_dates"), list) else []
        row["status"] = data.get("status") or "upcoming"
        row["source_lawyer_name"] = data.get("lawyer_name")
        row["source_lawyer_contact"] = data.get("lawyer_contact")
        documents = data.get("documents")
        row["documents_count"] = len(documents) if isinstance(documents, list) else 0
        row["score_factors"] = data.get("score_factors") if isinstance(data.get("score_factors"), list) else []
        row["quality_flags"] = data.get("quality_flags") if isinstance(data.get("quality_flags"), list) else []
        row["raw_payload"] = data.get("raw_payload") if isinstance(data.get("raw_payload"), dict) else {}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        rows.append(row)
    return rows


def _normalized_source_urls(sale: AuctionSale, data: dict[str, Any]) -> list[str]:
    values = data.get("source_urls")
    source_urls = values if isinstance(values, list) else []
    urls = [data.get("source_url"), *source_urls, *sale.source_urls]
    normalized: list[str] = []
    seen: set[str] = set()
    for url in urls:
        if not isinstance(url, str) or not url or url in seen:
            continue
        normalized.append(url)
        seen.add(url)
    return normalized


def _upsert_asset_tables_with_rest(supabase_url: str, api_key: str, sales: list[AuctionSale], now: str) -> None:
    features = [_timestamped(build_auction_features_row(sale), now) for sale in sales]
    surfaces = [_timestamped(build_auction_surfaces_row(sale), now) for sale in sales]
    if features:
        _postgrest_upsert(supabase_url, api_key, "auction_features", features, on_conflict="source_url")
    if surfaces:
        _postgrest_upsert(supabase_url, api_key, "auction_surfaces", surfaces, on_conflict="source_url")
    source_urls = [sale.source_url for sale in sales]
    if source_urls:
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_surface_derivations", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_surface_measurements", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_risks", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_risk_occurrences", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_urban_planning_signals", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_score_factors", source_urls)
    risk_occurrences_by_source = {sale.source_url: _risk_occurrence_rows_for_sale(sale) for sale in sales}
    risk_rows = [
        _timestamped(row, now)
        for sale in sales
        for row in build_auction_risk_rows_from_occurrences(
            sale.source_url,
            risk_occurrences_by_source.get(sale.source_url, []),
        )
    ]
    if risk_rows:
        _postgrest_insert(supabase_url, api_key, "auction_risks", risk_rows)
    risk_occurrences = [_timestamped(row, now) for rows in risk_occurrences_by_source.values() for row in rows]
    if risk_occurrences:
        _postgrest_insert(supabase_url, api_key, "auction_risk_occurrences", risk_occurrences)
    urban_planning_signals = [
        _timestamped(row, now)
        for sale in sales
        for row in build_urban_planning_signal_rows(sale, pdf_texts=_load_pdf_texts(sale))
    ]
    if urban_planning_signals:
        _postgrest_insert(
            supabase_url,
            api_key,
            "auction_urban_planning_signals",
            urban_planning_signals,
        )
    surface_measurements = [
        _timestamped(row, now)
        for sale in sales
        for row in _surface_measurement_rows_for_sale(sale)
    ]
    if surface_measurements:
        _postgrest_insert(
            supabase_url,
            api_key,
            "auction_surface_measurements",
            surface_measurements,
        )
    surface_derivations = [
        _timestamped(row, now)
        for sale in sales
        for row in _surface_derivation_rows_for_sale(sale)
    ]
    if surface_derivations:
        _postgrest_insert(
            supabase_url,
            api_key,
            "auction_surface_derivations",
            surface_derivations,
        )
    score_factors = [
        _timestamped(row, now)
        for sale in sales
        for row in build_auction_score_factor_rows(
            sale,
            risk_occurrences_by_source.get(sale.source_url, []),
        )
    ]
    if score_factors:
        _postgrest_insert(supabase_url, api_key, "auction_score_factors", score_factors)
    # Read the strict historical recovery map once.  The document rows and
    # the post-extraction cache writer must consume this exact map so a cold
    # worker cannot perform two reads or materialize a partial sibling.
    persisted_pdf_texts = _fetch_persisted_pdf_texts_for_sales(sales, supabase_url, api_key)
    upsert_documents_to_supabase(
        sales,
        persisted_pdf_texts=persisted_pdf_texts,
        prune_stale=True,
    )
    upsert_extractions_to_supabase(sales)
    _restore_persisted_pdf_text_caches(sales, persisted_pdf_texts)


def _postgrest_upsert(
    supabase_url: str,
    api_key: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> None:
    if _PUBLICATION_CONNECTION.get() is not None:
        _transaction_write(table, payload, on_conflict)
        return
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    for batch in _postgrest_batches(payload, _postgrest_batch_size(table)):
        response = _postgrest_upsert_batch(
            endpoint,
            api_key,
            table,
            batch,
            on_conflict,
        )
        if response.is_error:
            raise httpx.HTTPStatusError(
                f"{response.status_code} response from Supabase {table}: {response.text}",
                request=response.request,
                response=response,
            )


def _postgrest_upsert_batch(
    endpoint: str,
    api_key: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> httpx.Response:
    last_timeout: httpx.TimeoutException | None = None
    for attempt in range(1, POSTGREST_UPSERT_RETRIES + 1):
        try:
            response = httpx.post(
                endpoint,
                params={"on_conflict": on_conflict},
                headers=_rest_headers(api_key, prefer="resolution=merge-duplicates,return=minimal"),
                json=_sanitize_postgrest_payload(payload),
                timeout=POSTGREST_TIMEOUT,
            )
            if response.status_code not in POSTGREST_RETRYABLE_STATUS_CODES or attempt == POSTGREST_UPSERT_RETRIES:
                return response
            LOGGER.warning(
                "Supabase %s upsert returned %s on attempt %s/%s for %s rows; retrying",
                table,
                response.status_code,
                attempt,
                POSTGREST_UPSERT_RETRIES,
                len(payload),
            )
        except httpx.TimeoutException as exc:
            last_timeout = exc
            if attempt == POSTGREST_UPSERT_RETRIES:
                raise
            LOGGER.warning(
                "Supabase %s upsert timed out on attempt %s/%s for %s rows; retrying",
                table,
                attempt,
                POSTGREST_UPSERT_RETRIES,
                len(payload),
            )
        time.sleep(2 * attempt)
    if last_timeout is not None:
        raise last_timeout
    raise RuntimeError(f"Supabase {table} upsert failed before request")


def _postgrest_insert(supabase_url: str, api_key: str, table: str, payload: list[dict[str, object]]) -> None:
    if _PUBLICATION_CONNECTION.get() is not None:
        _transaction_write(table, payload)
        return
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    for batch in _postgrest_batches(payload, _postgrest_batch_size(table)):
        response = _postgrest_request_with_retries(
            "POST",
            endpoint,
            table=table,
            headers=_rest_headers(api_key, prefer="return=minimal"),
            json=_sanitize_postgrest_payload(batch),
            timeout=POSTGREST_TIMEOUT,
        )
        if response.is_error:
            raise httpx.HTTPStatusError(
                f"{response.status_code} response from Supabase {table}: {response.text}",
                request=response.request,
                response=response,
            )


def _postgrest_delete(supabase_url: str, api_key: str, table: str, params: dict[str, str]) -> None:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    response = _postgrest_request_with_retries(
        "DELETE",
        endpoint,
        table=table,
        params=params,
        headers=_rest_headers(api_key, prefer="return=minimal"),
        timeout=30,
    )
    if response.is_error:
        raise httpx.HTTPStatusError(
            f"{response.status_code} response from Supabase {table}: {response.text}",
            request=response.request,
            response=response,
        )


def _postgrest_delete_by_source_urls(supabase_url: str, api_key: str, table: str, source_urls: list[str]) -> int:
    connection = _PUBLICATION_CONNECTION.get()
    if connection is not None:
        connection.execute(sql.SQL("delete from {} where source_url = any(%s)").format(sql.Identifier("public", table)), (source_urls,))
        return len(set(source_urls))
    unique = _unique_source_urls(source_urls)
    for index in range(0, len(unique), POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE):
        batch = unique[index : index + POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE]
        _postgrest_delete(
            supabase_url,
            api_key,
            table,
            {"source_url": _postgrest_in_filter(batch)},
        )
    return len(unique)


def _prune_stale_document_rows(
    supabase_url: str,
    api_key: str,
    sales: list[AuctionSale],
) -> None:
    """Remove old attachment rows after a complete source revision.

    ``auction_documents`` is a child projection.  Upserting the current
    attachments alone leaves removed URLs visible forever because the view
    joins every child row by ``source_url``.  Delete only rows owned by a
    source revision explicitly marked ``complete``; restricted/partial,
    failed, malformed, and unmarked manifests remain upsert-only.
    The source-url predicate also prevents a stale revision from deleting a
    row belonging to another sale.
    """
    expected_by_source: dict[str, set[str]] = {}
    invalid_sources: set[str] = set()
    for sale in sales:
        source_url = clean_text(sale.source_url)
        if not source_url:
            continue
        documents = sale.documents
        if not isinstance(documents, list) or any(
            not isinstance(document, dict) or not clean_text(document.get("url"))
            for document in documents
        ):
            invalid_sources.add(source_url)
            continue
        raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
        detail_status = (clean_text(raw_payload.get("source_detail_status")) or "").casefold()
        if detail_status != "complete":
            invalid_sources.add(source_url)
            continue
        expected_by_source.setdefault(source_url, set()).update(
            clean_text(document.get("url"))
            for document in documents
            if isinstance(document, dict) and clean_text(document.get("url"))
        )
    for source_url in invalid_sources:
        expected_by_source.pop(source_url, None)
    if not expected_by_source:
        return

    connection = _PUBLICATION_CONNECTION.get()
    if connection is not None:
        for source_url, current_urls in expected_by_source.items():
            if current_urls:
                connection.execute(
                    "delete from public.auction_documents "
                    "where source_url = %s and not (document_url = any(%s))",
                    (source_url, list(current_urls)),
                )
            else:
                connection.execute(
                    "delete from public.auction_documents where source_url = %s",
                    (source_url,),
                )
        return

    for source_url, current_urls in expected_by_source.items():
        params = {"source_url": f"eq.{source_url}"}
        if current_urls:
            params["document_url"] = f"not.{_postgrest_in_filter(sorted(current_urls))}"
        _postgrest_delete(supabase_url, api_key, "auction_documents", params)


def _unique_source_urls(source_urls: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for source_url in source_urls:
        if not source_url or source_url in seen:
            continue
        seen.add(source_url)
        unique.append(source_url)
    return unique


def _postgrest_request_with_retries(method: str, endpoint: str, table: str, **kwargs: Any) -> httpx.Response:
    last_timeout: httpx.TimeoutException | None = None
    request_method = getattr(httpx, method.lower())
    for attempt in range(1, POSTGREST_UPSERT_RETRIES + 1):
        try:
            response = request_method(endpoint, **kwargs)
            status_code = getattr(response, "status_code", 200 if not response.is_error else 500)
            if status_code not in POSTGREST_RETRYABLE_STATUS_CODES or attempt == POSTGREST_UPSERT_RETRIES:
                return response
            LOGGER.warning(
                "Supabase %s %s returned %s on attempt %s/%s; retrying",
                table,
                method,
                response.status_code,
                attempt,
                POSTGREST_UPSERT_RETRIES,
            )
        except httpx.TimeoutException as exc:
            last_timeout = exc
            if attempt == POSTGREST_UPSERT_RETRIES:
                raise
            LOGGER.warning(
                "Supabase %s %s timed out on attempt %s/%s; retrying",
                table,
                method,
                attempt,
                POSTGREST_UPSERT_RETRIES,
            )
        time.sleep(2 * attempt)
    if last_timeout is not None:
        raise last_timeout
    raise RuntimeError(f"Supabase {table} {method} failed before request")


def _postgrest_in_filter(values: list[str]) -> str:
    quoted = []
    for value in values:
        escaped = value.replace('"', '\\"')
        quoted.append(f'"{escaped}"')
    return f"in.({','.join(quoted)})"


def _postgrest_batch_size(table: str) -> int:
    if table in {"auction_sales", "auction_extractions"}:
        return 5
    if table == "auction_observations":
        return 10
    if table in {"auction_documents", "auction_score_factors", "auction_risk_occurrences"}:
        return 25
    return 100


def _postgrest_batches(payload: list[dict[str, object]], batch_size: int) -> list[list[dict[str, object]]]:
    return [payload[index : index + batch_size] for index in range(0, len(payload), batch_size)]


def _rest_headers(api_key: str, prefer: str) -> dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def _timestamped(row: dict[str, object], now: str) -> dict[str, object]:
    row["updated_at"] = now
    return row


def _sanitize_postgrest_payload(
    value: Any,
    *,
    _path: str = "root",
    _active_paths: dict[int, str] | None = None,
    _depth: int = 0,
) -> Any:
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if not isinstance(value, (list, dict)):
        return value

    if _depth > POSTGREST_MAX_PAYLOAD_DEPTH:
        raise ValueError(
            f"PostgREST payload exceeds maximum nesting depth {POSTGREST_MAX_PAYLOAD_DEPTH} at {_path}"
        )

    active_paths = _active_paths if _active_paths is not None else {}
    value_id = id(value)
    first_path = active_paths.get(value_id)
    if first_path is not None:
        raise ValueError(
            f"PostgREST payload cycle detected at {_path}; container first seen at {first_path}"
        )
    active_paths[value_id] = _path
    try:
        if isinstance(value, list):
            return [
                _sanitize_postgrest_payload(
                    item,
                    _path=f"{_path}[{index}]",
                    _active_paths=active_paths,
                    _depth=_depth + 1,
                )
                for index, item in enumerate(value)
            ]
        return {
            key: _sanitize_postgrest_payload(
                item,
                _path=f"{_path}[{key!r}]",
                _active_paths=active_paths,
                _depth=_depth + 1,
            )
            for key, item in value.items()
        }
    finally:
        del active_paths[value_id]


def _risk_occurrence_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen: set[tuple[object, ...]] = set()
    for item in _load_pdf_texts(sale):
        if not isinstance(item, dict):
            continue
        document_url = str(item.get("url") or "")
        document_type = str(item.get("document_type") or "") or classify_document_type(str(item.get("label") or ""), document_url)
        pages = item.get("pages")
        has_page_text = isinstance(pages, list) and any(
            isinstance(page, dict) and page.get("text") for page in pages
        )
        page_items = pages if has_page_text else [{"page": None, "text": item.get("text")}]
        for page in page_items:
            if not isinstance(page, dict):
                continue
            page_number = page.get("page") if isinstance(page.get("page"), int) else None
            for occurrence in extract_risk_occurrences_from_text(
                str(page.get("text") or ""),
                sale.source_url,
                source_kind="pdf",
                document_url=document_url or None,
                document_label=str(item.get("label") or "") or None,
                document_type=document_type,
                page_number=page_number,
            ):
                key = (
                    occurrence.get("risk_label"),
                    occurrence.get("document_url"),
                    occurrence.get("page_number"),
                    str(occurrence.get("excerpt") or "")[:120],
                )
                if key in seen:
                    continue
                seen.add(key)
                rows.append(_public_occurrence_row(occurrence))

    if rows:
        return rows[:100]

    fallback_text = " ".join(filter(None, [sale.title, sale.description, sale.raw_text]))
    return [
        _public_occurrence_row(occurrence)
        for occurrence in extract_risk_occurrences_from_text(
            fallback_text,
            sale.source_url,
            source_kind="sale_text",
        )
    ][:50]


def _public_occurrence_row(occurrence: dict[str, object]) -> dict[str, object]:
    return {
        "source_url": occurrence["source_url"],
        "risk_type": occurrence["risk_type"],
        "risk_label": occurrence["risk_label"],
        "severity": occurrence["severity"],
        "document_url": occurrence.get("document_url"),
        "document_label": occurrence.get("document_label"),
        "document_type": occurrence.get("document_type"),
        "page_number": occurrence.get("page_number"),
        "excerpt": occurrence["excerpt"],
        "confidence": occurrence.get("confidence"),
        "detector": occurrence.get("detector"),
        "detector_version": occurrence.get("detector_version"),
        "matched_terms": occurrence.get("matched_terms") or [],
        "is_negated": occurrence.get("is_negated") or False,
        "score_impact": occurrence.get("score_impact"),
    }


def _document_rows_for_sale(
    sale: AuctionSale,
    *,
    pdf_texts: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    documents = sale.documents
    if not isinstance(documents, list) or any(not isinstance(document, dict) for document in documents):
        return []
    pdf_texts = _load_pdf_texts(sale) if pdf_texts is None else pdf_texts
    text_by_url = {item.get("url"): item for item in pdf_texts if isinstance(item, dict)}
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    invalid_analysis = analysis is not None and not isinstance(analysis, dict)
    current_analysis_profiles: dict[str, dict[str, object]] = {}
    fresh_analysis = (
        isinstance(analysis, dict)
        and analysis.get("input_fingerprint") == document_fingerprint(documents)
        and timestamp_is_fresh(analysis.get("checked_at"))
    )
    if (
        fresh_analysis
        and (
            "profiles" not in analysis
            or (
                isinstance(analysis.get("profiles"), list)
                and all(isinstance(profile, dict) for profile in analysis["profiles"])
            )
        )
    ):
        current_analysis_profiles = {
            str(profile.get("url")): profile
            for profile in analysis.get("profiles") or []
            if isinstance(profile, dict) and profile.get("url")
        }
        if "profiles" in analysis:
            profile_urls = set(current_analysis_profiles)
            excluded_urls: set[str] = set()
            for key in ("skipped_document_urls", "blocked_document_urls", "terminal_document_urls"):
                values = analysis.get(key)
                if values is not None and not isinstance(values, (list, tuple, set)):
                    invalid_analysis = True
                    continue
                excluded_urls.update(clean_text(url) for url in values or [] if clean_text(url))
            expected_profile_urls = {
                clean_text(document.get("url"))
                for document in documents
            } - excluded_urls
            if not expected_profile_urls.issubset(profile_urls):
                invalid_analysis = True
    rows = []
    if isinstance(analysis, dict) and "profiles" in analysis and not (
        isinstance(analysis.get("profiles"), list)
        and all(isinstance(profile, dict) for profile in analysis["profiles"])
    ):
        invalid_analysis = True
    for document in documents:
        url = document.get("url")
        if not url:
            continue
        extracted = text_by_url.get(url, {})
        pages = extracted.get("pages") if isinstance(extracted, dict) else None
        page_count = len(pages) if isinstance(pages, list) else None
        extracted_text = clean_text(extracted.get("text")) if isinstance(extracted, dict) else None
        try:
            text_chars = int(extracted.get("text_chars") or len(extracted_text or "")) if extracted else 0
        except (OverflowError, TypeError, ValueError):
            text_chars = 0
        extraction_confidence = extracted.get("confidence") if isinstance(extracted, dict) else None
        row_file_path = extracted.get("file_path") if isinstance(extracted, dict) else None
        row_sha256 = extracted.get("sha256") if isinstance(extracted, dict) else None
        persisted_pdf_proof = isinstance(extracted, dict) and extracted.get("_persisted_pdf_proof") is True
        persisted_verified_at = (
            extracted.get("_persisted_verified_at")
            if isinstance(extracted, dict) and persisted_pdf_proof
            else None
        )
        raw_payload = dict(document)
        if persisted_pdf_proof:
            # A reconstructed worker cannot reopen a local path from the
            # original extraction host.  Keep the document URL and hashes,
            # but do not persist that stale path in the child payload either.
            raw_payload.pop("file_path", None)
        if isinstance(extracted, dict):
            raw_payload["extraction"] = {
                "cache_version": extracted.get("cache_version"),
                "extraction_method": extracted.get("extraction_method"),
                "page_count": page_count,
                "ocr_pages": extracted.get("ocr_pages"),
                "empty_pages": extracted.get("empty_pages"),
                "page_text_chars": extracted.get("page_text_chars"),
                "confidence": extraction_confidence,
                "sha256": extracted.get("sha256"),
                "text_sha256": (
                    hashlib.sha256(extracted_text.encode("utf-8")).hexdigest()
                    if extracted_text
                    else None
                ),
                "text_chars": text_chars,
                "text_present": bool(extracted_text),
                "complete": extracted.get("complete") is True,
                "failed_pages": extracted.get("failed_pages") or [],
                "extraction_status": extracted.get("extraction_status"),
            }
            if persisted_pdf_proof:
                raw_payload["extraction"].update(
                    {
                        "provenance": "persisted_pdf_text",
                        "proof_version": 1,
                        "verified_at": persisted_verified_at,
                    }
                )
        extraction_status = "pending" if invalid_analysis else _document_extraction_status(extracted)
        manifest_profile = current_analysis_profiles.get(str(url))
        discard_cached_evidence = invalid_analysis or (
            fresh_analysis and not isinstance(manifest_profile, dict)
        )
        if isinstance(manifest_profile, dict):
            manifest_status = str(manifest_profile.get("extraction_status") or "").strip().lower()
            if manifest_profile.get("complete") is False or manifest_profile.get("failed_pages"):
                manifest_status = "incomplete"
            if manifest_status in {"incomplete", "failed"}:
                # A current manifest can carry a failed-page result from the
                # latest extraction while an older local cache still has text.
                # Do not let that stale cache advertise a complete document.
                extraction_status = manifest_status
                if isinstance(raw_payload.get("extraction"), dict):
                    raw_payload["extraction"]["manifest_status"] = manifest_status
                    raw_payload["extraction"]["complete"] = False
                    raw_payload["extraction"]["failed_pages"] = (
                        manifest_profile.get("failed_pages")
                        or raw_payload["extraction"].get("failed_pages")
                        or []
                    )
            elif manifest_status == "empty":
                # A fresh empty result is authoritative for this document.
                # Do not let a previous cache entry with text turn it back
                # into an extracted row, and keep the materialized metadata
                # aligned with the current profile.
                extraction_status = "empty"
                manifest_sha = clean_text(manifest_profile.get("sha256"))
                if isinstance(raw_payload.get("extraction"), dict):
                    raw_payload["extraction"].update(
                        {
                            "manifest_status": "empty",
                            "extraction_status": "empty",
                            "sha256": manifest_sha or None,
                            "complete": manifest_profile.get("complete") is True,
                            "failed_pages": manifest_profile.get("failed_pages") or [],
                            "text_chars": 0,
                            "text_present": False,
                            "text_sha256": None,
                        }
                    )
                extracted_text = None
                text_chars = 0
                row_file_path = None
                row_sha256 = manifest_sha or None
            elif manifest_status == "extracted":
                manifest_sha = str(manifest_profile.get("sha256") or "")
                extracted_sha = str(extracted.get("sha256") or "")
                if (
                    not manifest_sha
                    or not extracted_sha
                    or manifest_sha != extracted_sha
                    or manifest_profile.get("complete") is not True
                ):
                    extraction_status = "pending"
                    discard_cached_evidence = True
                    if isinstance(raw_payload.get("extraction"), dict):
                        raw_payload["extraction"].update(
                            {
                                "manifest_status": "pending",
                                "extraction_status": "pending",
                                "complete": False,
                            }
                        )
            else:
                # Missing/unknown current status is not proof that an older
                # local cache is still current. Keep the row visible while
                # making the uncertainty explicit.
                extraction_status = "pending"
                discard_cached_evidence = True
                if isinstance(raw_payload.get("extraction"), dict):
                    raw_payload["extraction"].update(
                        {
                            "manifest_status": manifest_status or None,
                            "extraction_status": "pending",
                            "complete": False,
                        }
                    )
        if discard_cached_evidence:
            # A current profile that cannot prove this cache also cannot lend
            # its old text counters, hashes or file identity to the row.
            extraction_status = "pending"
            extracted_text = None
            text_chars = 0
            row_file_path = None
            row_sha256 = None
            if isinstance(raw_payload.get("extraction"), dict):
                raw_payload["extraction"].update(
                    {
                        "extraction_status": "pending",
                        "complete": False,
                        "sha256": None,
                        "text_sha256": None,
                        "text_chars": 0,
                        "text_present": False,
                        "cache_version": None,
                        "extraction_method": None,
                        "page_count": None,
                        "ocr_pages": None,
                        "empty_pages": None,
                        "page_text_chars": None,
                        "confidence": None,
                        "failed_pages": [],
                    }
                )
        rows.append(
            {
                "source_url": sale.source_url,
                "document_url": url,
                "label": document.get("label"),
                "document_type": classify_document_type(
                    str(document.get("label") or extracted.get("label") or ""),
                    str(url),
                ),
                "file_path": None if persisted_pdf_proof else row_file_path,
                "sha256": row_sha256,
                "download_status": (
                    "verified"
                    if persisted_pdf_proof
                    else ("downloaded" if row_file_path or row_sha256 else "unknown")
                ),
                "text_chars": text_chars,
                "extraction_status": extraction_status,
                "docling_status": None if discard_cached_evidence else extracted.get("extraction_method"),
                "raw_payload": raw_payload,
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    return rows


def _document_extraction_status(extracted: dict[str, object]) -> str:
    """Map a PDF cache payload to the materialized document status.

    A partial cache can contain useful text while still having failed pages.
    Keep that payload visible for diagnostics, but never advertise it as a
    complete extraction in ``auction_documents``.
    """
    declared_status = str(extracted.get("extraction_status") or "").strip().lower()
    if declared_status in {"failed", "incomplete"}:
        return declared_status
    if extracted.get("complete") is False or extracted.get("failed_pages"):
        return "incomplete"
    if declared_status == "empty":
        return "empty"
    if (
        str(extracted.get("text") or "").strip()
        and extracted.get("complete") is True
        and str(extracted.get("sha256") or "").strip()
    ):
        return "extracted"
    return "pending"


def _unique_rows_by_keys(
    rows: list[dict[str, object]],
    keys: tuple[str, ...],
) -> list[dict[str, object]]:
    unique: dict[tuple[object, ...], dict[str, object]] = {}
    for row in rows:
        values = tuple(row.get(key) for key in keys)
        if any(value is None for value in values):
            continue
        unique[values] = row
    return list(unique.values())


def _unique_rows_by_key(rows: list[dict[str, object]], key: str) -> list[dict[str, object]]:
    return _unique_rows_by_keys(rows, (key,))


def _extraction_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    rows = []
    sale_id = sale_storage_id(sale)
    pdf_path = PDF_TEXTS_DIR / f"{sale_id}.json"
    if pdf_path.exists():
        payload = _read_json_file(pdf_path)
        input_hash = sale.content_hash or sale.source_url
        rows.append(
            {
                "source_url": sale.source_url,
                "provider": PDF_EXTRACTION_PROVIDER,
                "model": PDF_EXTRACTION_MODEL,
                "input_hash": input_hash,
                "schema_version": PDF_EXTRACTION_SCHEMA_VERSION,
                "result": payload,
                "confidence": _pdf_extraction_confidence(payload),
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    llm_payload = sale.raw_payload.get("llm_extraction")
    if isinstance(llm_payload, dict):
        cache = _read_json_file(LLM_EXTRACTIONS_DIR / f"{sale_id}.json") or {}
        input_hash = str(cache.get("_cache", {}).get("key") or sale.content_hash or sale.source_url)
        rows.append(
            {
                "source_url": sale.source_url,
                "provider": "replicate",
                "model": str(cache.get("_cache", {}).get("model") or "zsxkib/qwen2-7b-instruct"),
                "input_hash": input_hash,
                "schema_version": "llm_extraction_v2_structured_assets",
                "result": llm_payload,
                "confidence": llm_payload.get("confidence") or {},
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    return rows


def _surface_measurement_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    analysis = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return []
    version = str(analysis.get("version") or "surface_reasoning_v1")
    measurements = analysis.get("measurements")
    if not isinstance(measurements, list):
        return []
    rows: list[dict[str, object]] = []
    for index, measurement in enumerate(measurements):
        if not isinstance(measurement, dict):
            continue
        evidence = measurement.get("evidence") if isinstance(measurement.get("evidence"), dict) else {}
        quote = str(evidence.get("quote") or "").strip()
        value = measurement.get("value_m2")
        if not quote or value is None:
            continue
        local_key = str(measurement.get("measurement_id") or index)
        rows.append(
            {
                "measurement_key": _surface_row_key(sale.source_url, local_key),
                "source_url": sale.source_url,
                "asset_id": str(measurement.get("asset_id") or "asset-main"),
                "lot_label": measurement.get("lot_label"),
                "level_label": measurement.get("level"),
                "space_label": str(measurement.get("space_label") or "pièce"),
                "category": str(measurement.get("category") or "unknown"),
                "value_m2": value,
                "included_in_habitable_sum": measurement.get("included_in_habitable_sum"),
                "confidence": measurement.get("confidence") or 0,
                "evidence_quote": quote,
                "document_url": evidence.get("document_url"),
                "document_label": evidence.get("document_label"),
                "page_number": evidence.get("page_number"),
                "extraction_method": str(measurement.get("extraction_method") or "unknown"),
                "reasoning_version": version,
            }
        )
    return rows


def _surface_derivation_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    analysis = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return []
    version = str(analysis.get("version") or "surface_reasoning_v1")
    selected_id = str(analysis.get("selected_derivation_id") or "")
    derivations = analysis.get("derivations")
    candidates = analysis.get("candidates") if isinstance(analysis.get("candidates"), list) else []
    candidates_by_id = {
        str(item.get("candidate_id")): item
        for item in candidates
        if isinstance(item, dict) and item.get("candidate_id")
    }
    if not isinstance(derivations, list):
        return []
    rows: list[dict[str, object]] = []
    for index, derivation in enumerate(derivations):
        if not isinstance(derivation, dict):
            continue
        local_key = str(derivation.get("derivation_id") or index)
        operands = derivation.get("operand_measurement_ids")
        operand_keys = [
            _surface_row_key(sale.source_url, str(value))
            for value in operands
            if value
        ] if isinstance(operands, list) else []
        explicit_id = str(derivation.get("explicit_candidate_id") or "")
        rows.append(
            {
                "derivation_key": _surface_row_key(sale.source_url, local_key),
                "source_url": sale.source_url,
                "asset_id": str(derivation.get("asset_id") or "asset-main"),
                "kind": str(derivation.get("kind") or "unknown"),
                "value_m2": derivation.get("value_m2"),
                "operand_measurement_keys": operand_keys,
                "formula": str(derivation.get("formula") or "surface explicitement indiquée"),
                "validation_status": str(derivation.get("validation_status") or "rejected"),
                "confidence": derivation.get("confidence") or 0,
                "explicit_candidate": candidates_by_id.get(explicit_id),
                "warnings": derivation.get("warnings") or [],
                "is_selected": local_key == selected_id,
                "reasoning_version": version,
            }
        )
    return rows


def _surface_row_key(source_url: str, local_key: str) -> str:
    return hashlib.sha256(f"{source_url}\0{local_key}".encode()).hexdigest()


def _pdf_extraction_confidence(payload: Any) -> dict[str, object]:
    if not isinstance(payload, list):
        return {}
    document_confidences = []
    page_confidences = []
    ocr_pages = 0
    empty_pages = 0
    page_count = 0
    for item in payload:
        if not isinstance(item, dict):
            continue
        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)):
            document_confidences.append(float(confidence))
        pages = item.get("pages")
        if isinstance(pages, list):
            page_count += len(pages)
            for page in pages:
                if not isinstance(page, dict):
                    continue
                method = str(page.get("method") or "")
                if method.startswith("ocr_"):
                    ocr_pages += 1
                if not page.get("text"):
                    empty_pages += 1
                page_confidence = page.get("confidence")
                if isinstance(page_confidence, (int, float)):
                    page_confidences.append(float(page_confidence))
    confidence = document_confidences or page_confidences
    average = round(sum(confidence) / len(confidence), 3) if confidence else None
    return {
        "document_count": len(payload),
        "page_count": page_count,
        "ocr_pages": ocr_pages,
        "empty_pages": empty_pages,
        "average_confidence": average,
    }


def _load_pdf_texts(sale: AuctionSale) -> list[dict[str, object]]:
    path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    payload = _read_json_file(path)
    if not isinstance(payload, list) or any(not isinstance(item, dict) for item in payload):
        return []
    return payload


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
