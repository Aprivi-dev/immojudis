"""Surface d'un seul logement présentée comme celle d'une vente qui en compte plusieurs.

Audit du 03/11/2026 : « Comprenant 4 appartements : - appartement … de 74,59 m² ; - appartement … 68,85 m² … »
affiché 74,59 m² ; « UN LOGEMENT de 19,27 m2 … UN LOGEMENT de 50,22 m2 » ; un immeuble affiché avec la
surface de son restaurant. Quand le texte présente au moins deux logements ou locaux avec chacun sa surface,
et que la surface retenue est l'une d'elles (pas leur somme), elle n'est pas publiée.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

_UNIT_SURFACE_RE = re.compile(
    r"(?:^|[\s:;,(\-–−])(?:un|une|1|l['’])\s*(?:appartement|logement|studio|maison|pavillon|local\s+(?:commercial|d['’]activit[ée]s?)|"
    r"commerce|bureau)\b[^.;]{0,120}?(?<![\d,.])(\d{1,4}(?:[,.]\d{1,2})?)\s*m\s*(?:2|²)",
    re.I,
)
# « - appartement de l'étage 1 nord, … de 74,59 m² ; - appartement de l'… » : énumération par tirets.
_DASHED_UNIT_SURFACE_RE = re.compile(
    r"[-–−•]\s*(?:appartement|logement|studio|local\s+commercial)\b[^.;]{0,120}?(?<![\d,.])(\d{1,4}(?:[,.]\d{1,2})?)\s*m\s*(?:2|²)",
    re.I,
)


def listed_unit_surfaces(text: str | None) -> set[Decimal]:
    """Surfaces distinctes des logements ou locaux introduits un par un dans le texte."""
    values: set[Decimal] = set()
    for pattern in (_UNIT_SURFACE_RE, _DASHED_UNIT_SURFACE_RE):
        for match in pattern.finditer(text or ""):
            try:
                values.add(Decimal(match.group(1).replace(",", ".")))
            except InvalidOperation:
                continue
    return values


def is_single_unit_surface_of_several(text: str | None, value: Decimal | None) -> bool:
    """Vrai si ``value`` est la surface d'un des logements d'une vente qui en présente plusieurs."""
    if value is None:
        return False
    units = listed_unit_surfaces(text)
    if len(units) < 2 or value == sum(units, Decimal("0")):
        return False
    return any(abs(value - unit) <= Decimal("0.01") for unit in units)
