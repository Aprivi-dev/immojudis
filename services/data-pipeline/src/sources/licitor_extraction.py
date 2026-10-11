"""Lecture structurée d'une annonce Licitor à partir du texte de sa page détail.

Point d'entrée unique pour la collecte (texte de la page téléchargée) et pour le
recalcul sur l'existant (``source_blocks.page_text`` stocké), sans nouvelle
requête au site : :func:`extract_licitor_fields` lit le texte stable de la page
(lignes produites par ``get_text("\\n")``) et :func:`apply_licitor_fields`
applique le résultat à une vente brute ; :func:`refresh_licitor_raw_sale` rejoue
le tout sur une vente relue en base.

La page Licitor a une structure fixe : date de publication, numéro, tribunal,
type de vente, date d'audience, puis un ou plusieurs lots (titre, désignation,
« Mise à prix », conditions), la situation (commune, rue, plan, visites), les
avocats, la mention du cahier des conditions de vente, les pièces jointes et la
référence de la régie. Les balises en ligne (``<b>``) coupent le texte en
fragments : ils sont recollés avant lecture. Les compteurs de vues, l'encart
partenaire (prix au m² d'un tiers) et les adresses e-mail masquées par le site
ne sont jamais repris.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from src.cadastre_references import designation, parse_cadastral_references
from src.normalize import clean_text
from src.pdf_document_types import classify_document_type

FEATURES_SCHEMA_VERSION = "licitor_features_v1"
DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"
PARIS = ZoneInfo("Europe/Paris")

_MONTHS = {
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7,
    "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12,
}
_NUMBER_WORDS = {
    "un": 1, "une": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6, "sept": 7,
    "huit": 8, "neuf": 9, "dix": 10, "onze": 11, "douze": 12,
}
_PROCEDURES = (
    ("saisie_immobiliere", r"saisie\s+immobili[eè]re", "Saisie immobilière"),
    ("liquidation_judiciaire", r"liquidation\s+judiciaire", "Liquidation judiciaire"),
    ("licitation", r"licitation", "Licitation"),
    ("surenchere", r"surench[eè]re", "Surenchère"),
    ("reiteration_encheres", r"r[ée]it[ée]ration", "Réitération des enchères"),
)
_DOCUMENT_KIND_LABELS = {
    "cahier_conditions_vente": "Cahier des conditions de vente",
    "conditions_vente": "Conditions de vente",
    "pv_huissier": "Procès-verbal descriptif",
    "diagnostics_techniques": "Diagnostics techniques",
    "cadastre": "Cadastre et urbanisme",
    "annonce_vente": "Annonce",
    "bail": "Bail",
}
GROUPS = {
    "identification": "Annonce et procédure",
    "lots": "Lots mis en vente",
    "conditions": "Conditions pour enchérir",
    "situation": "Situation et occupation",
    "avocats": "Avocats",
    "divers": "Autres informations",
}

_PUBLISHED_RE = re.compile(r"^Annonce\s+publi[ée]e\s+le$", re.I)
_REFERENCE_RE = re.compile(r"^\d{5,7}$")
_SALE_DATE_RE = re.compile(
    r"\b(?P<day>\d{1,2})\s*(?:er)?\s+(?P<month>[a-zéûô]+)\s+(?P<year>20\d{2})\s+à\s+(?P<hour>\d{1,2})\s*h\s*(?P<minute>\d{2})?",
    re.I,
)
_LOT_MARKER_RE = re.compile(
    r"^(?:(?P<n>\d{1,2})\s*(?:er|ère|re|e|ème|eme|nd|nde)|(?P<w>premier|second|seconde))\s+lot(?:\s+de\s+(?:la\s+)?vente)?\s*:?$",
    re.I,
)
_PRICE_RE = re.compile(r"^Mise\s+[àa]\s+prix\s*:?\s*(?P<value>.*)$", re.I)
_LAWYER_RE = re.compile(
    r"\b(?P<role>Avocat(?:e|s)?|Commissaires?\s+de\s+justice|Notaires?)(?:\s+associ[ée]e?s?)?\s*$", re.I
)
_NOT_LAWYER_START_RE = re.compile(
    r"^(?:on|les?|la|l['’]|pour|il|elle|en|outre|au|aux|dont|par|et|ou|sur|un|une|des?|du|chaque|toute?s?)\b", re.I
)
_VISIT_START_RE = re.compile(r"^(?:Visites?\b|Aucune\s+visite|Pas\s+de\s+visite)", re.I)
_VISIT_STOP_RE = re.compile(r"^(?:Liens?\s+vers\s+les\s+documents|Afficher\s+le\s+plan|\(exactitude)", re.I)
_LOCATION_NOISE_RE = re.compile(r"^(?:Afficher\s+le\s+plan|\(exactitude\s+non\s+garantie\))$", re.I)
_ANNEX_NOTICE_RE = re.compile(r"^Liens?\s+vers\s+les\s+documents\s+annexes", re.I)
_CCV_NOTICE_RE = re.compile(r"^Le\s+cahier\s+des\s+conditions\s+de\s+vente\b", re.I)
_GREFFE_RE = re.compile(r"r[ée]f[ée]rence\s+(?:du\s+)?greffe\s*(?:n\s*[°º]|no)?\s*(?P<ref>[\w./-]*\d[\w./-]*)", re.I)
_REGIE_RE = re.compile(r"^(?P<regie>.{2,80}?)\s+-\s+R[ée]f\.\s*(?P<ref>\S.{0,40})$")
_NON_OFFICIAL_RE = re.compile(r"^Annonce\s+non[- ]officielle\b.*$", re.I)
_H1_RE = re.compile(
    r"^Annonce\s+n[°º]\s*\d+\s*:\s*(?P<what>.+)\s+à\s+(?P<city>[^,]+?)(?:\s+\((?P<dept>[^)]+)\))?,\s*mise\s+à\s+prix",
    re.I,
)
_AMOUNT_RE = re.compile(r"(?<![\d.,])(?P<value>\d{1,3}(?:[   .]\d{3})+|\d+)(?:,\d{1,2})?\s*(?:€|euros?\b)", re.I)
_SURFACE_RE = re.compile(r"(?P<value>\d{1,3}(?:[ .  ]\d{3})+(?:,\d+)?|\d+(?:[,.]\d+)?)\s*m\s*(?:²|2)(?![\w³])", re.I)
_CONTINUATION_TAIL_RE = re.compile(
    r"(?:\(|['’]|\b(?:de|du|des|la|le|les|à|au|aux|et|ou|en|par|pour|sur|avec|dont|d'une?|l|d|un|une|soit|selon))$",
    re.I,
)
_CONDITION_CUE_RE = re.compile(
    r"consignation|ench[eè]r|faculté|baisse|chèque|cheque|caution|séquestre|sequestre|carpa|frais|barreau|"
    r"précédemment|precedemment|adjug|mise\s+à\s+prix|émoluments|emoluments|montant|bâtonnier|batonnier",
    re.I,
)
_OCCUPANCY_LINE_RE = re.compile(
    r"\b(?:occup\w*|inoccup\w*|libres?|lou[ée]e?s?|vacant\w*|vides?|bail|squatt\w*)\b", re.I
)
_PARTIAL_RE = re.compile(r"\b(?:partiellement|une\s+partie|seul|un\s+libre|en\s+partie)\b", re.I)
_LAND_TITLE_RE = re.compile(r"\b(?:terrains?|parcelles?|bois|prés?|pâtures?|landes?|vignes?)\b", re.I)


def _fold(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"\s+", " ", text).strip()


def _amount(text: str | None) -> int | None:
    match = _AMOUNT_RE.search(text or "")
    if not match:
        return None
    digits = re.sub(r"\D", "", match.group("value"))
    return int(digits) if digits else None


def _join(lines: list[str]) -> str:
    """Recolle des fragments de texte coupés par des balises en ligne."""
    text = " ".join(line.strip() for line in lines if line and line.strip())
    text = re.sub(r"\s+([,.;)\]])", r"\1", text)
    text = re.sub(r"([(\[])\s+", r"\1", text)
    return clean_text(text) or ""


def _paragraphs(lines: list[str]) -> list[str]:
    """Regroupe les fragments en paragraphes (une ligne qui continue la phrase est recollée)."""
    paragraphs: list[str] = []
    for raw in lines:
        line = (raw or "").strip()
        if not line:
            continue
        if paragraphs and (
            line[0] in ",.;:)]"
            or line[0].islower()
            or _CONTINUATION_TAIL_RE.search(paragraphs[-1])
            # Intitulé court en gras (« Consignation pour enchérir : ») suivi de sa valeur.
            or (paragraphs[-1].endswith(":") and len(paragraphs[-1]) <= 40)
        ):
            paragraphs[-1] = _join([paragraphs[-1], line])
        else:
            paragraphs.append(_join([line]))
    return [paragraph for paragraph in paragraphs if paragraph]


def _french_date(text: str | None) -> date | None:
    match = re.search(r"\b(\d{1,2})\s*(?:er)?\s+([a-zéûô]+)\s+(20\d{2})\b", _join([text or ""]), re.I)
    if not match:
        return None
    month = _MONTHS.get(_fold(match.group(2)))
    if not month:
        return None
    try:
        return date(int(match.group(3)), month, int(match.group(1)))
    except ValueError:
        return None


def _sale_datetime(text: str | None) -> datetime | None:
    match = _SALE_DATE_RE.search(_join([text or ""]))
    if not match:
        return None
    month = _MONTHS.get(_fold(match.group("month")))
    if not month:
        return None
    try:
        return datetime(
            int(match.group("year")), month, int(match.group("day")),
            int(match.group("hour")), int(match.group("minute") or 0), tzinfo=PARIS,
        )
    except ValueError:
        return None


def _price_text(amount: int | None) -> str | None:
    return f"{amount:,}".replace(",", " ") + " €" if amount is not None else None


@dataclass
class LicitorLot:
    number: int
    label: str | None = None
    title: str | None = None
    paragraphs: list[str] = field(default_factory=list)
    price_text: str | None = None
    price_eur: int | None = None
    conditions: list[str] = field(default_factory=list)
    city: str | None = None
    street: str | None = None
    visits: list[str] = field(default_factory=list)
    visit_notes: list[str] = field(default_factory=list)

    @property
    def description(self) -> str:
        return " ".join(self.paragraphs)

    @property
    def text(self) -> str:
        return " ".join(part for part in (self.title, self.description) if part)

    def occupancy_lines(self) -> list[str]:
        return [
            paragraph for paragraph in self.paragraphs
            if len(paragraph) <= 110 and _OCCUPANCY_LINE_RE.search(paragraph) and not _SURFACE_RE.search(paragraph)
        ]

    def surfaces(self) -> list[dict[str, str]]:
        found: list[dict[str, str]] = []
        for match in _SURFACE_RE.finditer(self.text):
            raw = re.sub(r"[ .  ](?=\d{3}\b)", "", match.group("value")).replace(",", ".")
            context = self.text[max(0, match.start() - 50): match.end() + 40]
            found.append({"value": raw, "context": clean_text(context) or ""})
        return found[:12]

    def cadastre_sentences(self) -> list[str]:
        return [paragraph for paragraph in self.paragraphs if re.search(r"cadastr", paragraph, re.I)]


@dataclass
class LicitorLawyer:
    name: str
    role: str = "avocat"
    address: str | None = None
    phone: str | None = None
    fax: str | None = None
    website: str | None = None
    email_published: bool = False
    extra: list[str] = field(default_factory=list)

    def contact(self) -> str | None:
        parts = [self.address]
        if self.phone:
            parts.append(f"Tél.: {self.phone}")
        if self.fax:
            parts.append(f"Fax : {self.fax}")
        parts.append(self.website)
        return " | ".join(part for part in parts if part) or None

    def as_dict(self) -> dict[str, Any]:
        return {
            key: value
            for key, value in {
                "name": self.name, "role": self.role, "address": self.address, "phone": self.phone, "fax": self.fax,
                "website": self.website, "email_published": self.email_published or None,
                "notes": self.extra or None,
            }.items()
            if value not in (None, "", [])
        }


@dataclass
class LicitorPage:
    published_on: date | None = None
    reference: str | None = None
    court: str | None = None
    sale_type: str | None = None
    sale_at: datetime | None = None
    sale_date_text: str | None = None
    lots: list[LicitorLot] = field(default_factory=list)
    lawyers: list[LicitorLawyer] = field(default_factory=list)
    ccv_notice: str | None = None
    greffe_reference: str | None = None
    document_labels: list[str] = field(default_factory=list)
    regie: str | None = None
    regie_reference: str | None = None
    non_official_notice: str | None = None
    annex_notice: bool = False
    headline_city: str | None = None
    headline_department: str | None = None
    zone: str | None = None
    region: str | None = None
    category: str | None = None

    @property
    def is_structured(self) -> bool:
        return bool(self.reference and self.lots)

    @property
    def court_name(self) -> str | None:
        """Tribunal sans le lieu d'audience (« Tribunal Judiciaire de Paris »)."""
        if not self.court:
            return None
        match = re.search(r"Tribunal\s+Judiciaire\s+(?:de\s+|d['’]\s*|du\s+)?[^,(]+", self.court, re.I)
        return clean_text(match.group(0)) if match else clean_text(re.sub(r"\s*\([^)]*\)\s*$", "", self.court))

    @property
    def venue(self) -> str | None:
        """Lieu d'audience quand il diffère du tribunal (« Parvis Robert Badinter, à Paris 17ème », « Annexe »)."""
        if not self.court:
            return None
        if re.match(r"^À\s+l['’]Annexe", self.court, re.I):
            return clean_text(re.sub(r"\s*\([^)]*\)\s*$", "", self.court))
        _, _, rest = self.court.partition(",")
        return clean_text(rest) or None

    def procedures(self) -> list[tuple[str, str]]:
        text = _fold(self.sale_type)
        return [(code, label) for code, pattern, label in _PROCEDURES if re.search(_fold(pattern), text)]

    @property
    def announced_lots(self) -> int | None:
        match = re.search(r"\ben\s+(\w+)\s+(?:seul\s+)?lots?\b", _fold(self.sale_type))
        if not match:
            return None
        word = match.group(1)
        return int(word) if word.isdigit() else _NUMBER_WORDS.get(word)


def _stable_lines(page_text: str) -> list[str]:
    lines = []
    for raw in page_text.splitlines():
        line = clean_text(raw)
        if line:
            lines.append(line)
    return lines


def _is_lawyer_line(line: str) -> bool:
    if len(line) > 220 or not _LAWYER_RE.search(line):
        return False
    if line[0].islower() or line[0] in ",;:(" or _NOT_LAWYER_START_RE.match(line):
        return False
    return not re.search(r"minist[eè]re|par\s+l['’]avocat|barreau", line, re.I)


def _header(lines: list[str], page: LicitorPage) -> int | None:
    """Lit l'en-tête (publication, numéro, tribunal, type, audience) ; renvoie l'index du début des lots."""
    for line in lines[:60]:
        match = _H1_RE.match(line)
        if match:
            page.headline_city = clean_text(match.group("city"))
            page.headline_department = clean_text(match.group("dept"))
            break
    for index, line in enumerate(lines[:80]):
        if line.lower() == "annonces similaires":
            nearby = lines[index + 1: index + 5]
            plain = [item for item in nearby if " - " not in item]
            typed = [item for item in nearby if " - " in item]
            page.zone = plain[0] if plain else None
            page.region = plain[1] if len(plain) > 1 else None
            if typed:
                page.category = clean_text(typed[-1].rsplit(" - ", 1)[1])
            break
    start = next((index for index, line in enumerate(lines) if _PUBLISHED_RE.match(line)), None)
    if start is None:
        return None
    cursor = start + 1
    published_parts: list[str] = []
    while cursor < len(lines) and cursor < start + 6 and not _REFERENCE_RE.match(lines[cursor]):
        published_parts.append(lines[cursor])
        cursor += 1
    page.published_on = _french_date(" ".join(published_parts))
    if cursor >= len(lines) or not _REFERENCE_RE.match(lines[cursor]):
        return None
    page.reference = lines[cursor]
    cursor += 1
    header: list[str] = []
    while cursor < len(lines) and len(header) < 6:
        line = lines[cursor]
        cursor += 1
        if _SALE_DATE_RE.search(line):
            page.sale_date_text = line
            page.sale_at = _sale_datetime(line)
            break
        header.append(line)
    else:
        return None
    if header:
        page.court = header[0]
        rest = header[1:]
        if rest:
            page.sale_type = _join(rest)
    return cursor


def _split_lots(lines: list[str]) -> list[tuple[str | None, list[str]]]:
    markers = [index for index, line in enumerate(lines) if _LOT_MARKER_RE.match(line)]
    if not markers:
        return [(None, lines)]
    segments: list[tuple[str | None, list[str]]] = []
    for position, index in enumerate(markers):
        end = markers[position + 1] if position + 1 < len(markers) else len(lines)
        body = lines[index + 1: end]
        if position == 0 and index > 0:
            body = lines[:index] + body
        segments.append((lines[index], body))
    return segments


def _looks_like_address(line: str) -> bool:
    return (
        len(line) <= 90
        and "€" not in line
        and not line[0].islower()
        and line[0] not in ",;:"
        and not line.endswith(":")
        and not _CONDITION_CUE_RE.search(line)
        and not _PRICE_RE.match(line)
    )


def _location_start(trailing: list[str], cities: list[str]) -> int | None:
    folded = [_fold(city) for city in cities if city]
    for index, line in enumerate(trailing):
        name = _fold(re.sub(r"\s*\([^)]*\)\s*$", "", line))
        if name and name in folded:
            return index
    anchor = next(
        (index for index, line in enumerate(trailing) if _LOCATION_NOISE_RE.match(line) or _VISIT_START_RE.match(line)),
        None,
    )
    if anchor is None:
        return None
    start = anchor
    while start > 0 and anchor - start < 3 and _looks_like_address(trailing[start - 1]):
        start -= 1
    return start if start < anchor else None


def _parse_lot(number: int, label: str | None, body: list[str], cities: list[str]) -> LicitorLot:
    lot = LicitorLot(number=number, label=label)
    price_index = next((index for index, line in enumerate(body) if _PRICE_RE.match(line)), None)
    content = body if price_index is None else body[:price_index]
    trailing = [] if price_index is None else body[price_index + 1:]
    if price_index is not None:
        value = _PRICE_RE.match(body[price_index]).group("value")
        if not value and trailing:
            value, trailing = trailing[0], trailing[1:]
        lot.price_text = clean_text(value)
        lot.price_eur = _amount(value)
    if content:
        lot.title = content[0]
        lot.paragraphs = _paragraphs(content[1:])
    location_index = _location_start(trailing, cities)
    if location_index is None:
        visit_index = next((index for index, line in enumerate(trailing) if _VISIT_START_RE.match(line)), None)
        condition_lines = trailing if visit_index is None else trailing[:visit_index]
        rest = [] if visit_index is None else trailing[visit_index:]
        location: list[str] = []
    else:
        condition_lines = trailing[:location_index]
        after = trailing[location_index:]
        stop = next(
            (index for index, line in enumerate(after)
             if index > 0 and (_LOCATION_NOISE_RE.match(line) or _VISIT_START_RE.match(line) or _ANNEX_NOTICE_RE.match(line))),
            len(after),
        )
        location, rest = after[:stop], after[stop:]
    lot.conditions = _paragraphs(condition_lines)
    if location:
        lot.city = clean_text(re.sub(r"\s*\([^)]*\)\s*$", "", location[0]))
        lot.street = ", ".join(location[1:]) or None
    visit: list[str] = []
    for line in rest + [""]:
        if _VISIT_START_RE.match(line) or not line or _VISIT_STOP_RE.match(line):
            if visit:
                text = _join(visit)
                (lot.visit_notes if re.match(r"^(?:Aucune|Pas\s+de)\s+visite", text, re.I) else lot.visits).append(text)
            visit = [line] if line and _VISIT_START_RE.match(line) else []
        elif visit:
            visit.append(line)
    return lot


def _parse_trailer(lines: list[str], page: LicitorPage) -> None:
    current: LicitorLawyer | None = None
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if _is_lawyer_line(line):
            role = _fold(_LAWYER_RE.search(line).group("role"))
            current = LicitorLawyer(
                name=line,
                role="commissaire_de_justice" if role.startswith("commissaire") else "notaire" if role.startswith("notaire") else "avocat",
            )
            page.lawyers.append(current)
            continue
        if _CCV_NOTICE_RE.match(line):
            notice = [line]
            while index < len(lines) and (lines[index][0] in ",;:)" or lines[index][0].islower()
                                          or _CONTINUATION_TAIL_RE.search(notice[-1])):
                notice.append(lines[index])
                index += 1
            page.ccv_notice = _join(notice)
            greffe = _GREFFE_RE.search(page.ccv_notice)
            page.greffe_reference = greffe.group("ref").rstrip(".,") if greffe else page.greffe_reference
            current = None
            continue
        if _NON_OFFICIAL_RE.match(line):
            page.non_official_notice = line
            current = None
            continue
        regie = _REGIE_RE.match(line)
        if regie and not current:
            page.regie = clean_text(regie.group("regie"))
            page.regie_reference = clean_text(regie.group("ref"))
            continue
        if current is not None:
            if re.match(r"^T[ée]l\.?\s*:?", line, re.I):
                phone, _, fax = re.sub(r"^T[ée]l\.?\s*:?\s*", "", line, flags=re.I).partition("Fax")
                current.phone = clean_text(phone.strip(" -")) or current.phone
                current.fax = clean_text(fax.strip(" :-")) or current.fax
                continue
            if re.match(r"^Fax\b", line, re.I):
                current.fax = clean_text(re.sub(r"^Fax\s*:?\s*", "", line, flags=re.I))
                continue
            if "email protected" in line.lower() or re.search(r"[\w.+-]+@[\w-]+\.\w", line):
                current.email_published = True  # adresse masquée par le site : jamais décodée
                continue
            if re.match(r"^(?:https?://)?www\.|^https?://", line, re.I):
                current.website = current.website or line
                continue
            if current.address is None and (re.search(r"\b\d{5}\b|cedex", line, re.I)):
                current.address = line
                continue
            if line.startswith("(") and len(line) < 80:
                current.extra.append(line)
                continue
            if current.address is not None and len(current.extra) < 2 and re.search(r"\b\d{5}\b", line):
                current.extra.append(line)
                continue
            current = None
        if line not in page.document_labels and len(line) <= 90:
            page.document_labels.append(line)


def parse_licitor_page(page_text: str | None) -> LicitorPage:
    page = LicitorPage()
    if not isinstance(page_text, str) or not page_text.strip():
        return page
    lines = _stable_lines(page_text)
    end = next((index for index, line in enumerate(lines) if line == "Imprimer"), len(lines))
    lines = lines[:end]
    start = _header(lines, page)
    if start is None:
        return page
    body = lines[start:]
    first_price = next((index for index, line in enumerate(body) if _PRICE_RE.match(line)), len(body))
    # Un commissaire de justice cité pour la visite ne commence pas le bloc des contacts : un avocat d'abord.
    lawyer_index = next(
        (index for index, line in enumerate(body)
         if index > first_price and _is_lawyer_line(line) and _fold(_LAWYER_RE.search(line).group("role")).startswith("avocat")),
        None,
    )
    if lawyer_index is None:
        lawyer_index = next(
            (index for index, line in enumerate(body) if index > first_price and _is_lawyer_line(line)), None
        )
    if lawyer_index is None:
        lawyer_index = next(
            (index for index, line in enumerate(body) if _CCV_NOTICE_RE.match(line) or _NON_OFFICIAL_RE.match(line)),
            len(body),
        )
    property_lines = body[:lawyer_index]
    page.annex_notice = any(_ANNEX_NOTICE_RE.match(line) for line in property_lines)
    cities = [page.headline_city] if page.headline_city else []
    for number, (label, segment) in enumerate(_split_lots(property_lines), start=1):
        lot = _parse_lot(number, label, segment, cities)
        if lot.title or lot.price_text:
            page.lots.append(lot)
            if lot.city and lot.city not in cities:
                cities.append(lot.city)
    _parse_trailer(body[lawyer_index:], page)
    return page


def _statement_status(line: str) -> str | None:
    """Statut d'une phrase d'occupation courte (« Occupé », « Les biens sont inoccupés », « Loué »)."""
    text = _fold(line)
    text = re.sub(r"\bnon\s+occupe\w*", " inoccupe ", text)
    found = set()
    if re.search(r"\b(?:libres?|inoccupe\w*|vacant\w*|vides?|inhabite\w*)\b", text):
        found.add("vacant")
    if re.search(r"\b(?:louee?s?|bail|locataires?)\b", text):
        found.add("rented")
    if re.search(r"\b(?:occupee?s?|squatt\w*)\b", text):
        found.add("occupied")
    if found == {"rented", "occupied"} or (found == {"occupied"} and re.search(r"\bloyers?\b", text)):
        return "rented"  # « Occupée (loyer de 550 €) » : occupé par un locataire
    return found.pop() if len(found) == 1 else None


def _occupancy(lot: LicitorLot) -> tuple[str | None, list[str]]:
    """Statut d'occupation déclaré par les phrases d'occupation du lot, s'il est univoque."""
    lines = lot.occupancy_lines()
    statuses = {_statement_status(line) for line in lines}
    if not lines or len(statuses) != 1 or None in statuses or any(_PARTIAL_RE.search(line) for line in lines):
        return None, lines
    return statuses.pop(), lines


def _prior_adjudication(text: str) -> dict[str, Any] | None:
    match = re.search(
        r"pr[ée]c[ée]demment\s+adjug[ée]e?s?\s+(?:à|pour)?\s*(?P<amount>[\d .  ]+)\s*(?:€|euros?)"
        r"(?:\s+le\s+(?P<date>\d{1,2}[/.]\d{1,2}[/.]\d{2,4}))?",
        text,
        re.I,
    )
    if not match:
        return None
    digits = re.sub(r"\D", "", match.group("amount"))
    return {
        "price_eur": int(digits) if digits else None,
        "date": match.group("date"),
        "text": clean_text(match.group(0)),
    }


def _deposit(conditions: list[str]) -> dict[str, Any] | None:
    text = " ".join(conditions)
    match = re.search(r"consignation|caution\s+bancaire|ch[eè]que\s+de\s+banque", text, re.I)
    if not match:
        return None
    window = text[match.start(): match.start() + 400]
    amount = None
    explicit = re.search(
        r"(?:soit(?:\s+en\s+l['’]esp[eè]ce)?|d['’]un\s+montant\s+de|s[ée]questre\s+de|carpa\s+de|consignation(?:\s+pour\s+ench[ée]rir)?\s*:|ordre\s+du\s+b[âa]tonnier\s+s[ée]questre\s+de|^)\s*"
        r"(?P<amount>\d{1,3}(?:[ .  ]\d{3})+|\d+)\s*€",
        window,
        re.I,
    )
    if explicit:
        amount = int(re.sub(r"\D", "", explicit.group("amount")))
    rule = re.search(r"(\d{1,2})\s*%\s+du\s+montant\s+de\s+la\s+mise\s+[àa]\s+prix", window, re.I)
    minimum = re.search(r"(?:minimum\s+de|inf[ée]rieur\s+[àa])\s+(\d{1,3}(?:[ .  ]\d{3})+|\d+)\s*€", window, re.I)
    return {
        key: value
        for key, value in {
            "amount_eur": amount,
            "percent_of_starting_price": int(rule.group(1)) if rule else None,
            "minimum_eur": int(re.sub(r"\D", "", minimum.group(1))) if minimum else None,
            "text": clean_text(next((item for item in conditions if re.search(r"consignation|caution|ch[eè]que", item, re.I)), None)),
        }.items()
        if value is not None
    }


def _condition_facts(lot: LicitorLot) -> dict[str, Any]:
    text = " ".join(lot.conditions)
    facts: dict[str, Any] = {}
    reduction = next((item for item in lot.conditions if re.search(r"facult[ée]\s+de\s+baisse|baisse\s+de\s+la\s+mise", item, re.I)), None)
    if reduction:
        facts["price_reduction"] = reduction
    deposit = _deposit(lot.conditions)
    if deposit:
        facts["deposit"] = deposit
    prior = _prior_adjudication(text)
    if prior:
        facts["prior_adjudication"] = prior
    bar = next((item for item in lot.conditions if re.search(r"barreau|minist[eè]re\s+d['’]\s*(?:un\s+)?avocat", item, re.I)), None)
    if bar:
        facts["bidding_restriction"] = bar
    return facts


def _cadastre(lot: LicitorLot, city: str | None) -> dict[str, Any] | None:
    sentences = lot.cadastre_sentences()
    if not sentences:
        return None
    text = sentences[0]
    current = re.split(r"\bactuellement\b", text, maxsplit=1, flags=re.I)
    refs = parse_cadastral_references(current[-1] if len(current) > 1 else text)
    return {
        "text": text[:300],
        "parcels": [ref.label() for ref in refs],
        "designation": designation(refs, city),
    }


def _surface_scope(lot: LicitorLot) -> str:
    return "land" if lot.title and _LAND_TITLE_RE.search(lot.title) and not re.search(
        r"maison|appartement|immeuble|b[âa]timent|local|ensemble", lot.title, re.I
    ) else "built"


def _primary_surface(lot: LicitorLot) -> str | None:
    """Surface annoncée juste après le titre du lot (« de 124,92 m² … »)."""
    match = re.match(r"^(?:d['’]une\s+surface\s+(?:globale\s+)?(?:d['’]environ\s+)?|de\s+)" + _SURFACE_RE.pattern,
                     lot.description, re.I)
    if not match:
        return None
    return re.sub(r"[ .  ](?=\d{3}\b)", "", match.group("value")).replace(",", ".")


def _media(raw_sale: dict[str, Any]) -> dict[str, Any]:
    images = dedupe_licitor_images(raw_sale.get("source_images"))
    previous = raw_sale.get("source_property_features") if isinstance(raw_sale.get("source_property_features"), dict) else {}
    previous_media = previous.get("media") if isinstance(previous.get("media"), dict) else {}
    # La vidéo n'est pas dans le texte stocké : au recalcul, on reprend celle lue à la collecte.
    tours = [
        url for url in raw_sale.get("source_virtual_tours") or previous_media.get("virtual_tour_urls") or []
        if isinstance(url, str)
    ]
    return {"photos": len(images), "virtual_tours": len(tours), "images": images[:20], "virtual_tour_urls": tours[:5]}


def _attachments(raw_sale: dict[str, Any]) -> list[dict[str, str]]:
    attachments = []
    for document in raw_sale.get("documents") or []:
        if not isinstance(document, dict) or not document.get("url"):
            continue
        label = clean_text(document.get("label")) or "Document"
        kind = classify_document_type(label, None)
        attachments.append({
            "label": label,
            "url": str(document["url"]),
            "kind": kind,
            **({"kind_label": _DOCUMENT_KIND_LABELS[kind]} if kind in _DOCUMENT_KIND_LABELS else {}),
            "format": "pdf" if re.search(r"\.pdf(?:$|[?#])", str(document["url"]), re.I) else str(document.get("type") or ""),
        })
    return attachments


def _lot_summary(lot: LicitorLot) -> str:
    parts = [lot.title or "Lot"]
    surface = _primary_surface(lot)
    if surface:
        parts.append(f"{surface.replace('.', ',')} m²")
    if lot.price_eur is not None:
        parts.append(f"mise à prix {_price_text(lot.price_eur)}")
    return " — ".join(parts)


def extract_licitor_fields(page_text: str | None, raw_sale: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Champs, blocs et caractéristiques d'une annonce ; ``None`` si la page n'est pas une fiche détail."""
    page = parse_licitor_page(page_text)
    if not page.is_structured:
        return None
    raw_sale = raw_sale or {}
    first = page.lots[0]
    city = first.city or next((lot.city for lot in page.lots if lot.city), None) or page.headline_city or clean_text(
        raw_sale.get("city")
    )
    procedures = page.procedures()
    occupancy, occupancy_lines = _occupancy(first)
    lots_view = []
    for lot in page.lots:
        lot_occupancy, lot_occupancy_lines = _occupancy(lot)
        lots_view.append({
            key: value
            for key, value in {
                "number": lot.number,
                "label": lot.label,
                "title": lot.title,
                "description": lot.description[:2000] or None,
                "starting_price_eur": lot.price_eur,
                "starting_price_text": lot.price_text,
                "surface_m2": _primary_surface(lot),
                "surface_scope": _surface_scope(lot) if _primary_surface(lot) else None,
                "surfaces": lot.surfaces() or None,
                "occupancy_status": lot_occupancy,
                "occupancy_text": lot_occupancy_lines or None,
                "conditions": lot.conditions or None,
                **_condition_facts(lot),
                "city": lot.city,
                "street": lot.street,
                "visits": lot.visits or None,
                "visit_notes": lot.visit_notes or None,
                "cadastre": _cadastre(lot, lot.city or city),
            }.items()
            if value not in (None, "", [], {})
        })
    visits = list(dict.fromkeys(visit for lot in page.lots for visit in lot.visits))
    visit_notes = list(dict.fromkeys(note for lot in page.lots for note in lot.visit_notes))
    facts = _condition_facts(first)
    cadastre = _cadastre(first, city)
    media = _media(raw_sale)
    attachments = _attachments(raw_sale)
    multi = len(page.lots) > 1
    lawyer = next((item for item in page.lawyers if item.role == "avocat"), None)

    items: list[dict[str, Any]] = []

    def add(key: str, label: str, value: object, group: str) -> None:
        text = clean_text(value) if not isinstance(value, (int, float)) else str(value)
        if text:
            items.append({"key": key, "label": label, "value": text, "group": group})

    add("reference", "Annonce Licitor n°", page.reference, "identification")
    add("sale_type", "Type de vente", page.sale_type, "identification")
    add("court", "Tribunal", page.court_name, "identification")
    add("venue", "Lieu de l'audience", page.venue, "identification")
    add("occupancy", "Occupation déclarée", " ; ".join(occupancy_lines[:3]), "identification")
    add("greffe_reference", "Référence greffe du cahier des conditions", page.greffe_reference, "identification")
    if multi:
        for lot in page.lots:
            add(f"lot_{lot.number}", lot.label or f"Lot {lot.number}", _lot_summary(lot), "lots")
    add("price_reduction", "Baisse de la mise à prix", facts.get("price_reduction"), "conditions")
    add("deposit", "Consignation pour enchérir", (facts.get("deposit") or {}).get("text"), "conditions")
    prior = facts.get("prior_adjudication")
    if prior:
        add("prior_adjudication", "Précédente adjudication",
            " ".join(part for part in (_price_text(prior.get("price_eur")), f"le {prior['date']}" if prior.get("date") else None) if part),
            "conditions")
    add("bidding_restriction", "Enchères", facts.get("bidding_restriction"), "conditions")
    other_conditions = [item for item in first.conditions if item not in {
        facts.get("price_reduction"), (facts.get("deposit") or {}).get("text"), facts.get("bidding_restriction")
    } and not (prior and prior["text"] in item)]
    add("other_conditions", "Autres conditions", " ".join(other_conditions)[:600], "conditions")
    add("ccv_consultation", "Consultation du cahier des conditions", page.ccv_notice, "conditions")
    add("cadastre", "Cadastre (annonce)", cadastre.get("text") if cadastre else None, "situation")
    add("visit_note", "Visite", " ; ".join(visit_notes), "situation")
    add("category", "Catégorie Licitor", page.category, "situation")
    add("region", "Région", page.region, "situation")
    for position, item in enumerate(page.lawyers, start=1):
        role_label = {"commissaire_de_justice": "Commissaire de justice", "notaire": "Notaire"}.get(item.role, "Avocat")
        add(f"lawyer_{position}", role_label, " — ".join(part for part in (item.name, item.contact()) if part), "avocats")
    add("regie", "Régie de publication", " - Réf. ".join(part for part in (page.regie, page.regie_reference) if part), "divers")
    add("notice", "Mention de la source", page.non_official_notice, "divers")

    surfaces: dict[str, str] = {}
    primary = _primary_surface(first)
    if primary:
        surfaces["land_surface_m2" if _surface_scope(first) == "land" else "built_surface_m2"] = primary
    land = clean_text(raw_sale.get("land_surface_m2"))
    if land and "land_surface_m2" not in surfaces:
        surfaces["land_surface_m2"] = land

    prices: dict[str, int] = {}
    if first.price_eur is not None:
        prices["starting_price_eur"] = first.price_eur
    deposit = facts.get("deposit") or {}
    if deposit.get("amount_eur"):
        prices["deposit_eur"] = deposit["amount_eur"]
    procedure_view: dict[str, Any] = {}
    if procedures:
        procedure_view["method_label"] = " · ".join(label for _, label in procedures)
    if visits:
        procedure_view["visits"] = visits
    if prices:
        procedure_view["prices"] = prices
    if page.sale_at:
        procedure_view["deadline"] = {"at": page.sale_at.isoformat(), "kind": "adjudication"}

    display = {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": "licitor",
        "nature": [{"label": lot.title, "display": lot.title} for lot in page.lots if lot.title][:6],
        "category": page.category,
        "groups": GROUPS,
        "items": items,
        "surfaces": surfaces,
        "energy": {},
        "media": {key: media[key] for key in ("photos", "virtual_tours") if media[key]},
        "attachments": [
            {key: attachment[key] for key in ("label", "kind", "kind_label", "format") if attachment.get(key)}
            for attachment in attachments
        ],
        "procedure": procedure_view,
        "dates": {"published_on": page.published_on.isoformat()} if page.published_on else {},
        **({"location": {"designation": cadastre["designation"]}} if cadastre and cadastre.get("designation") else {}),
    }

    fields: dict[str, Any] = {
        "visit_dates": visits,
        "lawyer_name": lawyer.name if lawyer else None,
        "lawyer_contact": lawyer.contact() if lawyer else None,
        "occupancy_status_declared": occupancy,
    }
    blocks = {
        "date_publication": page.published_on.isoformat() if page.published_on else None,
        "type_vente": page.sale_type,
        "procedure_vente": " · ".join(label for _, label in procedures) or None,
        "lieu_audience": page.venue,
        "lots_detail": "\n".join(_lot_summary(lot) for lot in page.lots) if multi else None,
        "conditions_vente": " ".join(first.conditions)[:1500] or None,
        "baisse_mise_a_prix": facts.get("price_reduction"),
        "consignation": deposit.get("text"),
        "adjudication_precedente": prior["text"] if prior else None,
        "reference_greffe": page.greffe_reference,
        "consultation_cahier": page.ccv_notice,
        "avocats": " ; ".join(item.name for item in page.lawyers) or None,
        "regie": " - Réf. ".join(part for part in (page.regie, page.regie_reference) if part) or None,
        "mention_source": page.non_official_notice,
        "categorie_licitor": page.category,
        "visite_note": " ; ".join(visit_notes) or None,
        "occupation_declaree": " ; ".join(occupancy_lines[:3]) or None,
        "designation_cadastrale": cadastre.get("designation") if cadastre else None,
        "nombre_photos": media["photos"] or None,
        "visite_virtuelle": media["virtual_tour_urls"][0] if media["virtual_tour_urls"] else None,
        "visites": " | ".join(visits) or None,
        "contact_avocat": fields["lawyer_contact"],
        "caracteristiques_bien": display,
    }
    features = {
        "schema_version": FEATURES_SCHEMA_VERSION,
        "listing": {
            key: value
            for key, value in {
                "reference": page.reference,
                "published_on": page.published_on.isoformat() if page.published_on else None,
                "zone": page.zone,
                "region": page.region,
                "category": page.category,
                "headline_city": page.headline_city,
                "headline_department": page.headline_department,
                "regie": page.regie,
                "regie_reference": page.regie_reference,
                "non_official_notice": page.non_official_notice,
                "annex_documents_notice": page.annex_notice or None,
            }.items()
            if value not in (None, "")
        },
        "procedure": {
            key: value
            for key, value in {
                "sale_type": page.sale_type,
                "codes": [code for code, _ in procedures] or None,
                "labels": [label for _, label in procedures] or None,
                "announced_lots": page.announced_lots,
                "court": page.court_name,
                "court_line": page.court,
                "venue": page.venue,
                "sale_at": page.sale_at.isoformat() if page.sale_at else None,
                "greffe_reference": page.greffe_reference,
                "ccv_notice": page.ccv_notice,
                "visits": visits or None,
                "visit_notes": visit_notes or None,
            }.items()
            if value not in (None, "", [])
        },
        "lots": lots_view,
        "lot_count": len(page.lots),
        "lawyers": [item.as_dict() for item in page.lawyers],
        "media": {
            **media,
            "attachments": attachments,
            "attachment_count": len(attachments),
            "document_labels_text": page.document_labels[:12] or None,
        },
        **({"cadastre": cadastre} if cadastre else {}),
    }
    return {
        "fields": fields,
        "source_blocks": {key: value for key, value in blocks.items() if value not in (None, "", [], {})},
        "source_property_features": features,
        "page": page,
    }


def apply_licitor_fields(raw_sale: dict[str, Any], extracted: dict[str, Any]) -> dict[str, Any]:
    """Applique une extraction à une vente brute (collecte ou relecture en base)."""
    fields = extracted["fields"]
    if fields.get("visit_dates"):
        raw_sale["visit_dates"] = fields["visit_dates"]
    else:
        # Sans visite publiée, une ancienne lecture (« Visite virtuelle », libellé de pièce) est fausse.
        raw_sale["visit_dates"] = []
    if fields.get("lawyer_name"):
        raw_sale["lawyer_name"] = fields["lawyer_name"]
        raw_sale["lawyer_contact"] = fields.get("lawyer_contact")
    declared = fields.get("occupancy_status_declared")
    if declared and raw_sale.get("occupancy_status") in (None, "", "unknown"):
        raw_sale["occupancy_status"] = declared
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    blocks = {**blocks, **extracted["source_blocks"]}
    if not fields.get("visit_dates"):
        blocks.pop("visites", None)
    if raw_sale.get("occupancy_status"):
        blocks["occupation"] = raw_sale["occupancy_status"]
    raw_sale["source_blocks"] = blocks
    previous = raw_sale.get("source_property_features") if isinstance(raw_sale.get("source_property_features"), dict) else {}
    # Les faits déjà déduits par l'extraction générique (claims) sont conservés à côté.
    kept = {key: value for key, value in previous.items() if key not in extracted["source_property_features"]}
    raw_sale["source_property_features"] = {**kept, **extracted["source_property_features"]}
    return raw_sale


def dedupe_licitor_images(images: object) -> list[str]:
    """Une photo Licitor existe en grand et en vignette (``.small.jpg``) : on garde la grande."""
    urls = [str(url) for url in images if isinstance(url, str) and url] if isinstance(images, list) else []
    full = {url for url in urls if ".small." not in url}
    kept = [url for url in urls if ".small." not in url or url.replace(".small.", ".") not in full]
    return list(dict.fromkeys(kept))


def refresh_licitor_raw_sale(raw_sale: dict[str, Any]) -> bool:
    """Rejoue la lecture structurée sur le texte stocké d'une vente ``licitor`` (sans réseau)."""
    if str(raw_sale.get("source_name") or "") != "licitor":
        return False
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    page_text = blocks.get("page_text")
    if not isinstance(page_text, str) or not page_text.strip():
        return False
    if isinstance(raw_sale.get("source_images"), list):
        raw_sale["source_images"] = dedupe_licitor_images(raw_sale["source_images"])
        image = raw_sale.get("raw_image_url")
        if isinstance(image, str) and ".small." in image and image.replace(".small.", ".") in raw_sale["source_images"]:
            raw_sale["raw_image_url"] = image.replace(".small.", ".")
    extracted = extract_licitor_fields(page_text, raw_sale)
    if extracted is None:
        return False
    apply_licitor_fields(raw_sale, extracted)
    return True


__all__ = [
    "DISPLAY_SCHEMA_VERSION",
    "FEATURES_SCHEMA_VERSION",
    "apply_licitor_fields",
    "dedupe_licitor_images",
    "extract_licitor_fields",
    "parse_licitor_page",
    "refresh_licitor_raw_sale",
]
