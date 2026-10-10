"""Feature extraction helpers shared by source adapters.

These helpers only normalize source text and merge already validated values.
Source-specific URL policy, field precedence, and persistence stay in the
individual adapters.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from src.normalize import SURFACE_VALUE_PATTERN, clean_text


def is_mixed_property(text: str | None) -> bool:
    value = clean_text(text) or ""
    if not value:
        return False
    residential = re.search(
        r"\b(?:habitation|habitations|logement|logements|appartement|maison)\b",
        value,
        re.I,
    )
    commercial = re.search(
        r"\b(?:commerce|commercial(?:e|es)?|bureaux|local(?:ux)?|industriel(?:le|les)?|centre\s+[ée]questre)\b",
        value,
        re.I,
    )
    if not (residential and commercial):
        return False
    return bool(
        re.search(
            r"\b(?:usage\s+mixte|mixte|partie\s+[àa]\s+usage|ensemble\s+immobilier|b[âa]timent|immeuble)\b",
            value,
            re.I,
        )
    )


def normalize_document_text(value: str | None) -> str:
    text = clean_text(value) or ""
    return (
        text.lower()
        .replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("â", "a")
        .replace("î", "i")
        .replace("ï", "i")
        .replace("ô", "o")
        .replace("û", "u")
        .replace("ù", "u")
        .replace("ç", "c")
    )


def merge_documents(
    existing: object,
    incoming: list[dict[str, str]],
) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    by_url: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming]:
        if isinstance(document, dict) and document.get("url"):
            by_url[str(document["url"])] = {
                "label": str(document.get("label") or "document"),
                "url": str(document["url"]),
                "type": str(document.get("type") or "pdf"),
            }
    return list(by_url.values())


def merge_text_values(existing: object, incoming: object) -> list[str]:
    values: list[str] = []
    for item in [*as_text_list(existing), *as_text_list(incoming)]:
        if item not in values:
            values.append(item)
    return values


def as_text_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value] if clean_text(value) else []
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := clean_text(item))]


def extract_qualified_surface(
    text: str | None,
    kind: str,
    normalize_surface_number: Callable[[str], str | None],
) -> str | None:
    value = clean_text(text) or ""
    if not value:
        return None
    number = rf"{SURFACE_VALUE_PATTERN}\s*(?:m\s*(?:²|2)|²)\b"
    if kind == "carrez":
        patterns = (
            rf"\b{number}\s*(?:de\s+)?(?:surface\s+)?loi\s+carrez\b",
            rf"(?:surface\s+)?loi\s+carrez(?:\s+(?:totale|privative))?\s*(?:-|:|de)?\s*{number}",
        )
    elif kind == "habitable":
        patterns = (
            rf"\b(?:surface|superficie)\s+habitable(?:\s+totale)?\s*(?:est\s+)?(?:de|:)\s*{number}",
            rf"\b{number}\s*(?:de\s+)?surface\s+habitable\b",
        )
    else:
        return None
    candidates = [
        normalize_surface_number(match.group(1))
        for pattern in patterns
        for match in re.finditer(pattern, value, re.I)
    ]
    candidates = [candidate for candidate in candidates if candidate]
    return candidates[0] if len(candidates) == 1 else None


def cadastral_to_m2(match: re.Match[str]) -> str | None:
    hectares = int(match.group(1) or 0)
    ares = int(match.group(2) or 0)
    centiares = int(match.group(3))
    return str(hectares * 10000 + ares * 100 + centiares)


_ROOM_COUNT_WORDS = {
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


def parse_room_count(value: str) -> int | None:
    token = value.lower().strip()
    if token.isdigit():
        count = int(token)
        return count if count > 0 else None
    return _ROOM_COUNT_WORDS.get(token)


def extract_rooms_count(text: str | None, title: str | None = None) -> int | None:
    detail = clean_text(text) or ""
    heading = clean_text(title) or ""
    if not detail and not heading:
        return None

    direct_title = re.search(
        r"\b(?:appartement|maison|studio)\b[^.]{0,40}?\b(?:de\s+type\s*)?T?([1-9])\b",
        heading,
        re.I,
    )
    if direct_title:
        return int(direct_title.group(1))

    combined = " ".join(part for part in (heading, detail) if part)
    if re.search(
        r"\b(?:vente\s+en\s+\d+\s+lots?|r[ée]union\s+des\s+lots?|ensemble\s+immobilier|plusieurs\s+(?:appartements?|maisons?|logements?))\b",
        combined,
        re.I,
    ) or len(re.findall(r"\blots?\s*(?:n[°o.]?\s*)?\d+\b", combined, re.I)) >= 2:
        return None

    qualified_type = re.search(
        r"\b(?:appartement|maison|studio)\b[^.]{0,100}?\b(?:de\s+type\s*)?T?([1-9])\b",
        detail,
        re.I,
    )
    if qualified_type:
        return int(qualified_type.group(1))

    piece_matches = [
        parse_room_count(match.group(1))
        for match in re.finditer(
            r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+pi[eè]ces?\s+principales?\b",
            detail,
            re.I,
        )
    ]
    piece_matches.extend(
        parse_room_count(match.group(1))
        for match in re.finditer(
            r"\b(?:appartement|maison|villa)\s+(?:de\s+)?([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+pi[eè]ces?\b",
            detail,
            re.I,
        )
    )
    unique_pieces = {value for value in piece_matches if value}
    if len(unique_pieces) == 1:
        return next(iter(unique_pieces))
    if len(unique_pieces) > 1:
        return None

    if len(re.findall(r"\bpi[eè]ce\s+principale\b", detail, re.I)) == 1 and not re.search(
        r"\b(?:chambres?|\d+\s+pi[eè]ces?)\b", detail, re.I
    ):
        return 1
    return None


def extract_parking_count(text: str | None) -> int | None:
    detail = clean_text(text) or ""
    if not detail:
        return None
    token = r"[1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix"
    patterns = (
        rf"\b({token})\s+(?:emplacements?|places?)\s+(?:de\s+)?(?:parking|stationnement)\b",
        rf"\b({token})\s+(?:parkings?|stationnements?)\b",
        rf"\b(?:parking|stationnement)\s*:\s*({token})\b",
    )
    values = [
        parse_room_count(match.group(1))
        for pattern in patterns
        for match in re.finditer(pattern, detail, re.I)
    ]
    values = [value for value in values if value is not None]
    if len(values) == 1:
        return values[0]
    if len(values) > 1:
        return None
    if re.search(r"\b(?:visiteur|public|proximit[ée]|proche)\b", detail, re.I):
        return None
    if len(re.findall(r"\b(?:parking|stationnement|box|garage)\b", detail, re.I)) == 1:
        return 1
    return None
