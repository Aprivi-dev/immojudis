"""Lecture du texte d'une fiche détail « Cessions immobilières de l'État ».

Le texte est celui que conserve la pipeline (``source_blocks.page_text``) : une
ligne par nœud de texte de la page, dans l'ordre du document. La même lecture
sert à la collecte (texte de la page téléchargée) et au rejeu sur l'existant,
sans nouvelle requête au site. Fonctions pures : aucun accès réseau, aucune
journalisation de contenu (la fiche contient des noms et coordonnées).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from src.sources.cessions_etat_labels import (
    ENERGY_PATTERNS,
    SECTION_HEADINGS,
    attachment_kind,
    fold,
    lookup_field,
    lookup_nature,
)

_LOCATION_RE = re.compile(r"^(?P<city>.+?)\s+-\s+(?P<dep>2[AB]|\d{2,3})$")
_SURFACE_HEADLINE_RE = re.compile(r"^(\d{1,3}(?:[  .]\d{3})*|\d+)(?:[,.]\d+)?\s*m(?:²|2)$")
_PHONE_RE = re.compile(r"^\+?[\d .()/-]{9,}$")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_SIZE_RE = re.compile(r"^(?P<format>[A-Z0-9]{2,5})\s*[–-]\s*(?P<size>[\d.,]+\s*(?:o|Ko|Mo|Go))$", re.I)
_COUNTDOWN_RE = re.compile(r"^Fini(?:t)?\s+(?:dans\s+(?P<days>\d{1,4})\s+jours?|(?P<today>aujourd['’]hui)|(?P<tomorrow>demain))$", re.I)
_GALLERY_RE = re.compile(r"^(Photos|Plans|Vidéos|Mise en scène|Visite Virtuelle)\s*\((\d+)\)$", re.I)
_DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
_GALLERY_KEYS = {
    "photos": "photos",
    "plans": "plans",
    "videos": "videos",
    "mise en scene": "staging",
    "visite virtuelle": "virtual_tours",
}
_FUNCTIONAL_MAILBOX_RE = re.compile(
    r"(?:pole|gestion|domain|pgp|service|ddfip|drfip|dgfip|sgami|cession|immobilier|patrimoine|prie|"
    r"france-domaine|bureau|direction|secretariat|contact|accueil)",
    re.I,
)
_GOUV_DOMAIN_RE = re.compile(r"@(?:[a-z0-9-]+\.)*(?:gouv\.fr|finances\.gouv\.fr|interieur\.gouv\.fr)$", re.I)


@dataclass
class Characteristic:
    key: str | None
    label: str
    value: str
    group: str
    kind: str
    nature: str | None = None


@dataclass
class CessionsPage:
    title: str | None = None
    city: str | None = None
    department: str | None = None
    category: str | None = None
    headline_surface: str | None = None
    reference: str | None = None
    badge: str | None = None
    countdown_days: int | None = None
    published_on: date | None = None
    modified_on: date | None = None
    gallery: dict[str, int] = field(default_factory=dict)
    gallery_files: list[str] = field(default_factory=list)
    description: str | None = None
    procedure_lines: list[str] = field(default_factory=list)
    notary_link: bool = False
    characteristics: list[Characteristic] = field(default_factory=list)
    natures: list[str] = field(default_factory=list)
    energy: dict[str, str | None] = field(default_factory=dict)
    attachments: list[dict[str, Any]] = field(default_factory=list)
    managers: list[dict[str, str]] = field(default_factory=list)

    def value(self, key: str) -> str | None:
        for item in self.characteristics:
            if item.key == key and item.value:
                return item.value
        return None

    def values(self, key: str) -> list[str]:
        return [item.value for item in self.characteristics if item.key == key and item.value]

    @property
    def is_structured(self) -> bool:
        return bool(self.characteristics or self.procedure_lines or self.gallery)


def page_lines(text: str | None) -> list[str]:
    return [line for line in (re.sub(r"\s+", " ", part).strip() for part in str(text or "").splitlines()) if line]


def _index(lines: list[str], wanted: str, start: int = 0) -> int | None:
    for index in range(start, len(lines)):
        if lines[index] == wanted:
            return index
    return None


def _index_folded(lines: list[str], wanted: str, start: int = 0, stop: int | None = None) -> int | None:
    target = fold(wanted)
    for index in range(start, len(lines) if stop is None else min(stop, len(lines))):
        if fold(lines[index]) == target:
            return index
    return None


def _french_date(value: str | None) -> date | None:
    match = _DATE_RE.match(value or "")
    if not match:
        return None
    try:
        return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
    except ValueError:
        return None


def parse_cessions_page(text: str | None) -> CessionsPage:
    """Découpe le texte d'une fiche en blocs structurés (sans rien inventer)."""
    lines = page_lines(text)
    page = CessionsPage()
    if not lines:
        return page
    head = re.split(r"\s+\|\s+cessions\.immobilier-etat\.gouv\.fr", lines[0], maxsplit=1)
    if len(head) == 2 and head[0]:
        page.title = head[0].strip()
    start = _index(lines, "Ajouter aux favoris")
    published = _index(lines, "Publié le :")
    if start is not None:
        _parse_identity(lines, start, published, page)
    if published is not None:
        _parse_dates_and_gallery(lines, published, page)
    _parse_sections(lines, page)
    return page


def _parse_identity(lines: list[str], start: int, published: int | None, page: CessionsPage) -> None:
    cursor = start + 1
    if cursor < len(lines):
        badge = lines[cursor]
        countdown = _COUNTDOWN_RE.match(badge)
        if countdown:
            page.badge = "countdown"
            page.countdown_days = (
                int(countdown.group("days")) if countdown.group("days") else 0 if countdown.group("today") else 1
            )
            cursor += 1
        elif fold(badge) in {"expire", "expiree"}:
            page.badge = "expired"
            cursor += 1
        elif fold(badge) == "vendu":
            page.badge = "sold"
            cursor += 1
    reference_at = _index(lines, "Référence :", cursor)
    if reference_at is not None and reference_at <= cursor + 3:
        if reference_at - cursor >= 2:
            page.city = page.city or lines[cursor]
            page.title = lines[reference_at - 1] or page.title
        elif reference_at - cursor == 1:
            page.title = page.title or lines[cursor]
        if reference_at + 1 < len(lines):
            page.reference = lines[reference_at + 1]
    if published is None:
        return
    # Bloc de localisation lu à rebours depuis « Publié le » : [Commune - dép.] Catégorie [surface].
    back = published - 1
    if back >= 0 and _SURFACE_HEADLINE_RE.match(lines[back]):
        page.headline_surface = lines[back]
        back -= 1
    category_index: int | None = None
    # La catégorie peut contenir « / » et tenir sur une seule ligne (« Bureaux / Commerces »).
    if back >= 0 and not _EMAIL_RE.search(lines[back]) and not _PHONE_RE.match(lines[back]):
        page.category = lines[back]
        category_index = back
        back -= 1
    if back >= 0:
        location = _LOCATION_RE.match(lines[back])
        if location and not _EMAIL_RE.search(lines[back]):
            page.city = location.group("city").strip()
            page.department = location.group("dep").zfill(2)
            category_index = back
    managers_start = next(
        (index for index in range((reference_at or start) + 1, published) if fold(lines[index]).startswith("gestionnaire")),
        None,
    )
    if managers_start is not None and category_index is not None:
        page.managers = _parse_managers(lines[managers_start + 1 : category_index])


def _parse_managers(lines: list[str]) -> list[dict[str, str]]:
    """Contacts du bloc « Gestionnaire(s) de l'annonce » (après le second « Contacter »)."""
    contacter = [index for index, line in enumerate(lines) if line == "Contacter"]
    detail = lines[contacter[-1] + 1 :] if contacter else lines
    contacts: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in detail:
        if line in {"Fermer", "Contacter"}:
            continue
        email = _EMAIL_RE.search(line)
        if email:
            current.setdefault("email", email.group(0).lower())
            continue
        if _PHONE_RE.match(line) and sum(char.isdigit() for char in line) >= 9:
            current.setdefault("phone", line)
            continue
        if "name" not in current:
            current["name"] = line
        elif "function" not in current and not {"email", "phone"} & set(current):
            current["function"] = line
        else:
            contacts.append(current)
            current = {"name": line}
    if current:
        contacts.append(current)
    return [contact for contact in contacts if contact.get("name") or contact.get("email")]


_STREET_ABBREVIATIONS = {
    "R": "Rue", "RUE": "Rue", "AV": "Avenue", "AVE": "Avenue", "BD": "Boulevard", "BLD": "Boulevard",
    "CHE": "Chemin", "CHEM": "Chemin", "CR": "Chemin rural", "VC": "Voie communale", "RTE": "Route",
    "PL": "Place", "IMP": "Impasse", "ALL": "Allée", "QU": "Quai", "QUAI": "Quai", "CRS": "Cours",
    "SQ": "Square", "PAS": "Passage", "FG": "Faubourg", "LOT": "Lotissement", "RES": "Résidence",
    "HAM": "Hameau", "SEN": "Sentier", "PRO": "Promenade", "ESP": "Esplanade", "TRA": "Traverse",
    "MTE": "Montée", "CTRE": "Centre", "ZA": "ZA", "ZI": "ZI", "ZAC": "ZAC",
}
_PARTICLES = {"de", "du", "des", "la", "le", "les", "d", "l", "et", "en", "sur", "sous", "aux", "au"}


def _title_words(text: str, *, after_street_type: bool = False) -> str:
    words = re.split(r"(\s+|-|')", text.strip().lower())
    result: list[str] = []
    for index, word in enumerate(words):
        if not word or not word.strip() or word in {"-", "'"}:
            result.append(word)
            continue
        keep_lower = (index > 0 or after_street_type) and word in _PARTICLES
        result.append(word if keep_lower else word[:1].upper() + word[1:])
    return "".join(result)


def parse_map_popup(text: str | None) -> dict[str, str] | None:
    """Adresse de la carte de la fiche (« 66 R LAFAURIE DE MONBADON, Bordeaux, 33063 »).

    La fiche détail porte, dans l'attribut ``data-popup-text`` de sa carte, la
    désignation du bien au fichier immobilier de l'État : voie (ou « (rue non
    renseignée) »), lieu-dit éventuel, commune et code INSEE. Le texte stocké
    (``page_text``) ne la contient pas : elle n'est lue qu'à la collecte.
    """
    parts = [part.strip() for part in str(text or "").split(",") if part.strip()]
    if len(parts) < 2:
        return None
    insee = parts.pop().upper() if re.fullmatch(r"\d[\dAB]\d{3}", parts[-1], re.I) else None
    city = _title_words(parts.pop()) if parts else None
    street = None
    locality = None
    for part in parts:
        if re.fullmatch(r"\(?\s*rue\s+non\s+renseign[ée]e\s*\)?", part, re.I):
            continue
        tokens = part.split()
        number = tokens[0] if tokens and re.fullmatch(r"\d{1,4}(?:\s?(?:bis|ter|quater|[A-D]))?", tokens[0], re.I) else None
        rest = tokens[1:] if number else tokens
        kind = _STREET_ABBREVIATIONS.get(rest[0].upper()) if rest else None
        if street is None and (number or kind):
            name = _title_words(" ".join(rest[1:] if kind else rest), after_street_type=bool(kind))
            street = " ".join(item for item in (number, kind, name) if item)
        elif locality is None:
            locality = _title_words(part)
    address = ", ".join(item for item in (street, locality, city) if item) if street or locality else None
    found = {key: value for key, value in {"address": address, "insee_code": insee, "city": city}.items() if value}
    return found if found.get("address") or found.get("insee_code") else None


def direction_email(managers: list[dict[str, str]]) -> str | None:
    """Adresse fonctionnelle à privilégier pour une demande d'information.

    Une boîte de service (pôle de gestion domaniale, PRIE, DDFiP…) est stable et
    ne désigne pas une personne ; à défaut, la première adresse publiée.
    """
    emails = [contact["email"] for contact in managers if contact.get("email")]
    for email in emails:
        local = email.split("@", 1)[0]
        if _FUNCTIONAL_MAILBOX_RE.search(local) and _GOUV_DOMAIN_RE.search(email):
            return email
    for email in emails:
        if _FUNCTIONAL_MAILBOX_RE.search(email.split("@", 1)[0]):
            return email
    return emails[0] if emails else None


def _parse_dates_and_gallery(lines: list[str], published: int, page: CessionsPage) -> None:
    if published + 1 < len(lines):
        page.published_on = _french_date(lines[published + 1])
    modified = _index(lines, "Modifié le :", published)
    if modified is not None and modified <= published + 4 and modified + 1 < len(lines):
        page.modified_on = _french_date(lines[modified + 1])
    gallery = _index(lines, "Galerie", published)
    if gallery is None or gallery > published + 8:
        return
    index = gallery + 1
    while index < len(lines):
        match = _GALLERY_RE.match(lines[index])
        if not match:
            break
        key = _GALLERY_KEYS.get(fold(match.group(1)))
        if key:
            page.gallery[key] = int(match.group(2))
        index += 1
    end = _index(lines, "LE BIEN", index)
    for line in lines[index : end if end is not None else index]:
        if line in {"Voir toutes les photos", "Fermer", "Photos", "[LIGHTBOX]"} or line.startswith("Aucun"):
            continue
        if line not in page.gallery_files:
            page.gallery_files.append(line)


def _parse_sections(lines: list[str], page: CessionsPage) -> None:
    description_at = _index(lines, "Descriptif du bien")
    procedure_at = _index(lines, "Procédure de vente", description_at or 0)
    details_at = _index(lines, "Caractéristiques détaillées du bien", procedure_at or description_at or 0)
    attachments_at = _index(lines, "Pièces jointes", details_at or 0) if details_at is not None else None
    map_at = next(
        (index for index, line in enumerate(lines) if line.startswith("Carte de l’environnement") or line.startswith("Carte de l'environnement")),
        None,
    )
    if description_at is not None:
        stop = procedure_at or details_at or map_at or len(lines)
        description = "\n".join(lines[description_at + 1 : stop])
        # Certaines fiches publient leur descriptif avec des balises HTML échappées (« <p> … </P> »).
        description = re.sub(r"</?(?:p|br|div|span|strong|em|b|i|u)\b[^>]*>", " ", description, flags=re.I)
        description = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in description.splitlines())
        page.description = description.strip() or None
    if procedure_at is not None:
        stop = details_at or map_at or len(lines)
        procedure = lines[procedure_at + 1 : stop]
        page.notary_link = any(fold(line).startswith("acceder au site") for line in procedure)
        page.procedure_lines = [line for line in procedure if not fold(line).startswith("acceder au site")]
    if details_at is not None:
        stop = attachments_at or map_at or len(lines)
        _parse_characteristics(lines[details_at + 1 : stop], page)
    if attachments_at is not None:
        _parse_attachments(lines[attachments_at + 1 : map_at or len(lines)], page)


def _is_structural(line: str) -> bool:
    """Libellé connu, intertitre de nature ou de section, ou ligne DPE/GES."""
    return (
        lookup_field(line) is not None
        or lookup_nature(line) is not None
        or fold(line) in SECTION_HEADINGS
        or any(pattern.match(line) for _, pattern in ENERGY_PATTERNS)
    )


def _parse_characteristics(lines: list[str], page: CessionsPage) -> None:
    nature: str | None = None
    current: Characteristic | None = None
    awaiting_value = False
    for index, line in enumerate(lines):
        energy_done = False
        for key, pattern in ENERGY_PATTERNS:
            match = pattern.match(line)
            if match:
                page.energy[key] = match.group(1).upper() if match.group(1) else None
                current, awaiting_value, energy_done = None, False, True
                break
        if energy_done:
            continue
        spec = lookup_field(line)
        if awaiting_value and current is not None and spec is None and lookup_nature(line) is None:
            current.value = line
            awaiting_value = False
            continue
        if spec is not None:
            current = Characteristic(spec.key, spec.label, "", spec.group, spec.kind, nature)
            page.characteristics.append(current)
            awaiting_value = True
            continue
        nature_match = lookup_nature(line)
        if nature_match is not None and not awaiting_value:
            nature = line
            if line not in page.natures:
                page.natures.append(line)
            current = None
            continue
        if fold(line) in SECTION_HEADINGS:
            current, awaiting_value = None, False
            continue
        following = lines[index + 1] if index + 1 < len(lines) else None
        after = lines[index + 2] if index + 2 < len(lines) else None
        new_label = following is not None and not _is_structural(following) and (after is None or _is_structural(after))
        if current is not None and current.value and not awaiting_value and not new_label:
            # Valeur sur plusieurs lignes (texte libre d'une tuile « Divers »).
            current.value = f"{current.value}\n{line}"
            continue
        if nature_match is not None:
            nature = line
            if line not in page.natures:
                page.natures.append(line)
            continue
        # Libellé inconnu du vocabulaire : on le garde tel quel, la ligne suivante est sa valeur.
        current = Characteristic(None, line, "", "divers", "text", nature)
        page.characteristics.append(current)
        awaiting_value = True
    page.characteristics = [item for item in page.characteristics if item.value]


def _parse_attachments(lines: list[str], page: CessionsPage) -> None:
    pending: dict[str, Any] | None = None
    for line in lines:
        size = _SIZE_RE.match(line)
        if size and pending is not None:
            pending["format"] = size.group("format").upper()
            pending["size"] = size.group("size").replace(" ", " ")
            continue
        if size:
            continue
        kind, kind_label = attachment_kind(line)
        pending = {"filename": line, "kind": kind, "kind_label": kind_label, "label": _attachment_label(line, kind_label)}
        page.attachments.append(pending)


def _attachment_label(filename: str, kind_label: str) -> str:
    stem = re.sub(r"\.(?:pdf|zip|docx?|xlsx?|jpe?g|png)$", "", filename, flags=re.I)
    stem = re.sub(r"^\d{1,3}_", "", stem)
    stem = re.sub(r"_\d{6,}$", "", stem)
    readable = re.sub(r"[_]+", " ", stem).strip()
    readable = re.sub(r"\s+-\s+", " – ", readable)
    if not readable or re.fullmatch(r"[\w-]+", readable) and len(readable) > 40:
        return kind_label
    return readable[:1].upper() + readable[1:]
