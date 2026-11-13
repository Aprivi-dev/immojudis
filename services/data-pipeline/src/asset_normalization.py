from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from src.app_surface_withholding import withhold_ambiguous_app_surface
from src.asset_normalization_helpers import (
    compact_dict,
    confidence_note,
    document_context_label,
    evidence_excerpt,
    float_or_none,
    risk_next_action,
    sale_text,
    sale_type_context,
)
from src.asset_scoring import score_sale
from src.asset_surface_normalization import (
    apply_document_consistency_corrections,
    fill_booleans,
    fill_counts,
    fill_surfaces,
)
from src.lot_scope import sale_fact_text
from src.models import AuctionSale, add_quality_flag
from src.normalize import (
    _property_feature_bool,
    clean_text,
    parse_surface,
)
from src.text_fact_scope import private_amenity_mentioned, shared_amenity_mentioned

RISK_DETECTOR_VERSION = "risk_context_v4"

MAX_NORMALIZATION_TEXT_CHARS = 1_000_000


class AssetNormalizationInputTooLarge(ValueError):
    """Raised when attacker-controlled source text exceeds the regex safety budget."""


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
    if isinstance(sale.raw_payload, dict) and sale.raw_payload.get("annex_reclassification"):
        label = "Annexe"  # « appartement » de moins de 9 m² reclassé : le titre suit le type
    if sale.property_type == "land":
        surface = _format_surface_m2(sale.land_surface_m2)
    elif sale.surface_scope in {"partial", "room_or_annex", "unknown"}:
        surface = None
    else:
        surface = _format_surface_m2(sale.app_surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2)
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
    _assert_normalization_input_size(sale)
    _restore_partial_document_surface_scope(sale)
    text = sale_text(sale)
    if not text:
        _fill_quality_flags(sale)
        withhold_ambiguous_app_surface(sale)
        score_sale(sale, [])
        sale.title = build_display_title(sale)
        return sale

    apply_document_consistency_corrections(sale, text)
    fill_surfaces(sale, text)
    _restore_structured_surface_precision(sale)
    fill_counts(sale, text)
    fill_booleans(sale, text)
    _clear_scoped_feature_false_positives(sale, text)
    risks = extract_risks(sale)
    _fill_quality_flags(sale)
    withhold_ambiguous_app_surface(sale)
    score_sale(sale, risks)
    _write_asset_payload(sale, risks)
    sale.title = build_display_title(sale)
    return sale


def _clear_scoped_feature_false_positives(sale: AuctionSale, text: str) -> None:
    """Quarantine lot amenities inferred from building/level wording."""
    for feature_field, feature in (("has_garden", "garden"), ("has_terrace", "terrace"), ("has_pool", "pool")):
        if getattr(sale, feature_field) is not True:
            continue
        if not _feature_is_scope_only(text, feature):
            continue
        setattr(sale, feature_field, False)
        reconciliation = sale.raw_payload.setdefault("feature_scope_reconciliation", {})
        if isinstance(reconciliation, dict):
            reconciliation[feature_field] = {
                "status": "cleared",
                "reason": "building_or_level_scope_without_lot_amenity",
            }

    # Jardin de la copropriété seulement : pas de jardin privatif, mais l'information est gardée pour l'affichage
    # « Jardin : commun (copropriété) » (décision du 05/11/2026).
    if sale.has_garden is not True and shared_amenity_mentioned(text, "garden"):
        sale.raw_payload["shared_garden"] = True
    else:
        sale.raw_payload.pop("shared_garden", None)

    if sale.bedrooms_count is not None and _bedroom_count_is_cold_room_only(text):
        previous = sale.bedrooms_count
        sale.bedrooms_count = None
        sale.raw_payload["bedroom_count_reconciliation"] = {
            "status": "cleared",
            "rejected_bedrooms_count": previous,
            "reason": "cold_rooms_are_not_bedrooms",
        }

    if sale.land_surface_m2 is not None and _land_surface_is_rez_de_jardin_only(text):
        previous = sale.land_surface_m2
        sale.land_surface_m2 = None
        sale.raw_payload["land_surface_reconciliation"] = {
            "status": "cleared",
            "rejected_land_surface_m2": str(previous),
            "resolved_land_surface_m2": None,
            "basis": "rez_de_jardin_is_a_level_not_land_evidence",
        }
        add_quality_flag(sale.quality_flags, "parcel_surface_scope_unverified")


def _feature_is_scope_only(text: str, feature: str) -> bool:
    # Le texte ne nomme que le jardin ou la piscine de la copropriété, une vue « sur jardin » ou un lieu (« rue du
    # Jardin ») : une valeur reprise d'un ancien passage ou d'un champ de la source ne tient plus (audit 03/11/2026).
    if feature in {"garden", "pool"} and private_amenity_mentioned(text, feature) is False:
        return True
    if feature == "garden":
        ground_level = re.search(r"\brez[\s-]+de[\s-]+jardin\b", text, re.I)
        if not ground_level:
            return False
        without_level = re.sub(r"\brez[\s-]+de[\s-]+jardin\b", "", text, flags=re.I)
        return not bool(re.search(r"\bjardin\b", without_level, re.I))
    if feature == "terrace":
        matches = list(re.finditer(r"\bterrasse\b", text, re.I))
        return bool(matches) and _property_feature_bool(None, text, feature) is not True
    return False


def _bedroom_count_is_cold_room_only(text: str) -> bool:
    if not re.search(r"\bchambres?\s+froides?\b", text, re.I):
        return False
    without_cold_rooms = re.sub(
        r"\b(?:[0-9]+|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)?\s*"
        r"chambres?\s+froides?\b",
        "",
        text,
        flags=re.I,
    )
    return not bool(re.search(r"\bchambres?\b", without_cold_rooms, re.I))


def _land_surface_is_rez_de_jardin_only(text: str) -> bool:
    without_level = re.sub(r"\brez[\s-]+de[\s-]+jardin\b", "", text, flags=re.I)
    if not re.search(r"\brez[\s-]+de[\s-]+jardin\b", text, re.I):
        return False
    return not bool(
        re.search(
            r"\b(?:terrain|parcelle|cadastr\w*|contenance|hectare|hectares|ares?|centiares?)\b|"
            r"\b\d+(?:[,.]\d+)?\s*ha\b",
            without_level,
            re.I,
        )
    )


def _restore_structured_surface_precision(sale: AuctionSale) -> None:
    """Keep the source's generic surface representation alongside Carrez.

    Surface normalization promotes an equal Carrez value to the application
    surface. When the detail page also exposes a generic structured surface,
    preserve that canonical field's precision (for example 10.1 rather than
    the lexically padded 10.10) while retaining the typed Carrez field.
    """
    structured = parse_surface(sale.raw_payload.get("surface_m2"))
    if sale.surface_m2 is None or sale.carrez_surface_m2 is None:
        return
    if structured is not None and structured == sale.surface_m2 == sale.carrez_surface_m2:
        sale.surface_m2 = structured
    elif structured is None and sale.surface_m2 == sale.carrez_surface_m2:
        sale.surface_m2 = sale.surface_m2.normalize()


def _assert_normalization_input_size(sale: AuctionSale) -> None:
    text_fields = (sale.title, sale.description, sale.risk_notes, sale.raw_text, sale.surface_evidence)
    total_chars = sum(len(value) for value in text_fields if isinstance(value, str))
    if total_chars > MAX_NORMALIZATION_TEXT_CHARS:
        raise AssetNormalizationInputTooLarge(
            f"Asset normalization input exceeds {MAX_NORMALIZATION_TEXT_CHARS} characters."
        )


def _restore_partial_document_surface_scope(sale: AuctionSale) -> None:
    extraction = sale.raw_payload.get("surface_extraction")
    if not isinstance(extraction, dict) or extraction.get("surface_scope") != "partial":
        return
    if extraction.get("source") != "pdf":
        return

    documented_value = parse_surface(extraction.get("value_m2"))
    measured_values = {
        value
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
        )
        if value is not None
    }
    if documented_value is None or documented_value not in measured_values:
        return
    if sale.app_surface_m2 is not None and sale.app_surface_m2 != documented_value:
        return

    previous_scope = sale.surface_scope
    previous_app_surface = sale.app_surface_m2
    sale.surface_scope = "partial"
    sale.app_surface_m2 = None
    sale.app_surface_kind = None
    sale.raw_payload["surface_scope_reconciliation"] = {
        "status": "restored",
        "previous_scope": previous_scope,
        "rejected_app_surface_m2": str(previous_app_surface) if previous_app_surface is not None else None,
        "documented_partial_surface_m2": str(documented_value),
        "basis": "structured_pdf_extraction_scope",
    }
    add_quality_flag(sale.quality_flags, "partial_surface_scope_restored")


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
        "investment_score": float_or_none(sale.investment_score),
        "investment_summary": sale.investment_summary,
    }


def build_auction_surfaces_row(sale: AuctionSale) -> dict[str, Any]:
    return {
        "source_url": sale.source_url,
        "surface_m2": float_or_none(sale.surface_m2),
        "habitable_surface_m2": float_or_none(sale.habitable_surface_m2),
        "land_surface_m2": float_or_none(sale.land_surface_m2),
        "carrez_surface_m2": float_or_none(sale.carrez_surface_m2),
        "app_surface_m2": float_or_none(sale.app_surface_m2),
        "app_surface_kind": sale.app_surface_kind,
        "surface_scope": sale.surface_scope,
        "surface_source": sale.surface_source,
        "surface_confidence": float_or_none(sale.surface_confidence),
        "surface_evidence": sale.surface_evidence,
        "rooms_count": sale.rooms_count,
        "bedrooms_count": sale.bedrooms_count,
        "bathrooms_count": sale.bathrooms_count,
        "parking_count": sale.parking_count,
    }


def _write_asset_payload(sale: AuctionSale, risks: list[dict[str, Any]]) -> None:
    sale.raw_payload["asset_normalization"] = {
        "features": build_auction_features_row(sale),
        "surfaces": build_auction_surfaces_row(sale),
        "risks": risks,
        "score_confidence": float_or_none(sale.score_confidence),
        "score_factors": sale.score_factors,
        "investment_analysis": sale.raw_payload.get("investment_analysis"),
        "quality_flags": sale.quality_flags,
        "score_version": sale.score_version,
    }


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
                    "next_action": risk_next_action(label),
                    "document_context": document_context_label(occurrence.get("document_type")),
                    "document_weight": _document_type_weight(str(occurrence.get("document_type") or "")),
                    "question": _risk_question(label),
                    "decision": "Retenu car le contexte rattache la mention au bien ou à un document probant.",
                    "confidence_note": confidence_note(Decimal(str(occurrence.get("confidence") or "0"))),
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
            context = evidence_excerpt(text, match.start(), match.end())
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


def _risk_source_text(sale: AuctionSale) -> str:
    return clean_text(" ".join(filter(None, [sale.title, sale.description, sale_fact_text(sale)]))) or ""


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
    ) and not re.search(
        r"pr[ée]sence|positif|d[ée]tect[ée]|rep[ée]r[ée]|contient|contiennent|infestation", context, re.I
    )


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
    if label == "termites":
        # A negative finding in one room must not suppress another room's finding.
        boundaries = r"[.;\n]|\bmais\b|\ben\s+revanche\b"
        before = re.split(boundaries, before, flags=re.I)[-1]
        after = re.split(boundaries, text[end : end + 90], flags=re.I)[0]
        context = before + text[start:end].lower() + after.lower()
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
    if label == "termites":
        # The statutory report title describes its scope, not its conclusion.
        evidence = re.sub(
            r"[ée]tat\s+relatif\s+[àa]\s+la\s+pr[ée]sence\s+de\s+termites?",
            "état termites",
            context,
            flags=re.I,
        )
        for statement in re.split(r"[.;\n]|\bmais\b|\ben\s+revanche\b", evidence, flags=re.I):
            if re.search(
                r"\bsi\b.{0,60}termites?|"
                r"termites?.{0,60}ne\s+(?:peut|peuvent)\s+(?:pas\s+)?[êe]tre\s+exclu",
                statement,
                re.I,
            ):
                # Conditional instructions and inaccessible areas establish no positive finding.
                continue
            # A regulatory reminder is conditional, not a finding in this building.
            statement = re.sub(
                r"(?:dans\s+le\s+cas\s+de|en\s+cas\s+de)\s+"
                r"(?:la\s+)?(?:pr[ée]sence|infestation)\s+de\s+termites?[^,]*",
                "rappel conditionnel",
                statement,
                flags=re.I,
            )
            if re.search(
                r"(?:absence|aucun[es]*|pas)\s+(?:de\s+|d['’])?"
                r"(?:indices?\s+(?:de\s+|d['’]))?(?:infestation\s+de\s+)?termites?",
                statement,
                re.I,
            ) or _risk_match_is_negated(statement, 0, len(statement), label):
                continue
            if re.search(
                r"(?:pr[ée]sence|indices?|infestation|attaque).{0,100}termites?|"
                r"termites?.{0,100}(?:pr[ée]sents?|positif|d[ée]tect[ée]s?|rep[ée]r[ée]s?)",
                statement,
                re.I,
            ):
                return True
        return False
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
    if re.search(
        r"\bservitudes?\s+(?:de\s+passage|d['’]utilit[ée]\s+publique|conventionnelle|grevant|active|passive)\b",
        context,
        re.I,
    ):
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


def _risk_reasoning(label: str, occurrence: dict[str, Any]) -> str:
    document_context = document_context_label(occurrence.get("document_type"))
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
            "decision": document_context_label(document_type),
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
            "decision": risk_next_action(label),
        },
    ]


def _risk_verification_priority(label: str, severity: int) -> str:
    if severity >= 5 or label == "occupation":
        return "bloquant_avant_enchere"
    if label in {"travaux", "amiante", "plomb", "termites", "servitude"}:
        return "a_verifier_avant_prix_plafond"
    return "a_controler_dans_lecture_complete"


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
            compact_dict(
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


# Au-delà, la mise à prix ou la surface est presque sûrement fausse (3,5 M€ pour 23,6 m² : 148 000 €/m²). Le m² le
# plus cher de France (Paris, quartiers prestigieux) se vend autour de 20 000 à 25 000 € et une mise à prix est
# inférieure à la valeur du bien.
MAX_PLAUSIBLE_STARTING_PRICE_PER_M2 = Decimal("30000")


PRICE_PER_M2_IMPLAUSIBLE_FLAG = "price_per_m2_implausible"


def _starting_price_per_m2_is_implausible(sale: AuctionSale) -> bool:
    """Mise à prix rapportée à la surface affichée, hors annonce multi-lots (prix de l'ensemble, surface d'un lot)."""
    price, surface = sale.starting_price_eur, sale.app_surface_m2
    if price is None or surface is None or surface <= 0 or "multi_lot_sale" in sale.quality_flags:
        return False
    return price / surface > MAX_PLAUSIBLE_STARTING_PRICE_PER_M2


def _fill_quality_flags(sale: AuctionSale) -> None:
    if sale.latitude is None or sale.longitude is None:
        add_quality_flag(sale.quality_flags, "missing_gps")
    else:
        # Un drapeau hérité d'une lecture sans coordonnées ne survit pas à l'arrivée des coordonnées.
        sale.quality_flags = [flag for flag in sale.quality_flags if flag != "missing_gps"]
    if _starting_price_per_m2_is_implausible(sale):
        add_quality_flag(sale.quality_flags, PRICE_PER_M2_IMPLAUSIBLE_FLAG)
    else:
        sale.quality_flags = [flag for flag in sale.quality_flags if flag != PRICE_PER_M2_IMPLAUSIBLE_FLAG]
    if isinstance(sale.raw_payload, dict) and sale.raw_payload.get("sale_date_unverified"):
        add_quality_flag(sale.quality_flags, "sale_date_implausible")
    if not sale.documents:
        add_quality_flag(sale.quality_flags, "source_page_only")
    if sale_type_context(sale).get("status") == "non_judicial":
        add_quality_flag(sale.quality_flags, "non_judicial_sale_context")
    llm_confidence = sale.raw_payload.get("llm_extraction", {}).get("confidence", {})
    if isinstance(llm_confidence, dict) and any(float(value or 0) < 0.55 for value in llm_confidence.values()):
        add_quality_flag(sale.quality_flags, "low_confidence_extraction")
