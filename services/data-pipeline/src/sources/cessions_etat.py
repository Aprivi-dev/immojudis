from __future__ import annotations

import json
import logging
import re
import ssl
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import certifi
from bs4 import BeautifulSoup, Tag

from src.catalogue_proof import CatalogueEvidence, canonical
from src.config import FRENCH_POSTAL_CODE_PATTERN, TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text, normalize_property_type
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import (
    PaginationCoverage,
    PoliteHttpClient,
    ScrapeResult,
    parse_html,
    should_fetch_detail,
    unique_dicts,
)
from src.sources.image_candidates import html_image_candidates

BASE_URL = "https://cessions.immobilier-etat.gouv.fr"
LIST_URL = f"{BASE_URL}/"
LOGGER = logging.getLogger(__name__)
DETAIL_FIELDS = {
    "property_type",
    "description",
    "starting_price_eur",
    "sale_date",
    "sale_date_kind",
    "source_sale_schedule",
    "visit_dates",
    "documents",
    "raw_text",
    "surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
    "parking_count",
    "city",
    "postal_code",
    "dpe_class",
    "ges_class",
    "raw_image_url",
    "source_images",
    "source_blocks",
    "source_property_features",
    "source_evidence",
}
SURFACE_VALUE_PATTERN = r"([0-9]+(?:[ .][0-9]{3})*(?:[,.][0-9]+)?|[0-9]+(?:[,.][0-9]+)?)"


def cessions_tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=certifi.where())
    context.verify_flags &= ~ssl.VERIFY_X509_PARTIAL_CHAIN
    context.load_verify_locations(str(Path(__file__).with_name("certificates") / "sectigo-public-ov-r36.pem"))
    return context


def scrape_cessions_etat_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_cessions_etat_aquitaine_result(max_pages=max_pages).sales


def scrape_cessions_etat_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        tls_context=cessions_tls_context(),
        user_agent=str(settings["browser_user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
        accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        extra_headers={"Upgrade-Insecure-Requests": "1"},
    )
    max_pages = max_pages or int(settings["cessions_etat_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    catalogue = CatalogueEvidence("cessions_etat")
    exclusions: dict[str, str] = {}
    pagination = PaginationCoverage()
    advertised_last_page: int | None = None
    seen_sales: set[str] = set()
    for page_url in _list_urls(max_pages):
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("Cessions Etat list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            break
        page_sales = parse_cessions_etat_html(html, page_url=page_url)
        # The source publishes a last-page link on the listing. Use it as the
        # terminal assertion; reaching a repeated page remains a hard failure.
        proof = catalogue.observe(html, page_url, page_sales)
        if proof["advertised_last_pages"]:
            page_last = max(proof["advertised_last_pages"])
            advertised_last_page = max(advertised_last_page or page_last, page_last)
        page_is_terminal = advertised_last_page is not None and proof["page_index"] >= advertised_last_page
        if not pagination.accept(page_sales, terminal=page_is_terminal):
            break
        for sale in page_sales:
            if sale.get("department") not in TARGET_DEPARTMENTS:
                source_url = sale.get("source_url")
                if source_url:
                    exclusions[canonical(str(source_url))] = "department_filter"
                continue
            url = canonical(str(sale.get("source_url") or ""))
            if url in seen_sales:
                continue
            seen_sales.add(url)
            if should_fetch_detail(sale, known):
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)
        if pagination.exhausted:
            break

    pagination_metrics = pagination.metrics()
    validated_sales = validate_raw_sales("cessions_etat", unique_dicts(raw_sales, "source_url"), errors)
    catalogue_metrics = catalogue.metrics(
        validated_sales,
        errors,
        coverage=pagination_metrics,
        exclusions=exclusions,
        scope={"public": "national", "configured": "target_departments"},
    )
    return ScrapeResult(
        validated_sales,
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
         **pagination_metrics,
         **catalogue_metrics},
    )


def parse_cessions_etat_html(html: str, page_url: str = LIST_URL) -> list[dict[str, Any]]:
    soup = parse_html(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select("div[id^='bien-']"):
        sale = _parse_card(card, page_url)
        if sale:
            sales.append(sale)
    return sales


def parse_cessions_etat_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = parse_html(html, "html.parser")
    title = _detail_title(soup)
    location = soup.select_one(".location-info .location-text")
    city = clean_text(location.get_text(" ", strip=True)) if location else None
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    description = _description(soup)
    detail_tiles = _detail_tile_values(soup)
    detail_sections = _detail_section_labels(soup)
    property_type = _detail_property_type(title, description, detail_sections)
    dpe_class, ges_class = _detail_energy_classes(soup)
    surface = _extract_surface(raw_text)
    carrez_surface = _extract_carrez_surface(raw_text)
    # Keep lot-level measurements and amenities tied to the property's own
    # description.  The page-wide text can contain neighboring listings or
    # site chrome with another surface/parking statement.
    land_surface = _extract_land_surface(description or "")
    if land_surface is None and property_type == "land":
        # Cessions publishes agricultural parcels under the generic label
        # ``Surface en m²``.  The source type makes the measurement's scope
        # explicit even when the description contains no second terrain
        # sentence.
        land_surface = _normalize_surface_number(
            _tile_value(detail_tiles, "Surface en m²") or surface
        )
    parking_count = _extract_parking_count(description)
    postal_code = _extract_postal(raw_text)
    starting_price = _extract_after(
        raw_text,
        r"(?:Prix\s*:?\s*|Prix\s+de\s+vente\s*:\s*|Mise a prix\s*:?\s*|Mise à prix\s*:?\s*)"
        r"([0-9][0-9\s.,]+)\s*(?:€|euros?)",
    )
    property_panel = soup.select_one("#panel-bien")
    date_scope = property_panel.get_text("\n", strip=True) if property_panel else None
    sale_date = _extract_sale_date(date_scope) if date_scope else None
    if not sale_date:
        # A sale date can be outside the property panel. Exclude site chrome so
        # footer dates cannot silently become the date of this sale.
        fallback_scope = parse_html(str(soup.select_one("main") or soup), "html.parser")
        for chrome in fallback_scope.select("header, footer, nav, aside"):
            chrome.decompose()
        date_scope = fallback_scope.get_text("\n", strip=True)
        sale_date = _extract_sale_date(date_scope)
    source_sale_schedule = _extract_sale_schedule(date_scope or raw_text)
    sale_date_kind = _sale_date_kind(date_scope or raw_text, source_sale_schedule)
    visit_dates = _visit_dates(raw_text)
    documents = _documents(soup, source_url)
    source_images = _extract_images(soup, source_url)
    return {
        "source_name": "cessions_etat",
        "source_url": source_url,
        **({"title": title} if title else {}),
        **({"property_type": property_type} if property_type else {}),
        **({"city": city} if city else {}),
        "description": description,
        "surface_m2": surface,
        "carrez_surface_m2": carrez_surface,
        "land_surface_m2": land_surface,
        "parking_count": parking_count,
        "postal_code": postal_code,
        "dpe_class": dpe_class,
        "ges_class": ges_class,
        "starting_price_eur": starting_price,
        "sale_date": sale_date,
        "sale_date_kind": sale_date_kind,
        "source_sale_schedule": source_sale_schedule,
        "visit_dates": visit_dates,
        "documents": documents,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "raw_text": raw_text,
        "source_blocks": {
            key: value
            for key, value in {
                "description": description,
                "titre_detail": title,
                "type_bien_detail": property_type,
                "ville": city,
                "surface": surface,
                "surface_carrez": carrez_surface,
                "surface_terrain": land_surface,
                "parking_count": parking_count,
                "code_postal": postal_code,
                "dpe_classe": dpe_class,
                "ges_classe": ges_class,
                "mise_a_prix": starting_price,
                "date_vente": sale_date,
                "date_vente_type": sale_date_kind,
                "source_sale_schedule": source_sale_schedule,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "type_bien_source": detail_sections[-1] if detail_sections else None,
                "reference_cadastrale": _tile_value(detail_tiles, "Référence cadastrale"),
                "references_cadastrales": _tile_value(detail_tiles, "Références cadastrales"),
                "code_insee": _tile_value(detail_tiles, "Code INSEE"),
                "numero_dossier": _tile_value(detail_tiles, "Numéro de dossier"),
                "zonage_urbanisme": _tile_value(detail_tiles, "Zonage d'urbanisme"),
                "type_vente": _tile_value(detail_tiles, "Type de vente"),
                "annee_premiere_inscription": _tile_value(detail_tiles, "Année première inscription"),
                "plu": _tile_value(detail_tiles, "Informations sur le PLU"),
                "nombre_etages_batiment": _integer_value(
                    _tile_value(detail_tiles, "Nombre d'étages dans le bâtiment")
                ),
                "procedure_vente": _procedure_value(soup),
                "procedure": _procedure_value(soup),
                "gestionnaire": _cession_contact_features(soup).get("manager_name"),
                "gestionnaire_telephone": _cession_contact_features(soup).get("phone"),
                "gestionnaire_email": _cession_contact_features(soup).get("email"),
                "documents": "; ".join(document["label"] for document in documents if document.get("label")) or None,
                "page_text": raw_text,
            }.items()
            if value
        },
        "source_property_features": _cessions_property_features(
            soup=soup,
            detail_tiles=detail_tiles,
            detail_sections=detail_sections,
            property_type=property_type,
            postal_code=postal_code,
            land_surface=land_surface,
            surface=surface,
            documents=documents,
            source_images=source_images,
        ),
        "source_evidence": _cessions_source_evidence(
            title=title,
            description=description,
            detail_tiles=detail_tiles,
            land_surface=land_surface,
            postal_code=postal_code,
            procedure=_procedure_value(soup),
        ),
    }


def _detail_title(soup: BeautifulSoup) -> str | None:
    for node in soup.select("h1"):
        title = clean_text(node.get_text(" ", strip=True))
        if title and title.lower() != "partager la page" and len(title) <= 220:
            return title
    if soup.title:
        title = clean_text(soup.title.get_text(" ", strip=True).split("|", 1)[0])
        if title and len(title) <= 220:
            return title
    return None


def _detail_property_type(
    title: str | None,
    description: str | None = None,
    detail_sections: list[str] | None = None,
) -> str | None:
    """Classify the asset from detail content, never page-wide navigation."""
    title_text = clean_text(title) or ""
    description_text = clean_text(description) or ""
    scoped_text = " ".join(part for part in (title_text, description_text) if part)
    if re.search(r"\b(?:ancien\s+)?immeuble\b", description_text, re.I):
        return "building"
    if re.search(r"\b(?:bureaux?|locaux?\s+commerciaux?|commerce)\b", description_text, re.I):
        return "commercial"
    # A description can mention the land attached to a building without
    # classifying the listing as a land-only lot.  Require a title or a
    # structured detail section before promoting a description-only land word;
    # this also preserves the list parser's existing fallback type when a
    # minimal detail fixture has no identity heading.
    if (title_text or detail_sections) and re.search(
        r"\b(?:parcelle|terrain|foncier|lande|agricol(?:e|es?))\b", scoped_text, re.I
    ):
        return "land"
    if re.search(r"\bpavillons?\b", title_text, re.I):
        return "house"
    if re.search(r"\bbureaux?\b", title_text, re.I):
        return "commercial"
    title_type = normalize_property_type(title_text)
    if title_type not in {"other", "unknown"}:
        return title_type
    for section in reversed(detail_sections or []):
        section_type = normalize_property_type(section)
        if section_type not in {"other", "unknown"}:
            return section_type
    return None


def normalize_document_text(value: str | None) -> str:
    """Normalize a Cessions label for dictionary lookup without losing value."""
    text = clean_text(value) or ""
    return (
        text.lower()
        .replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("â", "a")
        .replace("î", "i")
        .replace("ï", "i")
        .replace("ô", "o")
        .replace("û", "u")
        .replace("ù", "u")
        .replace("ç", "c")
        .replace("’", "'")
    )


def _detail_tile_values(soup: BeautifulSoup) -> dict[str, str]:
    values: dict[str, str] = {}
    for tile in soup.select("#details-tab .fr-tile"):
        label = clean_text(_node_text(tile.select_one(".fr-tile__title")))
        value = clean_text(_node_text(tile.select_one(".fr-tile__desc")))
        if not label or not value:
            continue
        values[normalize_document_text(label)] = value
    return values


def _tile_value(values: dict[str, str], label: str) -> str | None:
    return values.get(normalize_document_text(label))


def _detail_section_labels(soup: BeautifulSoup) -> list[str]:
    labels: list[str] = []
    for heading in soup.select("#details-tab h4"):
        value = clean_text(heading.get_text(" ", strip=True))
        if not value or normalize_document_text(value) == "caracteristiques detaillees du bien":
            continue
        if normalize_document_text(value) == "pieces jointes":
            continue
        if value not in labels:
            labels.append(value)
    return labels


def _integer_value(value: object | None) -> int | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"\b\d+\b", text)
    return int(match.group(0)) if match else None


def _procedure_value(soup: BeautifulSoup) -> str | None:
    for heading in soup.select("#panel-bien h5"):
        label = clean_text(heading.get_text(" ", strip=True))
        if normalize_document_text(label) != "procedure de vente":
            continue
        paragraph = heading.find_next_sibling("p")
        value = clean_text(paragraph.get_text(" ", strip=True)) if paragraph else None
        if value:
            return re.sub(r"^par\s+", "", value, flags=re.I).strip()
    return None


def _cession_contact_features(soup: BeautifulSoup) -> dict[str, Any]:
    contacts: list[dict[str, Any]] = []
    for button in soup.select("button.contact-btn-unified[data-contacts]"):
        raw = button.get("data-contacts")
        if not raw:
            continue
        try:
            values = json.loads(str(raw))
        except (TypeError, ValueError):
            continue
        if isinstance(values, dict):
            values = [values]
        if not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict):
                continue
            contact = {
                key: clean_text(item.get(key))
                for key in ("nom", "prenom", "fonction", "email", "telephone")
                if clean_text(item.get(key))
            }
            if contact and contact not in contacts:
                contacts.append(contact)
    manager_name = clean_text(_node_text(soup.select_one(".contacts-region-title + .contacts-display .contact-name")))
    if not manager_name:
        manager_name = clean_text(_node_text(soup.select_one(".contact-name")))
    first = contacts[0] if contacts else {}
    return {
        "manager_name": manager_name,
        "phone": first.get("telephone"),
        "email": first.get("email"),
        "contacts": contacts,
    }


def _cessions_property_features(
    *,
    soup: BeautifulSoup,
    detail_tiles: dict[str, str],
    detail_sections: list[str],
    property_type: str | None,
    postal_code: str | None,
    land_surface: str | None,
    surface: str | None,
    documents: list[dict[str, str]],
    source_images: list[str],
) -> dict[str, Any]:
    procedure = _procedure_value(soup)
    contacts = _cession_contact_features(soup)
    cadastre = {
        "reference": _tile_value(detail_tiles, "Référence cadastrale"),
        "references": _tile_value(detail_tiles, "Références cadastrales"),
        "insee_code": _tile_value(detail_tiles, "Code INSEE"),
        "file_number": _tile_value(detail_tiles, "Numéro de dossier"),
    }
    urban = {
        "zoning": _tile_value(detail_tiles, "Zonage d'urbanisme"),
        "plu": _tile_value(detail_tiles, "Informations sur le PLU"),
        "cidol_eligible": _tile_value(detail_tiles, "Eligible CIDOL"),
    }
    building = {
        "section": detail_sections[-1] if detail_sections else None,
        "floors_count": _integer_value(_tile_value(detail_tiles, "Nombre d'étages dans le bâtiment")),
    }
    media = {
        "image_count": len(source_images),
        "images": list(source_images),
        "document_count": len(documents),
        "documents": list(documents),
    }
    return {
        "property_type": property_type,
        "postal_code": postal_code,
        "surface": {
            "surface_m2": surface,
            "land_surface_m2": land_surface,
            "scope": "parcel" if property_type == "land" else "asset",
            "label": _tile_value(detail_tiles, "Surface en m²"),
        },
        "procedure": {"method": procedure},
        "manager": contacts,
        "cadastre": {key: value for key, value in cadastre.items() if value is not None},
        "urban_planning": {key: value for key, value in urban.items() if value is not None},
        "building": {key: value for key, value in building.items() if value is not None},
        "media": media,
    }


def _cessions_source_evidence(
    *,
    title: str | None,
    description: str | None,
    detail_tiles: dict[str, str],
    land_surface: str | None,
    postal_code: str | None,
    procedure: str | None,
) -> dict[str, Any]:
    evidence: dict[str, Any] = {}
    if postal_code:
        evidence["postal_code"] = {"source": "title_or_detail", "quote": title}
    if land_surface:
        evidence["land_surface_m2"] = {
            "source": "cessions_detail_tile",
            "label": "Surface en m²",
            "quote": _tile_value(detail_tiles, "Surface en m²") or land_surface,
        }
    if procedure:
        evidence["procedure"] = {"source": "cessions_procedure_block", "quote": procedure}
    for key, label in (
        ("cadastre", "Références cadastrales"),
        ("insee_code", "Code INSEE"),
        ("plu", "Informations sur le PLU"),
        ("floors_count", "Nombre d'étages dans le bâtiment"),
    ):
        value = _tile_value(detail_tiles, label)
        if value:
            evidence[key] = {"source": "cessions_detail_tile", "label": label, "quote": value}
    if description:
        evidence["description"] = {"source": "cessions_description", "quote": description}
    return evidence


def _detail_energy_classes(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    scope = soup.select_one("#details-tab") or soup.select_one("#panel-description")
    if scope is None:
        return None, None
    text = scope.get_text(" ", strip=True)
    dpe = re.search(r"\bPerformance\s+[ée]nerg[ée]tique\s*:\s*([A-G])\b", text, re.I)
    ges = re.search(r"\bGaz\s+[àa]\s+effet\s+de\s+serre\s*:\s*([A-G])\b", text, re.I)
    return (dpe.group(1).upper() if dpe else None, ges.group(1).upper() if ges else None)


def _parse_card(card: Tag, page_url: str) -> dict[str, Any] | None:
    href = card.get("data-url")
    if not href:
        link = card.find("a", href=True)
        href = link.get("href") if link is not None else None
    if not href:
        return None
    source_url = urljoin(page_url, str(href))
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in card.get_text("\n", strip=True).splitlines()) if line
    )
    title = clean_text(card.get("data-titre")) or _node_text(card.select_one(".fr-card__title"))
    location = clean_text(card.get("data-localisation"))
    city, department = _location(location or raw_text)
    # Accept the explicit department only when both title and URL agree.
    if not department and location and title:
        code = re.search(r"\b(2[AB]|\d{2})$", title)
        if code and source_url.rstrip("/").endswith("-" + code[1].lower()):
            city, department = location, code[1]
    postal_code = _extract_postal(raw_text)
    surface = _extract_surface(raw_text)
    reference = _extract_after(raw_text, r"R[ée]f[ée]rence\s*:\s*([^\n]+)")
    property_type = clean_text(card.get("data-type-bien"))
    land_surface = surface if _is_land_property_type(property_type) else None
    image = _first_image(card, page_url)
    return {
        "source_name": "cessions_etat",
        "source_url": source_url,
        "external_id": str(card.get("data-nid") or card.get("node_id") or card.get("id") or source_url),
        "department": department,
        "city": city,
        "postal_code": postal_code,
        "surface_m2": surface,
        "land_surface_m2": land_surface,
        "property_type": property_type,
        "title": title,
        "description": title,
        "latitude": card.get("data-lat") or None,
        "longitude": card.get("data-lng") or None,
        "status": "past" if re.search(r"\bexpir[ée]\b", raw_text, re.I) else "unknown",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": image,
        "source_blocks": {
            key: value
            for key, value in {
                "reference": reference,
                "titre": title,
                "type_bien": property_type,
                "ville": city,
                "departement": department,
                "code_postal": postal_code,
                "surface": surface,
                "surface_terrain": land_surface,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _list_urls(max_pages: int) -> list[str]:
    urls = [LIST_URL]
    for index in range(1, max_pages):
        urls.append(f"{LIST_URL}?page={index}")
    return urls


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Cessions Etat detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return
    sale["source_detail_status"] = "complete"
    detail = parse_cessions_etat_detail_html(html, source_url)
    for key in DETAIL_FIELDS:
        value = detail.get(key)
        if not value:
            continue
        if key == "source_blocks":
            existing_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
            sale["source_blocks"] = {**existing_blocks, **value}
        elif key in {"source_property_features", "source_evidence"} and isinstance(value, dict):
            existing_features = sale.get(key) if isinstance(sale.get(key), dict) else {}
            sale[key] = {**existing_features, **value}
        elif key == "raw_text":
            sale["raw_text"] = _join_unique_lines(sale.get("raw_text"), value)
        elif key == "source_images":
            sale["source_images"] = _unique_text_values(
                [*_as_text_list(sale.get("source_images")), *_as_text_list(value)]
            )
            if not sale.get("raw_image_url") and sale["source_images"]:
                sale["raw_image_url"] = sale["source_images"][0]
        elif key == "raw_image_url" and not sale.get("raw_image_url"):
            sale[key] = value
        elif key in {
            "documents",
            "description",
            "property_type",
            "sale_date",
            "sale_date_kind",
            "source_sale_schedule",
            "visit_dates",
        } or not sale.get(key):
            sale[key] = value


def _location(text: str | None) -> tuple[str | None, str | None]:
    if not text:
        return None, None
    match = re.search(r"(.+?)\s*-\s*(2[AB]|\d{1,3})\b", text)
    if not match:
        return None, None
    return clean_text(match.group(1)), match.group(2).zfill(2)


def _first_image(card: Tag, page_url: str) -> str | None:
    image = card.find("img")
    if image:
        if candidates := html_image_candidates(image):
            return urljoin(page_url, candidates[0])
    images = str(card.get("data-images") or "").split(",")
    return urljoin(page_url, images[0]) if images and images[0].strip() else None


def _description(soup: BeautifulSoup) -> str | None:
    for selector in ("#panel-bien .texte .fr-text", ".field--name-body", ".fr-card__desc", "article"):
        node = soup.select_one(selector)
        if node:
            text = clean_text(node.get_text(" ", strip=True))
            if text:
                return text
    return None


def _documents(soup: BeautifulSoup, page_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        text = clean_text(link.get_text(" ", strip=True)) or href.rsplit("/", 1)[-1]
        if not _looks_like_document_link(href, text):
            continue
        documents.append({"label": text or "document", "url": urljoin(page_url, href), "type": "pdf" if ".pdf" in href.lower() else "document"})
    return documents


def _extract_images(soup: BeautifulSoup, page_url: str) -> list[str]:
    images: list[str] = []
    for selector in ("meta[property='og:image']", "meta[name='twitter:image']"):
        for node in soup.select(selector):
            _append_image(images, node.get("content"), page_url)
    for node in soup.find_all("img"):
        for candidate in html_image_candidates(node):
            _append_image(images, candidate, page_url)
    return _unique_text_values(images)


def _append_image(images: list[str], value: object | None, page_url: str) -> None:
    image_url = clean_text(value)
    if not image_url or image_url.startswith("data:"):
        return
    absolute = urljoin(page_url, image_url)
    lowered = absolute.lower()
    if re.search(r"\.(?:pdf|svg|ico)(?:[?#].*)?$", lowered):
        return
    if not re.search(r"\.(?:avif|jpe?g|png|webp)(?:[?#].*)?$", lowered):
        return
    if any(marker in lowered for marker in ("logo", "favicon", "pictogramme", "icon-", "/themes/", "/core/")):
        return
    images.append(absolute)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = f"{href} {label or ''}".lower()
    if "/qui-nous-sommes/" in text or "/qui-sommes-nous" in text:
        return False
    return bool(
        ".pdf" in text
        or re.search(
            r"\b(?:documents?|dossiers?|cahiers?|consultation|pr[ée]sentation|"
            r"t[ée]l[ée]charg\w*|download\w*|fichiers?|annexes?|r[èe]glement|notice)\b",
            text,
            flags=re.I,
        )
    )


def _visit_dates(text: str) -> list[str]:
    visits: list[str] = []
    for raw_line in text.splitlines():
        line = clean_text(raw_line)
        if not line or _is_virtual_visit_line(line):
            continue
        if re.fullmatch(r"visites?\s+libres?\.?", line, flags=re.I):
            visits.append(line)
            continue
        label_match = re.match(r"^(?:Visites?|Rendez-vous)\s*:\s*(.+)$", line, flags=re.I)
        if label_match:
            value = clean_text(label_match.group(1))
        elif _looks_like_visit_instruction(line):
            value = line
        else:
            value = None
        if not value or _is_virtual_visit_line(value) or value in visits:
            continue
        visits.append(value)
    return visits


def _extract_surface(text: str) -> str | None:
    for pattern in (
        rf"\bSurface\s+en\s+m(?:²|2)\s*:?\s*{SURFACE_VALUE_PATTERN}\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return _normalize_surface_number(match.group(1))
    return None


def _extract_carrez_surface(text: str) -> str | None:
    """Extract an explicitly labelled Carrez measurement.

    The general surface tag on a Cessions page may be rounded or describe a
    different scope.  Keep the separately labelled Carrez figure when the
    description publishes one.
    """
    for pattern in (
        rf"\b(?:surface\s+)?(?:loi\s+)?carrez\b[^\n0-9]{{0,40}}{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\s*(?:\(?\s*)?(?:loi\s+)?carrez\b",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return _normalize_surface_number(match.group(1))
    return None


def _extract_land_surface(text: str) -> str | None:
    for pattern in (
        rf"\bterrain\s+d['’]une\s+superficie\s+(?:totale\s+)?de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
        rf"\bterrain\s+d['’]une\s+surface\s+(?:totale\s+)?de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
        rf"\bsuperficie\s+du\s+terrain\s*:?\s*{SURFACE_VALUE_PATTERN}(?:\s*m(?:²|2))?\b",
        rf"\bterrain\s+clos\s+et\s+arbor[ée]\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
        rf"\bparcelle[^.\n]{{0,60}}d['’]une\s+superficie\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return _normalize_surface_number(match.group(1))
    return None


def _extract_parking_count(text: str | None) -> int | None:
    """Extract an explicit lot-level parking or garage count."""

    scoped_text = clean_text(text) or ""
    if not scoped_text:
        return None
    count_token = r"[1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix"
    patterns = (
        rf"\b(?P<count>{count_token})\s+(?:(?:emplacements?|places?)\s+(?:de\s+)?)?"
        rf"(?P<kind>parkings?|stationnement|garages?|box)\b",
        rf"\b(?P<kind>parkings?|stationnement|garages?|box)\s*:\s*"
        rf"(?P<count>{count_token})\b",
    )
    visitor_pattern = re.compile(r"\b(?:visiteurs?|publics?|publiques?)\b", re.I)
    excluded_lot_pattern = re.compile(
        r"\b(?:non|pas)\s+(?:compris(?:e|es|s)?|inclus(?:e|es|s)?)\b|"
        r"\b(?:parkings?|stationnement|garages?|box)\b[^.;:]{0,45}"
        r"\b(?:lot\s+)?voisin(?:e|s)?\b|"
        r"\b(?:lot\s+)?voisin(?:e|s)?\b[^.;:]{0,45}"
        r"\b(?:parkings?|stationnement|garages?|box)\b",
        re.I,
    )
    values: list[int] = []
    for pattern in patterns:
        for match in re.finditer(pattern, scoped_text, re.I):
            context = scoped_text[max(0, match.start() - 60) : min(len(scoped_text), match.end() + 60)]
            if visitor_pattern.search(context) or excluded_lot_pattern.search(context):
                continue
            token = match.group("count").lower()
            value = int(token) if token.isdigit() else {
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
            }.get(token)
            if value is not None:
                values.append(value)
    unique_values = set(values)
    return next(iter(unique_values)) if len(unique_values) == 1 else None


def _extract_sale_date(text: str) -> str | None:
    adjudication = re.search(r"Date\s+d[’']adjudication\s*:\s*(\d{2}/\d{2}/\d{4})", text, re.I)
    if adjudication:
        from src.normalize import parse_french_datetime
        date_text = adjudication.group(1)
        expected = parse_french_datetime(date_text)
        # Only attach an hour from the procedure comment on the same sale day.
        for line in text[adjudication.end():].splitlines()[:5]:
            if not line.lower().startswith("commentaire"):
                continue
            candidate = parse_french_datetime(line)
            hour = re.search(r"\b(\d{1,2})[h:](\d{2})\b", line)
            if candidate and expected and candidate.date() == expected.date() and hour:
                return f"{date_text} à {hour.group(1)}h{hour.group(2)}"
        return date_text
    for pattern in (
        r"\bdate\s+limite\s+de\s+r[ée]ception\s+des\s+offres\s+est\s+fix[ée]e?\s+au\s+([^\n.]+)",
        r"\bdate\s+limite\s+d['’]envoi[^:\n]*:\s*([^\n.]+)",
        r"\b(?:Date limite|Fin de candidature|Cl[oô]ture)\s*:\s*([^\n]+)",
    ):
        match = re.search(pattern, text, flags=re.I)
        if match:
            return clean_text(match.group(1).strip(" .;"))
    closing_date = re.search(
        r"\b(?:Fin\s+de\s+l['’]appel\s+d['’]offres?\s+le|"
        r"Date\s+de\s+fin\s+de\s+vente\s*:|prend\s+fin\s+au)\s*"
        r"(\d{1,2}(?:/\d{1,2}/\d{4}|\s+[A-Za-zÀ-ÿ]+\s+\d{4}))\b",
        text,
        re.I,
    )
    if closing_date:
        return clean_text(closing_date.group(1))
    return None


def _extract_sale_schedule(text: str) -> dict[str, str] | None:
    """Keep an explicit online sale window as source evidence.

    Cessions also publishes offer windows using the labels "Début de vente"
    and "Date de fin de vente".  They are distinct from an adjudication
    audience; the generic ``sale_date`` remains the closing boundary for
    backwards-compatible filtering while this payload preserves the window.
    """
    from src.normalize import parse_french_datetime

    opening = re.search(r"\bd[ée]but\s+de\s+vente\s*:\s*([^\n]+)", text, flags=re.I)
    closing = re.search(r"\bdate\s+de\s+fin\s+de\s+vente\s*:\s*([^\n]+)", text, flags=re.I)
    if not opening or not closing:
        return None
    start = parse_french_datetime(opening.group(1))
    end = parse_french_datetime(closing.group(1))
    if start is None or end is None or end <= start:
        return None
    return {
        "opens_at": start.isoformat(),
        "closes_at": end.isoformat(),
        "schedule_type": "sale_window",
    }


def _sale_date_kind(text: str, schedule: dict[str, str] | None) -> str | None:
    if schedule:
        return "sale_window_close"
    if re.search(r"\bdate\s+d[’']adjudication\b", text, flags=re.I):
        return "adjudication"
    if re.search(
        r"\b(?:date\s+limite|fin\s+de\s+l['’]appel\s+d['’]offres?|"
        r"fin\s+de\s+vente|fin\s+de\s+candidature|prend\s+fin\s+au|cl[oô]ture)\b",
        text,
        flags=re.I,
    ):
        return "offer_deadline"
    return None


def _normalize_surface_number(value: str) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," not in text and re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    return text


def _looks_like_visit_instruction(text: str) -> bool:
    return bool(
        re.search(
            r"\b(?:visite\s+(?:group[ée]e|obligatoire|est\s+obligatoire|sur\s+place|pr[ée]vue)|"
            r"sur\s+rendez[-\s]?vous|rendez[-\s]?vous)\b",
            text,
            flags=re.I,
        )
    )


def _is_virtual_visit_line(text: str) -> bool:
    return bool(re.search(r"\b(?:visite\s+virtuelle|virtuelle|partagez\s+la\s+page)\b", text, flags=re.I))


def _is_land_property_type(value: str | None) -> bool:
    return bool(value and re.search(r"\b(?:foncier|terrain|parcelle)\b", value, flags=re.I))


def _join_unique_lines(*blocks: object) -> str | None:
    lines: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        if not block:
            continue
        for raw_line in str(block).splitlines():
            line = clean_text(raw_line)
            if not line:
                continue
            key = line.casefold()
            if key in seen:
                continue
            seen.add(key)
            lines.append(line)
    return "\n".join(lines) or None


def _unique_text_values(values: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(text)
    return unique


def _as_text_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item]
    text = clean_text(value)
    return [text] if text else []


def _extract_postal(text: str) -> str | None:
    for raw_line in text.splitlines():
        line = clean_text(raw_line)
        if not line or re.fullmatch(r"\d{5}", line):
            continue
        # Detail titles frequently carry the postal code in parentheses,
        # e.g. ``Saint Junien (87200)``.  This is source identity evidence,
        # unlike an unqualified five-digit price token in page chrome.
        parenthesized = re.search(rf"\(\s*({FRENCH_POSTAL_CODE_PATTERN})\s*\)", line)
        if parenthesized:
            return parenthesized.group(1)
        if re.search(r"\b(?:adresse|localisation|lieu)\b", line, flags=re.I):
            match = re.search(rf"\b({FRENCH_POSTAL_CODE_PATTERN})\b", line)
            if match:
                return match.group(1)
        match = re.search(rf"(?:^|\s-\s)\b({FRENCH_POSTAL_CODE_PATTERN})\s+[A-Za-zÀ-ÖØ-öø-ÿ'-]", line)
        if match:
            return match.group(1)
    return None


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.I)
    return clean_text(match.group(1)) if match else None


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None
