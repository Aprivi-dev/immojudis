"""Champs d'une fiche Avoventes lus dans son texte (collecte et recalcul sans réseau).

La fiche détail publie, en plus de la description : un encadré de vente (mise à
prix, frais préalables, consignation, date, visites), trois tuiles (pièces,
chambres, superficie), une liste de caractéristiques (terrain, salles de bain et
d'eau, WC, année de construction, chauffage, état général, étage, ascenseur,
annexes, climatisation…), le diagnostic énergétique, la taxe foncière, les
charges annuelles, un résumé « Informations complémentaires », les pièces
jointes et le cabinet. :func:`extract_avoventes_text_fields` lit tout cela dans
le texte de la page (``source_blocks.page_text``) ; les données présentes
seulement dans le HTML (coordonnées de la carte, parcelles cadastrales) sont
lues à part par :func:`extract_avoventes_html_extras`.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from src.normalize import clean_text
from src.sources.listing_characteristics import (
    characteristics_block,
    euro_amount,
    features_tree,
    fold,
    item,
    merge_features_tree,
)

FEATURES_SCHEMA_VERSION = "avoventes_features_v1"
_COUNT_WORDS = {"pieces": "rooms_count", "chambres": "bedrooms_count"}
_SECTION_END = re.compile(r"^(?:Documents\*?|Voir toutes les ventes de ce cabinet|Demande d'informations|Autres biens)", re.I)
_STRONG_FEATURE = re.compile(
    r"^(?:\d+\s+salle\(s\)|\d+\s+WC$|Terrain\s*:|Construction\s*:|Chauffage\s*:|[ÉE]tat g[ée]n[ée]ral\s*:|[ÉE]tage\s*:)",
    re.I,
)
# Annexes publiées sans valeur (« Terrasse », « Cave (Cave voûtée…) », « Jardin (75 m²) »).
_AMENITIES = {
    "terrasse": ("has_terrace", "Terrasse"),
    "jardin": ("has_garden", "Jardin"),
    "garage": ("has_garage", "Garage"),
    "piscine": ("has_pool", "Piscine"),
    "climatisation": ("has_air_conditioning", "Climatisation"),
    "cave": (None, "Cave"),
    "balcon": (None, "Balcon"),
    "parking": (None, "Parking"),
    "box": (None, "Box"),
    "ascenseur": (None, "Ascenseur"),
    "cheminee": (None, "Cheminée"),
    "grenier": (None, "Grenier"),
    "veranda": (None, "Véranda"),
    "dependance": (None, "Dépendance"),
    "loggia": (None, "Loggia"),
    "interphone": (None, "Interphone"),
    "digicode": (None, "Digicode"),
    "gardien": (None, "Gardien"),
}
_LABELLED = {
    "terrain": ("land_surface", "Terrain", "urbanisme"),
    "construction": ("year_built", "Année de construction", "batiment"),
    "chauffage": ("heating", "Chauffage", "equipements"),
    "etat general": ("condition", "État général", "batiment"),
    "etage": ("floor", "Étage", "batiment"),
    "taxe fonciere": ("property_tax", "Taxe foncière", "divers"),
    "charges annuelles": ("annual_charges", "Charges annuelles", "divers"),
    "charges": ("annual_charges", "Charges", "divers"),
    "copropriete": ("coownership", "Copropriété", "situation"),
    "nombre de lots": ("coownership_lots", "Nombre de lots de la copropriété", "situation"),
    "occupation": ("occupancy", "Occupation", "situation"),
}


# Tuile « m² superficie » : surface publiée sans portée, affichée telle quelle.
PUBLISHED_SURFACE_FIELD = "published_surface_m2"

def _lines(page_text: str | None) -> list[str]:
    return [line for line in (clean_text(part) for part in str(page_text or "").splitlines()) if line]


def _value_after(lines: list[str], pattern: str, *, stop: int | None = None) -> tuple[str | None, int]:
    end = stop if stop is not None else len(lines)
    for index in range(end):
        line = lines[index]
        match = re.fullmatch(pattern, line, re.I)
        if not match:
            continue
        inline = clean_text(match.group(1)) if match.groups() else None
        if inline:
            return inline, index
        if index + 1 < end:
            return lines[index + 1], index + 1
    return None, -1


def _decimal_text(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    raw = text.replace(" ", "").replace(" ", "").replace(" ", "")
    raw = raw.replace(",", ".") if raw.count(",") == 1 and "." not in raw else raw.replace(",", "")
    try:
        number = Decimal(raw)
    except InvalidOperation:
        return None
    if number <= 0:
        return None
    return format(number.normalize(), "f")


def _summary(lines: list[str]) -> dict[str, Any]:
    """Encadré de vente et tuiles, avant « À propos du bien »."""
    boundary = next((index for index, line in enumerate(lines) if fold(line) == "a propos du bien"), len(lines))
    head = lines[:boundary]
    fees_text, _ = _value_after(head, r"Frais pr[ée]a?lables\s*:?\s*(.*)")
    deposit_text, deposit_index = _value_after(head, r"Consignation\s*:?\s*(.*)")
    deposit_note = None
    if deposit_index >= 0 and deposit_index + 1 < len(head) and head[deposit_index + 1].startswith("("):
        deposit_note = head[deposit_index + 1].strip("() ")
    visits, visit_index = _value_after(head, r"VISITES?\s*:?\s*(.*)")
    if visits and visits.startswith("%"):
        visits = None
    elif visits:
        # Les visites tiennent parfois sur plusieurs lignes (« … de 11 H à 12 H », « Selarl X (RDV sur place) »).
        extra = []
        for line in head[visit_index + 1 :]:
            if line.startswith("%") or re.fullmatch(r"\d{1,3}", line):
                break
            extra.append(line)
        visits = clean_text(" ".join([visits, *extra])) or visits
    _, price_index = _value_after(head, r"Mise à prix\s*:?\s*(.*)")
    price_conditions = None
    if price_index >= 0 and price_index + 1 < len(head) and re.match(r"(?:avec|outre|sur)\b", head[price_index + 1], re.I) \
            and not head[price_index + 1].rstrip().endswith(":"):
        price_conditions = head[price_index + 1]
    tiles: dict[str, str] = {}
    for index in range(1, len(head)):
        word = fold(head[index])
        previous = head[index - 1]
        if word in _COUNT_WORDS and re.fullmatch(r"\d{1,3}", previous):
            tiles[_COUNT_WORDS[word]] = previous
        elif re.fullmatch(r"m(?:2|²)? superficie", word):
            surface = _decimal_text(previous)
            if surface:
                tiles["published_surface_m2"] = surface
    return {
        "fees_text": fees_text,
        "fees_eur": euro_amount(fees_text),
        "deposit_text": deposit_text,
        "deposit_eur": euro_amount(deposit_text),
        "deposit_note": deposit_note,
        "visits": visits,
        "price_conditions": price_conditions,
        "tiles": tiles,
        "boundary": boundary,
    }


def _feature_region(lines: list[str], boundary: int) -> tuple[int, int]:
    end = next(
        (index for index in range(boundary, len(lines)) if _SECTION_END.match(lines[index])),
        len(lines),
    )
    start = next((index + 1 for index in range(boundary, end) if fold(lines[index]) == "cadastre"), None)
    if start is None:
        start = next((index for index in range(boundary, end) if _STRONG_FEATURE.match(lines[index])), end)
    return start, end


def _features(lines: list[str], start: int, end: int) -> dict[str, Any]:
    counts: dict[str, int] = {}
    labelled: dict[str, tuple[str, str, str]] = {}
    amenities: dict[str, str | None] = {}
    energy: dict[str, str] = {}
    complement: str | None = None
    index = start
    while index < end:
        line = lines[index]
        folded = fold(line)
        if folded.startswith("informations complementaires"):
            complement = clean_text(" ".join(lines[index + 1 : end])) or None
            break
        if folded == "diagnostic energetique":
            index += 1
            continue
        if folded in {"dpe", "ges"} and index + 1 < end and re.fullmatch(r"[A-G]", lines[index + 1], re.I):
            energy[f"{folded}_class"] = lines[index + 1].upper()
            index += 2
            continue
        count = re.fullmatch(r"(\d{1,2})\s+(salle\(s\) de bain|salle\(s\) d'eau|salle\(s\) d’eau|wc)", line, re.I)
        if count:
            key = {"salle(s) de bain": "bathrooms", "wc": "wc"}.get(fold(count.group(2)), "shower_rooms")
            counts[key] = int(count.group(1))
            index += 1
            continue
        pair = re.fullmatch(r"([^:]{3,40}?)\s*:\s*(.+)", line)
        if pair and fold(pair.group(1)) in _LABELLED:
            labelled[fold(pair.group(1))] = (*_LABELLED[fold(pair.group(1))][1:], clean_text(pair.group(2)) or "")
            index += 1
            continue
        amenity = re.fullmatch(r"([A-Za-zÀ-ÿ]+)\s*(?:\((.*)\))?", line)
        if amenity and fold(amenity.group(1)) in _AMENITIES:
            detail = clean_text(amenity.group(2))
            if detail and re.fullmatch(r"0\s*m(?:²|2)", detail):
                detail = None
            amenities[fold(amenity.group(1))] = detail
        index += 1
    return {"counts": counts, "labelled": labelled, "amenities": amenities, "energy": energy, "complement": complement}


def _cabinet(lines: list[str]) -> dict[str, str]:
    try:
        start = next(index for index, line in enumerate(lines) if line.startswith("* Pour tout autre document"))
    except StopIteration:
        return {}
    block = lines[start + 1 : start + 14]
    result: dict[str, str] = {}
    if block and not re.match(r"T[ée]l", block[0]):
        result["name"] = block[0]
        if len(block) > 1 and re.search(r"\b\d{5}\b", block[1]):
            result["address"] = block[1]
    phone, _ = _value_after(block, r"T[ée]l\.?\s*:?\s*(.*)")
    site, _ = _value_after(block, r"Site\.?\s*:?\s*(.*)")
    if phone and re.search(r"\d{6,}", phone.replace(" ", "")):
        result["phone"] = phone
    if site and re.match(r"(?:https?://|www\.)\S+$", site):
        result["website"] = site if site.startswith("http") else f"https://{site}"
    return result


def extract_avoventes_text_fields(
    page_text: str | None,
    *,
    property_type: str | None = None,
    title: str | None = None,
    documents: object = None,
    photos: int = 0,
    html_extras: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Champs bruts, bloc d'affichage et arbre de faits d'une fiche ; ``None`` si le texte n'est pas une fiche."""
    lines = _lines(page_text)
    if not any(fold(line) == "a propos du bien" for line in lines) and not any(
        line.startswith("Mise à prix") for line in lines
    ):
        return None
    summary = _summary(lines)
    start, end = _feature_region(lines, summary["boundary"])
    features = _features(lines, start, end)
    cabinet = _cabinet(lines)
    extras = html_extras or {}
    tiles = summary["tiles"]
    counts = features["counts"]
    labelled = features["labelled"]
    amenities = features["amenities"]

    land_text = labelled.get("terrain", (None, None, None))[2]
    land = _decimal_text(re.sub(r"\s*m(?:²|2)\s*$", "", land_text or "")) if land_text else None
    if land and Decimal(land) < 5:
        land = None  # « Terrain : 0.57 m² » : unité manifestement erronée (ares saisis en m²)
    year = labelled.get("construction", (None, None, None))[2]
    year_value = int(year) if year and re.fullmatch(r"1[5-9]\d\d|20\d\d", year) else None
    tax = euro_amount(labelled.get("taxe fonciere", (None, None, None))[2])
    charges_text = (labelled.get("charges annuelles") or labelled.get("charges") or (None, None, None))[2]
    single_dwelling = property_type in {"apartment", "house"}
    bathrooms_total = counts.get("bathrooms", 0) + counts.get("shower_rooms", 0)

    fields: dict[str, Any] = {
        "bedrooms_count": int(tiles["bedrooms_count"]) if single_dwelling and tiles.get("bedrooms_count") else None,
        "bathrooms_count": bathrooms_total if single_dwelling and bathrooms_total else None,
        "published_surface_m2": tiles.get("published_surface_m2"),
        "land_surface_m2": land,
        "lawyer_name": cabinet.get("name"),
        **{flag: True for name, (flag, _) in _AMENITIES.items() if flag and name in amenities},
    }
    if features["energy"]:
        fields["source_energy_diagnostics"] = {
            "source": "avoventes.detail",
            "dpe_class": features["energy"].get("dpe_class"),
            "ges_class": features["energy"].get("ges_class"),
            "diagnostic_date": None,
        }
    if extras.get("latitude") and extras.get("longitude"):
        fields["latitude"] = extras["latitude"]
        fields["longitude"] = extras["longitude"]

    items = [
        item("rooms_count", "Pièces", tiles.get("rooms_count"), "identification"),
        item("bedrooms_count", "Chambres", tiles.get("bedrooms_count"), "identification"),
        item("bathrooms_count", "Salles de bain", counts.get("bathrooms"), "equipements"),
        item("showers_count", "Salles d’eau", counts.get("shower_rooms"), "equipements"),
        item("wc_count", "WC", counts.get("wc"), "equipements"),
    ]
    for key, (label, group, value) in labelled.items():
        if key == "terrain":
            continue  # porté par les surfaces
        items.append(item(_LABELLED[key][0], label, value, group))
    for name, detail in amenities.items():
        label = _AMENITIES[name][1]
        items.append(item(f"amenity_{name}", label, detail or "Oui", "equipements"))
    deposit_note = summary["deposit_note"]
    notes = [
        {"label": "Conditions de la mise à prix", "value": summary["price_conditions"]}
        if summary["price_conditions"] else None,
        {"label": "Frais préalables", "value": summary["fees_text"]}
        if summary["fees_text"] and not summary["fees_eur"] else None,
        {"label": "Consignation", "value": " ".join(part for part in (summary["deposit_text"], f"({deposit_note})" if deposit_note else None) if part)}
        if summary["deposit_text"] else None,
    ]
    prices = {
        "preliminary_fees_eur": summary["fees_eur"],
        "deposit_eur": summary["deposit_eur"],
        "property_tax_eur": tax,
    }
    procedure = {
        "prices": {key: value for key, value in prices.items() if value},
        "notes": [note for note in notes if note],
        "visits": [summary["visits"]] if summary["visits"] else [],
    }
    location = extras.get("cadastre") or {}
    block = characteristics_block(
        "avoventes",
        items=items,
        surfaces={
            "published_surface_m2": tiles.get("published_surface_m2"),
            "land_surface_m2": land,
        },
        energy=features["energy"],
        photos=photos,
        documents=documents,
        procedure=procedure,
        location={"designation": location.get("designation"), "insee_code": location.get("insee_code")},
    )
    typed = {
        "rooms_count": int(tiles["rooms_count"]) if tiles.get("rooms_count") else None,
        "bedrooms_count": int(tiles["bedrooms_count"]) if tiles.get("bedrooms_count") else None,
        "bathrooms_count": counts.get("bathrooms"),
        "showers_count": counts.get("shower_rooms"),
        "wc_count": counts.get("wc"),
        "published_surface_m2": tiles.get("published_surface_m2"),
        "land_surface_m2": land,
        "year_built": year_value,
        "heating": labelled.get("chauffage", (None, None, None))[2],
        "condition": labelled.get("etat general", (None, None, None))[2],
        "floor": labelled.get("etage", (None, None, None))[2],
        "annual_charges_eur": euro_amount(charges_text),
        "amenities": sorted(amenities),
        "dpe_class": features["energy"].get("dpe_class"),
        "ges_class": features["energy"].get("ges_class"),
    }
    tree = features_tree(
        FEATURES_SCHEMA_VERSION,
        characteristics=typed,
        characteristics_raw=items,
        procedure={**procedure, "fees_text": summary["fees_text"], "deposit_text": summary["deposit_text"]},
        lawyer=cabinet,
        media={"photo_count": photos},
        documents=documents,
        extra={
            "complement": features["complement"],
            "cadastre_location": location,
            "coordinates": {"latitude": extras.get("latitude"), "longitude": extras.get("longitude")}
            if extras.get("latitude") else None,
        },
    )
    blocks = {
        "caracteristiques_bien": block,
        "informations_complementaires": features["complement"],
        "frais_prealables": summary["fees_text"],
        "conditions_mise_a_prix": summary["price_conditions"],
        "consignation": summary["deposit_text"],
        "chambres": tiles.get("bedrooms_count"),
        "superficie_publiee": tiles.get("published_surface_m2"),
        "designation_cadastrale": location.get("designation"),
        "cabinet_site": cabinet.get("website"),
        "cabinet_adresse": cabinet.get("address"),
    }
    return {
        "fields": {key: value for key, value in fields.items() if value not in (None, "", [], {})},
        "source_blocks": {key: value for key, value in blocks.items() if value not in (None, "", [], {})},
        "source_property_features": tree,
    }


def extract_avoventes_html_extras(html: str) -> dict[str, Any]:
    """Coordonnées du marqueur et parcelles cadastrales publiées dans les scripts de la carte."""
    extras: dict[str, Any] = {}
    marker = re.search(r"L\.marker\(\[\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\]\)", html)
    if marker:
        latitude, longitude = float(marker.group(1)), float(marker.group(2))
        if abs(latitude) <= 90 and abs(longitude) <= 180 and (latitude, longitude) != (0.0, 0.0):
            extras["latitude"] = marker.group(1)
            extras["longitude"] = marker.group(2)
    geojson = re.search(r"var\s+geojsonFeature\s*=\s*(\[.*?\])\s*;\s*\n", html, re.S)
    if geojson:
        try:
            features = json.loads(geojson.group(1))
        except (ValueError, TypeError):
            features = []
        parcels = []
        for feature in features if isinstance(features, list) else []:
            props = feature.get("properties") if isinstance(feature, dict) else None
            if not isinstance(props, dict) or not props.get("section") or not props.get("numero"):
                continue
            parcels.append({
                "section": str(props["section"]).lstrip("0") or str(props["section"]),
                "number": str(int(str(props["numero"]))) if str(props["numero"]).isdigit() else str(props["numero"]),
                "idu": props.get("idu"),
                "contenance_m2": props.get("contenance"),
                "insee_code": props.get("code_insee"),
                "commune": props.get("nom_com"),
            })
        if parcels:
            insee = {parcel["insee_code"] for parcel in parcels if parcel.get("insee_code")}
            commune = next((parcel["commune"] for parcel in parcels if parcel.get("commune")), None)
            labels = [f"{parcel['section']} {parcel['number']}" for parcel in parcels[:4]]
            noun = "Parcelle" if len(parcels) == 1 else "Parcelles"
            area = sum(int(parcel["contenance_m2"]) for parcel in parcels if isinstance(parcel.get("contenance_m2"), int))
            extras["cadastre"] = {
                "insee_code": next(iter(insee)) if len(insee) == 1 else None,
                "parcels": parcels,
                "designation": f"{noun} {', '.join(labels)}{'…' if len(parcels) > 4 else ''}"
                + (f" à {commune}" if commune else ""),
                "contenance_m2": area or None,
            }
    return extras


def apply_avoventes_fields(sale: dict[str, Any], extracted: dict[str, Any]) -> dict[str, Any]:
    """Applique une extraction à une vente brute sans écraser une valeur déjà lue par le parseur."""
    for key, value in extracted["fields"].items():
        if key == PUBLISHED_SURFACE_FIELD:
            # Tuile « m² superficie » : affichée telle quelle, sans portée ; la surface
            # canonique reste celle que la normalisation qualifie (Carrez, habitable…).
            continue
        if key == "source_energy_diagnostics":
            if not isinstance(sale.get(key), dict):
                sale[key] = value
            continue
        if sale.get(key) in (None, "", [], {}):
            sale[key] = value
    blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
    sale["source_blocks"] = {**blocks, **extracted["source_blocks"]}
    sale["source_property_features"] = merge_features_tree(sale.get("source_property_features"), extracted["source_property_features"])
    return sale


def refresh_avoventes_raw_sale(raw_sale: dict[str, Any]) -> bool:
    """Rejoue la lecture sur le ``page_text`` stocké d'une vente Avoventes (sans réseau).

    Les données lues seulement dans le HTML (carte, parcelles) sont reprises de
    l'arbre de faits déjà stocké.
    """
    if str(raw_sale.get("source_name") or "") != "avoventes":
        return False
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    page_text = blocks.get("page_text")
    if not isinstance(page_text, str) or not page_text.strip():
        return False
    previous = raw_sale.get("source_property_features")
    previous = previous if isinstance(previous, dict) else {}
    coordinates = previous.get("coordinates") if isinstance(previous.get("coordinates"), dict) else {}
    extras = {**coordinates, "cadastre": previous.get("cadastre_location")} if previous.get("cadastre_location") or coordinates else None
    images = raw_sale.get("source_images") if isinstance(raw_sale.get("source_images"), list) else []
    extracted = extract_avoventes_text_fields(
        page_text,
        property_type=str(raw_sale.get("property_type") or "") or None,
        title=str(raw_sale.get("title") or "") or None,
        documents=raw_sale.get("documents"),
        photos=len(images),
        html_extras=extras,
    )
    if extracted is None:
        return False
    apply_avoventes_fields(raw_sale, extracted)
    return True
