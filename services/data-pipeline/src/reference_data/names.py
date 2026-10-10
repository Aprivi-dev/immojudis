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
