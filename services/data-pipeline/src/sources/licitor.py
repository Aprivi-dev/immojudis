from __future__ import annotations

from dataclasses import dataclass
import logging
import re
import time
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
import httpx

from src.config import AQUITAINE_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import ScrapeResult


BASE_URL = "https://www.licitor.com"
AQUITAINE_URL = f"{BASE_URL}/ventes-aux-encheres-immobilieres/sud-ouest-pyrenees/prochaines-ventes.html?area%5B0%5D=AQ"
LOGGER = logging.getLogger(__name__)


@dataclass
class LicitorClient:
    user_agent: str
    delay_seconds: float
    timeout_seconds: float

    def __post_init__(self) -> None:
        self._last_request_at = 0.0
        self._client = httpx.Client(
            headers={"User-Agent": self.user_agent, "Accept": "text/html,application/xhtml+xml"},
            timeout=self.timeout_seconds,
            follow_redirects=True,
        )
        self._robots = RobotsRules()
        try:
            robots_response = self._client.get(urljoin(BASE_URL, "/robots.txt"))
            robots_response.raise_for_status()
            self._robots = RobotsRules.parse(robots_response.text, self.user_agent)
        except Exception as exc:  # pragma: no cover - depends on network state
            LOGGER.warning("Could not read Licitor robots.txt: %s", exc)

    def get(self, url: str) -> str:
        if not self._robots.can_fetch(url):
            raise RuntimeError(f"robots.txt does not allow fetching {url}")
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.delay_seconds:
            time.sleep(self.delay_seconds - elapsed)
        LOGGER.info("Fetching %s", url)
        try:
            response = self._client.get(url)
        finally:
            self._last_request_at = time.monotonic()
        response.raise_for_status()
        return response.text


@dataclass
class RobotsRules:
    disallow: tuple[str, ...] = ()
    allow: tuple[str, ...] = ()

    @classmethod
    def parse(cls, text: str, user_agent: str) -> "RobotsRules":
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


def scrape_licitor_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
    """Collect Licitor Aquitaine listings as an optional benchmark source."""
    settings = load_settings()
    client = LicitorClient(
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    max_pages = max_pages or int(settings["licitor_max_pages"])

    errors: list[str] = []
    detail_urls = _collect_detail_urls(client, max_pages=max_pages, errors=errors)
    raw_sales: list[dict[str, Any]] = []
    seen: set[str] = set()
    for detail_url in detail_urls:
        if detail_url in seen:
            continue
        seen.add(detail_url)
        try:
            detail_html = client.get(detail_url)
        except Exception as exc:
            LOGGER.error("Licitor detail fetch failed for %s: %s", detail_url, exc)
            errors.append(f"{detail_url}: {exc}")
            continue
        sale = parse_licitor_detail_html(detail_html, detail_url)
        postal_code = sale.get("postal_code")
        department = str(sale.get("department") or (str(postal_code)[:2] if postal_code else ""))
        if department and department not in AQUITAINE_DEPARTMENTS:
            continue
        raw_sales.append(sale)
    return ScrapeResult(validate_raw_sales("licitor", raw_sales, errors), errors)


def parse_licitor_list_html(html: str, page_url: str = AQUITAINE_URL) -> tuple[list[str], list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    detail_urls: list[str] = []
    next_urls: list[str] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href"))
        absolute = urljoin(page_url, href)
        if re.search(r"/annonce/.+/\d+\.html$", href):
            detail_urls.append(absolute)
        elif "/ventes-aux-encheres-immobilieres/aquitaine.html?p=" in href:
            next_urls.append(absolute)
    return _unique(detail_urls), _unique(next_urls)


def parse_licitor_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    lines = [line for line in (clean_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line]
    raw_text = "\n".join(lines)

    title = _extract_title(soup, lines, raw_text)
    city = _extract_city(soup, lines, raw_text)
    department = _extract_department(raw_text)
    postal_code = _extract_postal_code(raw_text)
    address = _extract_address(soup, lines, city, postal_code)
    lawyer_name, lawyer_contact = _extract_lawyer(lines)
    latitude, longitude = _extract_coordinates(soup)
    description = _extract_description(soup, title)
    images = _extract_images(soup, source_url)

    return {
        "source_name": "licitor",
        "source_url": source_url,
        "external_id": _extract_external_id(source_url, raw_text),
        "tribunal": _extract_after(raw_text, r"(Tribunal\s+Judiciaire[^\n]+)"),
        "department": department or (postal_code[:2] if postal_code else None),
        "city": city,
        "address": address,
        "postal_code": postal_code,
        "property_type": title,
        "title": title,
        "description": description or title,
        "surface_m2": _extract_surface_m2(raw_text),
        "starting_price_eur": _extract_after(raw_text, r"Mise à prix\s*:?\s*([^\n]+)"),
        "sale_date": _extract_sale_date(lines),
        "visit_dates": _extract_visit_dates(lines),
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "status": "unknown",
        "occupancy_status": _extract_occupancy_status(raw_text),
        "latitude": latitude,
        "longitude": longitude,
        "documents": _extract_documents(soup, source_url),
        "source_images": images,
        "raw_image_url": images[0] if images else None,
        "raw_text": raw_text,
    }


def _collect_detail_urls(client: LicitorClient, max_pages: int, errors: list[str]) -> list[str]:
    pending = [AQUITAINE_URL]
    visited: set[str] = set()
    detail_urls: list[str] = []

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
    return _unique(detail_urls)


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


def _extract_postal_code(raw_text: str) -> str | None:
    match = re.search(r"\b((?:24|33|40|47|64)\d{3})\b", raw_text)
    return match.group(1) if match else None


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
                return candidate
    return None


def _extract_occupancy_status(raw_text: str) -> str | None:
    lowered = raw_text.lower()
    if re.search(r"\boccup[ée]s?\s+sans\s+bail\b", lowered):
        return "occupied"
    if re.search(r"\blou[ée]?\b|\blocataire\b|\bbail\b", lowered):
        return "rented"
    if re.search(r"\blibre\b|\binoccup[ée]s?\b", lowered):
        return "vacant"
    if re.search(r"\boccup[ée]s?\b", lowered):
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
    map_link = soup.select_one("a[href*='maps.google']")
    href = str(map_link.get("href", "")) if map_link else ""
    match = re.search(r"[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", href)
    if not match:
        return None, None
    return match.group(1), match.group(2)


def _extract_sale_date(lines: list[str]) -> str | None:
    for line in lines:
        if re.search(r"\b\d{1,2}\s+\w+\s+20\d{2}\s+à\s+\d{1,2}h", line, re.I):
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
            contact_parts.extend(lines[index + 1 : index + 4])
            break
    contact = " | ".join(part for part in contact_parts if not part.startswith("🔎"))
    return lawyer_name, clean_text(contact)


def _extract_documents(soup: BeautifulSoup, source_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href"))
        label = clean_text(link.get_text(" ", strip=True)) or "document"
        if ".pdf" in href.lower():
            url = urljoin(source_url, href)
            documents.append({"label": label, "url": url, "type": "pdf"})
    return documents


def _extract_images(soup: BeautifulSoup, source_url: str) -> list[str]:
    images: list[str] = []
    for selector in ("meta[property='og:image']", "meta[name='twitter:image']", ".LegalAd img"):
        for node in soup.select(selector):
            value = node.get("content") if node.name == "meta" else node.get("src")
            _append_image(images, value, source_url)
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
    match = re.search(r"(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:²|2)\b", text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return clean_text(match.group(1)) if match else None


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))
