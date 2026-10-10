"""Pure row builders for the normalised sale tables (property, judicial sale, surfaces, occurrences)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from src.admission import quarantine_reason
from src.models import AuctionSale
from src.storage.column_sets import JUDICIAL_SALE_COLUMNS, PROPERTY_COLUMNS


def _secondary_source_urls(sales: list[AuctionSale]) -> list[str]:
    primary_urls = {sale.source_url for sale in sales if sale.source_url}
    urls: list[str] = []
    seen: set[str] = set()
    for sale in sales:
        for source_url in sale.source_urls:
            if source_url in primary_urls or source_url in seen:
                continue
            seen.add(source_url)
            urls.append(source_url)
    return urls


def _property_rows_for_sales(
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for sale in sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in PROPERTY_COLUMNS}
        row["primary_source"] = row.get("primary_source") or row.get("source_name")
        row["source_urls"] = _normalized_source_urls(sale, data)
        row["raw_payload"] = data.get("raw_payload") if isinstance(data.get("raw_payload"), dict) else {}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        rows.append(row)
    return rows


def _judicial_sale_rows_for_sales(
    sales: list[AuctionSale],
    now: str,
    *,
    refresh_last_seen: bool = True,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for sale in sales:
        reason = quarantine_reason(sale)
        if reason:
            sale.raw_payload["publication_quarantine"] = reason
            sale.status = "quarantined"
        else:
            sale.raw_payload.pop("publication_quarantine", None)
        data = sale.to_storage_dict(exclude_none=False)
        row = {column: data.get(column) for column in JUDICIAL_SALE_COLUMNS}
        row["property_source_url"] = data.get("source_url")
        row["primary_source"] = row.get("primary_source") or row.get("source_name")
        row["source_urls"] = _normalized_source_urls(sale, data)
        row["visit_dates"] = data.get("visit_dates") if isinstance(data.get("visit_dates"), list) else []
        row["status"] = data.get("status") or "upcoming"
        row["source_lawyer_name"] = data.get("lawyer_name")
        row["source_lawyer_contact"] = data.get("lawyer_contact")
        documents = data.get("documents")
        row["documents_count"] = len(documents) if isinstance(documents, list) else 0
        row["score_factors"] = data.get("score_factors") if isinstance(data.get("score_factors"), list) else []
        row["quality_flags"] = data.get("quality_flags") if isinstance(data.get("quality_flags"), list) else []
        row["raw_payload"] = data.get("raw_payload") if isinstance(data.get("raw_payload"), dict) else {}
        row["last_seen_at"] = now if refresh_last_seen else data.get("last_seen_at") or now
        rows.append(row)
    return rows


def _normalized_source_urls(sale: AuctionSale, data: dict[str, Any]) -> list[str]:
    values = data.get("source_urls")
    source_urls = values if isinstance(values, list) else []
    urls = [data.get("source_url"), *source_urls, *sale.source_urls]
    normalized: list[str] = []
    seen: set[str] = set()
    for url in urls:
        if not isinstance(url, str) or not url or url in seen:
            continue
        normalized.append(url)
        seen.add(url)
    return normalized


def _unique_source_urls(source_urls: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for source_url in source_urls:
        if not source_url or source_url in seen:
            continue
        seen.add(source_url)
        unique.append(source_url)
    return unique


def _public_occurrence_row(occurrence: dict[str, object]) -> dict[str, object]:
    return {
        "source_url": occurrence["source_url"],
        "risk_type": occurrence["risk_type"],
        "risk_label": occurrence["risk_label"],
        "severity": occurrence["severity"],
        "document_url": occurrence.get("document_url"),
        "document_label": occurrence.get("document_label"),
        "document_type": occurrence.get("document_type"),
        "page_number": occurrence.get("page_number"),
        "excerpt": occurrence["excerpt"],
        "confidence": occurrence.get("confidence"),
        "detector": occurrence.get("detector"),
        "detector_version": occurrence.get("detector_version"),
        "matched_terms": occurrence.get("matched_terms") or [],
        "is_negated": occurrence.get("is_negated") or False,
        "score_impact": occurrence.get("score_impact"),
    }


def _document_extraction_status(extracted: dict[str, object]) -> str:
    """Map a PDF cache payload to the materialized document status.

    A partial cache can contain useful text while still having failed pages.
    Keep that payload visible for diagnostics, but never advertise it as a
    complete extraction in ``auction_documents``.
    """
    declared_status = str(extracted.get("extraction_status") or "").strip().lower()
    if declared_status in {"failed", "incomplete"}:
        return declared_status
    if extracted.get("complete") is False or extracted.get("failed_pages"):
        return "incomplete"
    if declared_status == "empty":
        return "empty"
    if (
        str(extracted.get("text") or "").strip()
        and extracted.get("complete") is True
        and str(extracted.get("sha256") or "").strip()
    ):
        return "extracted"
    return "pending"


def _unique_rows_by_keys(
    rows: list[dict[str, object]],
    keys: tuple[str, ...],
) -> list[dict[str, object]]:
    unique: dict[tuple[object, ...], dict[str, object]] = {}
    for row in rows:
        values = tuple(row.get(key) for key in keys)
        if any(value is None for value in values):
            continue
        unique[values] = row
    return list(unique.values())


def _unique_rows_by_key(rows: list[dict[str, object]], key: str) -> list[dict[str, object]]:
    return _unique_rows_by_keys(rows, (key,))


def _surface_measurement_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    analysis = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return []
    version = str(analysis.get("version") or "surface_reasoning_v1")
    measurements = analysis.get("measurements")
    if not isinstance(measurements, list):
        return []
    rows: list[dict[str, object]] = []
    for index, measurement in enumerate(measurements):
        if not isinstance(measurement, dict):
            continue
        evidence = measurement.get("evidence") if isinstance(measurement.get("evidence"), dict) else {}
        quote = str(evidence.get("quote") or "").strip()
        value = measurement.get("value_m2")
        if not quote or value is None:
            continue
        local_key = str(measurement.get("measurement_id") or index)
        rows.append(
            {
                "measurement_key": _surface_row_key(sale.source_url, local_key),
                "source_url": sale.source_url,
                "asset_id": str(measurement.get("asset_id") or "asset-main"),
                "lot_label": measurement.get("lot_label"),
                "level_label": measurement.get("level"),
                "space_label": str(measurement.get("space_label") or "pièce"),
                "category": str(measurement.get("category") or "unknown"),
                "value_m2": value,
                "included_in_habitable_sum": measurement.get("included_in_habitable_sum"),
                "confidence": measurement.get("confidence") or 0,
                "evidence_quote": quote,
                "document_url": evidence.get("document_url"),
                "document_label": evidence.get("document_label"),
                "page_number": evidence.get("page_number"),
                "extraction_method": str(measurement.get("extraction_method") or "unknown"),
                "reasoning_version": version,
            }
        )
    return rows


def _surface_derivation_rows_for_sale(sale: AuctionSale) -> list[dict[str, object]]:
    analysis = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return []
    version = str(analysis.get("version") or "surface_reasoning_v1")
    selected_id = str(analysis.get("selected_derivation_id") or "")
    derivations = analysis.get("derivations")
    candidates = analysis.get("candidates") if isinstance(analysis.get("candidates"), list) else []
    candidates_by_id = {
        str(item.get("candidate_id")): item
        for item in candidates
        if isinstance(item, dict) and item.get("candidate_id")
    }
    if not isinstance(derivations, list):
        return []
    rows: list[dict[str, object]] = []
    for index, derivation in enumerate(derivations):
        if not isinstance(derivation, dict):
            continue
        local_key = str(derivation.get("derivation_id") or index)
        operands = derivation.get("operand_measurement_ids")
        operand_keys = [
            _surface_row_key(sale.source_url, str(value))
            for value in operands
            if value
        ] if isinstance(operands, list) else []
        explicit_id = str(derivation.get("explicit_candidate_id") or "")
        rows.append(
            {
                "derivation_key": _surface_row_key(sale.source_url, local_key),
                "source_url": sale.source_url,
                "asset_id": str(derivation.get("asset_id") or "asset-main"),
                "kind": str(derivation.get("kind") or "unknown"),
                "value_m2": derivation.get("value_m2"),
                "operand_measurement_keys": operand_keys,
                "formula": str(derivation.get("formula") or "surface explicitement indiquée"),
                "validation_status": str(derivation.get("validation_status") or "rejected"),
                "confidence": derivation.get("confidence") or 0,
                "explicit_candidate": candidates_by_id.get(explicit_id),
                "warnings": derivation.get("warnings") or [],
                "is_selected": local_key == selected_id,
                "reasoning_version": version,
            }
        )
    return rows


def _surface_row_key(source_url: str, local_key: str) -> str:
    return hashlib.sha256(f"{source_url}\0{local_key}".encode()).hexdigest()


def _pdf_extraction_confidence(payload: Any) -> dict[str, object]:
    if not isinstance(payload, list):
        return {}
    document_confidences = []
    page_confidences = []
    ocr_pages = 0
    empty_pages = 0
    page_count = 0
    for item in payload:
        if not isinstance(item, dict):
            continue
        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)):
            document_confidences.append(float(confidence))
        pages = item.get("pages")
        if isinstance(pages, list):
            page_count += len(pages)
            for page in pages:
                if not isinstance(page, dict):
                    continue
                method = str(page.get("method") or "")
                if method.startswith("ocr_"):
                    ocr_pages += 1
                if not page.get("text"):
                    empty_pages += 1
                page_confidence = page.get("confidence")
                if isinstance(page_confidence, (int, float)):
                    page_confidences.append(float(page_confidence))
    confidence = document_confidences or page_confidences
    average = round(sum(confidence) / len(confidence), 3) if confidence else None
    return {
        "document_count": len(payload),
        "page_count": page_count,
        "ocr_pages": ocr_pages,
        "empty_pages": empty_pages,
        "average_confidence": average,
    }


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
