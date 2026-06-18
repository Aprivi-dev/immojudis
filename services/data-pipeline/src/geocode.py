from __future__ import annotations

from decimal import Decimal
import logging

import httpx

from src.config import load_settings
from src.models import AuctionSale
from src.normalize import clean_text


LOGGER = logging.getLogger(__name__)
# ponytail: broad Aquitaine bboxes; tighten only if we ingest finer geodata later.
DEPARTMENT_BOUNDS = {
    "24": (44.55, 45.75, -0.1, 1.5),
    "33": (44.15, 45.65, -1.35, 0.05),
    "40": (43.45, 44.55, -1.55, 0.15),
    "47": (43.95, 44.85, -0.15, 1.15),
    "64": (42.75, 43.65, -1.95, 0.15),
}


def geocode_sale(sale: AuctionSale) -> AuctionSale:
    """Fill latitude/longitude using a configurable French geocoding API.

    Defaults to BAN adresse.data.gouv.fr. Existing coordinates are preserved.
    """
    if sale.latitude is not None and sale.longitude is not None and _coordinates_match_department(sale):
        return sale
    if sale.latitude is not None and sale.longitude is not None:
        LOGGER.warning("Ignoring implausible coordinates for %s", sale.source_url)
        sale.latitude = None
        sale.longitude = None
        if "implausible_coordinates" not in sale.quality_flags:
            sale.quality_flags.append("implausible_coordinates")

    settings = load_settings()
    if not settings["geocode_enabled"]:
        return sale

    query = _build_query(sale)
    if not query:
        return sale

    try:
        latitude, longitude = geocode_address(
            query=query,
            api_url=str(settings["geocode_api_url"]),
            min_score=float(settings["geocode_min_score"]),
        )
    except Exception as exc:
        LOGGER.warning("Geocoding failed for %s: %s", sale.source_url, exc)
        return sale

    if latitude is not None and longitude is not None:
        sale.latitude = latitude
        sale.longitude = longitude
    return sale


def geocode_address(
    query: str,
    api_url: str = "https://api-adresse.data.gouv.fr/search/",
    min_score: float = 0.45,
) -> tuple[Decimal | None, Decimal | None]:
    response = httpx.get(api_url, params={"q": query, "limit": 1}, timeout=10)
    response.raise_for_status()
    payload = response.json()
    features = payload.get("features") or []
    if not features:
        return None, None

    feature = features[0]
    score = float((feature.get("properties") or {}).get("score") or 0)
    if score < min_score:
        return None, None

    coordinates = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coordinates) < 2:
        return None, None

    longitude, latitude = coordinates[:2]
    return Decimal(str(latitude)), Decimal(str(longitude))


def _build_query(sale: AuctionSale) -> str | None:
    address = sale.address or ""
    address_lower = address.lower()
    parts = [sale.address]
    if sale.postal_code and sale.postal_code not in address:
        parts.append(sale.postal_code)
    if sale.city and sale.city.lower() not in address_lower:
        parts.append(sale.city)
    query = clean_text(" ".join(part for part in parts if part))
    return query


def _coordinates_match_department(sale: AuctionSale) -> bool:
    department = sale.department or (sale.postal_code[:2] if sale.postal_code else None)
    bounds = DEPARTMENT_BOUNDS.get(department or "")
    if not bounds:
        return True
    min_lat, max_lat, min_lon, max_lon = bounds
    return min_lat <= float(sale.latitude) <= max_lat and min_lon <= float(sale.longitude) <= max_lon
