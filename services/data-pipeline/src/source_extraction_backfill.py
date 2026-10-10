"""Plan and apply a narrow repair of source-extracted property facts.

This module intentionally does not read from a database.  A caller supplies a
JSON snapshot of ``auction_sales`` rows, the plan mode produces a signed plan
and a private backup, and the apply mode replays that plan through one
optimistic-concurrency guarded PostgREST PATCH per row.

Only physical property fields and the ``raw_payload`` evidence envelope may be
written.  Prices, dates, sale status, location/geocoding, valuation, editorial
content and media are never part of an operation payload.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import stat
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.extraction_profiles import attach_source_property_features
from src.recompute_scoring import _sale_from_storage_row
from src.sale_procedure import classify_sale_procedure

BACKFILL_SCHEMA_VERSION = "source_extraction_backfill_v1"
BACKFILL_NAMESPACE = "source_extraction_backfill"
MAX_EDITORIAL_TEXT_CHARS = 120_000
MAX_EDITORIAL_CONTAINER_ITEMS = 400
PHYSICAL_QUALITY_FLAGS = frozenset(
    {
        "ambiguous_surface",
        "surface_calculated_from_rooms",
        "surface_contradiction",
        "surface_type_unverified",
        "surface_unit_or_consistency_warning",
        "parcel_surface_scope_unverified",
        "partial_surface_scope_restored",
    }
)

# These are the only canonical columns a generated PATCH can contain.  In
# particular, ``occupancy_status`` is deliberately excluded: it is a legal
# or sale-state field in the current schema even when source text describes
# occupancy of the physical asset.
PHYSICAL_FIELDS = frozenset(
    {
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
    }
)
UPDATE_ALLOWLIST = frozenset((*PHYSICAL_FIELDS, "raw_payload"))

# This is a belt-and-suspenders check for plan input and for future additions
# to the model.  A field in this set must never appear in operation values.
PROTECTED_FIELDS = frozenset(
    {
        "starting_price_eur",
        "adjudication_price_eur",
        "sale_date",
        "visit_dates",
        "status",
        "latitude",
        "longitude",
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
        "title",
        "description",
        "raw_text",
        "source_images",
        "raw_image_url",
        "documents",
        "address",
        "city",
        "department",
        "postal_code",
        "tribunal",
        "lawyer_name",
        "lawyer_contact",
        "quality_flags",
        "updated_at",
    }
)


class PlanIntegrityError(ValueError):
    """Raised when a plan or its mandatory backup has been altered."""


class PlanInputError(ValueError):
    """Raised when a snapshot or operation is unsafe to plan or apply."""


class HttpResponse(Protocol):
    status_code: int

    def json(self) -> Any: ...


RequestFn = Callable[..., HttpResponse]


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _json_safe(value: Any) -> Any:
    """Convert model values to strict JSON without changing their meaning."""

    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    # Decimal is intentionally handled without importing it at module import
    # time; the pipeline model uses Decimal heavily and this keeps this module
    # useful with the lightweight test runtime too.
    if value.__class__.__name__ == "Decimal":
        number = float(value)
        return int(number) if number.is_integer() else number
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "model_dump"):
        return _json_safe(value.model_dump(mode="json"))
    return str(value)


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        _json_safe(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_bytes(_canonical_bytes(value))


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PlanInputError(f"Impossible de lire le JSON {path}: {exc}") from exc


def _write_private_json(path: Path, value: Any) -> str:
    """Write an immutable-by-convention 0600 JSON artifact atomically."""

    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise PlanInputError(f"Refus d'écrire dans un lien symbolique: {path}")
    data = _canonical_bytes(value)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if temporary.exists() or temporary.is_symlink():
        raise PlanInputError(f"Fichier temporaire inattendu: {temporary}")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if temporary.exists():
            temporary.unlink()
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise PlanInputError(f"Le fichier privé n'est pas en mode 0600: {path} ({oct(mode)})")
    return _sha256_bytes(data)


def _assert_private_file(path: Path) -> None:
    if not path.is_file() or path.is_symlink():
        raise PlanIntegrityError(f"Sauvegarde privée absente ou invalide: {path}")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise PlanIntegrityError(f"Sauvegarde non privée (mode {oct(mode)}): {path}")


def _rows_from_document(document: Any) -> list[dict[str, Any]]:
    rows = document.get("rows") if isinstance(document, Mapping) else document
    if not isinstance(rows, list):
        raise PlanInputError("Le snapshot doit être une liste JSON ou un objet {rows: [...]}")
    result: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping):
            raise PlanInputError(f"La ligne {index} du snapshot n'est pas un objet JSON")
        result.append(dict(row))
    return result


def load_rows(path: str | Path) -> list[dict[str, Any]]:
    return _rows_from_document(_read_json(Path(path)))


def _surface_context(sale: Any) -> str:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_blocks = payload.get("source_blocks")
    block_values = (
        [value for key, value in source_blocks.items() if str(key) != "listing_completeness"]
        if isinstance(source_blocks, dict)
        else []
    )
    values: list[object] = [
        sale.title,
        sale.description,
        sale.raw_text,
        payload.get("source_description"),
        *block_values,
    ]
    parts = dict.fromkeys(str(value).strip() for value in values if value and str(value).strip())
    return "\n".join(parts)


def _bounded_editorial_value(value: Any, *, budget: int = MAX_EDITORIAL_TEXT_CHARS, depth: int = 0) -> Any:
    """Bound source-editorial material before regex/profile extraction.

    Historical raw payloads can contain saved HTML or OCR several megabytes
    long.  The backfill only needs the public editorial text and structured
    source blocks; keeping this bound prevents a stale payload from becoming a
    new extraction corpus.
    """

    if budget <= 0:
        return None
    if isinstance(value, str):
        return value[:budget]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= 6:
        return str(value)[: min(budget, 2000)]
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        remaining = budget
        for key, item in list(value.items())[:MAX_EDITORIAL_CONTAINER_ITEMS]:
            if str(key) == "listing_completeness":
                continue
            clipped = _bounded_editorial_value(item, budget=remaining, depth=depth + 1)
            if clipped is None:
                continue
            result[str(key)] = clipped
            remaining -= min(remaining, len(str(clipped)))
            if remaining <= 0:
                break
        return result
    if isinstance(value, (list, tuple, set)):
        result = []
        remaining = budget
        for item in list(value)[:MAX_EDITORIAL_CONTAINER_ITEMS]:
            clipped = _bounded_editorial_value(item, budget=remaining, depth=depth + 1)
            if clipped is None:
                continue
            result.append(clipped)
            remaining -= min(remaining, len(str(clipped)))
            if remaining <= 0:
                break
        return result
    return str(value)[:budget]


def _editorial_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Build the small raw view consumed by deterministic source enrichers."""

    keys = (
        "source_name",
        "source_url",
        "external_id",
        "title",
        "description",
        "raw_text",
        "source_description",
        "address",
        "city",
        "postal_code",
        "tribunal",
        "lawyer_name",
        "lawyer_contact",
        "occupancy_status",
        "property_type",
        "source_blocks",
        "operator_fields",
        "operator_public_model",
        "source_property_features",
        "source_property_feature_evidence",
        "source_property_features_meta",
        "source_procedure_profile",
        "source_field_observations",
        "source_evidence",
        "source_evidence_provenance",
        "source_conflicts",
        "documents",
    )
    return {
        key: _bounded_editorial_value(payload[key])
        for key in keys
        if key in payload and payload[key] is not None
    }


def _recompute_sale(row: Mapping[str, Any]) -> Any:
    """Run deterministic source extraction without geocoding or heavy work."""

    # Several enrichers update nested ``source_blocks`` in place.  Hydrate a
    # deep copy so planning never mutates the operator's input snapshot (or the
    # backup that was written from it).
    sale = _sale_from_storage_row(copy.deepcopy(dict(row)))
    sale.raw_payload = _editorial_payload(sale.raw_payload)
    sale.raw_text = _bounded_editorial_value(sale.raw_text)
    sale.description = _bounded_editorial_value(sale.description)
    sale.title = _bounded_editorial_value(sale.title)
    classify_sale_procedure(sale)
    context = _surface_context(sale)
    if context:
        extract_and_apply_deterministic_surface_reasoning(sale, context)
    normalize_asset_features(sale)
    attach_source_property_features(sale.raw_payload)
    return sale


def _payload_dict(row: Mapping[str, Any]) -> dict[str, Any] | None:
    payload = row.get("raw_payload")
    if payload is None:
        result: dict[str, Any] = {}
    elif isinstance(payload, Mapping):
        result = copy.deepcopy(dict(payload))
    else:
        # Never replace a malformed/raw string payload as a side effect of a
        # physical-field repair.  The canonical columns can still be corrected.
        return None
    # The application view intentionally exposes source_blocks as a separate
    # JSON column while omitting raw_payload.  Carry that projection forward
    # so the PATCH can add listing_completeness without dropping source facts.
    if "source_blocks" not in result and isinstance(row.get("source_blocks"), Mapping):
        result["source_blocks"] = copy.deepcopy(dict(row["source_blocks"]))
    return result


def _safe_asset_normalization(value: Any) -> dict[str, Any] | None:
    """Keep physical evidence while dropping score/valuation material."""

    if not isinstance(value, Mapping):
        return None
    safe: dict[str, Any] = {}
    for section in ("features", "surfaces"):
        raw_section = value.get(section)
        if isinstance(raw_section, Mapping):
            filtered = {
                field: _json_safe(raw_section[field])
                for field in PHYSICAL_FIELDS
                if field in raw_section and raw_section[field] is not None
            }
            if any(item not in (None, False, "", [], {}) for item in filtered.values()):
                safe[section] = filtered
    risks = value.get("risks")
    if isinstance(risks, list) and risks:
        safe["risks"] = _json_safe(risks)
    return safe or None


def _meaningful_evidence(key: str, value: Any) -> bool:
    if value in (None, "", [], {}):
        return False
    if key == "surface_analysis" and isinstance(value, Mapping):
        return any(bool(value.get(name)) for name in ("measurements", "candidates", "derivations", "contradictions"))
    if key == "source_property_features_meta":
        return False
    if key == "source_procedure_profile" and isinstance(value, Mapping):
        fields = value.get("fields")
        return bool(value.get("family") not in (None, "unknown") or (isinstance(fields, Mapping) and fields))
    if key == "source_field_observations" and isinstance(value, Mapping):
        return any(
            field != "procedure_family"
            and isinstance(claim, Mapping)
            and claim.get("value") not in (None, "")
            and claim.get("state") not in (None, "unknown")
            for field, claim in value.items()
        )
    return True


def _listing_completeness_projection(sale: Any) -> dict[str, Any] | None:
    payload = sale.raw_payload if isinstance(sale.raw_payload, Mapping) else {}
    source_blocks = payload.get("source_blocks")
    if not isinstance(source_blocks, Mapping):
        return None
    projection = source_blocks.get("listing_completeness")
    return _json_safe(projection) if isinstance(projection, Mapping) else None


def _enriched_payload(row: Mapping[str, Any], sale: Any, *, processed_at: str, changed_fields: Sequence[str]) -> dict[str, Any] | None:
    payload = _payload_dict(row)
    if payload is None:
        return None

    # Keep the stored raw payload byte-for-byte in meaning.  The namespace is
    # additive and contains only evidence produced by this narrow pass; this
    # avoids copying normalized title/date/status/geocode values back into the
    # raw payload by accident.
    existing_namespace = payload.get(BACKFILL_NAMESPACE)
    previous_processed_at = (
        existing_namespace.get("processed_at")
        if isinstance(existing_namespace, Mapping)
        else None
    )
    previous_changed_fields = (
        existing_namespace.get("changed_physical_fields")
        if isinstance(existing_namespace, Mapping)
        else None
    )
    persisted_changed_fields = (
        list(previous_changed_fields)
        if not changed_fields and isinstance(previous_changed_fields, list)
        else list(changed_fields)
    )
    enrichment: dict[str, Any] = (
        copy.deepcopy(dict(existing_namespace))
        if isinstance(existing_namespace, Mapping)
        else {}
    )
    enrichment.update(
        {
            "schema_version": BACKFILL_SCHEMA_VERSION,
            # Retain the original timestamp when replaying a previously enriched
            # payload so planning is idempotent across runs.
            "processed_at": previous_processed_at or processed_at,
            "changed_physical_fields": persisted_changed_fields,
        }
    )
    evidence_values: dict[str, Any] = {}
    for key in (
        "surface_analysis",
        "surface_scope_reconciliation",
        "feature_scope_reconciliation",
        "source_property_features",
        "source_property_feature_evidence",
        "source_property_features_meta",
        "source_procedure_profile",
        "source_field_observations",
    ):
        value = sale.raw_payload.get(key) if isinstance(sale.raw_payload, dict) else None
        if value is not None:
            evidence_values[key] = _json_safe(value)
    asset_payload = _safe_asset_normalization(sale.raw_payload.get("asset_normalization"))
    if asset_payload:
        evidence_values["asset_normalization"] = asset_payload
    projection = _listing_completeness_projection(sale)
    if projection is not None:
        evidence_values["listing_completeness"] = projection
        source_blocks = payload.get("source_blocks")
        source_blocks = copy.deepcopy(dict(source_blocks)) if isinstance(source_blocks, Mapping) else {}
        source_blocks["listing_completeness"] = projection
        payload["source_blocks"] = source_blocks

    # Do not create a write-only timestamp on rows for which the deterministic
    # pass found neither a physical correction nor source evidence.  This keeps
    # the backfill narrow on large historical snapshots.
    meaningful_evidence = bool(changed_fields) or any(
        _meaningful_evidence(key, value) for key, value in evidence_values.items()
    )
    if not meaningful_evidence:
        return None
    enrichment.update(evidence_values)

    existing_flags = row.get("quality_flags")
    existing_flag_set = {str(flag) for flag in existing_flags} if isinstance(existing_flags, list) else set()
    new_flags = [
        str(flag)
        for flag in sale.quality_flags
        if str(flag) not in existing_flag_set and str(flag) in PHYSICAL_QUALITY_FLAGS
    ]
    if new_flags:
        enrichment["quality_flags_added"] = sorted(set(new_flags))

    payload[BACKFILL_NAMESPACE] = enrichment
    return _json_safe(payload)


def _value_for_sale(sale: Any, field: str) -> Any:
    return _json_safe(getattr(sale, field, None))


def _changed_values(row: Mapping[str, Any], sale: Any, *, processed_at: str) -> tuple[dict[str, Any], list[str]]:
    values: dict[str, Any] = {}
    changed_fields: list[str] = []
    for field in sorted(PHYSICAL_FIELDS):
        before = _json_safe(row.get(field))
        after = _value_for_sale(sale, field)
        if before != after:
            values[field] = after
            changed_fields.append(field)

    enriched = _enriched_payload(row, sale, processed_at=processed_at, changed_fields=changed_fields)
    if enriched is not None and _json_safe(row.get("raw_payload")) != enriched:
        values["raw_payload"] = enriched
    return values, changed_fields


def _validate_operation_values(values: Mapping[str, Any]) -> None:
    unknown = set(values) - UPDATE_ALLOWLIST
    if unknown:
        raise PlanIntegrityError(f"Champs hors allowlist dans le plan: {sorted(unknown)}")
    forbidden = set(values) & PROTECTED_FIELDS
    if forbidden:
        raise PlanIntegrityError(f"Champs protégés dans le plan: {sorted(forbidden)}")


def _backup_document(rows: Sequence[Mapping[str, Any]], *, created_at: str) -> dict[str, Any]:
    return {
        "schema_version": BACKFILL_SCHEMA_VERSION,
        "created_at": created_at,
        "rows": [_json_safe(dict(row)) for row in rows],
    }


def build_plan(
    rows: Sequence[Mapping[str, Any]],
    *,
    backup_path: str | Path,
    generated_at: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build and persist a private backup, returning ``(plan, backup)``.

    Planning is fail-closed for malformed identity fences.  Such rows are
    counted as skipped and cannot accidentally be sent to PostgREST.
    """

    created_at = generated_at or _utc_now()
    original_rows = [dict(row) for row in rows]
    backup = _backup_document(original_rows, created_at=created_at)
    backup_path_obj = Path(backup_path).expanduser().resolve()
    backup_sha256 = _write_private_json(backup_path_obj, backup)

    operations: list[dict[str, Any]] = []
    skipped_by_reason: Counter[str] = Counter()
    unchanged = 0
    seen_ids: set[str] = set()
    for index, row in enumerate(original_rows):
        row_id = row.get("id")
        observed_updated_at = row.get("updated_at")
        if not row_id:
            skipped_by_reason["missing_id"] += 1
            continue
        normalized_id = str(row_id)
        if normalized_id in seen_ids:
            skipped_by_reason["duplicate_id"] += 1
            continue
        seen_ids.add(normalized_id)
        if not observed_updated_at:
            skipped_by_reason["missing_updated_at"] += 1
            continue
        try:
            sale = _recompute_sale(row)
            values, changed_fields = _changed_values(row, sale, processed_at=created_at)
        except Exception:  # pragma: no cover - exercised by caller-specific fixtures
            skipped_by_reason["recompute_error"] += 1
            continue
        if not values:
            unchanged += 1
            continue
        _validate_operation_values(values)
        operations.append(
            {
                "id": normalized_id,
                "observed_updated_at": _json_safe(observed_updated_at),
                "values": values,
                "changed_fields": changed_fields,
                "source_row_index": index,
            }
        )

    plan_without_checksum: dict[str, Any] = {
        "schema_version": BACKFILL_SCHEMA_VERSION,
        "created_at": created_at,
        "backup": {
            "path": str(backup_path_obj),
            "sha256": backup_sha256,
        },
        "allowlist": sorted(UPDATE_ALLOWLIST),
        "operations": operations,
        "counters": {
            "input": len(original_rows),
            "planned": len(operations),
            "changed": len(operations),
            "unchanged": unchanged,
            "skipped": sum(skipped_by_reason.values()),
            "skipped_by_reason": dict(sorted(skipped_by_reason.items())),
        },
        "input_sha256": _sha256_json(original_rows),
    }
    plan = {
        **plan_without_checksum,
        "checksum": _sha256_json(plan_without_checksum),
    }
    return plan, backup


def write_plan(path: str | Path, plan: Mapping[str, Any]) -> str:
    checked = dict(plan)
    checksum = checked.pop("checksum", None)
    expected = _sha256_json(checked)
    if checksum != expected:
        raise PlanIntegrityError("Le checksum du plan fourni est invalide")
    return _write_private_json(Path(path).expanduser().resolve(), plan)


def plan_backfill(
    rows: Sequence[Mapping[str, Any]],
    *,
    plan_path: str | Path,
    backup_path: str | Path,
    generated_at: str | None = None,
) -> dict[str, Any]:
    plan, _backup = build_plan(rows, backup_path=backup_path, generated_at=generated_at)
    write_plan(plan_path, plan)
    return plan


def load_plan(path: str | Path) -> dict[str, Any]:
    path_obj = Path(path).expanduser().resolve()
    _assert_private_file(path_obj)
    plan = _read_json(path_obj)
    if not isinstance(plan, dict):
        raise PlanIntegrityError("Le plan n'est pas un objet JSON")
    checksum = plan.get("checksum")
    without_checksum = dict(plan)
    without_checksum.pop("checksum", None)
    if not isinstance(checksum, str) or checksum != _sha256_json(without_checksum):
        raise PlanIntegrityError("Checksum du fichier plan invalide")
    if plan.get("schema_version") != BACKFILL_SCHEMA_VERSION:
        raise PlanIntegrityError("Version de plan non supportée")
    if plan.get("allowlist") != sorted(UPDATE_ALLOWLIST):
        raise PlanIntegrityError("Allowlist du plan inattendue")
    operations = plan.get("operations")
    if not isinstance(operations, list):
        raise PlanIntegrityError("Opérations du plan invalides")
    seen_ids: set[str] = set()
    for operation in operations:
        if not isinstance(operation, Mapping):
            raise PlanIntegrityError("Opération du plan invalide")
        values = operation.get("values")
        if not isinstance(values, Mapping):
            raise PlanIntegrityError("Valeurs d'opération invalides")
        _validate_operation_values(values)
        if not operation.get("id") or not operation.get("observed_updated_at"):
            raise PlanIntegrityError("Opération sans id ou updated_at observé")
        operation_id = str(operation["id"])
        if operation_id in seen_ids:
            raise PlanIntegrityError(f"Id dupliqué dans le plan: {operation_id}")
        seen_ids.add(operation_id)
    return plan


def _load_and_verify_backup(plan: Mapping[str, Any], backup_path: str | Path) -> dict[str, Any]:
    path = Path(backup_path).expanduser().resolve()
    _assert_private_file(path)
    raw = path.read_bytes()
    backup_meta = plan.get("backup")
    if not isinstance(backup_meta, Mapping) or backup_meta.get("sha256") != _sha256_bytes(raw):
        raise PlanIntegrityError("Checksum de la sauvegarde privée invalide")
    try:
        backup = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PlanIntegrityError(f"Sauvegarde JSON invalide: {exc}") from exc
    if not isinstance(backup, dict) or backup.get("schema_version") != BACKFILL_SCHEMA_VERSION:
        raise PlanIntegrityError("Version de sauvegarde non supportée")
    return backup


def _default_request(method: str, url: str, **kwargs: Any) -> HttpResponse:
    # Lazy import keeps plan mode entirely offline and makes the no-connection
    # guarantee explicit: this is an HTTP request only in apply mode.
    import httpx

    return httpx.request(method, url, **kwargs)


def _auction_sales_endpoint(postgrest_url: str) -> str:
    base = postgrest_url.rstrip("/")
    if base.endswith("/auction_sales"):
        return base
    if base.endswith("/rest/v1"):
        return f"{base}/auction_sales"
    return f"{base}/rest/v1/auction_sales"


def apply_plan(
    plan_path: str | Path,
    *,
    backup_path: str | Path,
    postgrest_url: str,
    api_key: str,
    request_fn: RequestFn | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Apply a verified plan with one id + updated_at filtered PATCH per row."""

    if not postgrest_url or not api_key:
        raise PlanInputError("postgrest_url et api_key sont obligatoires en mode apply")
    plan = load_plan(plan_path)
    backup = _load_and_verify_backup(plan, backup_path)
    backup_rows = backup.get("rows")
    if not isinstance(backup_rows, list):
        raise PlanIntegrityError("La sauvegarde ne contient pas de lignes")
    backup_by_id = {
        str(row.get("id")): row
        for row in backup_rows
        if isinstance(row, Mapping) and row.get("id")
    }
    request = request_fn or _default_request
    endpoint = _auction_sales_endpoint(postgrest_url)
    counts: Counter[str] = Counter()
    errors: list[dict[str, str]] = []
    for operation in plan["operations"]:
        operation_id = str(operation["id"])
        backup_row = backup_by_id.get(operation_id)
        if backup_row is None or _json_safe(backup_row.get("updated_at")) != operation["observed_updated_at"]:
            raise PlanIntegrityError(f"La sauvegarde ne correspond pas à l'opération {operation_id}")
        values = dict(operation["values"])
        _validate_operation_values(values)
        observed = str(operation["observed_updated_at"])
        params = {
            "id": f"eq.{operation_id}",
            "updated_at": f"eq.{observed}",
        }
        headers = {
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Prefer": "return=representation",
        }
        try:
            response = request(
                "PATCH",
                endpoint,
                params=params,
                headers=headers,
                json=values,
                timeout=timeout,
            )
            status_code = int(response.status_code)
            body: Any = None
            try:
                body = response.json()
            except (ValueError, TypeError, AttributeError):
                body = None
            if status_code in {404, 409} or (200 <= status_code < 300 and isinstance(body, list) and not body):
                counts["skipped_concurrent"] += 1
            elif 200 <= status_code < 300 and (body is not None or status_code == 204):
                counts["applied"] += 1
            else:
                counts["errors"] += 1
                errors.append({"id": operation_id, "reason": f"http_{status_code}"})
        except Exception as exc:  # one bad row must not remove the fence from others
            counts["errors"] += 1
            errors.append({"id": operation_id, "reason": f"{type(exc).__name__}: {exc}"})
    return {
        "planned": len(plan["operations"]),
        "applied": counts["applied"],
        "skipped_concurrent": counts["skipped_concurrent"],
        "errors": counts["errors"],
        "error_details": errors,
    }


# Explicit aliases make the operator-facing intent clear to callers that use
# this module as a library rather than through the CLI.
build_backfill_plan = build_plan
apply_backfill_plan = apply_plan


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backfill borné des attributs physiques extraits des sources.")
    parser.add_argument(
        "--plan",
        nargs="?",
        const="",
        metavar="PLAN.json",
        help="Génère un plan privé; --input fournit le snapshot et --output le fichier plan.",
    )
    parser.add_argument("--input", help="Snapshot JSON (liste de lignes auction_sales) en mode plan.")
    parser.add_argument("--output", help="Chemin du plan produit; défaut: source-extraction-backfill-plan.json.")
    parser.add_argument("--backup", required=True, help="Sauvegarde privée obligatoire (mode 0600).")
    parser.add_argument("--apply-plan", metavar="PLAN.json", help="Applique un plan signé existant.")
    parser.add_argument("--postgrest-url", default=os.getenv("SUPABASE_URL"))
    parser.add_argument("--api-key", default=os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    plan_mode = args.plan is not None
    apply_mode = args.apply_plan is not None
    if plan_mode == apply_mode:
        print("Choisir exactement un mode --plan ou --apply-plan", file=sys.stderr)
        return 2
    try:
        if args.apply_plan:
            result = apply_plan(
                args.apply_plan,
                backup_path=args.backup,
                postgrest_url=args.postgrest_url or "",
                api_key=args.api_key or "",
            )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 1 if result["errors"] else 0

        input_path = args.input
        output = args.output
        # Accept both ergonomic forms used by operators:
        #   --plan output.json --input rows.json
        #   --plan rows.json (output defaults to the conventional filename)
        if not input_path and args.plan:
            candidate = Path(args.plan).expanduser()
            if candidate.is_file():
                input_path = str(candidate)
            else:
                output = output or args.plan
        if not input_path:
            print("--input est obligatoire avec --plan", file=sys.stderr)
            return 2
        output = output or "source-extraction-backfill-plan.json"
        if not output:
            output = "source-extraction-backfill-plan.json"
        plan = plan_backfill(
            load_rows(input_path),
            plan_path=output,
            backup_path=args.backup,
        )
        print(json.dumps(plan["counters"], ensure_ascii=False, sort_keys=True))
        return 0
    except (PlanInputError, PlanIntegrityError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [
    "BACKFILL_NAMESPACE",
    "BACKFILL_SCHEMA_VERSION",
    "PHYSICAL_FIELDS",
    "UPDATE_ALLOWLIST",
    "PlanInputError",
    "PlanIntegrityError",
    "apply_plan",
    "apply_backfill_plan",
    "build_plan",
    "build_backfill_plan",
    "load_plan",
    "load_rows",
    "main",
    "plan_backfill",
    "write_plan",
]
