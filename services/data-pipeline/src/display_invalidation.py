"""Decide when a source capture really invalidates the analysis of a sale.

The rules were written for the AI display synthesis (removed since); they now
decide which source changes discard the document facts.

Production showed the synthesis being erased in a loop: a collection run reads
the list card merged with the detail page, while the recurring ``source_detail``
job reads the detail page alone. The two captures fill ``description``,
``raw_text``, ``title``, ``address``, coordinates or the lawyer contact
differently, so one fingerprint over every field flipped on each pass. List
cards also carry a daily countdown (« J - 4 », then « J - 3 »).

The rules below:

* fingerprint only the facts that change the text (normalised text, documents,
  surfaces, rooms, occupancy, property type, city, procedure);
* compare a capture only with the previous capture of the same kind;
* tell an operational change (price, date, status), which keeps the facts,
  from a documentary one, which discards them.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

from src.normalize import (
    SURFACE_VALUE_PATTERN,
    _extract_occupancy_status_from_text,
    clean_text,
    normalize_occupancy_status,
    normalize_sale_property_type,
)
from src.text_folding import strip_accents

# Outcomes of ``classify_source_change``.
OPERATIONAL_CHANGE = "operational"
CONTENT_CHANGE_KEEP_DISPLAY = "content_keep_display"
CONTENT_CHANGE_ERASE_DISPLAY = "content_erase_display"

SURFACE_FIELDS = (
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
    "app_surface_m2",
)
COUNT_FIELDS = ("rooms_count", "bedrooms_count")
PROCEDURE_FIELDS = ("sale_type", "sale_venue_type")

# A list card counts down the days before the sale (« J - 24 »). Cessions (État) pages also write the deadline
# relative to today (« dans 34 jours », « hier ») : compared raw, each day's first pass saw 20 of its pages as changed
# and erased their document reading (06/11/2026, 08:20). Texts are casefolded and stripped of accents first.
_COUNTDOWN_RE = re.compile(
    r"\bj\s*-\s*\d{1,4}\b"
    r"|\b(?:dans|il y a)\s+\d{1,4}\s*(?:jours?|heures?|minutes?|semaines?|mois)\b"
    r"|\b\d{1,4}\s*jours?\s+restants?\b"
    r"|\breste(?:nt)?\s+\d{1,4}\s*jours?\b"
    r"|\b(?:avant-hier|hier|aujourd['’ ]?hui)\b"
)
_TEXT_SURFACE_RE = re.compile(rf"{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)", re.IGNORECASE)


def normalize_display_text(value: object) -> str:
    """Casefold, strip accents and volatile counters, collapse whitespace."""
    text = clean_text(value) or ""
    text = strip_accents(text).casefold()
    text = _COUNTDOWN_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def _number(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip().replace(" ", "").replace(" ", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return round(float(text), 2)
    except ValueError:
        return None


def _text_surfaces(*values: object) -> list[float]:
    found = set()
    for value in values:
        for match in _TEXT_SURFACE_RE.finditer(str(value or "")):
            number = _number(match.group(1))
            if number is not None:
                found.add(number)
    return sorted(found)


def _document_identities(documents: object) -> list[list[str]]:
    if not isinstance(documents, list):
        return []
    return sorted(
        [str(document.get("url") or ""), str(document.get("label") or "")]
        for document in documents
        if isinstance(document, dict)
    )


def _occupancy(sale: Mapping[str, Any]) -> str | None:
    return normalize_occupancy_status(sale.get("occupancy_status")) or _extract_occupancy_status_from_text(
        sale.get("description"), sale.get("raw_text")
    )


def _property_type(sale: Mapping[str, Any]) -> str:
    try:
        return normalize_sale_property_type(dict(sale))
    except Exception:  # a fingerprint must never stop a collection
        return normalize_display_text(sale.get("property_type"))


def _hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def capture_kind(sale: Mapping[str, Any], capture: str = "collection") -> str:
    """Name the capture so that only like is compared with like.

    ``collection`` is a scraper run: a list card, possibly merged with its
    detail page. ``source_detail`` is the recurring job that parses the detail
    page alone.
    """
    origin = "detail_page" if capture == "source_detail" else "listing"
    status = sale.get("source_detail_status")
    if status in {"complete", "restricted"}:
        return f"{origin}+{status}"
    return origin


def capture_fingerprints(
    sale: Mapping[str, Any],
    snapshot: Mapping[str, Any] | None = None,
    operational_fields: frozenset[str] | tuple[str, ...] = (),
) -> dict[str, str]:
    """Fingerprints of the facts that change the synthesis text."""
    merged = {**sale, **(snapshot or {})}
    major = {
        "surfaces": {field: _number(merged.get(field)) for field in SURFACE_FIELDS},
        "occupancy": _occupancy(merged),
        "property_type": _property_type(merged),
        "documents": _document_identities(merged.get("documents")),
    }
    # Surfaces quoted in the prose: a list card often repeats one the detail
    # page omits, so they are compared within a capture kind only.
    major_text = _text_surfaces(merged.get("description"), merged.get("raw_text"))
    display = {
        "major": major,
        "major_text": major_text,
        "description": normalize_display_text(merged.get("description")),
        "raw_text": normalize_display_text(merged.get("raw_text")),
        "counts": {field: _number(merged.get(field)) for field in COUNT_FIELDS},
        "city": normalize_display_text(merged.get("city")),
        "procedure": {field: normalize_display_text(merged.get(field)) for field in PROCEDURE_FIELDS},
    }
    operational = {field: merged.get(field) for field in sorted(operational_fields)}
    return {
        "major": _hash(major),
        "major_text": _hash(major_text),
        "display": _hash(display),
        "operational": _hash(operational),
    }


def classify_source_change(
    old_check: Mapping[str, Any],
    kind: str,
    fingerprints: Mapping[str, str],
    evidence_fingerprint: str,
) -> str | None:
    """Return how the synthesis must react to a new capture, or ``None``."""
    if not old_check:
        # No proof for this URL: nothing tells what changed (former behaviour).
        return CONTENT_CHANGE_ERASE_DISPLAY
    baselines = old_check.get("capture_fingerprints")
    known = [item for item in baselines.values() if isinstance(item, Mapping)] if isinstance(baselines, Mapping) else []
    baseline = baselines.get(kind) if isinstance(baselines, Mapping) else None
    if not isinstance(baseline, Mapping):
        # No capture of this kind yet (a row written before this rule, or the
        # first detail-job pass). Keep the former evidence comparison; erase
        # only when the major facts match no capture recorded for this URL.
        if known and fingerprints.get("major") not in {item.get("major") for item in known}:
            return CONTENT_CHANGE_ERASE_DISPLAY
        if old_check.get("evidence_fingerprint") == evidence_fingerprint:
            return OPERATIONAL_CHANGE
        return CONTENT_CHANGE_KEEP_DISPLAY
    display_changed = baseline.get("display") != fingerprints.get("display")
    operational_changed = baseline.get("operational") != fingerprints.get("operational")
    if any(baseline.get(key) != fingerprints.get(key) for key in ("major", "major_text")):
        return CONTENT_CHANGE_ERASE_DISPLAY
    if display_changed and operational_changed:
        # Prose usually repeats the price and the date: a stale text would show
        # the old ones.
        return CONTENT_CHANGE_ERASE_DISPLAY
    if display_changed:
        return CONTENT_CHANGE_KEEP_DISPLAY
    if operational_changed:
        return OPERATIONAL_CHANGE
    return None


def merge_capture_fingerprints(old_check: Mapping[str, Any], kind: str, fingerprints: dict[str, str]) -> dict:
    previous = old_check.get("capture_fingerprints")
    merged = dict(previous) if isinstance(previous, Mapping) else {}
    merged[kind] = fingerprints
    return merged

