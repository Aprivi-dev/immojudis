"""Superficie bâtie lue dans le texte libre d'une annonce, formulations non couvertes par normalize.py.

Formulations observées sur des annonces stockées SANS superficie alors que le texte la donne :

* « APPARTEMENT DE 2 PIECES (55,31 m²) A CANNES » : surface entre parenthèses après le nombre de pièces ;
* « CHALET de 180 m² sur 3 niveaux » : types de bien absents de la liste historique (chalet, pavillon, duplex…) ;
* « le certificat de mesurage … conclut à une superficie de 58,04 m² » ;
* « d'une surface globale d'environ 144 m² ».

Garde-fous : une seule valeur distincte doit ressortir du texte (sinon c'est un lot multiple : on s'abstient) ;
les sources dont la page mêle des bandeaux d'actualités ou d'autres annonces (petites_affiches, vench) sont exclues.
"""

from __future__ import annotations

import re
from decimal import Decimal

EXCLUDED_SOURCES = frozenset({"petites_affiches", "vench"})
_NUMBER = r"([0-9]+(?:[\s.][0-9]{3})*(?:[,.][0-9]+)?|[0-9]+(?:[,.][0-9]+)?)"
_M2 = r"m\s?(?:2|²)"
_PATTERNS = (
    re.compile(rf"\bpi[eè]ces?(?:\s+principales?)?\s*\(\s*{_NUMBER}\s*{_M2}\s*\)", re.I),
    re.compile(
        r"\b(?:chalet|pavillon|duplex|triplex|loft|studio|appartement|maison|villa)\b"
        rf"[^.\n]{{0,60}}?\b(?:de|d['’]environ|d['’]une\s+surface\s+de)\s+{_NUMBER}\s*{_M2}",
        re.I,
    ),
    re.compile(rf"\bmesurage\b[^.\n]{{0,160}}?\bsuperficie\s+de\s+{_NUMBER}\s*{_M2}", re.I),
    re.compile(rf"\bsurface\s+(?:globale|totale)\s+(?:d['’]environ\s+|de\s+)?{_NUMBER}\s*{_M2}", re.I),
)


def _to_decimal(token: str) -> Decimal | None:
    cleaned = token.replace(" ", "").replace("\xa0", "")
    if re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{3})+", cleaned):
        cleaned = cleaned.replace(".", "")
    try:
        value = Decimal(cleaned.replace(",", "."))
    except ArithmeticError:
        return None
    return value if Decimal("1") <= value <= Decimal("100000") else None


def extra_built_surface_from_text(text: str | None, source_name: str | None = None) -> Decimal | None:
    """Superficie (m²) lue dans ``text``, ou ``None`` si absente ou ambiguë."""
    if not text or (source_name or "").lower() in EXCLUDED_SOURCES:
        return None
    values: set[Decimal] = set()
    for pattern in _PATTERNS:
        for match in pattern.finditer(text):
            value = _to_decimal(match.group(1))
            if value is not None:
                values.add(value)
    return next(iter(values)) if len(values) == 1 else None
