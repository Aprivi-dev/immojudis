from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from src.catalogue_proof import CatalogueEvidence, canonical
from src.config import TARGET_DEPARTMENTS, load_settings
from src.extraction_profiles import attach_source_property_features as _attach_source_property_features
from src.normalize import (
    LATIN_LETTERS_PATTERN,
    SURFACE_VALUE_PATTERN,
    clean_text,
    extract_department,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
)
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PoliteHttpClient, ScrapeResult, parse_html, should_fetch_detail, unique_dicts
from src.sources.image_candidates import html_image_candidates
from src.sources.linked_pages import LinkedPages
from src.sources.source_features import merge_documents as _merge_documents
from src.sources.source_features import merge_text_values as _merge_text_values
from src.sources.source_features import normalize_document_text as _normalize_document_text

BASE_URL = "https://www.info-encheres.com"
LIST_URL = f"{BASE_URL}/vente-encheres-immobilieres-annonces.html"
LOGGER = logging.getLogger(__name__)
DETAIL_OVERRIDE_FIELDS = {
    "property_type",
    "title",
    "description",
    "address",
    "postal_code",
    "surface_m2",
    "habitable_surface_m2",
    "land_surface_m2",
    "surface_scope",
    "surface_source",
    "surface_evidence",
    "rooms_count",
    "parking_count",
    "starting_price_eur",
    "sale_date",
    "visit_dates",
    "lawyer_name",
    "lawyer_contact",
    "tribunal",
    "latitude",
    "longitude",
    "occupancy_status",
    "raw_text",
    "raw_image_url",
    "source_images",
    "source_property_features",
    "source_property_feature_evidence",
    "source_property_features_meta",
    "source_procedure_profile",
    "source_field_observations",
}


def scrape_info_encheres_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_info_encheres_aquitaine_result(max_pages=max_pages).sales


def scrape_info_encheres_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    """Collect Info Encheres judicial real-estate listings for the target departments."""
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    max_pages = max_pages or int(settings["info_encheres_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    catalogue = CatalogueEvidence("info_encheres")
    exclusions: dict[str, str] = {}
    pagination = LinkedPages(LIST_URL, "snr", 0, max_pages,
                             ("/vente-encheres-immobilieres-annonces.html", "/recherche.php"))
    for page_url in pagination:
        try:
            html = client.get(page_url)
        except Exception as exc:
            LOGGER.error("Info Encheres list fetch failed for %s: %s", page_url, exc)
            errors.append(f"{page_url}: {exc}")
            break
        pagination.observe(html, page_url)
        page_sales = parse_info_encheres_list_html(html, page_url=page_url)
        # Observe the complete public table before the configured department
        # filter. A filtered row count cannot certify the source catalogue.
        catalogue.observe(html, page_url, page_sales)
        for sale in page_sales:
            if sale.get("department") not in TARGET_DEPARTMENTS:
                source_url = sale.get("source_url")
                if source_url:
                    exclusions[canonical(str(source_url))] = "department_filter"
                continue
            if should_fetch_detail(sale, known):
                _enrich_sale_from_detail(client, sale, errors)
            raw_sales.append(sale)
    pagination_metrics = pagination.metrics()
    validated_sales = validate_raw_sales("info_encheres", unique_dicts(raw_sales, "source_url"), errors)
    catalogue_metrics = catalogue.metrics(
        validated_sales,
        errors,
        coverage=pagination_metrics,
        exclusions=exclusions,
        scope={"public": "national", "configured": "target_departments"},
    )
    return ScrapeResult(
        validated_sales,
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
         **pagination_metrics,
         **catalogue_metrics},
    )


def parse_info_encheres_list_html(html: str, page_url: str = LIST_URL) -> list[dict[str, Any]]:
    soup = parse_html(html, "html.parser")
    sales: list[dict[str, Any]] = []
    for row in soup.select("tr"):
        cells = [_text(cell.get_text(" ", strip=True)) for cell in row.find_all("td")]
        if len(cells) < 7 or not re.fullmatch(r"\d+", cells[0] or ""):
            continue
        department = cells[2]
        if not department or not re.fullmatch(r"\d{2,3}", department):
            continue
        link = row.find("a", href=True)
        if link is None:
            continue
        source_url = urljoin(f"{BASE_URL}/", str(link["href"]))
        city = _title_case_city(cells[1])
        property_type = cells[3]
        raw_text = "\n".join(
            filter(
                None,
                (
                    f"Reference: {cells[0]}",
                    f"Ville: {city}",
                    f"Departement: {department}",
                    f"Nature: {property_type}",
                    f"Mise a prix: {cells[4]}",
                    f"Vente le: {cells[5]}",
                    f"Avocat: {cells[6]}",
                ),
            )
        )
        sales.append(
            _attach_source_property_features({
                "source_name": "info_encheres",
                "source_url": source_url,
                "external_id": cells[0],
                "department": department,
                "city": city,
                "property_type": property_type,
                "title": _join_title(property_type, city),
                "starting_price_eur": cells[4],
                "sale_date": cells[5],
                "lawyer_name": cells[6],
                "status": "unknown",
                "documents": [],
                "raw_text": raw_text,
            })
        )
    return sales


def parse_info_encheres_detail_html(html: str, source_url: str) -> dict[str, Any]:
    soup = parse_html(html, "html.parser")
    page_text = "\n".join(
        line for line in (_text(part) for part in soup.get_text("\n", strip=True).splitlines()) if line
    )
    details = _extract_key_values(soup)
    address = details.get("adresse")
    postal_code, city = _extract_postal_city(address)
    lawyer_name = _text(soup.select_one(".avocat .nom b").get_text(" ", strip=True)) if soup.select_one(".avocat .nom b") else None
    lawyer_contact = (
        _text(soup.select_one(".avocat .nom .tel").get_text(" ", strip=True)) if soup.select_one(".avocat .nom .tel") else None
    )
    description = _extract_description(soup)
    latitude, longitude = _extract_coordinates(html)
    title = _extract_meta(soup, "title") or (_text(soup.title.get_text(" ", strip=True)) if soup.title else None)
    documents = _extract_documents(soup, source_url)
    source_images = _extract_images(soup, source_url)
    source_blocks = _extract_source_blocks(details, description, lawyer_name, lawyer_contact, documents, page_text)
    raw_text = _build_detail_raw_text(source_blocks)
    property_type = _detail_property_type(details.get("nature du bien"))
    habitable_surface_m2 = _extract_habitable_surface(
        description,
        property_type=property_type,
        detail_surface=details.get("superficie"),
    )
    land_surface_m2 = _extract_land_surface(description)
    explicit_total_surface_m2, explicit_total_surface_evidence = _extract_explicit_total_surface(
        description,
        page_text,
    )
    if explicit_total_surface_m2:
        surface_m2 = explicit_total_surface_m2
        surface_scope = "total"
        surface_source = "source_text"
        surface_evidence = explicit_total_surface_evidence
    else:
        surface_m2 = _extract_surface(description, page_text)
        surface_scope = None
        surface_source = None
        surface_evidence = None
    rooms_count = _extract_rooms_count(description)
    parking_count = _extract_parking_count(description)

    return _attach_source_property_features({
        "source_name": "info_encheres",
        "source_url": source_url,
        "external_id": details.get("reference") or _extract_after(page_text, r"\bref[ée]rence\s*:?\s*(\d+)"),
        "department": extract_department(postal_code) or _extract_department_from_url(source_url),
        "city": city,
        "address": address,
        "postal_code": postal_code,
        "property_type": property_type,
        "title": title,
        "description": description,
        "surface_m2": surface_m2,
        "habitable_surface_m2": habitable_surface_m2,
        "land_surface_m2": land_surface_m2,
        "surface_scope": surface_scope,
        "surface_source": surface_source,
        "surface_evidence": surface_evidence,
        "rooms_count": rooms_count,
        "parking_count": parking_count,
        "starting_price_eur": details.get("mise a prix") or details.get("mise à prix"),
        "sale_date": _sale_date_with_audience_time(details.get("vente le"), description or page_text),
        "visit_dates": [details["date de visite"]] if details.get("date de visite") else [],
        "lawyer_name": lawyer_name,
        "lawyer_contact": lawyer_contact,
        "tribunal": details.get("au tribunal judiciaire de"),
        "latitude": latitude,
        "longitude": longitude,
        "occupancy_status": _extract_occupancy_status(description or page_text),
        "documents": documents,
        "raw_text": raw_text or page_text,
        "source_blocks": source_blocks,
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
    })


def _sale_date_with_audience_time(date_text: str | None, text: str) -> str | None:
    if not date_text or not re.fullmatch(r"\d{2}/\d{2}/\d{4}", date_text.strip()):
        return date_text
    match = re.search(r"audience[^.\n]{0,70}d[ée]bute(?:nt)?\s+[àa]\s+(\d{1,2})[hH:](\d{2})?\b", text, re.I)
    if match and int(match.group(1)) < 24 and int(match.group(2) or 0) < 60:
        return f"{date_text} à {match.group(1)}h{match.group(2) or '00'}"
    return date_text


def _list_urls(max_pages: int) -> list[str]:
    urls = [LIST_URL]
    for page_index in range(1, max_pages):
        urls.append(f"{BASE_URL}/recherche.php?1=1&cat=1&snr={page_index}")
    return urls


def _enrich_sale_from_detail(client: PoliteHttpClient, sale: dict[str, Any], errors: list[str]) -> None:
    source_url = str(sale.get("source_url") or "")
    if not source_url.startswith(BASE_URL):
        return
    try:
        html = client.get(source_url)
    except Exception as exc:
        LOGGER.warning("Info Encheres detail fetch failed for %s: %s", source_url, exc)
        errors.append(f"detail {source_url}: {exc}")
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return
    sale["source_detail_status"] = "complete"
    details = parse_info_encheres_detail_html(html, source_url)
    for key, value in details.items():
        if value in (None, "", []):
            continue
        if key == "documents":
            sale[key] = _merge_documents(sale.get(key), value)
        elif key == "source_images":
            sale[key] = _merge_text_values(sale.get(key), value)
            if not sale.get("raw_image_url") and sale[key]:
                sale["raw_image_url"] = sale[key][0]
        elif key == "raw_image_url":
            if not sale.get("raw_image_url"):
                sale[key] = value
        elif key == "raw_text" and sale.get("raw_text"):
            sale[key] = f"{sale['raw_text']}\n{value}"
        elif key in DETAIL_OVERRIDE_FIELDS:
            sale[key] = value
        elif not sale.get(key):
            sale[key] = value
    _attach_source_property_features(sale)


def _extract_key_values(soup: BeautifulSoup) -> dict[str, str]:
    values: dict[str, str] = {}
    for row in soup.select("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        label = _normalize_label(cells[0].get_text(" ", strip=True))
        value = (
            _extract_tribunal_cell(cells[1])
            if label == "au tribunal judiciaire de"
            else _text(cells[1].get_text(" ", strip=True))
        )
        if label and value:
            values[label] = value
    return values


def _extract_tribunal_cell(cell: object) -> str | None:
    if not hasattr(cell, "stripped_strings"):
        return None
    parts = [_text(part) for part in cell.stripped_strings]
    first_line = next((part for part in parts if part), None)
    if not first_line:
        return None
    city = re.sub(r"^(?:Tribunal\s+Judiciaire\s+de|TJ\s+(?:de\s+)?)\s+", "", first_line, flags=re.I)
    city = re.split(
        r"\s+(?:\d|rue|avenue|av\.?|bd|boulevard|place|cours|all[ée]e|route|chemin)\b|[,.;]",
        city,
        maxsplit=1,
        flags=re.I,
    )[0]
    city = _text(city)
    return f"Tribunal Judiciaire de {city}" if city else None


def _normalize_label(value: str | None) -> str | None:
    text = _text(value)
    if not text:
        return None
    text = (
        text.lower()
        .replace("référence", "reference")
        .replace("mise à prix", "mise a prix")
        .replace(":", "")
        .strip()
    )
    return text or None


def _extract_description(soup: BeautifulSoup) -> str | None:
    for title in soup.find_all(string=re.compile(r"Description", re.I)):
        parent = title.parent
        for _ in range(4):
            if parent is None:
                break
            container = parent.find_next(class_="int2") if hasattr(parent, "find_next") else None
            if container:
                return _text(container.get_text(" ", strip=True))
            parent = parent.parent
    return None


def _extract_source_blocks(
    details: dict[str, str],
    description: str | None,
    lawyer_name: str | None,
    lawyer_contact: str | None,
    documents: list[dict[str, str]],
    page_text: str,
) -> dict[str, str]:
    blocks = {f"detail_{_slug_label(label)}": value for label, value in details.items() if value}
    blocks.update(
        {
            "description": description,
            "avocat": lawyer_name,
            "contact_avocat": lawyer_contact,
            "documents": "; ".join(document["label"] for document in documents if document.get("label")) or None,
            # The detail and description blocks contain the sale facts. Keeping
            # the full page here when a description exists also keeps the site's
            # navigation filters in normalization input (for example, a
            # navigation "Parking" followed by an address number).
            "page_text": page_text if not description else None,
        }
    )
    return {key: value for key, value in blocks.items() if value}


def _slug_label(value: str) -> str:
    text = value.lower()
    text = (
        text.replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("ù", "u")
        .replace("ç", "c")
    )
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")


def _build_detail_raw_text(source_blocks: dict[str, str]) -> str | None:
    parts = [
        f"Référence: {source_blocks['detail_reference']}" if source_blocks.get("detail_reference") else None,
        f"Nature: {source_blocks['detail_nature_du_bien']}" if source_blocks.get("detail_nature_du_bien") else None,
        f"Adresse: {source_blocks['detail_adresse']}" if source_blocks.get("detail_adresse") else None,
        f"Mise a prix: {source_blocks['detail_mise_a_prix']}" if source_blocks.get("detail_mise_a_prix") else None,
        f"Vente le: {source_blocks['detail_vente_le']}" if source_blocks.get("detail_vente_le") else None,
        f"Tribunal: {source_blocks['detail_au_tribunal_judiciaire_de']}"
        if source_blocks.get("detail_au_tribunal_judiciaire_de")
        else None,
        f"Visite: {source_blocks['detail_date_de_visite']}" if source_blocks.get("detail_date_de_visite") else None,
        source_blocks.get("description"),
        f"Avocat: {source_blocks['avocat']}" if source_blocks.get("avocat") else None,
        f"Contact: {source_blocks['contact_avocat']}" if source_blocks.get("contact_avocat") else None,
        f"Documents: {source_blocks['documents']}" if source_blocks.get("documents") else None,
    ]
    return "\n".join(part for part in parts if part) or None


def _extract_images(soup: BeautifulSoup, source_url: str) -> list[str]:
    urls: list[str] = []
    for meta in soup.find_all("meta"):
        property_name = _text(meta.get("property") or meta.get("name"))
        if property_name and property_name.lower() in {"og:image", "twitter:image"}:
            _append_image_url(urls, meta.get("content"), source_url)
    for image in soup.find_all("img"):
        for candidate in html_image_candidates(image):
            _append_image_url(urls, candidate, source_url)
    return urls


def _append_image_url(urls: list[str], value: object, source_url: str) -> None:
    src = _text(value)
    if not src:
        return
    absolute = urljoin(source_url, src)
    if not _looks_like_property_image(absolute) or absolute in urls:
        return
    urls.append(absolute)


def _looks_like_property_image(url: str) -> bool:
    text = _normalize_document_text(url)
    if "/pix/" in text:
        return False
    if not re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", text):
        return False
    return not re.search(r"\b(?:logo|favicon|sprite|icon|picto|placeholder|avatar|loader)\b", text)


def _extract_surface(*values: object) -> str | None:
    matches: list[tuple[str, re.Match[str], bool]] = []
    for value in values:
        text = str(value or "")
        for match in re.finditer(rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b", text, re.I):
            matches.append((text, match, _is_cadastral_surface_match(text, match.start(), match.end())))
    has_non_cadastral_match = any(not is_cadastral for _, _, is_cadastral in matches)
    for _, match, is_cadastral in matches:
        if is_cadastral and has_non_cadastral_match:
            continue
        return _normalize_surface_number(match.group(1))
    return None


def _extract_explicit_total_surface(*values: object) -> tuple[str | None, str | None]:
    """Prefer a qualified built/Carrez total over a room measurement.

    Info Enchères pages often list a room first (for example ``séjour de
    24,10 m²``) and publish the lot total later in the same description.  The
    total is the value suitable for the canonical listing surface; the quote
    remains available as evidence.
    """

    number = rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b"
    patterns = (
        rf"\b(?:surface|superficie)\s+(?:(?:privative|habitable)\s+)?(?:(?:loi\s+carrez)\s+)?totale\s*(?:de|:|est)?\s*{number}",
        rf"\b(?:surface|superficie)\s+totale\s+(?:b[âa]tie\s+)?(?:de|:|est)?\s*{number}",
    )
    for value in values:
        text = str(value or "")
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if not match or _is_cadastral_surface_match(text, match.start(), match.end()):
                continue
            quote = text[max(0, match.start() - 100) : min(len(text), match.end() + 100)].strip()
            return _normalize_surface_number(match.group(1)), quote
    return None, None


def _is_cadastral_surface_match(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 100) : end]
    return bool(
        re.search(
            r"\b(?:cadastr\w*|section\s+[A-Z]{1,4}\b|contenance)\b.{0,80}$",
            context,
            re.I | re.S,
        )
    )


def _detail_property_type(property_type: str | None) -> str | None:
    """Keep a semantic type for compound detail pages while retaining raw text in blocks."""
    raw_type = _text(property_type)
    if _is_mixed_asset(raw_type):
        return "mixed"
    if re.search(r"\b(?:un[e]?\s+)?pi[eè]ce\s+unique\b", raw_type or "", re.I):
        return "apartment"
    return raw_type


def _is_mixed_asset(text: str) -> bool:
    if not text:
        return False
    if re.search(r"\bensemble\s+immobilier\b", text, re.I):
        return True
    # An ordinary office or commercial building is still one building. Mark
    # an ``immeuble`` as mixed only when its wording combines residential and
    # commercial assets; otherwise ``normalize_property_type`` can retain the
    # more precise building classification.
    residential_asset = re.search(r"\b(?:habitation|appartements?|maisons?|studios?)\b", text, re.I)
    commercial_asset = re.search(
        r"\b(?:locaux?|bureaux|hangars?|industriels?|commerciaux?)\b", text, re.I
    )
    if re.search(r"\bimmeuble\b", text, re.I) and residential_asset and commercial_asset:
        return True
    return bool(residential_asset and commercial_asset)


def _extract_habitable_surface(
    description: str | None,
    *,
    property_type: str | None,
    detail_surface: str | None,
) -> str | None:
    """Extract one unambiguous dwelling area from the lot description.

    A page can describe several assets and several areas. In that case the
    generic ``surface_m2`` remains source evidence, but no single dwelling
    area is assigned to ``habitable_surface_m2``.
    """
    text = _text(description)
    if not text:
        return None
    asset = r"(?:un[e]?\s+)?(?:appartement|maison|villa|studio|logement|local\s+d['’]habitation|pi[eè]ce\s+unique)"
    number = rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b"
    candidates: list[str] = []
    asset_matches = list(re.finditer(rf"\b{asset}\b", text, re.I))
    surface_pattern = rf"\b(?:surface|superficie)\s+(?:habitable\s+)?(?:de\s+)?{number}"
    generic_pattern = rf"\bde\s+{number}"
    for index, asset_match in enumerate(asset_matches):
        segment_end = asset_matches[index + 1].start() if index + 1 < len(asset_matches) else asset_match.end() + 260
        segment = text[asset_match.end() : segment_end]
        match = re.search(surface_pattern, segment, re.I | re.S) or re.search(generic_pattern, segment, re.I)
        if match and match.group(0).lower().startswith("de ") and _is_auxiliary_surface_context(segment, match.start()):
            match = None
        if not match:
            continue
        value_match = re.search(number, match.group(0), re.I)
        value = _normalize_surface_number(value_match.group(1)) if value_match else None
        if value and value not in candidates:
            candidates.append(value)
    if len(candidates) != 1:
        return None
    candidate = candidates[0]
    detail_value = _extract_surface(detail_surface)
    if detail_value and detail_value != candidate and not _is_mixed_asset(
        " ".join(part for part in (property_type, text) if part)
    ):
        # A single dwelling with two different page/detail areas is ambiguous.
        return None
    return candidate


def _is_auxiliary_surface_context(text: str, start: int) -> bool:
    context = text[max(0, start - 90) : start]
    return bool(
        re.search(
            r"\b(?:hauteur|plafond|faitage|mezzanine|terrasse|v[eé]randa|balcon|box(?:es)?|garage|parking|stationnement|cave|lot)\b",
            context,
            re.I,
        )
    )


def _extract_land_surface(description: str | None) -> str | None:
    """Return one unambiguous cadastral area, excluding coproperty lots."""
    text = _text(description)
    if not text:
        return None
    matches = list(
        re.finditer(
            r"\b(?:(\d+)\s*ha\s*)?(\d+)\s*a\s*(\d+)\s*ca\b",
            text,
            re.I,
        )
    )
    if len(matches) != 1 or re.search(
        r"\blots?\s+(?:de\s+copropri[ée]t|n[°o]|num[ée]ro|\d)",
        text,
        re.I,
    ):
        return None
    match = matches[0]
    hectares = int(match.group(1) or 0)
    ares = int(match.group(2))
    centiares = int(match.group(3))
    return str(hectares * 10000 + ares * 100 + centiares)


def _extract_rooms_count(description: str | None) -> int | None:
    text = _text(description)
    if not text:
        return None
    if re.search(r"\b(?:un[e]?\s+)?pi[eè]ce\s+unique\b", text, re.I):
        return 1
    return None


def _extract_parking_count(description: str | None) -> int | None:
    text = _text(description)
    if not text:
        return None
    token = r"(?:une?|deux|trois|quatre|cinq|[1-9][0-9]?)"
    match = re.search(
        rf"\b({token})\s+(?:places?\s+de\s+)?(?:parking|stationnement)\b",
        text,
        re.I,
    )
    if match:
        return _parse_count_token(match.group(1))
    emplacement_match = re.search(
        rf"\b({token})\s+emplacements?\s+de\s+(?:parking|stationnement)\b",
        text,
        re.I,
    )
    if emplacement_match:
        return _parse_count_token(emplacement_match.group(1))
    emplacement_count = len(
        re.findall(r"\bemplacements?\s+de\s+(?:parking|stationnement)\b", text, re.I)
    )
    if emplacement_count:
        return emplacement_count
    if re.search(r"\blot\b[^.;]{0,80}\bun\s+garage\b", text, re.I):
        return 1
    if re.search(r"\b(?:place\s+de\s+parking|stationnement)\b", text, re.I):
        return 1
    return None


def _parse_count_token(value: str) -> int | None:
    lowered = value.lower()
    if lowered.isdigit():
        return int(lowered) if int(lowered) > 0 else None
    return {
        "un": 1,
        "une": 1,
        "deux": 2,
        "trois": 3,
        "quatre": 4,
        "cinq": 5,
    }.get(lowered)


def _normalize_surface_number(value: str) -> str | None:
    text = _text(value)
    if not text:
        return None
    text = text.replace(" ", "")
    if "," in text:
        return text.replace(".", "").replace(",", ".")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        return text.replace(".", "")
    return text


def _extract_occupancy_status(raw_text: str) -> str | None:
    lowered = raw_text.lower()
    if re.search(r"sans\s+droit\s+ni\s+titre|squat", lowered):
        return "squatted"
    owner_signal = bool(
        re.search(
            r"propri[ée]taires?\s+occupant(?:e|es|s)?|"
            r"occup[ée]e?s?\s+par\s+(?:(?:le|la|les|un|une|son|sa)\s+)?propri[ée]taires?",
            lowered,
        )
    )
    vacant_signal = bool(
        re.search(
            r"libres?\s+(?:de\s+tout(?:e)?\s+occupation|d[\s’\x27]*occupation)|"
            r"biens?\s+libres?|inoccup[ée]s?|vacants?",
            lowered,
        )
    )
    occupied_signal = bool(re.search(r"\boccup[ée]e?s?\b", lowered))
    rented_signal = has_rented_occupancy_signal(lowered)
    partial_signal = bool(re.search(r"partiellement\s+occup", lowered))
    if partial_signal or (occupied_signal and (vacant_signal or rented_signal)) or (owner_signal and rented_signal):
        return "unknown"
    if owner_signal:
        return "owner_occupied"
    if vacant_signal:
        return "vacant"
    if no_lease_status := no_lease_occupancy_status(lowered):
        return no_lease_status
    if rented_signal:
        return "rented"
    if occupied_signal:
        return "occupied"
    return None


def _extract_coordinates(html: str) -> tuple[str | None, str | None]:
    lat = _extract_after(html, r"var\s+lat\s*=\s*([0-9.,-]+)")
    lon = _extract_after(html, r"var\s+lon\s*=\s*([0-9.,-]+)")
    return lat, lon


def _extract_documents(soup: BeautifulSoup, source_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        label = _text(link.get_text(" ", strip=True)) or href.rstrip("/").split("/")[-1] or "document"
        if not _looks_like_document_link(href, label):
            continue
        documents.append({"label": label, "url": urljoin(source_url, href), "type": _document_type(label, href)})
    return _merge_documents([], documents)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = _normalize_document_text(f"{href} {label or ''}")
    return bool(
        ".pdf" in text
        or re.search(
            r"\b(?:documents?|dossiers?|cahiers?|conditions?|diagnostics?|annexes?|"
            r"pv|pvd|proces\s+verbal|proces-verbal|descriptif|telecharg\w*|download\w*)\b",
            text,
        )
    )


def _document_type(label: str, href: str) -> str:
    searchable = _normalize_document_text(f"{label} {href}")
    if "proces" in searchable or "procès" in searchable or "pv" in searchable:
        return "pv_descriptif"
    if "diagnostic" in searchable:
        return "diagnostics"
    if "cahier" in searchable:
        return "cahier_conditions"
    return "pdf"


def _extract_meta(soup: BeautifulSoup, name: str) -> str | None:
    node = soup.find("meta", attrs={"name": name})
    return _text(node.get("content")) if node and node.get("content") else None


def _extract_after(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.I)
    return _text(match.group(1)) if match else None


def _extract_postal_city(address: str | None) -> tuple[str | None, str | None]:
    if not address:
        return None, None
    match = re.search(
        rf"\b(\d{{5}})\s+([{LATIN_LETTERS_PATTERN}'’ -]+)\b(?=$|[,.;])",
        address,
    )
    if not match:
        return None, None
    return match.group(1), _title_case_city(match.group(2))


def _extract_department_from_url(source_url: str) -> str | None:
    match = re.search(r"-(\d{2,3})-ref-", source_url)
    return match.group(1) if match else None


def _join_title(property_type: str | None, city: str | None) -> str | None:
    if property_type and city:
        return f"{property_type} à {city}"
    return property_type or city


def _title_case_city(value: str | None) -> str | None:
    text = _text(value)
    return text.title() if text and text.isupper() else text


def _text(value: object | None) -> str | None:
    return clean_text(value)
