from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

import pandas as pd

from src.config import PROCESSED_DIR
from src.dedupe import compute_content_hash
from src.models import AuctionSale
from src.normalize import clean_text


def compare_source_sales(
    avoventes_sales: list[AuctionSale],
    licitor_sales: list[AuctionSale],
    errors: dict[str, list[str]] | None = None,
) -> dict[str, object]:
    for sale in [*avoventes_sales, *licitor_sales]:
        if not sale.content_hash:
            sale.content_hash = compute_content_hash(sale)

    licitor_by_hash = _index_by_hash(licitor_sales)
    licitor_by_loose_key = _index_by_loose_key(licitor_sales)
    used_licitor_urls: set[str] = set()
    matched: list[dict[str, object]] = []
    avoventes_only: list[dict[str, object]] = []

    for avoventes_sale in avoventes_sales:
        match_type = "content_hash"
        licitor_sale = licitor_by_hash.get(avoventes_sale.content_hash or "")
        if licitor_sale is None:
            match_type = "loose_key"
            licitor_sale = licitor_by_loose_key.get(compute_loose_match_key(avoventes_sale))

        if licitor_sale is None:
            avoventes_only.append(_sale_summary(avoventes_sale))
            continue

        used_licitor_urls.add(licitor_sale.source_url)
        matched.append(
            {
                "match_type": match_type,
                "content_hash": avoventes_sale.content_hash,
                "loose_key": compute_loose_match_key(avoventes_sale),
                "avoventes": _sale_summary(avoventes_sale),
                "licitor": _sale_summary(licitor_sale),
            }
        )

    licitor_only = [
        _sale_summary(sale) for sale in licitor_sales if sale.source_url not in used_licitor_urls
    ]
    return {
        "summary": {
            "avoventes_count": len(avoventes_sales),
            "licitor_count": len(licitor_sales),
            "matched_count": len(matched),
            "avoventes_only_count": len(avoventes_only),
            "licitor_only_count": len(licitor_only),
            "errors": {source: len(items) for source, items in (errors or {}).items()},
        },
        "matched": matched,
        "avoventes_only": avoventes_only,
        "licitor_only": licitor_only,
        "errors": errors or {},
    }


def export_comparison(report: dict[str, object], output_dir: Path = PROCESSED_DIR) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "source_comparison.json"
    csv_path = output_dir / "source_comparison.csv"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    rows = []
    for item in report.get("matched", []):
        if isinstance(item, dict):
            rows.append(_comparison_row("matched", item))
    for item in report.get("avoventes_only", []):
        if isinstance(item, dict):
            rows.append(_single_source_row("avoventes_only", item))
    for item in report.get("licitor_only", []):
        if isinstance(item, dict):
            rows.append(_single_source_row("licitor_only", item))
    pd.DataFrame(rows).to_csv(csv_path, index=False)
    return json_path, csv_path


def compute_loose_match_key(sale: AuctionSale) -> str:
    parts = [
        _fingerprint_text(sale.city),
        sale.sale_date.date().isoformat() if sale.sale_date else "",
        str(sale.starting_price_eur or ""),
        sale.department or "",
        sale.property_type or "",
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _index_by_hash(sales: list[AuctionSale]) -> dict[str, AuctionSale]:
    index: dict[str, AuctionSale] = {}
    for sale in sales:
        if sale.content_hash:
            index.setdefault(sale.content_hash, sale)
    return index


def _index_by_loose_key(sales: list[AuctionSale]) -> dict[str, AuctionSale]:
    index: dict[str, AuctionSale] = {}
    for sale in sales:
        key = compute_loose_match_key(sale)
        if key:
            index.setdefault(key, sale)
    return index


def _sale_summary(sale: AuctionSale) -> dict[str, object]:
    return {
        "source_name": sale.source_name,
        "source_url": sale.source_url,
        "external_id": sale.external_id,
        "department": sale.department,
        "city": sale.city,
        "postal_code": sale.postal_code,
        "address": sale.address,
        "property_type": sale.property_type,
        "title": sale.title,
        "starting_price_eur": float(sale.starting_price_eur) if sale.starting_price_eur else None,
        "sale_date": sale.sale_date.isoformat() if sale.sale_date else None,
        "lawyer_name": sale.lawyer_name,
        "content_hash": sale.content_hash,
        "loose_key": compute_loose_match_key(sale),
    }


def _comparison_row(status: str, item: dict[str, object]) -> dict[str, object]:
    avoventes = item.get("avoventes", {})
    licitor = item.get("licitor", {})
    return {
        "status": status,
        "match_type": item.get("match_type"),
        "avoventes_url": avoventes.get("source_url") if isinstance(avoventes, dict) else None,
        "licitor_url": licitor.get("source_url") if isinstance(licitor, dict) else None,
        "city": avoventes.get("city") if isinstance(avoventes, dict) else None,
        "department": avoventes.get("department") if isinstance(avoventes, dict) else None,
        "starting_price_eur": avoventes.get("starting_price_eur") if isinstance(avoventes, dict) else None,
        "sale_date": avoventes.get("sale_date") if isinstance(avoventes, dict) else None,
    }


def _single_source_row(status: str, item: dict[str, object]) -> dict[str, object]:
    return {
        "status": status,
        "match_type": None,
        "avoventes_url": item.get("source_url") if item.get("source_name") == "avoventes" else None,
        "licitor_url": item.get("source_url") if item.get("source_name") == "licitor" else None,
        "city": item.get("city"),
        "department": item.get("department"),
        "starting_price_eur": item.get("starting_price_eur"),
        "sale_date": item.get("sale_date"),
    }


def _fingerprint_text(value: object | None) -> str:
    text = clean_text(value) or ""
    text = "".join(
        char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char)
    )
    return re.sub(r"[^a-z0-9]+", "", text.lower())
