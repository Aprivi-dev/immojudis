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
    "apartment": re.compile(r"appartement|studio|duplex|triplex|\bf\s?\d\b|\bt\s?\d\b|logement"),
    "house": re.compile(r"maison|villa|pavillon|chalet|habitation|longere"),
    "building": re.compile(r"immeuble|batiment|ensemble immobilier"),
    "land": re.compile(r"terrain|parcelle|cadastr|foncier|a batir|lotissement"),
    "commercial": re.compile(r"local|commerc|bureau|boutique|magasin|entrepot|atelier|hotel|restaurant"),
    "parking": re.compile(r"parking|garage|stationnement|\bbox\b|emplacement"),
    "mixed": re.compile(r"mixte|usage\s+professionnel|habitation.*commerc|commerc.*habitation"),
}
_ROOMS_KEYWORDS = re.compile(r"pieces?|\bf\s?\d\b|\bt\s?\d\b|studio")
_BEDROOMS_KEYWORDS = re.compile(r"chambre|bedroom")


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


def occupancy_is_supported(context: str, status: str | None, evidence: Mapping[str, Any] | None) -> bool:
    excerpt = grounded_field_quote(context, evidence, "occupancy_status")
    if not excerpt or not status:
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


def rooms_count_is_supported(context: str, evidence: Mapping[str, Any] | None) -> bool:
    excerpt = grounded_field_quote(context, evidence, "rooms_count")
    return bool(excerpt and _ROOMS_KEYWORDS.search(_normalized(excerpt)))


def bedrooms_count_is_supported(context: str, evidence: Mapping[str, Any] | None) -> bool:
    excerpt = grounded_field_quote(context, evidence, "bedrooms_count")
    return bool(excerpt and _BEDROOMS_KEYWORDS.search(_normalized(excerpt)))


def cited_items(context: str, values: list[str], evidence: Mapping[str, Any] | None, field: str) -> list[str]:
    """Entries of one list field (risks, servitudes) whose quote, at the same position, is in the text."""
    raw = (evidence or {}).get(field)
    quotes = raw if isinstance(raw, list) else [raw] if isinstance(raw, Mapping) else []
    return [
        value
        for index, value in enumerate(values)
        if index < len(quotes) and cited_excerpt(context, quotes[index], min_chars=MIN_QUOTE_CHARS)
    ]


def has_cited_quote(context: str, evidence: Mapping[str, Any] | None, field: str) -> bool:
    return grounded_field_quote(context, evidence, field) is not None

