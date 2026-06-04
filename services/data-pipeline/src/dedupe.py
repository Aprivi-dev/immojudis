from __future__ import annotations

from collections.abc import Iterable
import hashlib
from typing import Any

from src.models import AuctionSale
from src.normalize import clean_text

PRIMARY_SOURCE_PRIORITY = {
    "avoventes": 0,
    "info_encheres": 1,
    "licitor": 2,
    "encheres_publiques": 3,
    "vench": 4,
}


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
    return [*by_hash.values(), *passthrough]


def _is_richer(candidate: AuctionSale, current: AuctionSale) -> bool:
    candidate_score = sum(value is not None and value != [] for value in candidate.model_dump().values())
    current_score = sum(value is not None and value != [] for value in current.model_dump().values())
    return candidate_score > current_score


def _choose_primary(first: AuctionSale, second: AuctionSale) -> AuctionSale:
    first_priority = PRIMARY_SOURCE_PRIORITY.get(first.source_name, 99)
    second_priority = PRIMARY_SOURCE_PRIORITY.get(second.source_name, 99)
    if first_priority != second_priority:
        return first if first_priority < second_priority else second
    return first if _is_richer(first, second) else second


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
