from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx

from src.cadastre_references import PROVIDER as CADASTRE_PROVIDER
from src.cadastre_references import resolve_sale_cadastre
from src.config import load_settings
from src.department_bounds import coordinates_in_department
from src.models import AuctionSale
from src.municipality_location import PROVIDER as MUNICIPALITY_PROVIDER
from src.municipality_location import (
    find_commune,
    is_municipality_point,
    locate_sale_by_municipality,
    restore_municipality_placeholder,
    take_municipality_placeholder,
)
from src.normalize import clean_text, extract_department, strip_accents
from src.position_quality import (
    GEOCODE_OUTSIDE_DEPARTMENT,
    IMPLAUSIBLE_COORDINATES,
    POSITION_FLAGS,
    UNVERIFIED_SOURCE_COORDINATES,
    add_position_flag,
    classify_distance_to_commune,
    distance_km,
    remove_flags,
    street_name_tokens,
    street_names_match,
)

LOGGER = logging.getLogger(__name__)
NEGATIVE_GEOCODE_CACHE_TTL = timedelta(days=14)
# A house number or street match below this score is usually another street of the same name.
ADDRESS_MIN_SCORE = 0.6
ADDRESS_RESULT_TYPES = frozenset({"housenumber", "street"})
RATE_LIMIT_BACKOFF_SECONDS = (1, 2, 4)
GEO_PRECISION_BY_TYPE = {
    "housenumber": "address",
    "street": "street",
    "locality": "street",
    "municipality": "municipality",
}


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
    # Nom de la voie trouvée (« Rue du Château d'Eau »), seulement pour un numéro ou une rue.
    street: str | None = None


def restore_accepted_geocode(sale: AuctionSale) -> bool:
    """Copy an accepted BAN result stored in ``raw_payload['geocode']`` into the empty coordinates.

    A commune-level result (``type`` municipality) used to stay in the evidence while
    ``latitude``/``longitude`` were empty. The point keeps its precision in ``geo_precision``
    (``municipality`` for a commune centroid) so the app can show it as approximate.
    """
    if sale.latitude is not None and sale.longitude is not None:
        return False
    evidence = sale.raw_payload.get("geocode") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(evidence, dict):
        return False
    if evidence.get("provider") != "ban_geoplateforme" or evidence.get("accepted") is not True:
        return False
    try:
        latitude = Decimal(str(evidence["latitude"]))
        longitude = Decimal(str(evidence["longitude"]))
    except (KeyError, ArithmeticError, ValueError):
        return False
    if GEO_PRECISION_BY_TYPE.get(str(evidence.get("type") or "")) != "municipality" and sale.raw_payload.get(
        "invalid_address_evidence"
    ):
        # Les coordonnées d'une adresse écartée (prix, bloc de cabinet) ont été retirées exprès.
        return False
    department = sale.department or extract_department(sale.postal_code)
    if not (Decimal(-90) <= latitude <= Decimal(90) and Decimal(-180) <= longitude <= Decimal(180)):
        return False
    if department and not _coordinates_in_department(latitude, longitude, department):
        return False
    sale.latitude = latitude
    sale.longitude = longitude
    precision = GEO_PRECISION_BY_TYPE.get(str(evidence.get("type") or ""))
    if precision:
        sale.raw_payload["geo_precision"] = precision
    return True


def geocode_sale(sale: AuctionSale) -> AuctionSale:
    """Fill latitude/longitude: cadastral parcels first, then the BAN geocoding service."""
    # Le centre de commune posé sans réseau (src.municipality_location) n'est pas une coordonnée de la source :
    # la BAN le remplace si elle trouve mieux, et la vente le garde si elle ne trouve rien.
    placeholder = take_municipality_placeholder(sale)
    try:
        return _geocode_sale(sale)
    finally:
        if placeholder is not None:
            restore_municipality_placeholder(sale, placeholder)


def _geocode_sale(sale: AuctionSale) -> AuctionSale:
    settings = load_settings()
    # A parcel named by the source (cessions de l'État) is more precise than any
    # commune centroid; a stored resolution is reused without a request.
    if resolve_sale_cadastre(sale, settings=settings, network=bool(settings["geocode_enabled"])):
        clear_position_flags(sale)
        return sale
    restore_accepted_geocode(sale)
    if coordinates_are_verified(sale) and _coordinates_match_department(sale):
        clear_position_flags(sale)
        return sale
    verify_source_coordinates(sale)

    if not settings["geocode_enabled"]:
        return sale

    _fill_location_from_city(sale, settings)
    query = _build_query(sale)
    if not query:
        return sale
    if _has_recent_negative_geocode_cache(sale, query):
        return sale

    api_url = str(settings["geocode_api_url"])
    min_score = float(settings["geocode_min_score"])
    street_mismatch = False
    try:
        result = geocode_address(query=query, api_url=api_url, min_score=min_score, postcode=sale.postal_code)
        if result is not None and not _result_street_matches(sale, result):
            # Un score de 0,6 suffit à la BAN pour une autre voie du même nom (« rue du Château » -> « Château d'Eau »).
            LOGGER.info("Ignoring BAN result on another street for %s: %s", sale.source_url, result.label)
            result = None
            street_mismatch = True
        if result is None and sale.city and (sale.latitude is None or sale.longitude is None):
            # The address failed: a commune centroid is better than no point at all,
            # as long as the sale keeps saying it is approximate.
            result = geocode_address(
                query=sale.city,
                api_url=api_url,
                min_score=min_score,
                postcode=sale.postal_code,
                result_type="municipality",
            )
            if result is not None and not _result_matches_department(result, sale):
                _reject_outside_department(sale, query=query, result=result)
                return sale
    except Exception as exc:
        LOGGER.warning("Geocoding failed for %s: %s", sale.source_url, exc)
        return sale

    if result is None:
        _store_negative_geocode_cache(sale, query=query, reason="street_mismatch" if street_mismatch else "no_result")
        return sale

    department = sale.department or extract_department(sale.postal_code) or extract_department(result.postcode)
    if department and not _coordinates_in_department(result.latitude, result.longitude, department):
        _reject_outside_department(sale, query=query, result=result)
        return sale

    sale.latitude = result.latitude
    sale.longitude = result.longitude
    precision = GEO_PRECISION_BY_TYPE.get(result.result_type or "")
    if precision:
        sale.raw_payload["geo_precision"] = precision
    else:
        sale.raw_payload.pop("geo_precision", None)
    _store_geocode_evidence(sale, query=query, result=result, accepted=True)
    # Le point vient d'être corrigé par un résultat accepté : les drapeaux de l'ancienne position n'ont plus lieu d'être.
    clear_position_flags(sale)
    # The commune code found by BAN completes cadastral references published without one.
    resolve_sale_cadastre(sale, settings=settings)
    return sale


def locate_sale_by_cadastre(sale: AuctionSale) -> AuctionSale:
    """Parcel location only (runs without BAN geocoding, e.g. in autonomous runs)."""
    settings = load_settings()
    if resolve_sale_cadastre(sale, settings=settings, network=bool(settings["geocode_enabled"])):
        clear_position_flags(sale)
    elif not restore_accepted_geocode(sale):
        # Les coordonnées de la source ne sont jamais passées par la BAN : au moins un contrôle de cohérence.
        verify_source_coordinates(sale)
        # Sans parcelle ni résultat BAN déjà accepté : au moins le centre de la commune, sans réseau.
        locate_sale_by_municipality(sale)
    else:
        verify_source_coordinates(sale)
    return sale


def clear_position_flags(sale: AuctionSale) -> None:
    """Retire les drapeaux de position : le point actuel est vérifié (BAN, parcelle) ou confirmé."""
    sale.quality_flags = remove_flags(sale.quality_flags, POSITION_FLAGS)


def _restore_precision_from_evidence(sale: AuctionSale) -> None:
    """Pose ``geo_precision`` quand le point est celui d'un résultat accepté qui l'a perdue (centre de commune compris)."""
    payload = sale.raw_payload
    if not isinstance(payload, dict) or payload.get("geo_precision"):
        return
    if sale.latitude is None or sale.longitude is None:
        return
    evidence = payload.get("geocode")
    if not isinstance(evidence, dict) or evidence.get("accepted") is not True:
        return
    if evidence.get("provider") not in {"ban_geoplateforme", MUNICIPALITY_PROVIDER}:
        return
    precision = GEO_PRECISION_BY_TYPE.get(str(evidence.get("type") or ""))
    try:
        same_point = (
            abs(float(sale.latitude) - float(evidence["latitude"])) <= 0.000001
            and abs(float(sale.longitude) - float(evidence["longitude"])) <= 0.000001
        )
    except (KeyError, TypeError, ValueError):
        return
    if precision and same_point:
        payload["geo_precision"] = precision


def verify_source_coordinates(sale: AuctionSale) -> str | None:
    """Contrôle de cohérence d'un point que ni la BAN ni le cadastre n'ont confirmé (sans réseau).

    Renvoie ``"implausible"`` (point hors du département de la vente, ou à plus de 40 km du centre de sa commune :
    il est retiré et ``implausible_coordinates`` posé), ``"unverified"`` (à plus de 12 km du centre de sa commune :
    il reste, avec ``unverified_source_coordinates``) ou ``None`` (cohérent : aucun drapeau de coordonnées source).
    Un point confirmé par la BAN ou le cadastre, ou un centre de commune, n'est pas une coordonnée de la source.
    """
    _restore_precision_from_evidence(sale)
    if sale.latitude is None or sale.longitude is None or not isinstance(sale.raw_payload, dict):
        return None
    if coordinates_are_verified(sale) or sale.raw_payload.get("geo_precision") == "parcel":
        clear_position_flags(sale)
        return None
    if is_municipality_point(sale):
        sale.quality_flags = remove_flags(sale.quality_flags, {UNVERIFIED_SOURCE_COORDINATES})
        return None

    latitude, longitude = float(sale.latitude), float(sale.longitude)
    department = sale.department or extract_department(sale.postal_code)
    status: str | None = None
    detail: dict[str, object] = {}
    if not _coordinates_in_department(sale.latitude, sale.longitude, department or ""):
        status = "implausible"
        detail = {"reason": "outside_department", "department": department}
    else:
        commune = find_commune(sale.city, sale.postal_code, sale.department)
        if commune is not None:
            kilometres = distance_km(latitude, longitude, float(commune["latitude"]), float(commune["longitude"]))
            status = classify_distance_to_commune(kilometres)
            detail = {"reason": "far_from_commune", "distance_km": round(kilometres, 1), "citycode": commune["code_insee"]}

    flags = remove_flags(sale.quality_flags, {IMPLAUSIBLE_COORDINATES, UNVERIFIED_SOURCE_COORDINATES})
    if status == "implausible":
        LOGGER.warning("Ignoring implausible coordinates for %s: %s", sale.source_url, detail)
        sale.raw_payload["rejected_source_coordinates"] = {"latitude": latitude, "longitude": longitude, **detail}
        sale.latitude = None
        sale.longitude = None
        sale.raw_payload.pop("geo_precision", None)
        add_position_flag(flags, IMPLAUSIBLE_COORDINATES)
    elif status == "unverified":
        add_position_flag(flags, UNVERIFIED_SOURCE_COORDINATES)
    sale.quality_flags = flags
    return status


def _result_street_matches(sale: AuctionSale, result: GeocodeResult) -> bool:
    """Le nom de voie trouvé est celui de l'adresse (vrai quand l'un des deux est introuvable ou sans voie)."""
    if result.result_type not in ADDRESS_RESULT_TYPES:
        return True
    wanted = street_name_tokens(sale.address, require_street_type=True)
    found = street_name_tokens(result.street, require_street_type=False)
    return street_names_match(wanted, found, result.score)


def _reject_outside_department(sale: AuctionSale, *, query: str, result: GeocodeResult) -> None:
    LOGGER.warning("Ignoring BAN result outside department for %s", sale.source_url)
    add_position_flag(sale.quality_flags, GEOCODE_OUTSIDE_DEPARTMENT)
    _store_geocode_evidence(
        sale,
        query=query,
        result=result,
        accepted=False,
        rejection_reason="outside_department",
    )


def coordinates_are_verified(sale: AuctionSale) -> bool:
    if sale.latitude is None or sale.longitude is None or not isinstance(sale.raw_payload, dict):
        return False
    evidence = sale.raw_payload.get("geocode")
    if not isinstance(evidence, dict):
        return False
    if evidence.get("provider") not in {"ban_geoplateforme", CADASTRE_PROVIDER} or evidence.get("accepted") is not True:
        return False
    try:
        evidence_latitude = float(evidence["latitude"])
        evidence_longitude = float(evidence["longitude"])
    except (KeyError, TypeError, ValueError):
        return False
    return (
        abs(float(sale.latitude) - evidence_latitude) <= 0.000001
        and abs(float(sale.longitude) - evidence_longitude) <= 0.000001
    )


def geocode_address(
    query: str,
    api_url: str = "https://data.geopf.fr/geocodage/search/",
    min_score: float = 0.45,
    postcode: str | None = None,
    result_type: str | None = None,
) -> GeocodeResult | None:
    features = _fetch_features(api_url, query=query, postcode=postcode, result_type=result_type, limit=1)
    return _result_from_feature(features[0], min_score) if features else None


def search_municipalities(
    city: str,
    api_url: str = "https://data.geopf.fr/geocodage/search/",
    min_score: float = 0.45,
    limit: int = 5,
) -> list[GeocodeResult]:
    features = _fetch_features(api_url, query=city, postcode=None, result_type="municipality", limit=limit)
    results = (_result_from_feature(feature, min_score) for feature in features)
    return [result for result in results if result is not None]


def _fetch_features(
    api_url: str,
    *,
    query: str,
    postcode: str | None,
    result_type: str | None,
    limit: int,
) -> list[dict]:
    params: dict[str, str | int] = {"q": query, "limit": limit}
    if postcode:
        params["postcode"] = postcode
    if result_type:
        params["type"] = result_type
    response = httpx.get(api_url, params=params, timeout=10)
    for delay in RATE_LIMIT_BACKOFF_SECONDS:
        if getattr(response, "status_code", None) != 429:
            break
        LOGGER.warning("BAN rate limit reached; retrying in %ss", delay)
        time.sleep(delay)
        response = httpx.get(api_url, params=params, timeout=10)
    response.raise_for_status()
    return response.json().get("features") or []


def _result_from_feature(feature: dict, min_score: float) -> GeocodeResult | None:
    properties = feature.get("properties") or {}
    score = float(properties.get("score") or 0)
    if score < min_score:
        return None
    result_type = clean_text(properties.get("type"))
    if result_type in ADDRESS_RESULT_TYPES and score < ADDRESS_MIN_SCORE:
        return None

    coordinates = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coordinates) < 2:
        return None

    longitude, latitude = coordinates[:2]
    street = (
        clean_text(properties.get("street") or properties.get("name")) if result_type in ADDRESS_RESULT_TYPES else None
    )
    return GeocodeResult(
        latitude=Decimal(str(latitude)),
        longitude=Decimal(str(longitude)),
        score=score,
        label=clean_text(properties.get("label")),
        result_type=result_type,
        city=clean_text(properties.get("city")),
        citycode=clean_text(properties.get("citycode")),
        postcode=_single_postcode(properties.get("postcode")),
        street=street,
    )


def _single_postcode(value: object) -> str | None:
    """A commune with several postcodes has no single one to show."""
    if isinstance(value, (list, tuple)):
        codes = {code for item in value if (code := clean_text(item))}
        return codes.pop() if len(codes) == 1 else None
    return clean_text(value)


def _fill_location_from_city(sale: AuctionSale, settings: dict) -> None:
    """Recover department and postal code from the commune when the source gave neither."""
    if sale.department or sale.postal_code or not sale.city:
        return
    try:
        results = search_municipalities(
            sale.city,
            api_url=str(settings["geocode_api_url"]),
            min_score=max(float(settings["geocode_min_score"]), ADDRESS_MIN_SCORE),
        )
    except Exception as exc:
        LOGGER.warning("City lookup failed for %s: %s", sale.source_url, exc)
        return
    if not results:
        return
    best = results[0]
    wanted = strip_accents(best.city or "").lower()
    homonyms = [result for result in results if strip_accents(result.city or "").lower() == wanted]
    departments = {_department_of_result(result) for result in homonyms}
    if len(departments) != 1 or None in departments:
        # Saint-Denis, Beaulieu… without a postal code there is no way to pick one.
        LOGGER.info("Ambiguous commune %r for %s", sale.city, sale.source_url)
        return
    sale.department = departments.pop()
    sale.postal_code = best.postcode
    sale.raw_payload["location_inferred_from_city"] = {
        "provider": best.provider,
        "city": sale.city,
        "citycode": best.citycode,
        "department": sale.department,
        "postal_code": best.postcode,
    }


def _department_of_result(result: GeocodeResult) -> str | None:
    citycode = result.citycode or ""
    if citycode[:2] in {"2A", "2B"}:
        return citycode[:2]
    if len(citycode) == 5 and citycode.isdigit():
        return citycode[:3] if citycode[:2] in {"97", "98"} else citycode[:2]
    return extract_department(result.postcode)


def _result_matches_department(result: GeocodeResult, sale: AuctionSale) -> bool:
    department = sale.department or extract_department(sale.postal_code)
    found = _department_of_result(result)
    return not department or not found or department == found


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
    return coordinates_in_department(latitude, longitude, department)


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
