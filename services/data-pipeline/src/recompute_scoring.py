from __future__ import annotations

import argparse
import logging
from collections import Counter
from datetime import UTC, datetime
from typing import Any

import httpx
from dotenv import load_dotenv

from src.asset_normalization import normalize_asset_features
from src.config import ROOT_DIR, load_settings
from src.normalize import normalize_sale
from src.sale_procedure import SALE_PROCEDURE_SCHEMA_VERSION, classify_sale_procedure
from src.storage.supabase_client import upsert_sales_to_supabase
from src.tribunal import fill_tribunal

LOGGER = logging.getLogger(__name__)
PAGE_SIZE = 200
SALE_VENUE_TYPES = {"tribunal", "notary", "state", "online", "unknown"}
SALE_LEGAL_FRAMEWORKS = {
    "judicial_seizure",
    "judicial_partition",
    "insolvency",
    "voluntary_notarial",
    "state_sale",
    "unknown",
}
SALE_VERIFICATION_STATUSES = {"verified", "cross_checked", "pending", "conflict"}


def recompute_scoring(
    *,
    source: str | None = None,
    limit: int | None = None,
    batch_size: int = 20,
    dry_run: bool = False,
) -> int:
    _load_env_fallbacks()
    rows = _fetch_sales(source=source, limit=limit)
    if not rows:
        LOGGER.error("No stored sales matched the requested recompute scope")
        return 1
    sales = []
    failures: list[str] = []
    for row in rows:
        try:
            sale = _sale_from_storage_row(row)
            fill_tribunal(sale)
            classify_sale_procedure(sale)
            normalize_asset_features(sale)
            sales.append(sale)
        except Exception as exc:
            failures.append(str(row.get("source_url") or row.get("id") or "unknown-row"))
            LOGGER.exception("Scoring recompute failed for %s: %s", row.get("source_url"), exc)

    if dry_run:
        _print_summary(sales, dry_run=True, failures=failures)
        return 1 if failures else 0

    upserted = 0
    for batch in _chunks(sales, max(1, batch_size)):
        upserted += upsert_sales_to_supabase(batch, refresh_last_seen=False)
    _print_summary(sales, dry_run=False, upserted=upserted, failures=failures)
    if failures or upserted != len(sales):
        LOGGER.error(
            "Incomplete scoring recompute: selected=%s computed=%s upserted=%s failures=%s",
            len(rows),
            len(sales),
            upserted,
            len(failures),
        )
        return 1
    return 0


def verify_persisted_sale_procedures(
    *,
    source: str | None = None,
    limit: int | None = None,
) -> int:
    """Fail closed when a persisted procedure payload is missing or inconsistent."""

    _load_env_fallbacks()
    rows = _fetch_sales(source=source, limit=limit)
    if not rows:
        LOGGER.error("No stored sales matched the requested verification scope")
        return 1

    invalid: list[tuple[str, list[str]]] = []
    statuses: Counter[str] = Counter()
    venues: Counter[str] = Counter()
    for row in rows:
        statuses[str(row.get("sale_verification_status") or "missing")] += 1
        venues[str(row.get("sale_venue_type") or "missing")] += 1
        issues = _validate_persisted_sale_procedure(row)
        if issues:
            invalid.append((str(row.get("source_url") or row.get("id") or "unknown-row"), issues))

    print("Persisted sale procedure verification")
    print(f"- sales: {len(rows)}")
    print(f"- invalid: {len(invalid)}")
    print(f"- venues: {dict(venues)}")
    print(f"- statuses: {dict(statuses)}")
    for identifier, issues in invalid[:20]:
        print(f"- invalid_row: {identifier}: {', '.join(issues)}")
    if len(invalid) > 20:
        print(f"- additional_invalid_rows: {len(invalid) - 20}")
    return 1 if invalid else 0


def _validate_persisted_sale_procedure(row: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    venue_type = row.get("sale_venue_type")
    legal_framework = row.get("sale_legal_framework")
    verification_status = row.get("sale_verification_status")
    procedure = row.get("sale_procedure")

    if venue_type not in SALE_VENUE_TYPES:
        issues.append("invalid sale_venue_type")
    if legal_framework not in SALE_LEGAL_FRAMEWORKS:
        issues.append("invalid sale_legal_framework")
    if verification_status not in SALE_VERIFICATION_STATUSES:
        issues.append("invalid sale_verification_status")
    if not isinstance(procedure, dict) or not procedure:
        issues.append("missing sale_procedure")
        return issues

    if procedure.get("schema_version") != SALE_PROCEDURE_SCHEMA_VERSION:
        issues.append("invalid schema_version")
    if procedure.get("venue_type") != venue_type:
        issues.append("venue_type mismatch")
    if procedure.get("legal_framework") != legal_framework:
        issues.append("legal_framework mismatch")
    if not isinstance(procedure.get("rules"), dict):
        issues.append("missing rules")
    verification = procedure.get("verification")
    if not isinstance(verification, dict):
        issues.append("missing verification")
    elif verification.get("status") != verification_status:
        issues.append("verification status mismatch")
    return issues


def _load_env_fallbacks() -> None:
    load_dotenv(ROOT_DIR / ".env")
    load_dotenv(ROOT_DIR.parents[1] / "apps" / "scout" / ".env.local")


def _fetch_sales(*, source: str | None, limit: int | None) -> list[dict[str, Any]]:
    settings = load_settings()
    supabase_url = str(settings["supabase_url"] or "").rstrip("/")
    api_key = str(settings["supabase_service_role_key"] or "")
    if not supabase_url or not api_key:
        raise RuntimeError("Supabase URL/service role key are missing")

    endpoint = f"{supabase_url}/rest/v1/auction_sales"
    rows: list[dict[str, Any]] = []
    offset = 0
    headers = {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    while True:
        remaining = None if limit is None else max(0, limit - len(rows))
        if remaining == 0:
            break
        page_size = PAGE_SIZE if remaining is None else min(PAGE_SIZE, remaining)
        params = {
            "select": "*",
            "order": "updated_at.desc.nullslast",
            "limit": str(page_size),
            "offset": str(offset),
        }
        if source:
            params["source_name"] = f"eq.{source}"
        response = httpx.get(endpoint, params=params, headers=headers, timeout=120)
        if response.is_error:
            raise httpx.HTTPStatusError(
                f"{response.status_code} response from Supabase auction_sales: {response.text}",
                request=response.request,
                response=response,
            )
        page = response.json()
        if not isinstance(page, list) or not page:
            break
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def _sale_from_storage_row(row: dict[str, Any]):
    original_payload = dict(row.get("raw_payload")) if isinstance(row.get("raw_payload"), dict) else {}
    original_payload.pop("raw_payload", None)
    row_payload = {key: value for key, value in row.items() if key != "raw_payload"}
    raw_sale = {**original_payload, **row_payload}
    # Stored titles are display titles generated by the pipeline. Surface
    # reconciliation needs the original editorial title and description.
    for field in ("title", "description", "raw_text", "source_blocks"):
        if original_payload.get(field):
            raw_sale[field] = original_payload[field]
    sale = normalize_sale(raw_sale)
    sale.id = str(row.get("id")) if row.get("id") else None
    sale.primary_source = row.get("primary_source") or sale.primary_source
    if isinstance(row.get("source_urls"), list):
        sale.source_urls = [str(item) for item in row["source_urls"] if item]
    sale.content_hash = row.get("content_hash")
    sale.first_seen_at = _parse_datetime(row.get("first_seen_at"))
    sale.last_seen_at = _parse_datetime(row.get("last_seen_at"))
    sale.created_at = _parse_datetime(row.get("created_at"))
    sale.updated_at = _parse_datetime(row.get("updated_at"))
    sale.quality_flags = []
    sale.raw_payload = raw_sale
    return sale


def _parse_datetime(value: object | None):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _chunks(items: list[Any], size: int):
    for index in range(0, len(items), size):
        yield items[index : index + size]


def _print_summary(
    sales: list[Any],
    *,
    dry_run: bool,
    upserted: int = 0,
    failures: list[str] | None = None,
) -> None:
    by_source: dict[str, int] = {}
    pretri = 0
    works = 0
    non_judicial = 0
    court_verified = 0
    court_unresolved = 0
    court_unverified = 0
    procedure_statuses: dict[str, int] = {}
    for sale in sales:
        by_source[sale.source_name] = by_source.get(sale.source_name, 0) + 1
        analysis = sale.raw_payload.get("investment_analysis") if isinstance(sale.raw_payload, dict) else {}
        gates = analysis.get("confidence_gates") if isinstance(analysis, dict) else {}
        if isinstance(gates, dict) and gates.get("readiness") == "pré-tri uniquement":
            pretri += 1
        if any(str(risk.get("risk_label")) == "travaux" for risk in sale.raw_payload.get("asset_normalization", {}).get("risks", [])):
            works += 1
        if "non_judicial_sale_context" in sale.quality_flags:
            non_judicial += 1
        assignment = sale.raw_payload.get("tribunal_assignment")
        if isinstance(assignment, dict) and assignment.get("status") == "verified":
            court_verified += 1
        if "tribunal_competence_unresolved" in sale.quality_flags:
            court_unresolved += 1
        if "tribunal_competence_unverified" in sale.quality_flags:
            court_unverified += 1
        procedure_statuses[sale.sale_verification_status] = procedure_statuses.get(sale.sale_verification_status, 0) + 1
    print("Scoring recompute summary")
    print(f"- mode: {'dry-run' if dry_run else 'upsert'}")
    print(f"- sales: {len(sales)}")
    print(f"- upserted: {upserted}")
    print(f"- failures: {len(failures or [])}")
    print(f"- by_source: {by_source}")
    print(f"- pretri_only: {pretri}")
    print(f"- works_to_quantify: {works}")
    print(f"- non_judicial_context: {non_judicial}")
    print(f"- tribunal_competence_verified: {court_verified}")
    print(f"- tribunal_competence_unresolved: {court_unresolved}")
    print(f"- tribunal_competence_unverified: {court_unverified}")
    print(f"- sale_procedure_statuses: {procedure_statuses}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recalcule le scoring métier des annonces déjà stockées.")
    parser.add_argument("--source", default=None, help="Filtre optionnel sur source_name.")
    parser.add_argument("--limit", type=int, default=None, help="Nombre maximum d'annonces à recalculer.")
    parser.add_argument("--batch-size", type=int, default=20, help="Taille des lots d'upsert Supabase.")
    parser.add_argument("--dry-run", action="store_true", help="Recalcule sans écrire dans Supabase.")
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Vérifie les procédures persistées sans les recalculer ni les modifier.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    args = parse_args()
    if args.verify_only:
        raise SystemExit(verify_persisted_sale_procedures(source=args.source, limit=args.limit))
    raise SystemExit(
        recompute_scoring(
            source=args.source,
            limit=args.limit,
            batch_size=args.batch_size,
            dry_run=args.dry_run,
        )
    )
