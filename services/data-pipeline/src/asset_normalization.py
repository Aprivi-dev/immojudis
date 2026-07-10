from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from src.config import ROOT_DIR
from src.models import AuctionSale
from src.normalize import SURFACE_VALUE_PATTERN, clean_text, parse_surface


@dataclass
class ScoreComponent:
    name: str
    points: Decimal
    reason: str
    confidence: Decimal = Decimal("0.7")
    evidence: str | None = None
    raw_value: object | None = None
    criterion: str | None = None
    calculation: str | None = None
    interpretation: str | None = None
    limits: str | None = None
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)
    axis: str | None = None
    question: str | None = None


RISK_DETECTOR_VERSION = "risk_context_v3"
BUSINESS_RULE_VERSION = "business_rules_v1"
PREMIUM_ANALYSIS_VERSION = "premium_due_diligence_v1"

AXIS_DEFINITIONS: dict[str, dict[str, object]] = {
    "financial_attractiveness": {
        "label": "Attractivité financière",
        "question": "Le prix de départ laisse-t-il une marge de sécurité exploitable ?",
        "factor_keys": ("prix_m2", "surface"),
    },
    "asset_quality": {
        "label": "Qualité du bien",
        "question": "L'état, les diagnostics et les caractéristiques rendent-ils le bien exploitable ?",
        "factor_keys": ("état", "atouts", "risques"),
    },
    "legal_security": {
        "label": "Sécurité juridique",
        "question": "L'occupation, les servitudes et les contraintes juridiques sont-elles maîtrisées ?",
        "factor_keys": ("occupation", "risques"),
    },
    "liquidity_resale": {
        "label": "Liquidité / revente",
        "question": "Le type de bien et sa localisation facilitent-ils la sortie ?",
        "factor_keys": ("type", "localisation"),
    },
    "analysis_confidence": {
        "label": "Confiance de l'analyse",
        "question": "Les données et preuves sont-elles suffisantes pour utiliser le score ?",
        "factor_keys": ("qualité",),
    },
}

FACTOR_AXIS = {
    "prix_m2": "financial_attractiveness",
    "surface": "financial_attractiveness",
    "état": "asset_quality",
    "etat": "asset_quality",
    "atouts": "asset_quality",
    "risques": "asset_quality",
    "occupation": "legal_security",
    "type": "liquidity_resale",
    "localisation": "liquidity_resale",
    "qualité": "analysis_confidence",
    "qualite": "analysis_confidence",
}

SURFACE_PATTERNS = {
    "habitable_surface_m2": (
        rf"surface\s*habitable\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"superficie\s+(?:de\s+|d['’]environ\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+superficie\b",
        rf"\bappartement\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+habitables?",
    ),
    "carrez_surface_m2": (
        rf"(?:surface\s+)?carrez.{{0,40}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"loi\s+carrez.{{0,40}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\*)\s+loi\s+carrez",
        rf"superficie\s*approximative\s*habitable\s*totale\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\?)",
    ),
    "land_surface_m2": (
        rf"\bcadastr[ée]e?.{{0,140}}?\b(?:total|superficie|contenance)\b.{{0,30}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\bsection\s+[A-Z]{{1,4}}\s*(?:n[°o]\s*)?[0-9A-Z]+.{{0,100}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:surface\s+(?:du\s+)?terrain|terrain\s+d['’]environ)\s+(?:d['’]environ\s+|environ\s+|de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        r"\b(?:cadastr[ée]e?.{0,120}?\bpour\s+)?([0-9]+)\s*ares?\s+([0-9]+)\s*centiares?\b",
        rf"(?:terrain|parcelle|jardin).{{0,60}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        r"contenance\s+(?:totale\s+)?(?:de\s+)?([0-9]+)\s*a\s*([0-9]+)\s*ca",
        r"([0-9]+)\s*a\s*([0-9]+)\s*ca",
    ),
}

RISK_PATTERNS = {
    "legal": {
        "occupation": r"occup[ée]\s+sans\s+bail|sans\s+droit\s+ni\s+titre|squatt|\bbail\b|\blocataire\b|\bloyer\s+mensuel\b",
        "servitude": r"\bservitudes?\b",
        "copropriété": r"\bcopropri[ée]t[ée]\b|charges\s+de\s+copropri[ée]t[ée]",
    },
    "physical": {
        "amiante": r"\bamiante\b",
        "plomb": r"\bplomb\b",
        "termites": r"\btermites?\b",
        "DPE": r"\bDPE\b|diagnostic\s+de\s+performance\s+[ée]nerg[ée]tique",
        "travaux": (
            r"\btravaux\b|r[ée]novation|rafra[iî]chissement|v[ée]tuste|ruine|"
            r"mauvais\s+[ée]tat|d[ée]grad[ée]s?|d[ée]g[aâ]t\s+des\s+eaux|infiltration"
        ),
    },
}

RISK_DEFINITIONS = tuple(
    {
        "risk_type": risk_type,
        "risk_label": risk_label,
        "pattern": pattern,
        "severity": {
            "occupation": 5,
            "amiante": 3,
            "plomb": 3,
            "termites": 3,
            "travaux": 4,
            "servitude": 2,
            "copropriété": 1,
            "DPE": 1,
        }.get(risk_label, 1),
    }
    for risk_type, patterns in RISK_PATTERNS.items()
    for risk_label, pattern in patterns.items()
)


_PROPERTY_TYPE_LABELS = {
    "apartment": "Appartement",
    "house": "Maison",
    "building": "Immeuble",
    "land": "Terrain",
    "commercial": "Local commercial",
    "parking": "Parking",
    "mixed": "Bien mixte",
}


def _format_surface_m2(value: Decimal | float | None) -> str | None:
    if value is None:
        return None
    try:
        rounded = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    if rounded <= 0:
        return None
    return f"{rounded:,}".replace(",", " ") + " m²"


def build_display_title(sale: AuctionSale) -> str:
    """Generic, consistent title built from the extracted data: property type +
    surface (when available). Replaces heterogeneous scraped titles. The original
    title stays available in raw_payload/raw_text for context and the LLM."""
    source_title = _specific_source_title(sale)
    if sale.property_type in {"commercial", "mixed"} and source_title:
        return source_title
    label = _PROPERTY_TYPE_LABELS.get(sale.property_type or "", "Bien immobilier")
    if sale.property_type == "land":
        surface = _format_surface_m2(sale.land_surface_m2)
    else:
        surface = _format_surface_m2(
            sale.app_surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2
    )
    return f"{label} {surface}" if surface else label


def _specific_source_title(sale: AuctionSale) -> str | None:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    candidates: list[object | None] = [raw_payload.get("title")]
    source_blocks = raw_payload.get("source_blocks")
    if isinstance(source_blocks, dict):
        candidates.extend((source_blocks.get("titre"), source_blocks.get("title")))
    candidates.append(sale.title)

    for candidate in candidates:
        title = clean_text(candidate)
        if _is_specific_display_title(title):
            return title
    return None


def _is_specific_display_title(title: str | None) -> bool:
    if not title or len(title) < 12:
        return False
    lowered = title.lower()
    generic_labels = {label.lower() for label in _PROPERTY_TYPE_LABELS.values()}
    generic_labels.update({"autre", "autres", "bien immobilier"})
    if lowered in generic_labels:
        return False
    return not bool(
        re.fullmatch(
            r"(?:vente aux enchères\s+)?(?:autres?|local commercial|commerce|terrain|immeuble|maison|appartement|bien mixte)"
            r"(?:\s+[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²))?",
            lowered,
        )
    )


def normalize_asset_features(sale: AuctionSale) -> AuctionSale:
    text = _sale_text(sale)
    if not text:
        _fill_quality_flags(sale)
        _score_sale(sale, [])
        sale.title = build_display_title(sale)
        return sale

    _apply_document_consistency_corrections(sale, text)
    _fill_surfaces(sale, text)
    _fill_counts(sale, text)
    _fill_booleans(sale, text)
    risks = extract_risks(sale)
    _fill_quality_flags(sale)
    _score_sale(sale, risks)
    _write_asset_payload(sale, risks)
    sale.title = build_display_title(sale)
    return sale


def build_auction_features_row(sale: AuctionSale) -> dict[str, Any]:
    return {
        "source_url": sale.source_url,
        "bathrooms_count": sale.bathrooms_count,
        "parking_count": sale.parking_count,
        "has_garden": sale.has_garden,
        "has_terrace": sale.has_terrace,
        "has_garage": sale.has_garage,
        "has_pool": sale.has_pool,
        "has_air_conditioning": sale.has_air_conditioning,
        "has_double_glazing": sale.has_double_glazing,
        "investment_score": _float_or_none(sale.investment_score),
        "investment_summary": sale.investment_summary,
    }


def build_auction_surfaces_row(sale: AuctionSale) -> dict[str, Any]:
    return {
        "source_url": sale.source_url,
        "surface_m2": _float_or_none(sale.surface_m2),
        "habitable_surface_m2": _float_or_none(sale.habitable_surface_m2),
        "land_surface_m2": _float_or_none(sale.land_surface_m2),
        "carrez_surface_m2": _float_or_none(sale.carrez_surface_m2),
        "app_surface_m2": _float_or_none(sale.app_surface_m2),
        "app_surface_kind": sale.app_surface_kind,
        "surface_scope": sale.surface_scope,
        "surface_source": sale.surface_source,
        "surface_confidence": _float_or_none(sale.surface_confidence),
        "surface_evidence": sale.surface_evidence,
        "rooms_count": sale.rooms_count,
        "bedrooms_count": sale.bedrooms_count,
        "bathrooms_count": sale.bathrooms_count,
        "parking_count": sale.parking_count,
    }


def build_auction_risk_rows(sale: AuctionSale) -> list[dict[str, Any]]:
    return extract_risks(sale)


def extract_risks(sale: AuctionSale) -> list[dict[str, Any]]:
    occurrences = extract_risk_occurrences_from_text(
        _risk_source_text(sale),
        sale.source_url,
        source_kind="sale_text",
        document_type="source_listing",
    )
    return build_auction_risk_rows_from_occurrences(sale.source_url, occurrences)


def build_auction_risk_rows_from_occurrences(
    source_url: str,
    occurrences: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    occurrence_counts: dict[str, int] = {}
    for occurrence in occurrences:
        label = str(occurrence["risk_label"])
        occurrence_counts[label] = occurrence_counts.get(label, 0) + 1
        current = grouped.get(label)
        if current is None or _risk_occurrence_rank(occurrence) > _risk_occurrence_rank(current):
            grouped[label] = {
                "source_url": source_url,
                "risk_type": occurrence["risk_type"],
                "risk_label": label,
                "severity": occurrence["severity"],
                "evidence": occurrence["excerpt"],
                "confidence": occurrence["confidence"],
                "detector": occurrence["detector"],
                "detector_version": occurrence["detector_version"],
                "score_impact": -float(occurrence["severity"]),
                "evidence_json": {
                    "source_kind": occurrence.get("source_kind") or "pdf",
                    "document_url": occurrence.get("document_url"),
                    "document_label": occurrence.get("document_label"),
                    "document_type": occurrence.get("document_type"),
                    "page_number": occurrence.get("page_number"),
                    "excerpt": occurrence["excerpt"],
                    "matched_terms": occurrence.get("matched_terms", []),
                    "fact": f"{label} retenu",
                    "risk_status": _risk_status(label, occurrence),
                    "source_status": _source_status(occurrence),
                    "decision_chain": _risk_decision_chain(label, occurrence),
                    "verification_priority": _risk_verification_priority(
                        label,
                        int(occurrence.get("severity") or 1),
                    ),
                    "status": _risk_fact_status(float(occurrence.get("confidence") or 0)),
                    "reasoning": _risk_reasoning(label, occurrence),
                    "why_it_matters": _risk_why_it_matters(label, int(occurrence.get("severity") or 1)),
                    "next_action": _risk_next_action(label),
                    "document_context": _document_context_label(occurrence.get("document_type")),
                    "document_weight": _document_type_weight(str(occurrence.get("document_type") or "")),
                    "question": _risk_question(label),
                    "decision": "Retenu car le contexte rattache la mention au bien ou à un document probant.",
                    "confidence_note": _confidence_note(Decimal(str(occurrence.get("confidence") or "0"))),
                },
            }

    rows = []
    for label, row in grouped.items():
        row["evidence_json"]["occurrence_count"] = occurrence_counts.get(label, 1)
        rows.append(row)
    return rows


def build_auction_score_factor_rows(
    sale: AuctionSale,
    risk_occurrences: list[dict[str, object]] | None = None,
) -> list[dict[str, Any]]:
    factors = sale.score_factors or sale.raw_payload.get("score_factors") or []
    if not isinstance(factors, list):
        return []
    rows = []
    seen_factor_keys: set[str] = set()
    for index, factor in enumerate(factors):
        if not isinstance(factor, dict):
            continue
        factor_key = str(factor.get("factor_key") or factor.get("name") or f"factor_{index}")
        if factor_key in seen_factor_keys:
            continue
        seen_factor_keys.add(factor_key)
        evidence_refs = factor.get("evidence_refs") or []
        if not evidence_refs and factor_key in {"risques", "état", "etat"} and risk_occurrences:
            evidence_refs = _factor_refs_from_risk_occurrences(risk_occurrences)
        rows.append(
            {
                "source_url": sale.source_url,
                "factor_order": index,
                "factor_key": factor_key,
                "label": factor.get("label") or factor_key,
                "reason": factor.get("reason"),
                "delta": factor.get("delta"),
                "weight": factor.get("weight"),
                "raw_value": factor.get("raw_value"),
                "normalized_value": factor.get("normalized_value"),
                "confidence": factor.get("confidence"),
                "evidence": factor.get("evidence"),
                "evidence_refs": evidence_refs,
            }
        )
    return rows


def extract_risk_occurrences_from_text(
    text: str | None,
    source_url: str,
    *,
    source_kind: str,
    document_url: str | None = None,
    document_label: str | None = None,
    document_type: str | None = None,
    page_number: int | None = None,
) -> list[dict[str, Any]]:
    if not text:
        return []
    normalized_document_type = _normalize_document_type(document_type, source_kind)
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int | None]] = set()
    for definition in RISK_DEFINITIONS:
        label = str(definition["risk_label"])
        pattern = str(definition["pattern"])
        matches_for_label = 0
        for match in re.finditer(pattern, text, re.I):
            if _risk_match_is_negated(text, match.start(), match.end(), label):
                continue
            context = _evidence(text, match.start(), match.end())
            decision = _risk_context_decision(
                label,
                context,
                source_kind=source_kind,
                document_type=normalized_document_type,
            )
            if not decision["accepted"]:
                continue
            key = (label, clean_text(context)[:120], page_number)
            if key in seen:
                continue
            seen.add(key)
            matches_for_label += 1
            rows.append(
                {
                    "source_url": source_url,
                    "risk_type": definition["risk_type"],
                    "risk_label": label,
                    "severity": decision.get("severity") or definition["severity"],
                    "document_url": document_url,
                    "document_label": document_label,
                    "document_type": normalized_document_type,
                    "page_number": page_number,
                    "excerpt": context,
                    "confidence": decision["confidence"],
                    "detector": "contextual_rules",
                    "detector_version": RISK_DETECTOR_VERSION,
                    "matched_terms": [match.group(0)],
                    "is_negated": False,
                    "score_impact": -float(decision.get("severity") or definition["severity"]),
                    "source_kind": source_kind,
                    "context_reasoning": decision.get("reasoning"),
                    "risk_status": decision.get("risk_status") or "confirmed",
                }
            )
            if matches_for_label >= 3:
                break
    return rows


def _fill_surfaces(sale: AuctionSale, text: str) -> None:
    if sale.habitable_surface_m2 is None:
        sale.habitable_surface_m2 = _extract_surface_kind(text, "habitable_surface_m2", sale)
    if sale.carrez_surface_m2 is None:
        sale.carrez_surface_m2 = _extract_surface_kind(text, "carrez_surface_m2", sale)
    text_land_surface = _extract_surface_kind(text, "land_surface_m2", sale)
    if sale.land_surface_m2 is None:
        sale.land_surface_m2 = text_land_surface
    elif _should_prefer_text_land_surface(sale, text_land_surface):
        previous_land_surface = sale.land_surface_m2
        sale.land_surface_m2 = text_land_surface
        sale.raw_payload["land_surface_reconciliation"] = {
            "status": "resolved",
            "rejected_land_surface_m2": str(previous_land_surface),
            "resolved_land_surface_m2": str(text_land_surface),
            "basis": "explicit_land_text_and_truncated_digits",
        }
        _add_quality_flag(sale, "land_surface_conflict_resolved")
    _discard_placeholder_built_surface(sale)
    text_built_surface = _extract_built_surface(text, sale)
    if sale.surface_m2 is None:
        sale.surface_m2 = text_built_surface
    elif _should_prefer_text_built_surface(sale, text_built_surface):
        previous_surface = sale.surface_m2
        sale.surface_m2 = text_built_surface
        if sale.property_type == "house" and (
            sale.habitable_surface_m2 is None or sale.habitable_surface_m2 == previous_surface
        ):
            sale.habitable_surface_m2 = text_built_surface
        if _corroborated_text_built_surface(sale) == text_built_surface:
            _record_surface_conflict_resolution(sale, previous_surface, text_built_surface)
    explicit_app_surface = None
    min_app_surface = Decimal("20")
    if sale.property_type == "apartment":
        explicit_app_surface = sale.carrez_surface_m2 or sale.habitable_surface_m2
        min_app_surface = Decimal("9")
    elif sale.property_type == "house":
        explicit_app_surface = sale.habitable_surface_m2
    if explicit_app_surface is not None and explicit_app_surface >= min_app_surface:
        sale.surface_m2 = explicit_app_surface
    if sale.habitable_surface_m2 is None and sale.property_type == "house":
        sale.habitable_surface_m2 = sale.surface_m2
        if sale.surface_m2 is not None:
            _set_surface_evidence(sale, "surface_m2_fallback", None)
    if sale.carrez_surface_m2 is None and sale.property_type == "apartment":
        sale.carrez_surface_m2 = sale.surface_m2
        if sale.surface_m2 is not None:
            _set_surface_evidence(sale, "surface_m2_fallback", None)
    if sale.land_surface_m2 is not None and sale.property_type not in {"land", "house", "building", "commercial", "mixed"}:
        sale.land_surface_m2 = None
    _set_app_surface(sale)
    _validate_app_surface_scope(sale)
    _flag_ambiguous_surface(sale)
    if (
        sale.surface_scope is None
        and sale.app_surface_m2 is None
        and sale.land_surface_m2 is not None
        and sale.property_type in {"house", "building"}
    ):
        sale.surface_scope = "land"


def _discard_placeholder_built_surface(sale: AuctionSale) -> None:
    if sale.property_type not in {"house", "building"} or sale.land_surface_m2 is None:
        return
    discarded = False
    if sale.habitable_surface_m2 is not None and sale.habitable_surface_m2 < Decimal("9"):
        sale.habitable_surface_m2 = None
        discarded = True
    if sale.surface_m2 is not None and sale.surface_m2 < Decimal("9") and sale.habitable_surface_m2 is None:
        sale.surface_m2 = None
        discarded = True
    if discarded and sale.app_surface_m2 is not None and sale.app_surface_m2 < Decimal("9"):
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        sale.surface_scope = None


def _should_prefer_text_built_surface(sale: AuctionSale, candidate: Decimal | None) -> bool:
    if candidate is None or sale.surface_m2 is None or candidate == sale.surface_m2:
        return False
    if sale.property_type not in {"house", "building"}:
        return False
    if _surface_is_document_backed(sale):
        return False
    if sale.surface_m2 < Decimal("9"):
        return True
    if candidate >= Decimal("20") and candidate > sale.surface_m2:
        return True
    return candidate >= Decimal("9") and _corroborated_text_built_surface(sale) == candidate


def _surface_is_document_backed(sale: AuctionSale) -> bool:
    extraction = sale.raw_payload.get("surface_extraction")
    if not isinstance(extraction, dict) or extraction.get("source") != "pdf":
        return sale.surface_source == "pdf"
    documented_value = parse_surface(extraction.get("value_m2"))
    return documented_value is not None and documented_value == sale.surface_m2


def _should_prefer_text_land_surface(sale: AuctionSale, candidate: Decimal | None) -> bool:
    current = sale.land_surface_m2
    if candidate is None or current is None or candidate <= current:
        return False
    extraction = sale.raw_payload.get("land_surface_extraction")
    if isinstance(extraction, dict) and extraction.get("source") == "pdf":
        documented_value = parse_surface(extraction.get("value_m2"))
        if documented_value == current:
            return False
    current_digits = _surface_integer_digits(current)
    candidate_digits = _surface_integer_digits(candidate)
    if not current_digits or not candidate_digits:
        return False
    return candidate_digits.endswith(current_digits) or (
        candidate >= current * Decimal("9") and candidate <= current * Decimal("11")
    )


def _surface_integer_digits(value: Decimal) -> str | None:
    if value != value.to_integral_value():
        return None
    return str(int(value))


def _corroborated_text_built_surface(sale: AuctionSale) -> Decimal | None:
    title_surface = _extract_built_surface(clean_text(sale.title) or "")
    description_surface = _extract_built_surface(clean_text(sale.description) or "")
    if title_surface is None or title_surface != description_surface:
        return None
    return title_surface


def _record_surface_conflict_resolution(
    sale: AuctionSale,
    previous_surface: Decimal,
    resolved_surface: Decimal,
) -> None:
    evidence = clean_text(" ".join(filter(None, (sale.title, sale.description))))
    sale.surface_source = "corroborated_source_text"
    sale.surface_confidence = Decimal("0.92")
    sale.surface_evidence = evidence[:500] if evidence else None
    sale.raw_payload["surface_reconciliation"] = {
        "status": "resolved",
        "rejected_surface_m2": str(previous_surface),
        "resolved_built_surface_m2": str(resolved_surface),
        "basis": "matching_title_and_description",
    }
    _add_quality_flag(sale, "surface_conflict_resolved")


def _apply_document_consistency_corrections(sale: AuctionSale, text: str) -> None:
    lowered = text.lower()
    if sale.property_type in {"building", "other", "unknown", None} and _text_describes_single_apartment(lowered):
        evidence = _first_rule_evidence(
            text,
            (
                r"\bappartement\s+de\s+type\s+studio\b",
                r"\btype\s+d['’]habitat\s*:?\s*studio\b",
                r"\bstudio\b.{0,80}\b(?:rez-de-chauss[ée]e|copropri[ée]t[ée]|surface\s+habitable|bail)\b",
            ),
        )
        previous_value = sale.property_type
        sale.property_type = "apartment"
        _add_quality_flag(sale, "type_corrected_from_documents")
        _record_business_rule(
            sale,
            "property_type_from_specific_asset",
            factor_key="type",
            decision="Type retenu : appartement/studio, et non immeuble.",
            evidence=evidence,
            reasoning=(
                "Le mot immeuble peut désigner juridiquement le bâtiment ou la copropriété. "
                "Quand le dossier rattache l'actif vendu à un logement précis, un lot, un studio "
                "ou un appartement, le scoring doit qualifier l'actif analysé et non le support cadastral."
            ),
            impact=(
                f"La valeur structurée initiale ({previous_value or 'non renseignée'}) est corrigée "
                "pour éviter de survaloriser à tort un potentiel d'immeuble de rapport."
            ),
            confidence=0.78,
        )

    if sale.occupancy_status in {"vacant", "free"} and _has_unresolved_occupancy_conflict(lowered):
        evidence = _first_rule_evidence(
            text,
            (
                r"\b(?:actuellement\s+)?occup[ée]\b.{0,120}\b(?:bail|locataire|loyer)\b",
                r"\b(?:bail|locataire|loyer\s+mensuel)\b.{0,120}\b(?:occup[ée]|meubl[ée]|charges?\s+comprises)\b",
            ),
        )
        previous_value = sale.occupancy_status
        sale.occupancy_status = "unknown"
        _add_quality_flag(sale, "occupation_conflict")
        _record_business_rule(
            sale,
            "occupation_conflict_requires_confirmation",
            factor_key="occupation",
            decision="Occupation retenue : à confirmer.",
            evidence=evidence,
            reasoning=(
                "Une annonce peut indiquer libre, mais un PV, un bail ou une pièce d'occupation a une portée "
                "plus opérationnelle pour l'investisseur. Si ces documents signalent un locataire, un bail "
                "ou un loyer sans preuve de départ effectif, l'application ne doit pas conclure que le bien "
                "sera libre à l'adjudication."
            ),
            impact=(
                f"Le statut initial ({previous_value}) est neutralisé : le score retire le bonus de liquidité "
                "et demande une vérification avant de calculer un scénario locatif ou de revente."
            ),
            confidence=0.82,
        )


def _text_describes_single_apartment(text: str) -> bool:
    if re.search(
        r"\bimmeuble\s+(?:entier|comprenant|compos[ée]|[àa]\s+usage)|"
        r"\bplusieurs\s+appartements?\b|"
        r"\bensemble\s+immobilier\s+comprenant\b",
        text,
        re.I,
    ):
        return False
    return bool(
        re.search(
            r"\bappartement\s+de\s+type\s+studio\b|"
            r"\bappartement\b.{0,80}\bstudio\b|"
            r"\bstudio\b.{0,80}\b(?:rez-de-chauss[ée]e|copropri[ée]t[ée]|surface\s+habitable|bail)\b|"
            r"\btype\s+d['’]habitat\s*:?\s*studio\b|"
            r"\blogement\b.{0,80}\bstudio\b",
            text,
            re.I,
        )
    )


def _has_unresolved_occupancy_conflict(text: str) -> bool:
    occupied_signal = re.search(
        r"\b(?:actuellement\s+)?occup[ée]\b|"
        r"\bsuivant\s+un\s+bail\b|"
        r"\bbail\s+(?:meubl[ée]|d['’]habitation|en\s+cours)\b|"
        r"\blocataire\b|"
        r"\bloyer\s+mensuel\b",
        text,
        re.I,
    )
    if not occupied_signal:
        return False
    resolved_vacancy = re.search(
        r"\blibre\s+de\s+toute\s+occupation\b|"
        r"\ba\s+quitt[ée]\s+les\s+lieux\b|"
        r"\bd[ée]part\s+effectif\b|"
        r"\bconstat[ée]?\s+libre\b",
        text,
        re.I,
    )
    return not bool(resolved_vacancy)


def _first_rule_evidence(text: str, patterns: tuple[str, ...], *, window: int = 170) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        return _evidence(text, match.start(), match.end(), window=window)
    return None


def _record_business_rule(
    sale: AuctionSale,
    rule_id: str,
    *,
    factor_key: str,
    decision: str,
    evidence: str | None,
    reasoning: str,
    impact: str,
    confidence: float,
) -> None:
    rules = sale.raw_payload.setdefault("business_rules", [])
    if not isinstance(rules, list):
        rules = []
        sale.raw_payload["business_rules"] = rules
    rule = {
        "rule_id": rule_id,
        "version": BUSINESS_RULE_VERSION,
        "factor_key": factor_key,
        "decision": decision,
        "evidence": evidence,
        "reasoning": reasoning,
        "impact": impact,
        "confidence": confidence,
    }
    for index, item in enumerate(rules):
        if isinstance(item, dict) and item.get("rule_id") == rule_id:
            rules[index] = rule
            return
    rules.append(rule)


def _business_rule(sale: AuctionSale, rule_id: str) -> dict[str, Any] | None:
    rules = sale.raw_payload.get("business_rules")
    if not isinstance(rules, list):
        return None
    for item in rules:
        if isinstance(item, dict) and item.get("rule_id") == rule_id:
            return item
    return None


def _business_rule_refs(sale: AuctionSale, factor_key: str | None = None) -> list[dict[str, Any]]:
    rules = sale.raw_payload.get("business_rules")
    if not isinstance(rules, list):
        return []
    refs = []
    for item in rules:
        if not isinstance(item, dict):
            continue
        if factor_key is not None and item.get("factor_key") != factor_key:
            continue
        refs.append(_business_rule_to_ref(item))
    return refs


def _business_rule_to_ref(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": rule.get("decision") or rule.get("rule_id"),
        "excerpt": rule.get("evidence"),
        "document_type": "règle métier",
        "confidence": rule.get("confidence"),
        "reasoning": rule.get("reasoning"),
    }


def _extract_surface_kind(text: str, kind: str, sale: AuctionSale | None = None) -> Decimal | None:
    for pattern in SURFACE_PATTERNS[kind]:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        if len(match.groups()) == 2:
            return Decimal(match.group(1)) * Decimal("100") + Decimal(match.group(2))
        value = _parse_surface_decimal(match.group(1))
        if (
            value
            and not _surface_false_positive(text, match.start(), match.end())
            and not _land_surface_false_positive(text, match, kind)
            and not _living_surface_false_positive(text, match.start(), match.end(), kind)
        ):
            if sale is not None:
                _set_surface_evidence(sale, kind, _evidence(text, match.start(), match.end()))
            return value
    return None


def _fill_counts(sale: AuctionSale, text: str) -> None:
    if sale.rooms_count is None:
        sale.rooms_count = _infer_rooms_count(text, sale)
    if sale.bedrooms_count is None and re.search(r"\bstudio\b|\bT\s*1\b|\btype\s*1\b", text, re.I):
        sale.bedrooms_count = 0
    if (
        sale.rooms_count is not None
        and sale.bedrooms_count is not None
        and sale.bedrooms_count > sale.rooms_count
    ):
        sale.rooms_count = None
        _add_quality_flag(sale, "room_count_conflict")
    if sale.bathrooms_count is None:
        sale.bathrooms_count = _extract_count(
            text,
            (
                r"\b([1-9][0-9]?)\s+salles?\s+(?:de\s+)?bains?\b",
                r"\b([1-9][0-9]?)\s+salles?\s+d['’]eau\b",
                r"\bsalles?\s+(?:de\s+)?bains?\s*:?\s*([1-9][0-9]?)\b",
            ),
        )
    if sale.parking_count is None:
        sale.parking_count = _extract_count(
            text,
            (
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(?:places?\s+de\s+)?parkings?\b",
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+places?\s+de\s+stationnement\b",
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+garages?\b",
            ),
        )
        if sale.parking_count is None and re.search(r"\bparking\b|\bgarage\b", text, re.I):
            sale.parking_count = 1


def _fill_booleans(sale: AuctionSale, text: str) -> None:
    checks = {
        "has_garden": r"\bjardin\b",
        "has_terrace": r"\bterrasse\b",
        "has_garage": r"\bgarage\b",
        "has_pool": r"\bpiscine\b",
        "has_air_conditioning": r"\bclimatisation\b|\bclimatis[ée]\b",
        "has_double_glazing": r"double\s+vitrage",
    }
    for flag_name, pattern in checks.items():
        if getattr(sale, flag_name) is None:
            setattr(sale, flag_name, bool(re.search(pattern, text, re.I)))


def _score_sale(sale: AuctionSale, risks: list[dict[str, Any]]) -> None:
    weights = _load_scoring_weights()
    sale.score_version = str(weights.get("version", "v1"))
    components = [
        _score_occupation(sale),
        _score_condition(sale, risks),
        _score_property_type(sale),
        _score_location(sale),
        _score_surface(sale),
        _score_price_per_m2(sale),
        _score_amenities(sale),
        _score_risks(sale, risks),
        _score_data_quality(sale),
    ]
    total = Decimal(str(weights.get("base_score", 50)))
    factor_rows = []
    for index, component in enumerate(components):
        weight = Decimal(str(weights.get(component.name, 1)))
        delta = component.points * weight
        score_before = total
        total += delta
        factor_rows.append(_score_factor_payload(component, delta, weight, index, score_before, total))
    total = max(Decimal("0"), min(Decimal("100"), total))
    sale.investment_score = total.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    sale.score_confidence = _score_confidence(sale, components)
    sale.score_factors = factor_rows
    sale.raw_payload["score_factors"] = factor_rows
    sale.raw_payload["investment_analysis"] = _build_premium_investment_analysis(
        sale,
        risks,
        components,
        factor_rows,
    )
    sale.investment_summary = "; ".join(
        f"{item.name}: {item.reason} ({Decimal(str(factor_rows[index]['delta'])):+})"
        for index, item in enumerate(components)
    )


def _score_occupation(sale: AuctionSale) -> ScoreComponent:
    conflict_rule = _business_rule(sale, "occupation_conflict_requires_confirmation")
    if sale.occupancy_status == "unknown" and conflict_rule:
        evidence = str(conflict_rule.get("evidence") or "") or None
        confidence = Decimal(str(conflict_rule.get("confidence") or "0.65"))
        return ScoreComponent(
            "occupation",
            Decimal("-3"),
            "occupation à confirmer : bail ou locataire détecté",
            confidence=confidence,
            evidence=evidence,
            raw_value=sale.occupancy_status,
            criterion="Le statut d'occupation pèse directement sur la liquidité, les délais et la capacité à visiter ou relouer.",
            calculation=(
                "Une source peut annoncer un bien libre, mais un document opérationnel mentionne bail, locataire "
                "ou loyer sans preuve de départ effectif. Le bonus de bien libre est donc retiré : -3 points."
            ),
            interpretation=str(conflict_rule.get("reasoning") or ""),
            limits=(
                "À lever avec une attestation de libération, un état des lieux de sortie, "
                "un PV plus récent ou une confirmation du cabinet avant enchère."
            ),
            evidence_refs=[_business_rule_to_ref(conflict_rule)],
        )
    mapping = {
        "vacant": (Decimal("12"), "libre, liquidité meilleure"),
        "unknown": (Decimal("-3"), "occupation à confirmer"),
        "rented": (Decimal("3"), "loué, rendement possible mais bail à vérifier"),
        "occupied": (Decimal("-10"), "occupé, libération incertaine"),
        "owner_occupied": (Decimal("-8"), "occupé par propriétaire"),
        "squatted": (Decimal("-18"), "squat ou occupation sans droit"),
    }
    points, reason = mapping.get(sale.occupancy_status or "", (Decimal("-3"), "occupation non renseignée"))
    confidence = Decimal("0.55") if sale.occupancy_status == "unknown" else Decimal("0.85") if sale.occupancy_status else Decimal("0.45")
    status_label = _occupancy_status_label(sale.occupancy_status)
    return ScoreComponent(
        "occupation",
        points,
        reason,
        confidence=confidence,
        raw_value=sale.occupancy_status,
        criterion="Le statut d'occupation pèse directement sur la liquidité, les délais et la capacité à visiter ou relouer.",
        calculation=f"Statut retenu : {status_label}. Barème appliqué : {points:+} point(s).",
        interpretation=(
            "Le bien est considéré comme immédiatement exploitable si l'occupation est libre. "
            "Une occupation inconnue ou contrainte est pénalisée car elle crée un coût et un délai potentiel."
        ),
        limits=(
            "À confirmer dans le PV descriptif, le bail ou le cahier des conditions de vente "
            "si le statut vient uniquement de l'annonce."
        ),
    )


def _score_condition(sale: AuctionSale, risks: list[dict[str, Any]]) -> ScoreComponent:
    works_risk = next((risk for risk in risks if risk.get("risk_label") == "travaux"), None)
    if works_risk:
        severity = int(works_risk.get("severity") or 4)
        confidence = Decimal(str(works_risk.get("confidence") or "0.78"))
        evidence = str(works_risk.get("evidence") or "") or None
        evidence_refs = [_risk_to_evidence_ref(works_risk)] if evidence else []
        if severity >= 5:
            return ScoreComponent(
                "état",
                Decimal("-14"),
                "désordre lourd ou remise en état importante documentée",
                confidence=confidence,
                evidence=evidence,
                criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
                calculation=f"Signal travaux retenu avec sévérité {severity}/5 : -14 points.",
                interpretation=(
                    "Le contexte contient un désordre matériel explicite rattaché au bien "
                    "(dégât des eaux, infiltrations, gros travaux ou remise en état importante)."
                ),
                limits="Le score ne chiffre pas encore le coût des travaux ; il indique un risque à budgéter avant enchère.",
                evidence_refs=evidence_refs,
            )
        return ScoreComponent(
            "état",
            Decimal("-6"),
            "travaux ou état dégradé documentés",
            confidence=confidence,
            evidence=evidence,
            criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
            calculation=f"Signal travaux retenu avec sévérité {severity}/5 : -6 points.",
            interpretation=(
                "Le contexte mentionne un état dégradé ou des travaux liés au bien, "
                "sans atteindre le seuil des désordres lourds."
            ),
            limits="À confronter aux photos, au PV descriptif complet et aux devis si disponibles.",
            evidence_refs=evidence_refs,
        )
    text = _sale_text(sale)
    positive_condition = re.search(
        r"\bbon\s+[ée]tat\b|\br[ée]nov[ée]e?\b|\brefaite?\b|\baucun\s+travaux\b",
        text,
        re.I,
    )
    if positive_condition and not _text_has_works_signal(text):
        return ScoreComponent(
            "état",
            Decimal("4"),
            "bon état explicitement mentionné",
            confidence=Decimal("0.75"),
            evidence=_evidence(text, positive_condition.start(), positive_condition.end()),
            criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
            calculation="Mention positive d'état détectée : +4 points.",
            interpretation="Le texte indique un bien en bon état ou rénové, sans signal travaux retenu.",
            limits="Cette lecture reste déclarative si elle ne provient pas d'un PV descriptif ou d'un diagnostic.",
        )
    return ScoreComponent(
        "état",
        Decimal("0"),
        "état non qualifié",
        confidence=Decimal("0.45"),
        criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
        calculation="Aucun signal positif ou négatif exploitable : 0 point.",
        interpretation="Aucun élément suffisamment contextualisé ne permet de conclure sur l'état réel du bien.",
        limits="Le lecteur doit consulter les PV, diagnostics et photographies avant de considérer ce facteur comme neutre.",
    )


def _score_property_type(sale: AuctionSale) -> ScoreComponent:
    mapping = {
        "apartment": (Decimal("5"), "appartement, marché liquide"),
        "house": (Decimal("4"), "maison, demande large"),
        "building": (Decimal("6"), "immeuble, potentiel locatif"),
        "mixed": (Decimal("1"), "actif mixte, analyse plus complexe"),
        "commercial": (Decimal("-2"), "commercial, sortie plus spécialisée"),
        "land": (Decimal("-3"), "terrain, valorisation spécifique"),
        "parking": (Decimal("1"), "parking"),
    }
    points, reason = mapping.get(sale.property_type or "", (Decimal("-2"), "type non qualifié"))
    confidence = Decimal("0.82") if sale.property_type not in {None, "unknown", "other"} else Decimal("0.45")
    type_rule = _business_rule(sale, "property_type_from_specific_asset")
    evidence = None
    evidence_refs: list[dict[str, Any]] = []
    calculation = f"Type retenu : {_property_type_label(sale.property_type)}. Barème appliqué : {points:+} point(s)."
    interpretation = (
        "Les appartements, maisons et immeubles sont favorisés car les usages et comparables sont plus lisibles. "
        "Les actifs spécialisés demandent une analyse de marché plus fine."
    )
    if type_rule and sale.property_type == "apartment":
        evidence = str(type_rule.get("evidence") or "") or None
        evidence_refs = [_business_rule_to_ref(type_rule)]
        confidence = Decimal(str(type_rule.get("confidence") or confidence))
        reason = "appartement/studio documenté, marché liquide"
        calculation = (
            "Le document décrit l'actif vendu comme un logement ou studio précis. "
            f"Type retenu : appartement. Barème appliqué : {points:+} point(s)."
        )
        interpretation = str(type_rule.get("reasoning") or interpretation)
    return ScoreComponent(
        "type",
        points,
        reason,
        confidence=confidence,
        evidence=evidence,
        raw_value=sale.property_type,
        criterion="Le type de bien sert à estimer la profondeur du marché et la facilité de sortie.",
        calculation=calculation,
        interpretation=interpretation,
        limits="Le type peut être corrigé si le cahier de vente décrit un actif mixte ou une dépendance dominante.",
        evidence_refs=evidence_refs,
    )


def _score_location(sale: AuctionSale) -> ScoreComponent:
    prime = {"Bordeaux", "Pau", "Bayonne", "Mérignac", "Merignac", "Périgueux", "Perigueux", "Urrugne"}
    secondary = {"Libourne", "Dax", "Agen", "Bergerac", "Mont-de-Marsan", "Floirac", "Cenon", "Biganos"}
    if sale.city in prime:
        return ScoreComponent(
            "localisation",
            Decimal("8"),
            f"{sale.city} marché profond",
            confidence=Decimal("0.75"),
            raw_value=sale.city,
            criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
            calculation=f"Ville classée marché prioritaire : {sale.city}. Barème appliqué : +8 points.",
            interpretation="La commune dispose d'une demande plus large et d'un volume de transactions plus exploitable.",
            limits="Cette pondération doit être complétée par l'adresse précise, l'environnement immédiat et les comparables.",
        )
    if sale.city in secondary:
        return ScoreComponent(
            "localisation",
            Decimal("4"),
            f"{sale.city} marché qualifié",
            confidence=Decimal("0.7"),
            raw_value=sale.city,
            criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
            calculation=f"Ville classée marché secondaire : {sale.city}. Barème appliqué : +4 points.",
            interpretation="La commune est exploitable, mais le marché est moins profond qu'une grande centralité.",
            limits="Le quartier et la distance aux services peuvent fortement modifier cette lecture.",
        )
    if sale.tribunal:
        return ScoreComponent(
            "localisation",
            Decimal("3"),
            "localisation qualifiée",
            confidence=Decimal("0.55"),
            raw_value=sale.tribunal,
            criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
            calculation=f"Ville non classée, tribunal identifié ({sale.tribunal}) : +3 points.",
            interpretation="Le dossier est localisable, mais la liquidité du micro-marché reste à confirmer.",
            limits="À compléter par les coordonnées GPS, la carte et les références locales.",
        )
    return ScoreComponent(
        "localisation",
        Decimal("-2"),
        "localisation peu qualifiée",
        confidence=Decimal("0.35"),
        criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
        calculation="Aucune commune ou tribunal suffisamment fiable : -2 points.",
        interpretation="L'absence de localisation exploitable réduit la fiabilité du scoring.",
        limits="Le score doit être recalculé dès que l'adresse ou la commune est confirmée.",
    )


def _score_surface(sale: AuctionSale) -> ScoreComponent:
    surface = sale.app_surface_m2
    if surface is None:
        if "ambiguous_surface" in sale.quality_flags:
            return ScoreComponent(
                "surface",
                Decimal("-8"),
                "surface ambiguë, non exploitable",
                confidence=Decimal("0.35"),
                criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
                calculation="Plusieurs surfaces ou une surface annexe semblent mélangées : -8 points.",
                interpretation="Le prix au m² et la comparaison marché ne sont pas fiables tant que la surface n'est pas clarifiée.",
                limits="Vérifier le PV descriptif, le diagnostic Carrez et la désignation des lots.",
            )
        return ScoreComponent(
            "surface",
            Decimal("-6"),
            "surface exploitable absente",
            confidence=Decimal("0.3"),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation="Aucune surface exploitable retenue : -6 points.",
            interpretation="Le score pénalise l'absence de base de calcul pour le prix au m².",
            limits="À compléter dès qu'une surface habitable, Carrez ou bâtie est extraite d'un document fiable.",
        )
    confidence = sale.surface_confidence or Decimal("0.65")
    if Decimal("25") <= surface <= Decimal("160"):
        return ScoreComponent(
            "surface",
            Decimal("6"),
            f"{surface} m2 exploitable",
            confidence=confidence,
            evidence=sale.surface_evidence,
            raw_value=float(surface),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation=f"Surface retenue : {_format_decimal(surface)} m2, dans la plage standard 25-160 m2 : +6 points.",
            interpretation="La surface permet de calculer un prix au m² et de comparer le bien au marché résidentiel courant.",
            limits="La surface reste à confirmer si elle ne provient pas d'une mention Carrez, habitable ou d'un PV descriptif.",
            evidence_refs=_surface_evidence_refs(sale),
        )
    if surface < Decimal("15"):
        return ScoreComponent(
            "surface",
            Decimal("-5"),
            "surface très faible",
            confidence=confidence,
            evidence=sale.surface_evidence,
            raw_value=float(surface),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation=f"Surface retenue : {_format_decimal(surface)} m2, inférieure au seuil de 15 m2 : -5 points.",
            interpretation="Une très petite surface limite les usages et peut réduire la liquidité.",
            limits="Vérifier qu'il ne s'agit pas d'une pièce, cave, garage ou annexe isolée.",
            evidence_refs=_surface_evidence_refs(sale),
        )
    if surface > Decimal("300") and sale.property_type not in {"building", "commercial", "mixed", "land"}:
        return ScoreComponent(
            "surface",
            Decimal("-2"),
            "surface atypique pour ce type",
            confidence=confidence,
            evidence=sale.surface_evidence,
            raw_value=float(surface),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation=f"Surface retenue : {_format_decimal(surface)} m2, atypique pour {_property_type_label(sale.property_type)} : -2 points.",
            interpretation="La surface peut mélanger bâti, terrain ou dépendances ; la comparaison marché devient plus fragile.",
            limits="À confirmer dans la désignation des lots et les diagnostics.",
            evidence_refs=_surface_evidence_refs(sale),
        )
    return ScoreComponent(
        "surface",
        Decimal("1"),
        "surface atypique mais exploitable",
        confidence=confidence,
        evidence=sale.surface_evidence,
        raw_value=float(surface),
        criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
        calculation=f"Surface retenue : {_format_decimal(surface)} m2 : +1 point.",
        interpretation="La donnée est exploitable mais ne rentre pas dans le cas résidentiel standard.",
        limits="À vérifier selon la nature exacte du bien.",
        evidence_refs=_surface_evidence_refs(sale),
    )


def _score_price_per_m2(sale: AuctionSale) -> ScoreComponent:
    surface = sale.app_surface_m2
    if not surface:
        return ScoreComponent(
            "prix_m2",
            Decimal("-4"),
            "prix/m2 non calculable sans surface",
            confidence=Decimal("0.3"),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation="Mise à prix / surface impossible car aucune surface exploitable n'est retenue : -4 points.",
            interpretation="Sans surface fiable, l'attractivité financière ne peut pas être comparée proprement.",
            limits="Ce facteur sera recalculé automatiquement dès qu'une surface exploitable sera disponible.",
        )
    if not sale.starting_price_eur:
        return ScoreComponent(
            "prix_m2",
            Decimal("-2"),
            "mise à prix absente",
            confidence=Decimal("0.35"),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation="Mise à prix absente : -2 points.",
            interpretation="Le potentiel financier ne peut pas être estimé sans prix de départ.",
            limits="Vérifier l'annonce officielle ou le cahier des conditions de vente.",
        )
    price_m2 = sale.starting_price_eur / surface
    low, fair, high = _price_bands_for_sale(sale)
    rounded = price_m2.quantize(Decimal("1"))
    confidence = min(sale.surface_confidence or Decimal("0.65"), Decimal("0.8"))
    if price_m2 < low:
        return ScoreComponent(
            "prix_m2",
            Decimal("12"),
            f"mise à prix attractive env. {rounded} €/m2",
            confidence=confidence,
            raw_value=float(price_m2),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, sous le seuil attractif {_format_eur(low)}/m2 : +12 points.",
            interpretation="La mise à prix laisse théoriquement une marge de sécurité avant le niveau de marché indicatif.",
            limits="Ce n'est pas une estimation de valeur vénale : frais, travaux, occupation et concurrence aux enchères restent à intégrer.",
        )
    if price_m2 < fair:
        return ScoreComponent(
            "prix_m2",
            Decimal("6"),
            f"mise à prix correcte env. {rounded} €/m2",
            confidence=confidence,
            raw_value=float(price_m2),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, sous le seuil correct {_format_eur(fair)}/m2 : +6 points.",
            interpretation="La mise à prix est cohérente avec un dossier à analyser, sans signal de surprix initial.",
            limits="Le résultat dépend fortement de la surface retenue et des coûts annexes.",
        )
    if price_m2 > high:
        return ScoreComponent(
            "prix_m2",
            Decimal("-8"),
            f"mise à prix élevée env. {rounded} €/m2",
            confidence=confidence,
            raw_value=float(price_m2),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, au-dessus du seuil élevé {_format_eur(high)}/m2 : -8 points.",
            interpretation="La marge de sécurité paraît faible au regard de la seule mise à prix.",
            limits="Un emplacement premium ou un actif rare peut justifier un prix au m² supérieur.",
        )
    return ScoreComponent(
        "prix_m2",
        Decimal("0"),
        f"mise à prix neutre env. {rounded} €/m2",
        confidence=confidence,
        raw_value=float(price_m2),
        criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
        calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, dans la zone neutre : 0 point.",
        interpretation="La mise à prix ne crée ni avantage clair ni alerte forte sur ce critère seul.",
        limits="Comparer avec des références récentes autour de l'adresse avant décision.",
    )


def _price_bands_for_sale(sale: AuctionSale) -> tuple[Decimal, Decimal, Decimal]:
    prime_cities = {"Bordeaux", "Bayonne", "Pau", "Mérignac", "Merignac", "Urrugne"}
    secondary_cities = {"Périgueux", "Perigueux", "Floirac", "Cenon", "Biganos", "Libourne"}
    if sale.city in prime_cities:
        return Decimal("1800"), Decimal("3200"), Decimal("5200")
    if sale.city in secondary_cities:
        return Decimal("1400"), Decimal("2600"), Decimal("4200")
    if sale.department == "33":
        return Decimal("1400"), Decimal("2800"), Decimal("4800")
    if sale.department == "64":
        return Decimal("1500"), Decimal("3000"), Decimal("5200")
    return Decimal("1000"), Decimal("2200"), Decimal("3600")


def _score_amenities(sale: AuctionSale) -> ScoreComponent:
    points = Decimal("0")
    labels = []
    weights = (
        ("has_garden", "jardin", Decimal("3")),
        ("has_garage", "garage", Decimal("2")),
        ("has_terrace", "terrasse", Decimal("2")),
        ("has_pool", "piscine", Decimal("1")),
    )
    for flag_name, label, value in weights:
        if getattr(sale, flag_name):
            points += value
            labels.append(label)
    if sale.parking_count and sale.parking_count > 0 and not sale.has_garage:
        points += Decimal("1")
        labels.append("parking")
    points = min(points, Decimal("7"))
    confidence = Decimal("0.75") if labels else Decimal("0.55")
    return ScoreComponent(
        "atouts",
        points,
        ", ".join(labels) if labels else "aucun atout détecté",
        confidence=confidence,
        raw_value=labels,
        criterion="Les atouts d'usage améliorent la revente, la location ou la qualité d'occupation.",
        calculation=(
            f"Atouts retenus : {', '.join(labels)}. Total plafonné : {points:+} point(s)."
            if labels
            else "Aucun atout exploitable détecté dans les textes : 0 point."
        ),
        interpretation=(
            "Les équipements sont ajoutés uniquement lorsqu'ils sont explicitement détectés. "
            "Le plafond évite de survaloriser une simple accumulation de mots-clés."
        ),
        limits="L'absence d'atout détecté ne prouve pas son absence réelle ; elle signale seulement une donnée non trouvée.",
    )


def _score_risks(sale: AuctionSale, risks: list[dict[str, Any]]) -> ScoreComponent:
    penalty = sum(Decimal(str(row.get("severity", 1))) for row in risks)
    penalty = min(penalty, Decimal("18"))
    no_documents = not sale.documents
    labels = (
        ", ".join(row["risk_label"] for row in risks[:4])
        if risks
        else "aucun risque sourcé : pièces officielles absentes" if no_documents
        else "aucun risque contextualisé retenu"
    )
    if risks:
        confidence = sum((Decimal(str(row.get("confidence") or "0.7")) for row in risks), Decimal("0")) / Decimal(
            str(len(risks))
        )
    else:
        confidence = Decimal("0.25") if no_documents else Decimal("0.5")
    evidence = risks[0].get("evidence") if risks else None
    return ScoreComponent(
        "risques",
        -penalty,
        labels,
        confidence=confidence,
        evidence=evidence,
        raw_value=[r.get("risk_label") for r in risks],
        criterion="Les risques ne sont retenus que lorsqu'un contexte indique qu'ils concernent le bien, pas une clause générique.",
        calculation=(
            f"Somme des sévérités retenues ({_risk_penalty_breakdown(risks)}) plafonnée à -18 : {-penalty:+} point(s)."
            if risks
            else (
                "Aucune pièce officielle n'est disponible : le moteur ne peut pas conclure à l'absence de risque, "
                "il signale seulement qu'aucun risque n'est sourcé dans les données structurées : 0 point."
                if no_documents
                else "Aucun risque contextualisé retenu dans les pièces analysées : 0 point."
            )
        ),
        interpretation=(
            "Chaque risque est relié à un extrait et à un type de document lorsque la source est disponible. "
            "Les mentions génériques de cahier de vente ou les diagnostics listés sans résultat positif sont ignorés. "
            "Quand les pièces sont absentes, l'absence d'alerte ne vaut jamais absence de risque."
        ),
        limits="Un risque absent du scoring peut encore exister si le document n'a pas été extrait ou si l'OCR est incomplet.",
        evidence_refs=[_risk_to_evidence_ref(risk) for risk in risks[:3] if risk.get("evidence")],
    )


def _score_data_quality(sale: AuctionSale) -> ScoreComponent:
    penalties: list[tuple[Decimal, str]] = []
    flags = set(sale.quality_flags)
    contradictions = _analysis_contradictions(sale)
    if "ambiguous_surface" in flags:
        penalties.append((Decimal("5"), "surface ambiguë"))
    if "low_confidence_extraction" in flags:
        penalties.append((Decimal("4"), "extraction faible"))
    if "missing_gps" in flags:
        penalties.append((Decimal("3"), "GPS manquant"))
    if not sale.documents:
        penalties.append((Decimal("6"), "pièces officielles absentes"))
    if sale.rooms_count is None:
        penalties.append((Decimal("2"), "pièces manquantes"))
    if sale.bedrooms_count is None and sale.property_type in {"apartment", "house"}:
        penalties.append((Decimal("2"), "chambres manquantes"))
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        penalties.append((Decimal("3"), "occupation à confirmer"))
    if contradictions:
        penalties.append((min(Decimal(str(len(contradictions) * 2)), Decimal("5")), "contradictions à lever"))
    total_penalty = min(sum((points for points, _reason in penalties), Decimal("0")), Decimal("18"))
    reason = ", ".join(reason for _points, reason in penalties[:4]) if penalties else "données exploitables"
    confidence = Decimal("0.85") if not penalties else Decimal("0.55")
    return ScoreComponent(
        "qualité",
        -total_penalty,
        reason,
        confidence=confidence,
        raw_value=[_quality_flag_label(flag) for flag in sale.quality_flags],
        criterion="La qualité des données mesure la fiabilité minimale nécessaire pour utiliser le score.",
        calculation=(
            f"Pénalités qualité : {_quality_penalty_breakdown(penalties)}. Total plafonné à -18 : {-total_penalty:+} point(s)."
            if penalties
            else "Aucune pénalité qualité : 0 point."
        ),
        interpretation=(
            "Le score baisse quand les informations structurantes manquent ou semblent ambiguës, "
            "même si le bien paraît intéressant par ailleurs. Les corrections automatiques sont tracées "
            "comme des règles métier pour expliquer quelle information a été préférée et pourquoi."
        ),
        limits="Cette rubrique indique surtout ce qu'il faut vérifier avant de prendre une décision.",
        evidence_refs=_business_rule_refs(sale),
        axis="analysis_confidence",
        question="Les données et preuves sont-elles suffisantes pour utiliser le score ?",
    )


def _score_factor_payload(
    component: ScoreComponent,
    delta: Decimal,
    weight: Decimal,
    index: int,
    score_before: Decimal,
    score_after: Decimal,
) -> dict[str, Any]:
    axis = component.axis or _component_axis(component.name)
    explanation = _compact_dict(
        {
            "status": _factor_status(delta),
            "axis": axis,
            "axis_label": _axis_label(axis),
            "question": component.question or _component_question(component.name),
            "decision": _component_decision(component, delta),
            "criterion": component.criterion or _default_factor_criterion(component.name),
            "reasoning": component.interpretation or component.reason,
            "calculation": component.calculation or f"{component.points:+} x poids {weight} = {delta:+}",
            "score_before": float(score_before),
            "score_after": float(score_after),
            "confidence_note": _confidence_note(component.confidence),
            "limits": component.limits,
            "raw_value_label": _component_raw_fact_label(component),
            "facts": _component_facts(component),
            "proof_level": _proof_level(component),
        }
    )
    return {
        "factor_order": index,
        "factor_key": component.name,
        "label": component.name,
        "reason": component.reason,
        "base_points": float(component.points),
        "weight": float(weight),
        "delta": float(delta),
        "confidence": float(max(Decimal("0"), min(Decimal("1"), component.confidence))),
        "evidence": component.evidence,
        "raw_value": _json_safe(component.raw_value),
        "normalized_value": explanation,
        "evidence_refs": [_compact_dict(_json_safe(ref)) for ref in component.evidence_refs],
    }


def _score_confidence(sale: AuctionSale, components: list[ScoreComponent]) -> Decimal:
    if not components:
        return Decimal("0")
    average = sum((component.confidence for component in components), Decimal("0")) / Decimal(str(len(components)))
    penalty = Decimal("0")
    flags = set(sale.quality_flags)
    if "ambiguous_surface" in flags:
        penalty += Decimal("0.12")
    if "low_confidence_extraction" in flags:
        penalty += Decimal("0.1")
    if not sale.documents:
        penalty += Decimal("0.14")
    if sale.app_surface_m2 is None:
        penalty += Decimal("0.12")
    if not sale.occupancy_status:
        penalty += Decimal("0.06")
    contradictions = _analysis_contradictions(sale)
    if contradictions:
        penalty += min(Decimal("0.18"), Decimal("0.06") * Decimal(str(len(contradictions))))
    if _sale_type_context(sale).get("status") == "non_judicial":
        penalty += Decimal("0.03")
    confidence = max(Decimal("0"), min(Decimal("1"), average - penalty))
    return confidence.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _write_asset_payload(sale: AuctionSale, risks: list[dict[str, Any]]) -> None:
    sale.raw_payload["asset_normalization"] = {
        "features": build_auction_features_row(sale),
        "surfaces": build_auction_surfaces_row(sale),
        "risks": risks,
        "score_confidence": _float_or_none(sale.score_confidence),
        "score_factors": sale.score_factors,
        "investment_analysis": sale.raw_payload.get("investment_analysis"),
        "quality_flags": sale.quality_flags,
        "score_version": sale.score_version,
    }


def _build_premium_investment_analysis(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    components: list[ScoreComponent],
    factor_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    facts = _investment_facts(sale, risks)
    contradictions = _analysis_contradictions(sale)
    axes = _axis_summaries(factor_rows, risks, contradictions, sale)
    questions = _investment_questions(sale, risks, contradictions)
    headline = _premium_headline(sale, risks, contradictions)
    evidence_trace = _evidence_trace(sale, risks, factor_rows)
    return _compact_dict(
        {
            "version": PREMIUM_ANALYSIS_VERSION,
            "headline": headline,
            "deal_memo": _deal_memo_payload(sale, risks, contradictions, axes),
            "facts": facts,
            "axes": axes,
            "contradictions": contradictions,
            "questions": questions,
            "evidence_trace": evidence_trace,
            "confidence_gates": _confidence_gates(sale, risks, evidence_trace),
            "analysis_contract": {
                "principle": "Chaque conclusion doit être reliée à un fait, une source et un niveau de confiance.",
                "document_hierarchy": [
                    "diagnostics_techniques",
                    "pv_huissier",
                    "pv_notaire",
                    "cahier_conditions_vente",
                    "annonce_vente",
                    "source_listing",
                ],
                "llm_role": "analyste de contexte et de contradictions, pas source OCR unique",
                "llm_use": [
                    "relire les pages scannées utiles",
                    "classer les faits confirmés/infirmés/incertains",
                    "expliquer le raisonnement avec citation document + page",
                    "signaler les contradictions plutôt que trancher sans preuve",
                ],
            },
            "score_confidence": _float_or_none(sale.score_confidence),
            "score_components": len(components),
        }
    )


def _deal_memo_payload(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    axes: list[dict[str, Any]],
) -> dict[str, Any]:
    blockers = []
    if not sale.documents:
        blockers.append("Documents officiels absents ou non exploitables.")
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        blockers.append("Occupation à confirmer avant de calculer le scénario de sortie.")
    blockers.extend(
        f"{risk.get('risk_label')} à vérifier : {_risk_next_action(str(risk.get('risk_label') or ''))}"
        for risk in risks[:3]
    )
    strengths = []
    if sale.starting_price_eur is not None:
        strengths.append(f"Mise à prix connue : {_format_eur(sale.starting_price_eur)}.")
    if sale.app_surface_m2 is not None:
        strengths.append(f"Surface exploitable retenue : {_format_decimal(sale.app_surface_m2)} m2.")
    if sale.city:
        strengths.append(f"Localisation analysable : {sale.city}.")
    if not strengths:
        strengths.append("Aucun atout structurant n'est encore confirmé par les données.")
    price_ceiling_inputs = [
        "mise à prix",
        "frais d'adjudication",
        "travaux et diagnostics",
        "délai d'occupation",
        "marge de sécurité",
    ]
    return {
        "summary": _premium_headline(sale, risks, contradictions),
        "why_consider": strengths[:4],
        "why_be_careful": blockers[:5] or ["Aucun blocage majeur détecté, sous réserve de relire les pièces."],
        "before_bidding": _deal_memo_actions(sale, risks, contradictions),
        "price_ceiling_inputs": price_ceiling_inputs,
        "axis_snapshot": [
            {
                "axis": axis.get("axis"),
                "label": axis.get("label"),
                "status": axis.get("status"),
                "delta": axis.get("delta"),
                "reading": axis.get("reading"),
            }
            for axis in axes[:4]
        ],
    }


def _deal_memo_actions(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
) -> list[str]:
    actions = [
        "Définir un prix plafond tout compris avant l'audience.",
        "Relire les pièces officielles qui justifient les alertes.",
    ]
    if not sale.documents:
        actions.insert(0, "Récupérer le PV descriptif, le cahier de vente et les diagnostics.")
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        actions.append("Confirmer le statut d'occupation et le délai de jouissance.")
    if any(str(risk.get("risk_label")) == "travaux" for risk in risks):
        actions.append("Chiffrer un budget travaux avant de calculer la marge.")
    if any(str(risk.get("risk_label")) in {"amiante", "plomb", "termites", "DPE"} for risk in risks):
        actions.append("Lire le diagnostic technique concerné et distinguer obligation, information et coût réel.")
    if contradictions:
        actions.append("Lever les contradictions entre annonce, PV, cahier de vente et diagnostics.")
    return actions[:7]


def _evidence_trace(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    factor_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    trace: list[dict[str, Any]] = []
    if sale.surface_evidence:
        trace.append(
            {
                "kind": "surface",
                "status": "confirmed" if (sale.surface_confidence or Decimal("0")) >= Decimal("0.7") else "uncertain",
                "claim": f"Surface retenue : {_format_decimal(sale.app_surface_m2)} m2." if sale.app_surface_m2 else "Surface à confirmer.",
                "evidence": sale.surface_evidence,
                "confidence": _float_or_none(sale.surface_confidence),
                "decision": "Utilisée pour le prix au mètre carré si la nature de surface est compatible avec le bien.",
            }
        )
    for risk in risks[:8]:
        evidence_json = risk.get("evidence_json") if isinstance(risk.get("evidence_json"), dict) else {}
        trace.append(
            _compact_dict(
                {
                    "kind": "risk",
                    "status": evidence_json.get("risk_status") or "confirmed",
                    "claim": f"Risque retenu : {risk.get('risk_label')}.",
                    "evidence": risk.get("evidence"),
                    "document_label": evidence_json.get("document_label"),
                    "document_type": evidence_json.get("document_type"),
                    "page_number": evidence_json.get("page_number"),
                    "confidence": risk.get("confidence"),
                    "decision": evidence_json.get("reasoning"),
                    "next_action": evidence_json.get("next_action") or _risk_next_action(str(risk.get("risk_label") or "")),
                }
            )
        )
    for row in factor_rows:
        refs = row.get("evidence_refs")
        if not isinstance(refs, list) or not refs:
            continue
        trace.append(
            _compact_dict(
                {
                    "kind": "score_factor",
                    "status": row.get("normalized_value", {}).get("status")
                    if isinstance(row.get("normalized_value"), dict)
                    else None,
                    "claim": f"{row.get('factor_key')} : {row.get('reason')}",
                    "confidence": row.get("confidence"),
                    "decision": row.get("normalized_value", {}).get("decision")
                    if isinstance(row.get("normalized_value"), dict)
                    else None,
                    "evidence_refs": refs[:2],
                }
            )
        )
    return [_compact_dict(_json_safe(item)) for item in trace[:16]]


def _confidence_gates(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    evidence_trace: list[dict[str, Any]],
) -> dict[str, Any]:
    documents_count = len(sale.documents or [])
    sourced_risks = sum(1 for risk in risks if risk.get("evidence"))
    weak_points = []
    if documents_count == 0:
        weak_points.append("documents_absents")
        weak_points.append("analyse_source_uniquement")
    if sale.app_surface_m2 is None:
        weak_points.append("surface_absente")
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        weak_points.append("occupation_inconnue")
    if not evidence_trace:
        weak_points.append("preuves_absentes")
    readiness = "prêt à analyser"
    if weak_points:
        readiness = "pré-tri uniquement" if len(weak_points) >= 2 else "analyse à confirmer"
    return {
        "readiness": readiness,
        "documents_count": documents_count,
        "sourced_risks": sourced_risks,
        "evidence_items": len(evidence_trace),
        "weak_points": weak_points,
    }


def _investment_facts(sale: AuctionSale, risks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    sale_context = _sale_type_context(sale)
    if sale_context:
        facts.append(
            _fact(
                "legal",
                "type_de_vente",
                "confirmé" if sale_context.get("status") else "à confirmer",
                str(sale_context.get("statement") or "Type de vente à confirmer."),
                evidence=str(sale_context.get("evidence") or "") or None,
                confidence=float(sale_context.get("confidence") or 0.55),
            )
        )
    if sale.starting_price_eur is not None:
        facts.append(
            _fact(
                "financial",
                "mise_a_prix",
                "confirmé",
                f"Mise à prix : {_format_eur(sale.starting_price_eur)}.",
                confidence=0.88,
            )
        )
    if sale.app_surface_m2 is not None:
        facts.append(
            _fact(
                "asset",
                "surface_exploitable",
                "confirmé" if (sale.surface_confidence or Decimal("0")) >= Decimal("0.7") else "incertain",
                f"Surface retenue : {_format_decimal(sale.app_surface_m2)} m2 ({sale.app_surface_kind or 'nature à confirmer'}).",
                evidence=sale.surface_evidence,
                confidence=float(sale.surface_confidence or Decimal("0.55")),
            )
        )
    else:
        facts.append(
            _fact(
                "asset",
                "surface_exploitable",
                "absent",
                "Aucune surface exploitable fiable n'est retenue pour le calcul.",
                confidence=0.35,
            )
        )
    if sale.occupancy_status:
        facts.append(
            _fact(
                "legal",
                "occupation",
                "incertain" if sale.occupancy_status == "unknown" else "confirmé",
                f"Occupation : {_occupancy_status_label(sale.occupancy_status)}.",
                confidence=0.55 if sale.occupancy_status == "unknown" else 0.82,
            )
        )
    if sale.city or sale.department:
        facts.append(
            _fact(
                "liquidity",
                "localisation",
                "confirmé",
                "Localisation : " + ", ".join(filter(None, [sale.city, sale.department])) + ".",
                confidence=0.75 if sale.latitude is not None and sale.longitude is not None else 0.55,
            )
        )
    document_facts = _document_facts(sale)
    facts.extend(document_facts)
    for risk in risks[:6]:
        facts.append(
            _fact(
                "risk",
                f"risque_{risk.get('risk_label')}",
                "confirmé" if float(risk.get("confidence") or 0) >= 0.8 else "probable",
                f"Risque retenu : {risk.get('risk_label')}.",
                evidence=str(risk.get("evidence") or "") or None,
                confidence=float(risk.get("confidence") or 0.7),
                evidence_refs=[_risk_to_evidence_ref(risk)],
            )
        )
    return [_compact_dict(_json_safe(item)) for item in facts]


def _document_facts(sale: AuctionSale) -> list[dict[str, Any]]:
    if not sale.documents:
        return [
            _fact(
                "evidence",
                "documents",
                "absent",
                "Aucun document source n'est disponible dans le dossier structuré.",
                confidence=0.25,
            )
        ]
    type_counts: dict[str, int] = {}
    for document in sale.documents:
        document_type = _classify_document_label(str(document.get("label") or ""), str(document.get("url") or ""))
        type_counts[document_type] = type_counts.get(document_type, 0) + 1
    labels = ", ".join(f"{_document_context_label(key)} ({count})" for key, count in sorted(type_counts.items()))
    return [
        _fact(
            "evidence",
            "documents",
            "confirmé",
            f"Documents disponibles : {labels}.",
            confidence=0.72,
        )
    ]


def _axis_summaries(
    factor_rows: list[dict[str, Any]],
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    sale: AuctionSale,
) -> list[dict[str, Any]]:
    summaries = []
    for axis, definition in AXIS_DEFINITIONS.items():
        rows = [
            row
            for row in factor_rows
            if _component_axis(str(row.get("factor_key") or "")) == axis
        ]
        if not rows:
            continue
        delta = sum((Decimal(str(row.get("delta") or 0)) for row in rows), Decimal("0"))
        refs = []
        for row in rows:
            evidence_refs = row.get("evidence_refs")
            if isinstance(evidence_refs, list):
                refs.extend(item for item in evidence_refs if isinstance(item, dict))
        summaries.append(
            _compact_dict(
                {
                    "axis": axis,
                    "label": definition["label"],
                    "question": definition["question"],
                    "delta": float(delta),
                    "status": _factor_status(delta),
                    "reading": _axis_reading(axis, delta, risks, contradictions, sale),
                    "top_factors": [
                        {
                            "factor_key": row.get("factor_key"),
                            "reason": row.get("reason"),
                            "delta": row.get("delta"),
                        }
                        for row in sorted(rows, key=lambda item: abs(float(item.get("delta") or 0)), reverse=True)[:3]
                    ],
                    "evidence_refs": [_compact_dict(_json_safe(ref)) for ref in refs[:3]],
                }
            )
        )
    return summaries


def _investment_questions(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return [
        _question(
            "occupation",
            "Qui occupe réellement le bien au jour de l'audience ?",
            "à lever" if not sale.occupancy_status or sale.occupancy_status == "unknown" else "répondu",
            f"Statut actuel : {_occupancy_status_label(sale.occupancy_status)}.",
        ),
        _question(
            "surface",
            "Quelle surface doit servir au prix au m² ?",
            "répondu" if sale.app_surface_m2 is not None else "à lever",
            (
                f"Surface retenue : {_format_decimal(sale.app_surface_m2)} m2."
                if sale.app_surface_m2 is not None
                else "Aucune surface principale fiable."
            ),
        ),
        _question(
            "diagnostics",
            "Les diagnostics créent-ils une obligation, un coût ou seulement une information ?",
            (
                "à vérifier"
                if any(risk.get("risk_label") in {"amiante", "plomb", "termites", "DPE"} for risk in risks)
                else "à récupérer"
                if not sale.documents
                else "sans alerte"
            ),
            _diagnostic_question_detail(sale, risks),
        ),
        _question(
            "travaux",
            "Y a-t-il des travaux réellement rattachés au bien ?",
            (
                "à chiffrer"
                if any(risk.get("risk_label") == "travaux" for risk in risks)
                else "à confirmer"
                if not sale.documents
                else "sans alerte"
            ),
            (
                "Le texte source contient un signal travaux rattaché au bien."
                if any(risk.get("risk_label") == "travaux" for risk in risks)
                else "Les pièces officielles manquent : l'absence de signal travaux ne suffit pas à conclure."
                if not sale.documents
                else "Le moteur retient uniquement les mentions contextualisées, pas les clauses génériques."
            ),
        ),
        _question(
            "contradictions",
            "Des sources se contredisent-elles ?",
            "à lever" if contradictions else "répondu",
            f"{len(contradictions)} contradiction(s) ou incohérence(s) détectée(s)." if contradictions else "Aucune contradiction structurante détectée.",
        ),
    ]


def _analysis_contradictions(sale: AuctionSale) -> list[dict[str, Any]]:
    contradictions: list[dict[str, Any]] = []
    rules = sale.raw_payload.get("business_rules")
    if isinstance(rules, list):
        for rule in rules:
            if not isinstance(rule, dict):
                continue
            rule_id = str(rule.get("rule_id") or "")
            if rule_id in {"occupation_conflict_requires_confirmation", "property_type_from_specific_asset"}:
                contradictions.append(
                    _compact_dict(
                        {
                            "key": rule_id,
                            "status": "à lever" if "occupation" in rule_id else "résolu",
                            "label": rule.get("decision") or rule_id,
                            "reasoning": rule.get("reasoning"),
                            "impact": rule.get("impact"),
                            "evidence": rule.get("evidence"),
                            "confidence": rule.get("confidence"),
                        }
                    )
                )
    flags = set(sale.quality_flags)
    if "room_count_conflict" in flags:
        contradictions.append(
            {
                "key": "room_count_conflict",
                "status": "résolu_partiellement",
                "label": "Pièces/chambres incohérentes",
                "reasoning": "Le nombre de chambres dépassait le nombre de pièces. Le nombre de pièces a été neutralisé pour éviter un stockage incohérent.",
                "impact": "Le scoring baisse la confiance et demande de relire la composition exacte du bien.",
                "confidence": 0.82,
            }
        )
    if "ambiguous_surface" in flags:
        contradictions.append(
            {
                "key": "ambiguous_surface",
                "status": "à lever",
                "label": "Surface ambiguë",
                "reasoning": "Les surfaces détectées peuvent mélanger surface habitable, annexe, terrain ou surface cadastrale.",
                "impact": "Le prix au m² et la marge de sécurité ne sont pas fiables tant que la surface principale n'est pas confirmée.",
                "evidence": sale.surface_evidence,
                "confidence": float(sale.surface_confidence or Decimal("0.55")),
            }
        )
    return [_compact_dict(_json_safe(item)) for item in contradictions]


def _premium_headline(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
) -> str:
    score = sale.investment_score
    if score is None:
        return "Dossier à structurer avant lecture d'investissement."
    if not sale.documents:
        return "Pré-tri uniquement : pièces officielles absentes, lecture à confirmer."
    if contradictions:
        return "Dossier exploitable, mais des incohérences doivent être levées avant décision."
    if risks and score < Decimal("60"):
        return "Dossier risqué : les alertes documentées peuvent absorber la marge."
    if score >= Decimal("75"):
        return "Dossier potentiellement attractif, sous réserve de confirmer les preuves clés."
    if score >= Decimal("55"):
        return "Dossier intéressant mais dépendant de quelques vérifications structurantes."
    return "Dossier fragile : conserver une marge de sécurité élevée."


def _fact(
    category: str,
    key: str,
    status: str,
    statement: str,
    *,
    evidence: str | None = None,
    confidence: float | None = None,
    evidence_refs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "category": category,
        "key": key,
        "status": status,
        "statement": statement,
        "evidence": evidence,
        "confidence": confidence,
        "evidence_refs": evidence_refs or [],
    }


def _question(key: str, question: str, status: str, answer: str) -> dict[str, str]:
    return {"key": key, "question": question, "status": status, "answer": answer}


def _load_scoring_weights() -> dict[str, int | float | str]:
    path = ROOT_DIR / "config" / "scoring.json"
    defaults: dict[str, int | float | str] = {
        "version": "v1",
        "base_score": 50,
        "occupation": 1,
        "état": 1,
        "type": 1,
        "localisation": 1,
        "surface": 1,
        "prix_m2": 1,
        "atouts": 1,
        "risques": 1,
        "qualité": 1,
    }
    if not path.exists():
        return defaults
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return defaults
    if isinstance(payload, dict):
        defaults.update({key: value for key, value in payload.items() if isinstance(value, (int, float, str))})
    return defaults


def _set_app_surface(sale: AuctionSale) -> None:
    if sale.surface_scope == "partial":
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        return
    if sale.property_type == "apartment":
        sale.app_surface_m2 = sale.carrez_surface_m2 or sale.habitable_surface_m2
        if sale.app_surface_m2 is None:
            sale.app_surface_kind = None
        else:
            sale.app_surface_kind = "carrez" if sale.carrez_surface_m2 is not None else "habitable"
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type == "land":
        sale.app_surface_m2 = sale.land_surface_m2
        sale.app_surface_kind = "land" if sale.land_surface_m2 is not None else None
        sale.surface_scope = "land" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type in {"commercial", "mixed"}:
        sale.app_surface_m2 = sale.surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2 or sale.land_surface_m2
        sale.app_surface_kind = "land" if (
            sale.app_surface_m2 is not None
            and sale.surface_m2 is None
            and sale.habitable_surface_m2 is None
            and sale.carrez_surface_m2 is None
            and sale.land_surface_m2 is not None
        ) else "built" if sale.app_surface_m2 is not None else None
        sale.surface_scope = (
            "land" if sale.app_surface_kind == "land" else "total" if sale.app_surface_m2 is not None else sale.surface_scope
        )
    else:
        sale.app_surface_m2 = sale.habitable_surface_m2
        sale.app_surface_kind = "habitable" if sale.habitable_surface_m2 is not None else None
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope


def _validate_app_surface_scope(sale: AuctionSale) -> None:
    if sale.app_surface_m2 is None:
        return
    if sale.property_type in {"house", "building"} and sale.app_surface_m2 < Decimal("20"):
        sale.surface_scope = "room_or_annex"
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        _add_quality_flag(sale, "ambiguous_surface")
    elif (
        sale.property_type in {"commercial", "mixed", "other", "unknown"}
        and sale.app_surface_m2 > Decimal("1000")
        and not _large_non_residential_surface_is_supported(sale)
    ):
        sale.surface_scope = "unknown"
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        _add_quality_flag(sale, "ambiguous_surface")
    elif sale.property_type == "land":
        sale.surface_scope = "land"


def _large_non_residential_surface_is_supported(sale: AuctionSale) -> bool:
    context = clean_text(" ".join(filter(None, (sale.surface_evidence, sale.description, sale.raw_text)))) or ""
    if not context:
        return False
    if re.search(r"\b(?:cadastr|parcelle|terrain|contenance)\b", context, re.I) and not re.search(
        r"\b(?:surface\s+totale|b[âa]timent|stabulation|hangar|stockage|salle\s+de\s+traite|"
        r"local\s+(?:commercial|industriel)|entrep[oô]t|atelier)\b",
        context,
        re.I,
    ):
        return False
    return bool(
        re.search(
            r"\b(?:surface\s+totale|b[âa]timent|stabulation|hangar|stockage|salle\s+de\s+traite|"
            r"local\s+(?:commercial|industriel)|entrep[oô]t|atelier)\b",
            context,
            re.I,
        )
    )


def _flag_ambiguous_surface(sale: AuctionSale) -> None:
    surface_values = {
        value
        for value in (sale.habitable_surface_m2, sale.carrez_surface_m2, sale.land_surface_m2)
        if value is not None
    }
    if len(surface_values) > 1 and sale.property_type not in {"house", "building"}:
        _add_quality_flag(sale, "ambiguous_surface")
    if sale.app_surface_m2 is None and sale.surface_m2 is not None:
        _add_quality_flag(sale, "ambiguous_surface")


def _extract_count(text: str, patterns: tuple[str, ...]) -> int | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            value = match.group(1)
            return int(value) if value.isdigit() else _number_word_to_int(value)
    return None


def _extract_built_surface(text: str, sale: AuctionSale | None = None) -> Decimal | None:
    patterns = (
        rf"superficie\s+au\s+sol\s+(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"d['’]une\s+superficie\s+au\s+sol\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|hangar)\b.{{0,80}}?"
        rf"d['’]une\s+superficie\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:ensemble\s+immobilier|propri[ée]t[ée])"
        rf"(?:\s+de\s+[0-9]+\s+pi[eè]ces?)?\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"d['’]une\s+superficie\s+d['’]environ\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"surface\s+au\s+sol\s+(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\btotal\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\*)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        value = _parse_surface_decimal(match.group(1))
        if value and not _surface_false_positive(text, match.start(), match.end()):
            if sale is not None:
                _set_surface_evidence(sale, "built_surface_text", _evidence(text, match.start(), match.end()))
            return value
    return None


def _infer_rooms_count(text: str, sale: AuctionSale) -> int | None:
    if re.search(r"\bstudio\b|\bT\s*1\b|\btype\s*1\b", text, re.I):
        return 1
    if not sale.bedrooms_count or sale.property_type not in {"house", "apartment", "building"}:
        return None
    living_rooms = 0
    if re.search(r"\bs[ée]jour\b|\bsalon\b|\bpi[eè]ce\s+principale\b", text, re.I):
        living_rooms = 1
    if re.search(r"\bsalle\s+[àa]\s+manger\b", text, re.I):
        living_rooms += 1
    extra_rooms = 0
    match = re.search(r"\b(?:mezzanine|combles?|annexe)\s+(?:avec|comprenant)\s+((?:une|deux|trois|[1-9]))\s+pi[eè]ces?\b", text, re.I)
    if match:
        extra_rooms = _number_word_to_int(match.group(1)) or 0
    if living_rooms or extra_rooms:
        return sale.bedrooms_count + max(living_rooms, 1) + extra_rooms
    return None


def _number_word_to_int(value: str) -> int | None:
    lowered = value.lower()
    mapping = {
        "une": 1,
        "un": 1,
        "deux": 2,
        "trois": 3,
        "quatre": 4,
        "cinq": 5,
        "six": 6,
        "sept": 7,
        "huit": 8,
        "neuf": 9,
        "dix": 10,
    }
    if lowered in mapping:
        return mapping[lowered]
    if lowered.isdigit():
        return int(lowered)
    return None


def _sale_text(sale: AuctionSale) -> str:
    return clean_text(" ".join(filter(None, [sale.title, sale.description, sale.risk_notes, sale.raw_text]))) or ""


def _risk_source_text(sale: AuctionSale) -> str:
    return clean_text(" ".join(filter(None, [sale.title, sale.description, sale.raw_text]))) or ""


def _sale_type_context(sale: AuctionSale) -> dict[str, object]:
    text = _sale_text(sale)
    if not text:
        return {}
    non_judicial = re.search(
        r"\bvente\s+volontaire\b|\bvente\s+notariale\b|\bvente\s+notariale\s+interactive\b|"
        r"\bimmo[-\s]?interactif\b|\ben\s+ligne\s+sur\s+immo[-\s]?interactif\b|"
        r"\boffice\s+notarial\b|\bnotaire\b",
        text,
        re.I,
    )
    if non_judicial:
        return {
            "status": "non_judicial",
            "statement": "Type de vente : vente volontaire/notariale interactive, à ne pas assimiler à une adjudication judiciaire.",
            "evidence": _evidence(text, non_judicial.start(), non_judicial.end()),
            "confidence": 0.82,
        }
    explicit_judicial = re.search(
        r"\btribunal\s+judiciaire\b|\bTJ\s+[A-Za-zÀ-ÿ' -]+\b|"
        r"\badjudication\b|\bsaisie\s+immobili[èe]re\b|"
        r"\bcahier\s+des\s+conditions\s+de\s+vente\b",
        text,
        re.I,
    )
    if explicit_judicial:
        return {
            "status": "judicial",
            "statement": "Type de vente : contexte judiciaire ou adjudication identifié.",
            "evidence": _evidence(text, explicit_judicial.start(), explicit_judicial.end()),
            "confidence": 0.78,
        }
    return {}


def _text_has_works_signal(text: str) -> bool:
    return bool(
        re.search(
            r"\b(?:pr[ée]voir|prevoir)\s+(?:des\s+)?travaux\b|"
            r"\btravaux\s+(?:de\s+)?r[ée]novation\b|"
            r"\b[àa]\s+r[ée]nover\b|\ba\s+renover\b|"
            r"\br[ée]novation\s+[àa]\s+pr[ée]voir\b|"
            r"\bmauvais\s+[ée]tat\b|\bd[ée]grad[ée]s?\b|\bv[ée]tuste\b",
            text,
            re.I,
        )
    )


def _surface_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 20) : min(len(text), end + 30)]
    return bool(re.search(r"\bkwh\b|kg\s*co2|\bges\b|dpe\b", context, re.I))


def _land_surface_false_positive(text: str, match: re.Match[str], kind: str) -> bool:
    if kind != "land_surface_m2":
        return False
    matched_text = text[match.start() : match.end()]
    value_start = match.start(1)
    value_end = match.end(1)
    before_value = text[max(match.start(), value_start - 45) : value_start]
    after_value = text[value_end : min(len(text), value_end + 25)]
    return bool(
        re.search(r"\b(?:maison|villa|appartement|immeuble|b[âa]timent|local|hangar)\s+de\s*$", before_value, re.I)
        or re.search(
            rf"\b(?:maison|villa|appartement|immeuble|b[âa]timent|local|hangar)\b.{{0,60}}?"
            rf"\b(?:de|d['’]une\s+surface\s+de|d['’]une\s+superficie\s+de)\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
            matched_text,
            re.I | re.S,
        )
        or
        re.search(
            r"\b(?:surface|superficie)\s+(?:habitable|carrez)\b|\bloi\s+carrez\b",
            before_value,
            re.I,
        )
        or re.search(r"\bhabitables?\b", after_value, re.I)
    )


def _living_surface_false_positive(text: str, start: int, end: int, kind: str) -> bool:
    if kind == "land_surface_m2":
        return False
    context = text[max(0, start - 45) : start]
    return bool(re.search(r"\b(?:terrain|parcelle|jardin|garage|cave|parking|stationnement|d[ée]pendance)\b", context, re.I))


def _parse_surface_decimal(value: str) -> Decimal | None:
    return parse_surface(value)


def _set_surface_evidence(sale: AuctionSale, source: str, evidence: str | None) -> None:
    if sale.surface_source is None:
        sale.surface_source = source
    if sale.surface_confidence is None:
        sale.surface_confidence = Decimal("0.8") if evidence else Decimal("0.55")
    if evidence and sale.surface_evidence is None:
        sale.surface_evidence = evidence


def _normalize_document_type(document_type: str | None, source_kind: str) -> str:
    raw = (clean_text(document_type) or "").lower().replace("-", "_").replace(" ", "_")
    if source_kind == "sale_text" and raw in {"", "none", "null"}:
        return "source_listing"
    aliases = {
        "pv_descriptif": "pv_huissier",
        "pvd": "pv_huissier",
        "pv": "proces_verbal",
        "constat": "pv_huissier",
        "diagnostics": "diagnostics_techniques",
        "diagnostic": "diagnostics_techniques",
        "avis_simplifie": "annonce_vente",
        "avis_simplifié": "annonce_vente",
        "insertion_legale": "annonce_vente",
        "insertion_légale": "annonce_vente",
        "cahier_conditions": "cahier_conditions_vente",
        "ccv": "cahier_conditions_vente",
    }
    return aliases.get(raw, raw or ("source_listing" if source_kind == "sale_text" else "pdf"))


def _risk_context_decision(
    label: str,
    context: str,
    *,
    source_kind: str,
    document_type: str,
) -> dict[str, object]:
    if not context:
        return {"accepted": False, "confidence": 0.0}
    if _is_generic_context(context, label, document_type):
        return {"accepted": False, "confidence": 0.0}

    if label == "DPE":
        accepted = _dpe_context_is_risky(context)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.84"), source_kind, document_type, accepted),
            "severity": 2,
        }
    if label in {"amiante", "plomb", "termites"}:
        accepted = _hazard_context_is_positive(label, context)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.86"), source_kind, document_type, accepted),
            "severity": 3,
        }
    if label == "travaux":
        severity = _works_severity(context)
        accepted = severity > 0
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.78"), source_kind, document_type, accepted),
            "severity": severity or 4,
        }
    if label == "servitude":
        accepted = _servitude_context_is_specific(context, document_type)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.8"), source_kind, document_type, accepted),
            "severity": 2,
        }
    if label == "copropriété":
        accepted = _copro_context_is_specific(context, document_type)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.72"), source_kind, document_type, accepted),
            "severity": 1,
        }
    if label == "occupation":
        accepted = _occupation_context_is_specific(context)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.82"), source_kind, document_type, accepted),
            "severity": 5,
        }
    return {"accepted": False, "confidence": 0.0}


def _contextual_confidence(base: Decimal, source_kind: str, document_type: str, accepted: bool) -> float:
    if not accepted:
        return 0.0
    confidence = base
    if source_kind == "pdf":
        confidence += Decimal("0.04")
    if document_type in {"pv_huissier", "diagnostics_techniques", "annonce_vente"}:
        confidence += Decimal("0.04")
    if document_type in {"cahier_conditions_vente", "conditions_vente", "pdf"}:
        confidence -= Decimal("0.05")
    return float(max(Decimal("0"), min(Decimal("0.96"), confidence)))


def _is_generic_context(context: str, label: str, document_type: str) -> bool:
    lowered = context.lower()
    if re.search(
        r"renseignements\s+ci-dessus.{0,80}servitudes?.{0,80}sans\s+aucune\s+garantie|"
        r"d[ée]signation\s+de\s+l['’]immeuble.{0,120}servitudes?.{0,120}proc[èe]s\s+verbal|"
        r"bon\s+ou\s+mauvais\s+[ée]tat\s+de\s+l['’]immeuble|"
        r"pour\s+les\s+parties\s+communes\s+des\s+immeubles\s+soumis",
        lowered,
        re.I,
    ):
        return True
    if label in {"amiante", "plomb", "termites"} and _diagnostic_context_is_only_inventory(lowered):
        return True
    if label in {"copropriété", "servitude", "travaux"} and re.search(
        r"\b(?:si|dans\s+le\s+cas\s+(?:o[uù]|on|\w{1,3}\s+\w?immeuble)|dans\s+l['’]hypoth[eè]se|le\s+cas\s+[ée]ch[ée]ant)\b"
        r".{0,120}\b(?:copropri[ée]t[ée]|servitudes?|travaux|lotissement)\b",
        lowered,
        re.I,
    ):
        return True
    generic_legal = bool(
        re.search(
            r"\b(?:article|chapitre|conditions?\s+pour\s+ench[ée]rir|r[èe]glement\s+int[ée]rieur|"
            r"l['’]adjudicataire|l['’]acqu[ée]reur|frais\s+de\s+vente|distribution\s+du\s+prix|"
            r"devra\s+notifier|sera\s+tenu|se\s+reporter|s['’]imposeront)\b",
            lowered,
            re.I,
        )
    )
    if not generic_legal:
        return False
    if document_type in {"pv_huissier", "diagnostics_techniques", "annonce_vente", "source_listing"}:
        return False
    return not _has_specific_property_assertion(lowered, label)


def _diagnostic_context_is_only_inventory(context: str) -> bool:
    return bool(
        re.search(
            r"(?:diagnostics?|annexes?|pi[eè]ces?).{0,140}"
            r"(?:amiante|plomb|termites).{0,140}"
            r"(?:diagnostics?|annexes?|constat|rep[ée]rage|exposition|performance\s+[ée]nerg[ée]tique)",
            context,
            re.I,
        )
    ) and not re.search(r"pr[ée]sence|positif|d[ée]tect[ée]|rep[ée]r[ée]|contient|contiennent|infestation", context, re.I)


def _has_specific_property_assertion(context: str, label: str) -> bool:
    if label == "copropriété":
        return bool(
            re.search(
                r"(?:soumis|d[ée]pend|d[ée]nomm[ée]|lot\s+(?:num[ée]ro|n[°o])|tanti[eè]mes).{0,90}"
                r"copropri[ée]t[ée]",
                context,
                re.I,
            )
        )
    if label == "servitude":
        return _servitude_context_is_specific(context, "cahier_conditions_vente")
    if label == "travaux":
        return _works_severity(context) > 0
    return False


def _risk_match_is_negated(text: str, start: int, end: int, label: str) -> bool:
    if label == "occupation":
        return False
    before = text[max(0, start - 90) : start].lower()
    context = text[max(0, start - 90) : min(len(text), end + 90)].lower()
    negation_patterns = (
        r"aucun(?:e|es|s)?\s+\w{0,25}$",
        r"absence\s+(?:de|d['’])\s*\w{0,25}$",
        r"pas\s+de\s+\w{0,25}$",
        r"sans\s+\w{0,25}$",
        r"n['’]est\s+pas\s+soumis.{0,45}$",
    )
    if any(re.search(pattern, before, re.I) for pattern in negation_patterns):
        return True
    label_patterns = {
        "servitude": r"aucune\s+servitude|absence\s+de\s+servitude|servitude\s+non\s+mentionn[ée]e",
        "copropriété": r"pas\s+soumis\s+au\s+r[ée]gime\s+de\s+la\s+copropri[ée]t[ée]|non\s+soumis\s+.*copropri[ée]t[ée]",
        "amiante": r"absence\s+d['’]amiante|sans\s+amiante|amiante\s*:\s*non",
        "plomb": (
            r"absence\s+de\s+plomb|sans\s+plomb|plomb\s*:\s*non|crep\s*:\s*non|"
            r"ne\s+constate\s+pas.{0,120}rev[êe]tements?\s+d[ée]grad[ée]s?.{0,80}plomb|"
            r"pas\s+de\s+rev[êe]tements?\s+d[ée]grad[ée]s?.{0,80}plomb|"
            r"ne\s*d[ée]passe\s*pas.{0,80}(?:plafond|seuil)|"
            r"quantit[ée].{0,80}ne\s*d[ée]passe\s*pas.{0,80}(?:plafond|seuil)|"
            r"inf[ée]rieur(?:e)?\s+(?:au|aux)\s+(?:plafond|seuil)"
        ),
        "termites": r"absence\s+de\s+termites?|sans\s+termites?|termites?\s*:\s*non|non\s+termite",
        "travaux": r"aucun\s+travaux|pas\s+de\s+travaux|sans\s+travaux",
    }
    pattern = label_patterns.get(label)
    if pattern and re.search(pattern, context, re.I):
        return True
    if label in {"amiante", "plomb", "termites"} and re.search(
        r"(?:n['’]a\s+pas\s+[ée]t[ée]\s+(?:rep[ée]r[ée]|constat[ée]|d[ée]tect[ée])|"
        r"non\s+(?:d[ée]tect[ée]|rep[ée]r[ée]|concern[ée])|"
        r"il\s+n['’]a\s+pas\s+[ée]t[ée]\s+rep[ée]r[ée])",
        context,
        re.I,
    ):
        return True
    return False


def _hazard_context_is_positive(label: str, context: str) -> bool:
    if _risk_match_is_negated(context, 0, len(context), label):
        return False
    patterns = {
        "amiante": (
            r"(?:pr[ée]sence|positif|d[ée]tect[ée]|rep[ée]r[ée]|contient|contiennent).{0,100}amiante|"
            r"amiante.{0,100}(?:pr[ée]sent|positif|d[ée]tect[ée]|rep[ée]r[ée]|contient|contiennent)"
        ),
        "plomb": (
            r"(?:pr[ée]sence|positif|concentration|rev[êe]tements?).{0,100}plomb|"
            r"plomb.{0,100}(?:pr[ée]sent|positif|d[ée]tect[ée]|sup[ée]rieur|classe\s*[1-4])"
        ),
        "termites": (
            r"(?:pr[ée]sence|indices?|infestation|attaque).{0,100}termites?|"
            r"termites?.{0,100}(?:pr[ée]sence|indices?|infestation|attaque)"
        ),
    }
    return bool(re.search(patterns[label], context, re.I))


def _works_severity(context: str) -> int:
    if re.search(
        r"gros\s+travaux|travaux\s+(?:lourds|importants|structurels|de\s+remise\s+en\s+[ée]tat|"
        r"n[ée]cessaires?)|ruine|insalubre|hors\s+d['’]eau|effondr|"
        r"infiltrations?\s+d['’]eau|d[ée]g[aâ]t\s+des\s+eaux",
        context,
        re.I,
    ):
        return 5
    if re.search(
        r"(?:pr[ée]voir|prevoir)\s+(?:des\s+)?travaux|"
        r"travaux\s+(?:[àa]\s+pr[ée]voir|de\s+r[ée]novation)|"
        r"[àa]\s+r[ée]nover|a\s+renover|"
        r"r[ée]novation\s+(?:compl[eè]te|importante|[àa]\s+pr[ée]voir)",
        context,
        re.I,
    ):
        return 4
    if re.search(
        r"mauvais\s+[ée]tat|fortement\s+d[ée]grad[ée]|d[ée]gradations?|v[ée]tuste|"
        r"rouill[ée]|moisi|fissures?|hors\s+service|arrach[ée]|affaiss[ée]|"
        r"travaux\s+futurs|remise\s+en\s+[ée]tat",
        context,
        re.I,
    ):
        return 4
    if re.search(r"rafra[iî]chissement|r[ée]novation\s+[àa]\s+pr[ée]voir", context, re.I):
        return 3
    return 0


def _servitude_context_is_specific(context: str, document_type: str) -> bool:
    if _risk_match_is_negated(context, 0, len(context), "servitude"):
        return False
    if re.search(r"\bservitudes?\s+(?:de\s+passage|d['’]utilit[ée]\s+publique|conventionnelle|grevant|active|passive)\b", context, re.I):
        return True
    if re.search(r"\b(?:grev[ée]|b[ée]n[ée]ficie|affect[ée]|supporte).{0,90}\bservitudes?\b", context, re.I):
        return True
    if document_type in {"cahier_conditions_vente", "conditions_vente"} and re.search(
        r"\bservitudes?\s+(?:suivantes?|mentionn[ée]es?|existant|publi[ée]es?)\b",
        context,
        re.I,
    ):
        return True
    return False


def _copro_context_is_specific(context: str, document_type: str) -> bool:
    if _risk_match_is_negated(context, 0, len(context), "copropriété"):
        return False
    if re.search(r"charges?\s+de\s+copropri[ée]t[ée]\s+(?:impay[ée]es?|dues?|annuelles?)", context, re.I):
        return True
    if re.search(
        r"(?:soumis|d[ée]pend|fait\s+partie|d[ée]nomm[ée]|ensemble\s+immobilier).{0,100}"
        r"copropri[ée]t[ée]",
        context,
        re.I,
    ):
        return True
    if re.search(r"\blot\s+(?:num[ée]ro|n[°o])\b.{0,140}\b(?:tanti[eè]mes|parties\s+communes)\b", context, re.I):
        return True
    return document_type in {"annonce_vente", "source_listing", "pv_huissier"} and bool(
        re.search(r"\b(?:tanti[eè]mes|syndic|parties\s+communes)\b", context, re.I)
    )


def _occupation_context_is_specific(context: str) -> bool:
    return bool(
        re.search(
            r"occup[ée].{0,80}(?:sans\s+bail|sans\s+droit\s+ni\s+titre|par\s+les?\s+propri[ée]taires?|"
            r"locataire|preneur)|"
            r"(?:bail|locataire|preneur|loyer).{0,100}(?:en\s+cours|actuel|occup|sign[ée])|"
            r"squatt",
            context,
            re.I,
        )
    )


def _dpe_context_is_risky(context: str) -> bool:
    return bool(
        re.search(
            r"\b(?:classe\s*)?[FG]\b|dpe\s*[:=-]?\s*[FG]\b|passoire|d[ée]favorable|"
            r"consommation\s+(?:excessive|tr[èe]s\s+[ée]lev[ée]e)|[ée]nergivore",
            context,
            re.I,
        )
    )


def _risk_occurrence_rank(occurrence: dict[str, Any]) -> tuple[int, float, int]:
    evidence_json = occurrence.get("evidence_json") if isinstance(occurrence.get("evidence_json"), dict) else {}
    document_type = occurrence.get("document_type") or evidence_json.get("document_type")
    return (
        int(occurrence.get("severity") or 1),
        float(occurrence.get("confidence") or 0),
        _document_type_weight(str(document_type or "")),
    )


def _document_type_weight(document_type: str) -> int:
    return {
        "diagnostics_techniques": 6,
        "pv_huissier": 6,
        "pv_notaire": 5,
        "proces_verbal": 5,
        "annonce_vente": 4,
        "source_listing": 3,
        "cahier_conditions_vente": 3,
        "conditions_vente": 2,
        "pdf": 1,
    }.get(document_type, 0)


def _document_context_label(document_type: object | None) -> str:
    value = str(document_type or "")
    return {
        "source_listing": "page de l'annonce",
        "annonce_vente": "annonce ou insertion légale",
        "pv_huissier": "PV descriptif / commissaire de justice",
        "pv_notaire": "PV de notaire",
        "proces_verbal": "procès-verbal",
        "cahier_conditions_vente": "cahier des conditions de vente",
        "conditions_vente": "conditions de vente",
        "diagnostics_techniques": "diagnostics techniques",
        "bail": "bail ou document d'occupation",
        "procedure_saisie": "procédure de saisie",
        "cadastre": "cadastre ou plan",
        "pdf": "document PDF",
    }.get(value, "document source")


def _risk_reasoning(label: str, occurrence: dict[str, Any]) -> str:
    document_context = _document_context_label(occurrence.get("document_type"))
    matched_terms = occurrence.get("matched_terms") or []
    term = f" Terme déclencheur : {matched_terms[0]}." if isinstance(matched_terms, list) and matched_terms else ""
    specific = {
        "travaux": "La mention décrit un désordre, une dégradation ou une remise en état concernant le bien.",
        "amiante": "La mention indique une présence, un repérage positif ou un matériau contenant de l'amiante.",
        "plomb": "La mention indique une présence ou concentration de plomb, pas seulement l'existence d'un CREP.",
        "termites": "La mention indique une présence, des indices ou une infestation de termites.",
        "DPE": "La mention rattache le bien à une classe énergétique défavorable ou à une consommation excessive.",
        "servitude": "La mention décrit une servitude précise grevant ou concernant le bien.",
        "copropriété": "La mention rattache le lot à un régime de copropriété ou à des tantièmes/charges.",
        "occupation": "La mention décrit une occupation, un bail, un locataire ou une occupation sans droit.",
    }.get(label, "La mention est retenue parce qu'elle est suffisamment contextualisée.")
    return f"{specific} Source analysée : {document_context}.{term}"


def _risk_why_it_matters(label: str, severity: int) -> str:
    impact = {
        "travaux": "Peut créer un budget travaux, un délai de revente et une incertitude sur la marge.",
        "amiante": "Peut imposer diagnostics complémentaires, retrait ou précautions en cas de travaux.",
        "plomb": "Peut contraindre les travaux et la location, notamment dans les logements anciens.",
        "termites": "Peut signaler un risque structurel ou un coût de traitement.",
        "DPE": "Peut limiter la location, augmenter les travaux énergétiques et réduire la liquidité.",
        "servitude": "Peut limiter l'usage, l'accès, la constructibilité ou la revente.",
        "copropriété": "Impose de vérifier charges, règlement, travaux votés et situation du syndicat.",
        "occupation": "Peut retarder la jouissance, la revente ou la relocation.",
    }.get(label, "Peut modifier le coût, le délai ou la liquidité du projet.")
    return impact


def _risk_status(label: str, occurrence: dict[str, Any]) -> str:
    confidence = float(occurrence.get("confidence") or 0)
    document_type = str(occurrence.get("document_type") or "")
    if label in {"amiante", "plomb", "termites", "DPE"} and document_type == "diagnostics_techniques":
        return "confirmed" if confidence >= 0.78 else "probable"
    if label == "travaux":
        return "to_quantify" if confidence >= 0.7 else "probable"
    if label in {"occupation", "servitude"}:
        return "to_verify" if confidence < 0.88 else "confirmed"
    if document_type in {"cahier_conditions_vente", "conditions_vente"}:
        return "property_specific_clause"
    return "confirmed" if confidence >= 0.82 else "probable"


def _source_status(occurrence: dict[str, Any]) -> str:
    document_type = str(occurrence.get("document_type") or "")
    if document_type in {"diagnostics_techniques", "pv_huissier", "pv_notaire", "proces_verbal"}:
        return "source_probante"
    if document_type in {"cahier_conditions_vente", "conditions_vente"}:
        return "source_juridique_a_recontextualiser"
    if document_type in {"annonce_vente", "source_listing"}:
        return "source_de_presentation"
    return "source_a_identifier"


def _risk_decision_chain(label: str, occurrence: dict[str, Any]) -> list[dict[str, str]]:
    document_type = str(occurrence.get("document_type") or "")
    matched_terms = occurrence.get("matched_terms") if isinstance(occurrence.get("matched_terms"), list) else []
    trigger = str(matched_terms[0]) if matched_terms else label
    return [
        {
            "step": "document",
            "decision": _document_context_label(document_type),
        },
        {
            "step": "indice",
            "decision": f"Terme ou expression repéré : {trigger}.",
        },
        {
            "step": "contexte",
            "decision": _risk_reasoning(label, occurrence),
        },
        {
            "step": "impact",
            "decision": _risk_why_it_matters(label, int(occurrence.get("severity") or 1)),
        },
        {
            "step": "action",
            "decision": _risk_next_action(label),
        },
    ]


def _risk_verification_priority(label: str, severity: int) -> str:
    if severity >= 5 or label == "occupation":
        return "bloquant_avant_enchere"
    if label in {"travaux", "amiante", "plomb", "termites", "servitude"}:
        return "a_verifier_avant_prix_plafond"
    return "a_controler_dans_lecture_complete"


def _risk_next_action(label: str) -> str:
    return {
        "travaux": "Chiffrer les travaux avec une marge de sécurité avant de fixer le prix plafond.",
        "amiante": "Relire le repérage amiante et vérifier si un retrait ou des précautions travaux sont nécessaires.",
        "plomb": "Relire le CREP et vérifier si la présence de plomb crée une obligation ou un coût.",
        "termites": "Relire l'état termites et vérifier le périmètre exact de l'infestation ou des indices.",
        "DPE": "Vérifier la classe énergétique, les interdictions locatives éventuelles et le budget de rénovation.",
        "servitude": "Identifier la servitude exacte et son impact sur l'usage, l'accès ou la revente.",
        "copropriété": "Contrôler charges, règlement, travaux votés et situation du syndicat.",
        "occupation": "Confirmer le titre d'occupation, le bail, le loyer et le délai de libération.",
    }.get(label, "Relire la pièce source complète et valider l'impact avant enchère.")


def _risk_confidence(label: str, context: str, source_kind: str) -> float:
    confidence = Decimal("0.72")
    if source_kind == "pdf":
        confidence += Decimal("0.08")
    if label in {"amiante", "plomb", "termites"} and re.search(r"diagnostic|constat|rapport|rep[ée]rage", context, re.I):
        confidence += Decimal("0.08")
    if label == "servitude" and re.search(r"servitude\s+(?:de\s+passage|publique|grev|liee|li[ée]e)", context, re.I):
        confidence += Decimal("0.08")
    if label == "travaux" and re.search(r"ruine|hors\s+d['’]eau|d[ée]g[aâ]ts?|r[ée]novation|v[ée]tuste", context, re.I):
        confidence += Decimal("0.08")
    return float(max(Decimal("0"), min(Decimal("0.96"), confidence)))


def _risk_severity(label: str) -> int:
    return {
        "occupation": 5,
        "amiante": 3,
        "plomb": 3,
        "termites": 3,
        "travaux": 4,
        "servitude": 2,
        "copropriété": 1,
        "DPE": 1,
    }.get(label, 1)


def _evidence(text: str, start: int, end: int, *, window: int = 120) -> str:
    return clean_text(text[max(0, start - 80) : min(len(text), end + window)]) or ""


def _factor_status(delta: Decimal) -> str:
    if delta > 0:
        return "favorable"
    if delta < 0:
        return "vigilance"
    return "neutre"


def _component_axis(name: str) -> str:
    normalized = name.lower()
    return FACTOR_AXIS.get(normalized, "analysis_confidence")


def _axis_label(axis: str) -> str:
    definition = AXIS_DEFINITIONS.get(axis)
    return str(definition.get("label")) if definition else "Analyse"


def _component_question(name: str) -> str:
    axis = _component_axis(name)
    definition = AXIS_DEFINITIONS.get(axis)
    if definition:
        return str(definition.get("question"))
    return "Que signifie ce facteur pour la décision d'enchérir ?"


def _component_decision(component: ScoreComponent, delta: Decimal) -> str:
    if delta > 0:
        prefix = "Signal favorable"
    elif delta < 0:
        prefix = "Point de vigilance"
    else:
        prefix = "Signal neutre"
    return f"{prefix} : {component.reason}."


def _component_facts(component: ScoreComponent) -> list[dict[str, Any]]:
    facts = []
    if component.raw_value is not None:
        facts.append(
            {
                "status": "retenu",
                "statement": _component_raw_fact_label(component),
                "confidence": float(component.confidence),
            }
        )
    if component.evidence:
        facts.append(
            {
                "status": "preuve",
                "statement": component.evidence,
                "confidence": float(component.confidence),
            }
        )
    for ref in component.evidence_refs[:2]:
        if not isinstance(ref, dict):
            continue
        facts.append(
            _compact_dict(
                {
                    "status": "preuve",
                    "statement": ref.get("excerpt") or ref.get("label"),
                    "document_label": ref.get("document_label"),
                    "document_type": ref.get("document_type"),
                    "page_number": ref.get("page_number"),
                    "confidence": ref.get("confidence"),
                }
            )
        )
    return [_compact_dict(_json_safe(item)) for item in facts]


def _proof_level(component: ScoreComponent) -> str:
    if component.evidence_refs:
        document_types = {str(ref.get("document_type") or "") for ref in component.evidence_refs if isinstance(ref, dict)}
        if document_types & {"diagnostics_techniques", "pv_huissier", "pv_notaire", "proces_verbal"}:
            return "preuve forte"
        return "preuve sourcée"
    if component.evidence:
        return "preuve textuelle"
    if component.raw_value is not None:
        return "donnée structurée"
    return "à confirmer"


def _axis_reading(
    axis: str,
    delta: Decimal,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    sale: AuctionSale,
) -> str:
    if axis == "financial_attractiveness":
        return (
            "La mise à prix semble créer une marge de sécurité."
            if delta > 0
            else "La lecture financière reste fragile sans surface ou prix/m² favorable."
        )
    if axis == "asset_quality":
        technical = [risk.get("risk_label") for risk in risks if risk.get("risk_type") == "physical"]
        if technical:
            return f"Qualité à vérifier : {', '.join(str(item) for item in technical[:4])}."
        if not sale.documents:
            return "Aucun risque technique sourcé, mais les pièces officielles manquent pour conclure."
        return "Aucun risque technique contextualisé majeur n'est retenu."
    if axis == "legal_security":
        legal = [risk.get("risk_label") for risk in risks if risk.get("risk_type") == "legal"]
        if legal:
            return f"Contraintes juridiques à clarifier : {', '.join(str(item) for item in legal[:4])}."
        if not sale.documents:
            return "Aucune contrainte juridique sourcée, mais le statut doit être confirmé dans les pièces."
        return "Pas de contrainte juridique forte détectée dans les faits structurés."
    if axis == "liquidity_resale":
        return "La sortie dépend surtout du type de bien et de la profondeur du marché local."
    if axis == "analysis_confidence":
        if contradictions:
            return "La confiance est abaissée par des incohérences à lever."
        return "La confiance dépend de la couverture documentaire et de la qualité OCR/extraction."
    return "Lecture synthétique de l'axe."


def _diagnostic_question_detail(sale: AuctionSale, risks: list[dict[str, Any]]) -> str:
    labels = [
        str(risk.get("risk_label"))
        for risk in risks
        if risk.get("risk_label") in {"amiante", "plomb", "termites", "DPE"}
    ]
    if labels:
        return "Diagnostics à relire : " + ", ".join(labels[:4]) + "."
    if not sale.documents:
        return "Diagnostics non disponibles dans les pièces structurées."
    return "Aucun diagnostic défavorable contextualisé n'est retenu à ce stade."


def _classify_document_label(label: str, url: str = "") -> str:
    text = f"{label} {url}".lower()
    if re.search(r"diagnostic|dpe|amiante|plomb|termites|crep", text):
        return "diagnostics_techniques"
    if re.search(r"cahier|conditions?.{0,20}vente|ccv", text):
        return "cahier_conditions_vente"
    if re.search(r"huissier|commissaire|descriptif|proc[eè]s[-\s]?verbal|pv", text):
        return "pv_huissier"
    if re.search(r"notaire|notarial", text):
        return "pv_notaire"
    if re.search(r"annonce|avis|insertion", text):
        return "annonce_vente"
    return "pdf"


def _risk_fact_status(confidence: float) -> str:
    if confidence >= 0.82:
        return "confirmé"
    if confidence >= 0.62:
        return "probable"
    return "à confirmer"


def _risk_question(label: str) -> str:
    return {
        "travaux": "La mention décrit-elle un coût réel à budgéter pour ce bien ?",
        "amiante": "Le diagnostic confirme-t-il une présence imposant précaution ou travaux ?",
        "plomb": "Le CREP confirme-t-il une présence de plomb ayant un impact d'usage ou de travaux ?",
        "termites": "Le diagnostic confirme-t-il une infestation ou des indices actifs ?",
        "DPE": "La performance énergétique limite-t-elle la location ou la revente ?",
        "servitude": "La servitude limite-t-elle l'accès, l'usage ou la valeur du bien ?",
        "copropriété": "La copropriété crée-t-elle charges, travaux votés ou contraintes à intégrer ?",
        "occupation": "L'occupation retarde-t-elle la jouissance ou la revente ?",
    }.get(label, "Ce signal modifie-t-il le coût, le délai ou la liquidité du projet ?")


def _default_factor_criterion(name: str) -> str:
    return {
        "occupation": "Statut d'occupation et facilité d'exploitation.",
        "état": "État matériel du bien et besoin probable de travaux.",
        "type": "Liquidité selon la nature du bien.",
        "localisation": "Profondeur du marché local.",
        "surface": "Présence d'une surface exploitable pour comparer le bien.",
        "prix_m2": "Mise à prix rapportée à la surface exploitable.",
        "atouts": "Équipements et caractéristiques positives détectées.",
        "risques": "Risques contextualisés dans les documents.",
        "qualité": "Fiabilité des données utilisées par le scoring.",
    }.get(name, "Facteur de scoring.")


def _confidence_note(confidence: Decimal) -> str:
    value = max(Decimal("0"), min(Decimal("1"), confidence))
    pct = int((value * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if value >= Decimal("0.8"):
        level = "forte"
    elif value >= Decimal("0.6"):
        level = "correcte"
    elif value >= Decimal("0.4"):
        level = "à confirmer"
    else:
        level = "faible"
    return f"Confiance {level} ({pct}%)."


def _component_raw_fact_label(component: ScoreComponent) -> str | None:
    value = component.raw_value
    if value is None:
        return None
    name = component.name.lower()
    raw = _raw_value_label(value)
    items = _list_value_labels(value)

    if name == "occupation":
        return f"Occupation retenue : {_occupancy_status_label(str(value) if value else None)}."
    if name == "type":
        return f"Type de bien retenu : {_property_type_label(str(value) if value else None)}."
    if name == "localisation" and raw:
        label = raw.replace("tj ", "TJ ", 1) if raw.lower().startswith("tj ") else raw
        return f"Localisation retenue : {label}."
    if name == "surface":
        surface = _decimal_value(value)
        if surface is not None:
            return f"Surface exploitable retenue : {_format_decimal(surface)} m2."
        return "Surface exploitable à confirmer."
    if name == "prix_m2":
        price = _decimal_value(value)
        if price is not None:
            return f"Mise à prix rapportée à la surface : environ {_format_eur(price)}/m2."
        return "Prix au m2 à confirmer."
    if name == "atouts":
        return (
            f"Atouts d'usage détectés : {', '.join(items)}."
            if items
            else "Aucun atout d'usage spécifique n'a été détecté."
        )
    if name == "risques":
        return (
            f"Risques contextualisés retenus : {', '.join(items)}."
            if items
            else "Aucun risque contextualisé n'a été retenu dans les éléments analysés."
        )
    if name in {"qualité", "qualite"}:
        return (
            f"Points à vérifier sur les données : {', '.join(items)}."
            if items
            else "Aucune pénalité qualité : les données structurantes sont exploitables."
        )
    if name in {"état", "etat"} and raw:
        return f"État du bien retenu : {raw}."
    return raw


def _list_value_labels(value: object | None) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _decimal_value(value: object | None) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        text = str(value).strip().replace(" ", "").replace(",", ".")
        if not text:
            return None
        try:
            return Decimal(text)
        except Exception:
            return None
    return None


def _raw_value_label(value: object | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) if value else "Aucune donnée détectée"
    if isinstance(value, float):
        return f"{value:.2f}".rstrip("0").rstrip(".")
    return str(value)


def _quality_flag_label(flag: str) -> str:
    return {
        "ambiguous_surface": "surface ambiguë",
        "low_confidence_extraction": "extraction à faible confiance",
        "missing_gps": "coordonnées GPS manquantes",
        "source_not_allowed": "source non autorisée",
        "type_corrected_from_documents": "type corrigé par les documents",
        "occupation_conflict": "occupation contradictoire à confirmer",
        "room_count_conflict": "pièces/chambres incohérentes",
        "surface_conflict_resolved": "contradiction de surface résolue",
        "land_surface_conflict_resolved": "contradiction de terrain résolue",
        "source_page_only": "analyse basée sur la page source uniquement",
        "non_judicial_sale_context": "vente volontaire ou notariale, tribunal non prouvé",
    }.get(flag, flag.replace("_", " "))


def _occupancy_status_label(value: str | None) -> str:
    return {
        "vacant": "libre",
        "unknown": "à confirmer",
        "rented": "loué",
        "occupied": "occupé",
        "owner_occupied": "occupé par le propriétaire",
        "squatted": "occupation sans droit ni titre",
    }.get(value or "", "non renseigné")


def _property_type_label(value: str | None) -> str:
    return {
        "apartment": "appartement",
        "house": "maison",
        "building": "immeuble",
        "mixed": "actif mixte",
        "commercial": "local commercial",
        "land": "terrain",
        "parking": "parking",
        "unknown": "type non qualifié",
        "other": "type non qualifié",
    }.get(value or "", "type non qualifié")


def _format_decimal(value: Decimal) -> str:
    formatted = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{formatted.normalize():f}".replace(".", ",")


def _format_eur(value: Decimal | None) -> str:
    if value is None:
        return "prix absent"
    rounded = value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return f"{int(rounded):,} €".replace(",", " ")


def _surface_evidence_refs(sale: AuctionSale) -> list[dict[str, object]]:
    if not sale.surface_evidence:
        return []
    return [
        {
            "label": "Surface retenue",
            "document_type": "source_listing" if sale.surface_source == "source_listing" else None,
            "excerpt": sale.surface_evidence,
            "confidence": _float_or_none(sale.surface_confidence),
        }
    ]


def _risk_to_evidence_ref(risk: dict[str, Any]) -> dict[str, object]:
    evidence_json = risk.get("evidence_json") if isinstance(risk.get("evidence_json"), dict) else {}
    return {
        "label": risk.get("risk_label"),
        "document_label": evidence_json.get("document_label"),
        "document_type": evidence_json.get("document_type"),
        "page_number": evidence_json.get("page_number"),
        "excerpt": risk.get("evidence") or evidence_json.get("excerpt"),
        "confidence": risk.get("confidence"),
    }


def _factor_refs_from_risk_occurrences(occurrences: list[dict[str, object]]) -> list[dict[str, object]]:
    refs = []
    seen: set[tuple[object, object, object]] = set()
    ranked = sorted(
        occurrences,
        key=lambda item: (
            int(item.get("severity") or 1),
            float(item.get("confidence") or 0),
            _document_type_weight(str(item.get("document_type") or "")),
        ),
        reverse=True,
    )
    for occurrence in ranked:
        key = (
            occurrence.get("risk_label"),
            occurrence.get("document_url"),
            occurrence.get("page_number"),
        )
        if key in seen:
            continue
        seen.add(key)
        refs.append(
            _compact_dict(
                {
                    "label": occurrence.get("risk_label"),
                    "document_label": occurrence.get("document_label"),
                    "document_type": occurrence.get("document_type"),
                    "page_number": occurrence.get("page_number"),
                    "excerpt": occurrence.get("excerpt"),
                    "confidence": occurrence.get("confidence"),
                }
            )
        )
        if len(refs) >= 3:
            break
    return refs


def _risk_penalty_breakdown(risks: list[dict[str, Any]]) -> str:
    parts = []
    for risk in risks[:6]:
        label = risk.get("risk_label") or "risque"
        severity = Decimal(str(risk.get("severity") or 1))
        parts.append(f"{label} -{severity}")
    return ", ".join(parts) if parts else "aucun"


def _quality_penalty_breakdown(penalties: list[tuple[Decimal, str]]) -> str:
    return ", ".join(f"{reason} -{points}" for points, reason in penalties) if penalties else "aucune"


def _compact_dict(payload: dict[str, Any] | object | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {key: value for key, value in payload.items() if value not in (None, "", [], {})}


def _json_safe(value: object | None) -> object | None:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    return value


def _float_or_none(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _fill_quality_flags(sale: AuctionSale) -> None:
    if sale.source_name == "licitor" and any((doc.get("url") or "").startswith("https://www.licitor.com/data/pub/") for doc in sale.documents):
        _add_quality_flag(sale, "source_not_allowed")
    if sale.latitude is None or sale.longitude is None:
        _add_quality_flag(sale, "missing_gps")
    if not sale.documents:
        _add_quality_flag(sale, "source_page_only")
    if _sale_type_context(sale).get("status") == "non_judicial":
        _add_quality_flag(sale, "non_judicial_sale_context")
    llm_confidence = sale.raw_payload.get("llm_extraction", {}).get("confidence", {})
    if isinstance(llm_confidence, dict) and any(float(value or 0) < 0.55 for value in llm_confidence.values()):
        _add_quality_flag(sale, "low_confidence_extraction")


def _add_quality_flag(sale: AuctionSale, flag: str) -> None:
    if flag not in sale.quality_flags:
        sale.quality_flags.append(flag)
