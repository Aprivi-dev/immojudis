"""Nombres de pièces, de chambres et de stationnements lus dans une fiche (valeurs ou texte libre).

Extrait de ``normalize.py`` (plafond de taille des fichiers) ; ``normalize`` en ré-exporte les
fonctions publiques.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from src.null_text import clean_text


def parse_rooms_count(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        rooms = int(value)
        return rooms if rooms > 0 else None
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"[1-9][0-9]?", text)
    return int(match.group(0)) if match else None


def parse_parking_count(value: object | None) -> int | None:
    """Parse a non-negative parking count while preserving an explicit zero."""

    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            numeric = Decimal(str(value))
        except (InvalidOperation, ValueError):
            return None
        if not numeric.is_finite() or numeric != numeric.to_integral_value():
            return None
        count = int(numeric)
        return count if count >= 0 else None
    text = clean_text(value)
    if not text:
        return None
    decimal_match = re.search(r"(?<!\d)([0-9]+[.,][0-9]+)(?!\d)", text)
    if decimal_match:
        try:
            numeric = Decimal(decimal_match.group(1).replace(",", "."))
        except InvalidOperation:
            return None
        if not numeric.is_finite() or numeric != numeric.to_integral_value():
            return None
        return int(numeric) if numeric >= 0 else None
    if re.fullmatch(r"0+", text):
        return 0
    match = re.search(r"\b([1-9][0-9]?)\b", text)
    return int(match.group(1)) if match else None


def parse_bedrooms_count(value: object) -> int | None:
    return parse_rooms_count(value)


def extract_rooms_count_from_text(*values: object) -> int | None:
    text = clean_text(" ".join(str(value) for value in values if value))
    if not text:
        return None

    for match in re.finditer(r"\bstudio\b", text, re.I):
        if not _is_rooms_count_false_positive(text, match.start(), match.end()):
            return 1

    patterns = (
        r"\b(?:appartement|maison|villa)\b.{0,80}?\blots?\s+\d+\s*,\s*"
        r"([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+[1-9][0-9]?\s*chambres?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+"
        r"[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²)\s+(?:superficie|surface)\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+(?:à\s+propos\s+du\s+bien|a\s+propos\s+du\s+bien)\b",
        r"\b(?:appartement|maison|villa|immeuble)\s+(?:de\s+)?([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b(?:appartement|maison|villa)\s+de\s+[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²)\s*,?\s+de\s+([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b(?:nombre\s+de\s+)?pi[eèé]ces?\s*(?:principales?)?\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\bappartement\s+(?:de\s+)?type\s*([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\btype\s+([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\b(?:type\s+)?[TF]\s*([1-9])\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_count_false_positive(text, match.start(1), match.end(1)):
                continue
            return _parse_count_token(match.group(1))

    if re.search(r"\b(?:(?:une|1)\s+)?pi[eèé]ce\s+principale\b", text, re.I):
        return 1
    return None


def extract_bedrooms_count_from_text(*values: object) -> int | None:
    text = clean_text(" ".join(str(value) for value in values if value))
    if not text:
        return None

    numbered = _count_numbered_bedrooms(text)
    if numbered is not None:
        return numbered

    patterns = (
        r"\b[1-9][0-9]?\s*pi[eèé]ces?\s+([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b",
        r"\bchambres?\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_count_false_positive(text, match.start(), match.end()):
                continue
            return _parse_count_token(match.group(1))
    return None


def _parse_count_token(value: str) -> int | None:
    value = value.lower().strip()
    if value.isdigit():
        rooms = int(value)
        return rooms if rooms > 0 else None
    mapping = {
        "un": 1,
        "une": 1,
        "deux": 2,
        "trois": 3,
        "quatre": 4,
        "cinq": 5,
        "six": 6,
        "sept": 7,
        "huit": 8,
        "neuf": 9,
        "dix": 10,
    }
    return mapping.get(value)


def _count_numbered_bedrooms(text: str) -> int | None:
    matches = re.findall(r"\bchambre\s*(?:n[°o]\s*)?([1-9][0-9]?)\b", text, re.I)
    if not matches:
        return None
    numbers = {int(match) for match in matches}
    if len(numbers) >= 2 and numbers == set(range(1, max(numbers) + 1)):
        return max(numbers)
    return None


def _is_rooms_count_false_positive(text: str, start: int, end: int) -> bool:
    nearby = text[max(0, start - 20) : min(len(text), end + 30)]
    if re.search(r"\bchambres?\s+froides?\b", nearby, re.I):
        return True
    after_number = text[end : min(len(text), end + 20)]
    if re.match(r"\s*[,.]\d+\s*m(?:2|²)\b", after_number, re.I):
        return True
    nearby = text[max(0, start - 40) : min(len(text), end + 80)]
    if re.search(r"\b(?:d[ée]pendance|annexe|remise)\b", nearby, re.I):
        return True
    before = text[max(0, start - 180) : start]
    after = text[end : min(len(text), end + 160)]
    context = before + after
    return bool(
        re.search(
            r"donnn?[ée]es?\s+des\s+valeurs\s+fonci[èe]res|prix\s+de\s+vente|date\s+de\s+vente|nb\s+de\s+pi[eèé]ces|article|page|"
            r"tous\s+les\s+biens|villa\s+maison\s+appartement\s+studio\s+terrain",
            context,
            re.I,
        )
    )
