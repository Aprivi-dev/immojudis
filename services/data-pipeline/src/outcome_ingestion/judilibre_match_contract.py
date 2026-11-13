"""Contrat d'un candidat de rapprochement Judilibre : ce que le rapprochement propose et que le dépôt revérifie.

``judilibre_matching`` construit les signaux d'un candidat ; ``repository.append_judilibre_match_candidate`` les
valide, recalcule dans sa transaction les empreintes, le score et la méthode, et refuse tout écart. Les deux lisent
ce module : une version, une clé ou une règle qui change ici change des deux côtés. Module feuille, comme
``judilibre_contract`` : le dépôt ne peut pas lire le rapprochement, qui l'importe.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import date

from src.official_sources.base import canonical_sha256
from src.sha256_digest import is_lowercase_sha256

_SIGNAL_SCHEMA = "judilibre_match_signals_v1"
_RULE_VERSION = "judilibre-review-match-v1"
JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX = 30
# Façons de résoudre la cour de la décision, que le dépôt attribue et qu'un candidat déclare.
JUDILIBRE_COURT_CODE_EXACT = "outcome_court_code_exact"
JUDILIBRE_JUSTICE_STRUCTURE_EXACT_NAME = "justice_structure_insee_exact_name"
# Méthodes que ``judilibre_match_score_and_method`` peut attribuer.
JUDILIBRE_MATCH_METHODS = frozenset({"exact_portalis_number", "exact_case_number", "composite"})

# Ce que tout candidat garantit (vrai) et s'interdit (faux), quel que soit le contexte rapproché.
_FIXED_SIGNALS: Mapping[str, bool] = {
    "court": True,
    "hearing_date": True,
    "source_record_version_current_at_scan": True,
    "selection_requires_human_review": True,
    "source_training_eligible": False,
    "automatic_link_allowed": False,
    "outcome_creation_allowed": False,
    "training_eligible": False,
    "claim_value_used_for_matching": False,
    "price_used_for_matching": False,
    "text_used_for_matching": False,
    "address_used_for_matching": False,
    "personal_identity_used_for_matching": False,
}
_COURT_RESOLUTION_METHODS = frozenset({JUDILIBRE_COURT_CODE_EXACT, JUDILIBRE_JUSTICE_STRUCTURE_EXACT_NAME})
_CLAIM_TYPES = frozenset({"starting_price_eur", "hammer_price_eur", "procedural_event"})
_PROVENANCE_DIGEST_KEYS = (
    "court_resolution_reference_sha256",
    "claims_manifest_sha256",
    "case_reference_manifest_sha256",
    "source_projection_sha256",
    "target_context_sha256",
    "source_record_sha256",
)


def normalize_judilibre_case_reference(value: object) -> str | None:
    """Numéro d'affaire comparable : espaces réduits, minuscules ; ``None`` s'il est vide, trop long ou multiligne.

    Le SQL du dépôt (``load_judilibre_auction_match_contexts`` et le classement objectif) normalise les numéros des
    affaires de la même façon.
    """
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"\s+", " ", value.strip()).lower()
    if not normalized or len(normalized) > 128 or any(
        character in normalized for character in ("\x00", "\r", "\n")
    ):
        return None
    return normalized


def judilibre_case_references(data: Mapping[str, object]) -> tuple[str, ...]:
    """Numéros d'affaire de la projection (``number`` puis ``numbers``), normalisés, sans doublon."""
    number = data.get("number")
    numbers = data.get("numbers")
    if number is not None and not isinstance(number, str):
        raise ValueError("Judilibre number has an invalid type")
    if numbers is not None and not isinstance(numbers, list):
        raise ValueError("Judilibre numbers has an invalid type")
    if isinstance(numbers, list) and any(not isinstance(value, str) for value in numbers):
        raise ValueError("Judilibre numbers contains a non-text value")
    references: list[str] = []
    for value in [number, *(numbers or [])]:
        normalized = normalize_judilibre_case_reference(value)
        if normalized is not None and normalized not in references:
            references.append(normalized)
    return tuple(references)


def judilibre_claims_manifest_sha256(claims: object) -> str:
    return canonical_sha256({"schema_version": "judilibre_claim_manifest_v1", "claims": claims})


def judilibre_case_reference_manifest_sha256(references: tuple[str, ...]) -> str:
    return canonical_sha256(
        {"schema_version": "judilibre_case_reference_manifest_v1", "references": references}
    )


def judilibre_target_context_sha256(
    *,
    case_id: str,
    lot_id: str,
    round_id: str,
    court_id: str,
    scheduled_date: date,
) -> str:
    return canonical_sha256(
        {
            "schema_version": "judilibre_target_context_v1",
            "case_id": case_id,
            "lot_id": lot_id,
            "round_id": round_id,
            "court_id": court_id,
            "scheduled_date": scheduled_date,
        }
    )


def judilibre_source_record_sha256(source_record_id: str) -> str:
    return canonical_sha256(
        {
            "schema_version": "judilibre_source_record_reference_v1",
            "source_record_id": source_record_id,
        }
    )


def judilibre_match_score_and_method(
    *,
    portalis_number_match: bool,
    case_number_match: bool,
    date_delta_days: int,
) -> tuple[str, str]:
    """Score (texte à quatre décimales) et méthode : Portalis, puis numéro d'affaire, puis cour et date seules."""
    exact_date = date_delta_days == 0
    if portalis_number_match:
        return ("0.9800" if exact_date else "0.9400"), "exact_portalis_number"
    if case_number_match:
        return ("0.9500" if exact_date else "0.9000"), "exact_case_number"
    return "0.7500", "composite"


def judilibre_match_signals(
    *,
    court_resolution_method: str,
    court_resolution_reference_sha256: str,
    date_delta_days: int,
    case_number_match: bool,
    portalis_number_match: bool,
    claim_types: list[str],
    claims_manifest_sha256: str,
    case_reference_manifest_sha256: str,
    source_projection_sha256: str,
    target_context_sha256: str,
    source_record_sha256: str,
) -> dict[str, object]:
    return {
        "schema_version": _SIGNAL_SCHEMA,
        "match_rule_version": _RULE_VERSION,
        "court_resolution_method": court_resolution_method,
        "court_resolution_reference_sha256": court_resolution_reference_sha256,
        "hearing_date_exact": date_delta_days == 0,
        "hearing_date_delta_days": date_delta_days,
        "case_number": case_number_match,
        "portalis_number": portalis_number_match,
        "claim_types": claim_types,
        "claims_manifest_sha256": claims_manifest_sha256,
        "case_reference_manifest_sha256": case_reference_manifest_sha256,
        "source_projection_sha256": source_projection_sha256,
        "target_context_sha256": target_context_sha256,
        "source_record_sha256": source_record_sha256,
        **_FIXED_SIGNALS,
    }


# Les clés exigées par le validateur sont celles que produit le constructeur, et non une seconde liste à tenir.
_SIGNAL_KEYS = frozenset(
    judilibre_match_signals(
        court_resolution_method="",
        court_resolution_reference_sha256="",
        date_delta_days=0,
        case_number_match=False,
        portalis_number_match=False,
        claim_types=[],
        claims_manifest_sha256="",
        case_reference_manifest_sha256="",
        source_projection_sha256="",
        target_context_sha256="",
        source_record_sha256="",
    )
)


def validate_judilibre_match_signals(
    signals: Mapping[str, object],
    *,
    expected_source_content_hash: str,
    match_method: str,
) -> None:
    """Refuse des signaux qui ne suivent pas ce contrat, avant toute lecture de la base."""
    if set(signals) != _SIGNAL_KEYS:
        raise ValueError("Judilibre match signals do not match the reviewed schema")
    if signals.get("schema_version") != _SIGNAL_SCHEMA:
        raise ValueError("Judilibre match signal schema is unsupported")
    if signals.get("match_rule_version") != _RULE_VERSION:
        raise ValueError("Judilibre match rule version is unsupported")
    if signals.get("court_resolution_method") not in _COURT_RESOLUTION_METHODS:
        raise ValueError("Judilibre court resolution is not objective")
    if any(signals.get(key) is not value for key, value in _FIXED_SIGNALS.items()):
        raise ValueError("Judilibre match safety flags are invalid")
    for key in ("hearing_date_exact", "case_number", "portalis_number"):
        if type(signals.get(key)) is not bool:
            raise ValueError("Judilibre objective signal flags must be booleans")
    date_delta = signals.get("hearing_date_delta_days")
    if type(date_delta) is not int or not 0 <= date_delta <= JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX:
        raise ValueError("Judilibre hearing date delta is invalid")
    claim_types = signals.get("claim_types")
    if (
        not isinstance(claim_types, list)
        or not claim_types
        or len(claim_types) != len(set(claim_types))
        or any(claim_type not in _CLAIM_TYPES for claim_type in claim_types)
    ):
        raise ValueError("Judilibre claim types are invalid")
    for key in _PROVENANCE_DIGEST_KEYS:
        if not is_lowercase_sha256(signals.get(key)):
            raise ValueError("Judilibre match provenance must contain SHA-256 only")
    if signals.get("source_projection_sha256") != expected_source_content_hash:
        raise ValueError("Judilibre source projection provenance is inconsistent")
    if match_method == "exact_portalis_number" and signals.get("portalis_number") is not True:
        raise ValueError("Judilibre Portalis match method lacks its exact signal")
    if match_method == "exact_case_number" and signals.get("case_number") is not True:
        raise ValueError("Judilibre case-number match method lacks its exact signal")
    if match_method == "composite" and not (
        signals.get("hearing_date_exact") is True
        and signals.get("case_number") is False
        and signals.get("portalis_number") is False
    ):
        raise ValueError("Judilibre composite match must be a unique exact court/date candidate")
