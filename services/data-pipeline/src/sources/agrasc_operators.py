"""Read only public operator data, preserving AGRASC's catalogue identity."""
from __future__ import annotations

import json
import re
from html import unescape
from typing import Any
from urllib.parse import urljoin, urlsplit

from src.sources.agrasc_urls import (
    AGORA_IMMO_ORIGINS,
    AGORA_MARKETPLACE_ORIGIN,
    TROCADERO_ORIGIN,
    classify_agrasc_operator_url,
)
from src.sources.common import PoliteHttpClient, is_allowed_origin_url, parse_html
from src.sources.notaires import API_URL, BASE_URL, parse_notaires_detail_json

IMMO_ORIGIN = "https://www.immo-interactif.fr"
AGORA_ORIGIN = "https://www.agorastore-immo.fr"


def enrich_agrasc_operator(
    sale: dict[str, Any], clients: dict[str, PoliteHttpClient], settings: dict, errors: list[str],
) -> None:
    url = str(sale.get("source_url") or "")
    kind = classify_agrasc_operator_url(url)
    if kind is None:
        sale["operator_detail_status"] = "unsupported"
        return
    sale["operator_source_url"] = url
    if kind == "agorastore_seller":
        # A seller page is a catalogue, not a listing.  It is retained as the
        # public AGRASC URL but must never be treated as facts for one sale.
        sale["operator_detail_status"] = "unsupported"
        sale["source_detail_status"] = "unsupported"
        sale.setdefault("source_blocks", {}).update({
            "operator_endpoint": url,
            "operator_detail_reason": "seller_catalogue_without_listing_identity",
        })
        return
    api = kind == "immo_interactif"
    marketplace_product = kind == "agorastore_product" and is_allowed_origin_url(
        url, (AGORA_MARKETPLACE_ORIGIN,)
    )
    client_origin = (
        BASE_URL
        if api
        else AGORA_MARKETPLACE_ORIGIN
        if marketplace_product
        else next((origin for origin in AGORA_IMMO_ORIGINS if is_allowed_origin_url(url, (origin,))), AGORA_ORIGIN)
        if kind == "agorastore_product"
        else TROCADERO_ORIGIN
    )
    marker = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    if api and not re.fullmatch(r"\d+", marker):
        sale["operator_detail_status"] = "unsupported"
        return
    if client_origin not in clients:
        client_kwargs = {
            "base_url": client_origin, "user_agent": str(settings["user_agent"]),
            "delay_seconds": float(settings["request_delay_seconds"]),
            "timeout_seconds": float(settings["request_timeout_seconds"]),
            "accept": "application/json,text/plain,*/*" if api else "text/html,*/*",
        }
        if marketplace_product:
            client_kwargs["allowed_redirect_origins"] = (AGORA_ORIGIN,)
        clients[client_origin] = PoliteHttpClient(**client_kwargs)
    endpoint = f"{API_URL}/{marker}" if api else url
    try:
        payload = clients[client_origin].get(endpoint)
        if api:
            detail = parse_immo_operator_json(payload, marker)
        elif kind == "agorastore_product":
            detail = parse_agora_operator_detail(payload, url)
        else:
            detail = parse_trocadero_operator_detail(payload, url)
        if api and not detail.get("description"):
            raise ValueError("missing operator description")
        if detail.get("description"):
            for key, value in detail.items():
                if value in (None, "", [], {}):
                    continue
                if key == "source_blocks":
                    sale[key] = {**(sale.get(key) or {}), **value}
                elif key == "raw_text":
                    sale[key] = f"{sale.get(key) or ''}\n{value}".strip()
                elif key == "external_id":
                    # The parser only exposes this value after checking it
                    # against the operator URL or payload, so it is safe to
                    # replace a card slug with the stable product identifier.
                    sale[key] = str(value).strip()
                elif key not in {"source_name", "source_url"}:
                    sale[key] = value
            sale["operator_detail_status"] = "complete"
            sale["source_detail_status"] = "complete"
        else:
            images = parse_agora_operator_images(payload, url)
            if images:
                sale["source_images"] = list(dict.fromkeys([*images, *(sale.get("source_images") or [])]))
                sale["raw_image_url"] = images[0]
            sale["operator_detail_status"] = "partial"
        sale.setdefault("source_blocks", {})["operator_endpoint"] = endpoint
        visited_urls = getattr(clients[client_origin], "_visited_urls", ())
        if visited_urls and visited_urls[-1] != endpoint:
            sale["source_blocks"]["operator_canonical_url"] = visited_urls[-1]
    except Exception as exc:
        sale["operator_detail_status"] = "failed"
        sale["source_detail_status"] = "failed"
        sale["_detail_fetch_failed"] = True
        errors.append(f"operator detail {endpoint}: {exc}")


def parse_immo_operator_json(payload: str, expected_id: str) -> dict[str, Any]:
    data = json.loads(payload)
    if not isinstance(data, dict) or str(data.get("id")) != expected_id:
        raise ValueError("operator identity mismatch")
    detail = parse_notaires_detail_json(payload)
    transaction = data.get(str(data.get("typeTransaction") or "").lower()) or {}
    # AGRASC's date for an online sale denotes the closing date, not its opening.
    if transaction.get("dateFinEncheres"):
        detail["sale_date"] = transaction["dateFinEncheres"]
    # The operator API has already validated the requested product identity.
    # Keep that stable numeric identity available to the AGRASC normalizer.
    detail["external_id"] = expected_id
    detail.setdefault("source_blocks", {}).update({
        "operator_opening_date": transaction.get("dateDebutEncheres"),
        "operator_closing_date": transaction.get("dateFinEncheres"),
    })
    return detail


def parse_agora_operator_images(html: str, source_url: str) -> list[str]:
    marker = re.search(r"-(\d+)\.aspx$", urlsplit(source_url).path)
    if not marker:
        return []
    for node in parse_html(html, "html.parser").find_all("script", type="application/ld+json"):
        try:
            data = json.loads(node.get_text())
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict) or data.get("@type") != "Product" or str(data.get("productID")) != marker.group(1):
            continue
        values = data.get("image") or []
        values = values if isinstance(values, list) else [values]
        return [unescape(value) for value in values if isinstance(value, str)
                and is_allowed_origin_url(value, ("https://cdn.agorastore.fr",))]
    return []


def parse_agora_operator_detail(html: str, source_url: str) -> dict[str, Any]:
    """Decode public React props as JSON, never execute JavaScript."""
    marker = re.search(r"-(\d+)\.aspx$", urlsplit(source_url).path)
    if not marker:
        return {}
    prefix = "React.createElement(FicheProduitApp,"
    for script in parse_html(html, "html.parser").find_all("script"):
        text = script.get_text()
        if prefix not in text:
            continue
        props, _ = json.JSONDecoder().raw_decode(text.split(prefix, 1)[1].lstrip())
        page = props["ficheProduitModel"]
        model = page["productPageWrapper"]["productPageModel"]
        product = model["product"]
        if str(product.get("id")) != marker.group(1):
            raise ValueError("operator identity mismatch")
        fields = [(str(item.get("descriptifLibelle") or ""),
                   _operator_field_text(item.get("value")))
                  for group in model.get("descriptifs", []) for item in group.get("descriptifs", [])]
        description = "\n".join(f"{label} : {value}" for label, value in fields if value)
        if not description:
            return {}
        detail: dict[str, Any] = {
            "external_id": marker.group(1),
            "description": description, "raw_text": description,
            "documents": [{"label": item.get("fileName") or "Document opérateur", "url": item["url"]}
                          for item in model.get("documents", [])
                          if isinstance(item.get("url"), str)
                          and is_allowed_origin_url(item["url"], ("https://cdn.agorastore.fr",))
                          and urlsplit(item["url"]).path.lower().endswith(".pdf")],
            "source_images": [item["url"] for item in model.get("images", [])
                              if isinstance(item.get("url"), str)
                              and is_allowed_origin_url(item["url"], ("https://cdn.agorastore.fr",))],
            "source_blocks": {"description": description, "operator_fields": fields,
                              "operator_public_model": "FicheProduitApp"},
        }
        if detail["source_images"]:
            detail["raw_image_url"] = detail["source_images"][0]
        for label, value in fields:
            normalized_label = " ".join(label.casefold().split())
            if normalized_label == "adresse":
                detail["address"] = value
            if normalized_label == "surface habitable":
                surface = _operator_surface_value(value)
                if surface:
                    detail["surface_m2"] = surface
            elif "carrez" in normalized_label:
                surface = _operator_surface_value(value)
                if surface:
                    detail["carrez_surface_m2"] = surface
        field_map = {label.casefold(): value for label, value in fields}
        land_label = "surface terrain" if field_map.get("surface terrain") else "surface parcelle"
        land_text = field_map.get(land_label, "")
        cadastral_text = field_map.get("références cadastrales", "")
        land_areas = _explicit_square_metres(land_text)
        cadastral_areas = _explicit_square_metres(cadastral_text)
        coproperty_scoped = _land_surface_is_coproperty_scoped(fields, description)
        # Do not sum parcels or shares. A listed terrain smaller than one of
        # its cadastral areas needs reconciliation, not a confident AI scalar.
        if len(land_areas) == 1 and cadastral_areas and land_areas[0] < max(cadastral_areas):
            detail["operator_land_surface_conflict"] = True
            detail["source_display_constraints"] = [
                f"{label} : {value}" for label, value in fields
                if label.casefold() in {"surface terrain", "surface parcelle", "références cadastrales"}
            ]
        elif len(land_areas) == 1 and coproperty_scoped:
            # A parcel area shown on a copropriété listing can describe the
            # syndicate's land or a cadastral reference shared by several
            # lots. Keep the exact source fact for claims/audit, but do not
            # promote it to the sale's land surface without an ownership
            # scope that the operator page does not provide.
            source_key = "surface_parcelle" if land_label == "surface parcelle" else "surface_terrain"
            detail["operator_land_surface_scope"] = "copropriété"
            detail["source_blocks"][source_key] = _surface_text(land_areas[0])
            detail["source_blocks"]["operator_land_surface_scope"] = "copropriété"
            detail["source_display_constraints"] = [
                f"{label} : {value}" for label, value in fields
                if label.casefold() in {"surface terrain", "surface parcelle", "références cadastrales"}
            ]
        elif land_label == "surface parcelle" and len(land_areas) == 1:
            # A single explicit parcel area is usable only after the same
            # cadastral contradiction guard above has passed.
            detail["land_surface_m2"] = _surface_text(land_areas[0])
        state = page.get("saleState") or {}
        if str(state.get("productId")) == marker.group(1):
            detail["sale_date"] = state.get("endDate")
            detail["starting_price_eur"] = state.get("initialPrice")
            detail["source_blocks"].update({"operator_opening_date": state.get("startDate"),
                                             "operator_closing_date": state.get("endDate")})
        last_visit = (product.get("realEstateInformation") or {}).get("lastVisitDate")
        if last_visit:
            detail["visit_dates"] = [last_visit]
            detail["source_blocks"]["operator_visit_coverage"] = "last_visit_only"
        if re.search(r"libre de toute occupation", description, re.I):
            detail["occupancy_status"] = "vacant"
        return detail
    return {}


def parse_trocadero_operator_detail(html: str, source_url: str) -> dict[str, Any]:
    """Extract the French public call-for-tenders page without guessing a price.

    The Trocadéro page is a static editorial page, unlike the Agorastore
    product props.  Only facts explicitly present in the French content are
    retained; the English translation is skipped to avoid duplicate claims.
    """
    if classify_agrasc_operator_url(source_url) != "trocadero_offer":
        return {}
    soup = parse_html(html, "html.parser")
    content = soup.select_one("main") or soup.select_one("article") or soup
    title_node = content.find("h1")
    title = _operator_field_text(title_node.get_text(" ", strip=True)) if title_node else None
    blocks: list[str] = []
    current_language = "fr"
    for node in content.find_all(("h2", "h3", "p", "li")):
        text = _operator_field_text(node.get_text(" ", strip=True))
        if not text or text == title:
            continue
        if node.name in {"h2", "h3"}:
            language = _trocadero_heading_language(text)
            if language is not None:
                current_language = language
            continue
        text_language = _trocadero_text_language(text)
        if text_language is not None:
            current_language = text_language
        if current_language == "fr" and text not in blocks:
            blocks.append(text)
    description = "\n".join(blocks).strip()
    if not description:
        return {}
    detail: dict[str, Any] = {
        "title": title,
        "property_type": "domaine immobilier",
        "description": description,
        "raw_text": description,
        "source_blocks": {
            "operator_public_model": "TrocaderoCallForTenderPage",
            "operator_page_title": title,
            "operator_description": description,
        },
    }
    calendar = [block for block in blocks if re.search(r"\b20\d{2}\b", block)]
    if calendar:
        detail["source_blocks"]["operator_calendar_french"] = calendar
    location = re.search(r"situ(?:é|es|és) à\s+([^(.]+?)\s*\((\d{5})\),\s*(.+?)(?:\.|$)", description, re.I)
    if location:
        detail.update({
            "city": location.group(1).strip(),
            "postal_code": location.group(2),
            "department": location.group(2)[:2],
            "address": location.group(3).strip(),
        })
        detail["source_blocks"].update({
            "operator_city": detail["city"],
            "operator_postal_code": detail["postal_code"],
            "operator_address": detail["address"],
        })
    emails = sorted(set(re.findall(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", description, re.I)))
    if emails:
        detail["source_blocks"]["operator_contacts"] = emails
    documents = []
    for link in content.select("a[href]"):
        href = urljoin(source_url, str(link.get("href") or ""))
        label = _operator_field_text(link.get_text(" ", strip=True))
        if not href.lower().split("?", 1)[0].endswith(".pdf"):
            continue
        if is_allowed_origin_url(href, (TROCADERO_ORIGIN,)):
            documents.append({"label": label or "Document opérateur", "url": href})
    if documents:
        detail["documents"] = documents
    return detail


def _trocadero_heading_language(text: str) -> str | None:
    normalized = " ".join(text.casefold().split())
    if normalized in {"purpose of the consultation", "preliminary timeline"}:
        return "en"
    if normalized in {"description du bien", "mode de la consultation", "calendrier"}:
        return "fr"
    # "Contacts" is used for both language blocks.  Let the next paragraph
    # decide from its words instead of dropping the French block after the
    # English timeline.
    if normalized == "contacts":
        return "pending"
    return None


def _trocadero_text_language(text: str) -> str | None:
    normalized = " ".join(text.casefold().split())
    french_markers = (
        "l’état", "l'etat", "dans le cadre", "propriétaire", "propriétés", "situés",
        "candidats", "période", "envoi", "dossier", "visites", "ouverture", "date limite",
        "réponse", "réception", "notification", "objectif", "pour toute question",
        "heure locale", "adresse courriel", "règlement", "consultation",
    )
    english_markers = (
        "the ", "purpose", "french state", "organisation", "first phase", "second phase",
        "application file", "opening of", "visiting period", "submission", "notification",
        "target date", "for any questions", "local time", "rules set", "which it intends",
    )
    french_score = sum(marker in normalized for marker in french_markers)
    english_score = sum(marker in normalized for marker in english_markers)
    if french_score > english_score:
        return "fr"
    if english_score > french_score:
        return "en"
    return None


def _operator_field_text(value: Any) -> str:
    text = str(value or "")
    return parse_html(text, "html.parser").get_text(" ", strip=True) if "<" in text else unescape(text).strip()


def _operator_surface_value(value: str) -> str | None:
    match = re.search(r"\b(\d+(?:[ .]\d{3})*(?:[.,]\d+)?)\s*m[²2]\b", value, re.I)
    if not match:
        return None
    text = re.sub(r"\s", "", match.group(1))
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    return text


def _explicit_square_metres(text: str) -> list[float]:
    return [float(re.sub(r"\s", "", value).replace(",", "."))
            for value in re.findall(r"(\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?)\s*m[²2]", text)]


def _land_surface_is_coproperty_scoped(fields: list[tuple[str, str]], description: str) -> bool:
    text = "\n".join([description, *(f"{label} : {value}" for label, value in fields)])
    normalized = " ".join(text.casefold().split())
    if not re.search(r"\bcopropri[ée]t[ée]\b", normalized):
        return False
    return bool(re.search(r"\b(?:surface\s+(?:du\s+)?(?:terrain|parcelle)|parcelle)\b", normalized))


def _surface_text(value: float) -> str:
    return format(value, "f").rstrip("0").rstrip(".") or "0"
