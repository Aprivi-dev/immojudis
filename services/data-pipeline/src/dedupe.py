from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterable
from typing import Any

from src.models import AuctionSale
from src.normalize import clean_text

_STREET_NUMBER_RE = re.compile(r"\d")

PRIMARY_SOURCE_PRIORITY = {
    "avoventes": 0,
    "info_encheres": 1,
    "licitor": 2,
    "encheres_publiques": 3,
    "vench": 4,
}

RICHNESS_FIELDS = (
    "address",
    "postal_code",
    "tribunal",
    "property_type",
    "surface_m2",
    "habitable_surface_m2",
    "land_surface_m2",
    "carrez_surface_m2",
    "app_surface_m2",
    "rooms_count",
    "bedrooms_count",
    "bathrooms_count",
    "parking_count",
    "occupancy_status",
    "lawyer_name",
    "lawyer_contact",
    "latitude",
    "longitude",
    "investment_score",
    "investment_summary",
)


def compute_content_hash(sale: AuctionSale) -> str:
    parts = [
        clean_text(sale.address) or "",
        clean_text(sale.city) or "",
        sale.sale_date.isoformat() if sale.sale_date else "",
        str(sale.starting_price_eur or ""),
    ]
    normalized = "|".join(part.lower() for part in parts)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def dedupe_sales(sales: Iterable[AuctionSale]) -> list[AuctionSale]:
    return merge_duplicate_sales(sales)


def merge_duplicate_sales(sales: Iterable[AuctionSale]) -> list[AuctionSale]:
    by_source_url: dict[str, AuctionSale] = {}
    for sale in sales:
        _ensure_observation_metadata(sale)
        if not sale.content_hash:
            sale.content_hash = compute_content_hash(sale)
        existing = by_source_url.get(sale.source_url)
        if existing is None or _is_richer(sale, existing):
            by_source_url[sale.source_url] = sale
        elif existing is not sale:
            _merge_into(existing, sale, confidence="source_url")

    by_hash: dict[str, AuctionSale] = {}
    passthrough: list[AuctionSale] = []
    for sale in by_source_url.values():
        key = sale.content_hash or compute_content_hash(sale)
        if not _has_strong_dedupe_signal(sale):
            sale.dedupe_confidence = sale.dedupe_confidence or "source_url_only"
            passthrough.append(sale)
            continue
        existing = by_hash.get(key)
        if existing is None:
            by_hash[key] = sale
            sale.dedupe_confidence = sale.dedupe_confidence or "content_hash"
            continue
        preferred, secondary = _choose_primary(existing, sale), sale
        if preferred is sale:
            secondary = existing
            by_hash[key] = sale
        _merge_into(preferred, secondary, confidence="content_hash")

    # Dernière passe : fusionner les annonces partageant une même adresse précise
    # (numéro + voie + commune) même si la date ou le prix diffèrent légèrement —
    # cas typique de deux sources référençant le même bien. Le hash de contenu
    # ci-dessus ne les rapproche pas car il inclut date et prix.
    survivors = [*by_hash.values(), *passthrough]
    return _merge_by_address(survivors)


def _is_richer(candidate: AuctionSale, current: AuctionSale) -> bool:
    return _richness_score(candidate) > _richness_score(current)


def _choose_primary(first: AuctionSale, second: AuctionSale) -> AuctionSale:
    first_score = _richness_score(first)
    second_score = _richness_score(second)
    if first_score != second_score:
        return first if first_score > second_score else second
    first_priority = PRIMARY_SOURCE_PRIORITY.get(first.source_name, 99)
    second_priority = PRIMARY_SOURCE_PRIORITY.get(second.source_name, 99)
    if first_priority != second_priority:
        return first if first_priority < second_priority else second
    return first


def _richness_score(sale: AuctionSale) -> int:
    score = sum(not _is_empty(getattr(sale, field)) for field in RICHNESS_FIELDS)
    score += min(len(sale.documents), 3)
    score += min(len(sale.score_factors), 3)
    score += min(len(sale.quality_flags), 3)
    if sale.raw_text:
        score += min(len(sale.raw_text) // 250, 4)
    return score


def _merge_into(target: AuctionSale, source: AuctionSale, confidence: str) -> AuctionSale:
    target.primary_source = target.primary_source or target.source_name
    target.dedupe_confidence = confidence
    for url in [source.source_url, *source.source_urls]:
        if url and url not in target.source_urls:
            target.source_urls.append(url)

    target.observations.extend(_new_observations(target, source))

    for field in _mergeable_fields():
        current = getattr(target, field)
        incoming = getattr(source, field)
        if _is_empty(current) and not _is_empty(incoming):
            setattr(target, field, incoming)
        elif field in {"documents", "quality_flags"} and isinstance(current, list) and isinstance(incoming, list):
            setattr(target, field, _merge_lists(current, incoming))
        elif field == "raw_payload" and isinstance(current, dict) and isinstance(incoming, dict):
            current.setdefault("merged_sources", [])
            current["merged_sources"].append(_observation_summary(source))

    if source.raw_text and source.raw_text not in (target.raw_text or ""):
        target.raw_text = clean_text(f"{target.raw_text or ''}\n\n--- SOURCE {source.source_name.upper()} ---\n{source.raw_text}")
    return target


def _ensure_observation_metadata(sale: AuctionSale) -> None:
    sale.primary_source = sale.primary_source or sale.source_name
    if sale.source_url not in sale.source_urls:
        sale.source_urls.append(sale.source_url)
    if not sale.observations:
        sale.observations.append(_observation_summary(sale))


def _new_observations(target: AuctionSale, source: AuctionSale) -> list[dict[str, Any]]:
    existing_urls = {item.get("source_url") for item in target.observations if isinstance(item, dict)}
    observations = source.observations or [_observation_summary(source)]
    return [item for item in observations if isinstance(item, dict) and item.get("source_url") not in existing_urls]


def _observation_summary(sale: AuctionSale) -> dict[str, Any]:
    return {
        "source_name": sale.source_name,
        "source_url": sale.source_url,
        "external_id": sale.external_id,
        "title": sale.title,
        "city": sale.city,
        "postal_code": sale.postal_code,
        "department": sale.department,
        "starting_price_eur": float(sale.starting_price_eur) if sale.starting_price_eur is not None else None,
        "sale_date": sale.sale_date.isoformat() if sale.sale_date else None,
        "raw_payload": sale.raw_payload,
    }


def _has_strong_dedupe_signal(sale: AuctionSale) -> bool:
    signals = [
        bool(clean_text(sale.address)),
        bool(clean_text(sale.city)),
        bool(sale.sale_date),
        bool(sale.starting_price_eur),
        bool(clean_text(sale.postal_code)),
    ]
    return sum(signals) >= 3


def _normalize_street_text(value: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    ascii_text = re.sub(r"\bfrance\b", " ", ascii_text)
    ascii_text = re.sub(r"\bcedex\b\s*\d*", " ", ascii_text)
    ascii_text = re.sub(r"[^a-z0-9]+", " ", ascii_text)
    return re.sub(r"\s+", " ", ascii_text).strip()


def _address_dedupe_key(sale: AuctionSale) -> str | None:
    address = clean_text(sale.address)
    if not address:
        return None
    street = address
    for token in (clean_text(sale.postal_code), clean_text(sale.city)):
        if token:
            street = re.sub(re.escape(token), " ", street, flags=re.IGNORECASE)
    street_key = _normalize_street_text(street)
    # Exiger une adresse précise (numéro de voie) : sans numéro on risquerait de
    # fusionner des biens distincts d'une même commune (ex. « 33000 Bordeaux »).
    if not _STREET_NUMBER_RE.search(street_key) or len(street_key) < 6:
        return None
    locality = clean_text(sale.postal_code) or _normalize_street_text(clean_text(sale.city) or "")
    return f"{street_key}|{(locality or '').lower()}"


def _prices_close(first: Any, second: Any, tolerance: float = 0.02) -> bool:
    try:
        left = float(first)
        right = float(second)
    except (TypeError, ValueError):
        return False
    if left <= 0 or right <= 0:
        return False
    return abs(left - right) <= tolerance * max(left, right)


def _same_property(first: AuctionSale, second: AuctionSale) -> bool:
    # Deux annonces à la même adresse précise = même bien, SAUF si elles sont
    # clairement deux lots/ventes distincts : date ET prix renseignés des deux
    # côtés et tous deux différents (ex. deux lots d'un même immeuble). Sinon
    # (date ou prix concordant, ou champ manquant) on fusionne.
    if first.sale_date and second.sale_date and first.starting_price_eur and second.starting_price_eur:
        dates_differ = first.sale_date != second.sale_date
        prices_differ = not _prices_close(first.starting_price_eur, second.starting_price_eur)
        if dates_differ and prices_differ:
            return False
    return True


def _merge_by_address(sales: list[AuctionSale]) -> list[AuctionSale]:
    by_address: dict[str, AuctionSale] = {}
    passthrough: list[AuctionSale] = []
    for sale in sales:
        key = _address_dedupe_key(sale)
        if key is None:
            passthrough.append(sale)
            continue
        existing = by_address.get(key)
        if existing is None:
            by_address[key] = sale
            continue
        if not _same_property(existing, sale):
            # Même adresse mais lots/ventes distincts : on conserve les deux.
            passthrough.append(sale)
            continue
        preferred = _choose_primary(existing, sale)
        secondary = sale if preferred is existing else existing
        _merge_into(preferred, secondary, confidence="address")
        by_address[key] = preferred
    return [*by_address.values(), *passthrough]


def _mergeable_fields() -> tuple[str, ...]:
    return (
        "external_id",
        "tribunal",
        "department",
        "city",
        "address",
        "postal_code",
        "property_type",
        "title",
        "description",
        "surface_m2",
        "habitable_surface_m2",
        "land_surface_m2",
        "carrez_surface_m2",
        "app_surface_m2",
        "app_surface_kind",
        "surface_source",
        "surface_confidence",
        "surface_evidence",
        "rooms_count",
        "bedrooms_count",
        "bathrooms_count",
        "parking_count",
        "has_garden",
        "has_terrace",
        "has_garage",
        "has_pool",
        "has_air_conditioning",
        "has_double_glazing",
        "starting_price_eur",
        "sale_date",
        "visit_dates",
        "lawyer_name",
        "lawyer_contact",
        "status",
        "adjudication_price_eur",
        "documents",
        "latitude",
        "longitude",
        "occupancy_status",
        "risk_notes",
        "investment_score",
        "investment_summary",
        "quality_flags",
        "raw_payload",
    )


def _is_empty(value: Any) -> bool:
    return value is None or value == [] or value == {} or value == ""


def _merge_lists(first: list[Any], second: list[Any]) -> list[Any]:
    merged: list[Any] = []
    seen: set[str] = set()
    for item in [*first, *second]:
        marker = repr(item)
        if marker in seen:
            continue
        seen.add(marker)
        merged.append(item)
    return merged
