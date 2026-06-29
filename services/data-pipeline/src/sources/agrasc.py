from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from src.config import TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, unique_dicts


BASE_URL = "https://agrasc.gouv.fr"
LIST_URL = f"{BASE_URL}/ventes-aux-encheres"
LOGGER = logging.getLogger(__name__)


def scrape_agrasc_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_agrasc_aquitaine_result(max_pages=max_pages).sales


def scrape_agrasc_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    try:
        html = client.get(LIST_URL)
    except Exception as exc:
        LOGGER.error("AGRASC list fetch failed: %s", exc)
        errors.append(f"{LIST_URL}: {exc}")
    else:
        for sale in parse_agrasc_html(html, page_url=LIST_URL):
            if sale.get("department") in TARGET_DEPARTMENTS:
                raw_sales.append(sale)

    return ScrapeResult(validate_raw_sales("agrasc", unique_dicts(raw_sales, "source_url"), errors), errors)


def parse_agrasc_html(html: str, page_url: str = LIST_URL) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for card in soup.select(".card-vente-immo"):
        sale = _parse_card(card, page_url)
        if sale:
            sales.append(sale)
    return sales


def _parse_card(card: Tag, page_url: str) -> dict[str, Any] | None:
    link = card.select_one(".fr-card__title a[href]")
    if link is None:
        return None
    raw_text = "\n".join(
        line for line in (clean_text(part) for part in card.get_text("\n", strip=True).splitlines()) if line
    )
    city, department = _location(_first_detail(card))
    title = clean_text(link.get_text(" ", strip=True))
    image = card.select_one("img")
    image_url = urljoin(page_url, str(image.get("src"))) if image and image.get("src") else None
    return {
        "source_name": "agrasc",
        "source_url": urljoin(page_url, str(link.get("href"))),
        "external_id": _external_id(str(link.get("href"))),
        "department": department,
        "city": city,
        "property_type": title,
        "title": title,
        "description": _node_text(card.select_one(".fr-card__desc")),
        "surface_m2": _extract_surface(raw_text),
        "starting_price_eur": _extract_after(raw_text, r"MAP\s*:?\s*([0-9][0-9\s.,]+)\s*€"),
        "sale_date": _extract_sale_window(card),
        "status": "upcoming" if re.search(r"\bEn cours\b", raw_text, re.I) else "unknown",
        "documents": [],
        "raw_text": raw_text,
        "raw_image_url": image_url,
    }


def _first_detail(card: Tag) -> str | None:
    for node in card.select(".fr-card__detail"):
        text = clean_text(node.get_text(" ", strip=True))
        if text and re.search(r"\(\d{2,3}\)", text):
            return text
    return None


def _location(text: str | None) -> tuple[str | None, str | None]:
    if not text:
        return None, None
    match = re.search(r"(.+?)\s*\((\d{2,3})\)", text)
    if not match:
        return None, None
    return clean_text(match.group(1)), match.group(2)


def _extract_sale_window(card: Tag) -> str | None:
    for node in card.select(".fr-card__detail"):
        text = clean_text(node.get_text(" ", strip=True))
        if text and re.search(r"\b\d{1,2}\b.*\b20\d{2}\b", text):
            return text
    return None


def _extract_surface(text: str) -> str | None:
    return _extract_after(text, r"([0-9][0-9\s.,]+)\s*m²")


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.I)
    return clean_text(match.group(1)) if match else None


def _external_id(url: str) -> str:
    return url.rstrip("/").split("/")[-1] or url


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None
