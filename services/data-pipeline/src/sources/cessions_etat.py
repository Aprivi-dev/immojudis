from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from src.config import AQUITAINE_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts


BASE_URL = "https://cessions.immobilier-etat.gouv.fr"
LIST_URL = f"{BASE_URL}/"
LOGGER = logging.getLogger(__name__)
DETAIL_FIELDS = {
    "description",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "documents",
    "raw_text",
    "surface_m2",
    "postal_code",
}


def scrape_cessions_etat_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_cessions_etat_aquitaine_result(max_pages=max_pages).sales


def scrape_cessions_etat_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
        # ponytail: the public site currently serves an incomplete cert chain to Python/httpx.
        verify=False,
    )
    max_pages = max_pages or int(settings["cessions_etat_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    for page_url in _list_urls(max_pages):
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("Cessions Etat list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            continue
        for sale in parse_cessions_etat_html(html, page_url=page_url):
            if sale.get("department") not in AQUITAINE_DEPARTMENTS:
                continue
            if should_fetch_detail(sale, known):
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)

    return ScrapeResult(
        validate_raw_sales("cessions_etat", unique_dicts(raw_sales, "source_url"), errors),
        errors,
    )


def parse_cessions_etat_html(html: str, page_url: str = LIST_URL) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select("div[id^='bien-'][data-url]"):
        sale = _parse_card(card, page_url)
        if sale:
            sales.append(sale)
    return sales


def parse_cessions_etat_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    return {
        "source_name": "cessions_etat",
        "source_url": source_url,
        "description": _description(soup),
        "surface_m2": _extract_surface(raw_text),
        "postal_code": _extract_postal(raw_text),
        "starting_price_eur": _extract_after(raw_text, r"(?:Prix|Mise a prix|Mise à prix)\s*:?\s*([0-9][0-9\s.,]+)\s*€"),
        "sale_date": _extract_after(raw_text, r"(?:Date limite|Fin de candidature|Cl[oô]ture)\s*:?\s*([^\n]+)"),
        "visit_dates": _visit_dates(raw_text),
        "documents": _documents(soup, source_url),
        "raw_text": raw_text,
    }


def _parse_card(card: Tag, page_url: str) -> dict[str, Any] | None:
    source_url = urljoin(page_url, str(card.get("data-url") or ""))
    if not source_url:
        return None
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in card.get_text("\n", strip=True).splitlines()) if line
    )
    title = clean_text(card.get("data-titre")) or _node_text(card.select_one(".fr-card__title"))
    city, department = _location(clean_text(card.get("data-localisation")) or raw_text)
    image = _first_image(card, page_url)
    return {
        "source_name": "cessions_etat",
        "source_url": source_url,
        "external_id": str(card.get("data-nid") or card.get("node_id") or card.get("id") or source_url),
        "department": department,
        "city": city,
        "postal_code": _extract_postal(raw_text),
        "surface_m2": _extract_surface(raw_text),
        "property_type": clean_text(card.get("data-type-bien")),
        "title": title,
        "description": title,
        "latitude": card.get("data-lat") or None,
        "longitude": card.get("data-lng") or None,
        "status": "past" if re.search(r"\bexpir[ée]\b", raw_text, re.I) else "unknown",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": image,
        "source_blocks": {"reference": _extract_after(raw_text, r"R[ée]f[ée]rence\s*:\s*([^\n]+)")},
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
        return
    detail = parse_cessions_etat_detail_html(html, source_url)
    for key in DETAIL_FIELDS:
        value = detail.get(key)
        if value and (key == "documents" or not sale.get(key)):
            sale[key] = value


def _location(text: str | None) -> tuple[str | None, str | None]:
    if not text:
        return None, None
    match = re.search(r"(.+?)\s*-\s*(\d{2,3})\b", text)
    if not match:
        return None, None
    return clean_text(match.group(1)), match.group(2)


def _first_image(card: Tag, page_url: str) -> str | None:
    image = card.find("img")
    if image and (image.get("src") or image.get("data-src")):
        return urljoin(page_url, str(image.get("src") or image.get("data-src")))
    images = str(card.get("data-images") or "").split(",")
    return urljoin(page_url, images[0]) if images and images[0].strip() else None


def _description(soup: BeautifulSoup) -> str | None:
    for selector in (".field--name-body", ".fr-card__desc", "article"):
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
        if ".pdf" not in href.lower() and "document" not in (text or "").lower():
            continue
        documents.append({"label": text or "document", "url": urljoin(page_url, href), "type": "document"})
    return documents


def _visit_dates(text: str) -> list[str]:
    return re.findall(r"(?:Visite|Visites)\s*:?\s*([^\n]+)", text, flags=re.I)


def _extract_surface(text: str) -> str | None:
    match = re.search(r"(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:²|2)\b", text, flags=re.I)
    return clean_text(match.group(1)) if match else None


def _extract_postal(text: str) -> str | None:
    match = re.search(r"\b((?:24|33|40|47|64)\d{3})\b", text)
    return match.group(1) if match else None


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.I)
    return clean_text(match.group(1)) if match else None


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None
