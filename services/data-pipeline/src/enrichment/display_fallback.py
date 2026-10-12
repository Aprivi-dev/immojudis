"""Deterministic public text used when the AI synthesis is missing or refused.

The template only states facts held in structured fields (or an annex noun
found in the source description). It never pastes source prose, never names a
lawyer or a contact detail, and never says that something is missing.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from src.enrichment.display_evidence import PUBLIC_EMAIL, PUBLIC_LINK, PUBLIC_PHONE, verify_display_claims
from src.extraction_profiles import build_procedure_profile
from src.models import AuctionSale
from src.normalize import clean_text

if TYPE_CHECKING:
    from src.enrichment.extract_structured import LLMExtraction

PARIS = ZoneInfo("Europe/Paris")

PROPERTY_TYPE_DISPLAY_LABELS = {
    "apartment": "Appartement",
    "house": "Maison",
    "building": "Immeuble",
    "land": "Terrain",
    "commercial": "Local commercial",
    "parking": "Stationnement",
    "mixed": "Bien mixte",
    "other": "Bien immobilier",
    "unknown": "Bien immobilier",
}
# Subject used for the occupancy sentence, with its grammatical gender.
_PROPERTY_SUBJECTS = {
    "apartment": ("L'appartement", False),
    "house": ("La maison", True),
    "building": ("L'immeuble", False),
    "land": ("Le terrain", False),
    "commercial": ("Le local", False),
    "parking": ("Le stationnement", False),
}
_DEFAULT_SUBJECT = ("Le bien", False)
# (masculine, feminine)
OCCUPANCY_DISPLAY_LABELS = {
    "vacant": ("libre", "libre"),
    "occupied": ("occupé", "occupée"),
    "rented": ("loué", "louée"),
    "owner_occupied": ("occupé par son propriétaire", "occupée par son propriétaire"),
    "squatted": ("squatté", "squattée"),
}

# Sentences that state an absence ("surface non précisée", "aucune information").
# Written so that Python ``re`` and PostgreSQL ``~*`` read it the same way, for
# the health report.
ABSENCE_SENTENCE_PATTERN = (
    r"(?:non|pas)\s+(?:pr[ée]cis[ée]e?s?|indiqu[ée]e?s?|renseign[ée]e?s?|communiqu[ée]e?s?|"
    r"mentionn[ée]e?s?|sp[ée]cifi[ée]e?s?|connue?s?|fournie?s?|disponibles?)"
    r"|aucune?s?\s+(?:information|donn[ée]e|pr[ée]cision|[ée]l[ée]ment|mention|indication)"
    r"|ne\s+(?:pr[ée]cise|mentionne|indique|sp[ée]cifie)(?:nt)?\s+pas"
    r"|rest(?:e|ent)\s+[àa]\s+(?:v[ée]rifier|confirmer|pr[ée]ciser)"
)
ABSENCE_SENTENCE_RE = re.compile(ABSENCE_SENTENCE_PATTERN, re.I)

_FIXED_PRICE_RE = re.compile(r"\bvente\s+au\s+prix\b|\bpas\s+d['’]\s*ench[eè]res?\b", re.I)
_NOTARIAL_ONLINE_RE = re.compile(
    r"\bimmo[-\s]?interactif\b|\bvente\s+interactive\b|\bench[eè]res?\s+en\s+ligne\b", re.I
)
_AUCTION_WORD_RE = re.compile(r"\bench[eè]res?\b|\badjudication\b|\bimmo[-\s]?interactif\b", re.I)
# Keywords are case-insensitive; the name itself must start with a capital letter.
_LAWYER_NAME_RE = re.compile(
    r"(?:\b(?i:ma[îi]tres?)|\bMes?)\s+[A-ZÀ-Ý][\w'’\-]*(?:\s+(?:de\s+|d['’])?(?!(?i:avocat))[A-ZÀ-Ý][\w'’\-]*){0,3}"
    r"|\b(?i:avocats?\s+(?:inscrits?\s+)?au\s+barreau\s+(?:de\s+|d['’])?)[A-ZÀ-Ý][\w'’\-]*(?:\s+[A-ZÀ-Ý][\w'’\-]*){0,3}"
)
_DANGLING_CONTACT_LABEL_RE = re.compile(
    r"\b(?:t[ée]l(?:[ée]phone)?|fax|portable|mobile|e-?mail|courriel)\b\s*[.:]?\s*(?=[,;.)]|$)", re.I
)
_NEGATED_ANNEX_RE = re.compile(r"(?:\bsans|\bpas\s+de|\baucune?|\bni)\s+(?:\w+\s+){0,2}$", re.I)
# Annex nouns that may be read from the source description: a keyword, never a quotation.
_TEXT_ANNEXES = (
    (re.compile(r"\bcaves?\b", re.I), "cave", "caves"),
    (re.compile(r"\bcelliers?\b", re.I), "cellier", "celliers"),
    (re.compile(r"\bserres?\b", re.I), "serre", "serres"),
    (re.compile(r"\bd[ée]pendances?\b", re.I), "dépendance", "dépendances"),
    (re.compile(r"\bgreniers?\b", re.I), "grenier", "greniers"),
    (re.compile(r"\bbalcons?\b", re.I), "balcon", "balcons"),
    (re.compile(r"\bbox\b", re.I), "box", "box"),
)
# Structured annex keys in ``source_property_features`` (several source shapes).
_FEATURE_ANNEXES = (
    ("cellar", "cave"),
    ("celliers", "cellier"),
    ("outbuildings", "dépendances"),
    ("farm_outbuildings", "dépendances"),
    ("attic", "grenier"),
    ("balcony", "balcon"),
    ("closed_box", "box"),
)
_JUDICIAL_AUCTION_SOURCES = frozenset(
    {
        "licitor",
        "avoventes",
        "vench",
        "info_encheres",
        "petites_affiches",
        "encheres_immobilieres",
    }
)
_NON_JUDICIAL_SOURCES = frozenset({"notaires", "cessions_etat", "agrasc"})


def build_fallback_display_description(
    sale: AuctionSale,
    extraction: LLMExtraction,
    *,
    source_text: str | None = None,
    evidence: str | None = None,
) -> str | None:
    """Return the template paragraph, or ``None`` when nothing can be said.

    With ``evidence``, every fragment is checked by ``verify_display_claims``
    against the same evidence as the final public check, and dropped alone when
    it would be refused. One unsupported figure no longer discards the whole
    template.
    """
    checker = _ClaimChecker(evidence, sale)
    sentences = [
        _fallback_opening(sale, extraction),
        _sale_terms_sentence(sale, checker),
    ]
    details = fallback_asset_details(sale, extraction, source_text=source_text, checker=checker)
    if details:
        sentences.append("Les éléments disponibles mentionnent " + _join_fr(details))
    sentences.append(checker.keep(fallback_occupation(sale, extraction)))
    points = _attention_points(extraction)
    if points:
        sentences.append(checker.keep("Points signalés : " + "; ".join(points)))
    text = " ".join(_ensure_sentence(sentence) for sentence in sentences if sentence)
    return clean_text(scrub_public_text(text))


def fallback_location(sale: AuctionSale) -> str | None:
    city = clean_text(sale.city)
    department = clean_text(sale.department)
    if city and department:
        return f"à {city} ({department})"
    if city:
        return f"à {city}"
    if department:
        return f"dans le département {department}"
    return None


def fallback_asset_details(
    sale: AuctionSale,
    extraction: LLMExtraction,
    *,
    source_text: str | None = None,
    checker: _ClaimChecker | None = None,
) -> list[str]:
    checker = checker or _ClaimChecker(None, sale)
    property_type = extraction.property_type or sale.property_type
    details: list[str] = []
    surface = _fallback_surface(sale, extraction)
    if surface:
        details.append(f"une surface de {surface} m²")
    rooms = extraction.rooms_count or sale.rooms_count
    if rooms:
        details.append(f"{rooms} pièce{'s' if rooms > 1 else ''}")
    bedrooms = extraction.bedrooms_count or sale.bedrooms_count
    if bedrooms:
        details.append(f"{bedrooms} chambre{'s' if bedrooms > 1 else ''}")
    land = _format_surface_value(sale.land_surface_m2) if property_type != "land" else None
    if land and land != surface:
        details.append(f"un terrain de {land} m²")
    amenities = fallback_amenities(sale, source_text=source_text)
    if amenities:
        details.append(
            ("une annexe ou un équipement : " if len(amenities) == 1 else "des annexes ou équipements : ")
            + ", ".join(amenities)
        )
    return [detail for detail in details if checker.keep(detail)]


def fallback_amenities(sale: AuctionSale, *, source_text: str | None = None) -> list[str]:
    amenities: list[str] = []
    if sale.has_garden:
        amenities.append("jardin")
    if sale.has_terrace:
        amenities.append("terrasse")
    if sale.has_garage:
        amenities.append("garage")
    if sale.has_pool:
        amenities.append("piscine")
    for label in (*_feature_annexes(sale), *_text_annexes(source_text)):
        singular = label.removesuffix("s") if label != "box" else label
        if not any(item.removesuffix("s") == singular for item in amenities):
            amenities.append(label)
    # A garage already is the parking space: "garage, 1 stationnement" says it twice.
    parking = sale.parking_count or 0
    if parking > 1 or (parking == 1 and not sale.has_garage):
        amenities.append(f"{parking} stationnement{'s' if parking > 1 else ''}")
    return amenities


def fallback_occupation(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    status = extraction.occupancy_status or sale.occupancy_status
    labels = OCCUPANCY_DISPLAY_LABELS.get(status or "")
    if not labels:
        return None
    property_type = extraction.property_type or sale.property_type or ""
    subject, feminine = _PROPERTY_SUBJECTS.get(property_type, _DEFAULT_SUBJECT)
    agreed = "e" if feminine else ""
    sentence = f"{subject} est indiqué{agreed} comme {labels[1 if feminine else 0]}"
    details = _model_detail(extraction.occupancy_details)
    if details:
        sentence += f" ({details})"
    return sentence


def scrub_public_text(text: str | None) -> str:
    """Remove links, contact details and lawyer names from template text."""
    value = text or ""
    for pattern in (PUBLIC_LINK, PUBLIC_EMAIL, PUBLIC_PHONE, _LAWYER_NAME_RE):
        value = pattern.sub(" ", value)
    value = _DANGLING_CONTACT_LABEL_RE.sub(" ", value)
    value = re.sub(r"\(\s*[,;:]?\s*\)", " ", value)
    # French typography keeps the space before ":" and ";".
    value = re.sub(r"\s+([,.)])", r"\1", value)
    value = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", value)
    value = re.sub(r"([.!?])(?:\s*[,;:])+", r"\1", value)
    value = re.sub(r"\s*[,;:]\s*([.!?])", r"\1", value)
    return clean_text(value) or ""


class _ClaimChecker:
    """Keep a fragment only if the final public check would accept it."""

    def __init__(self, evidence: str | None, sale: AuctionSale) -> None:
        self._evidence = evidence
        self._fields = sale.model_dump() if evidence is not None else {}

    def keep(self, fragment: str | None) -> str | None:
        if not fragment or ABSENCE_SENTENCE_RE.search(fragment):
            return None
        if self._evidence is None:
            return fragment
        return None if verify_display_claims(fragment, self._evidence, self._fields)["issues"] else fragment


def _fallback_opening(sale: AuctionSale, extraction: LLMExtraction) -> str:
    property_type = extraction.property_type or sale.property_type or "unknown"
    label = PROPERTY_TYPE_DISPLAY_LABELS.get(property_type, "Bien immobilier")
    location = fallback_location(sale)
    if location:
        return f"{label} {location}"
    title = scrub_public_text(clean_text(sale.title))
    return title or label


def _sale_terms_sentence(sale: AuctionSale, checker: _ClaimChecker) -> str | None:
    """Nature of the sale, its date (jj/mm/aaaa) and its price, in the right words."""
    nature, price_label = _sale_vocabulary(sale)
    date_part = checker.keep(_date_fragment(sale))
    if date_part is None and sale.sale_date is not None:
        date_part = checker.keep(_single_date_fragment(sale.sale_date))
    price = _format_money(sale.starting_price_eur)
    price_part = checker.keep(f"{price_label} {price}") if price else None
    head = " ".join(filter(None, (nature or ("Vente" if date_part else None), date_part)))
    if head and price_part:
        return f"{head}, {price_part}"
    if head:
        return head
    if price_part:
        return price_part[0].upper() + price_part[1:]
    return None


def _sale_vocabulary(sale: AuctionSale) -> tuple[str | None, str]:
    """Return (nature, price label). "Judiciaire" never names a notarial, State or AGRASC sale."""
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    corpus = " ".join(
        str(value) for value in (sale.title, sale.description, sale.raw_text, payload.get("description")) if value
    )
    source = sale.source_name
    procedure = sale.sale_procedure if isinstance(sale.sale_procedure, dict) else {}
    if _FIXED_PRICE_RE.search(corpus):
        return "Vente au prix", "prix de"
    if source == "agrasc":
        return "Vente organisée par l'AGRASC", ("mise à prix de" if _AUCTION_WORD_RE.search(corpus) else "prix de")
    family = _procedure_family(sale, payload)
    if source == "cessions_etat" or family == "state":
        method = procedure.get("state_sale_method")
        if method == "adjudication":
            return "Cession de l'État par adjudication", "mise à prix de"
        if method == "appel_offres":
            return "Cession de l'État sur appel d'offres", "prix de"
        if method == "cession_amiable":
            return "Cession amiable de l'État", "prix de"
        return "Cession immobilière de l'État", "prix de"
    if source == "notaires" or family == "notarial":
        if procedure.get("participation_mode") == "online" or _NOTARIAL_ONLINE_RE.search(corpus):
            return "Vente notariale interactive", "première offre à partir de"
        return "Vente aux enchères notariale", "mise à prix de"
    if family == "judicial" and source not in _NON_JUDICIAL_SOURCES:
        return "Vente aux enchères judiciaire", "mise à prix de"
    if source in _JUDICIAL_AUCTION_SOURCES:
        return "Vente aux enchères", "mise à prix de"
    return None, "prix annoncé de"


def _procedure_family(sale: AuctionSale, payload: Mapping[str, Any]) -> str:
    profile = payload.get("source_procedure_profile")
    if isinstance(profile, Mapping) and profile.get("family"):
        return str(profile["family"])
    try:
        return str(build_procedure_profile(sale.model_dump()).get("family") or "unknown")
    except Exception:  # noqa: BLE001 - vocabulary falls back to the neutral wording
        return "unknown"


def _date_fragment(sale: AuctionSale) -> str | None:
    if sale.sale_date is None:
        return None
    schedule = sale.raw_payload.get("source_sale_schedule") if isinstance(sale.raw_payload, dict) else None
    if isinstance(schedule, dict):
        try:
            opens = _paris_date(datetime.fromisoformat(str(schedule["opens_at"])))
            closes = _paris_date(datetime.fromisoformat(str(schedule["closes_at"])))
        except (KeyError, TypeError, ValueError):
            opens = closes = None
        if opens and closes and opens < closes and closes == _paris_date(sale.sale_date):
            return f"du {opens.strftime('%d/%m/%Y')} au {closes.strftime('%d/%m/%Y')}"
    return _single_date_fragment(sale.sale_date)


def _single_date_fragment(value: datetime) -> str:
    return "le " + _paris_date(value).strftime("%d/%m/%Y")


def _paris_date(value: datetime):
    aware = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return aware.astimezone(PARIS).date()


def _format_money(value: Any) -> str | None:
    if value is None:
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return None
    if not amount.is_finite() or amount <= 0:
        return None
    euros = int(amount)
    text = f"{euros:,}".replace(",", " ")
    cents = (amount - euros).quantize(Decimal("0.01"))
    if cents:
        text += "," + f"{cents:.2f}"[2:]
    return f"{text} €"


def _fallback_surface(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    value = (
        extraction.surface_m2
        or sale.app_surface_m2
        or sale.habitable_surface_m2
        or sale.carrez_surface_m2
        or sale.surface_m2
    )
    if value is None and (extraction.property_type or sale.property_type) == "land":
        value = sale.land_surface_m2
    return _format_surface_value(value)


def _format_surface_value(value: Any) -> str | None:
    if value is None:
        return None
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return None
    normalized = number.quantize(Decimal("0.01")).normalize()
    return format(normalized, "f").replace(".", ",")


def _feature_annexes(sale: AuctionSale) -> list[str]:
    features = sale.raw_payload.get("source_property_features") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(features, Mapping):
        return []
    containers = [features]
    containers.extend(nested for key in ("annexes", "amenities") if isinstance(nested := features.get(key), Mapping))
    labels: list[str] = []
    for key, label in _FEATURE_ANNEXES:
        if any(_feature_present(container.get(key)) for container in containers) and label not in labels:
            labels.append(label)
    return labels


def _feature_present(value: Any) -> bool:
    if isinstance(value, Mapping):
        if value.get("state") not in (None, "present"):
            return False
        value = value.get("value", True)
    if isinstance(value, str):
        return value.strip().casefold() not in {"", "non", "no", "false", "0", "aucun", "aucune"}
    return bool(value)


def _text_annexes(source_text: str | None) -> list[str]:
    if not source_text:
        return []
    labels: list[str] = []
    for pattern, singular, plural in _TEXT_ANNEXES:
        for match in pattern.finditer(source_text):
            if _NEGATED_ANNEX_RE.search(source_text[max(0, match.start() - 30) : match.start()]):
                continue
            labels.append(plural if match.group().lower().endswith(("s", "x")) and plural != "box" else singular)
            break
    return labels


def _attention_points(extraction: LLMExtraction) -> list[str]:
    points: list[str] = []
    works = _model_detail(extraction.works_needed)
    if works:
        points.append(f"travaux ou état signalé ({works})")
    if extraction.legal_risks:
        points.append("risques juridiques mentionnés")
    if extraction.physical_risks:
        points.append("risques techniques mentionnés")
    if extraction.servitudes:
        points.append("servitudes mentionnées")
    return points


def _model_detail(value: str | None) -> str | None:
    """A free-text qualifier from the fact extraction, dropped whole rather than mangled."""
    text = clean_text(value)
    if not text or ABSENCE_SENTENCE_RE.search(text):
        return None
    if any(pattern.search(text) for pattern in (PUBLIC_LINK, PUBLIC_EMAIL, PUBLIC_PHONE, _LAWYER_NAME_RE)):
        return None
    return text.rstrip(". ")


def _join_fr(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " et " + items[-1]


def _ensure_sentence(value: str) -> str:
    text = clean_text(value) or ""
    if not text:
        return text
    return text if re.search(r"[.!?]$", text) else f"{text}."
