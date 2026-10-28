"""Commune name normalisation, mirrored by ``src/lib/commune-names.ts``."""

from __future__ import annotations

import re
import unicodedata

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_PREFIXES = (("st ", "saint "), ("ste ", "sainte "))


def normalize_commune_name(value: str | None) -> str:
    """Lowercase, strip accents and punctuation, expand ``St``/``Ste``.

    ``Saint-Étienne``, ``ST ETIENNE`` and ``saint etienne`` all become
    ``saint etienne``. Leading articles are kept: ``Le Mans`` stays ``le mans``.
    """
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_only = "".join(char for char in decomposed if not unicodedata.combining(char))
    words = _NON_ALNUM.sub(" ", ascii_only.lower()).split()
    normalized = " ".join(words)
    for short, long in _PREFIXES:
        if normalized.startswith(short):
            normalized = long + normalized[len(short) :]
        normalized = normalized.replace(f" {short}", f" {long}")
    return normalized


def department_from_insee(code_insee: str) -> str:
    """Department of an INSEE commune code (``2A004`` -> ``2A``, ``97411`` -> ``974``)."""
    return code_insee[:3] if code_insee.startswith("97") else code_insee[:2]


# Name of the commune as a LOOKUP key (never stored): the label of a sale often carries more than the commune name.
# ``paris 8eme``, ``marseille 8e``, ``lyon 3e arrondissement``, ``lyon cedex 03`` and ``saint denis la reunion``
# all name a commune the reference table knows as ``paris``, ``marseille``, ``lyon`` and ``saint denis``. The stored
# column ``reference_communes.name_normalized`` keeps ``normalize_commune_name``; this mirror is
# ``app_private.commune_lookup_name`` (migration 20261108120000).
_TRAILING_DEPARTMENT = re.compile(r"\s*\((?:\d{2}|2[AB]|97\d)\)\s*$", re.IGNORECASE)
_ARRONDISSEMENT = re.compile(r"\b\d{1,2} ?(?:er|ere|e|eme)\b")
_ARRONDISSEMENT_WORD = re.compile(r"\b(?:arrondissement|arr)\b")
_CEDEX = re.compile(r"\bcedex(?: \d+)?\b")
_BIG_CITY_NUMBER = re.compile(r"^(paris|lyon|marseille) (?:\d{1,2}|[ivx]{1,5}(?:er|ere|e|eme)?)$")
_OVERSEAS_SUFFIX = re.compile(r"(?<=\S) (?:la reunion|reunion|guadeloupe|martinique|guyane|mayotte)$")
_ROMAN = {"i": 1, "v": 5, "x": 10}


def has_cedex(value: str | None) -> bool:
    return bool(_CEDEX.search(normalize_commune_name(value)))


def commune_lookup_name(value: str | None) -> str:
    """Normalised name of the commune named by a sale label, without arrondissement, Cedex or overseas region.

    ``Paris 8ème`` -> ``paris`` ; ``Lyon 3e arrondissement`` -> ``lyon`` ; ``Lyon Cedex 03`` -> ``lyon`` ;
    ``Saint-Denis La Réunion`` -> ``saint denis``. A name made only of those words stays as it is.
    """
    name = normalize_commune_name(_TRAILING_DEPARTMENT.sub("", value or ""))
    stripped = _CEDEX.sub(" ", name)
    stripped = _ARRONDISSEMENT.sub(" ", stripped)
    stripped = _ARRONDISSEMENT_WORD.sub(" ", stripped)
    stripped = " ".join(stripped.split())
    if not stripped:
        return name
    without_region = _OVERSEAS_SUFFIX.sub("", stripped)
    # « La Réunion » alone is not « la » + a region.
    stripped = without_region if without_region not in ("la", "le", "les") else stripped
    big_city = _BIG_CITY_NUMBER.match(stripped)
    return big_city.group(1) if big_city else stripped


def arrondissement_number(value: str | None) -> int | None:
    """Number of the arrondissement named in a label (``Marseille 8e`` -> 8, ``Paris XVIème`` -> 16), else ``None``."""
    name = normalize_commune_name(_TRAILING_DEPARTMENT.sub("", value or ""))
    match = re.search(r"\b(\d{1,2}) ?(?:er|ere|e|eme)\b", name)
    if match is None:
        match = re.fullmatch(r"(?:paris|lyon|marseille) (\d{1,2})", name)
    if match is not None:
        return int(match.group(1))
    roman = re.fullmatch(r"(?:paris|lyon|marseille) ([ivx]{1,5})(?:er|ere|e|eme)?", name)
    if roman is None:
        return None
    total = 0
    digits = [_ROMAN[char] for char in roman.group(1)]
    for index, digit in enumerate(digits):
        total += -digit if index + 1 < len(digits) and digit < digits[index + 1] else digit
    return total or None
