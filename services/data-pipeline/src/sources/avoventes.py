from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from src.catalogue_proof import CatalogueEvidence, canonical
from src.config import TARGET_DEPARTMENTS, load_settings
from src.normalize import clean_text, extract_department, parse_surface, strip_accents
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import (
    PoliteHttpClient,
    ScrapeResult,
    SourceParseLimitExceeded,
    is_allowed_origin_url,
    parse_html,
)
from src.sources.image_candidates import html_image_candidates

BASE_URL = "https://avoventes.fr"
SEARCH_URL = f"{BASE_URL}/recherche"
ALLOWED_ORIGINS = (BASE_URL, "https://www.avoventes.fr")
LOGGER = logging.getLogger(__name__)
MAX_AVOVENTES_RAW_CATALOGUE_CHARS = 8_000_000
_CITY_SELECTORS = re.compile(
    r'<select\b(?=[^>]*\bid\s*=\s*[\'\"](?:alerte_ville|modal_search_ville)[\'\"])[^>]*>.*?</select\s*>',
    re.IGNORECASE | re.DOTALL,
)


def compact_avoventes_catalogue_html(html: str) -> str:
    """Drop two city filters, not listing evidence, before bounded HTML parsing.

    The live page embeds the full 32,000-city list twice. Those two controls
    account for almost five megabytes while the listing markup is under one
    megabyte. Keep the raw-response size bounded and leave every other element
    intact so the inventory proof still checks all public cards.
    """
    if len(html) > MAX_AVOVENTES_RAW_CATALOGUE_CHARS:
        raise SourceParseLimitExceeded(
            f"Avoventes catalogue has {len(html)} units; raw limit is "
            f"{MAX_AVOVENTES_RAW_CATALOGUE_CHARS}"
        )
    return _CITY_SELECTORS.sub("", html)


class AvoventesClient(PoliteHttpClient):
    def __init__(self, user_agent: str, delay_seconds: float, timeout_seconds: float):
        super().__init__(base_url=BASE_URL, user_agent=user_agent,
                         delay_seconds=delay_seconds, timeout_seconds=timeout_seconds,
                         allowed_redirect_origins=ALLOWED_ORIGINS)


def scrape_avoventes_aquitaine() -> list[dict[str, Any]]:
    return scrape_avoventes_aquitaine_result().sales


def scrape_avoventes_aquitaine_result(known: dict[str, str] | None = None) -> ScrapeResult:
    settings = load_settings()
    client = AvoventesClient(
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    catalogue = CatalogueEvidence("avoventes")
    exclusions: dict[str, str] = {}
    seen_urls: set[str] = set()
    parsed_count = 0
    unresolved_locations: list[str] = []
    # Avoventes ignore le paramètre ?departement= et sert la liste nationale
    # complète sur une seule page : on la récupère une fois et on filtre les
    # départements en local (au lieu de re-télécharger la même page par dépt).
    url = f"{SEARCH_URL}?display=liste&order=asc&sort=date"
    try:
        html = compact_avoventes_catalogue_html(client.get(url))
    except Exception as exc:
        LOGGER.error("Avoventes list fetch failed: %s", exc)
        errors.append(f"list: {exc}")
        html = None
    if html:
        parsed_sales = parse_avoventes_html(html, page_url=url, fallback_department=None)
        # Certify the public national catalogue before applying the configured
        # department filter. The proof itself excludes cards marked ``Vente
        # amiable``; counting only the filtered output would hide omissions.
        proof = catalogue.observe(html, url, parsed_sales)
        amicable_urls = set(proof["outside_scope_urls"])
        exclusions.update({source_url: "vente_amiable" for source_url in amicable_urls})
        parsed_count = len(parsed_sales)
        for sale in parsed_sales:
            source_url = canonical(str(sale.get("source_url") or ""))
            if source_url in amicable_urls:
                continue
            postal_code = sale.get("postal_code")
            department = extract_department(str(postal_code) if postal_code else None)
            from src.source_checkpoint import restore_detail
            detail_checked = restore_detail(sale)
            department = sale.get("department") or extract_department(sale.get("postal_code")) or department
            if not department and not detail_checked:
                _enrich_sale_from_detail(client, sale, errors)
                detail_checked = True
                department = sale.get("department") or extract_department(sale.get("postal_code"))
            if not department:
                unresolved_locations.append(str(sale["source_url"]))
                continue
            if department not in TARGET_DEPARTMENTS:
                exclusions[source_url] = "department_filter"
                continue
            sale["department"] = department
            if sale["source_url"] in seen_urls:
                continue
            seen_urls.add(sale["source_url"])
            # Avoventes keeps photos and several detail fields off the list page;
            # always refresh the detail page after filtering to the target territory.
            if not detail_checked:
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)
    validated_sales = validate_raw_sales("avoventes", raw_sales, errors)
    catalogue_metrics = catalogue.metrics(
        validated_sales,
        errors,
        exclusions=exclusions,
        scope={"public": "national", "configured": "target_departments"},
    )
    return ScrapeResult(
        validated_sales,
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
         "inventory_before_department_filter": parsed_count,
         "unresolved_location_count": len(unresolved_locations),
         "unresolved_location_urls": unresolved_locations,
         **catalogue_metrics},
    )


def parse_avoventes_html(
    html: str, page_url: str = SEARCH_URL, fallback_department: str | None = None
) -> list[dict[str, Any]]:
    soup = parse_html(compact_avoventes_catalogue_html(html), "html.parser")
    sale_nodes = _find_sale_nodes(soup)
    if not sale_nodes:
        # A catalogue/search page may mention "Mise à prix" in a filter,
        # footer, or neighbouring content without containing a property card.
        # Treating the whole document as one sale fabricates a listing whose
        # URL is the search page.  Detail pages have their own parser and must
        # never enter this list-page fallback.
        return []
    parsed_sales = [_parse_sale_node(node, page_url, fallback_department) for node in sale_nodes]
    return [sale for sale in parsed_sales if sale is not None]


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


def _parse_sale_node(node: Tag, page_url: str, fallback_department: str | None) -> dict[str, Any] | None:
    raw_text = node.get_text("\n", strip=True)
    links = node.find_all("a", href=True)
    candidate_url = str(node.get("data-link") or _choose_sale_url(links) or "")
    sale_url = urljoin(BASE_URL, candidate_url)
    if not is_allowed_origin_url(sale_url, ALLOWED_ORIGINS):
        LOGGER.warning("Ignoring Avoventes listing with an untrusted source URL: %s", sale_url)
        return None
    if "/enchere/" not in urlparse(sale_url).path:
        LOGGER.warning("Ignoring Avoventes card without a property detail URL: %s", sale_url)
        return None
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
    starting_price = _extract_after_label(joined, r"Mise à prix(?: initiale)?\s*:?\s*([^\n]+)")
    adjudication_price = _extract_after_label(joined, r"Adjug[ée]\s*:?\s*([0-9][0-9\s,.]*\s*(?:€|euros?)?)")
    sale_date = _extract_after_label(joined, r"Date de la vente\s*:?\s*([^\n]+)")
    visit_dates = _extract_visit_dates(joined)
    lawyer_name = _extract_after_label(joined, r"Cabinet\s*:?\s*([^\n]+)")
    return {
        "source_name": "avoventes",
        "source_url": source_url,
        "external_id": source_url.rstrip("/").split("/")[-1],
        "department": fallback_department or extract_department(postal_code),
        "title": title,
        "address": address,
        "city": city,
        "postal_code": postal_code,
        "property_type": property_type,
        "starting_price_eur": starting_price,
        "adjudication_price_eur": adjudication_price,
        "sale_date": sale_date,
        "visit_dates": visit_dates,
        "lawyer_name": lawyer_name,
        "status": "adjudicated" if adjudication_price else None,
        "documents": documents or [],
        "raw_text": joined,
        "source_blocks": {
            key: value
            for key, value in {
                "titre": title,
                "adresse": address,
                "type_bien": property_type,
                "mise_a_prix": starting_price,
                "prix_adjudication": adjudication_price,
                "date_vente": sale_date,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "cabinet": lawyer_name,
                "page_text": joined,
            }.items()
            if value
        },
    }


def _choose_sale_url(links: list[Tag]) -> str | None:
    for link in links:
        href = str(link.get("href"))
        if "/enchere/" in href:
            return urljoin(BASE_URL, href)
    return None


def _extract_documents(links: list[Tag], page_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in links:
        href = str(link.get("href"))
        text = clean_text(link.get_text(" ", strip=True))
        searchable = f"{href} {text or ''}".lower()
        if href.startswith("javascript:") or href.startswith("#"):
            continue
        if ".pdf" in searchable or any(word in searchable for word in ("document", "affiche", "cahier")):
            document_url = urljoin(page_url, href)
            if not is_allowed_origin_url(document_url, ALLOWED_ORIGINS):
                LOGGER.warning("Ignoring Avoventes document with an untrusted URL: %s", document_url)
                continue
            label = text or href.rstrip("/").split("/")[-1] or "document"
            documents.append({"label": label, "url": document_url, "type": _document_type(href, label)})
    return documents


def _enrich_sale_from_detail(client: AvoventesClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not is_allowed_origin_url(source_url, ALLOWED_ORIGINS):
        return
    try:
        html = client.get(source_url)
        details = parse_avoventes_detail_html(html, source_url)
    except Exception as exc:
        LOGGER.warning("Avoventes detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return

    sale["source_detail_status"] = "complete"
    if details.get("source_blocks"):
        existing_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
        sale["source_blocks"] = {**existing_blocks, **details["source_blocks"]}
    if details.get("title") and _is_generic_title(sale.get("title")):
        sale["title"] = details["title"]
    if details.get("documents"):
        sale["documents"] = _merge_documents(sale.get("documents", []), details["documents"])
    if details.get("source_images"):
        sale["source_images"] = _merge_text_values(sale.get("source_images"), details["source_images"])
        if not sale.get("raw_image_url") and sale["source_images"]:
            sale["raw_image_url"] = sale["source_images"][0]
    elif details.get("raw_image_url") and not sale.get("raw_image_url"):
        sale["raw_image_url"] = details["raw_image_url"]
    if details.get("raw_text"):
        sale["raw_text"] = f"{sale.get('raw_text') or ''}\n{details['raw_text']}".strip()
    for key in (
        "tribunal",
        "description",
        "lawyer_contact",
        "surface_m2",
        "carrez_surface_m2",
        "land_surface_m2",
        "occupancy_status",
        "parking_count",
        "source_energy_diagnostics",
        "quality_flags",
        "adjudication_price_eur",
        "status",
        "postal_code",
        "department",
        "address",
        "city",
        "property_type",
        "sale_date",
        "visit_dates",
        "rooms_count",
    ):
        if key == "quality_flags" and details.get(key):
            existing_flags = sale.get(key) if isinstance(sale.get(key), list) else []
            sale[key] = list(dict.fromkeys([*existing_flags, *details[key]]))
        elif details.get(key) and (key == "description" or not sale.get(key)):
            sale[key] = details[key]


def parse_avoventes_detail_html(html: str, page_url: str) -> dict[str, Any]:
    soup = parse_html(html, "html.parser")
    if len(soup.select('select option')) > 100 and not soup.select_one('#lightSliderDetails') and not _property_description(soup):
        raise ValueError('Requested detail returned the catalogue/search page; property identity unverified')
    _remove_non_listing_detail_sections(soup)
    raw_text = soup.get_text("\n", strip=True)
    documents = _extract_documents(soup.find_all("a", href=True), page_url)
    images = _extract_images(soup, page_url)
    title = _extract_detail_title(soup, raw_text)
    tribunal = _extract_after_label(raw_text, r"(?:Tribunal\s+Judiciaire|TJ)\s+de?\s*([^\n]+)")
    description = _property_description(soup) or _extract_description(raw_text)
    location = _extract_property_location(description, title)
    lawyer_contact = _extract_after_label(raw_text, r"(?:Téléphone|Tél\.?|Tel\.?)\s*:?\s*([^\n]+)")
    adjudication_price = _extract_after_label(raw_text, r"Adjug[ée]\s*:?\s*([0-9][0-9\s,.]*\s*(?:€|euros?)?)")
    sale_date = _extract_detail_sale_date(soup, raw_text)
    visit_dates = _extract_detail_visit_dates(soup, raw_text)
    property_type = _extract_detail_property_type(title, description, raw_text)
    rooms_count = _extract_detail_rooms_count(raw_text, property_type, title)
    carrez_surface = _extract_carrez_surface(description, raw_text)
    land_surface = _extract_detail_land_surface(description, raw_text)
    occupancy_status = _extract_detail_occupancy_status(description)
    parking_count = _extract_detail_parking_count(raw_text)
    source_energy_diagnostics = _extract_detail_energy_diagnostics(raw_text)
    quality_flags = ["ambiguous_occupancy"] if _detail_occupancy_is_ambiguous(description) else []
    own_header = re.split(r"[ÀA] propos du bien|Autres biens", raw_text, maxsplit=1, flags=re.I)[0]
    event = None
    for pattern, value in ((r"vente\s+report[ée]e?", "postponed"),
                           (r"vente\s+annul[ée]e?", "cancelled"),
                           (r"vente\s+retir[ée]e?", "withdrawn")):
        if re.search(pattern, own_header, re.I):
            event = value
            break
    surface = _extract_after_label(
        raw_text,
        r"(?:Surface(?:\s+(?:habitable|totale))?|Superficie(?:\s+(?:des\s+)?Lots?\b[^:\n]{0,80})?)\s*:?\s*([0-9\s,.]+)\s*m",
    )
    return {
        **location,
        "documents": documents,
        "source_images": images,
        "raw_image_url": images[0] if images else None,
        "raw_text": raw_text,
        "title": title,
        "property_type": property_type,
        "tribunal": tribunal,
        "description": description,
        "lawyer_contact": lawyer_contact,
        "adjudication_price_eur": adjudication_price,
        "sale_date": sale_date,
        "visit_dates": visit_dates,
        "rooms_count": rooms_count,
        "carrez_surface_m2": carrez_surface,
        "land_surface_m2": land_surface,
        "occupancy_status": occupancy_status,
        "parking_count": parking_count,
        "source_energy_diagnostics": source_energy_diagnostics,
        "quality_flags": quality_flags,
        "status": event or ("adjudicated" if adjudication_price else None),
        "surface_m2": surface,
        "source_blocks": {
            key: value
            for key, value in {
                "titre_detail": title,
                "description": description,
                "tribunal": tribunal,
                "contact_avocat": lawyer_contact,
                "prix_adjudication": adjudication_price,
                "type_bien": property_type,
                "adresse": location.get("address"),
                "ville": location.get("city"),
                "date_vente": sale_date,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "surface": surface,
                "surface_carrez": carrez_surface,
                "surface_terrain": land_surface,
                "pieces": rooms_count,
                "occupation": occupancy_status,
                "parking_count": parking_count,
                "occupancy_scope": "ambiguous" if quality_flags else None,
                "dpe_class": source_energy_diagnostics.get("dpe_class") if source_energy_diagnostics else None,
                "ges_class": source_energy_diagnostics.get("ges_class") if source_energy_diagnostics else None,
                "documents": "; ".join(document["label"] for document in documents if document.get("label")) or None,
                "page_text": raw_text,
            }.items()
            if value
        },
    }


def _remove_non_listing_detail_sections(soup: BeautifulSoup) -> None:
    """Remove nearby facts without dropping the detail page's own metadata.

    Avoventes appends a heading followed by one or more ``data-link`` cards
    for nearby auctions.  Only the ``Autres biens à proximité`` boundary is
    exhaustive: removing only its first sibling leaves later cards in
    ``get_text()`` and lets their address, price, or sale status contaminate the
    listing being enriched.  The existing one-sibling treatment is retained
    for the plain ``À proximité`` map and ``Valeurs foncières`` table so that
    the listing's complementary facts remain available.
    """
    for heading in list(soup.find_all(["h2", "h3", "h4"])):
        if heading.parent is None:
            continue
        text = clean_text(heading.get_text(" ", strip=True)) or ""
        lowered = text.lower()
        is_other_listing_section = bool(re.search(r"\bautres\s+biens?\s+à\s+proximité\b", lowered))
        is_legacy_excluded_section = "proximité" in lowered or "valeurs foncières" in lowered
        if not (is_other_listing_section or is_legacy_excluded_section):
            continue
        if is_other_listing_section:
            for sibling in list(heading.next_siblings):
                sibling.extract()
        else:
            sibling = heading.find_next_sibling()
            if sibling and sibling.name in {"div", "table"}:
                sibling.decompose()
        heading.decompose()


def _property_location_codes(description: str | None) -> dict[str, str | None]:
    # Restrict inference to the property description, never the lawyer's address.
    text = description or ""
    postals = set(re.findall(r"\((\d{5})\)", text))
    departments = {extract_department(code) for code in postals}
    explicit_departments = set(re.findall(r"\((2[AB]|\d{2,3})\)", text))
    departments.update(explicit_departments)
    departments.discard(None)
    if len(departments) != 1:
        return {}
    return {"department": next(iter(departments)),
            "postal_code": next(iter(postals)) if len(postals) == 1 and not explicit_departments else None}


# Keep the first letter uppercase so that a prose sentence does not become a
# city candidate, while allowing ordinary mixed-case commune names such as
# ``Megève``. The candidate is filtered below when it is actually a street
# address (for example ``97 RUE DE GENEVE``).
_CITY_TOKEN = r"[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*){0,5}"
_STREET_KIND = (
    r"rue|avenue|av\.?|boulevard|bd|chemin|route|allée|allee|impasse|place|quai|cours|"
    r"montée|montee|passage"
)


def _extract_property_location(description: str | None, title: str | None) -> dict[str, str | None]:
    """Extract the target property's location from its own description.

    The page footer contains the lawyer's office address, so location parsing is
    intentionally restricted to the property description and the detail title.
    A street address is returned only when the source gives a numbered street;
    a named area without a number remains unknown.
    """

    text = clean_text(description) or ""
    cities: list[tuple[str, str | None]] = []
    addresses: list[str] = []

    for pattern in (
        rf"(?P<city>{_CITY_TOKEN})\s*\((?P<postal>\d{{5}})\)",
        rf"(?P<city>{_CITY_TOKEN})\s*\([^)]{{2,50}}\)\s*(?P<postal>\d{{5}})",
    ):
        for match in re.finditer(pattern, text):
            raw_city = match.group("city")
            # A numbered street followed by a postal code can satisfy the
            # generic ``CITY (postal)`` shape once mixed-case matching is
            # enabled. Keep that address for the address extractor, but do
            # not expose its street name as the commune. The prefix check also
            # catches a candidate that begins after a lower-case ``rue de``.
            if _looks_like_street_city_candidate(text, match, raw_city):
                continue
            city = _clean_city_candidate(raw_city)
            postal = clean_text(match.group("postal"))
            if city:
                cities.append((city, postal))

    # A few Avoventes descriptions put the department name between the city
    # and postal code, then put the street before the postal code.
    for match in re.finditer(
        rf"(?P<city>{_CITY_TOKEN})\s*\([^)]{{2,50}}\)\s+"
        rf"\d{{1,4}}(?:\s*(?:bis|ter))?(?:\s+et\s+\d{{1,4}})?\s+"
        rf"(?:{_STREET_KIND})\b[^()\n,;]{{0,80}}\s*\((?P<postal>\d{{5}})\)",
        text,
    ):
        raw_city = match.group("city")
        if _looks_like_street_city_candidate(text, match, raw_city):
            continue
        city = _clean_city_candidate(raw_city)
        postal = clean_text(match.group("postal"))
        if city:
            cities.append((city, postal))

    # Prefer a numbered street address, and stop before cadastral/legal
    # clauses. This keeps the lawyer's address and nearby prose out.
    for address_match in re.finditer(
        rf"\b(?P<address>\d{{1,4}}(?:\s*(?:bis|ter))?(?:\s+et\s+\d{{1,4}})?\s+"
        rf"(?:{_STREET_KIND})\b[^.;()\n]{{0,100}})",
        text,
        re.I,
    ):
        candidate = _trim_property_address(address_match.group("address"))
        if candidate:
            addresses.append(candidate)

    unique_addresses = {
        re.sub(r"\s+", " ", candidate).casefold(): candidate
        for candidate in addresses
    }
    address = next(iter(unique_addresses.values())) if len(unique_addresses) == 1 else None

    # If the description has several references, only retain a city when they
    # agree. Repeated mentions of the same city are common in lot descriptions.
    unique_cities = {city.casefold(): city for city, _ in cities if city}
    if len(unique_cities) == 1:
        city = next(iter(unique_cities.values()))
        postal_values = {postal for candidate, postal in cities if candidate.casefold() == city.casefold() and postal}
        postal_code = next(iter(postal_values)) if len(postal_values) == 1 else None
    else:
        city = None
        postal_code = None

    if city is None and title:
        title_match = re.search(rf"\b(?:à|a)\s+(?P<city>{_CITY_TOKEN})(?=\s*(?:\(|$))", title)
        if title_match:
            city = _clean_city_candidate(title_match.group("city"))

    if postal_code is None:
        # A unique postal code in the property description is safe to use even
        # when the city is only supplied by the title.
        postal_values = set(re.findall(r"\b(\d{5})\b", text))
        if len(postal_values) == 1:
            postal_code = next(iter(postal_values))

    result: dict[str, str | None] = {
        "address": address,
        "city": city,
        "postal_code": postal_code,
        "department": extract_department(postal_code),
    }
    return result


def _looks_like_street_city_candidate(text: str, match: re.Match[str], raw_city: str) -> bool:
    """Reject a city match that is a fragment of a numbered street address."""

    if re.search(rf"\b(?:{_STREET_KIND})\b", raw_city, re.I):
        return True
    candidate_start = match.start("city")
    prefix_window_start = max(0, candidate_start - 120)
    prefix_window = text[prefix_window_start:candidate_start]
    # Do not let a numbered address in the previous sentence suppress a real
    # commune in the current one.
    separator = max(
        (prefix_window.rfind(marker) for marker in ".!?\n,;"),
        default=-1,
    )
    prefix = prefix_window[separator + 1 :]
    return bool(
        re.search(
            rf"\b\d{{1,4}}(?:\s*(?:bis|ter))?(?:\s+et\s+\d{{1,4}})?\s+"
            rf"(?:{_STREET_KIND})\b[^,;()\n]{{0,100}}$",
            prefix,
            re.I,
        )
    )


def _clean_city_candidate(value: str | None) -> str | None:
    city = clean_text(value)
    if not city:
        return None
    # Greedy uppercase matching can include the lead-in phrase of a sentence
    # such as "UN APPARTEMENT ... SIS A GEX (01170)". Keep the final place
    # segment after the last location preposition.
    # Split only on a standalone location preposition. Splitting every
    # occurrence of "de" would truncate legitimate communes such as
    # "LE PONT DE BEAUVOISIN".
    parts = re.split(r"\b(?:à|a)\s+", city, flags=re.I)
    city = parts[-1] if parts else city
    city = re.sub(r"^(?:sur\s+la\s+commune\s+de|commune\s+de)\s+", "", city, flags=re.I)
    return clean_text(city)


def _trim_property_address(value: str) -> str | None:
    address = clean_text(value)
    if not address:
        return None
    address = address.split(",", 1)[0]
    address = re.split(
        r"\s+(?=(?:cadastr[ée]|cadastre|lot\b|section\b|lieudit\b|pour\b|"
        r"et\s+figurant\b|dans\s+un\s+ensemble\b|sur\s+la\s+commune\b|"
        r"commune\s+de\b))",
        address,
        maxsplit=1,
        flags=re.I,
    )[0]
    if len(re.findall(rf"\b(?:{_STREET_KIND})\b", address, re.I)) > 1:
        return None
    return address.rstrip(" ,:;-.\"'»’") or None


def _extract_images(soup: BeautifulSoup, page_url: str) -> list[str]:
    images: list[str] = []
    for selector in ("meta[property='og:image']", "meta[name='twitter:image']"):
        for node in soup.select(selector):
            _append_image(images, node.get("content"), page_url)
    for node in soup.select("#lightSliderDetails img, #lightSliderDetails [data-src]"):
        for candidate in html_image_candidates(node):
            _append_image(images, candidate, page_url)
    return _unique_text_values(images)


def _append_image(images: list[str], value: object | None, page_url: str) -> None:
    image_url = clean_text(value)
    if not image_url or image_url.startswith("data:"):
        return
    absolute = urljoin(page_url, image_url)
    if not is_allowed_origin_url(absolute, ALLOWED_ORIGINS):
        return
    lowered = absolute.lower()
    if "/documents/" in lowered or lowered.endswith(".pdf"):
        return
    if not re.search(r"\.(?:avif|jpe?g|png|webp)(?:[?#].*)?$", lowered):
        return
    if "/public/uploads/" not in lowered:
        return
    images.append(absolute)


def _merge_documents(existing: object, incoming: list[dict[str, str]]) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    merged: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming]:
        if isinstance(document, dict) and document.get("url"):
            merged[str(document["url"])] = {
                "label": str(document.get("label") or "document"),
                "url": str(document["url"]),
                "type": str(
                    document.get("type") or _document_type(str(document["url"]), str(document.get("label") or ""))
                ),
            }
    return list(merged.values())


def _merge_text_values(existing: object, incoming: object) -> list[str]:
    values: list[str] = []
    if isinstance(existing, list):
        values.extend(str(value) for value in existing if value)
    elif existing:
        values.append(str(existing))
    if isinstance(incoming, list):
        values.extend(str(value) for value in incoming if value)
    elif incoming:
        values.append(str(incoming))
    return _unique_text_values(values)


def _unique_text_values(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _document_type(href: str, label: str) -> str:
    text = f"{href} {label}".lower()
    if ".pdf" in text:
        return "pdf"
    return "document"


def _property_description(soup: BeautifulSoup) -> str | None:
    parts: list[str] = []
    for node in soup.find_all(["h2", "h3", "h4", "div"]):
        label = node.get_text(" ", strip=True).strip(" :").lower()
        if label not in {"à propos du bien", "informations complémentaires"}:
            continue
        content = node.find_next_sibling()
        if content:
            value = clean_text(content.get_text(" ", strip=True))
            if value and value not in parts:
                parts.append(value)
    return "\n".join(parts) or None


def _extract_description(raw_text: str) -> str | None:
    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            return clean_text(" ".join(lines[index : index + 6]))
    return None


def _extract_detail_title(soup: BeautifulSoup, raw_text: str) -> str | None:
    for node in soup.find_all(["h1", "h2"]):
        title = clean_text(node.get_text(" ", strip=True))
        if _looks_like_detail_title(title):
            return title

    lines = [line for line in (clean_text(part) for part in raw_text.splitlines()) if line]
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            for candidate in reversed(lines[max(0, index - 3) : index]):
                if _looks_like_detail_title(candidate):
                    return candidate
    for candidate in lines[:20]:
        if _looks_like_detail_title(candidate):
            return candidate
    return None


def _looks_like_detail_title(value: str | None) -> bool:
    text = clean_text(value)
    if not text or len(text) < 8:
        return False
    if re.search(
        r"^(?:avoventes\.fr|accueil|annuaire|connexion|retour|vente aux enchères|paramètres|documents?)$",
        text,
        re.I,
    ):
        return False
    return bool(
        re.search(
            r"\b(?:appartements?|maisons?|immeubles?|terrains?|parcelles?|b[âa]timents?|locaux?|garage|commerce|"
            r"commercial(?:e|es|s)?|"
            r"pavillons?|studios?|ensemble\s+immobilier)\b",
            text,
            re.I,
        )
    )


def _extract_title(lines: list[str]) -> str | None:
    for index, line in enumerate(lines):
        if re.search(r"Vente aux enchères", line, re.I):
            for candidate in lines[index + 1 : index + 6]:
                if _looks_like_list_title(candidate):
                    return candidate
    return lines[0] if lines else None


def _looks_like_list_title(value: str | None) -> bool:
    text = clean_text(value)
    if not text:
        return False
    if re.fullmatch(r"(?:voir\s+la\s+vente|retour\s+vers\s+la\s+liste|autres?)", text, re.I):
        return False
    if re.search(r"^(?:mise à prix|date de la vente|date des visites|cabinet|adjug[ée]|surench[èe]re)\b", text, re.I):
        return False
    if re.search(r"\b\d{5}\b", text):
        return False
    return True


def _is_generic_title(value: object | None) -> bool:
    text = clean_text(value)
    return text is None or text.lower() in {"autres", "autre", "bien", "vente aux enchères"}


def _extract_address(lines: list[str]) -> str | None:
    for line in lines:
        if re.search(r"\b\d{5}\b", line):
            return line
    return None


def _extract_location(address: str | None, raw_text: str) -> tuple[str | None, str | None]:
    text = address or raw_text
    match = re.search(r"\b(\d{5})\s+([^,\n]+)", text)
    if not match:
        # Titles often put the postal code after the city, in parentheses.
        # Keep the code without inventing a city from the rest of the title.
        parenthesized = re.search(r"\((\d{5})\)", text)
        return (parenthesized.group(1), None) if parenthesized else (None, None)
    city = clean_text(match.group(2).replace("France", "").strip(" ,"))
    return match.group(1), city


def _extract_property_type(text: str) -> str | None:
    match = re.search(r"Vente aux enchères\s+([^\n]+)", text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_detail_property_type(
    title: str | None,
    description: str | None,
    raw_text: str,
) -> str | None:
    """Return a conservative canonical type for a detail page.

    The page's summary can describe several lots. A single category in the
    title wins over secondary cadastral wording; several categories in that
    title are represented as ``mixed``. The function deliberately leaves a
    page without a defensible category as ``None``.
    """

    heading = title or _first_detail_heading(raw_text)
    title_types = _property_type_candidates(heading)
    if len(title_types) > 1:
        return "mixed"
    if len(title_types) == 1:
        return next(iter(title_types))

    description_types = _property_type_candidates(description)
    # "Immeuble" and cadastral "parcelle" wording commonly describes the
    # envelope of a dwelling. Keep them as secondary signals when a dwelling
    # category is explicit in the same description.
    if "apartment" in description_types or "house" in description_types:
        description_types.discard("building")
        description_types.discard("land")
    if len(description_types) > 1:
        return "mixed"
    if len(description_types) == 1:
        return next(iter(description_types))
    return None


def _first_detail_heading(raw_text: str) -> str | None:
    lines = [clean_text(part) for part in raw_text.splitlines() if clean_text(part)]
    for index, line in enumerate(lines):
        if line and re.search(r"Vente aux enchères", line, re.I):
            return lines[index - 1] if index else line
    return lines[0] if lines else None


def _property_type_candidates(value: object | None) -> set[str]:
    text = clean_text(value) or ""
    if not text:
        return set()
    candidates: set[str] = set()
    has_dwelling_code = bool(re.search(r"\b[tf]\s*[1-9]\b", text, re.I))
    has_explicit_apartment = bool(re.search(r"\b(?:appartements?|studios?)\b", text, re.I))
    if has_explicit_apartment or (has_dwelling_code and not re.search(r"\b(?:maisons?|villas?|pavillons?)\b", text, re.I)):
        candidates.add("apartment")
    if re.search(r"\b(?:maisons?|villas?|pavillons?)\b", text, re.I):
        candidates.add("house")
    if re.search(r"\b(?:locaux?\s+commerciaux?|boutiques?|commerces?|commercial(?:e|es|s)?)\b", text, re.I):
        candidates.add("commercial")
    if re.search(r"\b(?:terrains?|parcelles?|prés?|lieudit)\b", text, re.I):
        candidates.add("land")
    if re.search(r"\bensemble\s+immobilier\b", text, re.I):
        # The canonical normalizer treats this source label as a mixed asset:
        # it does not establish one dwelling whose room count can be reused.
        candidates.add("mixed")
    if re.search(r"\b(?:immeubles?|b[âa]timents?)\b", text, re.I):
        candidates.add("building")
    # A bare "local" is useful for a title such as "LOCAL", but in a
    # descriptive phrase it can mean a room or technical area. Require the
    # commercial qualifier unless this is the complete heading.
    if re.fullmatch(r"\s*(?:un\s+)?local\s*", text, re.I):
        candidates.add("commercial")
    return candidates


def _extract_detail_sale_date(soup: BeautifulSoup, raw_text: str) -> str | None:
    """Read the detail page's own sale summary, excluding nearby listings."""

    for strong in soup.find_all("strong"):
        label = clean_text(strong.get_text(" ", strip=True)) or ""
        if label.rstrip(" :").casefold() not in {"vente", "date de la vente"}:
            continue
        parent = strong.find_parent(["p", "div"]) or strong.parent
        if parent is None:
            continue
        text = clean_text(parent.get_text(" ", strip=True)) or ""
        value = re.sub(r"^(?:Vente|Date de la vente)\s*:?\s*", "", text, flags=re.I)
        if value and _looks_like_date_text(value):
            return value

    match = re.search(r"(?:^|\n)\s*Vente(?!\s+aux\s+ench[eè]res)\s*:?\s*([^\n]+)", raw_text, re.I)
    if match and _looks_like_date_text(match.group(1)):
        return clean_text(match.group(1))
    match = re.search(r"(?:^|\n)\s*Date de la vente\s*:?\s*([^\n]+)", raw_text, re.I)
    return clean_text(match.group(1)) if match and _looks_like_date_text(match.group(1)) else None


def _looks_like_date_text(value: str) -> bool:
    return bool(
        re.search(
            r"(?:\b\d{1,2}\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|"
            r"septembre|octobre|novembre|décembre|decembre)\s+\d{4}\b|"
            r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b)",
            value,
            re.I,
        )
    )


def _extract_detail_visit_dates(soup: BeautifulSoup, raw_text: str) -> list[str]:
    for strong in soup.find_all("strong"):
        label = clean_text(strong.get_text(" ", strip=True)) or ""
        if not re.fullmatch(r"visites?\s*:?", label, re.I):
            continue
        container = strong.find_parent("p") or strong.find_parent("div") or strong.parent
        if container is None:
            continue
        text = clean_text(container.get_text(" ", strip=True)) or ""
        value = re.sub(r"^visites?\s*:?\s*", "", text, flags=re.I)
        if value:
            return [value]

    lines = [clean_text(part) for part in raw_text.splitlines() if clean_text(part)]
    for index, line in enumerate(lines):
        if not line or not re.fullmatch(r"visites?\s*:?", line, re.I):
            continue
        values: list[str] = []
        for candidate in lines[index + 1 :]:
            if re.search(
                r"%\s*estimez|à propos du bien|autres biens|vente aux enchères|mise à prix|"
                r"date de la vente|cabinet\b",
                candidate,
                re.I,
            ):
                break
            values.append(candidate)
        value = clean_text(" ".join(values))
        return [value] if value and _looks_like_visit_text(value) else []
    return _extract_visit_dates(raw_text)


def _looks_like_visit_text(value: str) -> bool:
    return bool(
        re.search(
            r"\b(?:\d{1,2}\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|"
            r"septembre|octobre|novembre|décembre|decembre)\s+\d{4}|"
            r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|"
            r"visites?\s+libres?|sur\s+rendez-vous|sur\s+place)\b",
            value,
            re.I,
        )
    )


def _extract_detail_rooms_count(raw_text: str, property_type: str | None, title: str | None) -> int | None:
    """Use the summary count only for one clearly identified dwelling."""

    if property_type not in {"apartment", "house"}:
        return None
    detail_boundary = raw_text.lower().find("à propos du bien")
    summary_text = raw_text[:detail_boundary] if detail_boundary >= 0 else raw_text
    combined = " ".join(part for part in (title, summary_text) if part)
    # Lot labels normally live in the description, after the summary counter.
    # Use the complete cleaned detail text for the ambiguity signal while
    # keeping the actual piece count restricted to the page's own summary.
    lot_context = " ".join(part for part in (title, raw_text) if part)
    if re.search(r"\bvente\s+en\s+[2-9]\d*\s+lots?\b|\b(?:premier|second|troisi[eè]me)\s+lot\s+de\s+vente\b", lot_context, re.I):
        return None
    lot_ids = {
        value
        for value in re.findall(
            r"\blot\s*(?:n[°o.]?\s*)?(\d+)\b",
            lot_context,
            re.I,
        )
    }
    if {"1", "2"}.issubset(lot_ids):
        return None
    matches = re.findall(r"\b([1-9][0-9]?)\s*pi[eè]ces?\b", combined, re.I)
    if len(matches) != 1:
        return None
    return int(matches[0])


def _extract_carrez_surface(*values: object | None) -> str | None:
    patterns = (
        r"([0-9][0-9\s.,]*)\s*m(?:²|2)\s*(?:de\s+)?(?:surface\s+)?loi\s+carrez\b",
        r"(?:surface\s+)?loi\s+carrez(?:\s+(?:totale|privative))?\s*(?:-|:|de)?\s*([0-9][0-9\s.,]*)\s*m(?:²|2)\b",
        r"(?:superficie|surface)\s*\([^)]*loi\s+carrez[^)]*\)\s*:?\s*([0-9][0-9\s.,]*)\s*m(?:²|2)\b",
    )
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        for pattern in patterns:
            match = re.search(pattern, text, re.I)
            if match:
                return clean_text(match.group(1))
    return None


_DETAIL_COUNT_TOKENS = {
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


def _detail_count(value: str) -> int | None:
    token = clean_text(value)
    if not token:
        return None
    if token.isdigit():
        count = int(token)
        return count if count > 0 else None
    return _DETAIL_COUNT_TOKENS.get(strip_accents(token).lower())


def _extract_detail_land_surface(*values: object | None) -> str | None:
    """Extract one explicitly scoped parcel/terrain area from the detail page.

    Generic ``m² superficie`` counters and component areas are deliberately not
    accepted.  If the page exposes more than one distinct terrain measurement,
    the scalar field stays unresolved until a lot-level model can retain scope.
    """

    text = clean_text("\n".join(str(value) for value in values if value)) or ""
    if not text:
        return None
    candidates: list[object] = []
    surface_pattern = r"([0-9][0-9\s.,]*)\s*m(?:2|²)\b"
    direct_patterns = (
        rf"\bterrain\s*:\s*{surface_pattern}",
        rf"\b(?:surface|superficie)\s+(?:du|de\s+la)\s+terrain\s*:?\s*{surface_pattern}",
        rf"\bterrain\b[^.\n]{{0,80}}?\b(?:de|d['’]une\s+(?:surface|superficie)\s+de)\s+{surface_pattern}",
        rf"\bparcelle\b[^.\n]{{0,80}}?\b(?:de|d['’]une\s+(?:surface|superficie)\s+de)\s+{surface_pattern}",
    )
    for pattern in direct_patterns:
        candidates.extend(match.group(1) for match in re.finditer(pattern, text, re.I))

    parsed = [parse_surface(value) for value in candidates]
    unique = {value for value in parsed if value is not None}
    if len(unique) != 1:
        return None
    value = next(iter(unique))
    return format(value, "f").rstrip("0").rstrip(".")


def _extract_detail_occupancy_status(description: str | None) -> str | None:
    """Use only the target description and keep mixed lot statuses unknown."""

    text = strip_accents(clean_text(description) or "").lower()
    if not text:
        return None
    vacant, rented, occupied = _detail_occupancy_signals(text)
    if vacant and (rented or occupied):
        return None
    if rented:
        return "rented"
    if vacant:
        return "vacant"
    if occupied:
        return "occupied"
    return None


def _detail_occupancy_is_ambiguous(description: str | None) -> bool:
    text = strip_accents(clean_text(description) or "").lower()
    if not text:
        return False
    vacant, rented, occupied = _detail_occupancy_signals(text)
    return vacant and (rented or occupied)


_DETAIL_NEGATED_OCCUPIED_PATTERN = (
    r"\b(?:ne\s+|n['’])?(?:est|sont)\s+pas\s+occupe(?:e|es|s)?\b"
)


def _detail_occupancy_signals(text: str) -> tuple[bool, bool, bool]:
    vacant = bool(
        re.search(
            rf"\binoccupe(?:e|es|s)?\b|{_DETAIL_NEGATED_OCCUPIED_PATTERN}|"
            r"\bvide(?:s)?\s+de\s+toute\s+occupation\b|\bbien\s+libre\b",
            text,
        )
    )
    rented = bool(re.search(r"\blou(?:e|es|ee|ees)?\b|\bbail\b|\blocataire\b", text))
    # Remove only the negated occurrences before looking for a positive
    # ``occupé`` signal.  This keeps "n'est pas occupé" vacant while still
    # flagging a description that also contains another occupied component.
    positive_occupancy_text = re.sub(_DETAIL_NEGATED_OCCUPIED_PATTERN, "", text)
    occupied = bool(re.search(r"\boccupe(?:e|es|s)?\b", positive_occupancy_text))
    return vacant, rented, occupied


def _extract_detail_parking_count(raw_text: str) -> int | None:
    """Extract an explicit count; a generic parking label remains unknown."""

    text = clean_text(raw_text) or ""
    patterns = (
        r"\b([0-9]+|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)"
        r"\s+(?:emplacements?|places?)\s+(?:de\s+)?(?:parking|stationnement)\b",
        r"\b([0-9]+|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)"
        r"\s+(?:parking|stationnement)\b",
        r"\b(?:parking|stationnement)\s*:?\s*"
        r"([0-9]+|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
    )
    counts = {_detail_count(match.group(1)) for pattern in patterns for match in re.finditer(pattern, text, re.I)}
    counts.discard(None)
    return next(iter(counts)) if len(counts) == 1 else None


def _extract_detail_energy_diagnostics(raw_text: str) -> dict[str, object] | None:
    """Read DPE/GES classes from the page's own diagnostic block."""

    text = clean_text(raw_text) or ""
    marker = re.search(r"\bdiagnostic\s+[ée]nerg[ée]tique\b", text, re.I)
    if not marker:
        return None
    section = text[marker.end() :]
    section = re.split(r"\b(?:informations\s+compl[ée]mentaires|documents?)\b", section, maxsplit=1, flags=re.I)[0]
    values: dict[str, str | None] = {}
    for label, key in (("DPE", "dpe_class"), ("GES", "ges_class")):
        match = re.search(rf"\b{label}\b\s*[:\-]?\s*([A-G])\b", section, re.I)
        values[key] = match.group(1).upper() if match else None
    if not any(values.values()):
        return None
    return {
        "source": "avoventes.detail",
        **values,
        "diagnostic_date": None,
    }


def _extract_after_label(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return clean_text(match.group(1)) if match else None


def _extract_visit_dates(text: str) -> list[str]:
    match = re.search(
        r"Date des visites\s*:?\s*(.+?)(?:\n(?:Vente aux enchères|Mise à prix|Date de la vente|Cabinet)\b|$)",
        text,
        re.I | re.S,
    )
    if not match:
        return []
    visits = clean_text(match.group(1))
    return [visits] if visits else []
