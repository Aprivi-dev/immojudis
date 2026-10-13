"""Textual stand-ins for a missing value (« nan », « None »…) that must never reach the database."""
from __future__ import annotations

import re

NULL_TEXT_VALUES = frozenset({"nan", "none", "null", "undefined"})


def is_null_text(value: object) -> bool:
    """True for a string that only spells a missing value, whatever its case."""
    return isinstance(value, str) and value.strip().casefold() in NULL_TEXT_VALUES


def null_if_placeholder(value: object) -> object:
    return None if is_null_text(value) else value


def clean_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()
    # « nan » is what str() makes of a missing pandas/JSON value; it is not a city or a name.
    return None if is_null_text(text) else text or None
