"""Document type classification shared by the PDF extraction pipeline."""

from __future__ import annotations

import re
import unicodedata

from src.normalize import clean_text

DOCUMENT_TYPE_ALIASES = {
    "pv_descriptif": "pv_huissier",
    "proces_verbal_descriptif": "pv_huissier",
    "proces_verbal_de_description": "pv_huissier",
    "proces_verbal_de_constat": "pv_huissier",
    "pvd": "pv_huissier",
    "diagnostic": "diagnostics_techniques",
    "diagnostics": "diagnostics_techniques",
    "diagnostic_technique": "diagnostics_techniques",
    "cahier_conditions": "cahier_conditions_vente",
    "cahier_des_conditions": "cahier_conditions_vente",
    "cahier_des_conditions_de_vente": "cahier_conditions_vente",
    "ccv": "cahier_conditions_vente",
}

GENERIC_DOCUMENT_TYPES = {"document", "documents", "file", "fichier", "pdf", "piece_jointe", "pieces_jointes"}


def classify_document_type(label: str | None, url: str | None = None) -> str:
    text = _normalize_document_classifier_text(f"{label or ''} {url or ''}")
    if any(pattern in text for pattern in ("diagnostic", "dpe", "erp", "amiante", "plomb", "termites", "crep")):
        return "diagnostics_techniques"
    if re.search(r"\bdiag(?:nostics?)?\b", text):
        return "diagnostics_techniques"
    if any(
        pattern in text
        for pattern in (
            "cahier",
            "cahier des conditions",
            "cahier_des_conditions",
            "cahier des charges",
            "cahier_des_charges",
            "ccv",
            "dossier de consultation",
            "dossier_de_consultation",
            "dossier de presentation",
            "dossier_de_presentation",
            "reglement de consultation",
        )
    ):
        return "cahier_conditions_vente"
    if "conditions de vente" in text or "conditions_de_vente" in text:
        return "conditions_vente"
    if any(pattern in text for pattern in ("pv notaire", "notaire", "notarié", "notarie")):
        return "pv_notaire"
    if any(
        pattern in text
        for pattern in (
            "pv descriptif",
            "pv description",
            "pvd",
            "descriptif",
            "proces-verbal de constat",
            "commissaire de justice",
            "huissier",
        )
    ):
        return "pv_huissier"
    if re.search(r"\bproces[-\s]+verbal\b.*\b(?:description|descriptif|constat)\b", text):
        return "pv_huissier"
    if re.search(r"\bpv\b", text):
        return "pv_huissier"
    if re.search(r"\bproces[-\s]+verbal\b", text):
        return "proces_verbal"
    if any(
        pattern in text
        for pattern in (
            "avis",
            "simplifie",
            "simplifié",
            "affiche",
            "insertion",
            "annonce",
            "placard",
            "publicite",
            "publicité",
        )
    ):
        return "annonce_vente"
    if "bail" in text or "location" in text:
        return "bail"
    if any(pattern in text for pattern in ("hypothecaire", "hypothécaire", "commandement")):
        return "procedure_saisie"
    if any(pattern in text for pattern in ("cadastre", "plan", "parcelle")):
        return "cadastre"
    if ".pdf" in text:
        return "pdf"
    return "other"


def _normalize_document_classifier_text(value: object | None) -> str:
    text = clean_text(value) or ""
    normalized = unicodedata.normalize("NFKD", text)
    without_accents = "".join(char for char in normalized if not unicodedata.combining(char))
    return without_accents.lower()


def _canonical_document_type(
    document_type: object | None,
    *,
    label: object | None = None,
    url: object | None = None,
) -> str:
    classified = classify_document_type(clean_text(label), clean_text(url))
    raw = clean_text(document_type)
    if raw:
        normalized = _normalize_document_classifier_text(raw).replace("-", "_").replace(" ", "_")
        normalized = re.sub(r"_+", "_", normalized).strip("_")
        alias = DOCUMENT_TYPE_ALIASES.get(normalized)
        if alias:
            return alias
        if normalized in GENERIC_DOCUMENT_TYPES and classified != "other":
            return classified
        if normalized not in {"other", "unknown"}:
            return normalized
    return classified


PDF_DESCRIPTION_GROUP = frozenset({"pv_huissier", "pv_notaire", "proces_verbal"})

PDF_DIAGNOSTICS_GROUP = frozenset({"diagnostics_techniques"})

PDF_CONDITIONS_GROUP = frozenset({"cahier_conditions_vente", "conditions_vente"})

PDF_ANNOUNCE_GROUP = frozenset({"annonce_vente"})

PDF_BAIL_GROUP = frozenset({"bail"})

PDF_CADASTRE_GROUP = frozenset({"cadastre"})

DEFAULT_DOCUMENT_GROUPS = (
    PDF_DESCRIPTION_GROUP,
    PDF_DIAGNOSTICS_GROUP,
    PDF_CONDITIONS_GROUP,
    PDF_ANNOUNCE_GROUP,
    PDF_BAIL_GROUP,
    PDF_CADASTRE_GROUP,
)
