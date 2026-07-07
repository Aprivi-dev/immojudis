from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx

from src.config import load_settings
from src.models import AuctionSale
from src.normalize import clean_text, extract_department

LOGGER = logging.getLogger(__name__)
# ponytail: only departments with known historical false positives need bboxes.
DEPARTMENT_BOUNDS = {
    "24": (44.55, 45.75, -0.1, 1.5),
    "33": (44.15, 45.65, -1.35, 0.05),
    "40": (43.45, 44.55, -1.55, 0.15),
    "47": (43.95, 44.85, -0.15, 1.15),
    "64": (42.75, 43.65, -1.95, 0.15),
}
NEGATIVE_GEOCODE_CACHE_TTL = timedelta(days=14)


@dataclass(frozen=True)
class GeocodeResult:
    latitude: Decimal
    longitude: Decimal
    score: float
    label: str | None
    result_type: str | None
    city: str | None
    citycode: str | None
    postcode: str | None
    provider: str = "ban_geoplateforme"


def geocode_sale(sale: AuctionSale) -> AuctionSale:
    """Fill latitude/longitude using the BAN geocoding service."""
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
    if _has_recent_negative_geocode_cache(sale, query):
        return sale

    try:
        result = geocode_address(
            query=query,
            api_url=str(settings["geocode_api_url"]),
            min_score=float(settings["geocode_min_score"]),
            postcode=sale.postal_code,
        )
    except Exception as exc:
        LOGGER.warning("Geocoding failed for %s: %s", sale.source_url, exc)
        return sale

    if result is None:
        _store_negative_geocode_cache(sale, query=query, reason="no_result")
        return sale

    department = sale.department or extract_department(sale.postal_code) or extract_department(result.postcode)
    if department and not _coordinates_in_department(result.latitude, result.longitude, department):
        LOGGER.warning("Ignoring BAN result outside department for %s", sale.source_url)
        if "geocode_outside_department" not in sale.quality_flags:
            sale.quality_flags.append("geocode_outside_department")
        _store_geocode_evidence(
            sale,
            query=query,
            result=result,
            accepted=False,
            rejection_reason="outside_department",
        )
        return sale

    sale.latitude = result.latitude
    sale.longitude = result.longitude
    _store_geocode_evidence(sale, query=query, result=result, accepted=True)
    return sale


def geocode_address(
    query: str,
    api_url: str = "https://data.geopf.fr/geocodage/search/",
    min_score: float = 0.45,
    postcode: str | None = None,
) -> GeocodeResult | None:
    params: dict[str, str | int] = {"q": query, "limit": 1}
    if postcode:
        params["postcode"] = postcode
    response = httpx.get(api_url, params=params, timeout=10)
    response.raise_for_status()
    payload = response.json()
    features = payload.get("features") or []
    if not features:
        return None

    feature = features[0]
    properties = feature.get("properties") or {}
    score = float(properties.get("score") or 0)
    if score < min_score:
        return None

    coordinates = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coordinates) < 2:
        return None

    longitude, latitude = coordinates[:2]
    return GeocodeResult(
        latitude=Decimal(str(latitude)),
        longitude=Decimal(str(longitude)),
        score=score,
        label=clean_text(properties.get("label")),
        result_type=clean_text(properties.get("type")),
        city=clean_text(properties.get("city")),
        citycode=clean_text(properties.get("citycode")),
        postcode=clean_text(properties.get("postcode")),
    )


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
    department = sale.department or extract_department(sale.postal_code)
    if not department or sale.latitude is None or sale.longitude is None:
        return True
    return _coordinates_in_department(sale.latitude, sale.longitude, department)


def _coordinates_in_department(latitude: Decimal, longitude: Decimal, department: str) -> bool:
    bounds = DEPARTMENT_BOUNDS.get(department or "")
    if not bounds:
        return True
    min_lat, max_lat, min_lon, max_lon = bounds
    return min_lat <= float(latitude) <= max_lat and min_lon <= float(longitude) <= max_lon


def _store_geocode_evidence(
    sale: AuctionSale,
    *,
    query: str,
    result: GeocodeResult,
    accepted: bool,
    rejection_reason: str | None = None,
) -> None:
    sale.raw_payload["geocode"] = {
        "provider": result.provider,
        "query": query,
        "accepted": accepted,
        "attempted_at": _utc_now().isoformat().replace("+00:00", "Z"),
        "rejection_reason": rejection_reason,
        "score": result.score,
        "label": result.label,
        "type": result.result_type,
        "city": result.city,
        "citycode": result.citycode,
        "postcode": result.postcode,
        "latitude": float(result.latitude),
        "longitude": float(result.longitude),
    }


def _store_negative_geocode_cache(sale: AuctionSale, *, query: str, reason: str) -> None:
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme",
        "query": query,
        "accepted": False,
        "attempted_at": _utc_now().isoformat().replace("+00:00", "Z"),
        "rejection_reason": reason,
    }


def _has_recent_negative_geocode_cache(sale: AuctionSale, query: str) -> bool:
    geocode = sale.raw_payload.get("geocode") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(geocode, dict):
        return False
    if geocode.get("provider") != "ban_geoplateforme":
        return False
    if geocode.get("accepted") is not False:
        return False
    if geocode.get("query") != query:
        return False
    attempted_at = _parse_datetime(geocode.get("attempted_at"))
    if attempted_at is None:
        return False
    return _utc_now() - attempted_at <= NEGATIVE_GEOCODE_CACHE_TTL


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _utc_now() -> datetime:
    return datetime.now(UTC)
