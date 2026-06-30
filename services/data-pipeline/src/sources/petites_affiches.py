from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from src.config import FRENCH_POSTAL_CODE_PATTERN, FRANCE_DEPARTMENTS, TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts


BASE_URL = "https://www.petitesaffiches.fr"
LIST_URL = f"{BASE_URL}/encheres-immobilieres/"
LOGGER = logging.getLogger(__name__)
DETAIL_FIELDS = {
    "description",
    "address",
    "postal_code",
    "surface_m2",
    "starting_price_eur",
    "lawyer_name",
    "lawyer_contact",
    "tribunal",
    "raw_text",
}


def scrape_petites_affiches_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_petites_affiches_aquitaine_result(max_pages=max_pages).sales


def scrape_petites_affiches_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    for department in _department_filters():
        try:
            form = {"historique": "0"}
            if department is not None:
                form["select_dep"] = department
            html = client.post_form(LIST_URL, form)
        except Exception as exc:
            LOGGER.error("Petites Affiches list fetch failed for department %s: %s", department, exc)
            errors.append(f"department {department}: {exc}")
            continue
        for sale in parse_petites_affiches_html(html, page_url=LIST_URL, fallback_department=department):
            if should_fetch_detail(sale, known):
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)

    return ScrapeResult(
        validate_raw_sales("petites_affiches", unique_dicts(raw_sales, "source_url"), errors),
        errors,
    )


def _department_filters() -> tuple[str | None, ...]:
    if set(TARGET_DEPARTMENTS) == set(FRANCE_DEPARTMENTS):
        return (None,)
    return TARGET_DEPARTMENTS


def parse_petites_affiches_html(
    html: str,
    page_url: str = LIST_URL,
    fallback_department: str | None = None,
) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select("div[class*='annonce_lot_']"):
        sale = _parse_card(card, page_url, fallback_department)
        if sale:
            sales.append(sale)
    return sales


def _parse_card(card: Tag, page_url: str, fallback_department: str | None) -> dict[str, Any] | None:
    link = card.select_one(".titreVente a[href]") or card.select_one(".imgList a[href]")
    if link is None:
        return None
    source_url = urljoin(page_url, str(link.get("href")))
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in card.get_text("\n", strip=True).splitlines()) if line
    )
    title, reference, property_type = _title_reference_type(link.get_text(" ", strip=True))
    image = card.select_one(".imgList img")
    image_url = urljoin(page_url, str(image.get("data-src") or image.get("src"))) if image else None
    tribunal = _node_text(card.select_one(".lieuVente strong"))
    city = _node_text(card.select_one(".lot-adresse"))

    return {
        "source_name": "petites_affiches",
        "source_url": source_url,
        "external_id": _external_id(card, source_url),
        "department": fallback_department,
        "city": city,
        "property_type": property_type,
        "title": title,
        "description": title,
        "starting_price_eur": _node_text(card.select_one(".miseAPrix strong")),
        "sale_date": _node_text(card.select_one(".dateVente strong")),
        "surface_m2": _extract_surface(raw_text),
        "postal_code": _extract_postal(raw_text),
        "lawyer_name": _extract_lawyer(raw_text),
        "tribunal": tribunal,
        "status": "upcoming",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": image_url,
        "source_blocks": {"reference": reference, "type_vente": _node_text(card.select_one(".typeVente strong"))},
    }


def parse_petites_affiches_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    page_text = "\n".join(
        line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    detail_text = _scoped_text(soup.select_one(".row.detail")) or page_text
    contact_text = _scoped_text(soup.select_one(".contact-container")) or page_text
    address = _detail_address(soup)
    description = _meta_description(soup)
    price = _extract_price(detail_text)
    tribunal = _detail_tribunal(soup)
    lawyer_name = _extract_lawyer(contact_text)
    lawyer_contact = _extract_phone(contact_text)
    blocks = [
        description,
        f"Adresse: {address}" if address else None,
        f"Mise a prix: {price}" if price else None,
        f"Tribunal: {tribunal}" if tribunal else None,
        f"Avocat: {lawyer_name}" if lawyer_name else None,
        f"Contact: {lawyer_contact}" if lawyer_contact else None,
    ]
    return {
        "source_name": "petites_affiches",
        "source_url": source_url,
        "description": description,
        "address": address,
        "postal_code": _extract_postal(address or ""),
        "surface_m2": _extract_surface(detail_text),
        "starting_price_eur": price,
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "tribunal": tribunal,
        "raw_text": "\n".join(part for part in blocks if part),
    }


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Petites Affiches detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        return
    detail = parse_petites_affiches_detail_html(html, source_url)
    for key in DETAIL_FIELDS:
        value = detail.get(key)
        if value in (None, "", []):
            continue
        if key == "raw_text" and sale.get("raw_text"):
            sale[key] = f"{sale['raw_text']}\n{value}"
        elif not sale.get(key):
            sale[key] = value


def _title_reference_type(text: str) -> tuple[str | None, str | None, str | None]:
    text = clean_text(text)
    if not text:
        return None, None, None
    title = re.split(r"\bRef\.\s*:", text, maxsplit=1, flags=re.I)[0].strip()
    ref_match = re.search(r"Ref\.\s*:\s*([0-9]+)\s*-\s*([^|]+)$", text, re.I)
    if not ref_match:
        return title, None, None
    return title, ref_match.group(1).strip(), clean_text(ref_match.group(2))


def _external_id(card: Tag, source_url: str) -> str:
    for class_name in card.get("class") or []:
        match = re.search(r"annonce_lot_(\d+)", str(class_name))
        if match:
            return match.group(1)
    match = re.search(r"-(\d+)\.html", source_url)
    return match.group(1) if match else source_url.rstrip("/").split("/")[-1]


def _extract_surface(text: str) -> str | None:
    match = re.search(r"(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:²|2)\b", text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_price(text: str) -> str | None:
    match = re.search(r"Mise\s*[àa]\s*Prix\s*:?\s*([0-9][0-9\s.,]+)\s*€", text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_postal(text: str) -> str | None:
    match = re.search(rf"\b({FRENCH_POSTAL_CODE_PATTERN})\b", text)
    return match.group(1) if match else None


def _extract_lawyer(text: str) -> str | None:
    match = re.search(r"\b(?:Ma[îi]tre|SELARL|SELAS|SCP)\b[^\n|]{0,80}", text, re.I)
    return clean_text(match.group(0)) if match else None


def _extract_phone(text: str) -> str | None:
    match = re.search(r"\b(?:0|\+33\s?)[1-9](?:[\s.()-]?\d{2}){4}\b", text)
    return clean_text(match.group(0)) if match else None


def _detail_address(soup: BeautifulSoup) -> str | None:
    node = soup.select_one(".lot-adresse h4")
    text = clean_text(node.get_text(" ", strip=True)) if node else None
    if not text:
        return None
    return clean_text(re.sub(r"^Adresse\s*:\s*", "", text, flags=re.I))


def _detail_tribunal(soup: BeautifulSoup) -> str | None:
    node = soup.select_one(".lieu-vente strong a") or soup.select_one(".lieu-vente strong")
    return clean_text(node.get_text(" ", strip=True)) if node else None


def _meta_description(soup: BeautifulSoup) -> str | None:
    node = soup.find("meta", attrs={"name": "description"})
    return clean_text(node.get("content")) if node and node.get("content") else None


def _scoped_text(node: Tag | None) -> str | None:
    if node is None:
        return None
    return "\n".join(line for line in (clean_text(part) for part in node.get_text("\n", strip=True).splitlines()) if line)


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None
