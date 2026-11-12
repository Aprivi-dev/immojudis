"""Repli du texte français pour comparer des libellés : accents, ASCII, ponctuation.

Trois briques, que chaque module compose avec sa propre règle de casse ou d'espaces :

- ``strip_accents`` retire les accents et garde les autres caractères non ASCII (« œ », « ’ », « ß »,
  l'alphabet cyrillique…) ;
- ``to_ascii`` retire les accents puis tout caractère non ASCII restant (« cœur » devient « cur ») ;
- ``ascii_alnum_words`` remplace par un séparateur chaque suite de caractères autres que ``a-z0-9``.

Les deux replis passent par NFKD : les ligatures typographiques (« ﬁ ») et les exposants (« m² »)
deviennent leurs lettres et chiffres ordinaires, l'espace insécable devient une espace.
"""

from __future__ import annotations

import re
import unicodedata

_NOT_ASCII_ALNUM = re.compile(r"[^a-z0-9]+")
_WHITESPACE = re.compile(r"\s+")


def strip_accents(text: str) -> str:
    """NFKD puis suppression des marques combinantes ; les autres caractères non ASCII restent."""
    return "".join(char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char))


def to_ascii(text: str) -> str:
    """NFKD puis suppression de tout caractère non ASCII : accents, « œ », « ’ », « ß », autres alphabets."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def ascii_lower_single_spaced(text: str) -> str:
    """``to_ascii`` en minuscules, chaque suite d'espaces réduite à une espace, sans espace aux bords."""
    return _WHITESPACE.sub(" ", to_ascii(text).lower()).strip()


def ascii_alnum_words(lowered: str, separator: str = " ") -> str:
    """Chaque suite de caractères autres que ``a-z0-9`` devient ``separator``, retiré aux deux bouts.

    Le texte reçu est déjà replié et mis en minuscules : une majuscule restante compte comme séparateur.
    """
    return _NOT_ASCII_ALNUM.sub(separator, lowered).strip(separator)
