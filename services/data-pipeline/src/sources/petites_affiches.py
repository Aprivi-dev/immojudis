from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from src.config import AQUITAINE_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, unique_dicts


BASE_URL = "https://www.petitesaffiches.fr"
LIST_URL = f"{BASE_URL}/encheres-immobilieres/"
LOGGER = logging.getLogger(__name__)


def scrape_petites_affiches_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_petites_affiches_aquitaine_result(max_pages=max_pages).sales


def scrape_petites_affiches_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
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
            html = client.post_form(LIST_URL, {"historique": "0", "select_dep": department})
        except Exception as exc:
            LOGGER.error("Petites Affiches list fetch failed for department %s: %s", department, exc)
            errors.append(f"department {department}: {exc}")
            continue
        raw_sales.extend(parse_petites_affiches_html(html, page_url=LIST_URL, fallback_department=department))

    return ScrapeResult(
        validate_raw_sales("petites_affiches", unique_dicts(raw_sales, "source_url"), errors),
        errors,
    )


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


def _extract_postal(text: str) -> str | None:
    match = re.search(r"\b((?:24|33|40|47|64)\d{3})\b", text)
    return match.group(1) if match else None


def _extract_lawyer(text: str) -> str | None:
    match = re.search(r"\b(?:Ma[îi]tre|SELARL|SELAS|SCP)\b[^\n|]{0,80}", text, re.I)
    return clean_text(match.group(0)) if match else None


def _node_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None
