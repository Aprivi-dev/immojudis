from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from src.outcome_ingestion.dvf_adjudication import (
    DVF_OFFICIAL_DATASET_URL,
    AuctionLotMatchContext,
    DvfAdjudicationCandidate,
    DvfMatchCandidate,
    match_dvf_adjudication,
)
from src.outcome_ingestion.repository import (
    OutcomeIngestionRepository,
    StoredAuctionLotMatchContext,
    StoredDvfAdjudicationRecord,
)

DVF_MATCH_PAGE_SIZE_DEFAULT = 500
DVF_MATCH_PAGE_SIZE_MAX = 5_000


class DvfMatchingDataError(ValueError):
    """A persisted source candidate is not safe to send to matching."""


@dataclass
class DvfMatchingSummary:
    dry_run: bool
    source_limit: int | None
    context_limit: int
    page_size: int = DVF_MATCH_PAGE_SIZE_DEFAULT
    after_source_record_id: str | None = None
    outcome_lots_available: bool = False
    pages_loaded: int = 0
    source_records_loaded: int = 0
    last_source_record_id: str | None = None
    invalid_source_records: int = 0
    records_without_contexts: int = 0
    contexts_evaluated: int = 0
    context_limits_reached: int = 0
    weak_matches_skipped: int = 0
    objective_candidates: int = 0
    existing_candidates: int = 0
    dry_run_candidates: int = 0
    persisted_candidates: int = 0
    automatic_matches: int = 0
    training_eligibility_changes: int = 0
    truncated: bool = False
    empty_reason: str | None = None

    @property
    def writes(self) -> int:
        return self.persisted_candidates


class DvfAdjudicationMatchingService:
    def __init__(self, repository: OutcomeIngestionRepository) -> None:
        self.repository = repository

    def run(
        self,
        *,
        source_limit: int | None,
        context_limit: int,
        persist: bool = False,
        after_source_record_id: str | None = None,
        page_size: int = DVF_MATCH_PAGE_SIZE_DEFAULT,
    ) -> DvfMatchingSummary:
        if source_limit is not None and source_limit < 1:
            raise ValueError("DVF source-record limit must be positive")
        if context_limit < 1:
            raise ValueError("DVF context limit must be positive")
        if page_size < 1 or page_size > DVF_MATCH_PAGE_SIZE_MAX:
            raise ValueError(
                f"DVF page size must be between 1 and {DVF_MATCH_PAGE_SIZE_MAX}"
            )
        summary = DvfMatchingSummary(
            dry_run=not persist,
            source_limit=source_limit,
            context_limit=context_limit,
            page_size=page_size,
            after_source_record_id=after_source_record_id,
            last_source_record_id=after_source_record_id,
        )
        self.repository.require_dvf_matching_schema()
        summary.outcome_lots_available = self.repository.has_active_outcome_lots()
        if not summary.outcome_lots_available:
            summary.empty_reason = "no_active_outcome_lots"
            return summary

        cursor_id = after_source_record_id
        while True:
            remaining = (
                None
                if source_limit is None
                else source_limit - summary.source_records_loaded
            )
            if remaining == 0:
                summary.truncated = bool(
                    self.repository.load_active_dvf_adjudication_records(
                        limit=1,
                        after_source_record_id=cursor_id,
                    )
                )
                break

            page_limit = page_size if remaining is None else min(page_size, remaining)
            records = self.repository.load_active_dvf_adjudication_records(
                limit=page_limit,
                after_source_record_id=cursor_id,
            )
            if not records:
                break
            if len(records) > page_limit:
                raise DvfMatchingDataError("DVF repository returned an oversized page")
            next_cursor_id = records[-1].source_record_id
            if next_cursor_id == cursor_id:
                raise DvfMatchingDataError("DVF source-record pagination did not advance")

            summary.pages_loaded += 1
            summary.source_records_loaded += len(records)
            summary.last_source_record_id = next_cursor_id
            for record in records:
                self._match_record(
                    record,
                    summary=summary,
                    context_limit=context_limit,
                    persist=persist,
                )

            cursor_id = next_cursor_id
            if len(records) < page_limit:
                break

        if summary.source_records_loaded == 0:
            summary.empty_reason = "no_active_dvf_source_records"
            return summary

        if summary.objective_candidates == 0 and summary.empty_reason is None:
            summary.empty_reason = "no_objective_match_candidates"
        return summary

    def _match_record(
        self,
        record: StoredDvfAdjudicationRecord,
        *,
        summary: DvfMatchingSummary,
        context_limit: int,
        persist: bool,
    ) -> None:
        try:
            candidate = persisted_dvf_candidate(record)
        except (DvfMatchingDataError, TypeError, ValueError):
            summary.invalid_source_records += 1
            return
        contexts = self.repository.load_dvf_auction_match_contexts(
            sale_date=candidate.sale_date,
            parcel_ids=candidate.parcel_ids,
            address=candidate.address,
            insee_code=candidate.insee_code,
            postal_code=candidate.postal_code,
            city=candidate.city,
            limit=context_limit,
        )
        if not contexts:
            summary.records_without_contexts += 1
            return
        if len(contexts) == context_limit:
            summary.context_limits_reached += 1

        seen_targets: set[tuple[str, str | None]] = set()
        for stored_context in contexts:
            target_key = (stored_context.lot_id, stored_context.round_id)
            if target_key in seen_targets:
                continue
            seen_targets.add(target_key)
            summary.contexts_evaluated += 1
            match = match_dvf_adjudication(
                candidate,
                auction_lot_match_context(stored_context),
            )
            if not is_objective_dvf_match(match):
                summary.weak_matches_skipped += 1
                continue
            summary.objective_candidates += 1
            if not persist:
                summary.dry_run_candidates += 1
                continue
            existing = self.repository.find_current_source_record_match(
                source_record_id=record.source_record_id,
                lot_id=stored_context.lot_id,
                round_id=stored_context.round_id,
            )
            if existing is not None:
                summary.existing_candidates += 1
                continue
            match_signals = persisted_match_signals(match)
            match_signals["scheduled_date_source"] = (
                stored_context.scheduled_date_source
            )
            if match_signals["parcel"] is True:
                match_signals["parcel_source"] = "auction_cadastre_parcels"
            self.repository.append_match_candidate(
                source_record_id=record.source_record_id,
                case_id=stored_context.case_id,
                lot_id=stored_context.lot_id,
                round_id=stored_context.round_id,
                match_score=format(match.match_score, "f"),
                match_method=match.match_method,
                match_signals=match_signals,
            )
            summary.persisted_candidates += 1


def persisted_dvf_candidate(
    record: StoredDvfAdjudicationRecord,
) -> DvfAdjudicationCandidate:
    data = record.normalized_data
    if data.get("schema_version") != "dvf_adjudication_candidate_v1":
        raise DvfMatchingDataError("unsupported persisted DVF candidate schema")
    if data.get("mutation_nature") != "Adjudication":
        raise DvfMatchingDataError("persisted DVF candidate is not an adjudication")
    if data.get("training_eligible") is not False:
        raise DvfMatchingDataError("persisted DVF candidate must remain non-training")

    sale_date = _required_date(data, "sale_date")
    total_price = _required_decimal(data, "total_price_eur")
    raw_parcels = data.get("parcel_ids")
    if not isinstance(raw_parcels, list):
        raise DvfMatchingDataError("persisted DVF candidate parcel_ids must be a list")
    parcel_ids = tuple(
        cleaned
        for value in raw_parcels
        if isinstance(value, str) and (cleaned := value.strip())
    )
    provenance = data.get("source_provenance")
    provenance_data = provenance if isinstance(provenance, Mapping) else {}
    return DvfAdjudicationCandidate(
        external_record_id=record.external_record_id,
        sale_date=sale_date,
        total_price_eur=total_price,
        property_type=_optional_text(data.get("property_type")),
        parcel_ids=parcel_ids,
        address=_optional_text(data.get("address")),
        city=_optional_text(data.get("city")),
        postal_code=_optional_text(data.get("postal_code")),
        insee_code=_optional_text(data.get("insee_code")),
        department=_optional_text(data.get("department")),
        source_url=DVF_OFFICIAL_DATASET_URL,
        content_hash="",
        raw_row_count=_nonnegative_int(data.get("raw_row_count")),
        property_count=_nonnegative_int(data.get("property_count")),
        deduplication_key=_optional_text(data.get("deduplication_key")),
        source_artifact_sha256=_optional_text(provenance_data.get("artifact_sha256")),
        source_artifact_file_name=_optional_text(provenance_data.get("artifact_file_name")),
        source_member_name=_optional_text(provenance_data.get("member_name")),
        source_record_start=_optional_int(provenance_data.get("record_start")),
        source_record_end=_optional_int(provenance_data.get("record_end")),
        source_identity_confidence=_optional_text(data.get("source_identity_confidence"))
        or "derived_contiguous_price_free_signature",
        evidence_grade=_optional_text(data.get("evidence_grade")) or "C",
        review_status=_optional_text(data.get("review_status")) or "pending",
        training_eligible=False,
    )


def auction_lot_match_context(
    context: StoredAuctionLotMatchContext,
) -> AuctionLotMatchContext:
    return AuctionLotMatchContext(
        lot_id=context.lot_id,
        scheduled_at=context.scheduled_at,
        parcel_ids=context.parcel_ids,
        address=context.address,
        city=context.city,
        postal_code=context.postal_code,
        insee_code=context.insee_code,
    )


def is_objective_dvf_match(match: DvfMatchCandidate) -> bool:
    parcel_overlap = match.signals.get("parcel_overlap")
    date_delta = match.signals.get("date_delta_days")
    exact_address = match.signals.get("exact_address") is True
    has_parcel = isinstance(parcel_overlap, list) and bool(parcel_overlap)
    has_close_date = isinstance(date_delta, int) and date_delta <= 30
    return has_parcel or (exact_address and has_close_date)


def persisted_match_signals(match: DvfMatchCandidate) -> dict[str, object]:
    signals = dict(match.signals)
    parcel_overlap = signals.get("parcel_overlap")
    date_delta = signals.get("date_delta_days")
    signals.update(
        {
            "parcel": isinstance(parcel_overlap, list) and bool(parcel_overlap),
            "mutation_date": isinstance(date_delta, int) and date_delta <= 30,
            "address": signals.get("exact_address") is True,
            "suggested_match_status": match.match_status,
            "automatic_link_allowed": False,
            "training_eligible": False,
            "price_used_for_matching": False,
        }
    )
    return signals


def _required_date(data: Mapping[str, object], key: str) -> date:
    value = data.get(key)
    if not isinstance(value, str):
        raise DvfMatchingDataError(f"persisted DVF candidate is missing {key}")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise DvfMatchingDataError(f"persisted DVF candidate has invalid {key}") from exc


def _required_decimal(data: Mapping[str, object], key: str) -> Decimal:
    value = data.get(key)
    if not isinstance(value, (str, int, Decimal)):
        raise DvfMatchingDataError(f"persisted DVF candidate is missing {key}")
    try:
        parsed = Decimal(str(value))
    except InvalidOperation as exc:
        raise DvfMatchingDataError(f"persisted DVF candidate has invalid {key}") from exc
    if not parsed.is_finite() or parsed <= 0:
        raise DvfMatchingDataError(f"persisted DVF candidate has invalid {key}")
    return parsed


def _optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _nonnegative_int(value: object) -> int:
    parsed = _optional_int(value)
    return max(0, parsed or 0)


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None
