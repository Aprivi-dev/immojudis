"""Champs d'une fiche Info-Enchères au-delà du tableau principal.

La fiche publie un tableau (référence, nature, adresse, superficie, mise à prix
et ses conditions, date de vente, tribunal et son adresse, visite), une galerie
ouverte en JavaScript (``$.fancybox.open([{href: …}])``, absente des balises
``<img>``), les pièces jointes (cahier des conditions de vente et annexes : PV
descriptif, diagnostics, urbanisme, plan cadastral, syndic, divers) et une
description qui donne la procédure, la désignation cadastrale, le numéro RG,
le barreau autorisé à porter les enchères et l'heure de l'audience.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from src.cadastre_references import designation, parse_cadastral_references
from src.normalize import clean_text
from src.sources.listing_characteristics import (
    characteristics_block,
    euro_amount,
    features_tree,
    item,
    merge_features_tree,
)

FEATURES_SCHEMA_VERSION = "info_encheres_features_v1"
_GALLERY = re.compile(r"\{\s*href\s*:\s*['\"]([^'\"]+\.(?:jpe?g|png|webp))['\"]", re.I)


def gallery_images(html: str) -> list[str]:
    """Photos de la galerie (liste passée à ``$.fancybox.open``)."""
    images: list[str] = []
    for match in _GALLERY.finditer(html or ""):
        url = match.group(1).strip()
        if "/upload/" in url and url not in images:
            images.append(url)
    return images


def _cadastre(description: str | None, city: str | None) -> dict[str, Any] | None:
    text = unicodedata.normalize("NFC", description or "")
    match = re.search(r"\bcadastr[ée]e?s?\b|\bcadastre\b", text, re.I)
    if not match:
        return None
    # La désignation s'arrête à la première mention qui n'est plus une référence
    # (« d'une contenance », « Superficie », « Lot 4 : », « : UN APPARTEMENT »…).
    window = text[match.end() : match.end() + 160]
    window = re.split(
        r"\s+(?:d['’]une|pour|lieu-?dit|soit|superficie|contenance|lots?|occupation|avec|figurant|libres?|occup\w*|ainsi|compos\w*)\b"
        r"|\s*:?\s+(?-i:UNE?|LES?|LA|DES?)\s|[.;](?:\s|$)|\s[-–]\s",
        window,
        maxsplit=1,
        flags=re.I,
    )[0]
    refs = parse_cadastral_references(window if re.search(r"\bsection", window, re.I) else f"section {window}")
    if not refs:
        return None
    area = re.search(r"\bcontenance\s+(?:totale\s+)?(?:de\s+)?((?:\d+\s*ha\s*)?(?:\d+\s*a\s*)?\d+\s*ca)\b", text, re.I)
    raw = clean_text(f"{match.group(0)} {window}")
    return {
        "references": [ref.label() for ref in refs],
        "designation": designation(refs, city),
        "contenance": clean_text(area.group(1)) if area else None,
        "raw": raw[:200] if raw else None,
    }


def extract_info_encheres_detail(
    details: dict[str, str],
    *,
    description: str | None,
    tribunal_cell: str | None,
    city: str | None,
    documents: list[dict[str, str]],
    photos: int,
    surfaces: dict[str, str | None],
) -> dict[str, Any]:
    # Certaines descriptions portent des accents décomposés (« e » + accent combinant).
    text = unicodedata.normalize("NFC", description or "")
    price_text = details.get("mise a prix") or details.get("mise à prix")
    price_conditions = clean_text(re.sub(r"^\s*[\d\s.,]+\s*€?\s*", "", price_text or "")) or None
    price_drop = bool(re.search(r"baisse|faculte de baisse|facult[ée] de baisse", price_text or "", re.I))
    method = re.search(r"(Vente aux ench[èe]res publiques(?:\s+sur\s+[^:.\n]{3,60})?)\s*:", text, re.I)
    framework = re.search(r"\bsur\s+(licitation|saisie immobili[èe]re|liquidation judiciaire|conversion)", text, re.I)
    rg = re.search(r"\bRG\s*(?:n[°o]\s*)?:?\s*(\d{2}/\d{3,6})", text)
    bar = re.search(r"Seuls les Avocats au Barreau d[eu']\s*([A-ZÀ-Ÿ' -]{3,40}?)\s+peuvent", text, re.I)
    hearing = re.search(r"(Les audiences? de vente d[ée]bute(?:nt)?\s+[àa][^.]{2,60})", text, re.I)
    fees = re.search(r"(Frais de poursuites?.{3,160}?)(?:\.\s+(?=[A-ZÀ-Ý])|\.?$)", text, re.I)
    cadastre = _cadastre(text, city)
    tribunal_address = None
    if tribunal_cell:
        parts = [clean_text(part) for part in tribunal_cell.splitlines() if clean_text(part)]
        tribunal_address = parts[-1] if len(parts) > 1 else None

    items = [
        item("reference", "Référence Info-Enchères", details.get("reference"), "identification"),
        item("nature", "Nature du bien", details.get("nature du bien"), "identification"),
        item("cadastre", "Désignation cadastrale", (cadastre or {}).get("raw"), "urbanisme"),
        item("cadastre_area", "Contenance cadastrale", (cadastre or {}).get("contenance"), "urbanisme"),
        item("rg_number", "Numéro RG", rg.group(1) if rg else None, "divers"),
        item("bar", "Barreau autorisé à enchérir", clean_text(bar.group(1)) if bar else None, "divers"),
        item("tribunal_address", "Adresse du tribunal", tribunal_address, "divers"),
    ]
    notes = [
        {"label": "Conditions de la mise à prix", "value": price_conditions} if price_conditions else None,
        {"label": "Audience", "value": clean_text(hearing.group(1))} if hearing else None,
        {"label": "Frais", "value": clean_text(fees.group(1))} if fees else None,
    ]
    procedure = {
        "method_label": clean_text(method.group(1)) if method else None,
        "legal_framework": clean_text(framework.group(1)).capitalize() if framework else None,
        "notes": [note for note in notes if note],
        "visits": [details["date de visite"]] if details.get("date de visite") else [],
    }
    deposit = euro_amount(re.search(r"consignation[^.]{0,80}", text, re.I).group(0)) if re.search(r"consignation", text, re.I) else None
    if deposit:
        procedure["prices"] = {"deposit_eur": deposit}
    block = characteristics_block(
        "info_encheres",
        items=items,
        nature=[details["nature du bien"]] if details.get("nature du bien") else None,
        surfaces=surfaces,
        photos=photos,
        documents=documents,
        procedure=procedure,
        location={"designation": (cadastre or {}).get("designation")},
    )
    tree = features_tree(
        FEATURES_SCHEMA_VERSION,
        characteristics={
            "nature": details.get("nature du bien"),
            "rg_number": rg.group(1) if rg else None,
            "price_drop_option": price_drop or None,
            "bar": clean_text(bar.group(1)) if bar else None,
            **{key: value for key, value in surfaces.items() if value},
        },
        characteristics_raw=items,
        procedure={**procedure, "price_text": price_text, "tribunal_address": tribunal_address},
        media={"photo_count": photos},
        documents=documents,
        extra={"cadastre_location": cadastre},
    )
    blocks = {
        "caracteristiques_bien": block,
        "conditions_mise_a_prix": price_conditions,
        "numero_rg": rg.group(1) if rg else None,
        "designation_cadastrale": (cadastre or {}).get("designation"),
        "adresse_tribunal": tribunal_address,
    }
    return {
        "source_blocks": {key: value for key, value in blocks.items() if value not in (None, "", [], {})},
        "source_property_features": tree,
    }


def apply_info_encheres_features(sale: dict[str, Any], tree: dict[str, Any]) -> None:
    sale["source_property_features"] = merge_features_tree(sale.get("source_property_features"), tree)
