"""Annonce Licitor en plusieurs lots : la vente lue pour une URL décrit le lot de cette URL.

Licitor publie certaines ventes comme une seule page à plusieurs lots (« 1er lot », « 2ème lot »),
chacun avec sa désignation, sa mise à prix et sa situation (commune, rue, plan, visites). La page est
joignable par une URL par lot, qui ne diffèrent que par leur « slug » (nature et commune du lot) :

    /annonce/11/04/62/vente-aux-encheres/un-appartement/cannes/alpes-maritimes/110462.html
    /annonce/11/04/62/vente-aux-encheres/un-appartement/le-cannet/alpes-maritimes/110462.html

La lecture de la fiche prenait les valeurs du premier lot pour toutes les URL : la ligne du Cannet
affichait la commune, la mise à prix et la désignation de Cannes (03/11/2026). Ce module choisit le lot
de l'URL (commune et nature du slug, puis carte de la liste publique quand il en reste plusieurs) et en
tire les champs propres au lot. Si le lot ne peut pas être identifié avec certitude, les champs propres
au lot restent vides plutôt que de reprendre ceux d'un autre lot (« mieux vaut une case vide qu'une
valeur fausse ») ; la ligne reste alors en quarantaine multi-lots.

Même code pour la collecte (page téléchargée) et pour le recalcul sur le texte de page stocké.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from src.config import FRENCH_POSTAL_CODE_PATTERN
from src.lot_scope import AMBIGUOUS, LOT_SELECTION_KEY, SELECTED
from src.normalize import clean_text
from src.occupancy_statements import occupancy_status_from_text
from src.sources.common import extract_surface, normalize_surface_number
from src.sources.licitor_extraction import (
    _CONDITION_CUE_RE,
    _SURFACE_RE,
    LicitorLot,
    LicitorPage,
    _amount,
    _fold,
    _occupancy,
    _primary_surface,
)
from src.sources.source_features import (
    cadastral_to_m2,
    extract_parking_count,
    extract_qualified_surface,
    is_mixed_property,
)
from src.sources.source_features import extract_rooms_count as _source_rooms_count

_URL_RE = re.compile(
    r"/annonce/(?:\d+/)+[^/]+/(?P<nature>[^/]+)/(?P<city>[^/]+)/(?P<department>[^/]+)/\d+\.html$", re.I
)
_DEPARTMENT_LINE_RE = re.compile(r"^(?:\d{2,3}|2A|2B)$", re.I)
# Champs d'une vente qui décrivent un lot (et non l'audience, le tribunal ou l'avocat).
_LOT_FIELDS = (
    "title", "description", "city", "address", "postal_code", "property_type", "starting_price_eur",
    "surface_m2", "habitable_surface_m2", "carrez_surface_m2", "land_surface_m2", "rooms_count", "parking_count",
    "occupancy_status",
)
_LOT_BLOCKS = {
    "title": "titre", "description": "description", "city": "ville", "address": "adresse", "postal_code": "code_postal",
    "starting_price_eur": "mise_a_prix", "surface_m2": "surface", "habitable_surface_m2": "surface_habitable",
    "carrez_surface_m2": "surface_carrez", "land_surface_m2": "surface_terrain", "rooms_count": "pieces",
    "parking_count": "stationnement", "occupancy_status": "occupation",
}
_GEO_PAYLOAD_KEYS = ("geocode", "geo_precision")


def slug(value: object) -> str:
    """Slug d'URL Licitor : « Les Sables-d'Olonne » -> ``les-sables-d-olonne``."""
    return re.sub(r"[^a-z0-9]+", "-", _fold(value)).strip("-")


@dataclass
class LotLocation:
    city: str | None = None
    street: str | None = None
    visits: list[str] = field(default_factory=list)


@dataclass
class LotChoice:
    status: str
    lot: LicitorLot | None = None
    location: LotLocation | None = None
    reason: str = ""


def _location_unread(lot: LicitorLot) -> bool:
    """Lignes après la mise à prix qui ne sont pas des conditions : la situation du lot, non reconnue.

    (« Saint-Pargoire / Lieudit Prat del Monseigne » sans « Afficher le plan » : annonce 110285.)
    """
    return any(not _CONDITION_CUE_RE.search(paragraph) for paragraph in lot.conditions)


def lot_locations(page: LicitorPage) -> list[LotLocation]:
    """Situation de chaque lot : la sienne, ou celle du lot suivant du même bloc.

    Dans le texte, la situation (commune, rue, visites) suit le dernier lot de son bloc : un lot sans
    situation propre (un terrain puis un ensemble immobilier au même lieu, vendus en deux lots) partage celle
    du lot qui le suit. Un lot dont la situation est restée illisible ne prête ni n'emprunte rien : sa
    situation reste inconnue, comme celle des lots sans situation qui le précèdent.
    """
    locations: list[LotLocation] = []
    pending = 0
    for lot in page.lots:
        if lot.city:
            location = LotLocation(lot.city, lot.street, list(lot.visits))
            locations.extend([location] * (pending + 1))
            pending = 0
        elif _location_unread(lot):
            locations.extend([LotLocation()] * (pending + 1))
            pending = 0
        else:
            pending += 1
    locations.extend([LotLocation()] * pending)
    return locations


def _url_slugs(source_url: object) -> tuple[str | None, str | None]:
    match = _URL_RE.search(urlparse(str(source_url or "")).path)
    if not match:
        return None, None
    return match.group("nature").lower(), match.group("city").lower()


@dataclass
class _ListingCard:
    city: str | None
    price_eur: int | None
    surface: str | None


def _listing_card(listing_lots: object) -> _ListingCard | None:
    """Carte de la liste publique propre à cette URL, quand il n'y en a qu'une."""
    if not isinstance(listing_lots, list) or len(listing_lots) != 1 or not isinstance(listing_lots[0], dict):
        return None
    lines = [line for line in (clean_text(part) for part in str(listing_lots[0].get("raw_text") or "").splitlines()) if line]
    index = next((position for position, line in enumerate(lines) if _DEPARTMENT_LINE_RE.match(line)), None)
    if index is None or index + 1 >= len(lines):
        return None
    price_at = next((position for position, line in enumerate(lines) if re.match(r"Mise\s+[àa]\s+prix", line, re.I)), None)
    price = _amount(" ".join(lines[price_at:price_at + 2])) if price_at is not None else None
    body = " ".join(lines[index + 2: price_at if price_at is not None else len(lines)])
    surface = _SURFACE_RE.search(body)
    return _ListingCard(
        city=lines[index + 1],
        price_eur=price,
        surface=_surface_value(surface.group("value")) if surface else None,
    )


def _surface_value(raw: str) -> str:
    return re.sub(r"[ .  ](?=\d{3}\b)", "", raw).replace(",", ".")


def _lot_surface(lot: LicitorLot) -> str | None:
    primary = _primary_surface(lot)
    if primary:
        return primary
    match = _SURFACE_RE.search(lot.text)
    return _surface_value(match.group("value")) if match else None


def _same_number(left: str, right: str) -> bool:
    try:
        return abs(float(left) - float(right)) < 0.01
    except ValueError:
        return False


def _matches_card(lot: LicitorLot, location: LotLocation, card: _ListingCard) -> bool:
    """La carte décrit ce lot : même commune (connue des deux côtés) et rien de connu qui diffère."""
    if not card.city or not location.city or slug(card.city) != slug(location.city):
        return False
    if card.price_eur is not None and lot.price_eur is not None and card.price_eur != lot.price_eur:
        return False
    lot_surface = _lot_surface(lot)
    return not (card.surface and lot_surface and not _same_number(card.surface, lot_surface))


def select_licitor_lot(page: LicitorPage, source_url: object, listing_lots: object = None) -> LotChoice:
    """Lot que décrit l'URL ; ``ambiguous`` s'il ne peut pas être désigné avec certitude.

    1. Commune du slug de l'URL : Licitor y écrit la commune du lot. Seul un lot dont la commune lue est
       celle-là peut être choisi (commune illisible ou différente : aucun).
    2. Nature du slug (« un-appartement »), quand plusieurs lots sont dans cette commune.
    3. Carte de la liste publique de cette URL (commune, mise à prix, surface), quand l'URL n'en a qu'une :
       elle départage les lots restants et doit confirmer le lot retenu (sinon : ambiguïté).
    """
    lots = page.lots
    locations = lot_locations(page)
    if len(lots) == 1:
        return LotChoice(SELECTED, lots[0], locations[0], "single_lot")
    candidates = list(range(len(lots)))
    nature, city = _url_slugs(source_url)
    reasons: list[str] = []
    if city:
        candidates = [index for index in candidates if locations[index].city and slug(locations[index].city) == city]
        if not candidates:
            return LotChoice(AMBIGUOUS, reason="url_city_matches_no_lot")
        reasons.append("url_city")
    if nature and len(candidates) > 1 and all(lots[index].title for index in candidates):
        by_nature = [index for index in candidates if slug(lots[index].title) == nature]
        if by_nature:
            candidates = by_nature
            reasons.append("url_nature")
    card = _listing_card(listing_lots)
    if card is not None:
        matching = [index for index in candidates if _matches_card(lots[index], locations[index], card)]
        if len(matching) != 1:
            return LotChoice(AMBIGUOUS, reason="listing_card_conflict" if not matching else "listing_card_ambiguous")
        candidates = matching
        reasons.append("listing_card")
    if len(candidates) != 1:
        return LotChoice(AMBIGUOUS, reason="several_lots_match_url")
    index = candidates[0]
    return LotChoice(SELECTED, lots[index], locations[index], "+".join(reasons))


def postal_code_from_arrondissement(value: object | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"\b(Paris|Lyon|Marseille)\s+(\d{1,2})(?:er|[eè]me|eme)\b", text, re.I)
    if not match:
        return None
    city = match.group(1).lower()
    arrondissement = int(match.group(2))
    if city == "paris" and 1 <= arrondissement <= 20:
        return f"750{arrondissement:02d}"
    if city == "lyon" and 1 <= arrondissement <= 9:
        return f"6900{arrondissement}"
    if city == "marseille" and 1 <= arrondissement <= 16:
        return f"130{arrondissement:02d}"
    return None


def extract_land_surface_m2(text: str | None) -> str | None:
    value = clean_text(text) or ""
    if not value:
        return None
    cadastral = r"(?:(\d+)\s*ha\s*)?(?:(\d+)\s*a\s*)?(\d+)\s*ca\b"
    total_patterns = (
        rf"\b(?:soit\s+une\s+)?(?:contenance|surface|superficie)\s+totale\s*(?:de|:)\s*{cadastral}",
        rf"\b(?:parcelle|terrain)\b[^.\n]{{0,100}}?\b(?:d['’]une\s+)?(?:surface|superficie|contenance)\s+totale\s*(?:de|:)\s*{cadastral}",
    )
    totals = [
        cadastral_to_m2(match)
        for pattern in total_patterns
        for match in re.finditer(pattern, value, re.I)
    ]
    unique_totals = {candidate for candidate in totals if candidate}
    if len(unique_totals) == 1:
        return next(iter(unique_totals))
    if len(unique_totals) > 1:
        return None

    cadastral_marker = r"(?:cadastr\w*|parcelle|section\s+[A-Z]{1,4}\s*(?:n[°o.]?\s*)?[0-9A-Za-z-]+)"
    explicit_patterns = (
        rf"\b{cadastral_marker}\b[^.;\n]{{0,180}}?\b(?:pour\s+)?(?:une\s+)?(?:contenance|surface|superficie)\s+(?:de\s+)?{cadastral}",
        rf"\b{cadastral_marker}\b[^.;\n]{{0,180}}?\b(?:pour|de)\s+{cadastral}",
    )
    candidates_by_span: dict[tuple[int, int], str] = {}
    for pattern in explicit_patterns:
        for match in re.finditer(pattern, value, re.I):
            candidate = cadastral_to_m2(match)
            if candidate:
                candidates_by_span[(match.start(), match.end())] = candidate
    candidates = list(candidates_by_span.values())
    if len(candidates) != 1:
        return None
    return candidates[0]


def text_facts(detail_text: str, title: str | None) -> dict[str, Any]:
    """Faits lus dans la désignation d'un lot (titre et description), jamais dans le reste de la page."""
    return {
        "carrez_surface_m2": extract_qualified_surface(detail_text, "carrez", normalize_surface_number),
        "habitable_surface_m2": extract_qualified_surface(detail_text, "habitable", normalize_surface_number),
        "land_surface_m2": extract_land_surface_m2(detail_text),
        "rooms_count": _source_rooms_count(detail_text, title),
        "parking_count": extract_parking_count(detail_text),
        "property_type": "mixed" if is_mixed_property(" ".join(part for part in (title, detail_text) if part)) else clean_text(title),
        "occupancy_status": occupancy_status_from_text(detail_text),
    }


def _lot_description(lot: LicitorLot) -> str | None:
    if lot.title and lot.description:
        return clean_text(f"{lot.title}. {lot.description}")
    return clean_text(lot.title or lot.description)


def _postal_code(location: LotLocation) -> str | None:
    text = " ".join(part for part in (location.city, location.street) if part)
    match = re.search(rf"\b({FRENCH_POSTAL_CODE_PATTERN})\b", text)
    return match.group(1) if match else postal_code_from_arrondissement(location.city)


def _address(location: LotLocation, postal_code: str | None) -> str | None:
    if not location.street:
        return None
    if not location.city:
        return location.street
    return f"{location.street}, {postal_code} {location.city}" if postal_code else f"{location.street}, {location.city}"


def lot_text(lot: LicitorLot, location: LotLocation) -> str:
    """Texte du seul lot (désignation, mise à prix, conditions, situation, visites)."""
    parts = [lot.title, lot.description, f"Mise à prix : {lot.price_text}" if lot.price_text else None,
             *lot.conditions, location.city, location.street, *location.visits]
    return "\n".join(part for part in parts if part)


def _selected_fields(lot: LicitorLot, location: LotLocation) -> dict[str, Any]:
    description = _lot_description(lot)
    postal_code = _postal_code(location)
    facts = text_facts(description or lot.title or "", lot.title)
    declared, _ = _occupancy(lot)
    return {
        **facts,
        "title": lot.title,
        "description": description,
        "city": location.city,
        "postal_code": postal_code,
        "address": _address(location, postal_code),
        "starting_price_eur": lot.price_text,
        "surface_m2": extract_surface(" ".join(part for part in (lot.title, lot.description) if part),
                                      unit=r"(?:m\s*(?:²|2)|²)"),
        "occupancy_status": facts["occupancy_status"] or declared,
    }


def _common(values: list[Any]) -> Any:
    folded = {slug(value) for value in values}
    return values[0] if values and all(values) and len(folded) == 1 else None


def _ambiguous_fields(page: LicitorPage, locations: list[LotLocation]) -> dict[str, Any]:
    """Valeurs partagées par tous les lots seulement ; tout ce qui est propre à un lot reste vide."""
    title = _common([lot.title for lot in page.lots])
    city = _common([location.city for location in locations])
    street = _common([location.street for location in locations]) if city else None
    location = LotLocation(city, street)
    postal_code = _postal_code(location) if city else None
    fields: dict[str, Any] = dict.fromkeys(_LOT_FIELDS)
    fields.update({
        "title": title,
        "city": city,
        "postal_code": postal_code,
        "address": _address(location, postal_code),
        "property_type": title,
    })
    return fields


def _same_place(raw_sale: dict[str, Any], fields: dict[str, Any], street: str | None) -> bool:
    """La vente affichait déjà la situation de ce lot (même commune, même rue, code postal ajouté ou non)."""
    if not fields.get("city") or slug(raw_sale.get("city")) != slug(fields.get("city")):
        return False
    if not street:
        return not raw_sale.get("address") or slug(raw_sale.get("address")) == slug(fields.get("address"))
    return f"-{slug(street)}-" in f"-{slug(raw_sale.get('address'))}-"


def apply_licitor_lot(
    raw_sale: dict[str, Any],
    page: LicitorPage,
    *,
    lot_coordinates: list[tuple[str | None, str | None]] | None = None,
) -> LotChoice | None:
    """Remplace les champs propres au lot par ceux du lot de l'URL (ou les vide si le lot est incertain).

    Une page à un seul lot n'est pas modifiée. ``lot_coordinates`` (collecte) donne le point du plan de
    chaque lot, dans l'ordre de la page ; au recalcul, un point déjà stocké n'est gardé que si la situation
    du lot est celle qui était affichée (le point d'un autre lot, ou son géocodage, est retiré).
    """
    if len(page.lots) < 2:
        raw_sale.pop(LOT_SELECTION_KEY, None)
        return None
    choice = select_licitor_lot(page, raw_sale.get("source_url"), raw_sale.get("source_lots"))
    locations = lot_locations(page)
    if choice.status == SELECTED and choice.lot is not None and choice.location is not None:
        fields = _selected_fields(choice.lot, choice.location)
        position = page.lots.index(choice.lot)
        visits = list(choice.location.visits)
        text = lot_text(choice.lot, choice.location)
        street = choice.location.street
    else:
        fields = _ambiguous_fields(page, locations)
        position = None
        visits = list(dict.fromkeys(visit for location in locations for visit in location.visits))
        text = "\n".join(part for part in (fields["title"], fields["city"], fields["address"]) if part)
        street = _common([location.street for location in locations]) if fields["city"] else None

    # Lot dont la vente affichait déjà les valeurs : celui de la sélection précédente, sinon le premier
    # (l'ancienne lecture prenait toujours le premier lot, quelle que soit l'URL).
    previous = raw_sale.get(LOT_SELECTION_KEY)
    shown_lot = previous.get("lot_number") if isinstance(previous, dict) else 1
    same_place = _same_place(raw_sale, fields, street)
    if choice.status == SELECTED and choice.lot is not None:
        keep_shown = same_place and shown_lot == choice.lot.number
    else:
        keep_shown = same_place
    if keep_shown:
        # Le lot déjà affiché : l'adresse et le code postal complétés depuis (géocodage) restent, comme une
        # occupation déjà établie (pièces, relecture) que la fiche ne fait que déclarer.
        fields["address"] = raw_sale.get("address") or fields["address"]
        fields["postal_code"] = raw_sale.get("postal_code") or fields["postal_code"]
        if raw_sale.get("occupancy_status") not in (None, "", "unknown") and choice.status == SELECTED:
            fields["occupancy_status"] = raw_sale["occupancy_status"]
    if lot_coordinates is not None:
        # Collecte : le point du plan du lot, ou aucun (jamais celui du premier lot pour un autre).
        coordinates: tuple[str | None, str | None] | None = None
        if len(lot_coordinates) == len(page.lots):
            if position is not None:
                coordinates = lot_coordinates[position]
            elif len(set(lot_coordinates)) == 1:
                coordinates = lot_coordinates[0]
        raw_sale["latitude"], raw_sale["longitude"] = coordinates if coordinates is not None else (None, None)
    if not keep_shown:
        # Recalcul : le point stocké (plan ou géocodage) est celui d'un autre lot ou d'une autre adresse.
        if lot_coordinates is None:
            raw_sale["latitude"] = raw_sale["longitude"] = None
        for key in _GEO_PAYLOAD_KEYS:
            raw_sale.pop(key, None)

    blocks = dict(raw_sale.get("source_blocks") or {}) if isinstance(raw_sale.get("source_blocks"), dict) else {}
    for key in _LOT_FIELDS:
        raw_sale[key] = fields.get(key)
        block = _LOT_BLOCKS.get(key)
        if block is None:
            continue
        if fields.get(key) not in (None, ""):
            blocks[block] = fields[key]
        else:
            blocks.pop(block, None)
    raw_sale["visit_dates"] = visits
    if visits:
        blocks["visites"] = " | ".join(visits)
    else:
        blocks.pop("visites", None)
    if choice.lot is not None:
        blocks["lot_vendu"] = choice.lot.label or f"Lot {choice.lot.number}"
    else:
        blocks.pop("lot_vendu", None)
    raw_sale["source_blocks"] = blocks
    raw_sale[LOT_SELECTION_KEY] = {
        key: value
        for key, value in {
            "status": choice.status,
            "lot_number": choice.lot.number if choice.lot is not None else None,
            "lot_label": choice.lot.label if choice.lot is not None else None,
            "lot_count": len(page.lots),
            "reason": choice.reason,
            "lot_text": text,
        }.items()
        if value not in (None, "")
    }
    return choice


__all__ = [
    "apply_licitor_lot",
    "extract_land_surface_m2",
    "postal_code_from_arrondissement",
    "select_licitor_lot",
    "slug",
    "text_facts",
]
