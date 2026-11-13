"""Axes de la note d'un bien et composantes qui la forment.

Module feuille : la notation, l'analyse détaillée et les libellés partagés lisent ces définitions sans
dépendre de la normalisation qui les appelle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any


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
