"""Libellés et petites règles partagés par la normalisation d'un bien, sa notation et son analyse détaillée.

Ce qui ne sert qu'à un de ces modules vit dans ce module.
"""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from src.asset_score_axes import FACTOR_AXIS
from src.lot_scope import sale_fact_text
from src.models import AuctionSale
from src.normalize import clean_text


def sale_text(sale: AuctionSale) -> str:
    return clean_text(" ".join(filter(None, [sale.title, sale.description, sale.risk_notes, sale_fact_text(sale)]))) or ""


def sale_type_context(sale: AuctionSale) -> dict[str, object]:
    text = sale_text(sale)
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
            "evidence": evidence_excerpt(text, non_judicial.start(), non_judicial.end()),
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
            "evidence": evidence_excerpt(text, explicit_judicial.start(), explicit_judicial.end()),
            "confidence": 0.78,
        }
    return {}


def document_context_label(document_type: object | None) -> str:
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


def risk_next_action(label: str) -> str:
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


def evidence_excerpt(text: str, start: int, end: int, *, window: int = 120) -> str:
    return clean_text(text[max(0, start - 80) : min(len(text), end + window)]) or ""


def factor_status(delta: Decimal) -> str:
    if delta > 0:
        return "favorable"
    if delta < 0:
        return "vigilance"
    return "neutre"


def component_axis(name: str) -> str:
    normalized = name.lower()
    return FACTOR_AXIS.get(normalized, "analysis_confidence")


def confidence_note(confidence: Decimal) -> str:
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


def decimal_value(value: object | None) -> Decimal | None:
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


def occupancy_status_label(value: str | None) -> str:
    return {
        "vacant": "libre",
        "unknown": "à confirmer",
        "rented": "loué",
        "occupied": "occupé",
        "owner_occupied": "occupé par le propriétaire",
        "squatted": "occupation sans droit ni titre",
    }.get(value or "", "non renseigné")


def format_decimal(value: Decimal) -> str:
    formatted = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{formatted.normalize():f}".replace(".", ",")


def format_eur(value: Decimal | None) -> str:
    if value is None:
        return "prix absent"
    rounded = value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return f"{int(rounded):,} €".replace(",", " ")


def risk_to_evidence_ref(risk: dict[str, Any]) -> dict[str, object]:
    evidence_json = risk.get("evidence_json") if isinstance(risk.get("evidence_json"), dict) else {}
    return {
        "label": risk.get("risk_label"),
        "document_label": evidence_json.get("document_label"),
        "document_type": evidence_json.get("document_type"),
        "page_number": evidence_json.get("page_number"),
        "excerpt": risk.get("evidence") or evidence_json.get("excerpt"),
        "confidence": risk.get("confidence"),
    }


def compact_dict(payload: dict[str, Any] | object | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {key: value for key, value in payload.items() if value not in (None, "", [], {})}


def json_safe(value: object | None) -> object | None:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    return value


def float_or_none(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def add_quality_flag(sale: AuctionSale, flag: str) -> None:
    if flag not in sale.quality_flags:
        sale.quality_flags.append(flag)
