from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import re
import unicodedata

from dateutil import parser

from src.models import AuctionSale


FRENCH_MONTHS = {
    "janvier": "January",
    "février": "February",
    "fevrier": "February",
    "mars": "March",
    "avril": "April",
    "mai": "May",
    "juin": "June",
    "juillet": "July",
    "août": "August",
    "aout": "August",
    "septembre": "September",
    "octobre": "October",
    "novembre": "November",
    "décembre": "December",
    "decembre": "December",
}

FRENCH_WEEKDAYS = (
    "lundi",
    "mardi",
    "mercredi",
    "jeudi",
    "vendredi",
    "samedi",
    "dimanche",
)

PROPERTY_TYPE_MAP = {
    "apartment": "apartment",
    "appartement": "apartment",
    "studio": "apartment",
    "house": "house",
    "maison": "house",
    "building": "building",
    "immeuble": "building",
    "land": "land",
    "terrain": "land",
    "commercial": "commercial",
    "local": "commercial",
    "commerce": "commercial",
    "parking": "parking",
    "mixed": "mixed",
    "autres": "other",
    "autre": "other",
    "other": "other",
    "unknown": "unknown",
}

VALID_STATUSES = {"upcoming", "past", "adjudicated", "unknown"}


def strip_accents(value: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFKD", value) if not unicodedata.combining(char)
    )


def clean_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()
    return text or None


def parse_price(value: object | None) -> Decimal | None:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"([0-9][0-9\s.,]*)", text)
    if not match:
        return None
    number = match.group(1).replace(" ", "")
    if "," in number:
        number = number.replace(".", "").replace(",", ".")
    try:
        return Decimal(number)
    except InvalidOperation:
        return None


def extract_starting_price(raw_sale: dict[str, object]) -> Decimal | None:
    explicit = parse_price(raw_sale.get("starting_price_eur"))
    text = " ".join(
        filter(
            None,
            (
                clean_text(raw_sale.get("raw_text")),
                clean_text(raw_sale.get("description")),
                clean_text(raw_sale.get("title")),
            ),
        )
    )
    text_price = None
    match = re.search(r"mise\s+[àa]\s+prix\s*:?\s*([0-9][0-9\s.,]*)\s*(?:€|euros?)?", text, re.I)
    if match:
        text_price = parse_price(match.group(1))
    if explicit is not None and text_price is not None:
        if explicit == text_price * Decimal("10"):
            return text_price
        if explicit > Decimal("1000000") and text_price < explicit:
            return text_price
    return explicit or text_price


def parse_surface(value: object | None) -> Decimal | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"([0-9][0-9\s.,]*)", text)
    if not match:
        return None
    number = match.group(1).replace(" ", "")
    if "," in number:
        number = number.replace(".", "").replace(",", ".")
    try:
        return Decimal(number)
    except InvalidOperation:
        return None


def parse_decimal(value: object | None) -> Decimal | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return Decimal(text.replace(",", "."))
    except InvalidOperation:
        return None


def parse_confidence(value: object | None) -> Decimal | None:
    confidence = parse_decimal(value)
    if confidence is None:
        return None
    if confidence > 1 and confidence <= 100:
        return confidence / Decimal("100")
    if confidence < 0:
        return Decimal("0")
    if confidence > 1:
        return Decimal("1")
    return confidence


def parse_french_datetime(value: object | None) -> datetime | None:
    text = clean_text(value)
    if not text:
        return None
    lowered = text.lower()
    for weekday in FRENCH_WEEKDAYS:
        lowered = re.sub(rf"\b{weekday}\b", "", lowered)
    lowered = lowered.replace(" à ", " ")
    lowered = re.sub(r"\b([0-2]?\d)h([0-5]\d)?\b", lambda m: f"{m.group(1)}:{m.group(2) or '00'}", lowered)
    lowered = lowered.replace("heures", ":00").replace("heure", ":00")
    for fr, en in FRENCH_MONTHS.items():
        lowered = lowered.replace(fr, en)
    try:
        parsed = parser.parse(lowered, dayfirst=True, fuzzy=True)
    except (ValueError, TypeError, OverflowError):
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def normalize_property_type(value: object | None) -> str:
    text = strip_accents(clean_text(value) or "").lower()
    for needle, normalized in PROPERTY_TYPE_MAP.items():
        if needle in text:
            return normalized
    return "other"


def normalize_occupancy_status(value: object | None) -> str | None:
    """Map free-text occupancy (FR/EN) to the auction_sales enum.

    The DB CHECK constraint only accepts vacant/occupied/rented/owner_occupied/
    squatted/unknown (or NULL). Unrecognised values return None (NULL) rather
    than letting raw text reach the insert and fail the constraint.
    """
    text = strip_accents(clean_text(value) or "").lower()
    if not text:
        return None
    # Order matters: check the most specific labels before the generic "occup".
    if "squat" in text:
        return "squatted"
    if any(token in text for token in ("loue", "louee", "locataire", "bail", "rented", "leased", "tenant")):
        return "rented"
    if "proprietaire" in text or "owner" in text:
        return "owner_occupied"
    if any(token in text for token in ("libre", "vacant", "inoccup", "free", "vide", "disponible")):
        return "vacant"
    if "occup" in text:
        return "occupied"
    if "unknown" in text or "inconnu" in text:
        return "unknown"
    return None


def normalize_status(value: object | None, sale_date: datetime | None = None) -> str:
    text = strip_accents(clean_text(value) or "").lower()
    if "adjuge" in text or "adjudication" in text:
        return "adjudicated"
    if "passee" in text or "passe" in text:
        return "past"
    if "venir" in text or "upcoming" in text:
        return "upcoming"
    if text in VALID_STATUSES:
        return text
    if sale_date:
        return "past" if sale_date < datetime.now(timezone.utc) else "upcoming"
    return "unknown"


def extract_postal_code(*values: object | None) -> str | None:
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        match = re.search(r"\b(\d{5})\b", text)
        if match:
            return match.group(1)
    return None


def extract_department(postal_code: str | None) -> str | None:
    if not postal_code or len(postal_code) < 2:
        return None
    return postal_code[:2]


def extract_city(address: str | None, postal_code: str | None) -> str | None:
    if not address or not postal_code:
        return None
    match = re.search(rf"\b{re.escape(postal_code)}\s+([^,\n]+)", address)
    if not match:
        return None
    return clean_text(match.group(1).replace("France", "").strip(" ,"))


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


def parse_bedrooms_count(value: object) -> int | None:
    return parse_rooms_count(value)


def extract_rooms_count_from_text(*values: object) -> int | None:
    text = clean_text(" ".join(str(value) for value in values if value))
    if not text:
        return None

    if re.search(r"\bstudio\b", text, re.I):
        return 1

    patterns = (
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eè]ces?\s+[1-9][0-9]?\s*chambres?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eè]ces?\s+(?:à\s+propos\s+du\s+bien|a\s+propos\s+du\s+bien)\b",
        r"\b(?:nombre\s+de\s+)?pi[eè]ces?\s*(?:principales?)?\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\bappartement\s+(?:de\s+)?type\s*([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\btype\s+([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\b(?:type\s+)?[TF]\s*([1-9])\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_count_false_positive(text, match.start(), match.end()):
                continue
            return _parse_count_token(match.group(1))

    if re.search(r"\b(?:une|1)\s+pi[eè]ce\s+principale\b", text, re.I):
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
        r"\b[1-9][0-9]?\s*pi[eè]ces?\s+([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b",
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
    before = text[max(0, start - 180) : start]
    after = text[end : min(len(text), end + 160)]
    context = before + after
    return bool(
        re.search(
            r"donnn?[ée]es?\s+des\s+valeurs\s+fonci[èe]res|prix\s+de\s+vente|date\s+de\s+vente|nb\s+de\s+pi[eè]ces|article|page",
            context,
            re.I,
        )
    )


def normalize_sale(raw_sale: dict[str, object]) -> AuctionSale:
    source_url = clean_text(raw_sale.get("source_url"))
    if not source_url:
        raise ValueError("raw sale is missing source_url")

    address = clean_text(raw_sale.get("address"))
    postal_code = clean_text(raw_sale.get("postal_code")) or extract_postal_code(address, raw_sale.get("raw_text"))
    city = clean_text(raw_sale.get("city")) or extract_city(address, postal_code)
    sale_date = parse_french_datetime(raw_sale.get("sale_date"))
    status = normalize_status(raw_sale.get("status"), sale_date)
    rooms_count = parse_rooms_count(raw_sale.get("rooms_count")) or extract_rooms_count_from_text(
        raw_sale.get("title"),
        raw_sale.get("description"),
        raw_sale.get("raw_text"),
    )
    bedrooms_count = parse_bedrooms_count(raw_sale.get("bedrooms_count")) or extract_bedrooms_count_from_text(
        raw_sale.get("title"),
        raw_sale.get("description"),
        raw_sale.get("raw_text"),
    )
    # Note: an impossible rooms < bedrooms pair is resolved downstream by
    # normalize_asset_features() (clears rooms_count to NULL and flags a
    # room_count_conflict), so we deliberately do not coerce it here.

    return AuctionSale(
        source_name=clean_text(raw_sale.get("source_name")) or "avoventes",
        source_url=source_url,
        primary_source=clean_text(raw_sale.get("source_name")) or "avoventes",
        source_urls=[source_url],
        dedupe_confidence=clean_text(raw_sale.get("dedupe_confidence")),
        external_id=clean_text(raw_sale.get("external_id")),
        tribunal=clean_text(raw_sale.get("tribunal")),
        department=clean_text(raw_sale.get("department")) or extract_department(postal_code),
        city=city,
        address=address,
        postal_code=postal_code,
        property_type=normalize_property_type(raw_sale.get("property_type") or raw_sale.get("title")),
        title=clean_text(raw_sale.get("title")),
        description=clean_text(raw_sale.get("description")),
        surface_m2=parse_surface(raw_sale.get("surface_m2")),
        habitable_surface_m2=parse_surface(raw_sale.get("habitable_surface_m2")),
        land_surface_m2=parse_surface(raw_sale.get("land_surface_m2")),
        carrez_surface_m2=parse_surface(raw_sale.get("carrez_surface_m2")),
        app_surface_m2=parse_surface(raw_sale.get("app_surface_m2")),
        app_surface_kind=clean_text(raw_sale.get("app_surface_kind")),
        surface_source=clean_text(raw_sale.get("surface_source")),
        surface_confidence=parse_confidence(raw_sale.get("surface_confidence")),
        surface_evidence=clean_text(raw_sale.get("surface_evidence")),
        rooms_count=rooms_count,
        bedrooms_count=bedrooms_count,
        bathrooms_count=parse_rooms_count(raw_sale.get("bathrooms_count")),
        parking_count=parse_rooms_count(raw_sale.get("parking_count")),
        has_garden=_parse_bool(raw_sale.get("has_garden")),
        has_terrace=_parse_bool(raw_sale.get("has_terrace")),
        has_garage=_parse_bool(raw_sale.get("has_garage")),
        has_pool=_parse_bool(raw_sale.get("has_pool")),
        has_air_conditioning=_parse_bool(raw_sale.get("has_air_conditioning")),
        has_double_glazing=_parse_bool(raw_sale.get("has_double_glazing")),
        starting_price_eur=extract_starting_price(raw_sale),
        sale_date=sale_date,
        visit_dates=[clean_text(item) for item in raw_sale.get("visit_dates", []) if clean_text(item)]
        if isinstance(raw_sale.get("visit_dates"), list)
        else [],
        lawyer_name=clean_text(raw_sale.get("lawyer_name")),
        lawyer_contact=clean_text(raw_sale.get("lawyer_contact")),
        status=status,
        adjudication_price_eur=parse_price(raw_sale.get("adjudication_price_eur")),
        documents=raw_sale.get("documents") if isinstance(raw_sale.get("documents"), list) else [],
        latitude=parse_decimal(raw_sale.get("latitude")),
        longitude=parse_decimal(raw_sale.get("longitude")),
        occupancy_status=normalize_occupancy_status(raw_sale.get("occupancy_status")),
        risk_notes=clean_text(raw_sale.get("risk_notes")),
        investment_score=parse_price(raw_sale.get("investment_score")),
        investment_summary=clean_text(raw_sale.get("investment_summary")),
        quality_flags=raw_sale.get("quality_flags") if isinstance(raw_sale.get("quality_flags"), list) else [],
        raw_text=clean_text(raw_sale.get("raw_text")),
        raw_payload=raw_sale,
        observations=raw_sale.get("observations") if isinstance(raw_sale.get("observations"), list) else [],
    )


def _parse_bool(value: object | None) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = clean_text(value)
    if not text:
        return None
    lowered = text.lower()
    if lowered in {"1", "true", "yes", "oui", "vrai"}:
        return True
    if lowered in {"0", "false", "no", "non", "faux"}:
        return False
    return None
