"""Empreintes SHA-256 écrites en hexadécimal : deux règles, voulues.

* ``is_sha256`` : empreinte calculée par le pipeline et relue dans un cache local, une preuve de pièce ou une
  revendication de fait ; les espaces autour et les majuscules sont admis.
* ``is_lowercase_sha256`` : empreinte relue telle quelle d'une base ou d'un fichier contrôlé (``encode(...,
  'hex')`` de Postgres, exports de relecture, contrat Judilibre, clé du cache LLM) ; la forme exacte fait partie
  du contrôle.
"""

from __future__ import annotations

from src.null_text import clean_text

_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_LOWERCASE_HEX_DIGITS = frozenset("0123456789abcdef")


def is_sha256(value: object) -> bool:
    text = clean_text(value) or ""
    return len(text) == 64 and all(character in _HEX_DIGITS for character in text)


def is_lowercase_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in _LOWERCASE_HEX_DIGITS for character in value)
