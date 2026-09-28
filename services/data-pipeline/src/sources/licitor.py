from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from src.catalogue_proof import CatalogueEvidence
from src.config import FRENCH_POSTAL_CODE_PATTERN, TARGET_DEPARTMENTS, load_settings
from src.normalize import (
    SURFACE_VALUE_PATTERN,
    clean_text,
    extract_department,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
)
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PoliteHttpClient, ScrapeResult, is_allowed_origin_url, parse_html
from src.sources.image_candidates import html_image_candidates

BASE_URL = "https://www.licitor.com"
ALLOWED_ORIGINS = (BASE_URL, "https://licitor.com")
LICITOR_ZONE_URLS = (
    f"{BASE_URL}/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/prochaines-ventes.html",
    f"{BASE_URL}/ventes-aux-encheres-immobilieres/regions-du-nord-est/prochaines-ventes.html",
    f"{BASE_URL}/ventes-aux-encheres-immobilieres/bretagne-grand-ouest/prochaines-ventes.html",
    f"{BASE_URL}/ventes-aux-encheres-immobilieres/centre-loire-limousin/prochaines-ventes.html",
    f"{BASE_URL}/ventes-aux-encheres-immobilieres/sud-ouest-pyrenees/prochaines-ventes.html",
    f"{BASE_URL}/ventes-aux-encheres-immobilieres/sud-est-mediterrannee/prochaines-ventes.html",
)
AQUITAINE_URL = LICITOR_ZONE_URLS[4]
LOGGER = logging.getLogger(__name__)


class LicitorClient(PoliteHttpClient):
    def __init__(self, user_agent: str, delay_seconds: float, timeout_seconds: float):
        super().__init__(base_url=BASE_URL, user_agent=user_agent,
                         delay_seconds=delay_seconds, timeout_seconds=timeout_seconds,
                         allowed_redirect_origins=ALLOWED_ORIGINS)


@dataclass
class RobotsRules:
    disallow: tuple[str, ...] = ()
    allow: tuple[str, ...] = ()

    @classmethod
    def parse(cls, text: str, user_agent: str) -> RobotsRules:
        groups: list[tuple[list[str], list[tuple[str, str]]]] = []
        agents: list[str] = []
        rules: list[tuple[str, str]] = []
        for raw_line in text.splitlines():
            line = raw_line.split("#", 1)[0].strip()
            if not line:
                if agents or rules:
                    groups.append((agents, rules))
                    agents, rules = [], []
                continue
            if ":" not in line:
                continue
            key, value = [part.strip() for part in line.split(":", 1)]
            key = key.lower()
            if key == "user-agent":
                if rules:
                    groups.append((agents, rules))
                    agents, rules = [], []
                agents.append(value.lower())
            elif key in {"allow", "disallow"} and agents:
                rules.append((key, value))
        if agents or rules:
            groups.append((agents, rules))

        ua = user_agent.lower()
        selected = []
        for group_agents, group_rules in groups:
            if any(agent != "*" and agent in ua for agent in group_agents):
                selected = group_rules
                break
            if not selected and "*" in group_agents:
                selected = group_rules

        return cls(
            disallow=tuple(value for key, value in selected if key == "disallow" and value),
            allow=tuple(value for key, value in selected if key == "allow" and value),
        )

    def can_fetch(self, url: str) -> bool:
        path = urlparse(url).path or "/"
        matched_allow = max((rule for rule in self.allow if path.startswith(rule)), key=len, default="")
        matched_disallow = max((rule for rule in self.disallow if path.startswith(rule)), key=len, default="")
        return len(matched_allow) >= len(matched_disallow)


def scrape_licitor_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_licitor_aquitaine_result(max_pages=max_pages).sales


def scrape_licitor_aquitaine_result(max_pages: int | None = None, fetch_details: bool = True, known: dict[str, str] | None = None) -> ScrapeResult:
    """Collect Licitor listings as an optional benchmark source."""
    settings = load_settings()
    client = LicitorClient(
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    max_pages = max_pages or int(settings["licitor_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    if not fetch_details:
        raw_sales = _collect_list_sales(client, max_pages=max_pages, errors=errors)
        return ScrapeResult(
            validate_raw_sales("licitor", raw_sales, errors),
            errors,
            {**getattr(client, "coverage_metrics", lambda: {})(),
             **(client.catalogue_evidence.metrics(raw_sales, errors) if hasattr(client, "catalogue_evidence") else {})},
        )

    listing_by_url = {sale["source_url"]: sale for sale in _collect_list_sales(client, max_pages=max_pages, errors=errors)}
    detail_urls = list(listing_by_url)
    seen: set[str] = set()
    from src.sources.common import should_fetch_detail

    for detail_url in detail_urls:
        if detail_url in seen:
            continue
        seen.add(detail_url)
        summary = listing_by_url[detail_url]
        if not should_fetch_detail(summary, known):
            raw_sales.append(summary)
            continue
        try:
            detail_html = client.get(detail_url)
        except Exception as exc:
            LOGGER.error("Licitor detail fetch failed for %s: %s", detail_url, exc)
            errors.append(f"{detail_url}: {exc}")
            summary["_detail_fetch_failed"] = True
            summary["source_detail_status"] = "failed"
            raw_sales.append(summary)
            continue
        sale = parse_licitor_detail_html(detail_html, detail_url)
        if summary.get("_checkpoint_signature"):
            sale["_checkpoint_signature"] = summary["_checkpoint_signature"]
            sale["_discovered_at"] = summary.get("_discovered_at")
        sale["source_lots"] = listing_by_url[detail_url].get("source_lots", [])
        sale.setdefault("source_blocks", {})["lots_publics"] = "\n\n".join(lot["raw_text"] for lot in sale["source_lots"])
        postal_code = sale.get("postal_code")
        department = str(sale.get("department") or extract_department(str(postal_code) if postal_code else None) or "")
        if department and department not in TARGET_DEPARTMENTS:
            continue
        raw_sales.append(sale)
    return ScrapeResult(
        validate_raw_sales("licitor", raw_sales, errors),
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
             **(client.catalogue_evidence.metrics(raw_sales, errors) if hasattr(client, "catalogue_evidence") else {})},
    )


def parse_licitor_list_html(html: str, page_url: str = AQUITAINE_URL) -> tuple[list[str], list[str]]:
    soup = parse_html(html, "html.parser")
    detail_urls: list[str] = []
    next_urls: list[str] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href"))
        absolute = urljoin(page_url, href)
        if not is_allowed_origin_url(absolute, ALLOWED_ORIGINS):
            continue
        if re.search(r"/annonce/.+/\d+\.html$", href):
            detail_urls.append(absolute)
        elif re.search(r"/ventes-aux-encheres-immobilieres/.+/prochaines-ventes\.html\?p=", href):
            next_urls.append(absolute)
    return _unique(detail_urls), _unique(next_urls)


def parse_licitor_list_sales(html: str, page_url: str = AQUITAINE_URL) -> list[dict[str, Any]]:
    soup = parse_html(html, "html.parser")
    sales: list[dict[str, Any]] = []
    by_url: dict[str, dict[str, Any]] = {}
    for link in soup.find_all("a", href=True):
        href = str(link.get("href"))
        if not re.search(r"/annonce/.+/\d+\.html$", href):
            continue
        source_url = urljoin(page_url, href)
        if not is_allowed_origin_url(source_url, ALLOWED_ORIGINS):
            continue
        container = _list_item_container(link)
        raw_text = "\n".join(
            line
            for line in (
                clean_text(part)
                for part in (container or link).get_text("\n", strip=True).splitlines()
            )
            if line
        )
        sale = _parse_list_sale(source_url, raw_text)
        if sale:
            sale["source_lots"] = [{"raw_text": raw_text, "title": sale.get("title"),
                                    "starting_price_eur": sale.get("starting_price_eur")}]
            if source_url in by_url:
                _merge_listing_lots(by_url[source_url], sale)
            else:
                by_url[source_url] = sale
                sales.append(sale)
    return sales


def parse_licitor_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = parse_html(html, "html.parser")
    lines = [line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line]
    raw_text = "\n".join(lines)

    title = _extract_title(soup, lines, raw_text)
    city = _extract_city(soup, lines, raw_text)
    postal_code = _extract_postal_code(soup, raw_text, city)
    department = _extract_department(raw_text) or extract_department(postal_code)
    address = _extract_address(soup, lines, city, postal_code)
    lawyer_name, lawyer_contact = _extract_lawyer(lines)
    latitude, longitude = _extract_coordinates(soup)
    description = _extract_description(soup, title)
    images = _extract_images(soup, source_url)
    tribunal = _extract_after(raw_text, r"(Tribunal\s+Judiciaire[^\n]+)")
    surface = _extract_surface_m2(raw_text)
    # Restrict enriched fields to the listing title/lot block. The page-wide
    # text contains navigation and generic labels that can look like facts.
    detail_text = description or title or ""
    carrez_surface = _extract_qualified_surface(detail_text, "carrez")
    habitable_surface = _extract_qualified_surface(detail_text, "habitable")
    land_surface = _extract_land_surface_m2(detail_text)
    rooms_count = _extract_rooms_count(detail_text, title)
    parking_count = _extract_parking_count(detail_text)
    property_type = _extract_property_type(title, detail_text)
    starting_price = _extract_after(raw_text, r"Mise à prix\s*:?\s*([^\n]+)")
    sale_date = _extract_sale_date(lines)
    visit_dates = _extract_visit_dates(lines)
    occupancy_status = _extract_occupancy_status(detail_text)
    documents = _extract_documents(soup, source_url)
    status = "unknown"
    for line in lines:
        if re.fullmatch(r"Vente\s+non\s+requise\.?", line, re.I):
            status = "withdrawn"
            break
        if re.fullmatch(r"Vente\s+report[ée]e(?:\s+.*)?", line, re.I):
            status = "postponed"
            break
        if re.fullmatch(r"Vente\s+annul[ée]e\.?", line, re.I):
            status = "cancelled"
            break

    return {
        "source_name": "licitor",
        "source_url": source_url,
        "external_id": _extract_external_id(source_url, raw_text),
        "tribunal": tribunal,
        "department": department or extract_department(postal_code),
        "city": city,
        "address": address,
        "postal_code": postal_code,
        "property_type": property_type,
        "title": title,
        "description": description or title,
        "surface_m2": surface,
        "habitable_surface_m2": habitable_surface,
        "carrez_surface_m2": carrez_surface,
        "land_surface_m2": land_surface,
        "rooms_count": rooms_count,
        "parking_count": parking_count,
        "starting_price_eur": starting_price,
        "sale_date": sale_date,
        "visit_dates": visit_dates,
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "status": status,
        "occupancy_status": occupancy_status,
        "latitude": latitude,
        "longitude": longitude,
        "documents": documents,
        "source_images": images,
        "raw_image_url": images[0] if images else None,
        "raw_text": raw_text,
        "source_blocks": {
            key: value
            for key, value in {
                "titre": title,
                "description": description,
                "tribunal": tribunal,
                "adresse": address,
                "ville": city,
                "code_postal": postal_code,
                "surface": surface,
                "surface_habitable": habitable_surface,
                "surface_carrez": carrez_surface,
                "surface_terrain": land_surface,
                "pieces": rooms_count,
                "stationnement": parking_count,
                "mise_a_prix": starting_price,
                "date_vente": sale_date,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "avocat": lawyer_name,
                "contact_avocat": lawyer_contact,
                "occupation": occupancy_status,
                "documents": "; ".join(document["label"] for document in documents if document.get("label"))
                or None,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _collect_detail_urls(client: LicitorClient, max_pages: int, errors: list[str]) -> list[str]:
    detail_urls: list[str] = []

    for start_url in _start_urls_for_target_departments():
        pending = [start_url]
        visited: set[str] = set()
        while pending and len(visited) < max_pages:
            page_url = pending.pop(0)
            if page_url in visited:
                continue
            visited.add(page_url)
            try:
                html = client.get(page_url)
            except Exception as exc:
                LOGGER.error("Licitor list fetch failed for %s: %s", page_url, exc)
                errors.append(f"{page_url}: {exc}")
                continue
            page_detail_urls, next_urls = parse_licitor_list_html(html, page_url)
            detail_urls.extend(page_detail_urls)
            pending.extend(url for url in next_urls if url not in visited and url not in pending)
        if pending:
            errors.append(f"Pagination incomplete at {start_url}: page limit {max_pages}")
    return _unique(detail_urls)


def _collect_list_sales(client: LicitorClient, max_pages: int, errors: list[str]) -> list[dict[str, Any]]:
    raw_sales: list[dict[str, Any]] = []
    client.catalogue_evidence = CatalogueEvidence("licitor")
    by_url: dict[str, dict[str, Any]] = {}
    for start_url in _start_urls_for_target_departments():
        pending = [start_url]
        visited: set[str] = set()
        while pending and len(visited) < max_pages:
            page_url = pending.pop(0)
            if page_url in visited:
                continue
            visited.add(page_url)
            try:
                html = client.get(page_url)
            except Exception as exc:
                LOGGER.error("Licitor list fetch failed for %s: %s", page_url, exc)
                errors.append(f"{page_url}: {exc}")
                continue
            parsed = parse_licitor_list_sales(html, page_url)
            client.catalogue_evidence.observe(html, page_url, parsed)
            for sale in parsed:
                source_url = str(sale.get("source_url") or "")
                if source_url in by_url:
                    _merge_listing_lots(by_url[source_url], sale)
                    continue
                by_url[source_url] = sale
                department = str(sale.get("department") or "")
                if department and department not in TARGET_DEPARTMENTS:
                    continue
                raw_sales.append(sale)
            _, next_urls = parse_licitor_list_html(html, page_url)
            pending.extend(url for url in next_urls if url not in visited and url not in pending)
        if pending:
            errors.append(f"Pagination incomplete at {start_url}: page limit {max_pages}")
    return raw_sales


def _merge_listing_lots(target: dict[str, Any], incoming: dict[str, Any]) -> None:
    lots = target.setdefault("source_lots", [])
    for lot in incoming.get("source_lots", []):
        if lot not in lots:
            lots.append(lot)
    target["raw_text"] = "\n\n".join(lot["raw_text"] for lot in lots)
    target.setdefault("source_blocks", {})["lots_publics"] = target["raw_text"]


def _start_urls_for_target_departments() -> tuple[str, ...]:
    aquitaine = {"24", "33", "40", "47", "64"}
    if set(TARGET_DEPARTMENTS).issubset(aquitaine):
        return (AQUITAINE_URL,)
    return LICITOR_ZONE_URLS


def _list_item_container(link: Any) -> Any:
    if "Mise à prix" in link.get_text(" ", strip=True) or "Mise a prix" in link.get_text(" ", strip=True):
        return link
    node = link
    for _ in range(5):
        parent = getattr(node, "parent", None)
        if parent is None:
            break
        text = parent.get_text(" ", strip=True)
        if "Mise à prix" in text or "Mise a prix" in text:
            return parent
        node = parent
    return link


def _parse_list_sale(source_url: str, raw_text: str) -> dict[str, Any] | None:
    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    if not lines:
        return None
    department = next((line for line in lines if re.fullmatch(r"\d{2,3}|2A|2B", line)), None)
    department_index = lines.index(department) if department in lines else -1
    city = lines[department_index + 1] if department_index >= 0 and department_index + 1 < len(lines) else None
    title = lines[department_index + 2] if department_index >= 0 and department_index + 2 < len(lines) else None
    price = _list_value_after(lines, r"Mise à prix")
    sale_date = lines[-1] if lines else None
    description_lines = []
    if department_index >= 0:
        for line in lines[department_index + 3 :]:
            if re.match(r"Mise à prix", line, re.I):
                break
            description_lines.append(line)
    description = clean_text(" ".join(description_lines)) or title
    surface = _extract_surface_m2(raw_text)
    return {
        "source_name": "licitor",
        "source_url": source_url,
        "external_id": _extract_external_id(source_url, raw_text),
        "department": department,
        "city": city,
        "property_type": title,
        "title": title,
        "description": description,
        "surface_m2": surface,
        "starting_price_eur": price,
        "sale_date": sale_date,
        "status": "unknown",
        "documents": [],
        "raw_text": raw_text,
        "source_blocks": {
            key: value
            for key, value in {
                "departement": department,
                "ville": city,
                "titre": title,
                "description": description,
                "surface": surface,
                "mise_a_prix": price,
                "date_vente": sale_date,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _list_value_after(lines: list[str], label_pattern: str) -> str | None:
    for index, line in enumerate(lines):
        if not re.match(label_pattern, line, re.I):
            continue
        inline_value = re.sub(rf"^{label_pattern}\s*:?\s*", "", line, flags=re.I).strip(" :")
        if inline_value:
            return clean_text(inline_value)
        if index + 1 < len(lines):
            return clean_text(lines[index + 1])
    return None


def _extract_external_id(source_url: str, raw_text: str) -> str | None:
    match = re.search(r"/(\d+)\.html$", source_url) or re.search(r"Annonce n[°º]\s*(\d+)", raw_text)
    return match.group(1) if match else None


def _extract_title(soup: BeautifulSoup, lines: list[str], raw_text: str) -> str | None:
    structured = soup.select_one(".AddressBlock .SousLot h2")
    if structured:
        title = clean_text(structured.get_text(" ", strip=True))
        if title:
            return title
    h1 = soup.select_one("#legalad-search h1")
    if h1:
        match = re.search(r"Annonce n[°º]\d+\s*:\s*(.+?)\s+à\s+[^,]+", h1.get_text(" ", strip=True), re.I)
        if match:
            return clean_text(match.group(1))
    for index, line in enumerate(lines):
        if re.match(r"Mise à prix", line, re.I) and index > 0:
            return lines[index - 1]
    match = re.search(r"Annonce n[°º]\d+\s*:\s*(.+?),\s+mise à prix", raw_text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_city(soup: BeautifulSoup, lines: list[str], raw_text: str) -> str | None:
    structured = soup.select_one(".AddressBlock .Location .City")
    if structured:
        city = _clean_city(structured.get_text(" ", strip=True))
        if city:
            return city
    h1 = soup.select_one("#legalad-search h1")
    if h1:
        match = re.search(r"\sà\s+([^,()]+)\s+\([^)]+\)", h1.get_text(" ", strip=True), re.I)
        if match:
            return _clean_city(match.group(1))
    for index, line in enumerate(lines):
        if re.match(r"Mise à prix", line, re.I) and index + 1 < len(lines):
            candidate = lines[index + 1]
            if not re.search(r"Afficher|exactitude|Visite", candidate, re.I):
                return _clean_city(candidate)
    match = re.search(r"\sà\s+([^()\n]+)\s+\(([^)\n]+)\)", raw_text, re.I)
    return _clean_city(match.group(1)) if match else None


def _clean_city(value: object | None) -> str | None:
    city = clean_text(value)
    if not city:
        return None
    return clean_text(re.sub(r"\s*\([^)]*\)\s*$", "", city))


def _extract_department(raw_text: str) -> str | None:
    department_names = {
        "dordogne": "24",
        "gironde": "33",
        "landes": "40",
        "lot-et-garonne": "47",
        "pyrenees-atlantiques": "64",
        "pyrénées-atlantiques": "64",
    }
    lowered = raw_text.lower()
    for name, code in department_names.items():
        if name in lowered:
            return code
    return None


def _extract_postal_code(soup: BeautifulSoup, raw_text: str, city: str | None = None) -> str | None:
    location = soup.select_one(".AddressBlock .Location")
    if location:
        location_text = location.get_text(" ", strip=True)
        match = re.search(rf"\b({FRENCH_POSTAL_CODE_PATTERN})\b", location_text)
        if match:
            return match.group(1)
    arrondissement_postal_code = _postal_code_from_arrondissement(city)
    if arrondissement_postal_code:
        return arrondissement_postal_code
    h1 = soup.select_one("#legalad-search h1")
    if h1:
        arrondissement_postal_code = _postal_code_from_arrondissement(h1.get_text(" ", strip=True))
        if arrondissement_postal_code:
            return arrondissement_postal_code
    match = _postal_code_near_city(raw_text, city)
    if match:
        return match
    if city:
        return None
    match = re.search(rf"\b({FRENCH_POSTAL_CODE_PATTERN})\b", raw_text)
    return match.group(1) if match else None


def _postal_code_near_city(raw_text: str, city: str | None) -> str | None:
    city_text = clean_text(city)
    if not city_text:
        return None
    city_pattern = re.escape(re.sub(r"\s+\d+(?:er|[eè]me|eme)$", "", city_text, flags=re.I))
    patterns = (
        rf"\b({FRENCH_POSTAL_CODE_PATTERN})\s+{city_pattern}\b",
        rf"\b{city_pattern}\s+\(?({FRENCH_POSTAL_CODE_PATTERN})\)?\b",
    )
    for pattern in patterns:
        match = re.search(pattern, raw_text, re.I)
        if match:
            return match.group(1)
    return None


def _postal_code_from_arrondissement(value: object | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"\b(Paris|Lyon|Marseille)\s+(\d{1,2})(?:er|[eè]me|eme)\b", text, re.I)
    if not match:
        return None
    city = match.group(1).lower()
    arrondissement = int(match.group(2))
    if city == "paris" and 1 <= arrondissement <= 20:
        return f"750{arrondissement:02d}"
    if city == "lyon" and 1 <= arrondissement <= 9:
        return f"6900{arrondissement}"
    if city == "marseille" and 1 <= arrondissement <= 16:
        return f"130{arrondissement:02d}"
    return None


def _extract_address(soup: BeautifulSoup, lines: list[str], city: str | None, postal_code: str | None) -> str | None:
    street = soup.select_one(".AddressBlock .Location .Street")
    if street:
        candidate = clean_text(street.get_text(" ", strip=True))
        if candidate and city:
            return f"{candidate}, {postal_code} {city}" if postal_code else f"{candidate}, {city}"
        if candidate:
            return candidate
    for index, line in enumerate(lines):
        if city and line == city and index + 1 < len(lines):
            candidate = lines[index + 1]
            if not re.search(r"Afficher|exactitude|Visite|Maître", candidate, re.I):
                if postal_code and postal_code not in candidate:
                    return f"{candidate}, {postal_code} {city}"
                if postal_code is None:
                    return f"{candidate}, {city}"
                return candidate
    return None


def _extract_property_type(title: str | None, detail_text: str | None) -> str | None:
    text = " ".join(part for part in (title, detail_text) if part)
    if _is_mixed_property(text):
        return "mixed"
    return clean_text(title)


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
            r"\b(?:partiellement|une\s+partie|partie\s+à\s+usage|les\s+biens|plusieurs\s+biens|r[ée]union\s+des\s+lots?)\b",
            lowered,
            re.I,
        )
    )
    if (vacant and (rented or occupied)) or (rented and occupied) or (partial_or_ambiguous and (vacant or rented or occupied)):
        return "unknown"
    if re.search(rf"\b{occupied_word}\s+sans\s+bail\b", lowered):
        return "occupied"
    if no_lease_status := no_lease_occupancy_status(lowered):
        return no_lease_status
    if rented:
        return "rented"
    if vacant:
        return "vacant"
    if occupied:
        return "occupied"
    return None


def _extract_description(soup: BeautifulSoup, title: str | None) -> str | None:
    lot = soup.select_one(".AddressBlock .Lot")
    if not lot:
        return None
    parts = []
    for node in lot.select(".SousLot p, .AdditionalText"):
        text = clean_text(node.get_text(" ", strip=True))
        if text:
            parts.append(text)
    if title and parts:
        return clean_text(f"{title}. {' '.join(parts)}")
    return clean_text(" ".join(parts))


def _extract_coordinates(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    for link in soup.find_all("a", href=True):
        href = str(link.get("href", ""))
        match = re.search(r"[?&](?:q|ll|center)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", href)
        if match:
            return match.group(1), match.group(2)
        match = re.search(r"@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", href)
        if match:
            return match.group(1), match.group(2)
    return None, None


def _extract_sale_date(lines: list[str]) -> str | None:
    for line in lines:
        if re.search(r"\b(?:\d{1,2}|1er)\s+\w+\s+20\d{2}\s+à\s+\d{1,2}h", line, re.I):
            return line
    return None


def _extract_visit_dates(lines: list[str]) -> list[str]:
    visits = [line for line in lines if line.lower().startswith("visite")]
    return visits


def _extract_lawyer(lines: list[str]) -> tuple[str | None, str | None]:
    lawyer_name = None
    contact_parts: list[str] = []
    for index, line in enumerate(lines):
        if re.search(r"\bMa[îi]tre\b|Avocat", line, re.I):
            lawyer_name = line
            for candidate in lines[index + 1 : index + 6]:
                if _is_lawyer_contact_boundary(candidate):
                    break
                if not candidate.startswith("🔎"):
                    contact_parts.append(candidate)
            break
    contact = " | ".join(part for part in contact_parts if not part.startswith("🔎"))
    return lawyer_name, clean_text(contact)


def _is_lawyer_contact_boundary(line: str) -> bool:
    text = clean_text(line) or ""
    return bool(
        re.search(
            r"^(?:surface|superficie|mise\s+[àa]\s+prix|visite|tribunal|vente|annonce|date|descriptif|description|lot\b|occupation)\b",
            text,
            re.I,
        )
    )


def _extract_documents(soup: BeautifulSoup, source_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href"))
        label = clean_text(link.get_text(" ", strip=True))
        if href.startswith(("javascript:", "#")):
            continue
        if not _looks_like_document_link(href, label):
            continue
        url = urljoin(source_url, href)
        documents.append({"label": label or href.rstrip("/").rsplit("/", 1)[-1] or "document", "url": url, "type": "pdf"})
    return documents


def _looks_like_document_link(href: str, label: str | None) -> bool:
    href_text = _normalize_document_text(href)
    label_text = _normalize_document_text(label)
    if re.search(r"\.pdf(?:$|[?#])", href_text):
        return True
    if re.search(r"(?:^|/)(?:download|telechargement|document)(?:/|\?|$)", href_text):
        return True
    if not label_text or label_text in {"document", "documents", "dossier", "pieces jointes"}:
        return False
    if re.search(r"\b(?:voir|consulter)\s+le\s+dossier\s+complet\b", label_text):
        return False
    return bool(
        re.search(
            r"\b(?:cahier(?:\s+des\s+conditions)?|conditions\s+de\s+vente|diagnostics?|annexes?|"
            r"pv|pvd|proces\s+verbal|proces-verbal|descriptif|telecharg\w*)\b",
            label_text,
        )
    )


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


def _extract_images(soup: BeautifulSoup, source_url: str) -> list[str]:
    images: list[str] = []
    for selector in ("meta[property='og:image']", "meta[name='twitter:image']", ".LegalAd img"):
        for node in soup.select(selector):
            if node.name == "meta":
                _append_image(images, node.get("content"), source_url)
            else:
                for candidate in html_image_candidates(node):
                    _append_image(images, candidate, source_url)
    return _unique(images)


def _append_image(images: list[str], value: object | None, source_url: str) -> None:
    image_url = clean_text(value)
    if not image_url or image_url.startswith("data:"):
        return
    absolute = urljoin(source_url, image_url)
    lowered = absolute.lower()
    path = urlparse(absolute).path.lower()
    if any(asset in lowered for asset in ("licitor.png", "app-store", "google-play", "la-loupe-immo", "favicon")):
        return
    if path.startswith("/static/"):
        return
    if not re.search(r"\.(?:avif|jpe?g|png|webp)(?:[?#].*)?$", lowered):
        return
    images.append(absolute)


def _is_disallowed_document_url(url: str) -> bool:
    path = urlparse(url).path
    return path.startswith("/data/pub/doc/") or path.startswith("/data/pub/media/")


def _extract_surface_m2(text: str) -> str | None:
    # Première surface bâtie plausible mentionnée dans la page (en m²).
    match = re.search(rf"\b{SURFACE_VALUE_PATTERN}\s*(?:m\s*(?:²|2)|²)\b", text, re.I)
    return _normalize_surface_number(match.group(1)) if match else None


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
    if len(candidates) != 1:
        return None
    return candidates[0]


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


def _normalize_surface_number(value: str) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," in text:
        return text.replace(".", "")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        return text.replace(".", "")
    return text


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return clean_text(match.group(1)) if match else None


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))
