"""Bloc « Caractéristiques du bien » des annonces judiciaires (Vench, Avoventes, Info-Enchères).

Même contrat d'affichage que les cessions de l'État
(``source_blocks.caracteristiques_bien``, ``property_characteristics_v1``), lu
côté site par ``src/lib/property-characteristics.ts`` : tuiles libellé/valeur
groupées, surfaces par portée, diagnostics, galerie, pièces jointes typées,
procédure (mise à prix, consignation, frais, visites), dates de publication et
localisation cadastrale. Les faits structurés correspondants sont rangés dans
``source_property_features`` (arbre propre à la source, à côté des faits typés
génériques). Fonctions pures, sans réseau.
"""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal, InvalidOperation
from typing import Any

from src.normalize import clean_text
from src.pdf_document_types import classify_document_type

DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"
GROUPS = {
    "identification": "Identification",
    "surfaces": "Surfaces",
    "urbanisme": "Urbanisme et terrain",
    "batiment": "Bâtiment",
    "equipements": "Équipements",
    "situation": "Situation et occupation",
    "diagnostics": "Diagnostics",
    "divers": "Autres informations",
}
_KIND_LABELS = {
    "cahier_conditions_vente": "Cahier des conditions de vente",
    "conditions_vente": "Conditions de vente",
    "pv_huissier": "Procès-verbal descriptif",
    "pv_notaire": "Acte notarié",
    "proces_verbal": "Procès-verbal",
    "diagnostics_techniques": "Diagnostics techniques",
    "annonce_vente": "Avis de vente / affiche",
    "bail": "Bail",
    "procedure_saisie": "Pièce de procédure",
    "cadastre": "Plan cadastral",
    "urbanisme": "Renseignements d'urbanisme",
    "copropriete": "Copropriété / syndic",
    "dire": "Dire",
    "plans": "Plans et superficies",
    "other": "Autre pièce",
}


def fold(value: object | None) -> str:
    """Texte replié (minuscules, sans accents) pour comparer des libellés."""
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", text).strip().lower()


def document_kind(label: object | None, url: object | None = None) -> tuple[str, str]:
    """Nature d'une pièce jointe pour l'affichage (plus fine que le type PDF)."""
    text = fold(f"{label or ''} {url or ''}")
    name = fold(label)
    if re.search(r"\bdires?\b", name):
        kind = "dire"
    elif re.search(r"urbanisme|\bcu[\s_-]|\blru\b|certificat d.urbanisme|note de renseignements", text):
        kind = "urbanisme"
    elif re.search(r"\bddt\b|\bdiag|dossier (?:de )?diagnostics?", text):
        kind = "diagnostics_techniques"
    elif re.search(r"syndic|copropri|reglement de copro|\beds\b|\beps\b", text):
        kind = "copropriete"
    elif re.search(r"\bsuperficie\b|\bplans?\b(?! cadastral)", name) and "cadastr" not in text:
        kind = "plans"
    else:
        kind = classify_document_type(clean_text(label), clean_text(url))
        if kind == "pdf":
            kind = "other"
    return kind, _KIND_LABELS.get(kind, _KIND_LABELS["other"])


def attachments(documents: object) -> list[dict[str, str]]:
    """Pièces jointes (libellé, nature) d'une liste ``documents`` de la source."""
    result: list[dict[str, str]] = []
    for document in documents if isinstance(documents, list) else []:
        if not isinstance(document, dict) or not document.get("url"):
            continue
        label = clean_text(document.get("label")) or "Document"
        kind, kind_label = document_kind(label, document.get("url"))
        result.append({"label": label, "kind": kind, "kind_label": kind_label})
    return result


def euro_amount(value: object | None) -> str | None:
    """Montant en euros d'un texte publié (« 6 504,49 € », « 9.000 euros ») ; ``None`` si ambigu."""
    text = clean_text(value)
    if not text:
        return None
    amounts = re.findall(r"(\d{1,3}(?:[   .]\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)\s*(?:€|eur(?:os?)?\b)", text, re.I)
    if len(set(amounts)) != 1:
        return None
    raw = amounts[0]
    if re.search(r",\d{1,2}$", raw):
        raw = raw.replace(".", "").replace(",", ".")
    elif re.search(r"\.\d{3}$", raw) or re.search(r"\.\d{3}\.", raw):
        raw = raw.replace(".", "")
    raw = re.sub(r"[   ]", "", raw)
    try:
        amount = Decimal(raw)
    except InvalidOperation:
        return None
    if amount <= 0:
        return None
    return format(amount.normalize(), "f")


def item(key: str, label: str, value: object | None, group: str) -> dict[str, str] | None:
    text = clean_text(value)
    if not text:
        return None
    return {"key": key, "label": label, "value": text, "group": group}


def characteristics_block(
    source: str,
    *,
    items: list[dict[str, str] | None],
    nature: list[str] | None = None,
    category: str | None = None,
    surfaces: dict[str, str | None] | None = None,
    energy: dict[str, str | None] | None = None,
    photos: int = 0,
    documents: object = None,
    procedure: dict[str, Any] | None = None,
    dates: dict[str, str | None] | None = None,
    location: dict[str, str | None] | None = None,
) -> dict[str, Any] | None:
    """Bloc ``caracteristiques_bien`` ; ``None`` quand la fiche ne publie rien d'exploitable."""
    clean_items = [entry for entry in items if entry]
    clean_surfaces = {key: value for key, value in (surfaces or {}).items() if value}
    clean_energy = {key: value for key, value in (energy or {}).items() if value}
    pieces = attachments(documents)
    clean_procedure = {key: value for key, value in (procedure or {}).items() if value not in (None, "", [], {})}
    block: dict[str, Any] = {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": source,
        "nature": [{"label": label, "display": label} for label in nature or [] if label],
        "category": category,
        # Titres de groupes : ceux du site (DEFAULT_GROUPS) ; pas recopiés ici pour ne pas
        # injecter « Situation et occupation » etc. dans le texte de normalisation.
        "items": clean_items,
        "surfaces": clean_surfaces,
        "energy": clean_energy,
        "media": {"photos": photos} if photos else {},
        "attachments": pieces,
        "procedure": clean_procedure,
        "dates": {key: value for key, value in (dates or {}).items() if value},
        "location": {key: value for key, value in (location or {}).items() if value},
    }
    if not (clean_items or clean_surfaces or clean_energy or pieces or clean_procedure):
        return None
    return {key: value for key, value in block.items() if value not in (None, "", [], {})}


def features_tree(
    schema_version: str,
    *,
    characteristics: dict[str, Any],
    characteristics_raw: list[dict[str, str] | None],
    procedure: dict[str, Any] | None = None,
    lawyer: dict[str, Any] | None = None,
    media: dict[str, Any] | None = None,
    documents: object = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Arbre ``source_property_features`` propre à la source (faits structurés de la fiche)."""
    tree: dict[str, Any] = {
        "schema_version": schema_version,
        "characteristics": {key: value for key, value in characteristics.items() if value not in (None, "", [], {})},
        "characteristics_raw": [entry for entry in characteristics_raw if entry],
        "procedure": {key: value for key, value in (procedure or {}).items() if value not in (None, "", [], {})},
        "lawyer": {key: value for key, value in (lawyer or {}).items() if value not in (None, "", [], {})},
        "media": {
            **{key: value for key, value in (media or {}).items() if value not in (None, "", [], {})},
            "attachments": attachments(documents),
            "attachment_count": len(attachments(documents)),
        },
        **{key: value for key, value in (extra or {}).items() if value not in (None, "", [], {})},
    }
    return {key: value for key, value in tree.items() if value not in (None, "", [], {})}


def known_detail_lacks_characteristics(
    sale: dict[str, Any],
    known_details: dict[str, dict[str, Any]] | None,
) -> bool:
    """Vente inchangée dont la fiche stockée précède la lecture structurée : à relire une fois.

    Une vente dont la vignette n'a pas changé n'est pas relue ; sa fiche stockée
    sans bloc ``caracteristiques_bien`` ne porterait jamais les informations que
    la fiche publique affiche (adresse, avocat, visites, consignation, photos…).
    Après une relecture le bloc est conservé avec la vente et la règle ne joue plus.
    """
    if not sale.get("_known_unchanged") or not known_details:
        return False
    known = known_details.get(str(sale.get("source_url") or ""))
    if not isinstance(known, dict):
        return False
    payload = known.get("raw_payload") if isinstance(known.get("raw_payload"), dict) else {}
    for container in (known, payload):
        blocks = container.get("source_blocks")
        if isinstance(blocks, dict) and isinstance(blocks.get("caracteristiques_bien"), dict):
            return False
    return True


_TREE_KEYS = ("schema_version", "characteristics", "characteristics_raw", "procedure", "lawyer", "media",
              "cadastre_location", "listing", "coordinates", "complement")


def restore_known_detail_blocks(
    sale: dict[str, Any],
    known_details: dict[str, dict[str, Any]] | None,
) -> bool:
    """Vente inchangée non relue : reprend les blocs et l'arbre de faits de la fiche déjà lue.

    La vignette porte toujours un bloc (``listing_completeness``) : la reprise
    générique des champs vides ne recopie donc jamais les blocs de la fiche, qui
    seraient perdus au premier passage sans relecture.
    """
    if not sale.get("_known_unchanged") or not known_details:
        return False
    known = known_details.get(str(sale.get("source_url") or ""))
    payload = known.get("raw_payload") if isinstance(known, dict) and isinstance(known.get("raw_payload"), dict) else {}
    known_blocks = payload.get("source_blocks") if isinstance(payload.get("source_blocks"), dict) else None
    if not known_blocks or not isinstance(known_blocks.get("caracteristiques_bien"), dict):
        return False
    card_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
    sale["source_blocks"] = {
        **{key: value for key, value in known_blocks.items() if key != "listing_completeness"},
        **{key: value for key, value in card_blocks.items() if key != "listing_completeness"},
    }
    known_tree = payload.get("source_property_features")
    if isinstance(known_tree, dict) and known_tree.get("schema_version"):
        tree = {key: known_tree[key] for key in _TREE_KEYS if key in known_tree}
        sale["source_property_features"] = merge_features_tree(sale.get("source_property_features"), tree)
    return True


def merge_features_tree(existing: object, tree: dict[str, Any]) -> dict[str, Any]:
    """Remplace l'arbre de la source dans ``source_property_features`` sans toucher aux faits typés."""
    base = dict(existing) if isinstance(existing, dict) else {}
    for key in _TREE_KEYS:
        base.pop(key, None)
    return {**base, **tree}
