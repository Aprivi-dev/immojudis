from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from src.config import AQUITAINE_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, unique_dicts


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
}


def scrape_vench_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_vench_aquitaine_result(max_pages=max_pages).sales


def scrape_vench_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
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
    raw_sales: list[dict[str, Any]] = []
    for department in AQUITAINE_DEPARTMENTS:
        try:
            html = client.post_form(
                LIST_URL,
                {
                    "searching": "1",
                    "orderResult": "1",
                    "resetInput": "0",
                    "departement": department,
                },
            )
        except Exception as exc:
            LOGGER.error("Vench list fetch failed for department %s: %s", department, exc)
            errors.append(f"department {department}: {exc}")
            continue
        for sale in parse_vench_list_html(html, page_url=LIST_URL, fallback_department=department):
            _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)

    return ScrapeResult(validate_raw_sales("vench", unique_dicts(raw_sales, "source_url"), errors), errors)


def parse_vench_list_html(
    html: str,
    page_url: str = LIST_URL,
    fallback_department: str | None = None,
) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select(".featured-item"):
        sale = _parse_card(card, page_url, fallback_department)
        if sale:
            sales.append(sale)
    return sales


def parse_vench_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    page_text = "\n".join(
        line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    title = _extract_title_from_detail(soup)
    postal_code = _extract_after(page_text, r"\b(\d{5})\b")
    city = _extract_city_from_detail(soup, source_url)
    documents = _extract_documents(soup, source_url)
    sale_date = _extract_after(page_text, r"DATE DE L['’]AUDIENCE\s*([0-9/]{8,10}(?:\s+à\s+\d{1,2}:\d{2})?)")
    if not sale_date:
        sale_date = _extract_after(page_text, r"Date de la vente\s*:?\s*([0-9/]{8,10})")
    description = _extract_description(soup)
    source_blocks = _extract_source_blocks(soup, page_text, title, description, documents)
    curated_raw_text = _build_detail_raw_text(source_blocks)

    return {
        "source_name": "vench",
        "source_url": source_url,
        "external_id": _extract_external_id(source_url),
        "tribunal": _extract_after(page_text, r"Tribunal judiciaire de\s+([A-ZÀ-Ÿ' -]+)"),
        "department": postal_code[:2] if postal_code else None,
        "city": city,
        "address": _join_address(postal_code, city),
        "postal_code": postal_code,
        "property_type": _extract_property_type(title),
        "title": title,
        "description": description,
        "surface_m2": _extract_surface(title, page_text),
        "starting_price_eur": _extract_after(page_text, r"Mise à prix\s*:?\s*([0-9][0-9\s.,]+)\s*€"),
        "sale_date": sale_date,
        "visit_dates": _extract_visit_dates(page_text),
        "has_garden": _has_feature(page_text, "Jardin"),
        "has_terrace": _has_feature(page_text, "Terrasse"),
        "has_garage": _has_feature(page_text, "Garage"),
        "occupancy_status": _extract_occupancy_status(page_text),
        "documents": documents,
        "raw_text": curated_raw_text or page_text,
        "source_blocks": source_blocks,
        "source_images": _extract_images(soup, source_url),
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
        return
    details = parse_vench_detail_html(html, source_url)
    for key, value in details.items():
        if value in (None, "", []):
            continue
        if key == "documents":
            sale[key] = _merge_documents(sale.get(key), value)
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
        if ".pdf" not in f"{href} {label}".lower():
            continue
        if urlparse(absolute).path.startswith("/upload/"):
            continue
        documents.append({"label": label, "url": absolute, "type": _document_type(label, href)})
    return _merge_documents([], documents)


def _document_type(label: str, href: str) -> str:
    searchable = f"{label} {href}".lower()
    if "cahier" in searchable:
        return "cahier_conditions"
    if "diagnostic" in searchable:
        return "diagnostics"
    if "proces" in searchable or "procès" in searchable or "pv" in searchable:
        return "pv_descriptif"
    return "pdf"


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


def _extract_property_type(title: str | None) -> str | None:
    text = clean_text(title)
    if not text:
        return None
    match = re.search(r"\b(appartement|maison|immeuble|terrain|studio|local|garage|parking|villa)\b", text, re.I)
    return match.group(1) if match else text


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
    match = re.search(r"\b(\d{5}\s+[A-ZÀ-ŸA-Za-z' -]+)\b", page_text)
    return _text(match.group(1)) if match else None


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
    for image in soup.find_all("img"):
        src = _text(image.get("data-src") or image.get("src"))
        if not src:
            continue
        absolute = urljoin(source_url, src)
        if absolute not in urls:
            urls.append(absolute)
    return urls


def _extract_surface(*values: object) -> str | None:
    text = " ".join(str(value) for value in values if value)
    match = re.search(r"([0-9]+(?:[,.][0-9]+)?)\s*m(?:2|²)\b", text, re.I)
    return match.group(1).replace(",", ".") if match else None


def _extract_occupancy_status(raw_text: str) -> str | None:
    lowered = raw_text.lower()
    if re.search(r"sans\s+droit\s+ni\s+titre|squat", lowered):
        return "squatted"
    if re.search(r"propri[ée]taire\s+occupant|occup[ée]\s+par\s+le\s+propri[ée]taire", lowered):
        return "owner_occupied"
    if re.search(r"libre\s+de\s+toute\s+occupation|bien\s+libre|inoccup[ée]|vacant", lowered):
        return "vacant"
    if re.search(r"bail|locataire|lou[ée]|loyer", lowered):
        return "rented"
    if re.search(r"occup[ée]", lowered):
        return "occupied"
    return None


def _extract_visit_dates(raw_text: str) -> list[str]:
    dates: list[str] = []
    for match in re.finditer(r"Prochaine visite\s*:?\s*([0-9/]{8,10})", raw_text, re.I):
        dates.append(match.group(1))
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
