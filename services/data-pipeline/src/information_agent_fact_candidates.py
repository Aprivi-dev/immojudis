"""Candidats d'information de l'agent tirés d'une pièce analysée par le worker.

Sorti de ``information_agent_evidence`` (limite de taille des sources) : choix des faits assez nets pour
devenir des candidats, écriture des candidats avec leurs motifs de relecture, et complément d'une ligne déjà
écrite par les règles TypeScript du corps du message quand la lecture par l'IA trouve la même valeur
(motifs fusionnés, ``semantic_agreement``). Les faits sont des ``EvidenceFact`` du worker.
"""

from __future__ import annotations

import json
import math
import re
from typing import TYPE_CHECKING, Any

import httpx

from src.information_agent_semantic import UNCERTAIN_EVIDENCE_RE
from src.normalize import clean_text

if TYPE_CHECKING:
    from src.information_agent_evidence import EvidenceFact

PROCESSOR_VERSION = "evidence_v1"
MIN_FACT_CANDIDATE_CONFIDENCE = 0.5
_UNCERTAIN_FACT_VALUE_RE = re.compile(
    r"\b(?:non\s+(?:communiqu(?:e|ée)|pr[eé]cis(?:e|ée)|renseign(?:e|ée)|disponible)|"
    r"(?:a|à)\s+confirmer|inconnu(?:e)?|ind[eé]termin(?:e|ée)|"
    r"sans\s+information|n/?a|nc)\b",
    re.IGNORECASE,
)


def rest_headers(key: str) -> dict[str, str]:
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def fetch_existing_message_fact_values(
    client: httpx.Client,
    base_url: str,
    key: str,
    message_id: str,
) -> dict[tuple[str, str], dict[str, Any]]:
    """Return body-level facts already persisted by the inbound worker.

    Inbound text facts intentionally have no ``evidence_asset_id``. The
    evidence worker subsequently processes the same body as a private text
    asset, so it must not create a second candidate with attachment
    provenance for the identical value. A failed read is allowed to abort the
    extraction job; inserting a duplicate would be harder to repair and
    would make replay behavior depend on request ordering.

    The rows are returned so that a semantic reading of the same value completes the existing row
    (review reasons, agreement marker) instead of being dropped with its review reasons.
    """
    if not message_id:
        return {}
    response = client.get(
        f"{base_url}/rest/v1/information_agent_fact_candidates",
        headers=rest_headers(key),
        params={
            "select": "id,fact_key,proposed_value,evidence_asset_id,metadata",
            "message_id": f"eq.{message_id}",
            "evidence_asset_id": "is.null",
            "limit": "1000",
        },
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list):
        raise RuntimeError("Invalid existing information-agent facts response")
    values: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("evidence_asset_id") is not None:
            continue
        fact_key = str(row.get("fact_key") or "").strip()
        proposed_value = row.get("proposed_value")
        if not fact_key:
            continue
        if isinstance(proposed_value, dict):
            proposed_value = proposed_value.get("value")
        values[(fact_key, _fact_value_key(proposed_value))] = row
    return values


def insert_fact_candidates(
    client: httpx.Client,
    base_url: str,
    key: str,
    job: dict[str, Any],
    facts: list[EvidenceFact],
    sale: dict[str, Any],
    *,
    skip_values: dict[tuple[str, str], dict[str, Any]] | None = None,
) -> None:
    payload = []
    for fact in candidate_facts_for_insertion(facts):
        existing = skip_values.get((fact.fact_key, _fact_value_key(fact.value))) if skip_values else None
        if existing is not None:
            # Valeur déjà proposée par les règles du corps du message : la lecture par l'IA complète cette
            # ligne (motifs, accord) au lieu de disparaître avec ses motifs.
            if _is_semantic(fact):
                _complete_rules_candidate(client, base_url, key, existing, fact)
            continue
        item = fact.as_json()
        payload.append(
            {
                "case_id": job["case_id"],
                "message_id": job["message_id"],
                "sale_id": job["sale_id"],
                "evidence_asset_id": job["asset_id"],
                "fact_key": fact.fact_key,
                "proposed_value": item["proposed_value"],
                "display_value": fact.display_value[:500],
                "evidence_excerpt": fact.evidence_excerpt[:2000],
                "confidence": fact.confidence,
                "extraction_method": fact.extraction_method,
                "source_page": fact.source_page,
                "source_locator": f"page:{fact.source_page}",
                "status": "conflict" if conflicts_with_sale(fact, sale) else "pending",
                "metadata": {
                    "processor_version": PROCESSOR_VERSION,
                    "content_trust": "untrusted_external_evidence",
                    # Fait douteux gardé pour la relecture : jamais un fait net (motif affiché à l'administrateur).
                    **({"review_reasons": list(reasons)} if (reasons := _candidate_review_reasons(fact)) else {}),
                },
            }
        )
    if not payload:
        return
    response = client.post(
        f"{base_url}/rest/v1/information_agent_fact_candidates",
        headers={**rest_headers(key), "Prefer": "resolution=ignore-duplicates,return=minimal"},
        params={"on_conflict": "message_id,fact_key,evidence_asset_id,source_page,display_value"},
        content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    response.raise_for_status()


def _is_semantic(fact: EvidenceFact) -> bool:
    return fact.extraction_method.startswith("semantic")


def _candidate_review_reasons(fact: EvidenceFact) -> tuple[str, ...]:
    """Motifs du candidat : ceux de la lecture, plus `rules_only_attachment` pour un fait lu par les règles
    Python seules (pièce jointe ou corps relu par le worker) : jamais un fait net sans l'IA."""
    if _is_semantic(fact):
        return fact.review_reasons
    return tuple(dict.fromkeys([*fact.review_reasons, "rules_only_attachment"]))


def _complete_rules_candidate(
    client: httpx.Client,
    base_url: str,
    key: str,
    existing: dict[str, Any],
    fact: EvidenceFact,
) -> None:
    """Fusionne les motifs de la lecture par l'IA dans la ligne des règles, et marque l'accord sans motif."""
    candidate_id = str(existing.get("id") or "")
    if not candidate_id:
        return
    metadata = existing.get("metadata") if isinstance(existing.get("metadata"), dict) else {}
    previous = metadata.get("review_reasons") if isinstance(metadata.get("review_reasons"), list) else []
    reasons = list(dict.fromkeys([*(str(reason) for reason in previous), *fact.review_reasons]))
    updated = {
        **metadata,
        "semantic_extraction_method": fact.extraction_method,
        "semantic_agreement": not fact.review_reasons,
        **({"review_reasons": reasons} if reasons else {}),
    }
    if updated == metadata:
        return
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_fact_candidates",
        headers={**rest_headers(key), "Prefer": "return=minimal"},
        params={"id": f"eq.{candidate_id}", "status": "in.(pending,conflict)"},
        content=json.dumps({"metadata": updated}, ensure_ascii=False).encode("utf-8"),
    )
    response.raise_for_status()


def candidate_facts_for_insertion(facts: list[EvidenceFact]) -> list[EvidenceFact]:
    """Keep only facts that are sufficiently clear to become review rows.

    The extraction record retains every grounded observation for auditability,
    but a candidate must not silently select one of two values found in the
    same reply. Unknown/placeholder values and low-confidence semantic
    proposals are likewise retained only in the extraction evidence. This
    keeps the admin queue from presenting an arbitrary answer as the proposed
    value while preserving the original text for human review.
    """
    values_by_key: dict[str, set[str]] = {}
    for fact in facts:
        values_by_key.setdefault(fact.fact_key, set()).add(_fact_value_key(fact.value))
    ambiguous_keys = {fact_key for fact_key, values in values_by_key.items() if len(values) > 1}
    return [
        fact
        for fact in facts
        if fact.fact_key not in ambiguous_keys
        and fact.confidence >= MIN_FACT_CANDIDATE_CONFIDENCE
        and not _uncertain_fact_value(fact.value)
        and not _uncertain_evidence_excerpt(fact.evidence_excerpt)
    ]


def _uncertain_fact_value(value: object) -> bool:
    if not isinstance(value, str):
        return False
    normalized = clean_text(value) or ""
    return bool(_UNCERTAIN_FACT_VALUE_RE.search(normalized))


def _uncertain_evidence_excerpt(value: object) -> bool:
    if not isinstance(value, str):
        return False
    return UNCERTAIN_EVIDENCE_RE.search(value) is not None


def _fact_value_key(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return f"{float(value):.12g}"
    return (clean_text(value) or str(value or "")).strip().casefold()


def conflicts_with_sale(fact: EvidenceFact, sale: dict[str, Any]) -> bool:
    if fact.fact_key == "surface_m2":
        existing = sale.get("app_surface_m2")
        if existing is None:
            existing = sale.get("surface_m2")
    else:
        existing = sale.get(fact.fact_key)
    if existing is None or fact.fact_key in {"visit_information", "energy_diagnostics"}:
        return False
    if isinstance(existing, (int, float)) and isinstance(fact.value, (int, float)):
        tolerance = 0.5 if fact.fact_key in {"surface_m2", "land_surface_m2"} else 0.01
        return abs(float(existing) - float(fact.value)) > tolerance
    if fact.fact_key == "sale_date":
        return str(existing)[:10] != str(fact.value)[:10]
    if fact.fact_key == "property_type":
        return str(existing).strip().casefold() != str(fact.value).strip().casefold()
    if fact.fact_key == "address":
        return _normalize_comparable_text(existing) != _normalize_comparable_text(fact.value)
    return str(existing).strip().lower() != str(fact.value).strip().lower()


def _normalize_comparable_text(value: object) -> str:
    text = clean_text(value) or ""
    return " ".join(text.casefold().split())
