"""Un immeuble, ou une maison de plusieurs appartements, n'est pas « un appartement ».

« Immeuble de 4 appartements » contient le mot « appartement » : sans cette règle, la table de correspondance
des types le range en « appartement », et sa surface (celle d'un lot) est plafonnée et affichée comme celle d'un
logement. Seule une accroche qui annonce le bien lui-même compte (le texte commence par « immeuble de N
appartements », « maison de N appartements ») : « appartement dans un immeuble de 12 lots » reste un appartement.
"""

from __future__ import annotations

import re

_COUNT = r"(?:[2-9]|[1-9][0-9]|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze)"
# Texte sans accents, en minuscules (voir ``normalize_property_type``).
_MULTI_UNIT_BUILDING = re.compile(
    r"^\W*(?:vente\s+(?:d['’]\s*|de\s+)?)?(?:(?:un|une)\s+|l['’]\s*)?(?:immeuble|maison|batiment)\b[^.;\n]{0,40}?"
    rf"\b(?:de|comprenant|compose(?:e|es)?\s+de|avec|abritant|divise(?:e|es)?\s+en)\s+{_COUNT}\s+"
    r"(?:appartements?|logements?|studios?)\b",
)


def is_multi_unit_building_text(text: str | None) -> bool:
    """Vrai si ``text`` (sans accents, en minuscules) annonce un immeuble ou une maison de plusieurs logements."""
    return bool(text and _MULTI_UNIT_BUILDING.search(text))
