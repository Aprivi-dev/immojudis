"""Citation checks on the values the structured extraction wants to publish.

The model returns, with each fact, a short quote of the text it read. A value is kept only when
that quote really exists in the text that was sent (same test as the document reading,
``document_reading.grounded_quote``) and contains the word that field is about. Otherwise the value
is dropped (« unknown ») rather than trusted on the model's own confidence score.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from src.document_reading import MIN_QUOTE_CHARS, grounded_quote
from src.normalize import strip_accents
from src.occupancy_statements import OCCUPIED_FAMILY, VACANT, is_template_clause, occupancy_from_text

# A scalar field (type, rooms, occupation) is often supported by a very short quote (« Maison »,
# « Studio T2 »): shorter than the 12 characters asked of a document-reading quote.
SCALAR_QUOTE_MIN_CHARS = 6

_VACANT = re.compile(
    r"libre\s+de\s+(?:toute?s?\s+)?(?:occupation|occupant|locataire|location)|libre\s+d['’]occupation|"
    r"libre\s+de\s+tout|non\s+occup|inoccup|vacant|sans\s+occupant|pas\s+occup|inhabit|\blibre\b"
)
_OCCUPATION_KEYWORDS: dict[str, re.Pattern[str]] = {
    "occupied": re.compile(r"occup|habit|reside|\bloge\b"),
    "rented": re.compile(r"locat|\bloue|\blouer|bail|loyer|fermage"),
    "owner_occupied": re.compile(
        r"(?:proprietaire|debiteur|saisi).*(?:occup|habit|reside)|"
        r"(?:occup|habit|reside).*(?:proprietaire|debiteur|saisi)"
    ),
    "squatted": re.compile(r"squat|sans droit ni titre|occupation illicite|occupation sans titre"),
}
_PROPERTY_TYPE_KEYWORDS: dict[str, re.Pattern[str]] = {
    "apartment": re.compile(r"appartement|studio|duplex|triplex|\bf\s?\d\b|\bt\s?\d\b"),
    "house": re.compile(r"maison|villa|pavillon|chalet|longere"),
    "building": re.compile(r"immeuble|batiment|ensemble immobilier"),
    "land": re.compile(r"terrain|parcelle|a batir|lotissement"),
    "commercial": re.compile(r"\blocal\b|\blocaux\b|commerc|bureau|boutique|magasin|entrepot|atelier|hotel|restaurant"),
    "parking": re.compile(r"parking|garage|stationnement|\bbox\b"),
    "mixed": re.compile(r"mixte|habitation.*commerc|commerc.*habitation"),
}
_NUMBER_WORDS = {
    "un": 1, "une": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6, "sept": 7,
    "huit": 8, "neuf": 9, "dix": 10, "onze": 11, "douze": 12,
}  # fmt: skip


def _count_forms(value: int) -> str:
    """Regex alternatives for a count written as digits or as a French number word."""
    forms = [str(value), *(word for word, number in _NUMBER_WORDS.items() if number == value)]
    return "(?:" + "|".join(forms) + ")"


def _quote_states_count(text: str, value: int, noun: str) -> bool:
    """The quote writes ``value`` right next to the noun (« 3 pièces », « deux chambres »)."""
    number = _count_forms(value)
    return bool(
        re.search(rf"(?<![\d,.]){number}\s+(?:[a-z]+\s+)?{noun}", text)
        or re.search(rf"{noun}\s*(?:n°|no|:|=)?\s*{number}(?!\d)", text)
    )


def _normalized(text: str) -> str:
    return strip_accents(text).lower()


def cited_excerpt(context: str, item: object, *, min_chars: int = SCALAR_QUOTE_MIN_CHARS) -> str | None:
    """The excerpt of ``context`` that the evidence item quotes, or None when it is not there."""
    if not isinstance(item, Mapping) or not context:
        return None
    quote = item.get("quote")
    if not isinstance(quote, str) or not quote.strip():
        return None
    return grounded_quote(context, quote, min_chars=min_chars)


def grounded_field_quote(context: str, evidence: Mapping[str, Any] | None, field: str) -> str | None:
    """Excerpt of the text quoted for one scalar field, None when the quote is missing or invented."""
    item = (evidence or {}).get(field)
    if isinstance(item, list):
        item = item[0] if item else None
    return cited_excerpt(context, item)


def _same_occupancy_family(claimed: str, read: str | None) -> bool:
    """Free with free, or two statuses of the occupied family (occupied, rented, owner, squat)."""
    if claimed == VACANT:
        return read == VACANT
    return claimed in OCCUPIED_FAMILY and read in OCCUPIED_FAMILY


def occupancy_is_supported(context: str, status: str | None, evidence: Mapping[str, Any] | None) -> bool:
    """The quote exists, states this status and reads as a statement about this property.

    The quote must also give the same family of status with the grammar of ``occupancy_statements``
    (#403): a template clause of the conditions of sale (« Si l'immeuble est loué, l'adjudicataire fera
    son affaire du bail », « expulsion des occupants éventuels »), a conditional (« le bien serait
    occupé ») or a mixed sentence give no certain status there, so they support none here either.
    """
    excerpt = grounded_field_quote(context, evidence, "occupancy_status")
    if not excerpt or not status:
        return False
    if is_template_clause(excerpt) or not _same_occupancy_family(status, occupancy_from_text(excerpt).status):
        return False
    text = _normalized(excerpt)
    vacant = bool(_VACANT.search(text))
    if status == "vacant":
        return vacant
    pattern = _OCCUPATION_KEYWORDS.get(status)
    # A quote that also says the dwelling is free contradicts an occupation claim: unknown.
    return bool(pattern and pattern.search(text)) and not vacant


def property_type_is_supported(context: str, property_type: str | None, evidence: Mapping[str, Any] | None) -> bool:
    excerpt = grounded_field_quote(context, evidence, "property_type")
    if not excerpt or not property_type:
        return False
    if property_type == "other":
        return True
    pattern = _PROPERTY_TYPE_KEYWORDS.get(property_type)
    return bool(pattern and pattern.search(_normalized(excerpt)))


def rooms_count_is_supported(context: str, evidence: Mapping[str, Any] | None, value: int) -> bool:
    """The quote exists and states this very count (« 3 pièces », « T3 », « studio » for 1)."""
    excerpt = grounded_field_quote(context, evidence, "rooms_count")
    if not excerpt:
        return False
    text = _normalized(excerpt)
    return bool(
        _quote_states_count(text, value, r"pieces?")
        or re.search(rf"\b[tf]\s?{value}(?!\d)", text)
        or (value == 1 and "studio" in text)
    )


def bedrooms_count_is_supported(context: str, evidence: Mapping[str, Any] | None, value: int) -> bool:
    """The quote exists and states this very number of bedrooms."""
    excerpt = grounded_field_quote(context, evidence, "bedrooms_count")
    return bool(excerpt and _quote_states_count(_normalized(excerpt), value, r"chambres?"))


def cited_items(context: str, values: list[str], evidence: Mapping[str, Any] | None, field: str) -> list[str]:
    """Entries of one list field (risks, servitudes) whose quote, at the same position, is in the text."""
    raw = (evidence or {}).get(field)
    quotes = raw if isinstance(raw, list) else [raw] if isinstance(raw, Mapping) else []
    return [
        value
        for index, value in enumerate(values)
        if index < len(quotes) and cited_excerpt(context, quotes[index], min_chars=MIN_QUOTE_CHARS)
    ]

