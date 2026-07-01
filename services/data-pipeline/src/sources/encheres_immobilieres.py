from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from src.config import TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, unique_dicts

BASE_URL = "https://encheresimmobilieres.fr"
LIST_URL = f"{BASE_URL}/biens-en-vente"
LOGGER = logging.getLogger(__name__)
SALE_BLOCK_RE = re.compile(
    r'\{\s*\\"id\\":\s*\d+\s*,\s*\\"titre\\":.*?\\"lots\\":\s*\[\s*\]\s*\}', re.S
)


def scrape_encheres_immobilieres_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_encheres_immobilieres_aquitaine_result(max_pages=max_pages).sales


def scrape_encheres_immobilieres_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    max_pages = max_pages or int(settings["encheres_immobilieres_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    for page_url in _list_urls(max_pages):
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("EncheresImmobilieres list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            continue
        for sale in parse_encheres_immobilieres_html(html):
            if sale.get("department") in TARGET_DEPARTMENTS:
                raw_sales.append(sale)

    return ScrapeResult(
        validate_raw_sales("encheres_immobilieres", unique_dicts(raw_sales, "source_url"), errors),
        errors,
    )


def parse_encheres_immobilieres_html(html: str) -> list[dict[str, Any]]:
    sales: list[dict[str, Any]] = []
    for item in _sale_objects(html):
        sale = _raw_sale(item)
        if sale:
            sales.append(sale)
    return sales


def _sale_objects(html: str) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for candidate in SALE_BLOCK_RE.findall(html):
        try:
            decoded = json.loads(f'"{candidate}"')
            item = json.loads(decoded)
        except json.JSONDecodeError:
            continue
        if item.get("titre") and item.get("url"):
            objects.append(item)
    return objects


def _raw_sale(item: dict[str, Any]) -> dict[str, Any] | None:
    slug = str(item.get("url") or "")
    if not slug:
        return None
    description = _html_text(item.get("complement")) or clean_text(item.get("description"))
    lawyer = item.get("avocat") if isinstance(item.get("avocat"), dict) else {}
    raw_text = "\n".join(
        filter(
            None,
            (
                clean_text(item.get("titre")),
                clean_text(item.get("adresse")),
                clean_text(item.get("complement")),
                clean_text(item.get("entete")),
                clean_text(item.get("ccv")),
                clean_text(item.get("complementVisite")),
            ),
        )
    )
    return {
        "source_name": "encheres_immobilieres",
        "source_url": urljoin(BASE_URL, f"/ventes/{slug}"),
        "external_id": str(item.get("id") or slug),
        "department": clean_text(item.get("departement")),
        "city": clean_text(item.get("ville")),
        "address": _join_address(item.get("adresse"), item.get("codePostal"), item.get("ville")),
        "postal_code": clean_text(item.get("codePostal")),
        "property_type": _property_type(item),
        "title": clean_text(item.get("titre")),
        "description": description,
        "surface_m2": _extract_surface(item.get("titre"), description),
        "rooms_count": _extract_rooms(item.get("titre")),
        "starting_price_eur": item.get("prix"),
        "adjudication_price_eur": item.get("prixAdjudication"),
        "sale_date": _date_value(item.get("dateVente")),
        "visit_dates": [clean_text(item.get("complementVisite"))] if clean_text(item.get("complementVisite")) else [],
        "lawyer_name": clean_text(lawyer.get("nom") or item.get("entete")),
        "lawyer_contact": clean_text(lawyer.get("tel") or lawyer.get("email")),
        "latitude": item.get("latitude"),
        "longitude": item.get("longitude"),
        "occupancy_status": _occupancy_status(description, raw_text),
        "status": "past" if item.get("prixAdjudication") else "upcoming",
        "documents": [],
        "raw_text": raw_text,
    }


def _list_urls(max_pages: int) -> list[str]:
    urls = [LIST_URL]
    for page in range(2, max_pages + 1):
        urls.append(f"{LIST_URL}?page={page}")
    return urls


def _html_text(value: Any) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    return clean_text(BeautifulSoup(text, "html.parser").get_text(" ", strip=True))


def _property_type(item: dict[str, Any]) -> str | None:
    title = clean_text(item.get("titre")) or ""
    match = re.search(r"\b(appartement|maison|villa|terrain|parking|stationnement|immeuble|parcelle)", title, re.I)
    return match.group(1) if match else clean_text(item.get("typeVente"))


def _extract_rooms(title: Any) -> int | None:
    # Nombre de pièces déduit du titre : "2P", "T3", "F4"…
    text = clean_text(title) or ""
    match = re.search(r"\b(\d{1,2})\s*[Pp]\b", text) or re.search(r"\b[TF]\s?(\d{1,2})\b", text)
    if not match:
        return None
    value = int(match.group(1))
    return value if 1 <= value <= 20 else None


def _extract_surface(*values: str | None) -> str | None:
    text = " ".join(value for value in (clean_text(v) for v in values) if value)
    match = re.search(r"([0-9][0-9\s.,]+)\s*m²", text, flags=re.I)
    return clean_text(match.group(1)) if match else None


def _date_value(value: Any) -> str | None:
    text = clean_text(value)
    return text[2:] if text and text.startswith("$D") else text


def _occupancy_status(*values: str | None) -> str | None:
    text = " ".join(value for value in (clean_text(v) for v in values) if value).lower()
    if re.search(r"\binoccup[ée]\b|\blibre\b", text):
        return "vacant"
    if re.search(r"\boccup[ée]\b|\blou[ée]\b", text):
        return "occupied"
    return None


def _join_address(address: Any, postal_code: Any, city: Any) -> str | None:
    parts = [clean_text(address), clean_text(postal_code), clean_text(city)]
    return ", ".join(part for part in parts if part) or None
