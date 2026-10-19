"""Garde-fous de vraisemblance des surfaces lues dans une annonce.

Quatre erreurs de lecture récurrentes, corrigées ici sans toucher au reste de la normalisation :

* une surface habitable (ou bâtie) égale à la surface du terrain est la contenance recopiée dans le mauvais
  champ (maison éclusière « d'environ 80 m² » affichée à 1 283 m², la parcelle) ;
* deux valeurs différentes, sans qualificatif, pour le même bien (« Superficie : 90,70 m² » puis
  « superficie de 20,70 m² ») : on ne sait pas laquelle est la bonne, la surface reste « à confirmer » ;
* une « superficie totale » qui conclut une liste de parcelles cadastrales est la contenance du terrain, pas
  une surface bâtie ;
* un total bâti n'est prouvé que par un texte qui dit « bâtie », « construite » ou « de plancher »
  (la simple mention « habitable » ne suffit pas à dépasser le plafond d'une maison).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from decimal import Decimal
from typing import Any

from src.normalize import SURFACE_VALUE_PATTERN, parse_surface, strip_accents

# Marqueur posé dans ``raw_payload`` tant que le texte donne deux valeurs sans qualificatif pour le même bien.
SURFACE_VALUES_CONFLICT_KEY = "surface_values_conflict"

_NUMBER_M2 = re.compile(rf"{SURFACE_VALUE_PATTERN}\s*(?:m\s*(?:2|²)|mètres?\s+carrés?)", re.I)

# --- deux valeurs sans qualificatif ----------------------------------------------------------------------

_GENERIC_SURFACE = re.compile(
    rf"\b(?:superficie|surface)(?!\s+(?:habitable|carrez|privative|utile|hors|au\s+sol|du\s+(?:sol|terrain)|"
    rf"terrain|de\s+plancher|b[âa]tie|totale))"
    rf"\s*(?::|de|d['’]environ|d['’]une|environ)?\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
    re.I,
)
# Mots qui peuvent précéder « superficie » sans rattacher la valeur à autre chose que le bien.
_FILLER_WORDS = frozenset(
    "un une le la les l de d du des pour avec soit environ et ou sa son ses cette ce ces notamment dont au aux "
    "en a y compris bien biens descriptif caracteristiques designation maison appartement villa immeuble studio".split()
)
# Un mot qui rattache la valeur qui suit à une annexe, une pièce, un lot ou un terrain.
_OTHER_SCOPE = re.compile(
    r"\b(?:lots?|terrains?|parcelles?|cadastr\w*|jardin|cave|garage|parking|balcon|terrasse|annexes?|"
    r"d[ée]pendances?|combles?|grenier|sous-sol|carrez|contenance|section|cour|piscine|v[ée]randa|"
    r"appentis|hangar|remise|grange|[ée]curie|[ée]table|atelier|abri|b[ûu]cher|chai|cellier|local|"
    r"pi[eè]ces?|s[ée]jour|salon|cuisine|chambres?|salle|bureau|entr[ée]e|mezzanine|dressing)\b",
    re.I,
)


def _starts_its_clause(text: str, start: int) -> bool:
    """Vrai si seuls des mots neutres séparent « superficie » du début de sa proposition.

    « Superficie : 90,70 m² » ou « Une superficie de 20,70 m² » désignent le bien ; « mur est, surface : 77 m² »
    ou « une grange attenante d'une surface d'environ 70 m² » désignent autre chose.
    """
    prefix = re.split(r"[.;\n]", text[max(0, start - 120) : start])[-1]
    words = re.findall(r"[a-zà-ÿ]+", strip_accents(prefix).lower())
    return all(word in _FILLER_WORDS for word in words)


def conflicting_generic_surfaces(text: str | None) -> list[Decimal]:
    """Valeurs distinctes de « superficie / surface » sans qualificatif, quand il y en a au moins deux.

    Une valeur n'entre dans la comparaison que si elle désigne le bien lui-même : « superficie » ouvre sa
    proposition (``_starts_its_clause``) et rien dans la suite immédiate ne la rattache à un lot, une annexe, une
    pièce ou un terrain. Les mesures typées (habitable, Carrez, totale) n'en font pas partie.
    """
    if not text:
        return []
    values: set[Decimal] = set()
    for match in _GENERIC_SURFACE.finditer(text):
        after = re.split(r"[.;\n]", text[match.end() : match.end() + 40])[0]
        if not _starts_its_clause(text, match.start()) or _OTHER_SCOPE.search(after):
            continue
        value = parse_surface(match.group(1))
        if value is not None and value > 0:
            values.add(value)
    return sorted(values) if len(values) > 1 else []


# --- superficie totale d'une liste de parcelles -----------------------------------------------------------

_PARCEL_CONTEXT = re.compile(r"\bcadastr\w*|\bsection\s+[A-Z]{1,2}\b|\bparcelles?\b", re.I)
_PARCEL_TOTAL = re.compile(
    rf"\b(?:soit|total(?:ement)?|pour)\s+(?:une\s+|la\s+)?(?:superficie|surface|contenance)\s+totale\s+"
    rf"(?:de\s+|d['’]environ\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)"
    rf"|\bcontenance\s+totale\s+(?:de\s+|d['’]environ\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
    re.I,
)


def parcel_total_surfaces(text: str | None) -> list[Decimal]:
    """Totaux annoncés à la suite de parcelles cadastrales (« …, soit superficie totale 1550 m² »)."""
    if not text:
        return []
    totals: list[Decimal] = []
    for match in _PARCEL_TOTAL.finditer(text):
        sentence = re.split(r"[.\n]\s", text[max(0, match.start() - 400) : match.start()])[-1]
        if not _PARCEL_CONTEXT.search(sentence):
            continue
        value = parse_surface(match.group(1) or match.group(2))
        if value is not None and value > 0:
            totals.append(value)
    return totals


def is_parcel_total(texts: Iterable[str | None], value: Decimal | None) -> bool:
    """Vrai si ``value`` est le total d'une liste de parcelles dans l'un des textes."""
    return value is not None and any(value in parcel_total_surfaces(text) for text in texts)


# --- total bâti prouvé -----------------------------------------------------------------------------------

_BUILT_TOTAL = re.compile(
    r"(?:surface|superficie)\s+(?:totale\s+)?(?:b[âa]tie|construite|de\s+plancher|d[ée]velopp[ée]e)(?:\s+totale)?|"
    r"(?:surface|superficie)\s+totale\s+(?:habitable|des\s+b[âa]timents)|total\s+b[âa]ti|b[âa]ti\s+total",
    re.I,
)
_LAND_WORDS = re.compile(r"\b(?:cadastr\w*|parcelles?|terrains?|contenance|section|sol)\b", re.I)


def source_proves_built_total(texts: Iterable[str | None], value: Decimal | None) -> bool:
    """Vrai si un texte donne ``value`` m² comme total bâti (« surface totale bâtie de … »).

    Le qualificatif doit être dans la même phrase que le nombre et aucun mot de terrain (parcelle, cadastre,
    contenance) ne doit s'y trouver : « soit superficie totale 1550 m² » après des parcelles n'est pas un total bâti.
    """
    if value is None:
        return False
    for text in texts:
        for match in _NUMBER_M2.finditer(text or ""):
            if parse_surface(match.group(1)) != value:
                continue
            before = re.split(r"[;\n]|\.\s", (text or "")[max(0, match.start() - 80) : match.start()])[-1]
            after = re.split(r"[;\n]|\.\s", (text or "")[match.end() : match.end() + 40])[0]
            window = f"{before} {match.group(0)} {after}"
            if _BUILT_TOTAL.search(window) and not _LAND_WORDS.search(window):
                return True
    return False


# --- surface bâtie égale au terrain ------------------------------------------------------------------------


def built_surfaces_equal_to_land(sale: Any) -> Iterator[str]:
    """Champs de surface bâtie (habitable, générique) qui valent exactement la surface du terrain."""
    land = sale.land_surface_m2
    if land is None or sale.property_type not in {"house", "apartment", "building"}:
        return
    for field in ("habitable_surface_m2", "surface_m2"):
        if getattr(sale, field) == land:
            yield field
