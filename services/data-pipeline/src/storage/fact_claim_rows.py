"""Fact-claim snapshot, retry hash and Postgres insert helpers."""

from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import UUID, uuid5

try:
    from psycopg import sql
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - same guard as supabase_client.
    sql = None
    Jsonb = None

from src.fact_claims import FACT_CLAIMS_NAMESPACE, FACT_CLAIMS_VERSION
from src.models import AuctionSale
from src.storage.postgrest_helpers import _is_uuid
from src.storage.postgrest_payload import _sanitize_postgrest_payload

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
