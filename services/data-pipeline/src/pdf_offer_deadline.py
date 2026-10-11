"""Offer deadline ("date limite de remise des offres") read from attachments.

Calls for offers (Cessions de l'État, AGRASC, notarial tenders) often publish
the deadline only in the conditions of sale or the tender rules. The generic
sale-date extractor looks for hearing/auction wording and ignores it. This
module returns one dated candidate with its document/page evidence; the caller
decides whether it may feed ``sale_date``.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

from src.normalize import clean_text, parse_french_datetime
from src.pdf_document_types import _canonical_document_type

_E = "[eéèêEÉÈÊ]"
OFFER_DEADLINE_PATTERNS = (
    re.compile(
        rf"date\s+limite\s+(?:de\s+|d['’]\s*)?(?:la\s+)?(?:remise|d{_E}p[oô]t|r{_E}ception|envoi|pr{_E}sentation)"
        rf"\s+des\s+(?:offres|plis|candidatures|propositions)[^.;\n]{{0,140}}",
        re.I,
    ),
    re.compile(r"date\s+limite\s+des\s+(?:offres|plis|candidatures|propositions)[^.;\n]{0,140}", re.I),
    re.compile(
        rf"\b(?:les\s+)?(?:offres|plis|propositions)(?:\s+d['’]\s*achat)?\s+(?:devront|doivent)\s+(?:{_E}tre\s+)?"
        rf"(?:remises?|d{_E}pos{_E}{_E}?s?|parvenir|re[çc]u{_E}?s?|adress{_E}{_E}?s?|transmises?|envoy{_E}{_E}?s?)"
        r"[^.;\n]{0,160}",
        re.I,
    ),
)
_DATE_SIGNAL = re.compile(
    r"\b\d{1,2}(?:er)?\s+(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)"
    r"\s+\d{4}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\b",
    re.I,
)
_NUMERIC_DATE = re.compile(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b(?:\D{0,6}(\d{1,2})\s*[h:]\s*(\d{2})?)?")
DOCUMENT_RANK = {
    "cahier_conditions_vente": 90,
    "conditions_vente": 85,
    "annonce_vente": 80,
    "pv_notaire": 50,
    "pdf": 40,
}
OFFER_PROCEDURE_SOURCES = frozenset({"cessions_etat", "agrasc", "notaires"})


def _parse_deadline(phrase: str, *, local_timezone: str) -> datetime | None:
    text = re.sub(r"\b(\d{1,2})er\b", r"\1", phrase)
    parsed = parse_french_datetime(text, local_timezone=local_timezone)
    if parsed is not None:
        return parsed
    match = _NUMERIC_DATE.search(text)
    if not match:
        return None
    day, month, year, hour, minute = match.groups()
    iso = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    if hour is not None:
        iso += f" {int(hour):02d}:{int(minute or 0):02d}"
    try:
        datetime.fromisoformat(iso)
    except ValueError:
        return None
    return parse_french_datetime(iso, local_timezone=local_timezone)


def offer_deadline_candidates(text: str, *, local_timezone: str = "Europe/Paris") -> list[dict[str, object]]:
    value = clean_text(text) or ""
    candidates: list[dict[str, object]] = []
    seen: set[str] = set()
    for pattern in OFFER_DEADLINE_PATTERNS:
        for match in pattern.finditer(value):
            phrase = clean_text(match.group(0)) or ""
            if not phrase or phrase in seen or not _DATE_SIGNAL.search(phrase):
                continue
            seen.add(phrase)
            parsed = _parse_deadline(phrase, local_timezone=local_timezone)
            if parsed is None:
                continue
            candidates.append({"value": parsed, "offer_deadline": parsed.isoformat(), "evidence": phrase[:300]})
    return candidates


def extract_offer_deadline_from_documents(
    pdf_texts: list[dict[str, object]] | list[str],
    *,
    local_timezone: str = "Europe/Paris",
) -> dict[str, object] | None:
    """Best-ranked offer deadline; ``ambiguous`` when top documents disagree."""

    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        url = clean_text(item.get("url")) or ""
        document_type = _canonical_document_type(item.get("document_type") or item.get("type"), label=label, url=url)
        pages = item.get("pages") if isinstance(item.get("pages"), list) else None
        units = (
            [(page.get("page"), str(page.get("text") or "")) for page in pages if isinstance(page, dict)]
            if pages
            else [(None, str(item.get("text") or ""))]
        )
        for page_number, text in units:
            for candidate in offer_deadline_candidates(text, local_timezone=local_timezone):
                candidate.update(
                    {
                        "document_label": label,
                        "document_url": url,
                        "document_type": document_type,
                        "page_number": page_number,
                        "rank": DOCUMENT_RANK.get(document_type, 30),
                    }
                )
                candidates.append(candidate)
    if not candidates:
        return None
    best_rank = max(int(candidate["rank"]) for candidate in candidates)
    top = [candidate for candidate in candidates if int(candidate["rank"]) == best_rank]
    dates = {candidate["offer_deadline"] for candidate in top}
    selected = dict(top[0])
    selected["candidates"] = len(candidates)
    selected["ambiguous"] = len(dates) > 1
    return selected


def record_offer_deadline(
    sale: object,
    pdf_texts: list[dict[str, object]] | list[str],
    *,
    complete_texts: bool,
    local_timezone: str = "Europe/Paris",
) -> dict[str, object] | None:
    """Keep the deadline evidence on the sale; a complete re-read clears it."""

    raw_payload = getattr(sale, "raw_payload", None)
    extraction = extract_offer_deadline_from_documents(pdf_texts, local_timezone=local_timezone)
    if isinstance(raw_payload, dict):
        if extraction:
            raw_payload["pdf_offer_deadline_extraction"] = {
                key: value for key, value in extraction.items() if key != "value"
            }
        elif complete_texts:
            raw_payload.pop("pdf_offer_deadline_extraction", None)
    return extraction


def offer_deadline_sale_date(extraction: dict[str, object]) -> dict[str, object]:
    """Candidate for ``_assign_pdf_sale_date``; its value is None when not allowed."""

    allowed = offer_deadline_may_feed_sale_date(extraction)
    candidate = {key: value for key, value in extraction.items() if key not in {"value", "candidates", "ambiguous"}}
    candidate.update(
        {
            "value": extraction.get("value") if allowed else None,
            "sale_date": extraction.get("offer_deadline"),
            "sale_date_kind": "offer_deadline",
        }
    )
    return candidate


def offer_deadline_may_feed_sale_date(extraction: dict[str, object], *, now: datetime | None = None) -> bool:
    """Only an unambiguous, not yet expired deadline may become ``sale_date``."""

    value = extraction.get("value")
    if not isinstance(value, datetime) or extraction.get("ambiguous"):
        return False
    current = now or datetime.now(UTC)
    return current - timedelta(days=1) <= value <= current + timedelta(days=730)
