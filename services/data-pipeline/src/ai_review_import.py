"""Controlled import of the private, AI-only extraction review.

The review manifest is an operator artifact and stays outside the repository.
This module turns it into a *pending* field-level projection in one explicit
PostgreSQL transaction.  It never writes ``auction_sales`` directly and it
does not try to repair an unresolved case.  A sale is mapped only when the
current database snapshot contains exactly one ``(source_name, source_url)``
match.

The intended production sequence is:

1. read the manifest and verify every captured file and AI output digest;
2. in one transaction, read the current sale identity snapshot and existing
   projection rows for the sample digest;
3. build a fail-closed plan and refuse any conflicting existing row;
4. insert only new, byte-equivalent projection rows with ``ON CONFLICT DO
   NOTHING``;
5. let the database publication guard quarantine exact sales that still have
   unresolved or unverified fields, then commit.

The CLI defaults to read-only dry-run.  ``--apply`` is the only write path.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5

from src.ai_review_projection import AI_REVIEW_FIELD_KEYS, build_ai_review_projection_rows
from src.real_extraction_review import _timestamp, _validate_ai_review, ai_review_output_sha256

try:  # pragma: no cover - psycopg is installed by the production runner.
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - dry-run parsing tests do not need psycopg.
    Jsonb = None


CAPTURED_STATE = "captured"
ACCESS_STATES = frozenset({"captured", "not_attempted", "inaccessible", "capture_failed"})
AI_LABEL_STATES = frozenset({"present", "unknown", "absent", "unresolved"})
PROJECTION_COLUMNS = (
    "schema_version",
    "sample_sha256",
    "case_id",
    "source_name",
    "source_url",
    "capture_sha256",
    "canonical_content_hash_at_import",
    "auction_sale_id",
    "mapping_status",
    "field_key",
    "review_state",
    "citation_status",
    "value_jsonb",
    "evidence_locator",
    "block_reason",
)
PROJECTION_KEY_COLUMNS = ("sample_sha256", "case_id", "field_key")
PROJECTION_JSON_COLUMNS = frozenset({"value_jsonb", "evidence_locator"})
CASE_STATUS_COLUMNS = (
    "schema_version",
    "sample_sha256",
    "case_id",
    "source_name",
    "source_url",
    "access_state",
    "access_reason",
    "capture_sha256",
    "canonical_content_hash_at_import",
    "auction_sale_id",
    "mapping_status",
)
CASE_STATUS_KEY_COLUMNS = ("sample_sha256", "case_id")
EXPECTED_MANIFEST_SHA256 = "c2a8d1d245e738efc7549be148a59716aa32a4958aed4db996ea860a0427f6f1"
EXPECTED_SAMPLE_SHA256 = "19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424"
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
MAX_REDIRECT_HOPS = 8
AI_EXECUTION_ID_FIELDS = ("execution_id", "run_id", "review_id", "request_id")
NOTAIRES_API_HOST = "www.immobilier.notaires.fr"
NOTAIRES_API_SOURCE_HOSTS = frozenset({"www.immo-interactif.fr", NOTAIRES_API_HOST})
NOTAIRES_API_HOST_PAIRS = frozenset(
    (source_host, NOTAIRES_API_HOST) for source_host in NOTAIRES_API_SOURCE_HOSTS
)
NOTAIRES_PUBLIC_PATH_PREFIXES = {
    "www.immo-interactif.fr": "/encheres-en-ligne/",
    NOTAIRES_API_HOST: "/fr/annonce-immo/",
}
NOTAIRES_API_PATH_RE = re.compile(r"^/pub-services/inotr-www-annonces/v1/annonces/(\d+)$")
NUMERIC_PATH_ID_RE = re.compile(r"^\d+$")


class AiReviewImportConflict(ValueError):
    """Raised when an existing projection row is not byte-equivalent."""


@dataclass(frozen=True)
class AiReviewImportPlan:
    """A complete, read-only import plan ready for one transaction."""

    manifest_sha256: str
    sample_sha256: str
    rows: tuple[dict[str, Any], ...]
    new_rows: tuple[dict[str, Any], ...]
    unchanged_rows: int
    case_rows: tuple[dict[str, Any], ...]
    new_case_rows: tuple[dict[str, Any], ...]
    unchanged_case_rows: int
    summary: dict[str, Any]


def load_manifest_file(
    path: Path, *, expected_sha256: str = EXPECTED_MANIFEST_SHA256
) -> tuple[dict[str, Any], str]:
    """Load a private manifest and return it with the digest of its bytes."""

    payload = path.read_bytes()
    manifest_sha256 = hashlib.sha256(payload).hexdigest()
    if expected_sha256 and manifest_sha256 != expected_sha256:
        raise ValueError("AI review manifest digest does not match the approved frozen artifact")
    try:
        manifest = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("AI review manifest must be valid UTF-8 JSON") from exc
    if not isinstance(manifest, dict):
        raise ValueError("AI review manifest must be a JSON object")
    return manifest, manifest_sha256


def validate_ai_review_manifest(
    manifest: Mapping[str, Any],
    *,
    repo_root: Path | None = None,
    capture_provenance_errors: dict[str, str] | None = None,
) -> tuple[str, ...]:
    """Validate the provenance contract required by the AI-only importer.

    The validator is intentionally stricter than the general review evaluator:
    every captured case must have exactly two blind AI passes with complete
    labels and valid output digests.  Human reviews cannot silently enter this
    import lane.  A malformed captured case stops the whole import before any
    database write.  When ``capture_provenance_errors`` is provided, a
    capture endpoint mismatch is retained as a case-level quarantine reason
    so the rest of a manifest can still be imported.  All other malformed
    evidence remains fatal and stops the import.
    """

    if manifest.get("schema_version") != "immojudis.real-extraction-review.v2":
        raise ValueError("AI review manifest must use schema v2")
    sample_sha256 = _required_digest(manifest.get("sample_sha256"), "sample_sha256")
    if sample_sha256 != EXPECTED_SAMPLE_SHA256:
        raise ValueError("AI review sample digest is not the approved frozen sample")
    expected_fields = manifest.get("ai_review_expected_fields")
    if not isinstance(expected_fields, list) or {
        field for field in expected_fields if isinstance(field, str)
    } != set(AI_REVIEW_FIELD_KEYS) or len(expected_fields) != len(AI_REVIEW_FIELD_KEYS):
        raise ValueError("AI review manifest fields do not match the fixed extraction scope")
    if any(not isinstance(field, str) for field in expected_fields):
        raise ValueError("AI review manifest fields must be text")

    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("AI review manifest cases must be a non-empty array")
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    root = (repo_root or Path(__file__).resolve().parents[3]).resolve()
    captured_count = 0
    for case in cases:
        if not isinstance(case, Mapping):
            raise ValueError("AI review cases must be objects")
        case_id = _required_text(case.get("id"), "case id")
        source_name = _required_text(case.get("source"), f"source for case {case_id}")
        source_url = _required_https(case.get("source_url"), f"source_url for case {case_id}")
        if len(case_id) > 200 or len(source_name) > 64 or len(source_url) > 4096:
            raise ValueError(f"AI review identity fields are too long for case {case_id}")
        if case_id in seen_ids:
            raise ValueError(f"duplicate AI review case id: {case_id}")
        if source_url in seen_urls:
            raise ValueError(f"duplicate AI review source URL: {source_url}")
        seen_ids.add(case_id)
        seen_urls.add(source_url)
        access = case.get("access")
        if not isinstance(access, Mapping):
            raise ValueError(f"case {case_id} has no access state")
        if access.get("state") not in ACCESS_STATES:
            raise ValueError(f"case {case_id} has an unsupported access state")
        if access.get("state") != CAPTURED_STATE:
            continue
        captured_count += 1
        _validate_captured_case(
            case,
            case_id,
            source_name,
            source_url,
            expected_fields,
            root,
            capture_provenance_errors=capture_provenance_errors,
        )

    if captured_count == 0:
        raise ValueError("AI review manifest contains no captured cases")
    return tuple(expected_fields)


def build_ai_review_import_plan(
    manifest: Mapping[str, Any],
    sales: Sequence[Mapping[str, Any]],
    *,
    existing_rows: Sequence[Mapping[str, Any]] = (),
    existing_case_rows: Sequence[Mapping[str, Any]] = (),
    manifest_sha256: str = "",
    repo_root: Path | None = None,
) -> AiReviewImportPlan:
    """Build a fail-closed, idempotent plan without performing database I/O."""

    if manifest_sha256:
        _required_digest(manifest_sha256, "manifest_sha256")
        if manifest_sha256 != EXPECTED_MANIFEST_SHA256:
            raise ValueError("AI review manifest digest is not the approved frozen artifact")
    capture_provenance_errors: dict[str, str] = {}
    expected_fields = validate_ai_review_manifest(
        manifest,
        repo_root=repo_root,
        capture_provenance_errors=capture_provenance_errors,
    )
    rows = build_ai_review_projection_rows(manifest, sales)
    _apply_capture_provenance_errors(rows, capture_provenance_errors)
    _attach_canonical_content_hashes(rows, sales)
    case_rows = _build_case_status_rows(manifest, sales)
    _apply_capture_provenance_errors_to_case_status(case_rows, capture_provenance_errors)
    expected_captured = sum(
        1
        for case in manifest["cases"]
        if isinstance(case, Mapping)
        and isinstance(case.get("access"), Mapping)
        and case["access"].get("state") == CAPTURED_STATE
    )
    expected_row_count = expected_captured * len(expected_fields)
    if len(rows) != expected_row_count:
        raise ValueError(
            f"AI projection row count mismatch: expected {expected_row_count}, got {len(rows)}"
        )

    existing_by_key = {
        _projection_key(row): row
        for row in existing_rows
    }
    planned_by_key = {_projection_key(row): row for row in rows}
    extra_existing = set(existing_by_key) - set(planned_by_key)
    if extra_existing:
        raise AiReviewImportConflict(
            "existing projection contains fields outside this manifest: "
            + ", ".join(f"{key[1]}/{key[2]}" for key in sorted(extra_existing)[:5])
        )

    new_rows: list[dict[str, Any]] = []
    unchanged_rows = 0
    for key, row in planned_by_key.items():
        existing = existing_by_key.get(key)
        if existing is None:
            new_rows.append(row)
            continue
        if not _projection_rows_equal(existing, row):
            raise AiReviewImportConflict(
                f"existing projection differs for case {key[1]}, field {key[2]}"
            )
        unchanged_rows += 1

    existing_case_by_key = {
        _case_status_key(row): row
        for row in existing_case_rows
    }
    planned_case_by_key = {_case_status_key(row): row for row in case_rows}
    extra_existing_cases = set(existing_case_by_key) - set(planned_case_by_key)
    if extra_existing_cases:
        raise AiReviewImportConflict(
            "existing AI review case status contains cases outside this manifest: "
            + ", ".join(key[1] for key in sorted(extra_existing_cases)[:5])
        )
    new_case_rows: list[dict[str, Any]] = []
    unchanged_case_rows = 0
    for key, row in planned_case_by_key.items():
        existing = existing_case_by_key.get(key)
        if existing is None:
            new_case_rows.append(row)
            continue
        if not _case_status_rows_equal(existing, row):
            raise AiReviewImportConflict(
                f"existing AI review case status differs for case {key[1]}"
            )
        unchanged_case_rows += 1

    mapping_by_case: dict[str, str] = {}
    for row in rows:
        mapping_by_case.setdefault(row["case_id"], row["mapping_status"])
    summary = {
        "manifest_sha256": manifest_sha256 or None,
        "sample_sha256": manifest["sample_sha256"],
        "captured_cases": expected_captured,
        "projected_rows": len(rows),
        "new_rows": len(new_rows),
        "unchanged_rows": unchanged_rows,
        "case_status_rows": len(case_rows),
        "new_case_status_rows": len(new_case_rows),
        "unchanged_case_status_rows": unchanged_case_rows,
        "noncaptured_cases": sum(row["access_state"] != CAPTURED_STATE for row in case_rows),
        "blocked_case_status_rows": sum(row["access_state"] != CAPTURED_STATE for row in case_rows),
        "exact_mapping_cases": sum(status == "exact" for status in mapping_by_case.values()),
        "unmapped_cases": sum(status == "unmapped" for status in mapping_by_case.values()),
        "ambiguous_cases": sum(status == "ambiguous" for status in mapping_by_case.values()),
        # This is deliberately a local pre-reconciliation gate.  It does not
        # prove current canonical equality or a current content hash; only the
        # database reconciliation views can produce a publication decision.
        "passes_local_gate_rows": sum(bool(row["passes_local_gate"]) for row in rows),
        "blocked_rows": sum(not bool(row["passes_local_gate"]) for row in rows),
        "capture_provenance_blocked_cases": len(capture_provenance_errors),
        "capture_provenance_blocked_rows": sum(
            row["case_id"] in capture_provenance_errors for row in rows
        ),
    }
    return AiReviewImportPlan(
        manifest_sha256=manifest_sha256,
        sample_sha256=manifest["sample_sha256"],
        rows=tuple(rows),
        new_rows=tuple(new_rows),
        unchanged_rows=unchanged_rows,
        case_rows=tuple(case_rows),
        new_case_rows=tuple(new_case_rows),
        unchanged_case_rows=unchanged_case_rows,
        summary=summary,
    )


def build_ai_review_export_payload(
    manifest: Mapping[str, Any],
    *,
    manifest_sha256: str,
    batch_size: int = 100,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    """Build sanitized, server-mapped JSON batches for Supabase MCP calls.

    The export deliberately carries no private capture path or excerpt.  A
    deterministic in-memory UUID is used only to let the existing projection
    validator evaluate the AI labels; it is removed before serialization.
    The SQL function receiving this payload resolves ``source_name`` and
    ``source_url`` against the live database and accepts a value only for one
    exact match.
    """

    if batch_size < 1 or batch_size > 500:
        raise ValueError("export batch_size must be between 1 and 500")
    if manifest_sha256 != EXPECTED_MANIFEST_SHA256:
        raise ValueError("AI review manifest digest is not the approved frozen artifact")
    capture_provenance_errors: dict[str, str] = {}
    expected_fields = validate_ai_review_manifest(
        manifest,
        repo_root=repo_root,
        capture_provenance_errors=capture_provenance_errors,
    )
    captured_cases = [
        case
        for case in manifest["cases"]
        if isinstance(case, Mapping)
        and isinstance(case.get("access"), Mapping)
        and case["access"].get("state") == CAPTURED_STATE
    ]

    synthetic_sales = [
        {
            "id": str(uuid5(NAMESPACE_URL, f"immojudis-ai-review:{case['id']}")),
            "source_name": case["source"],
            "source_url": case["source_url"],
        }
        for case in captured_cases
    ]
    projection_rows = build_ai_review_projection_rows(manifest, synthetic_sales)
    _apply_capture_provenance_errors(projection_rows, capture_provenance_errors)
    export_projections: list[dict[str, Any]] = []
    for row in projection_rows:
        export_projections.append(
            {
                "schema_version": row["schema_version"],
                "sample_sha256": row["sample_sha256"],
                "case_id": row["case_id"],
                "source_name": row["source_name"],
                "source_url": row["source_url"],
                "capture_sha256": row["capture_sha256"],
                "mapping_status": "server_exact_required",
                "field_key": row["field_key"],
                "review_state": row["review_state"],
                "citation_status": row["citation_status"],
                "value_jsonb": row["value_jsonb"],
                # Locators are useful in the local review but are omitted from
                # the MCP payload to guarantee that no private path or excerpt
                # can escape the review workspace.
                "evidence_locator": {},
                "block_reason": row["block_reason"],
            }
        )

    local_case_rows = _build_case_status_rows(manifest, [])
    _apply_capture_provenance_errors_to_case_status(local_case_rows, capture_provenance_errors)
    export_cases = [
        {
            "schema_version": row["schema_version"],
            "sample_sha256": row["sample_sha256"],
            "case_id": row["case_id"],
            "source_name": row["source_name"],
            "source_url": row["source_url"],
            "access_state": row["access_state"],
            "access_reason": _safe_export_reason(row["access_reason"]),
            "capture_sha256": row["capture_sha256"],
            "mapping_status": "server_exact_required",
        }
        for row in local_case_rows
    ]

    projection_batch_count = (len(export_projections) + batch_size - 1) // batch_size
    # Keep the case-level gate as a distinct first transaction.  The remaining
    # transactions contain only bounded projection slices, so 100 case
    # statuses are emitted exactly once even when the importer is resumed.
    batches = [
        {
            "format": "immojudis.ai-review-import.v1",
            "schema_version": manifest["schema_version"],
            "manifest_sha256": manifest_sha256,
            "sample_sha256": manifest["sample_sha256"],
            "batch_index": 0,
            "batch_count": projection_batch_count + 1,
            "case_statuses": export_cases,
            "projections": [],
        }
    ]
    batches.extend(
        {
            "format": "immojudis.ai-review-import.v1",
            "schema_version": manifest["schema_version"],
            "manifest_sha256": manifest_sha256,
            "sample_sha256": manifest["sample_sha256"],
            "batch_index": index + 1,
            "batch_count": projection_batch_count + 1,
            "case_statuses": [],
            "projections": export_projections[start : start + batch_size],
        }
        for index, start in enumerate(range(0, len(export_projections), batch_size))
    )
    summary = {
        "captured_cases": len(captured_cases),
        "case_status_rows": len(export_cases),
        "projection_rows": len(export_projections),
        "projection_batches": projection_batch_count,
        "batch_count": len(batches),
        "batch_size": batch_size,
        "noncaptured_cases": sum(row["access_state"] != CAPTURED_STATE for row in export_cases),
        "manifest_sha256": manifest_sha256,
        "sample_sha256": manifest["sample_sha256"],
        "expected_fields": list(expected_fields),
        "capture_provenance_blocked_cases": len(capture_provenance_errors),
        "capture_provenance_blocked_rows": sum(
            row["case_id"] in capture_provenance_errors for row in projection_rows
        ),
    }
    return {
        "format": "immojudis.ai-review-import-batches.v1",
        "summary": summary,
        "batches": batches,
    }


def fetch_sale_identity_snapshot(connection: Any) -> list[dict[str, Any]]:
    """Read the exact identity snapshot used by the mapping step."""

    with connection.cursor() as cursor:
        cursor.execute(
            """
            select id::text, source_name, source_url, content_hash
            from public.auction_sales
            where source_name is not null and source_url is not null
            order by id
            """
        )
        return [
            {
                "id": row[0],
                "source_name": row[1],
                "source_url": row[2],
                "content_hash": row[3],
            }
            for row in cursor.fetchall()
        ]


def fetch_existing_projection_rows(connection: Any, sample_sha256: str) -> list[dict[str, Any]]:
    """Read existing rows for one sample digest before the idempotent insert."""

    with connection.cursor() as cursor:
        cursor.execute(
            """
            select schema_version, sample_sha256, case_id, source_name, source_url,
                   capture_sha256, canonical_content_hash_at_import,
                   auction_sale_id::text, mapping_status, field_key,
                   review_state, citation_status, value_jsonb, evidence_locator, block_reason
            from public.auction_ai_review_projections
            where sample_sha256 = %s
            order by case_id, field_key
            """,
            (sample_sha256,),
        )
        return [dict(zip(PROJECTION_COLUMNS, row, strict=True)) for row in cursor.fetchall()]


def fetch_existing_case_status_rows(connection: Any, sample_sha256: str) -> list[dict[str, Any]]:
    """Read case-level access outcomes, including non-captured cases."""

    with connection.cursor() as cursor:
        cursor.execute(
            """
            select schema_version, sample_sha256, case_id, source_name, source_url,
                   access_state, access_reason, capture_sha256,
                   canonical_content_hash_at_import, auction_sale_id::text,
                   mapping_status
            from public.auction_ai_review_case_status
            where sample_sha256 = %s
            order by case_id
            """,
            (sample_sha256,),
        )
        return [dict(zip(CASE_STATUS_COLUMNS, row, strict=True)) for row in cursor.fetchall()]


def insert_new_projection_rows(connection: Any, plan: AiReviewImportPlan) -> int:
    """Insert only new rows; the caller owns the surrounding transaction."""

    if not plan.new_rows:
        return 0
    values = [
        tuple(_postgres_value(column, row.get(column)) for column in PROJECTION_COLUMNS)
        for row in plan.new_rows
    ]
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            insert into public.auction_ai_review_projections (
              schema_version, sample_sha256, case_id, source_name, source_url,
              capture_sha256, canonical_content_hash_at_import, auction_sale_id,
              mapping_status, field_key,
              review_state, citation_status, value_jsonb, evidence_locator, block_reason
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (sample_sha256, case_id, field_key) do nothing
            """,
            values,
        )
        inserted = cursor.rowcount
    if inserted != len(plan.new_rows):
        raise AiReviewImportConflict(
            f"projection insert race or duplicate: expected {len(plan.new_rows)}, inserted {inserted}"
        )
    return inserted


def insert_new_case_status_rows(connection: Any, plan: AiReviewImportPlan) -> int:
    """Insert case-level outcomes, including explicit non-captured blockers."""

    if not plan.new_case_rows:
        return 0
    values = [
        tuple(row.get(column) for column in CASE_STATUS_COLUMNS)
        for row in plan.new_case_rows
    ]
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            insert into public.auction_ai_review_case_status (
              schema_version, sample_sha256, case_id, source_name, source_url,
              access_state, access_reason, capture_sha256,
              canonical_content_hash_at_import, auction_sale_id, mapping_status
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (sample_sha256, case_id) do nothing
            """,
            values,
        )
        inserted = cursor.rowcount
    if inserted != len(plan.new_case_rows):
        raise AiReviewImportConflict(
            "AI review case-status insert race or duplicate: "
            f"expected {len(plan.new_case_rows)}, inserted {inserted}"
        )
    return inserted


def _build_case_status_rows(
    manifest: Mapping[str, Any], sales: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Record every case outcome without inventing evidence for failed captures."""

    sale_index: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for sale in sales:
        source_name = _required_text(sale.get("source_name"), "sale source_name")
        source_url = _required_https(sale.get("source_url"), "sale source_url")
        sale_index.setdefault((source_name, source_url), []).append(sale)
    rows: list[dict[str, Any]] = []
    for case in manifest["cases"]:
        assert isinstance(case, Mapping)
        case_id = _required_text(case.get("id"), "case id")
        source_name = _required_text(case.get("source"), f"source for case {case_id}")
        source_url = _required_https(case.get("source_url"), f"source_url for case {case_id}")
        access = case["access"]
        assert isinstance(access, Mapping)
        access_state = _required_text(access.get("state"), f"access state for {case_id}")
        matches = sale_index.get((source_name, source_url), [])
        mapping_status = "exact" if len(matches) == 1 else "ambiguous" if len(matches) > 1 else "unmapped"
        sale_id = _sale_uuid_text(matches[0].get("id")) if mapping_status == "exact" else None
        if sale_id is None and mapping_status == "exact":
            mapping_status = "unmapped"
        canonical_content_hash = None
        if mapping_status == "exact":
            canonical_content_hash = _optional_digest(
                matches[0].get("content_hash"),
                f"sale content_hash for {case_id}",
            )
        capture = case.get("capture")
        capture_sha256 = None
        if access_state == CAPTURED_STATE:
            if not isinstance(capture, Mapping):
                raise ValueError(f"captured case {case_id} has no capture")
            capture_sha256 = _required_digest(capture.get("sha256"), f"capture sha256 for {case_id}")
        reason = access.get("reason")
        if reason is not None and not isinstance(reason, str):
            raise ValueError(f"access reason for {case_id} must be text")
        rows.append(
            {
                "schema_version": manifest["schema_version"],
                "sample_sha256": manifest["sample_sha256"],
                "case_id": case_id,
                "source_name": source_name,
                "source_url": source_url,
                "access_state": access_state,
                "access_reason": reason[:500] if isinstance(reason, str) else None,
                "capture_sha256": capture_sha256,
                "canonical_content_hash_at_import": canonical_content_hash,
                "auction_sale_id": sale_id,
                "mapping_status": mapping_status,
            }
        )
    return rows


def _attach_canonical_content_hashes(
    rows: list[dict[str, Any]], sales: Sequence[Mapping[str, Any]]
) -> None:
    """Snapshot the canonical sale hash without confusing it with capture SHA."""

    sale_index: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for sale in sales:
        key = (
            _required_text(sale.get("source_name"), "sale source_name"),
            _required_https(sale.get("source_url"), "sale source_url"),
        )
        sale_index.setdefault(key, []).append(sale)
    for row in rows:
        if row.get("mapping_status") != "exact":
            row["canonical_content_hash_at_import"] = None
            continue
        matches = sale_index.get((row["source_name"], row["source_url"]), [])
        if len(matches) != 1:
            row["canonical_content_hash_at_import"] = None
            continue
        row["canonical_content_hash_at_import"] = _optional_digest(
            matches[0].get("content_hash"),
            f"sale content_hash for {row['case_id']}",
        )


def _apply_capture_provenance_errors(
    rows: list[dict[str, Any]], errors: Mapping[str, str]
) -> None:
    """Quarantine rows whose frozen endpoint identity could not be proven.

    Endpoint provenance is a case-level gate.  Keeping one failed case in the
    import plan preserves its audit trail while forcing every field to remain
    non-publishable.  The error is deliberately copied into ``block_reason``
    because the SQL projection guard requires an explicit reason for an
    ``unverified`` row.
    """

    for row in rows:
        reason = errors.get(row["case_id"])
        if reason is None:
            continue
        row["review_state"] = "unverified"
        row["citation_status"] = "unverified"
        row["value_jsonb"] = None
        row["passes_local_gate"] = False
        row["block_reason"] = "; ".join(
            part for part in (row.get("block_reason"), f"capture endpoint provenance: {reason}") if part
        )


def _apply_capture_provenance_errors_to_case_status(
    rows: list[dict[str, Any]], errors: Mapping[str, str]
) -> None:
    """Expose endpoint quarantines on the retained case-level audit rows."""

    for row in rows:
        reason = errors.get(row["case_id"])
        if reason is None:
            continue
        row["access_reason"] = "; ".join(
            part
            for part in (
                row.get("access_reason"),
                f"capture endpoint provenance: {reason}",
            )
            if part
        )[:500]


def _validate_captured_case(
    case: Mapping[str, Any],
    case_id: str,
    source_name: str,
    source_url: str,
    expected_fields: Sequence[str],
    repo_root: Path,
    *,
    capture_provenance_errors: dict[str, str] | None = None,
) -> None:
    capture = case.get("capture")
    if not isinstance(capture, Mapping):
        raise ValueError(f"captured case {case_id} has no capture")
    capture_sha256 = _required_digest(capture.get("sha256"), f"capture sha256 for {case_id}")
    endpoint = _required_https(capture.get("endpoint"), f"capture endpoint for {case_id}")
    if not endpoint:
        raise ValueError(f"capture endpoint for {case_id} is empty")
    captured_at = _timestamp(capture.get("captured_at"), f"capture captured_at for {case_id}")
    private_ref = capture.get("private_ref")
    if not isinstance(private_ref, str) or not private_ref:
        raise ValueError(f"captured case {case_id} has no private capture path")
    path = Path(private_ref)
    if not path.is_absolute():
        raise ValueError(f"private capture path for {case_id} must be absolute")
    resolved = path.resolve()
    if resolved == repo_root or repo_root in resolved.parents:
        raise ValueError(f"private capture for {case_id} must stay outside the Git checkout")
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"private capture for {case_id} is not a regular file")
    if _file_sha256(path) != capture_sha256:
        raise ValueError(f"private capture digest mismatch for {case_id}")
    capture_bytes = path.read_bytes()
    try:
        _validate_capture_source_binding(
            capture, case_id, source_name, source_url, endpoint, capture_bytes
        )
    except ValueError as exc:
        if capture_provenance_errors is None:
            raise
        capture_provenance_errors[case_id] = str(exc)

    reviews = case.get("ai_reviews")
    if not isinstance(reviews, list) or len(reviews) != 2:
        raise ValueError(f"captured case {case_id} must contain exactly two AI reviews")
    expected_set = set(expected_fields)
    validated_reviews: list[dict[str, Any]] = []
    for index, review in enumerate(reviews, start=1):
        if not isinstance(review, Mapping) or review.get("reviewer_type") != "ai":
            raise ValueError(f"captured case {case_id} contains a non-AI review")
        try:
            validated = _validate_ai_review(
                review,
                capture_sha256,
                f"AI review {index} for {case_id}",
                tuple(expected_fields),
            )
        except ValueError as exc:
            # Keep the importer error useful to operators while preserving the
            # existing non-AI lane distinction in this module.
            raise ValueError(str(exc)) from exc
        if set(validated["labels"]) != expected_set:
            raise ValueError(f"AI review labels are incomplete for {case_id}")
        if validated["reviewed_at"] < captured_at:
            raise ValueError(f"AI review {index} cannot precede the frozen capture for {case_id}")
        validated_reviews.append(validated)

    _validate_ai_execution_independence(reviews, validated_reviews, case_id)

    adjudication = case.get("ai_adjudication")
    if adjudication is None:
        return
    if not isinstance(adjudication, Mapping) or adjudication.get("reviewer_type") != "ai":
        raise ValueError(f"AI adjudication for {case_id} is not marked as AI")
    if not isinstance(adjudication.get("reviewer"), str) or not adjudication["reviewer"].strip():
        raise ValueError(f"AI adjudication for {case_id} has no reviewer")
    if adjudication.get("blind_to_prediction") is not True:
        raise ValueError(f"AI adjudication for {case_id} is not blind to the prediction")
    if adjudication.get("capture_sha256") != capture_sha256:
        raise ValueError(f"AI adjudication capture digest mismatch for {case_id}")
    labels = adjudication.get("labels")
    if not isinstance(labels, Mapping) or not set(labels).issubset(expected_set):
        raise ValueError(f"AI adjudication field scope mismatch for {case_id}")
    _validate_labels(labels, case_id, allow_unresolved=True)
    if adjudication.get("output_sha256") != ai_review_output_sha256(labels):
        raise ValueError(f"AI adjudication output digest mismatch for {case_id}")


def _validate_ai_execution_independence(
    reviews: Sequence[Mapping[str, Any]],
    validated_reviews: Sequence[Mapping[str, Any]],
    case_id: str,
) -> None:
    """Require two distinct declared executions, using retained metadata.

    The v2 artifact predates a dedicated execution id, so its provider/model/
    prompt/timestamp tuple is the strongest available execution certificate.
    New artifacts may add one of the optional execution id fields; when they
    do, both passes must carry distinct ids.  Distinct reviewer names remain
    mandatory because an execution id alone is not a reviewer identity.
    """

    reviewers = [review.get("reviewer") for review in reviews]
    if len(reviewers) != 2 or any(not isinstance(value, str) or not value.strip() for value in reviewers):
        raise ValueError(f"captured case {case_id} contains an unnamed AI review")
    if reviewers[0] == reviewers[1]:
        raise ValueError(f"AI projection requires distinct independent passes for {case_id}")

    execution_ids: list[str | None] = []
    for index, review in enumerate(reviews, start=1):
        present: list[str] = []
        for key in AI_EXECUTION_ID_FIELDS:
            if key not in review or review[key] is None:
                continue
            value = review[key]
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"AI review {index} execution metadata {key} is invalid for {case_id}")
            present.append(value.strip())
        if len(set(present)) > 1:
            raise ValueError(f"AI review {index} execution metadata disagrees for {case_id}")
        execution_ids.append(present[0] if present else None)

    if any(value is not None for value in execution_ids):
        if any(value is None for value in execution_ids) or execution_ids[0] == execution_ids[1]:
            raise ValueError(f"AI passes need distinct execution ids when execution metadata is present for {case_id}")
        return

    signatures = [
        (
            review.get("provider"),
            review.get("model"),
            review.get("prompt_version"),
            review.get("prompt_record_status"),
            review.get("prompt_sha256"),
            validated.get("reviewed_at"),
            review.get("output_sha256"),
        )
        for review, validated in zip(reviews, validated_reviews, strict=True)
    ]
    if len(set(signatures)) != len(signatures):
        raise ValueError(f"AI passes do not contain distinct execution metadata for {case_id}")


def _validate_capture_source_binding(
    capture: Mapping[str, Any],
    case_id: str,
    source_name: str,
    source_url: str,
    endpoint: str,
    capture_bytes: bytes,
) -> None:
    """Bind a frozen capture endpoint to its source URL or an observed chain."""

    if endpoint == source_url:
        return
    chain = capture.get("redirect_chain")
    if chain is not None:
        if not isinstance(chain, list):
            raise ValueError(f"capture redirect_chain is invalid for {case_id}")
        if chain:
            _validate_redirect_chain(chain, case_id, source_url, endpoint)
            return
    if _validate_notaires_api_identity(
        case_id, source_name, source_url, endpoint, capture_bytes
    ):
        return
    raise ValueError(
        f"capture endpoint differs from source_url for {case_id}; a redirect_chain proof is "
        "required unless the approved Notaires API identity contract applies"
    )


def _validate_redirect_chain(
    chain: list[Any], case_id: str, source_url: str, endpoint: str
) -> None:
    if len(chain) > MAX_REDIRECT_HOPS:
        raise ValueError(f"capture redirect_chain is too long for {case_id}")

    previous = source_url
    for index, hop in enumerate(chain, start=1):
        if not isinstance(hop, Mapping):
            raise ValueError(f"capture redirect_chain hop {index} is invalid for {case_id}")
        hop_from = _required_https(hop.get("from"), f"capture redirect_chain hop {index} source for {case_id}")
        hop_to = _required_https(hop.get("to"), f"capture redirect_chain hop {index} target for {case_id}")
        status = hop.get("status")
        if isinstance(status, bool) or not isinstance(status, int) or status not in REDIRECT_STATUSES:
            raise ValueError(f"capture redirect_chain hop {index} has an invalid status for {case_id}")
        if hop_from != previous:
            raise ValueError(f"capture redirect_chain is not contiguous for {case_id}")
        if hop_to == hop_from:
            raise ValueError(f"capture redirect_chain contains a self-loop for {case_id}")
        previous = hop_to
    if previous != endpoint:
        raise ValueError(f"capture redirect_chain does not terminate at endpoint for {case_id}")


def _validate_notaires_api_identity(
    case_id: str,
    source_name: str,
    source_url: str,
    endpoint: str,
    capture_bytes: bytes,
) -> bool:
    """Accept a Notaires API capture only with a stable listing identity.

    Notaires public listing pages expose the same listing through the public
    Immo-Interactif/Notaires URL and a JSON API endpoint.  This is a source
    identity contract, not a generic cross-domain redirect exemption: the
    source lane must be ``notaires``, the host pair is fixed, both paths carry
    the same terminal numeric id, and the frozen JSON must repeat that id in
    its stable top-level ``id`` field.
    """

    if source_name != "notaires":
        return False
    source_parts = urlsplit(source_url)
    endpoint_parts = urlsplit(endpoint)
    source_host = (source_parts.hostname or "").lower()
    endpoint_host = (endpoint_parts.hostname or "").lower()
    if (source_host, endpoint_host) not in NOTAIRES_API_HOST_PAIRS:
        return False
    if source_parts.port is not None or endpoint_parts.port is not None:
        return False
    if not source_parts.path.startswith(NOTAIRES_PUBLIC_PATH_PREFIXES[source_host]):
        return False
    if source_parts.query or source_parts.fragment or endpoint_parts.query or endpoint_parts.fragment:
        return False
    endpoint_match = NOTAIRES_API_PATH_RE.fullmatch(endpoint_parts.path)
    source_id = _numeric_terminal_path_id(source_parts.path)
    if endpoint_match is None or source_id is None:
        return False
    endpoint_id = endpoint_match.group(1)
    if source_id != endpoint_id:
        raise ValueError(f"Notaires API identity id differs from public source for {case_id}")

    try:
        payload = json.loads(capture_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Notaires API capture is not valid JSON for {case_id}") from exc
    if not isinstance(payload, Mapping):
        raise ValueError(f"Notaires API capture must be a JSON object for {case_id}")
    listing_id = payload.get("id")
    if isinstance(listing_id, bool):
        listing_id = None
    elif isinstance(listing_id, int):
        listing_id = str(listing_id)
    elif isinstance(listing_id, str) and NUMERIC_PATH_ID_RE.fullmatch(listing_id.strip()):
        listing_id = str(int(listing_id.strip()))
    else:
        listing_id = None
    if listing_id != str(int(source_id)):
        raise ValueError(f"Notaires API capture stable listing id differs from source for {case_id}")
    return True


def _numeric_terminal_path_id(path: str) -> str | None:
    terminal = path.rstrip("/").rsplit("/", 1)[-1]
    return terminal if NUMERIC_PATH_ID_RE.fullmatch(terminal) else None


def _validate_labels(labels: Mapping[str, Any], case_id: str, *, allow_unresolved: bool = False) -> None:
    for field, label in labels.items():
        if not isinstance(label, Mapping):
            raise ValueError(f"AI label {field} for {case_id} is not an object")
        state = label.get("state")
        allowed = AI_LABEL_STATES if allow_unresolved else AI_LABEL_STATES - {"unresolved"}
        if state not in allowed:
            raise ValueError(f"AI label {field} for {case_id} has an invalid state")
        if state == "unresolved" and not isinstance(label.get("reason"), str):
            raise ValueError(f"unresolved AI label {field} for {case_id} needs a reason")


def _projection_key(row: Mapping[str, Any]) -> tuple[str, str, str]:
    return tuple(str(row.get(column) or "") for column in PROJECTION_KEY_COLUMNS)  # type: ignore[return-value]


def _projection_rows_equal(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    for column in PROJECTION_COLUMNS:
        if _canonical_value(left.get(column)) != _canonical_value(right.get(column)):
            return False
    return True


def _case_status_key(row: Mapping[str, Any]) -> tuple[str, str]:
    return tuple(str(row.get(column) or "") for column in CASE_STATUS_KEY_COLUMNS)  # type: ignore[return-value]


def _case_status_rows_equal(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return all(
        _canonical_value(left.get(column)) == _canonical_value(right.get(column))
        for column in CASE_STATUS_COLUMNS
    )


def _canonical_value(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return str(value)


def _postgres_value(column: str, value: Any) -> Any:
    if column in PROJECTION_JSON_COLUMNS and value is not None and Jsonb is not None:
        return Jsonb(value)
    return value


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _required_text(value: Any, description: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{description} must be non-empty text")
    return value.strip()


def _required_https(value: Any, description: str) -> str:
    text = _required_text(value, description)
    if not text.startswith("https://"):
        raise ValueError(f"{description} must use HTTPS")
    return text


def _required_digest(value: Any, description: str) -> str:
    text = _required_text(value, description)
    if len(text) != 64 or any(char not in "0123456789abcdef" for char in text):
        raise ValueError(f"{description} must be a lowercase SHA-256 digest")
    return text


def _optional_digest(value: Any, description: str) -> str | None:
    if value is None or value == "":
        return None
    return _required_digest(value, description)


def _safe_export_reason(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    # The export is safe to hand to an external SQL connector.  Keep the
    # operator outcome, but redact anything that resembles a local path.
    lowered = text.casefold()
    if "/" in text or "\\" in text or "private_ref" in lowered or "capture_path" in lowered:
        return "access outcome recorded"
    return text[:500]


def _sale_uuid_text(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    parts = text.split("-")
    if len(parts) != 5 or len(parts[0]) != 8 or len(parts[1]) != 4 or len(parts[2]) != 4:
        return None
    if len(parts[3]) != 4 or len(parts[4]) != 12:
        return None
    try:
        int(text.replace("-", ""), 16)
    except ValueError:
        return None
    return text.lower()
