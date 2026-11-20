"""File d'analyse des pièces de l'agent d'information : prise, lectures liées et écritures sous le bail.

Sorti de ``information_agent_evidence`` (limite de taille des sources) : ce qui suit le contrat de la table
``information_agent_evidence_extractions`` et de sa RPC de prise (essais, bail, délai entre deux essais), et les
lectures de la pièce, de la vente et du dossier dont le worker a besoin.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx

from src.information_agent_semantic import SemanticLotContext, semantic_lot_context
from src.storage.postgrest_helpers import rest_headers

# Essais pris par ``claim_information_agent_evidence_extractions`` (elle ne reprend que ``attempts < 3``).
MAX_ATTEMPTS = 3


def claim_jobs(client: httpx.Client, base_url: str, key: str, limit: int) -> list[dict[str, Any]]:
    response = client.post(
        f"{base_url}/rest/v1/rpc/claim_information_agent_evidence_extractions",
        headers=rest_headers(key),
        json={"p_limit": limit},
    )
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, list) else []


def fetch_asset(client: httpx.Client, base_url: str, key: str, asset_id: str) -> dict[str, Any]:
    response = client.get(
        f"{base_url}/rest/v1/information_agent_evidence_assets",
        headers=rest_headers(key),
        params={
            "select": "id,case_id,message_id,sale_id,storage_bucket,storage_path,original_filename,mime_type,size_bytes,sha256,metadata",
            "id": f"eq.{asset_id}",
            "limit": "1",
        },
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Evidence asset not found")
    return rows[0]


def download_asset(client: httpx.Client, base_url: str, key: str, asset: dict[str, Any]) -> bytes:
    bucket = quote(str(asset.get("storage_bucket") or ""), safe="")
    path = quote(str(asset.get("storage_path") or ""), safe="/")
    response = client.get(f"{base_url}/storage/v1/object/{bucket}/{path}", headers=rest_headers(key))
    response.raise_for_status()
    content = response.content
    if len(content) != int(asset.get("size_bytes") or 0):
        raise RuntimeError("Evidence download size mismatch")
    expected_sha256 = str(asset.get("sha256") or "")
    if not expected_sha256 or hashlib.sha256(content).hexdigest() != expected_sha256:
        raise RuntimeError("Evidence download checksum mismatch")
    return content


def fetch_sale(client: httpx.Client, base_url: str, key: str, sale_id: str) -> dict[str, Any]:
    response = client.get(
        f"{base_url}/rest/v1/auction_sales",
        headers=rest_headers(key),
        params={
            "select": "surface_m2,app_surface_m2,land_surface_m2,rooms_count,occupancy_status,sale_date,starting_price_eur,property_type,address",
            "id": f"eq.{sale_id}",
            "limit": "1",
        },
    )
    response.raise_for_status()
    rows = response.json()
    return rows[0] if isinstance(rows, list) and rows else {}


def fetch_sale_lot_context(
    client: httpx.Client,
    base_url: str,
    key: str,
    sale_id: str,
) -> SemanticLotContext:
    """Lots de la vente, pour que la lecture sémantique contrôle le lot dont parle chaque phrase."""
    response = client.get(
        f"{base_url}/rest/v1/auction_sales",
        headers=rest_headers(key),
        params={
            "select": "quality_flags,source_lot_selection:raw_payload->source_lot_selection",
            "id": f"eq.{sale_id}",
            "limit": "1",
        },
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        raise RuntimeError("Information-agent sale not found")
    return semantic_lot_context(rows[0].get("quality_flags"), rows[0].get("source_lot_selection"))


def fetch_case_status(client: httpx.Client, base_url: str, key: str, case_id: str) -> str:
    if not case_id:
        return ""
    response = client.get(
        f"{base_url}/rest/v1/information_agent_cases",
        headers=rest_headers(key),
        params={"select": "status", "id": f"eq.{case_id}", "limit": "1"},
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Information-agent case not found")
    return str(rows[0].get("status") or "")


def retry_schedule(attempts: int, now: datetime, not_before: datetime | None = None) -> dict[str, object]:
    """Échéance du prochain essai d'un passage en échec ; terminé (``completed_at``) au dernier essai.

    ``not_before`` : fin du lot en cours, avant laquelle la pièce n'est pas reprise (un passage par pièce et par lot).
    """
    available_at = now + timedelta(minutes=min(30, 2**attempts))
    if not_before is not None:
        available_at = max(available_at, not_before)
    return {
        "available_at": available_at.isoformat(),
        "completed_at": now.isoformat() if attempts >= MAX_ATTEMPTS else None,
    }


def fail_job(
    client: httpx.Client,
    base_url: str,
    key: str,
    extraction_id: str,
    attempts: int,
    message: str,
    *,
    locked_at: str | None = None,
    not_before: datetime | None = None,
) -> None:
    now = datetime.now(UTC)
    payload: dict[str, object] = {
        "status": "failed",
        "error_code": "WORKER_ERROR",
        "error_message": message[:2000],
        "locked_at": None,
        **retry_schedule(attempts, now, not_before),
    }
    if attempts >= MAX_ATTEMPTS:
        # Échec définitif : le résumé d'une lecture en cours (« … seront proposées ») ne doit pas rester.
        payload["summary"] = (
            f"Analyse interrompue : erreur du traitement à chacun des {MAX_ATTEMPTS} essais. "
            "Aucune information proposée : vérification manuelle nécessaire."
        )
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_evidence_extractions",
        headers=rest_headers(key, prefer="return=minimal"),
        params=processing_lease_params(extraction_id, attempts=attempts, locked_at=locked_at),
        json=payload,
    )
    response.raise_for_status()


def processing_lease_params(
    extraction_id: str,
    *,
    attempts: int | None,
    locked_at: str | None,
) -> dict[str, str]:
    params = {
        "id": f"eq.{extraction_id}",
        "status": "eq.processing",
    }
    if attempts is not None:
        params["attempts"] = f"eq.{attempts}"
    if locked_at:
        params["locked_at"] = f"eq.{locked_at}"
    return params


def mark_case_for_review(client: httpx.Client, base_url: str, key: str, case_id: str) -> None:
    if not case_id:
        return
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_cases",
        headers=rest_headers(key, prefer="return=minimal"),
        params={"id": f"eq.{case_id}", "status": "in.(replied,review)"},
        json={"status": "review"},
    )
    response.raise_for_status()
