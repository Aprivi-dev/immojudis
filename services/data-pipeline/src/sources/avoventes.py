from __future__ import annotations

from dataclasses import dataclass
import logging
import re
import time
from typing import Any
from urllib.parse import urljoin
from urllib.robotparser import RobotFileParser

from bs4 import BeautifulSoup, Tag
import httpx

from src.config import AQUITAINE_DEPARTMENTS, load_settings
from src.normalize import clean_text


BASE_URL = "https://avoventes.fr"
SEARCH_URL = f"{BASE_URL}/recherche"
LOGGER = logging.getLogger(__name__)
SCRAPE_ERRORS: list[str] = []


@dataclass
class AvoventesClient:
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
        self._robots = RobotFileParser()
        self._robots.set_url(urljoin(BASE_URL, "/robots.txt"))
        self._robots_available = True
        try:
            self._robots.read()
        except Exception as exc:  # pragma: no cover - depends on network state
            self._robots_available = False
            LOGGER.warning("Could not read Avoventes robots.txt: %s", exc)

    def get(self, url: str) -> str:
        if self._robots_available and not self._robots.can_fetch(self.user_agent, url):
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


def scrape_avoventes_aquitaine() -> list[dict[str, Any]]:
    SCRAPE_ERRORS.clear()
    settings = load_settings()
    client = AvoventesClient(
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )

    raw_sales: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for department in AQUITAINE_DEPARTMENTS:
        url = f"{SEARCH_URL}?departement={department}&display=liste&order=asc&sort=date"
        try:
            html = client.get(url)
        except Exception as exc:
            LOGGER.error("Avoventes fetch failed for department %s: %s", department, exc)
            SCRAPE_ERRORS.append(f"department {department}: {exc}")
            continue
        for sale in parse_avoventes_html(html, page_url=url, fallback_department=department):
            postal_code = sale.get("postal_code")
            if not postal_code or str(postal_code)[:2] not in AQUITAINE_DEPARTMENTS:
                continue
            sale["department"] = str(postal_code)[:2]
            if sale["source_url"] in seen_urls:
                continue
            seen_urls.add(sale["source_url"])
            _enrich_sale_from_detail(client, sale)
            raw_sales.append(sale)
    return raw_sales


def get_avoventes_errors() -> list[str]:
    return list(SCRAPE_ERRORS)


def parse_avoventes_html(html: str, page_url: str = SEARCH_URL, fallback_department: str | None = None) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sale_nodes = _find_sale_nodes(soup)
    if not sale_nodes:
        text = soup.get_text("\n", strip=True)
        return [_parse_text_block(text, page_url, fallback_department)] if "Mise à prix" in text else []
    return [_parse_sale_node(node, page_url, fallback_department) for node in sale_nodes]


def _find_sale_nodes(soup: BeautifulSoup) -> list[Tag]:
    candidates: list[Tag] = [
        node for node in soup.find_all(attrs={"data-link": True}) if "Mise à prix" in node.get_text(" ", strip=True)
    ]
    for price_label in soup.find_all(string=re.compile(r"Mise à prix", re.I)):
        parent = price_label.parent
        for _ in range(6):
            if parent is None:
                break
            text = parent.get_text(" ", strip=True)
            classes = set(parent.get("class") or [])
            if "Mise à prix" in text and ("Date de la vente" in text or parent.get("data-link")):
                if parent.get("data-link") or "row" in classes or parent.name == "article":
                    candidates.append(parent)
                    break
            parent = parent.parent

    unique: list[Tag] = []
    seen: set[int] = set()
    for candidate in candidates:
        marker = id(candidate)
        if marker not in seen:
            seen.add(marker)
            unique.append(candidate)
    return unique


def _parse_sale_node(node: Tag, page_url: str, fallback_department: str | None) -> dict[str, Any]:
    raw_text = node.get_text("\n", strip=True)
    links = node.find_all("a", href=True)
    sale_url = urljoin(BASE_URL, str(node.get("data-link") or _choose_sale_url(links, page_url)))
    documents = _extract_documents(links, page_url)
    return _parse_text_block(raw_text, sale_url, fallback_department, documents=documents)


def _parse_text_block(
    raw_text: str,
    source_url: str,
    fallback_department: str | None,
    documents: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    joined = "\n".join(lines)
    title = _extract_title(lines)
    address = _extract_address(lines)
    postal_code, city = _extract_location(address, joined)
    property_type = _extract_property_type(joined)
    return {
        "source_name": "avoventes",
        "source_url": source_url,
        "external_id": source_url.rstrip("/").split("/")[-1],
        "department": fallback_department or (postal_code[:2] if postal_code else None),
        "title": title,
        "address": address,
        "city": city,
        "postal_code": postal_code,
        "property_type": property_type,
        "starting_price_eur": _extract_after_label(joined, r"Mise à prix(?: initiale)?\s*:?\s*([^\n]+)"),
        "sale_date": _extract_after_label(joined, r"Date de la vente\s*:?\s*([^\n]+)"),
        "visit_dates": _extract_visit_dates(joined),
        "lawyer_name": _extract_after_label(joined, r"Cabinet\s*:?\s*([^\n]+)"),
        "documents": documents or [],
        "raw_text": joined,
    }


def _choose_sale_url(links: list[Tag], page_url: str) -> str:
    for link in links:
        href = str(link.get("href"))
        if "/enchere/" in href:
            return urljoin(BASE_URL, href)
    for link in links:
        href = str(link.get("href"))
        if href and not href.startswith("#") and not href.lower().endswith(".pdf"):
            return urljoin(BASE_URL, href)
    return page_url


def _extract_documents(links: list[Tag], page_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in links:
        href = str(link.get("href"))
        text = clean_text(link.get_text(" ", strip=True))
        searchable = f"{href} {text or ''}".lower()
        if href.startswith("javascript:") or href.startswith("#"):
            continue
        if ".pdf" in searchable or any(word in searchable for word in ("document", "affiche", "cahier")):
            label = text or href.rstrip("/").split("/")[-1] or "document"
            documents.append({"label": label, "url": urljoin(page_url, href), "type": _document_type(href, label)})
    return documents


def _enrich_sale_from_detail(client: AvoventesClient, sale: dict[str, Any]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Avoventes detail fetch failed for %s: %s", source_url, exc)
        SCRAPE_ERRORS.append(f"detail {source_url}: {exc}")
        return

    details = parse_avoventes_detail_html(html, source_url)
    if details.get("documents"):
        sale["documents"] = _merge_documents(sale.get("documents", []), details["documents"])
    if details.get("raw_text"):
        sale["raw_text"] = f"{sale.get('raw_text') or ''}\n{details['raw_text']}".strip()
    for key in ("tribunal", "description", "lawyer_contact", "surface_m2"):
        if details.get(key) and not sale.get(key):
            sale[key] = details[key]


def parse_avoventes_detail_html(html: str, page_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    raw_text = soup.get_text("\n", strip=True)
    documents = _extract_documents(soup.find_all("a", href=True), page_url)
    return {
        "documents": documents,
        "raw_text": raw_text,
        "tribunal": _extract_after_label(raw_text, r"(?:Tribunal\s+Judiciaire|TJ)\s+de?\s*([^\n]+)"),
        "description": _extract_description(raw_text),
        "lawyer_contact": _extract_after_label(raw_text, r"(?:Téléphone|Tél\.?|Tel\.?)\s*:?\s*([^\n]+)"),
        "surface_m2": _extract_after_label(raw_text, r"Surface\s*:?\s*([0-9\s,.]+)\s*m"),
    }


def _merge_documents(existing: object, incoming: list[dict[str, str]]) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    merged: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming]:
        if isinstance(document, dict) and document.get("url"):
            merged[str(document["url"])] = {
                "label": str(document.get("label") or "document"),
                "url": str(document["url"]),
                "type": str(document.get("type") or _document_type(str(document["url"]), str(document.get("label") or ""))),
            }
    return list(merged.values())


def _document_type(href: str, label: str) -> str:
    text = f"{href} {label}".lower()
    if ".pdf" in text:
        return "pdf"
    return "document"


def _extract_description(raw_text: str) -> str | None:
    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            return clean_text(" ".join(lines[index : index + 6]))
    return None


def _extract_title(lines: list[str]) -> str | None:
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            for candidate in lines[index + 1 : index + 4]:
                if not re.search(r"Mise à prix|Date de la vente|Cabinet", candidate, re.I):
                    return candidate
    return lines[0] if lines else None


def _extract_address(lines: list[str]) -> str | None:
    for line in lines:
        if re.search(r"\b\d{5}\b", line):
            return line
    return None


def _extract_location(address: str | None, raw_text: str) -> tuple[str | None, str | None]:
    text = address or raw_text
    match = re.search(r"\b(\d{5})\s+([^,\n]+)", text)
    if not match:
        return None, None
    city = clean_text(match.group(2).replace("France", "").strip(" ,"))
    return match.group(1), city


def _extract_property_type(text: str) -> str | None:
    match = re.search(r"Vente aux enchères\s+([^\n]+)", text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_after_label(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_visit_dates(text: str) -> list[str]:
    match = re.search(r"Date des visites\s*:?\s*(.+?)(?:\n(?:Vente aux enchères|Mise à prix|Date de la vente|Cabinet)\b|$)", text, re.I | re.S)
    if not match:
        return []
    visits = clean_text(match.group(1))
    return [visits] if visits else []
