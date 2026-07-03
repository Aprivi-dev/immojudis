from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

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

from src.asset_normalization import (
    build_auction_features_row,
    build_auction_risk_rows_from_occurrences,
    build_auction_score_factor_rows,
    build_auction_surfaces_row,
    extract_risk_occurrences_from_text,
)
from src.config import LLM_EXTRACTIONS_DIR, PDF_TEXTS_DIR, load_settings
from src.models import AuctionSale
from src.normalize import make_sale_signature
from src.pdf_enrichment import classify_document_type, sale_storage_id

LOGGER = logging.getLogger(__name__)
POSTGREST_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
POSTGREST_UPSERT_RETRIES = 3
POSTGREST_RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504, 522, 524}
POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE = 50
POSTGRES_CONNECT_TIMEOUT = 15
POSTGRES_JSON_COLUMNS = {
    "source_urls",
    "visit_dates",
    "documents",
    "score_factors",
    "quality_flags",
    "raw_payload",
    "observations",
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
    "quality_flags",
    "raw_text",
    "raw_payload",
    "observations",
    "content_hash",
    "last_run_id",
)


def get_supabase_client() -> Client | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return None
    return create_client(str(url), str(key))


def upsert_sales_to_supabase(sales: list[AuctionSale]) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        LOGGER.info("Supabase variables are missing; skipping upsert")
        return 0
    now = datetime.now(UTC).isoformat()
    payload = []
    for sale in sales:
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in UPSERT_COLUMNS}
        row["last_seen_at"] = now
        row["updated_at"] = now
        payload.append(row)
    if not payload:
        return 0
    if db_url:
        try:
            _postgres_upsert(str(db_url), "auction_sales", payload, on_conflict="source_url")
            _delete_secondary_sale_rows_with_postgres(str(db_url), sales)
            _upsert_asset_tables_with_rest(str(url), str(key), sales, now)
            return len(payload)
        except Exception as exc:
            LOGGER.warning("Direct Postgres auction_sales sync failed; falling back to REST: %s", exc)
    _upsert_with_rest(str(url), str(key), payload)
    _delete_secondary_sale_rows(str(url), str(key), sales)
    _upsert_asset_tables_with_rest(str(url), str(key), sales, now)
    return len(payload)


def create_run_in_supabase(source: str, use_llm: bool, run_id: str | None = None) -> str | None:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return None
    if run_id:
        return start_existing_run_in_supabase(run_id, source, use_llm)
    payload = {
        "status": "running",
        "source": source,
        "use_llm": use_llm,
        "started_at": datetime.now(UTC).isoformat(),
    }
    response = httpx.post(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        headers=_rest_headers(str(key), prefer="return=representation"),
        json=payload,
        timeout=30,
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
    payload = {
        "status": "running",
        "source": source,
        "use_llm": use_llm,
        "started_at": datetime.now(UTC).isoformat(),
        "finished_at": None,
    }
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={"id": f"eq.{run_id}"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=payload,
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase run start failed: %s", response.text)
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
    payload = {
        "status": status,
        "finished_at": datetime.now(UTC).isoformat(),
        "summary": summary,
        "errors": errors or {},
    }
    response = httpx.patch(
        f"{str(url).rstrip('/')}/rest/v1/auction_runs",
        params={"id": f"eq.{run_id}"},
        headers=_rest_headers(str(key), prefer="return=minimal"),
        json=_sanitize_postgrest_payload(payload),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase run finish failed: %s", response.text)


def upsert_documents_to_supabase(sales: list[AuctionSale]) -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    rows = [row for sale in sales for row in _document_rows_for_sale(sale)]
    if not rows:
        return 0
    _postgrest_upsert(str(url), str(key), "auction_documents", rows, on_conflict="document_url")
    return len(rows)


def upsert_extractions_to_supabase(sales: list[AuctionSale]) -> int:
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
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    db_url = settings.get("supabase_db_url")
    if not url or not key:
        return 0
    now = datetime.now(UTC).isoformat()
    payload = []
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
            payload.append(
                {
                    "source_name": observation.get("source_name") or sale.source_name,
                    "source_url": observation.get("source_url"),
                    "external_id": observation.get("external_id"),
                    "content_hash": sale.content_hash,
                    "canonical_source_url": sale.source_url,
                    "raw_payload": observation.get("raw_payload") or observation,
                    "observed_at": now,
                    "updated_at": now,
                }
            )
    if not payload:
        return 0
    if db_url:
        try:
            _postgres_upsert(str(db_url), "auction_observations", payload, on_conflict="source_url")
            return len(payload)
        except Exception as exc:
            LOGGER.warning("Direct Postgres auction_observations upsert failed; falling back to REST: %s", exc)
    _postgrest_upsert(str(url), str(key), "auction_observations", payload, on_conflict="source_url")
    return len(payload)


def fetch_enriched_content_hashes(
    content_hashes: list[str],
    *,
    require_llm_description: bool = False,
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
    unique = [h for h in {h for h in content_hashes if h}]
    if not url or not key or not unique:
        return set()

    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    found: set[str] = set()
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
                    not require_llm_description
                    or _has_current_llm_description(row.get("raw_payload"), prompt_version)
                ):
                    found.add(str(value))
        except httpx.HTTPError as exc:
            LOGGER.warning("Enriched-hash lookup failed: %s", exc)
    return found


def _has_current_llm_description(raw_payload: Any, prompt_version: str | None) -> bool:
    if not isinstance(raw_payload, dict):
        return False
    display_description = raw_payload.get("llm_display_description")
    if not isinstance(display_description, str) or not display_description.strip():
        return False
    if not prompt_version:
        return True
    return raw_payload.get("llm_prompt_version") == prompt_version


KNOWN_SALE_DETAIL_SELECT = ",".join(
    (
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


def fetch_known_sale_details() -> dict[str, dict[str, Any]]:
    """Map every known source URL to DB fields available for fallback."""
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return {}

    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    details: dict[str, dict[str, Any]] = {}
    offset = 0
    while True:
        try:
            response = httpx.get(
                endpoint,
                params={
                    "select": KNOWN_SALE_DETAIL_SELECT,
                    "limit": "1000",
                    "offset": str(offset),
                },
                headers=_rest_headers(str(key), prefer="count=none"),
                timeout=30,
            )
            if response.is_error:
                LOGGER.warning("Could not fetch known sale details: %s", response.text[:200])
                break
            rows = response.json()
        except httpx.HTTPError as exc:
            LOGGER.warning("Known sale detail lookup failed: %s", exc)
            break
        for row in rows:
            row["_signature"] = make_sale_signature(row.get("sale_date"), row.get("starting_price_eur"))
            for source_url in _known_source_urls(row):
                details.setdefault(source_url, row)
        if len(rows) < 1000:
            break
        offset += 1000
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
    now = datetime.now(UTC).isoformat()
    endpoint = f"{str(url).rstrip('/')}/rest/v1/auction_sales"
    response = httpx.patch(
        endpoint,
        params={
            "sale_date": f"lt.{now}",
            "status": "in.(upcoming,unknown)",
        },
        headers=_rest_headers(str(key), prefer="return=representation"),
        json={
            "status": "past",
            "updated_at": now,
        },
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase auction_sales cleanup failed (%s): %s", response.status_code, response.text[:200])
        return 0
    return len(response.json()) if response.content else 0


def delete_vench_sales_without_surface_in_supabase() -> int:
    settings = load_settings()
    url = settings["supabase_url"]
    key = settings["supabase_service_role_key"]
    if not url or not key:
        return 0
    deleted = 0
    while source_urls := _fetch_vench_without_surface_urls(str(url), str(key)):
        _postgrest_delete_by_source_urls(str(url), str(key), "auction_observations", source_urls)
        _postgrest_delete_by_source_urls(str(url), str(key), "auction_sales", source_urls)
        deleted += len(source_urls)
    return deleted


def _fetch_vench_without_surface_urls(supabase_url: str, api_key: str) -> list[str]:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/auction_sales"
    response = httpx.get(
        endpoint,
        params={
            "select": "source_url",
            "source_name": "eq.vench",
            "surface_m2": "is.null",
            "habitable_surface_m2": "is.null",
            "carrez_surface_m2": "is.null",
            "app_surface_m2": "is.null",
            "land_surface_m2": "is.null",
            "limit": "1000",
        },
        headers=_rest_headers(api_key, prefer="count=none"),
        timeout=30,
    )
    if response.is_error:
        LOGGER.warning("Supabase Vench cleanup lookup failed (%s): %s", response.status_code, response.text[:200])
        return []
    return [str(row["source_url"]) for row in response.json() if row.get("source_url")]


def _upsert_with_rest(supabase_url: str, api_key: str, payload: list[dict[str, object]]) -> None:
    _postgrest_upsert(supabase_url, api_key, "auction_sales", payload, on_conflict="source_url")


def _delete_secondary_sale_rows(supabase_url: str, api_key: str, sales: list[AuctionSale]) -> int:
    secondary_urls = _secondary_source_urls(sales)
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
                "delete from public.auction_observations where source_url = any(%s)",
                (secondary_urls,),
            )
            cursor.execute(
                "delete from public.auction_sales where source_url = any(%s)",
                (secondary_urls,),
            )
    return len(secondary_urls)


def _postgres_upsert(
    db_url: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> None:
    if psycopg is None or sql is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    if not payload:
        return
    columns = list(payload[0].keys())
    insert_statement = sql.SQL(
        "insert into {} ({}) values ({}) on conflict ({}) do update set {}"
    ).format(
        sql.Identifier("public", table),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
        sql.Identifier(on_conflict),
        sql.SQL(", ").join(
            sql.SQL("{} = excluded.{}").format(sql.Identifier(column), sql.Identifier(column))
            for column in columns
            if column != on_conflict
        ),
    )
    rows = [tuple(_postgres_value(column, row.get(column)) for column in columns) for row in payload]
    with _postgres_connect(db_url) as connection:
        with connection.cursor() as cursor:
            cursor.executemany(insert_statement, rows)


def _postgres_connect(db_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    return psycopg.connect(
        db_url,
        connect_timeout=POSTGRES_CONNECT_TIMEOUT,
        prepare_threshold=None,
    )


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


def _upsert_asset_tables_with_rest(supabase_url: str, api_key: str, sales: list[AuctionSale], now: str) -> None:
    features = [_timestamped(build_auction_features_row(sale), now) for sale in sales]
    surfaces = [_timestamped(build_auction_surfaces_row(sale), now) for sale in sales]
    if features:
        _postgrest_upsert(supabase_url, api_key, "auction_features", features, on_conflict="source_url")
    if surfaces:
        _postgrest_upsert(supabase_url, api_key, "auction_surfaces", surfaces, on_conflict="source_url")
    source_urls = [sale.source_url for sale in sales]
    if source_urls:
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_risks", source_urls)
        _postgrest_delete_by_source_urls(supabase_url, api_key, "auction_risk_occurrences", source_urls)
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
    upsert_documents_to_supabase(sales)
    upsert_extractions_to_supabase(sales)


def _postgrest_upsert(
    supabase_url: str,
    api_key: str,
    table: str,
    payload: list[dict[str, object]],
    on_conflict: str,
) -> None:
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
    unique: list[str] = []
    seen: set[str] = set()
    for source_url in source_urls:
        if not source_url or source_url in seen:
            continue
        seen.add(source_url)
        unique.append(source_url)
    for index in range(0, len(unique), POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE):
        batch = unique[index : index + POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE]
        _postgrest_delete(
            supabase_url,
            api_key,
            table,
            {"source_url": _postgrest_in_filter(batch)},
        )
    return len(unique)


def _postgrest_request_with_retries(method: str, endpoint: str, table: str, **kwargs: Any) -> httpx.Response:
    last_timeout: httpx.TimeoutException | None = None
    for attempt in range(1, POSTGREST_UPSERT_RETRIES + 1):
        try:
            response = httpx.request(method, endpoint, **kwargs)
            if response.status_code not in POSTGREST_RETRYABLE_STATUS_CODES or attempt == POSTGREST_UPSERT_RETRIES:
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


def _sanitize_postgrest_payload(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, list):
        return [_sanitize_postgrest_payload(item) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_postgrest_payload(item) for key, item in value.items()}
    return value


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


def _document_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    pdf_texts = _load_pdf_texts(sale)
    text_by_url = {item.get("url"): item for item in pdf_texts if isinstance(item, dict)}
    rows = []
    for document in sale.documents:
        url = document.get("url")
        if not url:
            continue
        extracted = text_by_url.get(url, {})
        pages = extracted.get("pages") if isinstance(extracted, dict) else None
        page_count = len(pages) if isinstance(pages, list) else None
        text_chars = int(extracted.get("text_chars") or len(str(extracted.get("text") or ""))) if extracted else 0
        extraction_confidence = extracted.get("confidence") if isinstance(extracted, dict) else None
        raw_payload = dict(document)
        if isinstance(extracted, dict):
            raw_payload["extraction"] = {
                "cache_version": extracted.get("cache_version"),
                "extraction_method": extracted.get("extraction_method"),
                "page_count": page_count,
                "ocr_pages": extracted.get("ocr_pages"),
                "empty_pages": extracted.get("empty_pages"),
                "page_text_chars": extracted.get("page_text_chars"),
                "confidence": extraction_confidence,
            }
        rows.append(
            {
                "source_url": sale.source_url,
                "document_url": url,
                "label": document.get("label"),
                "document_type": classify_document_type(
                    str(document.get("label") or extracted.get("label") or ""),
                    str(url),
                ),
                "file_path": extracted.get("file_path"),
                "sha256": extracted.get("sha256"),
                "download_status": "downloaded" if extracted.get("file_path") else "unknown",
                "text_chars": text_chars,
                "extraction_status": "extracted" if extracted.get("text") else "pending",
                "docling_status": extracted.get("extraction_method"),
                "raw_payload": raw_payload,
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    return rows


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
                "provider": "pdf_text",
                "model": "docling+pymupdf+tesseract",
                "input_hash": input_hash,
                "schema_version": "pdf_text_v2_page_level",
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
                "model": str(cache.get("_cache", {}).get("model") or "google/gemini-2.5-flash"),
                "input_hash": input_hash,
                "schema_version": "llm_extraction_v1",
                "result": llm_payload,
                "confidence": llm_payload.get("confidence") or {},
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
    return rows


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
    return payload if isinstance(payload, list) else []


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
