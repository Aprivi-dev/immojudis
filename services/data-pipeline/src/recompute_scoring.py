from __future__ import annotations

import argparse
import logging
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any

import httpx

from src.admission import catalogue_write_rejection, closes_expired_offer_deadline
from src.cadastre_references import resolve_sale_cadastre
from src.catalogue_readiness import apply_catalogue_readiness
from src.config import load_settings, require_encheres_publiques_access
from src.geocode import geocode_sale, restore_accepted_geocode, verify_source_coordinates
from src.insufficient_sales import drop_insufficient_sales
from src.sale_finalization import derive_sale_facts
from src.sale_procedure import SALE_PROCEDURE_SCHEMA_VERSION
from src.sources.common import PoliteHttpClient
from src.sources.encheres_publiques import (
    BASE_URL as ENCHERES_PUBLIQUES_BASE_URL,
)
from src.sources.encheres_publiques import (
    CANONICAL_BASE_URL as ENCHERES_PUBLIQUES_CANONICAL_BASE_URL,
)
from src.sources.encheres_publiques import (
    parse_encheres_publiques_detail_html,
)
from src.sources.licitor import LicitorClient, parse_licitor_detail_html
from src.storage.postgrest_helpers import postgrest_request_with_retries, rest_headers
from src.storage.supabase_client import upsert_sales_to_supabase
from src.stored_sales import fetch_sales, sale_from_storage_row

LOGGER = logging.getLogger(__name__)
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
PROCEDURE_REFRESH_SUPPORTED_SOURCES = {"licitor", "encheres_publiques"}
PROCEDURE_REFRESH_FIELDS = {
    "address",
    "city",
    "department",
    "description",
    "documents",
    "external_id",
    "habitable_surface_m2",
    "latitude",
    "lawyer_contact",
    "lawyer_name",
    "longitude",
    "postal_code",
    "property_type",
    "raw_image_url",
    "raw_text",
    "rooms_count",
    "sale_date",
    "source_images",
    "starting_price_eur",
    "surface_m2",
    "title",
    "tribunal",
    "visit_dates",
}


def recompute_scoring(
    *,
    source: str | None = None,
    limit: int | None = None,
    batch_size: int = 20,
    dry_run: bool = False,
    geocode_missing: bool = False,
    geocode_workers: int = 1,
) -> int:
    rows = fetch_sales(source=source, limit=limit)
    if not rows:
        LOGGER.error("No stored sales matched the requested recompute scope")
        return 1
    sales: list[Any] = []
    failures: list[str] = []
    if geocode_missing and geocode_workers > 1:
        with ThreadPoolExecutor(max_workers=geocode_workers, thread_name_prefix="catalogue-geocode") as executor:
            futures = [
                executor.submit(_recomputed_sale_from_storage_row, row, geocode=True)
                for row in rows
            ]
            for row, future in zip(rows, futures, strict=True):
                try:
                    sales.append(future.result())
                except Exception as exc:
                    failures.append(str(row.get("source_url") or row.get("id") or "unknown-row"))
                    LOGGER.exception("Scoring recompute failed for %s: %s", row.get("source_url"), exc)
    else:
        for row in rows:
            try:
                sale = _recomputed_sale_from_storage_row(row, geocode=geocode_missing)
                sales.append(sale)
            except Exception as exc:
                failures.append(str(row.get("source_url") or row.get("id") or "unknown-row"))
                LOGGER.exception("Scoring recompute failed for %s: %s", row.get("source_url"), exc)

    if dry_run:
        _print_summary(sales, dry_run=True, failures=failures)
        return 1 if failures else 0

    # La règle d'admission du catalogue n'écrit jamais une vente expirée ou sans mise à prix ni surface
    # (upsert_sales_to_supabase). Comptées comme attendues, ces ventes faisaient conclure chaque recalcul complet à un
    # échec (05/11/2026 : 1 369 écrites sur 1 501, environ 130 refusées par la règle à chaque passe).
    writable: list[Any] = []
    refused: Counter[str] = Counter()
    for sale in sales:
        reason = catalogue_write_rejection(sale)
        if reason is None or closes_expired_offer_deadline(sale):
            writable.append(sale)
        else:
            refused[reason] += 1
    if refused:
        LOGGER.info("Recompute leaves %s sales to the catalogue admission rule: %s", sum(refused.values()), dict(refused))
    upserted = 0
    for batch in _chunks(writable, max(1, batch_size)):
        upserted += _upsert_batch_with_lock_retry(batch)
    _print_summary(sales, dry_run=False, upserted=upserted, failures=failures)
    if failures or upserted != len(writable):
        LOGGER.error(
            "Incomplete scoring recompute: selected=%s computed=%s writable=%s upserted=%s failures=%s",
            len(rows),
            len(sales),
            len(writable),
            upserted,
            len(failures),
        )
        return 1
    return 0


def backfill_catalogue_readiness(
    *,
    source: str | None = None,
    limit: int | None = None,
    batch_size: int = 100,
    dry_run: bool = False,
) -> int:
    """Score every active unassessed row, including rows rejected by publication admission."""

    rows = fetch_sales(
        source=source,
        limit=limit,
        readiness_unassessed_only=True,
    )
    updates: list[dict[str, Any]] = []
    statuses: Counter[str] = Counter()
    for row in rows:
        sale = sale_from_storage_row(row)
        result = apply_catalogue_readiness(sale)
        statuses[result.status] += 1
        updates.append(
            {
                "id": row["id"],
                "observed_updated_at": row.get("updated_at"),
                "values": {
                    "premium_readiness_score": result.score,
                    "premium_readiness_status": result.status,
                    "premium_readiness_policy_version": result.policy_version,
                    "premium_readiness_factors": result.factors,
                    "premium_readiness_blockers": result.blockers,
                    "premium_readiness_missing_fields": result.missing_fields,
                    "premium_readiness_evaluated_at": sale.premium_readiness_evaluated_at.isoformat(),
                },
            }
        )

    print("Catalogue readiness backfill")
    print(f"- mode: {'dry-run' if dry_run else 'patch'}")
    print(f"- sales: {len(updates)}")
    print(f"- statuses: {dict(statuses)}")
    if dry_run or not updates:
        return 0

    settings = load_settings()
    supabase_url = str(settings["supabase_url"] or "").rstrip("/")
    api_key = str(settings["supabase_service_role_key"] or "")
    if not supabase_url or not api_key:
        raise RuntimeError("Supabase URL/service role key are missing")
    endpoint = f"{supabase_url}/rest/v1/auction_sales"
    headers = rest_headers(api_key, prefer="return=minimal")
    for batch in _chunks(updates, max(1, batch_size)):
        for update in batch:
            params = {"id": f"eq.{update['id']}"}
            if update["observed_updated_at"]:
                params["updated_at"] = f"eq.{update['observed_updated_at']}"
            response = postgrest_request_with_retries(
                "PATCH",
                endpoint,
                table="auction_sales",
                params=params,
                headers=headers,
                json=update["values"],
                timeout=120,
            )
            if response.is_error:
                raise httpx.HTTPStatusError(
                    f"{response.status_code} readiness backfill response: {response.text}",
                    request=response.request,
                    response=response,
                )
    return 0


def verify_persisted_sale_procedures(
    *,
    source: str | None = None,
    limit: int | None = None,
) -> int:
    """Fail closed when a persisted procedure payload is missing or inconsistent."""

    rows = fetch_sales(source=source, limit=limit)
    if not rows:
        LOGGER.error("No stored sales matched the requested verification scope")
        return 1

    invalid: list[tuple[str, list[str]]] = []
    statuses: Counter[str] = Counter()
    venues: Counter[str] = Counter()
    for row in rows:
        statuses[str(row.get("sale_verification_status") or "missing")] += 1
        venues[str(row.get("sale_venue_type") or "missing")] += 1
        try:
            expected_sale = _recomputed_sale_from_storage_row(row)
            issues = _validate_persisted_sale_procedure(row, expected_sale=expected_sale)
        except Exception as exc:
            LOGGER.exception("Persisted procedure verification failed for %s: %s", row.get("source_url"), exc)
            issues = ["procedure recompute failed"]
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


def repair_invalid_sale_procedures(
    *,
    source: str | None = None,
    limit: int | None = None,
) -> int:
    """Retry inconsistent catalogue rows individually, then let verification re-read them."""

    rows = fetch_sales(source=source, limit=limit)
    if not rows:
        LOGGER.error("No stored sales matched the requested repair scope")
        return 1

    repairs = []
    failures: list[str] = []
    for row in rows:
        identifier = str(row.get("source_url") or row.get("id") or "unknown-row")
        try:
            expected_sale = _recomputed_sale_from_storage_row(row)
            if _validate_persisted_sale_procedure(row, expected_sale=expected_sale):
                repairs.append(expected_sale)
        except Exception as exc:
            failures.append(identifier)
            LOGGER.exception("Procedure repair preparation failed for %s: %s", identifier, exc)

    repaired = 0
    for sale in repairs:
        try:
            repaired += upsert_sales_to_supabase([sale], refresh_last_seen=False)
        except Exception as exc:
            failures.append(sale.source_url)
            LOGGER.exception("Individual procedure repair failed for %s: %s", sale.source_url, exc)

    print("Sale procedure repair summary")
    print(f"- candidates: {len(repairs)}")
    print(f"- repaired: {repaired}")
    print(f"- failures: {len(failures)}")
    return 1 if failures or repaired != len(repairs) else 0


def refresh_unknown_sale_procedures(
    *,
    source: str | None = None,
    limit: int | None = None,
) -> int:
    """Re-fetch public source pages for unresolved procedures, then verify them again."""

    if source == "encheres_publiques":
        # The refresh command can reach the detail client without going through
        # the normal source collector.  Keep its explicit mode behind the same
        # two-switch gate before it even reads the catalogue.
        require_encheres_publiques_access(load_settings())
    rows = fetch_sales(source=source, limit=limit)
    candidates = [
        row
        for row in rows
        if row.get("sale_venue_type") == "unknown"
        and row.get("source_name") in PROCEDURE_REFRESH_SUPPORTED_SOURCES
    ]
    if any(row.get("source_name") == "encheres_publiques" for row in candidates):
        # ``all`` is allowed to inspect the catalogue, but it cannot create a
        # client or issue an EP detail request until the source is authorized.
        require_encheres_publiques_access(load_settings())
    if not candidates:
        print("Unknown sale procedure source refresh")
        print("- candidates: 0")
        print("- refreshed: 0")
        print("- unresolved: 0")
        print("- failures: 0")
        return 0

    clients = _procedure_refresh_clients()
    refreshed_sales: list[Any] = []
    failures: list[str] = []
    for row in candidates:
        identifier = str(row.get("source_url") or row.get("id") or "unknown-row")
        try:
            details = _fetch_procedure_source_details(row, clients)
            if not details:
                raise RuntimeError("the refreshed source page returned no structured sale details")
            refreshed_row = _merge_refetched_source_details(row, details)
            refreshed_sales.append(_recomputed_sale_from_storage_row(refreshed_row, geocode=True))
        except Exception as exc:
            failures.append(identifier)
            LOGGER.exception("Procedure source refresh failed for %s: %s", identifier, exc)

    upserted = 0
    for sale in refreshed_sales:
        try:
            upserted += upsert_sales_to_supabase([sale], refresh_last_seen=False)
        except Exception as exc:
            failures.append(sale.source_url)
            LOGGER.exception("Refreshed procedure upsert failed for %s: %s", sale.source_url, exc)

    unresolved = sum(sale.sale_venue_type == "unknown" for sale in refreshed_sales)
    print("Unknown sale procedure source refresh")
    print(f"- candidates: {len(candidates)}")
    print(f"- refreshed: {upserted}")
    print(f"- unresolved: {unresolved}")
    print(f"- failures: {len(failures)}")
    return 1 if failures or upserted != len(refreshed_sales) else 0


def _procedure_refresh_clients() -> dict[str, Any]:
    settings = load_settings()
    common = {
        "user_agent": str(settings["user_agent"]),
        "delay_seconds": float(settings["request_delay_seconds"]),
        "timeout_seconds": float(settings["request_timeout_seconds"]),
    }
    return {
        "licitor": LicitorClient(**common),
        "encheres_publiques": PoliteHttpClient(
            base_url=ENCHERES_PUBLIQUES_BASE_URL,
            allowed_redirect_origins=(ENCHERES_PUBLIQUES_CANONICAL_BASE_URL,),
            **common,
        ),
    }


def _fetch_procedure_source_details(
    row: dict[str, Any],
    clients: dict[str, Any],
) -> dict[str, Any]:
    source_name = str(row.get("source_name") or "")
    source_url = str(row.get("source_url") or "")
    client = clients.get(source_name)
    if client is None or not source_url:
        return {}

    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            html = client.get(source_url)
            if source_name == "licitor":
                return parse_licitor_detail_html(html, source_url)
            if source_name == "encheres_publiques":
                return parse_encheres_publiques_detail_html(html, source_url)
            return {}
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                LOGGER.warning(
                    "Procedure source refresh attempt %s/3 failed for %s: %s",
                    attempt,
                    source_url,
                    exc,
                )
                time.sleep(2 * attempt)
    if last_error is not None:
        raise last_error
    return {}


def _merge_refetched_source_details(
    row: dict[str, Any],
    details: dict[str, Any],
) -> dict[str, Any]:
    merged_row = dict(row)
    original_payload = dict(row.get("raw_payload")) if isinstance(row.get("raw_payload"), dict) else {}
    merged_payload = {**original_payload}

    for key in PROCEDURE_REFRESH_FIELDS:
        value = details.get(key)
        if value in (None, "", []):
            continue
        merged_row[key] = value
        merged_payload[key] = value

    existing_blocks = (
        original_payload.get("source_blocks")
        if isinstance(original_payload.get("source_blocks"), dict)
        else {}
    )
    refreshed_blocks = details.get("source_blocks") if isinstance(details.get("source_blocks"), dict) else {}
    if existing_blocks or refreshed_blocks:
        merged_payload["source_blocks"] = {**existing_blocks, **refreshed_blocks}

    merged_payload["procedure_source_refresh"] = {
        "schema_version": "procedure_source_refresh_v1",
        "source_name": row.get("source_name"),
        "source_url": row.get("source_url"),
        "fetched_at": datetime.now(UTC).isoformat(),
        "status": "verified_source_page",
    }
    merged_row["raw_payload"] = merged_payload
    return merged_row


def _validate_persisted_sale_procedure(
    row: dict[str, Any],
    *,
    expected_sale: Any | None = None,
) -> list[str]:
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
    if expected_sale is not None:
        if venue_type != expected_sale.sale_venue_type:
            issues.append("venue_type differs from recompute")
        if legal_framework != expected_sale.sale_legal_framework:
            issues.append("legal_framework differs from recompute")
        if verification_status != expected_sale.sale_verification_status:
            issues.append("verification status differs from recompute")
        expected_procedure = expected_sale.sale_procedure
        for key in ("ruleset_version", "participation_mode", "state_sale_method", "rules"):
            if procedure.get(key) != expected_procedure.get(key):
                issues.append(f"{key} differs from recompute")
    return issues


def _recomputed_sale_from_storage_row(row: dict[str, Any], *, geocode: bool = False):
    sale = sale_from_storage_row(row)
    if geocode:
        geocode_sale(sale)
    else:
        # Reprend la localisation cadastrale déjà résolue, sans requête.
        resolve_sale_cadastre(sale, network=False)
        # Et le géocodage déjà accepté (centre de commune compris) qui n'avait pas été recopié.
        restore_accepted_geocode(sale)
        # Les coordonnées de la source n'ont jamais été vérifiées : contrôle de cohérence, sans réseau.
        verify_source_coordinates(sale)
    # Le reste de la collecte (``finalize_sale_for_app``) n'est pas refait : la description de la source et
    # l'échéance lue sur la page restent celles de la ligne stockée, l'image n'est pas revérifiée (requête réseau)
    # et la préparation au catalogue se refait à l'écriture (``upsert_sales_to_supabase``).
    derive_sale_facts(sale)
    return sale


# Le recalcul écrit pendant que la collecte et le rattrapage des pièces publient aussi : un lot peut attendre plus
# que les 15 s du verrou de publication. La transaction du lot est alors annulée en entier (rien n'est écrit) et le
# lot est réessayé ; sans cela, le recalcul du 03/11/2026 s'est arrêté après 8 lots sur 75.
LOCK_RETRY_DELAYS_SECONDS = (20.0, 60.0, 120.0)
_TRANSIENT_LOCK_ERRORS = frozenset({"LockNotAvailable", "DeadlockDetected", "SerializationFailure"})


def _upsert_batch_with_lock_retry(batch: list[Any], *, sleep=time.sleep) -> int:
    for delay in (*LOCK_RETRY_DELAYS_SECONDS, None):
        try:
            return upsert_sales_to_supabase(batch, refresh_last_seen=False)
        except Exception as exc:
            if delay is None or type(exc).__name__ not in _TRANSIENT_LOCK_ERRORS:
                raise
            LOGGER.warning(
                "Recompute batch waited too long for a catalogue lock (%s); retrying in %.0f s",
                type(exc).__name__,
                delay,
            )
            sleep(delay)
    return 0


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
    geocode_verified = 0
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
        geocode = sale.raw_payload.get("geocode")
        if (
            isinstance(geocode, dict)
            and geocode.get("provider") == "ban_geoplateforme"
            and geocode.get("accepted") is True
            and geocode.get("citycode")
        ):
            geocode_verified += 1
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
    print(f"- ban_geoplateforme_verified: {geocode_verified}")
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
        "--geocode-missing",
        action="store_true",
        help="Valide les adresses historiques avec BAN/GéoPlateforme avant le rattachement au tribunal.",
    )
    parser.add_argument(
        "--geocode-workers",
        type=int,
        default=1,
        choices=range(1, 9),
        metavar="1..8",
        help="Nombre borné de validations d'adresse simultanées.",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Vérifie les procédures persistées sans les recalculer ni les modifier.",
    )
    parser.add_argument(
        "--repair-invalid-procedures",
        action="store_true",
        help="Recalcule et réécrit individuellement les procédures persistées incohérentes.",
    )
    parser.add_argument(
        "--refresh-unknown-procedures",
        action="store_true",
        help="Relit les pages sources publiques des procédures encore indéterminées.",
    )
    parser.add_argument(
        "--readiness-unassessed-only",
        action="store_true",
        help="Backfill borné des seules annonces actives encore non évaluées pour le catalogue Premium.",
    )
    parser.add_argument(
        "--drop-insufficient",
        action="store_true",
        help="Rapport (dry-run) des ventes aux informations insuffisantes ; ne supprime rien sans --execute-drop.",
    )
    parser.add_argument(
        "--execute-drop",
        action="store_true",
        help="Avec --drop-insufficient : supprime par app_private.delete_empty_listings (tout le catalogue).",
    )
    parser.add_argument("--max-deletions", type=int, default=100, help="Plafond de suppressions d'une exécution.")
    parser.add_argument("--drop-report", default="insufficient-sales-report.json", help="Fichier JSON des identifiants.")
    args = parser.parse_args()
    if args.execute_drop and not args.drop_insufficient:
        parser.error("--execute-drop n'a de sens qu'avec --drop-insufficient")
    return args


def _writes_catalogue(args: argparse.Namespace) -> bool:
    if args.drop_insufficient:
        return args.execute_drop
    if args.verify_only:
        return False
    # Refreshing or repairing procedures always writes; the other modes only
    # write when they are not a dry run.
    return args.refresh_unknown_procedures or args.repair_invalid_procedures or not args.dry_run


def main() -> int:
    args = parse_args()
    if not _writes_catalogue(args):
        return _run(args)
    from src.catalogue_lock import catalogue_writer_lock

    with catalogue_writer_lock(label="recompute"):
        return _run(args)


def _run(args: argparse.Namespace) -> int:
    if args.drop_insufficient:
        return drop_insufficient_sales(
            source=args.source,
            limit=args.limit,
            execute=args.execute_drop,
            max_deletions=args.max_deletions,
            report_path=args.drop_report,
        )
    if args.refresh_unknown_procedures:
        return refresh_unknown_sale_procedures(source=args.source, limit=args.limit)
    if args.repair_invalid_procedures:
        return repair_invalid_sale_procedures(source=args.source, limit=args.limit)
    if args.verify_only:
        return verify_persisted_sale_procedures(source=args.source, limit=args.limit)
    if args.readiness_unassessed_only:
        return backfill_catalogue_readiness(
            source=args.source,
            limit=args.limit,
            batch_size=args.batch_size,
            dry_run=args.dry_run,
        )
    return recompute_scoring(
        source=args.source,
        limit=args.limit,
        batch_size=args.batch_size,
        dry_run=args.dry_run,
        geocode_missing=args.geocode_missing,
        geocode_workers=args.geocode_workers,
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    raise SystemExit(main())
