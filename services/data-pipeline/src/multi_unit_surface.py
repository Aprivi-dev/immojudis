"""Surface d'un seul logement présentée comme celle d'une vente qui en compte plusieurs.

Audit du 03/11/2026 : « Comprenant 4 appartements : - appartement … de 74,59 m² ; - appartement … 68,85 m² … »
affiché 74,59 m² ; « UN LOGEMENT de 19,27 m2 … UN LOGEMENT de 50,22 m2 » ; un immeuble affiché avec la
surface de son restaurant. Quand le texte présente au moins deux logements ou locaux avec chacun sa surface,
et que la surface retenue est l'une d'elles (pas leur somme), elle n'est pas publiée.

Un terrain ou une annexe nommé entre le logement et la valeur reçoit cette valeur : « Un pavillon … de 95,26 m²
… une maison d'habitation … construite sur un terrain de forme rectangulaire de 207 m² » (e34acc33) décrit un
seul logement, pas deux.

Une copropriété vendue en plusieurs lots dont un seul est un logement, les autres des annexes (cave, parkings,
jardin), a la surface de ce logement : « -lot n°5 : … un local à usage d'habitation … présentant une superficie
de 75,34 m² … -lot n°10 : … une cave … » (991d7119).
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from src.enrichment.surface_text_rules import value_belongs_to_other_object

_UNIT_SURFACE_RE = re.compile(
    r"(?:^|[\s:;,(\-–−])(?:un|une|1|l['’])\s*(?P<noun>appartement|logement|studio|maison|pavillon|local\s+(?:commercial|d['’]activit[ée]s?)|"
    r"commerce|bureau)\b(?P<gap>[^.;]{0,120}?)(?<![\d,.])(\d{1,4}(?:[,.]\d{1,2})?)\s*m\s*(?:2|²)",
    re.I,
)
# « - appartement de l'étage 1 nord, … de 74,59 m² ; - appartement de l'… » : énumération par tirets.
_DASHED_UNIT_SURFACE_RE = re.compile(
    r"[-–−•]\s*(?P<noun>appartement|logement|studio|local\s+commercial)\b(?P<gap>[^.;]{0,120}?)(?<![\d,.])(\d{1,4}(?:[,.]\d{1,2})?)\s*m\s*(?:2|²)",
    re.I,
)


def listed_unit_surfaces(text: str | None) -> set[Decimal]:
    """Surfaces distinctes des logements ou locaux introduits un par un dans le texte."""
    values: set[Decimal] = set()
    for pattern in (_UNIT_SURFACE_RE, _DASHED_UNIT_SURFACE_RE):
        for match in pattern.finditer(text or ""):
            value = _decimal(match.group(3))
            if value is None or value_belongs_to_other_object(match.group("gap"), value):
                continue
            values.add(value)
    return values


def is_single_unit_surface_of_several(text: str | None, value: Decimal | None) -> bool:
    """Vrai si ``value`` est la surface d'un des logements d'une vente qui en présente plusieurs."""
    if value is None:
        return False
    units = listed_unit_surfaces(text)
    if len(units) < 2 or value == sum(units, Decimal("0")):
        return False
    return any(abs(value - unit) <= Decimal("0.01") for unit in units)


# --- logement unique parmi des lots de copropriété ---------------------------------------------------------

_LOT_MARKER_RE = re.compile(r"(?:^|[\s\-–−•(])lots?\s*(?:n\s*[°o]\s*|num[ée]ro\s+)?(?P<number>\d{1,4})\s*[:\-–]", re.I)
_DWELLING_LOT_RE = re.compile(
    r"\b(?:appartement|logement|studio|duplex|maison|pavillon|local\s+(?:[àa]\s+usage\s+)?d['’]\s*habitation)\b", re.I
)
_ANNEX_LOT_RE = re.compile(
    r"\b(?:caves?|parkings?|box|garages?|jardins?|celliers?|greniers?|combles?|stationnements?|emplacements?"
    r"|remises?|d[ée]barras|cours?|terrasses?|balcons?|piscines?)\b",
    re.I,
)
_LOT_SURFACE_RE = re.compile(
    r"\b(?:superficie|surface)\s+(?:(?:privative|habitable|totale)\s+)?(?:de\s+|d['’]environ\s+|:\s*)"
    r"(?<![\d,.])(\d{1,4}(?:[,.]\d{1,2})?)\s*m\s*(?:2|²)",
    re.I,
)
_ANY_SURFACE_RE = re.compile(r"(?<![\d,./])(\d{1,4}(?:[,.]\d{1,2})?)\s*m\s*(?:2|²)", re.I)


def single_dwelling_lot_surface(text: str | None) -> Decimal | None:
    """Surface du seul logement d'une vente de lots de copropriété dont les autres lots sont des annexes.

    Il faut au moins deux lots numérotés, un seul lot de logement, tous les autres lots reconnus comme annexes
    (cave, parking, jardin…), et dans le lot de logement une seule valeur en m², annoncée par « superficie » ou
    « surface » (pas une pièce). Un même lot recopié plusieurs fois (description, texte de la page) doit
    donner la même valeur. Sinon : ``None``.
    """
    markers = list(_LOT_MARKER_RE.finditer(text or ""))
    if len(markers) < 2:
        return None
    dwelling_lots: dict[str, set[Decimal]] = {}
    other_lots: set[str] = set()
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text or "")
        body = (text or "")[marker.end() : end]
        number = marker.group("number")
        # La nature du lot est le premier bien nommé : « un jardin … attenant à l'appartement » est un jardin.
        dwelling = _DWELLING_LOT_RE.search(body)
        annex = _ANNEX_LOT_RE.search(body)
        if dwelling and (annex is None or dwelling.start() < annex.start()):
            values = {_decimal(match.group(1)) for match in _ANY_SURFACE_RE.finditer(body)}
            stated = {_decimal(match.group(1)) for match in _LOT_SURFACE_RE.finditer(body)}
            if len(values) != 1 or values != stated:
                return None
            dwelling_lots.setdefault(number, set()).update(values)
        elif annex:
            other_lots.add(number)
        else:
            return None
    if len(dwelling_lots) != 1 or not other_lots:
        return None
    (values,) = dwelling_lots.values()
    if len(values) != 1 or None in values:
        return None
    (value,) = values
    return value


def _decimal(value: str) -> Decimal | None:
    try:
        return Decimal(value.replace(",", "."))
    except InvalidOperation:
        return None
