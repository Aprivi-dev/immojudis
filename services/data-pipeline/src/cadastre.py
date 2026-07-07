from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import httpx

from src.config import load_settings
from src.models import AuctionSale

LOGGER = logging.getLogger(__name__)
SOURCE_API_NAME = "API Carto Cadastre"


@dataclass(frozen=True)
class CadastreParcel:
    source_url: str
    parcel_key: str
    parcel_id: str | None
    code_insee: str | None
    department: str | None
    city: str | None
    section: str | None
    parcel_number: str | None
    surface_m2: float | None
    centroid_lat: float | None
    centroid_lng: float | None
    geometry_geojson: dict[str, Any]
    match_kind: str
    confidence: float
    source_api_url: str
    raw_payload: dict[str, Any]

    def to_storage_row(self) -> dict[str, object]:
        return {
            "source_url": self.source_url,
            "parcel_key": self.parcel_key,
            "parcel_id": self.parcel_id,
            "code_insee": self.code_insee,
            "department": self.department,
            "city": self.city,
            "section": self.section,
            "parcel_number": self.parcel_number,
            "surface_m2": self.surface_m2,
            "centroid_lat": self.centroid_lat,
            "centroid_lng": self.centroid_lng,
            "geometry_geojson": self.geometry_geojson,
            "match_kind": self.match_kind,
            "confidence": self.confidence,
            "source_api": SOURCE_API_NAME,
            "source_api_url": self.source_api_url,
            "raw_payload": self.raw_payload,
        }


def enrich_cadastre_sales(
    sales: Iterable[AuctionSale],
    *,
    settings: dict[str, object] | None = None,
) -> list[dict[str, object]]:
    settings = settings or load_settings()
    if not bool(settings.get("cadastre_enrich_enabled", False)):
        return []

    rows: list[dict[str, object]] = []
    for sale in sales:
        try:
            rows.extend(
                parcel.to_storage_row()
                for parcel in fetch_cadastre_parcels_for_sale(
                    sale,
                    api_url=str(settings.get("cadastre_api_url") or ""),
                    source_ign=str(settings.get("cadastre_source_ign") or ""),
                    max_parcels=int(settings.get("cadastre_max_parcels") or 4),
                    timeout_seconds=float(settings.get("cadastre_timeout_seconds") or 10),
                    user_agent=str(settings.get("user_agent") or "immojudis-data-pipeline/1.0"),
                )
            )
        except Exception as exc:
            LOGGER.warning("Cadastre enrichment failed for %s: %s", sale.source_url, exc)
            if "cadastre_enrichment_failed" not in sale.quality_flags:
                sale.quality_flags.append("cadastre_enrichment_failed")
    return rows


def fetch_cadastre_parcels_for_sale(
    sale: AuctionSale,
    *,
    api_url: str = "https://apicarto.ign.fr/api/cadastre/parcelle",
    source_ign: str = "PCI",
    max_parcels: int = 4,
    timeout_seconds: float = 10,
    user_agent: str = "immojudis-data-pipeline/1.0",
) -> list[CadastreParcel]:
    if not sale.source_url or sale.latitude is None or sale.longitude is None:
        return []
    endpoint = api_url.strip() or "https://apicarto.ign.fr/api/cadastre/parcelle"
    lat = float(sale.latitude)
    lng = float(sale.longitude)
    point = {"type": "Point", "coordinates": [lng, lat]}
    params: dict[str, object] = {
        "geom": json.dumps(point, separators=(",", ":")),
        "_limit": max(1, max_parcels),
    }
    if source_ign:
        params["source_ign"] = source_ign

    response = httpx.get(
        endpoint,
        params=params,
        headers={"User-Agent": user_agent},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()
    return cadastre_rows_from_feature_collection(
        sale,
        payload,
        source_api_url=endpoint,
        request_params=params,
        match_kind="point_intersection",
    )


def cadastre_rows_from_feature_collection(
    sale: AuctionSale,
    payload: dict[str, Any],
    *,
    source_api_url: str,
    request_params: dict[str, object] | None = None,
    match_kind: str = "point_intersection",
) -> list[CadastreParcel]:
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        return []

    parcels: list[CadastreParcel] = []
    seen: set[str] = set()
    for feature in features:
        if not isinstance(feature, dict):
            continue
        parcel = cadastre_parcel_from_feature(
            sale,
            feature,
            source_api_url=source_api_url,
            request_params=request_params or {},
            match_kind=match_kind,
        )
        if parcel is None or parcel.parcel_key in seen:
            continue
        seen.add(parcel.parcel_key)
        parcels.append(parcel)
    return parcels


def cadastre_parcel_from_feature(
    sale: AuctionSale,
    feature: dict[str, Any],
    *,
    source_api_url: str,
    request_params: dict[str, object],
    match_kind: str,
) -> CadastreParcel | None:
    properties = feature.get("properties")
    if not isinstance(properties, dict):
        properties = {}
    geometry = feature.get("geometry")
    geometry_geojson = geometry if isinstance(geometry, dict) else {}

    code_insee = first_text(properties, "code_insee", "insee", "code_commune")
    section = normalize_section(first_text(properties, "section", "section_cadastrale"))
    parcel_number = normalize_parcel_number(first_text(properties, "numero", "num_parcelle", "numero_parcelle"))
    parcel_id = first_text(properties, "idu", "id", "id_parcelle", "parcel_id")
    department = first_text(properties, "code_dep", "department") or sale.department
    city = first_text(properties, "nom_com", "commune", "city") or sale.city
    surface_m2 = positive_float(first_value(properties, "contenance", "surface", "surface_m2"))
    centroid_lng, centroid_lat = geometry_centroid(geometry_geojson)
    parcel_key = build_parcel_key(
        parcel_id=parcel_id,
        code_insee=code_insee,
        section=section,
        parcel_number=parcel_number,
        geometry=geometry_geojson,
    )
    if not parcel_key:
        return None

    confidence = 0.88 if parcel_id or (code_insee and section and parcel_number) else 0.72
    return CadastreParcel(
        source_url=sale.source_url,
        parcel_key=parcel_key,
        parcel_id=parcel_id,
        code_insee=code_insee,
        department=department,
        city=city,
        section=section,
        parcel_number=parcel_number,
        surface_m2=surface_m2,
        centroid_lat=centroid_lat,
        centroid_lng=centroid_lng,
        geometry_geojson=geometry_geojson,
        match_kind=match_kind,
        confidence=confidence,
        source_api_url=source_api_url,
        raw_payload={
            "request": request_params,
            "feature": feature,
        },
    )


def build_parcel_key(
    *,
    parcel_id: str | None,
    code_insee: str | None,
    section: str | None,
    parcel_number: str | None,
    geometry: dict[str, Any],
) -> str | None:
    if parcel_id:
        return parcel_id
    if code_insee and section and parcel_number:
        return f"{code_insee}-{section}-{parcel_number}"
    centroid = geometry_centroid(geometry)
    if centroid[0] is not None and centroid[1] is not None:
        return f"centroid-{centroid[0]:.7f}-{centroid[1]:.7f}"
    return None


def geometry_centroid(geometry: dict[str, Any]) -> tuple[float | None, float | None]:
    coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
    points = list(iter_coordinate_pairs(coordinates))
    if not points:
        return None, None
    lng = sum(point[0] for point in points) / len(points)
    lat = sum(point[1] for point in points) / len(points)
    return round(lng, 7), round(lat, 7)


def iter_coordinate_pairs(value: Any) -> Iterable[tuple[float, float]]:
    if not isinstance(value, list):
        return
    if len(value) >= 2 and all(isinstance(item, int | float) for item in value[:2]):
        lng = float(value[0])
        lat = float(value[1])
        if -180 <= lng <= 180 and -90 <= lat <= 90:
            yield lng, lat
        return
    for item in value:
        yield from iter_coordinate_pairs(item)


def first_text(values: dict[str, Any], *keys: str) -> str | None:
    value = first_value(values, *keys)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def first_value(values: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in values and values[key] not in (None, ""):
            return values[key]
    return None


def normalize_section(value: str | None) -> str | None:
    if not value:
        return None
    text = "".join(char for char in value.upper() if char.isalnum())
    return text or None


def normalize_parcel_number(value: str | None) -> str | None:
    if not value:
        return None
    text = "".join(char for char in value.upper() if char.isalnum())
    return text or None


def positive_float(value: object) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(str(value).replace(",", "."))
    except ValueError:
        return None
    if not (number >= 0):
        return None
    return number
