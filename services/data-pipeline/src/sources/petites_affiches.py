from __future__ import annotations

import logging
import os
import re
import time
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup, Tag

from src import source_checkpoint
from src.catalogue_proof import CatalogueEvidence
from src.config import FRANCE_DEPARTMENTS, FRENCH_POSTAL_CODE_PATTERN, TARGET_DEPARTMENTS, load_settings
from src.normalize import SURFACE_VALUE_PATTERN, clean_text
from src.raw_models import validate_raw_sales
from src.source_checkpoint import CheckpointSales
from src.sources.common import PoliteHttpClient, ScrapeResult, should_fetch_detail, unique_dicts
from src.sources.image_candidates import html_image_candidates
from src.sources.linked_pages import LinkedPages

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
    "visit_dates",
    "documents",
    "raw_text",
    "source_blocks",
    "raw_image_url",
    "source_images",
}
SOURCE_BUDGET_ENV = "PETITES_AFFICHES_SOURCE_BUDGET_SECONDS"
CURSOR_SCHEMA = "petites_affiches_cursor_v1"


def _source_budget_deadline() -> float | None:
    raw = os.getenv(SOURCE_BUDGET_ENV)
    if not raw:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return time.monotonic() + seconds if seconds > 0 else None


def _source_budget_expired(deadline: float | None) -> bool:
    return deadline is not None and time.monotonic() >= deadline


def _cursor_pages(cursor: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(cursor, dict):
        return []
    return [page for page in cursor.get("inventory_pages", []) if isinstance(page, dict)]


def _cursor_parsed_urls(cursor: dict[str, Any] | None) -> dict[str, set[str]]:
    if not isinstance(cursor, dict) or not isinstance(cursor.get("parsed_urls"), dict):
        return {}
    return {
        str(partition): {str(url) for url in urls if url}
        for partition, urls in cursor["parsed_urls"].items()
        if isinstance(urls, list)
    }


def _restore_catalogue_cursor(catalogue: CatalogueEvidence, cursor: dict[str, Any] | None) -> None:
    """Restore evidence only as a dated snapshot; callers gate certification."""
    pages = _cursor_pages(cursor)
    parsed_urls = _cursor_parsed_urls(cursor)
    for proof in pages:
        catalogue.pages.append(proof)
    for partition, urls in parsed_urls.items():
        catalogue.parsed.setdefault(partition, set()).update(urls)


def _restore_linked_pages(pages: LinkedPages, cursor: dict[str, Any] | None) -> bool:
    if not isinstance(cursor, dict) or cursor.get("scan_complete") is not False:
        return False
    seen = [str(url) for url in cursor.get("seen_pages", []) if url]
    pending = [str(url) for url in cursor.get("pending_pages", []) if url]
    if not seen and not pending:
        return False
    pages.seen = set(seen)
    pages.pending = pending
    try:
        pages.fetched = max(0, int(cursor.get("pages_fetched", len(seen))))
    except (TypeError, ValueError):
        pages.fetched = len(seen)
    return True


def _save_page_cursor(
    partition: str,
    department: str | None,
    pages: LinkedPages,
    completed_proofs: list[dict[str, Any]],
    parsed_urls: dict[str, set[str]],
    *,
    current_page: str | None = None,
    current_page_observed: bool = False,
    resumed: bool = False,
    scan_complete: bool = False,
) -> None:
    """Commit progress after a whole detail page, or put a partial page back.

    A page is added to the certificate snapshot only after every card on the
    page has either been enriched or has a durable matching detail checkpoint.
    If the source budget interrupts a page, that page stays pending so the next
    run cannot skip un-emitted URLs.
    """
    seen = list(dict.fromkeys(str(url) for url in pages.seen if url))
    pending = list(dict.fromkeys(str(url) for url in pages.pending if url))
    fetched = pages.fetched
    if current_page is not None:
        seen = [url for url in seen if url != current_page]
        pending = [current_page, *[url for url in pending if url != current_page]]
        if current_page_observed:
            fetched = max(0, fetched - 1)
    payload = {
        "schema_version": CURSOR_SCHEMA,
        "source_name": "petites_affiches",
        "partition": partition,
        "department": department,
        "scan_complete": bool(scan_complete and not pending),
        "resumed_from_checkpoint": bool(resumed),
        "pages_fetched": fetched,
        "seen_pages": seen,
        "pending_pages": pending,
        "inventory_pages": completed_proofs,
        "parsed_urls": {key: sorted(values) for key, values in parsed_urls.items()},
        "last_completed_page": completed_proofs[-1].get("page_index") if completed_proofs else None,
    }
    try:
        source_checkpoint.save_source_cursor(partition, payload)
    except Exception:  # pragma: no cover - persistence failures are source/runtime dependent
        LOGGER.warning("Unable to persist Petites Affiches cursor for %s", partition, exc_info=True)


def scrape_petites_affiches_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_petites_affiches_aquitaine_result(max_pages=max_pages).sales


def scrape_petites_affiches_aquitaine_result(
    max_pages: int | None = None, known: dict[str, str] | None = None
) -> ScrapeResult:
    settings = load_settings()
    deadline = _source_budget_deadline()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["browser_user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
        accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        extra_headers={"Origin": BASE_URL, "Referer": LIST_URL},
    )

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = CheckpointSales()
    partitions: list[dict[str, Any]] = []
    catalogue = CatalogueEvidence("petites_affiches")
    seen_sales: set[str] = set()
    budget_exhausted = False
    resumed_partitions: set[str] = set()
    departments = _department_filters()
    for department_index, department in enumerate(departments):
        partition = f"department:{department or 'all'}"
        pages = LinkedPages(LIST_URL, "", 1, max_pages or 100,
                            path_pattern=r"/encheres-immobilieres/ventes-aux-encheres-immobilieres-p(\d+)\.html")
        try:
            cursor = source_checkpoint.load_source_cursor(partition)
        except Exception:  # pragma: no cover - database availability is runtime dependent
            LOGGER.warning("Unable to load Petites Affiches cursor for %s", partition, exc_info=True)
            cursor = None
        resumed = _restore_linked_pages(pages, cursor)
        if resumed:
            resumed_partitions.add(partition)
            _restore_catalogue_cursor(catalogue, cursor)
            completed_proofs = _cursor_pages(cursor)
            parsed_urls = _cursor_parsed_urls(cursor)
        else:
            # A cursor which reached its end belongs to a prior interrupted
            # snapshot. Start a fresh inventory scan and do not carry its old
            # proofs into the next cursor.
            completed_proofs = []
            parsed_urls = {}
        # Keep the partition's evidence separate from other departments.  The
        # certificate is reconstructed from these dated page proofs only after
        # the page's details have been fully handled.
        parsed_urls.setdefault(partition, set())
        page_pending = False
        for page_url in pages:
            if _source_budget_expired(deadline):
                budget_exhausted = True
                page_pending = True
                _save_page_cursor(partition, department, pages, completed_proofs, parsed_urls,
                                  current_page=page_url, resumed=resumed)
                break
            try:
                html = (_fetch_listing(client, department) if page_url == LIST_URL
                        else _fetch_listing(client, department, page_url))
            except Exception as exc:
                LOGGER.error("Petites Affiches list fetch failed for %s: %s", page_url, exc)
                errors.append(f"{page_url}: {exc}")
                page_pending = True
                _save_page_cursor(partition, department, pages, completed_proofs, parsed_urls,
                                  current_page=page_url, resumed=resumed)
                break
            pages.observe(html, page_url)
            page_sales = parse_petites_affiches_html(html, page_url=page_url, fallback_department=department)
            # Certify every department POST before the global URL deduplication.
            # A URL repeated by two department partitions is still evidence in
            # both public catalogues and must not hide a partial partition.
            proof = catalogue.observe(html, page_url, page_sales, partition=partition)
            page_pending = False
            for sale in page_sales:
                if _source_budget_expired(deadline):
                    budget_exhausted = True
                    page_pending = True
                    break
                url = str(sale.get("source_url"))
                if url in seen_sales:
                    continue
                seen_sales.add(url)
                if should_fetch_detail(sale, known):
                    _enrich_sale_from_detail(client, sale, errors)
                raw_sales.append(sale)
            if page_pending:
                _save_page_cursor(partition, department, pages, completed_proofs, parsed_urls,
                                  current_page=page_url, current_page_observed=True, resumed=resumed)
                break
            completed_proofs.append(proof)
            parsed_urls[partition].update(
                str(sale.get("source_url")) for sale in page_sales if sale.get("source_url")
            )
            metrics = pages.metrics()
            _save_page_cursor(partition, department, pages, completed_proofs, parsed_urls,
                              resumed=resumed, scan_complete=metrics["linked_pages_complete"])
            if _source_budget_expired(deadline):
                budget_exhausted = True
                break
        partition_metrics = pages.metrics()
        if page_pending or budget_exhausted:
            partition_metrics = {
                **partition_metrics,
                "linked_pages_complete": False,
                "coverage_complete": False,
                "stop_reason": "source_budget_exhausted" if budget_exhausted else partition_metrics["stop_reason"],
            }
        partitions.append({"department": department, "partition": partition, **partition_metrics})
        if budget_exhausted:
            # Preserve an explicit incomplete record for every department not
            # visited in this process.  Omitting them would let an empty suffix
            # accidentally pass the catalogue proof.
            for remaining in departments[department_index + 1 :]:
                partitions.append({
                    "department": remaining,
                    "partition": f"department:{remaining or 'all'}",
                    "pages_fetched": 0,
                    "linked_pages_complete": False,
                    "pending_pages": 1,
                    "coverage_complete": False,
                    "stop_reason": "source_budget_exhausted",
                })
            break

    pagination_incomplete = [item for item in partitions if not item["linked_pages_complete"]]
    pagination_metrics = {
        # A resumed run carries old page proofs for evidence and diagnosis,
        # but cannot certify the current public inventory until a fresh scan
        # revalidates those pages. The following run starts from page one once
        # this cursor reaches its end.
        "coverage_complete": False if pagination_incomplete or resumed_partitions else None,
        "stop_reason": "source_budget_exhausted" if budget_exhausted
        else "partition_pagination_incomplete" if pagination_incomplete
        else "resumed_snapshot_requires_revalidation" if resumed_partitions
        else "published_links_exhausted",
        "budget_exhausted": budget_exhausted,
        "source_budget_seconds": None if deadline is None else max(0, round(deadline - time.monotonic(), 3)),
        "cursor_resumed_partitions": sorted(resumed_partitions),
        "cursor_revalidated": not resumed_partitions,
    }
    validated_sales = validate_raw_sales("petites_affiches", unique_dicts(raw_sales, "source_url"), errors)
    catalogue_metrics = catalogue.metrics(
        validated_sales,
        errors,
        coverage=pagination_metrics,
        scope={"public": "configured_departments", "configured": "target_departments"},
    )

    result = ScrapeResult(
        validated_sales,
        errors,
        {**getattr(client, "coverage_metrics", lambda: {})(),
         **pagination_metrics,
         "partitions": partitions,
         "linked_pages_complete": not pagination_incomplete,
         **catalogue_metrics},
    )
    if budget_exhausted:
        # ScrapeResult marks any error as ``source_errors``; retain the more
        # actionable bounded-stop reason when both happened in one run.
        result.coverage["coverage_complete"] = False
        result.coverage["stop_reason"] = "source_budget_exhausted"
        result.coverage["budget_exhausted"] = True
    return result


def _department_filters() -> tuple[str | None, ...]:
    if set(TARGET_DEPARTMENTS) == set(FRANCE_DEPARTMENTS):
        return (None,)
    return TARGET_DEPARTMENTS


def _fetch_listing(client: PoliteHttpClient, department: str | None, page_url: str = LIST_URL) -> str:
    form = {"historique": "0"}
    if department is not None:
        form["select_dep"] = department
    try:
        return client.post_form(page_url, form)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code if exc.response is not None else None
        if department is None and status in {403, 405, 406, 415, 429}:
            LOGGER.warning("Petites Affiches POST refused with %s; falling back to national GET listing", status)
            return client.get(page_url)
        raise


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
    property_type = _property_type_from_title(title) or property_type
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
        "source_images": [image_url] if image_url else [],
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
    visit_dates = _detail_visits(page_text)
    documents = _detail_documents(soup, source_url)
    source_images = _detail_images(soup, source_url)
    blocks = [
        description,
        f"Adresse: {address}" if address else None,
        f"Mise a prix: {price}" if price else None,
        f"Tribunal: {tribunal}" if tribunal else None,
        f"Avocat: {lawyer_name}" if lawyer_name else None,
        f"Contact: {lawyer_contact}" if lawyer_contact else None,
        f"Visites: {' | '.join(visit_dates)}" if visit_dates else None,
        f"Documents: {'; '.join(document['label'] for document in documents)}" if documents else None,
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
        "visit_dates": visit_dates,
        "documents": documents,
        "raw_text": "\n".join(part for part in blocks if part),
        "raw_image_url": source_images[0] if source_images else None,
        "source_images": source_images,
        "source_blocks": {
            key: value
            for key, value in {
                "description": description,
                "adresse": address,
                "mise_a_prix": price,
                "tribunal": tribunal,
                "avocat": lawyer_name,
                "contact_avocat": lawyer_contact,
                "visites": " | ".join(visit_dates) if visit_dates else None,
                "documents": "; ".join(document["label"] for document in documents if document.get("label"))
                or None,
                "page_text": page_text,
            }.items()
            if value
        },
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
        sale["_detail_fetch_failed"] = True
        sale["source_detail_status"] = "failed"
        return
    access_text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    restricted = re.search(
        r"(?:r[ée]serv[ée]e?\s+aux\s+abonn[ée]s|vous\s+devez\s+[êe]tre\s+abonn[ée])", access_text, re.I,
    )
    sale["source_detail_status"] = "restricted" if restricted else "complete"
    detail = parse_petites_affiches_detail_html(html, source_url)
    for key in DETAIL_FIELDS:
        value = detail.get(key)
        if value in (None, "", []):
            continue
        if key == "source_blocks":
            existing_blocks = sale.get("source_blocks") if isinstance(sale.get("source_blocks"), dict) else {}
            sale["source_blocks"] = {**existing_blocks, **value}
            continue
        if key == "documents":
            sale[key] = _merge_documents(sale.get(key), value)
            continue
        if key == "source_images":
            sale[key] = _merge_text_values(sale.get(key), value)
            if not sale.get("raw_image_url") and sale[key]:
                sale["raw_image_url"] = sale[key][0]
            continue
        if key == "raw_image_url" and not sale.get("raw_image_url"):
            sale[key] = value
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


def _property_type_from_title(title: str | None) -> str | None:
    text = _normalized_text(title)
    if not text:
        return None
    if re.search(r"\bappartement\b", text):
        return "Appartement"
    if re.search(r"\bmaison\b", text):
        return "Maison"
    if re.search(r"\b(?:terrain|parcelle)\b", text):
        return "Terrain"
    if re.search(r"\bensemble\s+immobilier\b", text):
        return "Ensemble immobilier"
    if re.search(r"\bimmeuble\b", text):
        return "Immeuble"
    if re.search(r"\b(?:magasin|local\s+commercial|commerce)\b", text):
        return "Magasin"
    if re.search(r"\b(?:emplacement\s+de\s+)?(?:stationnement|parking|garage)\b", text):
        return "Stationnement"
    return None


def _external_id(card: Tag, source_url: str) -> str:
    for class_name in card.get("class") or []:
        match = re.search(r"annonce_lot_(\d+)", str(class_name))
        if match:
            return match.group(1)
    match = re.search(r"-(\d+)\.html", source_url)
    return match.group(1) if match else source_url.rstrip("/").split("/")[-1]


def _extract_surface(text: str) -> str | None:
    match = re.search(rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:²|2)\b", text, re.I)
    return _normalize_surface_number(match.group(1)) if match else None


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


def _detail_documents(soup: BeautifulSoup, source_url: str) -> list[dict[str, str]]:
    documents: list[dict[str, str]] = []
    for link in soup.find_all("a", href=True):
        href = str(link.get("href") or "")
        label = clean_text(link.get_text(" ", strip=True)) or href.rstrip("/").rsplit("/", 1)[-1] or "document"
        if not _looks_like_document_link(href, label):
            continue
        documents.append(
            {
                "label": label,
                "url": urljoin(source_url, href),
                "type": "pdf" if ".pdf" in href.lower() else "document",
            }
        )
    return _merge_documents([], documents)


def _detail_images(soup: BeautifulSoup, source_url: str) -> list[str]:
    urls: list[str] = []
    for meta in soup.find_all("meta"):
        property_name = clean_text(meta.get("property") or meta.get("name"))
        if property_name and property_name.lower() in {"og:image", "twitter:image"}:
            _append_image_url(urls, meta.get("content"), source_url)
    for image in soup.find_all("img"):
        for candidate in html_image_candidates(image):
            _append_image_url(urls, candidate, source_url)
    return urls


def _append_image_url(urls: list[str], value: object, source_url: str) -> None:
    src = clean_text(value)
    if not src:
        return
    absolute = urljoin(source_url, src)
    if not _looks_like_property_image(absolute) or absolute in urls:
        return
    urls.append(absolute)


def _looks_like_property_image(url: str) -> bool:
    text = _normalized_text(url)
    if any(marker in text for marker in ("captcha", "/squelettes/", "kiosque")):
        return False
    if not re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", text):
        return False
    return not re.search(r"\b(?:logo|favicon|sprite|icon|picto|placeholder|avatar|loader)\b", text)


def _looks_like_document_link(href: str, label: str | None) -> bool:
    text = _normalized_text(f"{href} {label or ''}")
    if "cgv" in text or "conditions-generales-de-vente" in text:
        return False
    return bool(
        ".pdf" in text
        or re.search(
            r"\b(?:documents?|dossiers?|cahiers?|conditions?|diagnostics?|annexes?|"
            r"pv|pvd|proces\s+verbal|proces-verbal|descriptif|telecharg\w*|download\w*)\b",
            text,
        )
    )


def _merge_documents(existing: object, incoming: object) -> list[dict[str, str]]:
    documents = existing if isinstance(existing, list) else []
    incoming_documents = incoming if isinstance(incoming, list) else []
    merged: dict[str, dict[str, str]] = {}
    for document in [*documents, *incoming_documents]:
        if not isinstance(document, dict) or not document.get("url"):
            continue
        url = str(document["url"])
        merged[url] = {
            "label": str(document.get("label") or "document"),
            "url": url,
            "type": str(document.get("type") or ("pdf" if url.lower().endswith(".pdf") else "document")),
        }
    return list(merged.values())


def _merge_text_values(existing: object, incoming: object) -> list[str]:
    values: list[str] = []
    for item in [*_as_text_list(existing), *_as_text_list(incoming)]:
        if item not in values:
            values.append(item)
    return values


def _as_text_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value] if clean_text(value) else []
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := clean_text(item))]


def _detail_visits(page_text: str) -> list[str]:
    lines = [line for line in (clean_text(part) for part in page_text.splitlines()) if line]
    visits: list[str] = []
    for index, line in enumerate(lines):
        if _normalized_text(line) != "visites":
            continue
        parts: list[str] = []
        for next_line in lines[index + 1 : index + 8]:
            normalized = _normalized_text(next_line)
            if normalized.startswith(("adresse", "demander plus", "avocat poursuivant", "lieu de vente")):
                break
            if normalized in {"visites"}:
                continue
            parts.append(next_line)
        visit = clean_text(" ".join(parts))
        if visit and visit not in visits:
            visits.append(visit)
    return visits


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


def _normalized_text(value: str | None) -> str:
    text = clean_text(value) or ""
    return (
        text.lower()
        .replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("î", "i")
    )
