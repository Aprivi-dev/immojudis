"""Lecture structurée d'une fiche « Petites Affiches » à partir de son texte.

La fiche d'une vente expose, dans l'ordre du texte rendu : la référence du lot,
la mise à prix, le statut du résultat, des badges (chambres ou pièces,
occupation), le descriptif publié, le bloc « Informations sur la vente »
(date, heure et lieu de l'audience, publication légale, origine de l'annonce,
lieu de consultation du cahier des conditions), les visites, l'adresse du bien,
puis les encadrés « Avocat Poursuivant » et « Lieu de Vente ».

Une fiche réservée aux abonnés ne garde que la référence, la mise à prix,
la commune et l'avocat poursuivant : rien n'est inventé pour les autres champs.
Le site ne publie aucune pièce jointe (le cahier des conditions se consulte au
greffe ou au cabinet de l'avocat) : la fiche le dit et la lecture le conserve.

Point d'entrée unique pour la collecte (texte de la page téléchargée) et pour le
recalcul sur l'existant (``source_blocks.page_text`` stocké), sans requête :
:func:`extract_petites_affiches_fields`.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from src.cadastre_references import designation, parse_cadastral_references, ref_label, references_signature
from src.normalize import clean_text

FEATURES_SCHEMA_VERSION = "petites_affiches_features_v1"
DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"

_WEEKDAYS = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche"
_VISIT_DATE_RE = re.compile(
    rf"^(?:le\s+)?(?:{_WEEKDAYS})\s+\d{{1,2}}(?:er)?\s+[a-zéèêûôîàç]+\s+\d{{4}}"
    r"(?:\s+(?:de|à|a|entre)\s+\d{1,2}\s*[h:]\s*\d{0,2}.*)?$",
    re.I,
)
_VISIT_TIME_RE = re.compile(r"^[àa]\s*(?P<time>\d{1,2}[:h]\d{2})?\s*:?\s*$", re.I)
_RELATIVE_VISIT_RE = re.compile(r"^(?:visite\s+finie|dans\s+\d+\s+jours?|aujourd'hui|demain)$")
_CONDITIONS_NUMBER_RE = re.compile(r"cahier\s+des\s+conditions\s+de\s+vente\s*:\s*(?P<number>[\w/.-]+)", re.I)
_UNKNOWN_JOURNALS = {"journal non renseigne", "inconnu", "non renseigne"}
_BADGE_COUNT_RE = re.compile(r"^(?P<count>\d{1,2})\s+(?P<kind>chambre|piece)\(?s?\)?\s*-?$")
_OCCUPANCY_BADGES = {
    "libre": ("vacant", "Libre"),
    "occupe": ("occupied", "Occupé"),
    "occupee": ("occupied", "Occupé"),
    "occupes": ("occupied", "Occupé"),
    "loue": ("rented", "Loué"),
    "louee": ("rented", "Loué"),
    "squatte": ("squatted", "Squatté"),
    "squattee": ("squatted", "Squatté"),
}
_RESTRICTED_RE = re.compile(r"reservee?\s+(?:uniquement\s+)?aux\s+abonnes|devez\s+etre\s+abonne")
_EMAIL_PLACEHOLDER_RE = re.compile(r"^\[email(?:&#160;|\s)*protected\]$", re.I)
_PHONE_RE = re.compile(r"^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$")
_PRICE_RE = re.compile(r"^\d{1,3}(?:[\s\u00a0\u202f.]\d{3})*(?:,\d{2})?$")
# Le descriptif d'une annonce légale se termine où commence l'identification des parties.
_PARTIES_RE = re.compile(
    r"\b(?:cette\s+vente\s+a\s+lieu\s+[àa]\s+la\s+requ[êe]te|[àa]\s+la\s+requ[êe]te\s+de|"
    r"aux\s+requ[êe]te,?\s+poursuites\s+et\s+diligences|poursuites\s+et\s+diligences\s+de|"
    r"pour\s+qui\s+domicile\s+est\s+[ée]lu)\b",
    re.I,
)
_ANNOUNCEMENT_START_RE = re.compile(r"\bvente\s+aux\s+ench[èe]res\b", re.I)
_LAWYER_HEADER_RE = re.compile(r"\b(?:ma[îi]tre|avocat|selarl|scp|selas)\b", re.I)
_ACCESS_NOTICE_RE = re.compile(r"merci\s+de\s+vous\s+identifier|cliquant\s+ici|^\.$", re.I)
_CADASTRE_RE = re.compile(
    r"\bsection\s+[A-Z]{1,2}\s*(?:n\s*[°º]|nos?\b|num[ée]ros?|parcelles?)?\s*\d{1,4}"
    r"(?:\s*(?:,|et|à|a)\s*(?:n\s*[°º]\s*)?\d{1,4})*",
    re.I,
)
_CONTENANCE_RE = re.compile(
    r"(?:(?P<ha>\d{1,4})\s*ha\s*)?(?P<a>\d{1,2})\s*a\s*(?P<ca>\d{1,2})\s*ca\b",
    re.I,
)
_SPELLED_LAND_RE = re.compile(
    r"\b(?:terrain|contenance)\s+(?:total\s+)?(?:d['’]une\s+superficie\s+)?de\s+"
    r"(?:(?P<ha>\d{1,4})\s*hectares?\s*)?(?:(?P<a>\d{1,3})\s*ares?\b\s*)?(?:(?P<ca>\d{1,2})\s*centiares?)?(?=\W|$)",
)
_PUBLICATION_RE = re.compile(r"publication\s+l[ée]gale\s*:\s*(?P<journal>.+?)\s+du\s+(?P<date>\d{2}/\d{2}/\d{4})", re.I)


def fold(value: object | None) -> str:
    """Texte replié : minuscules, sans accents, apostrophes droites, espaces simples."""
    text = str(value or "").replace("’", "'").replace("\u00a0", " ")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"\s+", " ", text).strip()


def _lines(page_text: str | None) -> list[str]:
    return [line for line in (clean_text(part) for part in str(page_text or "").splitlines()) if line]


def _index(lines: list[str], predicate, start: int = 0, end: int | None = None) -> int | None:
    stop = len(lines) if end is None else min(end, len(lines))
    for position in range(max(0, start), stop):
        if predicate(fold(lines[position])):
            return position
    return None


@dataclass
class PetitesAffichesPage:
    """Champs lus dans le texte d'une fiche, sans interprétation métier."""

    reference: str | None = None
    starting_price: str | None = None
    result_status: str | None = None
    restricted: bool = False
    bedrooms_count: int | None = None
    rooms_count: int | None = None
    occupancy_badge: str | None = None
    occupancy_status: str | None = None
    announcement_text: str | None = None
    description: str | None = None
    lawyer_header: str | None = None
    sale_day: str | None = None
    sale_time: str | None = None
    sale_venue: str | None = None
    publication_journal: str | None = None
    publication_date: str | None = None
    listing_origin: str | None = None
    conditions_consultation: str | None = None
    conditions_number: str | None = None
    visits: list[dict[str, str]] = field(default_factory=list)
    visit_contact: str | None = None
    address: str | None = None
    lawyer_name: str | None = None
    lawyer_address: str | None = None
    lawyer_phone: str | None = None
    venue_name: str | None = None
    venue_address: str | None = None
    venue_phone: str | None = None

    @property
    def is_structured(self) -> bool:
        return bool(self.reference is not None or self.starting_price or self.sale_day or self.lawyer_name)


def _price_after(lines: list[str], position: int) -> str | None:
    for line in lines[position + 1 : position + 3]:
        value = clean_text(line.replace("€", ""))
        if value and _PRICE_RE.match(value):
            return value
    return None


def _join_description(lines: list[str]) -> str | None:
    parts = [line for line in lines if not _EMAIL_PLACEHOLDER_RE.match(line)]
    return clean_text(" ".join(parts))


def _split_announcement(text: str | None, title: str | None) -> tuple[str | None, str | None]:
    """(descriptif du bien, en-tête avocat) ; l'identité des parties n'est pas reprise."""
    if not text:
        return None, None
    header = None
    body = text
    start = _ANNOUNCEMENT_START_RE.search(text)
    if start and start.start() > 0 and _LAWYER_HEADER_RE.search(text[: start.start()]):
        header = clean_text(text[: start.start()])
        body = text[start.start() :]
    parties = _PARTIES_RE.search(body)
    if parties and parties.start() > 40:
        body = body[: parties.start()]
    body = clean_text(body.strip(" -–;,"))
    if body and title:
        # Les annonces reprises de Vench commencent par la surface ou la distribution
        # (« de 60,57 m² … », « Au 1er ét. : séjour… ») : le titre publié donne la nature du bien.
        title_words = fold(title).split()[:3]
        if re.match(r"^(?:de\s|d['’]|comprenant\b|sis\b|situ[ée])", body, re.I):
            body = f"{title}, {body}"
        elif title_words and " ".join(title_words) not in fold(body):
            body = f"{title} : {body}"
    return body, header


def _visits(lines: list[str]) -> tuple[list[dict[str, str]], str | None]:
    visits: list[dict[str, str]] = []
    contact: list[str] = []
    in_contact = False
    position = 0
    while position < len(lines):
        line = lines[position]
        folded = fold(line)
        if folded.startswith("contact des visites"):
            in_contact = True
            position += 1
            continue
        if in_contact:
            if not line.startswith("[") and folded not in {"adresse :", "adresse"}:
                contact.append(line)
            position += 1
            continue
        if _VISIT_DATE_RE.match(line):
            visit = {"date": line}
            following = lines[position + 1] if position + 1 < len(lines) else ""
            time_match = _VISIT_TIME_RE.match(following)
            if time_match:
                position += 1
                if time_match.group("time"):
                    visit["time"] = time_match.group("time").replace("h", ":")
                location = lines[position + 1] if position + 1 < len(lines) else ""
                location_folded = fold(location)
                if (
                    location
                    and not _VISIT_DATE_RE.match(location)
                    and not _RELATIVE_VISIT_RE.match(location_folded)
                    and not location_folded.startswith(("adresse", "contact des visites", "aucune visite"))
                    and not location.startswith("[")
                ):
                    visit["location"] = location
                    position += 1
            if visit not in visits:
                visits.append(visit)
        position += 1
    return visits, clean_text(" ".join(contact))


def _contact_box(lines: list[str]) -> tuple[str | None, str | None, str | None]:
    name = address = phone = None
    for line in lines:
        compact = re.sub(r"[\s.]", "", line)
        if phone is None and (_PHONE_RE.match(line.strip()) or re.fullmatch(r"(?:\+33|0)[1-9]\d{8}", compact)):
            phone = line.strip()
        elif name is None:
            name = line
        elif address is None:
            address = line
    return name, address, phone


def _address_after(lines: list[str], position: int, end: int) -> str | None:
    inline = re.split(r"adresse\s*:", lines[position], maxsplit=1, flags=re.I)
    value = clean_text(inline[1]) if len(inline) > 1 else None
    if not value and position + 1 < end:
        value = lines[position + 1]
    return clean_text((value or "").strip(" ,")) or None


def parse_petites_affiches_page(page_text: str | None) -> PetitesAffichesPage:
    lines = _lines(page_text)
    page = PetitesAffichesPage()
    if not lines:
        return page
    access_notice = any(_RESTRICTED_RE.search(fold(line)) for line in lines)

    reference_at = _index(lines, lambda text: text.startswith(("lot / ref", "lot/ref")))
    start = reference_at if reference_at is not None else 0
    if reference_at is not None:
        value = re.split(r"r[ée]f\.?\s*:?", lines[reference_at], maxsplit=1, flags=re.I)
        page.reference = (clean_text(value[1]) if len(value) > 1 else None) or ""
    price_at = _index(lines, lambda text: text.startswith("mise a prix"), start)
    cursor = None
    if price_at is not None and price_at - start <= 3:
        inline = re.search(r":\s*([\d\s.,]+?)\s*€?$", lines[price_at])
        if inline and inline.group(1).strip():
            page.starting_price = clean_text(inline.group(1))
            cursor = price_at + 1
        else:
            page.starting_price = _price_after(lines, price_at)
            cursor = price_at + (2 if page.starting_price else 1)
        while cursor < len(lines) and lines[cursor] == "€":
            cursor += 1

    stops = ("informations sur la vente", "le + des petites affiches", "desole mais", "visites", "adresse")
    info_at = _index(lines, lambda text: text.startswith("informations sur la vente"))
    if info_at is not None:
        number = _CONDITIONS_NUMBER_RE.search(lines[info_at])
        page.conditions_number = number.group("number") if number else None
    visits_at = _index(lines, lambda text: text == "visites")
    if cursor is not None:
        bullet = next((position for position in range(cursor, min(cursor + 2, len(lines))) if lines[position] == "•"), None)
        if bullet is not None:
            if bullet + 1 < len(lines):
                page.result_status = lines[bullet + 1]
            cursor = bullet + 2
        zone_end = _index(lines, lambda text: text.startswith(stops), cursor)
        zone = lines[cursor:zone_end] if zone_end is not None else []
        description_lines: list[str] = []
        for line in zone:
            folded = fold(line)
            if _RESTRICTED_RE.search(folded) or _ACCESS_NOTICE_RE.search(line):
                continue
            badge = _BADGE_COUNT_RE.match(folded)
            if badge and not description_lines:
                count = int(badge.group("count"))
                if badge.group("kind") == "chambre":
                    page.bedrooms_count = count
                else:
                    page.rooms_count = count
                continue
            occupancy = _OCCUPANCY_BADGES.get(folded.strip(" .-"))
            if occupancy and not description_lines:
                page.occupancy_status, page.occupancy_badge = occupancy
                continue
            description_lines.append(line)
        page.announcement_text = _join_description(description_lines)
    # Une mention « réservée aux abonnés » peut ne masquer qu'un encadré : la fiche
    # n'est restreinte que si son descriptif est absent.
    page.restricted = access_notice and not page.announcement_text

    if info_at is not None:
        end = visits_at if visits_at is not None and visits_at > info_at else min(len(lines), info_at + 30)
        block = lines[info_at + 1 : end]
        for position, line in enumerate(block):
            folded = fold(line)
            following = block[position + 1] if position + 1 < len(block) else None
            if folded == "vente le" and following:
                page.sale_day = following if re.fullmatch(r"\d{2}/\d{2}/\d{4}", following) else None
                time_line = block[position + 3] if position + 3 < len(block) else ""
                if block[position + 2 : position + 3] == ["à"] and re.fullmatch(r"\d{1,2}:\d{2}", time_line):
                    page.sale_time = time_line
            elif folded.startswith("lieu de vente") and following:
                page.sale_venue = following
            elif folded.startswith("publication legale"):
                match = _PUBLICATION_RE.search(line)
                if match:
                    journal = clean_text(match.group("journal"))
                    page.publication_journal = None if fold(journal) in _UNKNOWN_JOURNALS else journal
                    page.publication_date = match.group("date")
            elif folded == "source :" and following:
                page.listing_origin = following
            elif "qui peut etre consulte" in folded:
                where = clean_text(re.split(r"consult[ée]\s+", line, maxsplit=1, flags=re.I)[-1])
                cabinet = following if following and following != "." else None
                if where and cabinet and fold(where).endswith("ou au cabinet"):
                    where = f"{where} {cabinet}"
                page.conditions_consultation = clean_text((where or "").rstrip(" ."))

    request_at = _index(lines, lambda text: text.startswith("demander plus d'informations"))
    if visits_at is not None:
        end = request_at if request_at is not None and request_at > visits_at else min(len(lines), visits_at + 40)
        address_at = None
        for position in range(end - 1, visits_at, -1):
            if fold(lines[position]).startswith("adresse"):
                address_at = position
                break
        visit_end = address_at if address_at is not None else end
        page.visits, page.visit_contact = _visits(lines[visits_at + 1 : visit_end])
        if address_at is not None:
            page.address = _address_after(lines, address_at, end)
    elif request_at is not None:
        address_at = _index(lines, lambda text: text.startswith("adresse"), max(0, request_at - 3), request_at)
        if address_at is not None:
            page.address = _address_after(lines, address_at, request_at)

    box_stops = ("voir les ventes de", "lieu de vente", "estimer les frais", "acheter ce bien", "avocat poursuivant")
    lawyer_at = _index(lines, lambda text: text == "avocat poursuivant")
    if lawyer_at is not None:
        end = _index(lines, lambda text: text.startswith(box_stops), lawyer_at + 1) or min(len(lines), lawyer_at + 5)
        page.lawyer_name, page.lawyer_address, page.lawyer_phone = _contact_box(lines[lawyer_at + 1 : min(end, lawyer_at + 5)])
    venue_at = _index(lines, lambda text: text == "lieu de vente", (lawyer_at or 0))
    if venue_at is not None:
        end = _index(lines, lambda text: text.startswith(box_stops), venue_at + 1) or min(len(lines), venue_at + 5)
        page.venue_name, page.venue_address, page.venue_phone = _contact_box(lines[venue_at + 1 : min(end, venue_at + 5)])
    return page


def _cadastre(text: str | None, city: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    refs = []
    raws: list[str] = []
    for match in _CADASTRE_RE.finditer(text):
        raws.append(match.group(0))
        for ref in parse_cadastral_references(match.group(0)):
            if ref not in refs:
                refs.append(ref)
    if not refs:
        return None
    return {
        "parcels": [ref_label(ref) for ref in refs],
        "designation": designation(refs, city),
        "raw": " ; ".join(raws)[:300],
        "refs": refs,
    }


def land_surface_from_contenance(text: str | None) -> str | None:
    """Contenance cadastrale totale (« Au total 1ha 97a 42ca », ou somme des parcelles)."""
    if not text:
        return None
    folded = fold(text)
    spelled = next((match for match in _SPELLED_LAND_RE.finditer(folded) if match.group("ha", "a", "ca") != (None,) * 3), None)
    if spelled:
        # « Sur un terrain de 03 ares », « terrain de 00 hectare 04 ares 36 centiares ».
        square_metres = (
            int(spelled.group("ha") or 0) * 10000 + int(spelled.group("a") or 0) * 100 + int(spelled.group("ca") or 0)
        )
        return str(square_metres) if square_metres > 0 else None
    if not re.search(r"\bcontenance\b|\bcadastr|\bterrain\s+de\b", folded):
        return None
    total_at = re.search(r"\bau\s+total\b", folded)
    matches = list(_CONTENANCE_RE.finditer(folded[total_at.end() :] if total_at else folded))
    if not matches:
        return None
    if total_at:
        matches = matches[:1]
    square_metres = sum(
        int(match.group("ha") or 0) * 10000 + int(match.group("a")) * 100 + int(match.group("ca")) for match in matches
    )
    return str(square_metres) if square_metres > 0 else None


def _iso_day(value: str | None) -> str | None:
    match = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", value or "")
    return f"{match.group(3)}-{match.group(2)}-{match.group(1)}" if match else None


def _visit_label(visit: dict[str, str]) -> str:
    text = visit["date"]
    if visit.get("time"):
        text += f" à {visit['time']}"
    if visit.get("location"):
        text += f" — {visit['location']}"
    return text


def _sale_type_label(sale_type: str | None) -> str | None:
    text = fold(sale_type)
    if not text:
        return None
    return {"judiciaire": "Vente judiciaire", "notariale": "Vente notariale", "licitation": "Licitation"}.get(
        text, clean_text(sale_type)
    )


def _items(page: PetitesAffichesPage, *, sale_type: str | None) -> list[dict[str, str]]:
    rows = [
        ("reference_lot", "Référence du lot", page.reference or None, "identification"),
        ("type_vente", "Type de vente", clean_text(sale_type), "identification"),
        ("bedrooms_count", "Chambres", page.bedrooms_count, "batiment"),
        ("rooms_count", "Pièces", page.rooms_count, "batiment"),
        ("occupation", "Occupation", page.occupancy_badge, "situation"),
        ("adresse", "Adresse publiée", page.address, "situation"),
        ("publication_legale", "Publication légale",
         " du ".join(part for part in (page.publication_journal, page.publication_date) if part) or None, "divers"),
        ("origine_annonce", "Annonce reprise de", page.listing_origin, "divers"),
        ("numero_cahier", "Cahier des conditions de vente n°", page.conditions_number, "divers"),
        ("consultation_cahier", "Cahier des conditions consultable", page.conditions_consultation, "divers"),
        ("avocat_poursuivant", "Avocat poursuivant",
         " — ".join(part for part in (page.lawyer_name, page.lawyer_address) if part) or None, "divers"),
        ("lieu_vente", "Lieu de l'audience",
         " — ".join(part for part in (page.venue_name or page.sale_venue, page.venue_address) if part) or None, "divers"),
        ("acces_detail", "Accès au détail",
         "Détail réservé aux abonnés de Petites Affiches" if page.restricted else None, "divers"),
    ]
    return [
        {"key": key, "label": label, "value": str(value), "group": group}
        for key, label, value, group in rows
        if value not in (None, "")
    ]


def extract_petites_affiches_fields(
    page_text: str | None,
    *,
    title: str | None = None,
    city: str | None = None,
    property_type: str | None = None,
    sale_type: str | None = None,
    photo_count: int | None = None,
) -> dict[str, Any] | None:
    """Champs bruts, blocs et caractéristiques d'une fiche ; ``None`` si le texte n'est pas une fiche."""
    page = parse_petites_affiches_page(page_text)
    if not page.is_structured:
        return None
    description, lawyer_header = _split_announcement(page.announcement_text, title)
    page.description, page.lawyer_header = description, lawyer_header
    cadastre = _cadastre(description, city)
    land_surface = land_surface_from_contenance(description)
    sale_date = page.sale_day and (f"{page.sale_day} {page.sale_time}" if page.sale_time else page.sale_day)
    visit_labels = [_visit_label(visit) for visit in page.visits]
    tribunal = page.sale_venue or page.venue_name
    fields: dict[str, Any] = {
        "description": description,
        "starting_price_eur": page.starting_price,
        "sale_date": sale_date,
        "bedrooms_count": page.bedrooms_count,
        "rooms_count": page.rooms_count,
        "occupancy_status": page.occupancy_status,
        "visit_dates": visit_labels,
        "tribunal": tribunal,
        "lawyer_name": page.lawyer_name,
        "lawyer_contact": page.lawyer_phone,
        "address": page.address if page.address and re.search(r"\d|,", page.address) else None,
        "land_surface_m2": land_surface,
    }
    procedure: dict[str, Any] = {}
    if _sale_type_label(sale_type):
        procedure["method_label"] = _sale_type_label(sale_type)
    if page.sale_day:
        iso_day = _iso_day(page.sale_day)
        procedure["deadline"] = {
            "at": f"{iso_day}T{page.sale_time}:00" if iso_day and page.sale_time else iso_day,
            "kind": "adjudication",
        }
    if page.starting_price:
        try:
            amount = Decimal(re.sub(r"[^\d,]", "", page.starting_price).replace(",", "."))
            procedure["prices"] = {"starting_price_eur": float(amount)}
        except ArithmeticError:
            pass
    if visit_labels:
        procedure["visits"] = visit_labels
    surfaces = {"land_surface_m2": land_surface} if land_surface else {}
    display = {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": "petites_affiches",
        "nature": [{"label": property_type, "display": property_type}] if property_type else [],
        "category": None,
        "items": _items(page, sale_type=sale_type),
        "surfaces": surfaces,
        "media": {"photos": photo_count} if photo_count else {},
        # Le site ne publie aucune pièce jointe : la liste reste vide plutôt qu'inventée.
        "attachments": [],
        "procedure": procedure,
        "dates": {"published_on": _iso_day(page.publication_date)} if _iso_day(page.publication_date) else {},
        **({"location": {"designation": cadastre["designation"]}} if cadastre and cadastre.get("designation") else {}),
    }
    blocks = {
        "reference_lot": page.reference or None,
        "statut_resultat": page.result_status,
        "acces_detail": "abonnes" if page.restricted else "public",
        "descriptif_complet": description,
        "entete_avocat": lawyer_header,
        "occupation_badge": page.occupancy_badge,
        "badge_chambres": page.bedrooms_count,
        "badge_pieces": page.rooms_count,
        "heure_vente": page.sale_time,
        "lieu_vente": page.sale_venue,
        "publication_legale_journal": page.publication_journal,
        "publication_legale_date": page.publication_date,
        "origine_annonce": page.listing_origin,
        "consultation_cahier_conditions": page.conditions_consultation,
        "numero_cahier_conditions": page.conditions_number,
        "visites": " | ".join(visit_labels) or None,
        "contact_visites": page.visit_contact,
        "avocat_poursuivant_adresse": page.lawyer_address,
        "lieu_vente_adresse": page.venue_address,
        "designation_cadastrale": cadastre.get("designation") if cadastre else None,
        "pieces_jointes": "Aucune pièce jointe publiée sur la fiche",
        "caracteristiques_bien": display,
    }
    features = {
        "schema_version": FEATURES_SCHEMA_VERSION,
        "listing": {
            "reference": page.reference or None,
            "result_status": page.result_status,
            "access": "subscribers_only" if page.restricted else "public",
            "sale_type": clean_text(sale_type),
            "origin": page.listing_origin,
        },
        "characteristics": {
            "bedrooms_count": page.bedrooms_count,
            "rooms_count": page.rooms_count,
            "occupancy_badge": page.occupancy_badge,
        },
        "sale": {
            "date": page.sale_day,
            "time": page.sale_time,
            "venue": page.sale_venue or page.venue_name,
            "venue_address": page.venue_address,
            "venue_phone": page.venue_phone,
        },
        "publication": {"journal": page.publication_journal, "date": page.publication_date},
        "conditions": {
            "consultation": page.conditions_consultation,
            "number": page.conditions_number,
            "attachments_published": False,
        },
        "lawyer": {"name": page.lawyer_name, "address": page.lawyer_address, "phone": page.lawyer_phone},
        "visits": page.visits,
        "visit_contact": page.visit_contact,
        "surface": surfaces,
        **({"cadastre_references": {key: cadastre[key] for key in ("parcels", "designation")}} if cadastre else {}),
        "media": {"photo_count": photo_count or 0},
    }
    location = None
    if cadastre and not (fields["address"] and re.match(r"^\s*\d{1,4}(?!\d)", fields["address"])):
        # Sans numéro de voie, les parcelles citées localisent mieux le bien que la commune.
        location = {
            "insee_code": None,
            "candidates": [{"source_label": "Descriptif", "raw": cadastre["raw"], "parcels": cadastre["parcels"]}],
            "designation": cadastre["designation"],
            "published_surface_m2": land_surface,
            "signature": references_signature(None, cadastre["refs"]),
        }
    return {
        "page": page,
        "fields": fields,
        "source_blocks": {key: value for key, value in blocks.items() if value not in (None, "", [], {})},
        "source_property_features": _prune(features),
        "cadastre_location": location,
    }


def _prune(value: Any) -> Any:
    if isinstance(value, dict):
        pruned = {key: _prune(item) for key, item in value.items()}
        return {key: item for key, item in pruned.items() if item not in (None, "", [], {})}
    if isinstance(value, list):
        return [_prune(item) for item in value]
    return value
