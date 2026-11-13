"""Offer deadline ("date limite de remise des offres") read from attachments and the source page.

Calls for offers (Cessions de l'État, AGRASC, notarial tenders) often publish
the deadline only in the conditions of sale or the tender rules. The generic
sale-date extractor looks for hearing/auction wording and ignores it. This
module returns one dated candidate with its document/page evidence; the caller
decides whether it may feed ``sale_date``.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from src.admission import sale_date_has_passed
from src.french_dates import MONTH_NUMBERS, MONTH_PATTERN
from src.normalize import clean_text, parse_french_datetime, source_sale_timezone
from src.pdf_document_types import canonical_document_type
from src.pdf_sale_date_guard import assign_pdf_sale_date
from src.text_folding import strip_accents

_E = "[eéèêEÉÈÊ]"
# A full stop ends the phrase, except after a roman numeral (a section reference): « Date limite de
# réception des offres et de transmission des documents visés au II. ci-dessus 13 novembre 2026 » (02/11/2026,
# Hôtel de Nevers) stopped at « II. » before its date.
_PHRASE = r"(?:\b[IVX]{1,4}\.|[^.;\n]){0,140}"
_SUBJECT = (
    r"(?:des\s+(?:offres|plis|candidatures|propositions)"
    r"|du\s+dossier\s+(?:d['’]\s*offres?|de\s+candidature)|de\s+l['’]\s*offre"
    r"|des\s+dossiers(?:\s+d['’]\s*offres?|\s+de\s+candidature)?"
    # A table cell: « Date limite de réception du dossier 10/12/2026 à 16h00 d'offre » (Bougival).
    r"|du\s+dossier(?=\s*:?\s*\d))"
)
_WEEKDAY = r"(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?"
_DATE_TEXT = rf"(?:\d{{1,2}}(?:\s*er)?\s+(?:{MONTH_PATTERN})\s+\d{{4}}|\d{{1,2}}[/.-]\d{{1,2}}[/.-]\d{{4}})"
_WHEN = rf"(?P<when>{_WEEKDAY}{_DATE_TEXT}[^.;]{{0,40}})"
OFFER_DEADLINE_PATTERNS = (
    re.compile(
        rf"date\s+limite\s+(?:de\s+|d['’]\s*)?(?:la\s+)?(?:remise|d{_E}p[oô]t|r{_E}ception|envoi|pr{_E}sentation)"
        rf"\s+{_SUBJECT}{_PHRASE}",
        re.I,
    ),
    re.compile(rf"date\s+limite\s+{_SUBJECT}{_PHRASE}", re.I),
    re.compile(
        rf"\b(?:les\s+)?(?:offres|plis|propositions)(?:\s+d['’]\s*achat)?\s+(?:devront|doivent)\s+(?:{_E}tre\s+)?"
        rf"(?:remises?|d{_E}pos{_E}{_E}?s?|parvenir|re[çc]u{_E}?s?|adress{_E}{_E}?s?|transmises?|envoy{_E}{_E}?s?)"
        r"[^.;\n]{0,160}",
        re.I,
    ),
    # « Ces plis sont, soit transmis par voie postale […], soit remis directement contre récépissé au plus tard
    # le mardi 8 décembre 2026 à 12h » ; « Ce pli devra être impérativement reçu : - au plus tard le jeudi
    # 22 février 2024 à 16H00 ». Only after an offer subject, and the lead is checked (_FOREIGN_LEAD).
    re.compile(
        rf"\b(?:plis?|offres?|candidatures?|soumissions?)\b(?P<lead>[^.;]{{0,220}}?)\bau\s+plus\s+tard\s+(?:le\s+)?{_WHEN}",
        re.I,
    ),
    # « au plus tard le 25 novembre 2026 à 12h (jour et heure limite tant du récépissé que de l'accusé… » ;
    # « – soit remise directement en mains propres contre récépissé, au plus tard le 10 décembre 2026 à 15 h, sous
    # peine d’irrecevabilité ».
    re.compile(
        rf"\bau\s+plus\s+tard\s+(?:le\s+)?(?P<when>{_WEEKDAY}{_DATE_TEXT}[^.;()]{{0,30}}?)"
        r"(?:\(\s*jour\s+et\s+heure\s+limite|,?\s*sous\s+peine\s+d['’]\s*irrecevabilit)",
        re.I,
    ),
    # Interactive notarial sale: « La vente IMMO-INTERACTIF aura lieu : Du 5 novembre 2026 à 13h30 Au
    # 6 novembre 2026 à 13h30 » — offers close at the end of the window.
    re.compile(
        rf"\bvente\b[^.;]{{0,60}}?\baura\s+lieu\s*:?\s*du\s+{_WEEKDAY}{_DATE_TEXT}[^.;]{{0,20}}?\s+au\s+{_WHEN}",
        re.I,
    ),
    # Online sale window on the page: « Date de fin de vente : Le 28/05/2026 à 16:00 ».
    re.compile(
        rf"\bdate\s+de\s+(?:fin|cl[oô]ture)\s+(?:de\s+(?:la\s+)?vente|des\s+ench[eè]res|des\s+offres)\s*:?\s*"
        rf"(?:le\s+)?{_WHEN}",
        re.I,
    ),
)
# « au plus tard le … » after an offer subject is still not the deadline when the sentence is about the deed,
# the visits, the questions, the payment or the guarantee: « l'offre retenue, l'acte sera signé au plus tard le… ».
_FOREIGN_LEAD = re.compile(
    r"\b(?:actes?|signature|sign[eé]e?s?|signera|compromis|promesse|questions?|r[eé]ponses?|visites?|visiter"
    r"|paiement|versement|garantie|caution|consignation|pr[eê]t|substitution|agr[eé]ment"
    # The calendar row after the deadline: « … du dossier 10/12/2026 à 16h00 d'offre Date de sélection du
    # lauréat Au plus tard le 07/01/2027 » (Bougival).
    r"|s[eé]lection|laur[eé]at|d[eé]signation|choix|notification|validit[eé]|ouverture)\b",
    re.I,
)
_DATE_RE = re.compile(
    rf"\b(?P<day>\d{{1,2}})(?:\s*er)?\s+(?P<month>{MONTH_PATTERN})\s+(?P<year>\d{{4}})\b"
    r"|\b(?P<nday>\d{1,2})[/.-](?P<nmonth>\d{1,2})[/.-](?P<nyear>\d{4})\b",
    re.I,
)
# « à 12h », « À 14 HEURES », « 16H00 », « à 16:00 », « à midi ».
_TIME_RE = re.compile(
    r"\s*,?\s*(?:(?:à|a)\s*)?(?:(?P<midi>midi)\b|(?P<hour>[01]?\d|2[0-3])\s*(?:h|heures?|:)\s*(?P<minute>[0-5]\d)?(?![\d/]))",
    re.I,
)
DOCUMENT_RANK = {
    "cahier_conditions_vente": 90,
    "conditions_vente": 85,
    "annonce_vente": 80,
    # The source page: below the conditions of sale, which carry the binding calendar.
    "source_page": 70,
    "pv_notaire": 50,
    "pdf": 40,
}
_FOREIGN_DOCUMENT_TYPES = frozenset({"diagnostics_techniques", "bail", "cadastre"})
OFFER_PROCEDURE_SOURCES = frozenset({"cessions_etat", "agrasc", "notaires"})
_PDF_ENRICHMENT_MARKER = "--- PDF TEXT ENRICHMENT ---"


def _first_deadline(text: str, *, local_timezone: str) -> tuple[datetime, bool] | None:
    """First dated deadline of ``text`` with the time that follows it; ``(value, date_only)``."""

    match = _DATE_RE.search(text)
    if not match:
        return None
    if match.group("day"):
        day, year = int(match.group("day")), int(match.group("year"))
        month = MONTH_NUMBERS.get(strip_accents(match.group("month")).lower(), 0)
    else:
        day, month, year = int(match.group("nday")), int(match.group("nmonth")), int(match.group("nyear"))
    try:
        datetime(year, month, day)
    except ValueError:
        return None
    iso = f"{year:04d}-{month:02d}-{day:02d}"
    clock = _TIME_RE.match(text, match.end())
    if clock and (clock.group("midi") or clock.group("hour")):
        hour, minute = (12, 0) if clock.group("midi") else (int(clock.group("hour")), int(clock.group("minute") or 0))
        iso += f" {hour:02d}:{minute:02d}"
    parsed = parse_french_datetime(iso, local_timezone=local_timezone)
    return (parsed, " " not in iso) if parsed is not None else None


def offer_deadline_candidates(text: str, *, local_timezone: str = "Europe/Paris") -> list[dict[str, object]]:
    value = clean_text(text) or ""
    candidates: list[dict[str, object]] = []
    seen: set[str] = set()
    for pattern in OFFER_DEADLINE_PATTERNS:
        for match in pattern.finditer(value):
            phrase = clean_text(match.group(0)) or ""
            if not phrase or phrase in seen:
                continue
            groups = pattern.groupindex
            if "lead" in groups and _FOREIGN_LEAD.search(match.group("lead") or ""):
                continue
            seen.add(phrase)
            dated = _first_deadline(match.group("when") if "when" in groups else match.group(0), local_timezone=local_timezone)
            if dated is None:
                continue
            parsed, date_only = dated
            candidates.append(
                {"value": parsed, "offer_deadline": parsed.isoformat(), "date_only": date_only, "evidence": phrase[:300]}
            )
    return candidates


def source_page_document(sale: object) -> dict[str, object] | None:
    """The source page text (without the appended PDF text) of a call for offers, as a pseudo-document.

    AGRASC: « Date limite de réception des offres fermes : vendredi 20 novembre 2026 à 12 heures » is only on
    the page; Cessions de l'État: « Date de fin de vente : Le 28/05/2026 à 16:00 ».
    """
    if getattr(sale, "source_name", None) not in OFFER_PROCEDURE_SOURCES:
        return None
    text = clean_text(str(getattr(sale, "raw_text", None) or "").split(_PDF_ENRICHMENT_MARKER, 1)[0])
    if not text:
        return None
    return {"label": "Page source", "url": getattr(sale, "source_url", "") or "", "text": text, "document_type": "source_page"}


def extract_offer_deadline_from_documents(
    pdf_texts: list[dict[str, object]] | list[str],
    *,
    local_timezone: str = "Europe/Paris",
) -> dict[str, object] | None:
    """Best-ranked offer deadline; ``ambiguous`` when top documents give different days."""

    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        url = clean_text(item.get("url")) or ""
        raw_type = item.get("document_type") or item.get("type")
        document_type = (
            "source_page" if raw_type == "source_page" else canonical_document_type(raw_type, label=label, url=url)
        )
        if document_type in _FOREIGN_DOCUMENT_TYPES:
            continue
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
    # « Date limite de réception des offres Mercredi 25 février 2026 » and « … LE MERCREDI 25 FÉVRIER 2026 À
    # 14 HEURES » in the same rules are one deadline: compare civil days, keep the latest stated time.
    zone = ZoneInfo(local_timezone)
    days = {candidate["value"].astimezone(zone).date() for candidate in top}
    timed = [candidate for candidate in top if not candidate["date_only"]]
    selected = dict(max(timed, key=lambda candidate: candidate["value"]) if timed else top[0])
    selected["candidates"] = len(candidates)
    selected["ambiguous"] = len(days) > 1
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
    page = source_page_document(sale)
    documents = [*pdf_texts, page] if page else pdf_texts
    extraction = extract_offer_deadline_from_documents(documents, local_timezone=local_timezone)
    if isinstance(raw_payload, dict):
        if extraction:
            raw_payload["pdf_offer_deadline_extraction"] = {
                key: value for key, value in extraction.items() if key != "value"
            }
        elif complete_texts:
            raw_payload.pop("pdf_offer_deadline_extraction", None)
    return extraction


def apply_page_offer_deadline(sale: object) -> None:
    """Date a call for offers without attachments text from its page, when the deadline is still ahead."""

    if getattr(sale, "sale_date", None) is not None:
        return
    page = source_page_document(sale)
    if page is None:
        return
    raw_payload = getattr(sale, "raw_payload", None)
    timezone = source_sale_timezone(raw_payload if isinstance(raw_payload, dict) else {})
    extraction = extract_offer_deadline_from_documents([page], local_timezone=timezone)
    if extraction:
        assign_pdf_sale_date(sale, offer_deadline_sale_date(extraction))


def offer_deadline_sale_date(
    extraction: dict[str, object], *, allow_expired: bool = False, now: datetime | None = None
) -> dict[str, object]:
    """Candidate for ``assign_pdf_sale_date``; its value is None when not allowed.

    ``allow_expired`` (a call for offers, whose deadline is the sale's échéance): a deadline read without
    ambiguity that has passed closes the sale (``offer_deadline_expired``) instead of leaving it undated
    and « à venir ».
    """

    allowed = offer_deadline_may_feed_sale_date(extraction, now=now)
    expired = allow_expired and offer_deadline_has_expired(extraction, now=now)
    candidate = {key: value for key, value in extraction.items() if key not in {"value", "candidates", "ambiguous"}}
    candidate.update(
        {
            "value": extraction.get("value") if allowed or expired else None,
            "sale_date": extraction.get("offer_deadline"),
            "sale_date_kind": "offer_deadline",
        }
    )
    if expired:
        candidate["offer_deadline_expired"] = True
    return candidate


def offer_deadline_may_feed_sale_date(extraction: dict[str, object], *, now: datetime | None = None) -> bool:
    """Only an unambiguous, not yet expired deadline may become ``sale_date``."""

    value = extraction.get("value")
    if not isinstance(value, datetime) or extraction.get("ambiguous"):
        return False
    current = now or datetime.now(UTC)
    return current - timedelta(days=1) <= value <= current + timedelta(days=730)


def offer_deadline_has_expired(extraction: dict[str, object], *, now: datetime | None = None) -> bool:
    """An unambiguous deadline that has passed (a date-only one once its Paris day is over)."""

    value = extraction.get("value")
    if not isinstance(value, datetime) or extraction.get("ambiguous"):
        return False
    return sale_date_has_passed(value, date_only=bool(extraction.get("date_only")), now=now)
