"""Superficie bâtie lue dans le texte libre d'une annonce, formulations non couvertes par normalize.py.

Formulations observées sur des annonces stockées SANS superficie alors que le texte la donne :

* « APPARTEMENT DE 2 PIECES (55,31 m²) A CANNES » : surface entre parenthèses après le nombre de pièces ;
* « CHALET de 180 m² sur 3 niveaux » : types de bien absents de la liste historique (chalet, pavillon, duplex…) ;
* « le certificat de mesurage … conclut à une superficie de 58,04 m² » ;
* « d'une surface globale d'environ 144 m² » ;
* « Jardin derrière Le tout représente une surface bâtie de 259,86 m² et cadastré : Section AD n°168 … 04 a et 69 ca »
  (ebafd1c4, audit du 03/11/2026) : le libellé « surface bâtie » qualifie la valeur, sauf s'il suit une annexe
  (« un garage d'une surface bâtie de 20 m² ») ou s'il s'agit d'une surface au sol.

Garde-fous : une seule valeur distincte doit ressortir du texte (sinon c'est un lot multiple : on s'abstient) ;
les sources dont la page mêle des bandeaux d'actualités ou d'autres annonces (petites_affiches, vench) sont exclues.
"""

from __future__ import annotations

import re
from decimal import Decimal

from src.enrichment.surface_text_rules import _DWELLING_NOUN_RE, value_belongs_to_other_object

EXCLUDED_SOURCES = frozenset({"petites_affiches", "vench"})
_NUMBER = r"([0-9]+(?:[\s.][0-9]{3})*(?:[,.][0-9]+)?|[0-9]+(?:[,.][0-9]+)?)"
_M2 = r"m\s?(?:2|²)"
_BUILT_LABEL = re.compile(
    rf"\b(?:surface|superficie)\s+(?:totale\s+)?(?:b[âa]tie|construite)(?:\s+totale)?\s*:?\s*"
    rf"(?:de\s+|d['’]environ\s+|environ\s+)?{_NUMBER}\s*{_M2}(?!\s*(?:de\s+)?(?:surface\s+)?au\s+sol)",
    re.I,
)
_PATTERNS = (
    re.compile(rf"\bpi[eè]ces?(?:\s+principales?)?\s*\(\s*{_NUMBER}\s*{_M2}\s*\)", re.I),
    re.compile(
        r"\b(?:chalet|pavillon|duplex|triplex|loft|studio|appartement|maison|villa)\b"
        rf"[^.\n]{{0,60}}?\b(?:de|d['’]environ|d['’]une\s+surface\s+de)\s+{_NUMBER}\s*{_M2}",
        re.I,
    ),
    re.compile(rf"\bmesurage\b[^.\n]{{0,160}}?\bsuperficie\s+de\s+{_NUMBER}\s*{_M2}", re.I),
    re.compile(rf"\bsurface\s+(?:globale|totale)\s+(?:d['’]environ\s+|de\s+)?{_NUMBER}\s*{_M2}", re.I),
    _BUILT_LABEL,
)
_ANNEX_LEAD = re.compile(
    r"\b(?:garages?|caves?|d[ée]pendances?|annexes?|abris?|remises?|granges?|hangars?|ateliers?|appentis|piscines?"
    r"|v[ée]randas?|extensions?)\b",
    re.I,
)


_VALUE_M2 = re.compile(rf"{_NUMBER}\s*{_M2}", re.I)


def built_value_names_other_object(text: str, start: int, end: int) -> bool:
    """« ancienne maison éclusière d'environ 80 m2 sur un terrain … d'une superficie de 1283 m2 » (db4a22d3) : la
    valeur lue après « maison » appartient au terrain nommé entre les deux, pas à la maison."""
    matched = text[start:end]
    values = list(_VALUE_M2.finditer(matched))
    if not values:
        return False
    lead = matched[: values[-1].start()]
    nouns = list(_DWELLING_NOUN_RE.finditer(lead))
    return bool(nouns) and value_belongs_to_other_object(lead[nouns[-1].end() :], _to_decimal(values[-1].group(1)))


def _names_an_annex(text: str, start: int) -> bool:
    """« un garage d'une surface bâtie de 20 m² » : la surface bâtie d'une annexe, pas celle du bien."""
    return bool(_ANNEX_LEAD.search(re.split(r"[.;:\n,]", text[max(0, start - 60) : start])[-1]))


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
            if pattern is _BUILT_LABEL and _names_an_annex(text, match.start()):
                continue
            value = _to_decimal(match.group(1))
            if value is not None:
                values.add(value)
    return next(iter(values)) if len(values) == 1 else None
