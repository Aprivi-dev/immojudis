from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from src.catalogue_proof import CatalogueEvidence
from src.config import FRANCE_DEPARTMENTS, TARGET_DEPARTMENTS, load_settings
from src.normalize import (
    LATIN_LETTERS_PATTERN,
    SURFACE_VALUE_PATTERN,
    clean_text,
    extract_department,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
    parse_surface,
)
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PoliteHttpClient, ScrapeResult, parse_html, should_fetch_detail, unique_dicts
from src.sources.image_candidates import html_image_candidates
from src.sources.linked_pages import LinkedPages

BASE_URL = "https://www.vench.fr"
LIST_URL = f"{BASE_URL}/prochaines-ventes-aux-encheres.html"
LOGGER = logging.getLogger(__name__)
DETAIL_OVERRIDE_FIELDS = {
    "title",
    "description",
    "address",
    "postal_code",
    "surface_m2",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "tribunal",
    "occupancy_status",
    "raw_text",
    "raw_image_url",
    "source_images",
}


def scrape_vench_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_vench_aquitaine_result(max_pages=max_pages).sales


def scrape_vench_aquitaine_result(
    max_pages: int | None = None,
    known: dict[str, str] | None = None,
    known_details: dict[str, dict[str, Any]] | None = None,
) -> ScrapeResult:
    """Collect Vench listings for the target departments.

    Vench exposes the core listing data publicly, while some descriptions and
    documents are behind a subscription wall. We keep this source as a coverage
    signal and do not attempt to fetch disallowed upload documents.
    """
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    inventory = CatalogueEvidence("vench")
    partitions: list[dict[str, Any]] = []
    seen_sales: set[str] = set()
    for department in _department_filters():
        pages = LinkedPages(LIST_URL, "p", 1, max_pages or int(settings["vench_max_pages"]))
        form = {"searching": "1", "orderResult": "1", "resetInput": "0"}
        if department:
            form["departement"] = department
        for page_url in pages:
            try:
                # Preserve the source's search session when following its links.
                html = client.post_form(page_url, form) if page_url == LIST_URL else client.get(page_url)
            except Exception as exc:
                LOGGER.error("Vench list fetch failed for %s: %s", page_url, exc)
                errors.append(f"{page_url}: {exc}")
                break
            pages.observe(html, page_url)
            parsed = parse_vench_list_html(html, page_url=page_url, fallback_department=department)
            inventory.observe(html, page_url, parsed)
            for sale in parsed:
                url = str(sale.get("source_url"))
                if url in seen_sales:
                    continue
                seen_sales.add(url)
                if should_fetch_detail(sale, known):
                    _enrich_sale_from_detail(client, sale, errors)
                raw_sales.append(sale)
        partitions.append({"department": department, **pages.metrics()})

    catalog_sales = _filter_catalog_sales(unique_dicts(raw_sales, "source_url"), known_details)
    return ScrapeResult(
        validate_raw_sales("vench", catalog_sales, errors),
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(), "partitions": partitions,
         "linked_pages_complete": all(p["linked_pages_complete"] for p in partitions),
         "inventory_before_catalog_filter": len(raw_sales),
         "catalog_filter_excluded": len(raw_sales) - len(catalog_sales),
         **inventory.metrics(catalog_sales, errors)},
    )


def _department_filters() -> tuple[str | None, ...]:
    if set(TARGET_DEPARTMENTS) == set(FRANCE_DEPARTMENTS):
        return (None,)
    return TARGET_DEPARTMENTS


def _filter_catalog_sales(
    sales: list[dict[str, Any]],
    known_details: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    # Preserve discovery; common admission runs after all enrichment stages.
    for sale in sales:
        if not _has_surface_signal(sale) or _is_paywalled_or_sparse(sale):
            _backfill_from_known_detail(sale, known_details)
    return sales


def _backfill_from_known_detail(
    sale: dict[str, Any],
    known_details: dict[str, dict[str, Any]] | None,
) -> None:
    if not known_details:
        return
    known = known_details.get(str(sale.get("source_url") or ""))
    if not known:
        return
    for key in (
        "tribunal",
        "department",
        "city",
        "address",
        "postal_code",
        "property_type",
        "title",
        "description",
        "surface_m2",
        "habitable_surface_m2",
        "land_surface_m2",
        "carrez_surface_m2",
        "app_surface_m2",
        "app_surface_kind",
        "surface_source",
        "surface_confidence",
        "surface_evidence",
        "rooms_count",
        "bedrooms_count",
        "bathrooms_count",
        "parking_count",
        "has_garden",
        "has_terrace",
        "has_garage",
        "has_pool",
        "has_air_conditioning",
        "has_double_glazing",
        "occupancy_status",
        "raw_text",
    ):
        if sale.get(key) in (None, "", [], {}) and known.get(key) not in (None, "", [], {}):
            sale[key] = known[key]
    if not sale.get("documents") and known.get("documents"):
        sale["documents"] = known["documents"]
    if not sale.get("raw_image_url") and known.get("raw_image_url"):
        sale["raw_image_url"] = known["raw_image_url"]
    if not sale.get("source_images") and known.get("source_images"):
        sale["source_images"] = known["source_images"]


def _is_paywalled_or_sparse(sale: dict[str, Any]) -> bool:
    text = " ".join(
        clean_text(value) or ""
        for value in (sale.get("title"), sale.get("description"), sale.get("raw_text"))
    ).lower()
    if "vous devez être abonné" in text or "consulter l'intégralité" in text:
        return True
    useful = (
        "address",
        "postal_code",
        "surface_m2",
        "starting_price_eur",
        "sale_date",
        "description",
        "documents",
    )
    return sum(sale.get(key) not in (None, "", [], {}) for key in useful) <= 3


def _has_surface_signal(sale: dict[str, Any]) -> bool:
    for key in (
        "surface_m2",
        "habitable_surface_m2",
        "carrez_surface_m2",
        "app_surface_m2",
        "land_surface_m2",
    ):
        if sale.get(key) not in (None, "", 0, "0"):
            return True
    text_values = [
        sale.get("title"),
        sale.get("description"),
        sale.get("raw_text"),
    ]
    source_blocks = sale.get("source_blocks")
    if isinstance(source_blocks, dict):
        text_values.extend(source_blocks.values())
    text = " ".join(clean_text(value) or "" for value in text_values)
    return bool(re.search(r"\b[1-9][0-9]*(?:[,.][0-9]+)?\s*m(?:2|²)\b", text, re.I))


def parse_vench_list_html(
    html: str,
    page_url: str = LIST_URL,
    fallback_department: str | None = None,
) -> list[dict[str, Any]]:
    soup = parse_html(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select(".featured-item"):
        sale = _parse_card(card, page_url, fallback_department)
        if sale:
            sales.append(sale)
    return sales


def parse_vench_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = parse_html(html, "html.parser")
    page_text = "\n".join(
        line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    title = _extract_title_from_detail(soup)
    address = _extract_address_block(page_text)
    postal_code = _extract_postal_code_from_address(address)
    city = _extract_city_from_detail(soup, source_url)
    documents = _extract_documents(soup, source_url)
    sale_date = _extract_after(page_text, r"DATE DE L['’]AUDIENCE\s*([0-9/]{8,10}(?:\s+à\s+\d{1,2}:\d{2})?)")
    if not sale_date:
        sale_date = _extract_after(page_text, r"Date de la vente\s*:?\s*([0-9/]{8,10})")
    description = _extract_description(soup)
    source_blocks = _extract_source_blocks(soup, page_text, title, description, documents)
    curated_raw_text = _build_detail_raw_text(source_blocks)
    source_images = _extract_images(soup, source_url)
    # Restrict enriched fields to the listing title/description. Page-wide
    # text includes generic navigation labels that are not property facts.
    detail_text = description or title or ""
    habitable_surface = _extract_qualified_surface(detail_text, "habitable")
    carrez_surface = _extract_qualified_surface(detail_text, "carrez")
    land_surface = _extract_land_surface_m2(detail_text)
    rooms_count = _extract_rooms_count(detail_text, title)
    parking_count = _extract_parking_count(detail_text)
    property_type = _extract_property_type(title, detail_text)
    occupancy_status = _extract_occupancy_status(detail_text)
    for key, value in {
        "surface_habitable": habitable_surface,
        "surface_carrez": carrez_surface,
        "surface_terrain": land_surface,
        "pieces": rooms_count,
        "stationnement": parking_count,
    }.items():
        if value is not None:
            source_blocks[key] = str(value)

    return {
        "source_name": "vench",
        "source_url": source_url,
        "external_id": _extract_external_id(source_url),
        "tribunal": _extract_after(page_text, r"(Tribunal judiciaire de\s+[A-ZÀ-Ÿ' -]+)"),
        "department": extract_department(postal_code),
        "city": city,
        "address": address or _join_address(postal_code, city),
        "postal_code": postal_code,
        "property_type": property_type,
        "title": title,
        "description": description,
        "surface_m2": _extract_surface(title, page_text),
        "habitable_surface_m2": habitable_surface,
        "carrez_surface_m2": carrez_surface,
        "land_surface_m2": land_surface,
        "rooms_count": rooms_count,
        "parking_count": parking_count,
        "starting_price_eur": _extract_after(page_text, r"Mise à prix\s*:?\s*([0-9][0-9\s.,]+)\s*€"),
        "sale_date": sale_date,
        "visit_dates": _extract_visit_dates(page_text),
        "has_garden": _has_feature(page_text, "Jardin"),
        "has_terrace": _has_feature(page_text, "Terrasse"),
        "has_garage": _has_feature(page_text, "Garage"),
        "occupancy_status": occupancy_status,
        "documents": documents,
        "raw_text": curated_raw_text or page_text,
        "source_blocks": source_blocks,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
    }


def _parse_card(card: Tag, page_url: str, fallback_department: str | None) -> dict[str, Any] | None:
    raw_text = card.get_text("\n", strip=True)
    link = _find_sale_link(card)
    if link is None:
        return None
    source_url = urljoin(page_url, str(link.get("href")))
    title, city = _split_title_city(_text(card.select_one("h3").get_text(" ", strip=True)) if card.select_one("h3") else None)
    image = card.find("img")
    image_url = urljoin(page_url, str(image.get("data-src") or image.get("src"))) if image else None
    return {
        "source_name": "vench",
        "source_url": source_url,
        "external_id": _extract_external_id(source_url),
        "department": fallback_department,
        "city": city,
        "property_type": _extract_property_type(title),
        "title": title,
        "description": title,
        "starting_price_eur": _extract_after(raw_text, r"Mise à prix\s*:?\s*([0-9][0-9\s.,]+)\s*€"),
        "sale_date": _extract_after(raw_text, r"Date de la vente\s*:?\s*([0-9/]{8,10})"),
        "visit_dates": _extract_visit_dates(raw_text),
        "status": "unknown",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": image_url,
        "source_images": [image_url] if image_url else [],
    }


def _find_sale_link(card: Tag) -> Tag | None:
    for link in card.find_all("a", href=True):
        if "vente-" in str(link.get("href")):
            return link
    return None


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Vench detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return
    access_text = parse_html(html, "html.parser").get_text(" ", strip=True)
    restricted = re.search(
        r"(?:r[ée]serv[ée]e?\s+aux\s+abonn[ée]s|vous\s+devez\s+[êe]tre\s+abonn[ée])", access_text, re.I,
    )
    sale["source_detail_status"] = "restricted" if restricted else "complete"
    details = parse_vench_detail_html(html, source_url)
    for key, value in details.items():
        if value in (None, "", []):
            continue
        if key == "documents":
            sale[key] = _merge_documents(sale.get(key), value)
        elif key == "source_images":
            sale[key] = _merge_text_values(sale.get(key), value)
            if not sale.get("raw_image_url") and sale[key]:
                sale["raw_image_url"] = sale[key][0]
        elif key == "raw_image_url":
            if not sale.get("raw_image_url"):
                sale[key] = value
        elif key == "raw_text" and sale.get("raw_text"):
            sale[key] = f"{sale['raw_text']}\n{value}"
        elif key in {"has_garden", "has_terrace", "has_garage"}:
            if sale.get(key) is None:
                sale[key] = value
        elif key in DETAIL_OVERRIDE_FIELDS:
            sale[key] = value
        elif not sale.get(key):
            sale[key] = value


def _extract_documents(soup: BeautifulSoup, source_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        label = _text(link.get_text(" ", strip=True)) or href.rstrip("/").split("/")[-1] or "document"
        absolute = urljoin(source_url, href)
        if not _looks_like_document_link(href, label):
            continue
        if urlparse(absolute).path.startswith("/upload/"):
            continue
        documents.append({"label": label, "url": absolute, "type": _document_type(label, href)})
    return _merge_documents([], documents)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = _normalize_document_text(f"{href} {label or ''}")
    return bool(
        ".pdf" in text
        or re.search(
            r"\b(?:documents?|dossiers?|cahiers?|conditions?|diagnostics?|annexes?|"
            r"pv|pvd|proces\s+verbal|proces-verbal|descriptif|telecharg\w*|download\w*)\b",
            text,
        )
    )


def _document_type(label: str, href: str) -> str:
    searchable = _normalize_document_text(f"{label} {href}")
    if "cahier" in searchable:
        return "cahier_conditions"
    if "diagnostic" in searchable:
        return "diagnostics"
    if "proces" in searchable or "procès" in searchable or "pv" in searchable:
        return "pv_descriptif"
    return "pdf"


def _normalize_document_text(value: str | None) -> str:
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
    )


def _merge_documents(existing: object, incoming: list[dict[str, str]]) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    by_url: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming]:
        if isinstance(document, dict) and document.get("url"):
            by_url[str(document["url"])] = {
                "label": str(document.get("label") or "document"),
                "url": str(document["url"]),
                "type": str(document.get("type") or "pdf"),
            }
    return list(by_url.values())


def _merge_text_values(existing: object, incoming: object) -> list[str]:
    values: list[str] = []
    for item in [*_as_text_list(existing), *_as_text_list(incoming)]:
        if item not in values:
            values.append(item)
    return values


def _as_text_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value] if _text(value) else []
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := _text(item))]


def _extract_title_from_detail(soup: BeautifulSoup) -> str | None:
    heading = soup.select_one("#page-heading h1")
    if heading:
        text = _text(heading.get_text(" ", strip=True))
        if text:
            return _text(text.replace("•", " - "))
    meta = soup.find("meta", attrs={"property": "og:title"})
    return _text(meta.get("content")) if meta and meta.get("content") else None


def _extract_city_from_detail(soup: BeautifulSoup, source_url: str) -> str | None:
    heading = _text(soup.select_one("#page-heading h1").get_text(" ", strip=True)) if soup.select_one("#page-heading h1") else None
    _, city = _split_title_city(heading)
    if city:
        return city
    match = re.search(r"-([a-z0-9-]+)\.html$", source_url)
    if not match:
        return None
    return match.group(1).replace("-", " ").title()


def _extract_property_type(title: str | None, detail_text: str | None = None) -> str | None:
    text = clean_text(title)
    if not text:
        return None
    combined = " ".join(part for part in (title, detail_text) if part)
    if _is_mixed_property(combined):
        return "mixed"
    match = re.search(r"\b(appartement|maison|immeuble|terrain|studio|local|garage|parking|villa)\b", text, re.I)
    return match.group(1) if match else text


def _is_mixed_property(text: str | None) -> bool:
    value = clean_text(text) or ""
    if not value:
        return False
    residential = re.search(r"\b(?:habitation|habitations|logement|logements|appartement|maison)\b", value, re.I)
    commercial = re.search(
        r"\b(?:commerce|commercial(?:e|es)?|bureaux|local(?:ux)?|industriel(?:le|les)?|centre\s+[ée]questre)\b",
        value,
        re.I,
    )
    if not (residential and commercial):
        return False
    return bool(
        re.search(
            r"\b(?:usage\s+mixte|mixte|partie\s+[àa]\s+usage|ensemble\s+immobilier|b[âa]timent|immeuble)\b",
            value,
            re.I,
        )
    )


def _extract_description(soup: BeautifulSoup) -> str | None:
    node = soup.select_one(".descriptionContener")
    if not node:
        return None
    text = _text(node.get_text(" ", strip=True))
    if text and "Pour consulter l'intégralité" not in text:
        return text
    return None


def _extract_source_blocks(
    soup: BeautifulSoup,
    page_text: str,
    title: str | None,
    description: str | None,
    documents: list[dict[str, str]],
) -> dict[str, str]:
    amenities = _extract_amenities(soup)
    blocks = {
        "titre": title,
        "description": description,
        "tribunal": _extract_after(page_text, r"(Tribunal judiciaire de\s+[A-ZÀ-Ÿ' -]+)"),
        "adresse": _extract_address_block(page_text),
        "audience": _extract_after(page_text, r"DATE DE L['’]AUDIENCE\s*([0-9/]{8,10}(?:\s+à\s+\d{1,2}:\d{2})?)")
        or _extract_after(page_text, r"Date de la vente\s*:?\s*([0-9/]{8,10})"),
        "mise_a_prix": _extract_after(page_text, r"Mise à prix\s*:?\s*([0-9][0-9\s.,]+)\s*€"),
        "visites": ", ".join(_extract_visit_dates(page_text)) or None,
        "caracteristiques": ", ".join(amenities) if amenities else None,
        "documents": "; ".join(document["label"] for document in documents if document.get("label")) or None,
        "page_text": page_text,
    }
    return {key: value for key, value in blocks.items() if value}


def _extract_amenities(soup: BeautifulSoup) -> list[str]:
    amenities: list[str] = []
    for node in soup.select(".amentiesDetail, .amenitiesDetail, .details-icons, .property-features"):
        for part in node.get_text("\n", strip=True).splitlines():
            text = _text(part)
            if text and text not in amenities:
                amenities.append(text)
    return amenities


def _extract_address_block(page_text: str) -> str | None:
    lines = [line for line in (clean_text(part) for part in page_text.splitlines()) if line]
    stop_pattern = re.compile(
        r"^(date de|mise à prix|prochaine visite|tribunal|description|pour consulter|documents?)",
        re.I,
    )
    for index, line in enumerate(lines):
        if not re.fullmatch(r"adresse|localisation", line, re.I):
            continue
        candidates: list[str] = []
        for following in lines[index + 1 :]:
            if stop_pattern.search(following):
                break
            candidates.append(following)
            if len(candidates) >= 3:
                break
        candidate_text = _text(
            re.sub(r"\bVoir\s+la\s+carte\b", "", " ".join(candidates), flags=re.I)
        ) or ""
        match = re.search(
            rf"\b(\d{{5}}\s+[{LATIN_LETTERS_PATTERN}'’ -]+)\b(?=$|[,.;])",
            candidate_text,
        )
        if match:
            return _text(match.group(1))
    return None


def _extract_postal_code_from_address(address: str | None) -> str | None:
    return _extract_after(address or "", r"\b(\d{5})\b")


def _build_detail_raw_text(source_blocks: dict[str, str]) -> str | None:
    parts = [
        source_blocks.get("titre"),
        f"Tribunal: {source_blocks['tribunal']}" if source_blocks.get("tribunal") else None,
        f"Adresse: {source_blocks['adresse']}" if source_blocks.get("adresse") else None,
        f"Audience: {source_blocks['audience']}" if source_blocks.get("audience") else None,
        f"Mise a prix: {source_blocks['mise_a_prix']}" if source_blocks.get("mise_a_prix") else None,
        source_blocks.get("description"),
        f"Caractéristiques: {source_blocks['caracteristiques']}" if source_blocks.get("caracteristiques") else None,
        f"Visites: {source_blocks['visites']}" if source_blocks.get("visites") else None,
        f"Documents: {source_blocks['documents']}" if source_blocks.get("documents") else None,
    ]
    return "\n".join(part for part in parts if part) or None


def _extract_images(soup: BeautifulSoup, source_url: str) -> list[str]:
    urls: list[str] = []
    for meta in soup.find_all("meta"):
        property_name = _text(meta.get("property") or meta.get("name"))
        if property_name and property_name.lower() in {"og:image", "twitter:image"}:
            _append_image_url(urls, meta.get("content"), source_url)
    for image in soup.find_all("img"):
        for candidate in html_image_candidates(image):
            _append_image_url(urls, candidate, source_url)
    return urls


def _append_image_url(urls: list[str], value: object, source_url: str) -> None:
    src = _text(value)
    if not src:
        return
    absolute = urljoin(source_url, src)
    if not _looks_like_property_image(absolute) or absolute in urls:
        return
    urls.append(absolute)


def _looks_like_property_image(url: str) -> bool:
    text = _normalize_document_text(url)
    if "/design/" in text or "autopromo" in text:
        return False
    if not re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", text):
        return False
    return not re.search(r"\b(?:logo|favicon|sprite|icon|picto|placeholder|avatar|loader)\b", text)


def _extract_surface(*values: object) -> str | None:
    text = " ".join(str(value) for value in values if value)
    match = re.search(rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b", text, re.I)
    surface = parse_surface(match.group(1)) if match else None
    return str(surface) if surface is not None else None


def _normalize_surface_number(value: str) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," in text:
        return text.replace(".", "").replace(",", ".")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        return text.replace(".", "")
    return text


def _extract_qualified_surface(text: str | None, kind: str) -> str | None:
    value = clean_text(text) or ""
    if not value:
        return None
    number = rf"{SURFACE_VALUE_PATTERN}\s*(?:m\s*(?:²|2)|²)\b"
    if kind == "carrez":
        patterns = (
            rf"\b{number}\s*(?:de\s+)?(?:surface\s+)?loi\s+carrez\b",
            rf"(?:surface\s+)?loi\s+carrez(?:\s+(?:totale|privative))?\s*(?:-|:|de)?\s*{number}",
        )
    elif kind == "habitable":
        patterns = (
            rf"\b(?:surface|superficie)\s+habitable(?:\s+totale)?\s*(?:est\s+)?(?:de|:)\s*{number}",
            rf"\b{number}\s*(?:de\s+)?surface\s+habitable\b",
        )
    else:
        return None
    candidates = [
        _normalize_surface_number(match.group(1))
        for pattern in patterns
        for match in re.finditer(pattern, value, re.I)
    ]
    candidates = [candidate for candidate in candidates if candidate]
    return candidates[0] if len(candidates) == 1 else None


def _extract_land_surface_m2(text: str | None) -> str | None:
    value = clean_text(text) or ""
    if not value:
        return None
    cadastral = r"(?:(\d+)\s*ha\s*)?(?:(\d+)\s*a\s*)?(\d+)\s*ca\b"
    total_patterns = (
        rf"\b(?:soit\s+une\s+)?(?:contenance|surface|superficie)\s+totale\s*(?:de|:)\s*{cadastral}",
        rf"\b(?:parcelle|terrain)\b[^.\n]{{0,100}}?\b(?:d['’]une\s+)?(?:surface|superficie|contenance)\s+totale\s*(?:de|:)\s*{cadastral}",
    )
    totals = [
        _cadastral_to_m2(match)
        for pattern in total_patterns
        for match in re.finditer(pattern, value, re.I)
    ]
    unique_totals = {candidate for candidate in totals if candidate}
    if len(unique_totals) == 1:
        return next(iter(unique_totals))
    if len(unique_totals) > 1:
        return None

    cadastral_marker = r"(?:cadastr\w*|parcelle|section\s+[A-Z]{1,4}\s*(?:n[°o.]?\s*)?[0-9A-Za-z-]+)"
    explicit_patterns = (
        rf"\b{cadastral_marker}\b[^.;\n]{{0,180}}?\b(?:pour\s+)?(?:une\s+)?(?:contenance|surface|superficie)\s+(?:de\s+)?{cadastral}",
        rf"\b{cadastral_marker}\b[^.;\n]{{0,180}}?\b(?:pour|de)\s+{cadastral}",
    )
    candidates_by_span: dict[tuple[int, int], str] = {}
    for pattern in explicit_patterns:
        for match in re.finditer(pattern, value, re.I):
            candidate = _cadastral_to_m2(match)
            if candidate:
                candidates_by_span[(match.start(), match.end())] = candidate
    candidates = list(candidates_by_span.values())
    if len(candidates) == 1:
        return candidates[0]

    land_m2_pattern = rf"\b{cadastral_marker}\b[^.;\n]{{0,180}}?\b(?:pour\s+)?(?:une\s+)?(?:surface|superficie)\s+(?:de\s+)?({SURFACE_VALUE_PATTERN})\s*m(?:2|²)\b"
    land_m2 = [
        _normalize_surface_number(match.group(1))
        for match in re.finditer(land_m2_pattern, value, re.I)
    ]
    land_m2 = [candidate for candidate in land_m2 if candidate]
    return land_m2[0] if len(land_m2) == 1 else None


def _cadastral_to_m2(match: re.Match[str]) -> str | None:
    hectares = int(match.group(1) or 0)
    ares = int(match.group(2) or 0)
    centiares = int(match.group(3))
    return str(hectares * 10000 + ares * 100 + centiares)


_ROOM_COUNT_WORDS = {
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


def _parse_room_count(value: str) -> int | None:
    token = value.lower().strip()
    if token.isdigit():
        count = int(token)
        return count if count > 0 else None
    return _ROOM_COUNT_WORDS.get(token)


def _extract_rooms_count(text: str | None, title: str | None = None) -> int | None:
    detail = clean_text(text) or ""
    heading = clean_text(title) or ""
    if not detail and not heading:
        return None

    direct_title = re.search(r"\b(?:appartement|maison|studio)\b[^.]{0,40}?\b(?:de\s+type\s*)?T?([1-9])\b", heading, re.I)
    if direct_title:
        return int(direct_title.group(1))

    combined = " ".join(part for part in (heading, detail) if part)
    if re.search(
        r"\b(?:vente\s+en\s+\d+\s+lots?|r[ée]union\s+des\s+lots?|ensemble\s+immobilier|plusieurs\s+(?:appartements?|maisons?|logements?))\b",
        combined,
        re.I,
    ) or len(re.findall(r"\blots?\s*(?:n[°o.]?\s*)?\d+\b", combined, re.I)) >= 2:
        return None

    qualified_type = re.search(
        r"\b(?:appartement|maison|studio)\b[^.]{0,100}?\b(?:de\s+type\s*)?T?([1-9])\b",
        detail,
        re.I,
    )
    if qualified_type:
        return int(qualified_type.group(1))

    piece_matches = [
        _parse_room_count(match.group(1))
        for match in re.finditer(
            r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+pi[eè]ces?\s+principales?\b",
            detail,
            re.I,
        )
    ]
    piece_matches.extend(
        _parse_room_count(match.group(1))
        for match in re.finditer(
            r"\b(?:appartement|maison|villa)\s+(?:de\s+)?([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+pi[eè]ces?\b",
            detail,
            re.I,
        )
    )
    unique_pieces = {value for value in piece_matches if value}
    if len(unique_pieces) == 1:
        return next(iter(unique_pieces))
    if len(unique_pieces) > 1:
        return None

    if len(re.findall(r"\bpi[eè]ce\s+principale\b", detail, re.I)) == 1 and not re.search(
        r"\b(?:chambres?|\d+\s+pi[eè]ces?)\b", detail, re.I
    ):
        return 1
    return None


def _extract_parking_count(text: str | None) -> int | None:
    detail = clean_text(text) or ""
    if not detail:
        return None
    token = r"[1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix"
    patterns = (
        rf"\b({token})\s+(?:emplacements?|places?)\s+(?:de\s+)?(?:parking|stationnement)\b",
        rf"\b({token})\s+(?:parkings?|stationnements?)\b",
        rf"\b(?:parking|stationnement)\s*:\s*({token})\b",
    )
    values = [
        _parse_room_count(match.group(1))
        for pattern in patterns
        for match in re.finditer(pattern, detail, re.I)
    ]
    values = [value for value in values if value is not None]
    if len(values) == 1:
        return values[0]
    if len(values) > 1:
        return None
    if re.search(r"\b(?:visiteur|public|proximit[ée]|proche)\b", detail, re.I):
        return None
    if len(re.findall(r"\b(?:parking|stationnement|box|garage)\b", detail, re.I)) == 1:
        return 1
    return None


def _extract_occupancy_status(raw_text: str) -> str | None:
    lowered = raw_text.lower()
    occupied_word = r"(?:occup(?:e|é)(?:e|s|es)?|occupant(?:e|s|es)?)"
    vacant = bool(
        re.search(
            rf"\b(?:libre|in{occupied_word}|non\s+{occupied_word}|vacant(?:e|s|es)?)\b",
            lowered,
        )
    )
    rented = has_rented_occupancy_signal(lowered)
    occupied = bool(re.search(rf"\b{occupied_word}\b", lowered))
    partial_or_ambiguous = bool(
        re.search(
            r"\b(?:partiellement|une\s+partie|partie\s+à\s+usage|les\s+biens|plusieurs\s+biens|parcelles?\s+cadastr[ée]es?)\b",
            lowered,
            re.I,
        )
    )
    if (vacant and (rented or occupied)) or (rented and occupied) or (partial_or_ambiguous and (vacant or rented or occupied)):
        return "unknown"
    if re.search(r"sans\s+droit\s+ni\s+titre|squat", lowered):
        return "squatted"
    if re.search(r"propri[ée]taire\s+occupant|occup[ée]\s+par\s+le\s+propri[ée]taire", lowered):
        return "owner_occupied"
    if vacant:
        return "vacant"
    if no_lease_status := no_lease_occupancy_status(lowered):
        return no_lease_status
    if rented:
        return "rented"
    if occupied:
        return "occupied"
    return None


def _extract_visit_dates(raw_text: str) -> list[str]:
    dates: list[str] = []
    text = clean_text(raw_text) or ""
    time_pattern = r"\d{1,2}(?:(?::|h)\d{2}|h)?"
    visit_pattern = (
        rf"Prochaine visite\s*:?\s*((?:le\s+)?[0-9]{{1,2}}/[0-9]{{1,2}}/[0-9]{{2,4}}"
        rf"(?:\s*(?:à|a|de|-)\s*{time_pattern})?"
        rf"(?:\s*(?:à|a|-)\s*{time_pattern})?)"
    )
    for match in re.finditer(visit_pattern, text, re.I):
        value = clean_text(match.group(1))
        if value and value not in dates:
            dates.append(value)
    return dates


def _split_title_city(value: str | None) -> tuple[str | None, str | None]:
    text = _text(value)
    if not text:
        return None, None
    parts = [part for part in (_text(part) for part in re.split(r"\s*[•]\s*", text)) if part]
    if len(parts) >= 2:
        return _text(parts[0]), _text(parts[-1])
    return text, None


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_external_id(source_url: str) -> str | None:
    match = re.search(r"vente-(\d+)-", source_url)
    return match.group(1) if match else None


def _has_feature(raw_text: str, label: str) -> bool | None:
    return True if re.search(rf"\b{re.escape(label)}\b", raw_text, re.I) else None


def _join_address(postal_code: str | None, city: str | None) -> str | None:
    if postal_code and city:
        return f"{postal_code} {city}"
    return city


def _text(value: object | None) -> str | None:
    return clean_text(value)
