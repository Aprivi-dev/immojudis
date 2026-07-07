from __future__ import annotations

import logging
import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from typing import Any

import httpx

from src.config import load_settings
from src.models import AuctionSale
from src.normalize import clean_text

LOGGER = logging.getLogger(__name__)
SOURCE_API_NAME = "ADEME DPE Open Data"
DPE_CLASSES = {"A", "B", "C", "D", "E", "F", "G"}
DPE_SELECT_FIELDS = (
    "numero_dpe",
    "etiquette_dpe",
    "etiquette_ges",
    "date_etablissement_dpe",
    "date_fin_validite_dpe",
    "date_derniere_modification_dpe",
    "adresse_ban",
    "adresse_complete_brut",
    "code_postal_ban",
    "nom_commune_ban",
    "code_insee_ban",
    "code_departement_ban",
    "score_ban",
    "_geopoint",
    "type_batiment",
    "surface_habitable_logement",
    "surface_habitable_immeuble",
    "conso_5_usages_par_m2_ep",
    "emission_ges_5_usages_par_m2",
)


@dataclass(frozen=True)
class DpeDiagnostic:
    source_url: str
    diagnostic_number: str
    dpe_class: str | None
    ges_class: str | None
    established_at: str | None
    valid_until: str | None
    last_modified_at: str | None
    property_type: str | None
    address: str | None
    city: str | None
    postal_code: str | None
    insee_code: str | None
    department: str | None
    surface_m2: float | None
    energy_consumption_kwh_m2_year: float | None
    emissions_kg_co2_m2_year: float | None
    ban_score: float | None
    latitude: float | None
    longitude: float | None
    match_kind: str
    confidence: float
    source_api_url: str
    raw_payload: dict[str, Any]

    def to_storage_row(self) -> dict[str, object]:
        return {
            "source_url": self.source_url,
            "diagnostic_number": self.diagnostic_number,
            "dpe_class": self.dpe_class,
            "ges_class": self.ges_class,
            "established_at": self.established_at,
            "valid_until": self.valid_until,
            "last_modified_at": self.last_modified_at,
            "property_type": self.property_type,
            "address": self.address,
            "city": self.city,
            "postal_code": self.postal_code,
            "insee_code": self.insee_code,
            "department": self.department,
            "surface_m2": self.surface_m2,
            "energy_consumption_kwh_m2_year": self.energy_consumption_kwh_m2_year,
            "emissions_kg_co2_m2_year": self.emissions_kg_co2_m2_year,
            "ban_score": self.ban_score,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "match_kind": self.match_kind,
            "confidence": self.confidence,
            "source_api": SOURCE_API_NAME,
            "source_api_url": self.source_api_url,
            "raw_payload": self.raw_payload,
        }


def enrich_dpe_sales(
    sales: Iterable[AuctionSale],
    *,
    settings: dict[str, object] | None = None,
) -> list[dict[str, object]]:
    settings = settings or load_settings()
    if not bool(settings.get("dpe_enrich_enabled", False)):
        return []

    rows: list[dict[str, object]] = []
    for sale in sales:
        try:
            rows.extend(
                diagnostic.to_storage_row()
                for diagnostic in fetch_dpe_diagnostics_for_sale(
                    sale,
                    api_url=str(settings.get("dpe_api_url") or ""),
                    geo_radius_m=int(settings.get("dpe_geo_radius_m") or 120),
                    max_results=int(settings.get("dpe_max_results") or 5),
                    timeout_seconds=float(settings.get("dpe_timeout_seconds") or 12),
                    user_agent=str(settings.get("user_agent") or "immojudis-data-pipeline/1.0"),
                )
            )
        except Exception as exc:
            LOGGER.warning("DPE enrichment failed for %s: %s", sale.source_url, exc)
            if "dpe_enrichment_failed" not in sale.quality_flags:
                sale.quality_flags.append("dpe_enrichment_failed")
    return rows


def fetch_dpe_diagnostics_for_sale(
    sale: AuctionSale,
    *,
    api_url: str = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines",
    geo_radius_m: int = 120,
    max_results: int = 5,
    timeout_seconds: float = 12,
    user_agent: str = "immojudis-data-pipeline/1.0",
) -> list[DpeDiagnostic]:
    if not sale.source_url:
        return []
    endpoint = api_url.strip() or "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines"
    params = dpe_query_params_for_sale(sale, geo_radius_m=geo_radius_m, max_results=max_results)
    if not params:
        return []

    response = httpx.get(
        endpoint,
        params=params,
        headers={"User-Agent": user_agent},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()
    return dpe_rows_from_payload(sale, payload, source_api_url=endpoint, request_params=params)


def dpe_query_params_for_sale(
    sale: AuctionSale,
    *,
    geo_radius_m: int,
    max_results: int,
) -> dict[str, object] | None:
    params: dict[str, object] = {
        "size": max(1, max_results),
        "select": ",".join(DPE_SELECT_FIELDS),
    }
    if sale.latitude is not None and sale.longitude is not None:
        params["geo_distance"] = f"{float(sale.longitude)}:{float(sale.latitude)}:{max(10, geo_radius_m)}"
        if sale.department:
            params["code_departement_ban_eq"] = sale.department
        return params

    query = clean_text(" ".join(part for part in [sale.address, sale.postal_code, sale.city] if part))
    if not query:
        return None
    params["q"] = query
    if sale.department:
        params["code_departement_ban_eq"] = sale.department
    return params


def dpe_rows_from_payload(
    sale: AuctionSale,
    payload: dict[str, Any],
    *,
    source_api_url: str,
    request_params: dict[str, object] | None = None,
) -> list[DpeDiagnostic]:
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        return []

    rows: list[DpeDiagnostic] = []
    seen: set[str] = set()
    for result in results:
        if not isinstance(result, dict):
            continue
        diagnostic = dpe_diagnostic_from_result(
            sale,
            result,
            source_api_url=source_api_url,
            request_params=request_params or {},
        )
        if diagnostic is None or diagnostic.diagnostic_number in seen:
            continue
        seen.add(diagnostic.diagnostic_number)
        rows.append(diagnostic)
    return rows


def dpe_diagnostic_from_result(
    sale: AuctionSale,
    result: dict[str, Any],
    *,
    source_api_url: str,
    request_params: dict[str, object],
) -> DpeDiagnostic | None:
    diagnostic_number = text_value(result.get("numero_dpe"))
    if not diagnostic_number:
        return None

    latitude, longitude = geopoint(result.get("_geopoint"))
    match_kind = "geo_distance" if "geo_distance" in request_params else "address_query"
    confidence = match_confidence(sale, result, latitude=latitude, longitude=longitude, match_kind=match_kind)
    return DpeDiagnostic(
        source_url=sale.source_url,
        diagnostic_number=diagnostic_number,
        dpe_class=normalize_dpe_class(result.get("etiquette_dpe")),
        ges_class=normalize_dpe_class(result.get("etiquette_ges")),
        established_at=date_value(result.get("date_etablissement_dpe")),
        valid_until=date_value(result.get("date_fin_validite_dpe")),
        last_modified_at=date_value(result.get("date_derniere_modification_dpe")),
        property_type=text_value(result.get("type_batiment")),
        address=text_value(result.get("adresse_ban")) or text_value(result.get("adresse_complete_brut")),
        city=text_value(result.get("nom_commune_ban")),
        postal_code=text_value(result.get("code_postal_ban")),
        insee_code=text_value(result.get("code_insee_ban")),
        department=text_value(result.get("code_departement_ban")) or sale.department,
        surface_m2=positive_float(result.get("surface_habitable_logement"))
        or positive_float(result.get("surface_habitable_immeuble")),
        energy_consumption_kwh_m2_year=positive_float(result.get("conso_5_usages_par_m2_ep")),
        emissions_kg_co2_m2_year=positive_float(result.get("emission_ges_5_usages_par_m2")),
        ban_score=bounded_float(result.get("score_ban"), minimum=0, maximum=1),
        latitude=latitude,
        longitude=longitude,
        match_kind=match_kind,
        confidence=confidence,
        source_api_url=source_api_url,
        raw_payload={
            "request": request_params,
            "result": result,
        },
    )


def match_confidence(
    sale: AuctionSale,
    result: dict[str, Any],
    *,
    latitude: float | None,
    longitude: float | None,
    match_kind: str,
) -> float:
    confidence = 0.62 if match_kind == "address_query" else 0.72
    if sale.department and text_value(result.get("code_departement_ban")) == sale.department:
        confidence += 0.05
    if sale.postal_code and text_value(result.get("code_postal_ban")) == sale.postal_code:
        confidence += 0.08
    if sale.city and same_text(sale.city, text_value(result.get("nom_commune_ban"))):
        confidence += 0.05

    ban_score = bounded_float(result.get("score_ban"), minimum=0, maximum=1)
    if ban_score is not None:
        confidence += min(0.08, max(0, ban_score - 0.55) / 5)

    if sale.latitude is not None and sale.longitude is not None and latitude is not None and longitude is not None:
        distance = haversine_m(float(sale.latitude), float(sale.longitude), latitude, longitude)
        if distance <= 35:
            confidence += 0.12
        elif distance <= 120:
            confidence += 0.06
        else:
            confidence -= 0.12

    return round(min(0.95, max(0.35, confidence)), 2)


def geopoint(value: object) -> tuple[float | None, float | None]:
    text = text_value(value)
    if not text or "," not in text:
        return None, None
    lat_text, lng_text = text.split(",", 1)
    lat = bounded_float(lat_text, minimum=-90, maximum=90)
    lng = bounded_float(lng_text, minimum=-180, maximum=180)
    return lat, lng


def normalize_dpe_class(value: object) -> str | None:
    text = text_value(value)
    if not text:
        return None
    normalized = text.strip().upper()[:1]
    return normalized if normalized in DPE_CLASSES else None


def text_value(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).replace("\x00", "").strip()
    return text or None


def date_value(value: object) -> str | None:
    text = text_value(value)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        return None


def positive_float(value: object) -> float | None:
    number = bounded_float(value, minimum=0)
    return number if number is not None and number > 0 else None


def bounded_float(value: object, *, minimum: float, maximum: float | None = None) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(str(value).replace(",", "."))
    except ValueError:
        return None
    if math.isnan(number) or number < minimum:
        return None
    if maximum is not None and number > maximum:
        return None
    return number


def same_text(left: str, right: str | None) -> bool:
    if not right:
        return False
    return clean_text(left).casefold() == clean_text(right).casefold()


def haversine_m(first_lat: float, first_lng: float, second_lat: float, second_lng: float) -> float:
    radius = 6_371_000
    phi1 = math.radians(first_lat)
    phi2 = math.radians(second_lat)
    delta_phi = math.radians(second_lat - first_lat)
    delta_lambda = math.radians(second_lng - first_lng)
    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
