from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from src.dvf_import import (
    DVF_ADJUDICATION_MUTATION_MARKERS,
    clean_text,
    derived_dvf_mutation_id,
    first_value,
    inspect_dvf_source,
    iter_dvf_rows,
    normalize_dvf_row,
    raw_dvf_mutation_group_signature,
    raw_dvf_mutation_identity_signature,
)

DVF_OFFICIAL_SOURCE_NAME = "dvf_dgfip"
DVF_OFFICIAL_DATASET_URL = "https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres"
DVF_ADJUDICATION_RECORD_KIND = "auction_result_candidate"


@dataclass(frozen=True)
class DvfAdjudicationCandidate:
    external_record_id: str
    sale_date: date
    total_price_eur: Decimal
    property_type: str | None
    parcel_ids: tuple[str, ...]
    address: str | None
    city: str | None
    postal_code: str | None
    insee_code: str | None
    department: str | None
    source_url: str
    content_hash: str
    raw_row_count: int
    property_count: int
    deduplication_key: str | None = None
    source_artifact_sha256: str | None = None
    source_artifact_file_name: str | None = None
    source_member_name: str | None = None
    source_record_start: int | None = None
    source_record_end: int | None = None
    source_identity_confidence: str = "derived_contiguous_price_free_signature"
    record_kind: str = DVF_ADJUDICATION_RECORD_KIND
    evidence_grade: str = "C"
    review_status: str = "pending"
    training_eligible: bool = False

    def normalized_data(self) -> dict[str, object]:
        """JSON-safe source projection; money stays decimal text, never float."""
        return {
            "schema_version": "dvf_adjudication_candidate_v1",
            "mutation_nature": "Adjudication",
            "sale_date": self.sale_date.isoformat(),
            "total_price_eur": format(self.total_price_eur, "f"),
            "property_type": self.property_type,
            "parcel_ids": list(self.parcel_ids),
            "address": self.address,
            "city": self.city,
            "postal_code": self.postal_code,
            "insee_code": self.insee_code,
            "department": self.department,
            "raw_row_count": self.raw_row_count,
            "property_count": self.property_count,
            "deduplication_key": self.deduplication_key,
            "source_identity_confidence": self.source_identity_confidence,
            "source_provenance": {
                "artifact_sha256": self.source_artifact_sha256,
                "artifact_file_name": self.source_artifact_file_name,
                "member_name": self.source_member_name,
                "record_start": self.source_record_start,
                "record_end": self.source_record_end,
            },
            "label_provenance": "dvf_matched",
            "evidence_grade": self.evidence_grade,
            "review_status": self.review_status,
            "training_eligible": self.training_eligible,
        }


@dataclass(frozen=True)
class AuctionLotMatchContext:
    lot_id: str
    scheduled_at: date | datetime | None
    parcel_ids: tuple[str, ...] = ()
    address: str | None = None
    city: str | None = None
    postal_code: str | None = None
    insee_code: str | None = None


@dataclass(frozen=True)
class DvfMatchCandidate:
    source_record_id: str
    lot_id: str
    match_score: Decimal
    match_method: str
    match_status: str
    signals: dict[str, object]
    automatic_link_allowed: bool = False
    training_eligible: bool = False


def iter_dvf_adjudication_candidates(
    path: Path,
    *,
    source_url: str = DVF_OFFICIAL_DATASET_URL,
    deduplicate: bool = True,
) -> Iterator[DvfAdjudicationCandidate]:
    """Stream DGFiP DVF and emit review-only adjudication candidates.

    The raw DGFiP export has no durable mutation identifier. Rows belonging to
    one mutation are contiguous, so identity is explicitly marked as derived
    and candidates remain ineligible for training until matched and reviewed.
    """
    artifact = inspect_dvf_source(path)
    source_member_name = artifact.members[0] if len(artifact.members) == 1 else None
    current_group_signature: tuple[str, ...] | None = None
    current_identity_signature: tuple[str, ...] | None = None
    current_occurrence: int | None = None
    current_transactions: list[dict[str, object]] = []
    current_raw_count = 0
    current_record_start: int | None = None
    current_record_end: int | None = None
    occurrence_counts: dict[tuple[str, ...], int] = {}
    emitted_deduplication_keys: set[str] = set()

    def flush() -> DvfAdjudicationCandidate | None:
        nonlocal current_group_signature, current_identity_signature, current_occurrence
        nonlocal current_transactions, current_raw_count
        nonlocal current_record_start, current_record_end
        if (
            current_group_signature is None
            or current_identity_signature is None
            or current_occurrence is None
            or not current_transactions
        ):
            current_group_signature = None
            current_identity_signature = None
            current_occurrence = None
            current_transactions = []
            current_raw_count = 0
            current_record_start = None
            current_record_end = None
            return None
        candidate = _candidate_from_group(
            current_identity_signature,
            current_transactions,
            raw_row_count=current_raw_count,
            occurrence=current_occurrence,
            source_url=source_url,
            source_artifact_sha256=artifact.sha256,
            source_artifact_file_name=artifact.file_name,
            source_member_name=source_member_name,
            source_record_start=current_record_start,
            source_record_end=current_record_end,
        )
        current_group_signature = None
        current_identity_signature = None
        current_occurrence = None
        current_transactions = []
        current_raw_count = 0
        current_record_start = None
        current_record_end = None
        if deduplicate and candidate.deduplication_key in emitted_deduplication_keys:
            return None
        if candidate.deduplication_key is not None:
            emitted_deduplication_keys.add(candidate.deduplication_key)
        return candidate

    for record_index, row in enumerate(iter_dvf_rows(path), start=1):
        if not _is_adjudication_row(row):
            candidate = flush()
            if candidate is not None:
                yield candidate
            continue

        group_signature = raw_dvf_mutation_group_signature(row)
        if current_group_signature is not None and group_signature != current_group_signature:
            candidate = flush()
            if candidate is not None:
                yield candidate
        if current_group_signature is None:
            identity_signature = raw_dvf_mutation_identity_signature(row)
            occurrence = occurrence_counts.get(identity_signature, 0) + 1
            occurrence_counts[identity_signature] = occurrence
            current_group_signature = group_signature
            current_identity_signature = identity_signature
            current_occurrence = occurrence
            current_record_start = record_index
        current_record_end = record_index
        current_raw_count += 1
        transaction = normalize_dvf_row(
            row,
            source_url=source_url,
            mutation_markers=DVF_ADJUDICATION_MUTATION_MARKERS,
        )
        if transaction is not None:
            transaction["source_mutation_id"] = derived_dvf_mutation_id(
                current_identity_signature,
                occurrence=current_occurrence,
            )
            current_transactions.append(transaction)

    candidate = flush()
    if candidate is not None:
        yield candidate


def match_dvf_adjudication(
    candidate: DvfAdjudicationCandidate,
    lot: AuctionLotMatchContext,
) -> DvfMatchCandidate:
    candidate_parcels = {
        normalized
        for value in candidate.parcel_ids
        if (normalized := _normalized_parcel_id(value))
    }
    lot_parcels = {
        normalized
        for value in lot.parcel_ids
        if (normalized := _normalized_parcel_id(value))
    }
    parcel_overlap = sorted(candidate_parcels & lot_parcels)

    scheduled_date = lot.scheduled_at.date() if isinstance(lot.scheduled_at, datetime) else lot.scheduled_at
    date_delta_days = abs((candidate.sale_date - scheduled_date).days) if scheduled_date else None
    exact_address = bool(
        _normalized_text(candidate.address)
        and _normalized_text(candidate.address) == _normalized_text(lot.address)
    )
    exact_insee = bool(candidate.insee_code and lot.insee_code and candidate.insee_code == lot.insee_code)
    exact_postal_city = bool(
        candidate.postal_code
        and lot.postal_code
        and candidate.postal_code == lot.postal_code
        and _normalized_text(candidate.city) == _normalized_text(lot.city)
    )

    score = Decimal("0")
    if parcel_overlap:
        score += Decimal("0.65")
    if date_delta_days == 0:
        score += Decimal("0.20")
    elif date_delta_days is not None and date_delta_days <= 30:
        score += Decimal("0.12")
    elif date_delta_days is not None and date_delta_days <= 180:
        score += Decimal("0.05")
    if exact_address:
        score += Decimal("0.10")
    if exact_insee:
        score += Decimal("0.05")
    elif exact_postal_city:
        score += Decimal("0.03")

    if not parcel_overlap:
        # Address-only matching can propose a queue item, never a strong link.
        score = min(score, Decimal("0.49"))
    score = min(score, Decimal("1")).quantize(Decimal("0.0001"))

    if parcel_overlap and date_delta_days is not None and date_delta_days <= 30 and score >= Decimal("0.75"):
        status = "strong_candidate"
        method = "parcel_and_date"
    elif parcel_overlap:
        status = "review_required"
        method = "parcel"
    elif exact_address and date_delta_days is not None and date_delta_days <= 30:
        status = "review_required"
        method = "address_and_date"
    else:
        status = "weak_candidate"
        method = "insufficient_signals"

    return DvfMatchCandidate(
        source_record_id=candidate.external_record_id,
        lot_id=lot.lot_id,
        match_score=score,
        match_method=method,
        match_status=status,
        signals={
            "parcel_overlap": parcel_overlap,
            "date_delta_days": date_delta_days,
            "exact_address": exact_address,
            "exact_insee": exact_insee,
            "exact_postal_city": exact_postal_city,
            "price_used_for_matching": False,
        },
    )


def _candidate_from_group(
    identity_signature: tuple[str, ...],
    transactions: list[dict[str, object]],
    *,
    raw_row_count: int,
    occurrence: int,
    source_url: str,
    source_artifact_sha256: str | None,
    source_artifact_file_name: str | None,
    source_member_name: str | None,
    source_record_start: int | None,
    source_record_end: int | None,
) -> DvfAdjudicationCandidate:
    sale_dates = {value for row in transactions if isinstance((value := row.get("sale_date")), date)}
    prices = {value for row in transactions if isinstance((value := row.get("total_price_eur")), Decimal)}
    if len(sale_dates) != 1 or len(prices) != 1:
        raise ValueError("A DVF adjudication group must have one date and one exact price.")

    representative = next(
        (row for row in transactions if row.get("built_surface_m2") is not None),
        transactions[0],
    )
    parcels: set[str] = set()
    property_signatures: set[tuple[str, ...]] = set()
    for row in transactions:
        if parcel_id := clean_text(str(row.get("parcel_id") or "")):
            parcels.add(parcel_id)
        raw_payload = row.get("raw_payload")
        lot_numbers: tuple[str, ...] = ()
        if isinstance(raw_payload, dict):
            for parcel_id in raw_payload.get("parcel_ids", []):
                if cleaned := clean_text(str(parcel_id)):
                    parcels.add(cleaned)
            raw_lot_numbers = raw_payload.get("lot_numbers")
            if isinstance(raw_lot_numbers, list):
                lot_numbers = tuple(sorted(str(value) for value in raw_lot_numbers))
        if row.get("built_surface_m2") is not None or row.get("land_surface_m2") is not None:
            property_signatures.add(
                (
                    str(row.get("parcel_id") or ""),
                    str(row.get("dvf_property_type_code") or ""),
                    _decimal_text(row.get("built_surface_m2")),
                    _decimal_text(row.get("land_surface_m2")),
                    str(row.get("rooms_count") or ""),
                    str(row.get("address") or ""),
                    *lot_numbers,
                )
            )

    derived_mutation_id = derived_dvf_mutation_id(
        identity_signature,
        occurrence=occurrence,
    )
    external_record_id = f"dvf-adjudication:{derived_mutation_id.rsplit(':', 1)[-1]}"
    semantic_projection = {
        "sale_date": next(iter(sale_dates)).isoformat(),
        "total_price_eur": format(next(iter(prices)), "f"),
        "property_type": representative.get("property_type"),
        "parcel_ids": sorted(parcels),
        "address": representative.get("address"),
        "city": representative.get("city"),
        "postal_code": representative.get("postal_code"),
        "insee_code": representative.get("insee_code"),
        "department": representative.get("department"),
        "property_fingerprints": sorted(property_signatures),
    }
    semantic_json = json.dumps(
        semantic_projection,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    deduplication_key = hashlib.sha256(semantic_json.encode()).hexdigest()
    content_projection = {
        **semantic_projection,
        "raw_row_count": raw_row_count,
        "property_count": len(property_signatures),
    }
    content_json = json.dumps(
        content_projection,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return DvfAdjudicationCandidate(
        external_record_id=external_record_id,
        sale_date=next(iter(sale_dates)),
        total_price_eur=next(iter(prices)),
        property_type=clean_text(str(representative.get("property_type") or "")),
        parcel_ids=tuple(sorted(parcels)),
        address=clean_text(str(representative.get("address") or "")),
        city=clean_text(str(representative.get("city") or "")),
        postal_code=clean_text(str(representative.get("postal_code") or "")),
        insee_code=clean_text(str(representative.get("insee_code") or "")),
        department=clean_text(str(representative.get("department") or "")),
        source_url=source_url,
        content_hash=hashlib.sha256(content_json.encode()).hexdigest(),
        raw_row_count=raw_row_count,
        property_count=len(property_signatures),
        deduplication_key=deduplication_key,
        source_artifact_sha256=source_artifact_sha256,
        source_artifact_file_name=source_artifact_file_name,
        source_member_name=source_member_name,
        source_record_start=source_record_start,
        source_record_end=source_record_end,
    )


def _is_adjudication_row(row: dict[str, str]) -> bool:
    nature = clean_text(first_value(row, "nature_mutation", "libnatmut"))
    return bool(nature and nature.casefold() == "adjudication")


def _normalized_text(value: str | None) -> str:
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    without_marks = "".join(character for character in decomposed if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]+", " ", without_marks.casefold()).strip()


def _normalized_parcel_id(value: str | None) -> str:
    return re.sub(r"[^A-Z0-9]+", "", (value or "").upper())


def _decimal_text(value: object) -> str:
    return format(value, "f") if isinstance(value, Decimal) else ""
