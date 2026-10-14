"""Champs d'une fiche Vench lus dans son HTML.

La fiche publique publie, que la vente soit en accès libre ou réservée aux
abonnés : la procédure (« Ventes aux enchères publiques sur Licitation »), le
lieu de l'audience, la nature du bien, les équipements signalés, la mise à prix,
la consignation, la faculté de baisse de prix, le journal d'annonces légales et
la date de publication. En accès libre s'y ajoutent l'adresse complète, les
dates de visite, la description, l'occupation, les pièces jointes, le numéro RG,
les coordonnées de la carte et les avocats (poursuivant, postulant) ou le
notaire. Réservé aux abonnés : description, avocat et pièces ; jamais contourné.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from bs4 import BeautifulSoup, Tag

from src.normalize import clean_text
from src.sources.listing_characteristics import (
    characteristics_block,
    euro_amount,
    features_tree,
    fold,
    item,
    merge_features_tree,
)
from src.sources.professional_contact import clear_email, keep_professional

FEATURES_SCHEMA_VERSION = "vench_features_v1"
_OCCUPANCY = {"bien occupe": "occupied", "bien libre": "vacant", "bien loue": "rented"}
_TITLED_PERSON = re.compile(r"Ma[iî]tre\b|Me\b")
_PERSON_LINE = re.compile(r"Ma[iî]tre\b|Me\b|Avocat\s+\S")
_PAYWALL = re.compile(r"vous devez [êe]tre abonn|pour consulter l.int[ée]gralit|s.abonner pour consulter", re.I)


def _text(node: Tag | None, separator: str = " ") -> str | None:
    return clean_text(node.get_text(separator, strip=True)) if node is not None else None


def _heading_value(soup: BeautifulSoup, label: str) -> Tag | None:
    """Élément qui suit un intitulé ``<p class="h4">`` (« Occupation », « Consignation : »…)."""
    for heading in soup.select("p.h4"):
        if fold(heading.get_text(" ", strip=True)).rstrip(" :") == label:
            sibling = heading.find_next_sibling()
            return sibling if isinstance(sibling, Tag) else None
    return None


def _iso_date(value: str | None) -> str | None:
    match = re.search(r"\b(\d{2})/(\d{2})/(\d{4})\b", value or "")
    if not match:
        return None
    try:
        return datetime(int(match.group(3)), int(match.group(2)), int(match.group(1))).date().isoformat()
    except ValueError:
        return None


def is_paywalled(soup: BeautifulSoup) -> bool:
    """Description ou avocat réservés aux abonnés (la mention PLU/carte parcellaire ne compte pas)."""
    description = soup.select_one(".descriptionContener")
    lawyer = soup.select_one("#left-info .enquiry")
    if description is None and lawyer is None:
        # Page sans la structure d'une fiche : la mention d'abonnement de la page fait foi.
        return bool(re.search(r"r[ée]serv[ée]e?\s+aux\s+abonn[ée]s|" + _PAYWALL.pattern, soup.get_text(" ", strip=True), re.I))
    return bool(
        (description is not None and _PAYWALL.search(description.get_text(" ", strip=True)))
        or (lawyer is not None and _PAYWALL.search(lawyer.get_text(" ", strip=True)))
    )


def _procedure(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    heading = _text(soup.select_one(".up-content h2"))
    if not heading:
        return None, None
    method, _, venue = heading.partition(" - ")
    method = clean_text(method)
    detail = re.search(r"\bsur\s+(.+)$", method or "", re.I)
    return method, clean_text(detail.group(1)) if detail else None


def _street_address(soup: BeautifulSoup) -> str | None:
    """Adresse complète du bloc « Adresse » (rue, code postal, commune)."""
    node = _heading_value(soup, "adresse")
    if node is None:
        return None
    lines = [line for line in (clean_text(part) for part in node.get_text("\n", strip=True).splitlines()) if line]
    if len(lines) < 2:
        return None
    joined = clean_text(" ".join(lines))
    if not joined or not re.search(r"\b\d{5}\b", joined):
        return None
    street = joined.split(re.search(r"\b\d{5}\b", joined).group(0))[0].strip(" ,")
    return joined if street and re.search(r"[A-Za-zÀ-ÿ]{3,}", street) else None


def _contact_blocks(soup: BeautifulSoup) -> dict[str, dict[str, str]]:
    """Avocat poursuivant, avocat postulant, notaire et journal publicateur du panneau latéral."""
    contacts: dict[str, dict[str, str]] = {}
    for enquiry in soup.select("#left-info .enquiry"):
        title = fold(_text(enquiry.select_one(".head-side-bar")))
        if not title or title.startswith("statistiques"):
            continue
        role = {
            "avocat poursuivant": "lawyer",
            "avocat postulant": "co_lawyer",
            "notaire": "notary",
            "journal publicateur": "journal",
        }.get(title)
        if role is None or _PAYWALL.search(enquiry.get_text(" ", strip=True)):
            continue
        entry: dict[str, str] = {}
        main = enquiry.select_one(".contact-form p")
        names = [line for line in (clean_text(part) for part in main.get_text("\n", strip=True).splitlines()) if line] if main else []
        if role == "journal":
            published = re.search(r"Vente publiée par (.+?) le (\d{2}/\d{2}/\d{4})", " ".join(names))
            if published:
                entry["name"] = clean_text(published.group(1).rstrip(" -")) or ""
                entry["published_on"] = _iso_date(published.group(2)) or ""
            if len(names) > 1:
                entry["address"] = names[-1]
        else:
            # Le cabinet puis l'avocat, en « Maître Prénom NOM Avocat » ou en « Avocat Prénom NOM ».
            firm = next((name for name in names if not _PERSON_LINE.match(name)), None)
            person = next((name for name in names if _PERSON_LINE.match(name)), None)
            # Garde-fou : un libellé que le filtre de données personnelles réécrit nomme une personne physique.
            firm = keep_professional(firm)
            person = keep_professional(person)
            if firm:
                entry["firm"] = firm
            if person:
                if not _TITLED_PERSON.match(person):
                    person = re.sub(r"^Avocat\s+", "", person)  # « Avocat Prénom NOM » : le titre n'est pas le nom
                entry["person"] = clean_text(re.sub(r"\s+Avocat$", "", person)) or person
            coords = enquiry.select_one(".displayAPcoords")
            if coords is not None:
                coord_text = coords.get_text("\n", strip=True)
                coord_lines = [line for line in (clean_text(part) for part in coord_text.splitlines()) if line]
                phone = re.search(r"(?:\+33\s?|0)[1-9](?:[\s.]?\d{2}){4}", coord_text)
                site = coords.select_one("a[href^='http']")
                # Seule une adresse publiée en clair est lue (« mailto: » ou texte) ; celle que Cloudflare masque
                # (« [email protected] », ``data-cfemail``) n'est pas décodée.
                mailto = coords.select_one("a[href^='mailto:']")
                email = clear_email(str(mailto.get("href"))[len("mailto:"):]) if mailto is not None else None
                email = email or clear_email(coord_text)
                address = [
                    line for line in coord_lines
                    if not re.search(r"(?:\+33|0)[1-9](?:[\s.]?\d{2}){4}|https?://|\[email.{0,8}protected\]", line, re.I)
                    and not clear_email(line)
                ]
                if phone:
                    entry["phone"] = clean_text(phone.group(0)) or ""
                if email:
                    entry["email"] = email
                if site is not None:
                    entry["website"] = str(site.get("href")).strip()
                if address:
                    entry["address"] = " ".join(address)
        entry = {key: value for key, value in entry.items() if value}
        if entry:
            contacts[role] = entry
    return contacts


def _coordinates(html: str) -> tuple[str | None, str | None]:
    lat = re.search(r"var\s+lat\s*=\s*(-?\d{1,2}\.\d+)\s*;", html)
    lon = re.search(r"var\s+lon\s*=\s*(-?\d{1,3}\.\d+)\s*;", html)
    if not lat or not lon or (float(lat.group(1)), float(lon.group(1))) == (0.0, 0.0):
        return None, None
    return lat.group(1), lon.group(1)


def lawyer_label(entry: dict[str, str] | None) -> str | None:
    if not entry:
        return None
    firm, person = entry.get("firm"), entry.get("person")
    if firm and person:
        return f"{firm} ({person})"
    return firm or person


def extract_vench_detail(
    soup: BeautifulSoup,
    html: str,
    *,
    source_url: str,
    external_id: str | None,
    documents: list[dict[str, str]],
    photos: int,
    amenities: list[str],
    surfaces: dict[str, str | None],
) -> dict[str, Any]:
    """Champs bruts, blocs et arbre de faits d'une fiche Vench (accès libre ou abonnés)."""
    method, framework = _procedure(soup)
    nature = _text(soup.select_one(".descriptionContener p.h4"))
    nature = clean_text(re.split(r"\s*[•·]\s*", nature)[0]) if nature else None
    occupancy_text = _text(_heading_value(soup, "occupation"))
    occupancy = _OCCUPANCY.get(fold(occupancy_text)) if occupancy_text else None
    deposit_text = _text(_heading_value(soup, "consignation"))
    deposit_text = clean_text(re.sub(r"\*?\s*facult[ée] de baisse de prix.*$", "", deposit_text or "", flags=re.I)) or None
    more_info = _text(_heading_value(soup, "pour plus d'informations"))
    rg = re.search(r"\bRG\s*:?\s*(\d{2}/\d{3,6})", more_info or "")
    # Seul l'intitulé affiché compte : le script de la page contient la même phrase sur toutes les fiches.
    price_drop = any(
        re.search(r"facult[ée] de baisse de prix", heading.get_text(" ", strip=True), re.I)
        for heading in soup.select(".infosRG p.h4, .infosRG p")
    )
    # Le texte du créneau est dans ``<strong>`` ; le reste du bloc est un bouton « Enregistrer ».
    visits = [
        value
        for value in (_text(node.select_one("strong") or node) for node in soup.select(".visitesContener .visite"))
        if value
    ]
    contacts = _contact_blocks(soup)
    publication = re.search(r"Publication\s*:\s*(\d{2}/\d{2}/\d{4})", _text(soup.select_one(".statsVente")) or "")
    latitude, longitude = _coordinates(html)
    street_address = _street_address(soup)
    venue = _text(soup.select_one(".up-content h2 strong"))
    lawyer = contacts.get("lawyer")
    notary = contacts.get("notary")
    journal = contacts.get("journal")
    published_on = _iso_date(publication.group(1)) if publication else None

    fields: dict[str, Any] = {
        "occupancy_status": occupancy,
        "visit_dates": visits,
        "lawyer_name": lawyer_label(lawyer) or lawyer_label(notary),
        "lawyer_contact": " · ".join(
            part for part in (
                (lawyer or notary or {}).get("phone"),
                (lawyer or notary or {}).get("email"),
                (lawyer or notary or {}).get("website"),
            ) if part
        ) or None,
        "latitude": latitude,
        "longitude": longitude,
        "street_address": street_address,
        "notarial_venue": bool(venue and re.search(r"\bnotaire\b", venue, re.I)) or None,
    }
    items = [
        item("reference", "Référence Vench", external_id, "identification"),
        item("nature", "Nature du bien", nature, "identification"),
        item("occupancy", "Occupation", occupancy_text, "situation"),
        item("amenities", "Équipements signalés", ", ".join(amenities) if amenities else None, "equipements"),
        item("rg_number", "Numéro RG", rg.group(1) if rg else None, "divers"),
        item("venue", "Lieu de l'audience", venue, "divers"),
        item("lawyer", "Avocat poursuivant", lawyer_label(lawyer), "divers"),
        item("co_lawyer", "Avocat postulant", lawyer_label(contacts.get("co_lawyer")), "divers"),
        item("notary", "Notaire", lawyer_label(notary), "divers"),
        item("journal", "Journal d'annonces légales", (journal or {}).get("name"), "divers"),
    ]
    notes = [
        {"label": "Consignation", "value": deposit_text} if deposit_text else None,
        {"label": "Faculté de baisse de prix", "value": "Oui"} if price_drop else None,
        {"label": "Renseignements", "value": more_info} if more_info else None,
    ]
    procedure = {
        "method_label": method,
        "legal_framework": framework,
        "prices": {"deposit_eur": euro_amount(deposit_text)} if euro_amount(deposit_text) else {},
        "notes": [note for note in notes if note],
        "visits": visits,
    }
    block = characteristics_block(
        "vench",
        items=items,
        nature=[nature] if nature else None,
        surfaces=surfaces,
        photos=photos,
        documents=documents,
        procedure=procedure,
        dates={"published_on": published_on},
    )
    tree = features_tree(
        FEATURES_SCHEMA_VERSION,
        characteristics={
            "nature": nature,
            "occupancy": occupancy_text,
            "amenities": amenities,
            "rg_number": rg.group(1) if rg else None,
            "price_drop_option": price_drop or None,
            **{key: value for key, value in surfaces.items() if value},
        },
        characteristics_raw=items,
        procedure={**procedure, "deposit_text": deposit_text, "venue": venue},
        lawyer={"lawyer": lawyer, "co_lawyer": contacts.get("co_lawyer"), "notary": notary},
        media={"photo_count": photos},
        documents=documents,
        extra={
            "listing": {"reference": external_id, "published_on": published_on, "journal": journal,
                        "access": "subscribers_only" if is_paywalled(soup) else "public"},
            "coordinates": {"latitude": latitude, "longitude": longitude} if latitude else None,
        },
    )
    blocks = {
        "caracteristiques_bien": block,
        "procedure_vente": method,
        "occupation": occupancy_text,
        "consignation": deposit_text,
        "numero_rg": rg.group(1) if rg else None,
        "renseignements": more_info,
        "avocat": lawyer_label(lawyer) or lawyer_label(notary),
        "contact_avocat": fields["lawyer_contact"],
        "journal_publicateur": (journal or {}).get("name"),
        "date_publication": published_on,
        "adresse_complete": street_address,
    }
    return {
        "fields": {key: value for key, value in fields.items() if value not in (None, "", [], {})},
        "source_blocks": {key: value for key, value in blocks.items() if value not in (None, "", [], {})},
        "source_property_features": tree,
    }


def apply_vench_features(sale: dict[str, Any], tree: dict[str, Any]) -> None:
    sale["source_property_features"] = merge_features_tree(sale.get("source_property_features"), tree)
