from __future__ import annotations

from datetime import UTC, date, datetime

from src.outcome_ingestion.dvf_matching import DvfAdjudicationMatchingService
from src.outcome_ingestion.repository import (
    StoredAuctionLotMatchContext,
    StoredDvfAdjudicationRecord,
)


def _record(
    *,
    source_record_id: str = "source-record-1",
    training_eligible: bool = False,
) -> StoredDvfAdjudicationRecord:
    return StoredDvfAdjudicationRecord(
        source_record_id=source_record_id,
        external_record_id="dvf-adjudication:one",
        normalized_data={
            "schema_version": "dvf_adjudication_candidate_v1",
            "mutation_nature": "Adjudication",
            "sale_date": "2025-05-14",
            "total_price_eur": "185000.00",
            "property_type": "Appartement",
            "parcel_ids": ["33063000AB0042"],
            "address": "12 RUE DU TEST",
            "city": "Bordeaux",
            "postal_code": "33000",
            "insee_code": "33063",
            "department": "33",
            "raw_row_count": 1,
            "property_count": 1,
            "review_status": "pending",
            "training_eligible": training_eligible,
        },
    )


def _context(
    *,
    parcel_ids: tuple[str, ...] = ("33 063 000 AB 0042",),
    scheduled_at: datetime | None = datetime(2025, 5, 14, 9, 0, tzinfo=UTC),
    address: str | None = "12 rue du Test",
) -> StoredAuctionLotMatchContext:
    return StoredAuctionLotMatchContext(
        case_id="case-1",
        lot_id="lot-1",
        round_id="round-1",
        scheduled_at=scheduled_at,
        scheduled_date_source="auction_round",
        parcel_ids=parcel_ids,
        address=address,
        city="Bordeaux",
        postal_code="33000",
        insee_code="33063",
    )


class FakeMatchingRepository:
    def __init__(
        self,
        *,
        active_lots: int = 1,
        records: list[StoredDvfAdjudicationRecord] | None = None,
        contexts: list[StoredAuctionLotMatchContext] | None = None,
        existing_match_id: str | None = None,
    ) -> None:
        self.active_lots = active_lots
        self.records = records if records is not None else [_record()]
        self.contexts = contexts if contexts is not None else [_context()]
        self.existing_match_id = existing_match_id
        self.load_record_limits: list[int | None] = []
        self.load_record_cursors: list[str | None] = []
        self.context_calls: list[dict[str, object]] = []
        self.find_calls: list[dict[str, object]] = []
        self.append_calls: list[dict[str, object]] = []

    def require_dvf_matching_schema(self) -> None:
        return None

    def has_active_outcome_lots(self) -> bool:
        return self.active_lots > 0

    def load_active_dvf_adjudication_records(
        self,
        *,
        limit: int | None,
        after_source_record_id: str | None,
    ) -> list[StoredDvfAdjudicationRecord]:
        self.load_record_limits.append(limit)
        self.load_record_cursors.append(after_source_record_id)
        start = 0
        if after_source_record_id is not None:
            start = next(
                (
                    index + 1
                    for index, record in enumerate(self.records)
                    if record.source_record_id == after_source_record_id
                ),
                len(self.records),
            )
        records = self.records[start:]
        return records if limit is None else records[:limit]

    def load_dvf_auction_match_contexts(self, **kwargs: object) -> list[StoredAuctionLotMatchContext]:
        self.context_calls.append(dict(kwargs))
        return self.contexts

    def find_current_source_record_match(self, **kwargs: object) -> str | None:
        self.find_calls.append(dict(kwargs))
        return self.existing_match_id

    def append_match_candidate(self, **kwargs: object) -> str:
        self.append_calls.append(dict(kwargs))
        return "match-1"


def test_reports_absent_outcome_lots_without_attempting_source_matching() -> None:
    repository = FakeMatchingRepository(active_lots=0)

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=10,
        context_limit=25,
    )

    assert summary.empty_reason == "no_active_outcome_lots"
    assert summary.outcome_lots_available is False
    assert summary.source_records_loaded == 0
    assert repository.load_record_limits == []
    assert summary.writes == 0


def test_dry_run_counts_objective_parcel_match_without_any_write() -> None:
    repository = FakeMatchingRepository()

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=10,
        context_limit=25,
    )

    assert summary.dry_run is True
    assert summary.source_records_loaded == 1
    assert summary.contexts_evaluated == 1
    assert summary.objective_candidates == 1
    assert summary.dry_run_candidates == 1
    assert summary.persisted_candidates == 0
    assert summary.automatic_matches == 0
    assert summary.training_eligibility_changes == 0
    assert repository.find_calls == []
    assert repository.append_calls == []
    assert repository.context_calls[0]["sale_date"] == date(2025, 5, 14)
    assert repository.context_calls[0]["address"] == "12 RUE DU TEST"


def test_persist_appends_review_candidate_with_objective_price_free_signals() -> None:
    repository = FakeMatchingRepository()

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=None,
        context_limit=25,
        persist=True,
    )

    assert summary.persisted_candidates == 1
    assert summary.writes == 1
    assert summary.automatic_matches == 0
    assert summary.training_eligibility_changes == 0
    assert len(repository.append_calls) == 1
    payload = repository.append_calls[0]
    assert payload["source_record_id"] == "source-record-1"
    assert payload["case_id"] == "case-1"
    assert payload["lot_id"] == "lot-1"
    assert payload["round_id"] == "round-1"
    assert payload["match_method"] == "parcel_and_date"
    signals = payload["match_signals"]
    assert isinstance(signals, dict)
    assert signals["parcel"] is True
    assert signals["mutation_date"] is True
    assert signals["automatic_link_allowed"] is False
    assert signals["training_eligible"] is False
    assert signals["price_used_for_matching"] is False
    assert not any("price_eur" in key for key in signals)


def test_existing_current_candidate_is_not_appended_twice() -> None:
    repository = FakeMatchingRepository(existing_match_id="existing-match")

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=1,
        context_limit=25,
        persist=True,
    )

    assert summary.objective_candidates == 1
    assert summary.existing_candidates == 1
    assert summary.persisted_candidates == 0
    assert repository.append_calls == []


def test_weak_context_and_training_eligible_source_are_never_persisted() -> None:
    weak = _context(parcel_ids=(), scheduled_at=None, address="99 rue différente")
    repository = FakeMatchingRepository(
        records=[
            _record(),
            _record(source_record_id="source-record-2", training_eligible=True),
        ],
        contexts=[weak],
    )

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=2,
        context_limit=25,
        persist=True,
    )

    assert summary.invalid_source_records == 1
    assert summary.weak_matches_skipped == 1
    assert summary.objective_candidates == 0
    assert summary.empty_reason == "no_objective_match_candidates"
    assert repository.append_calls == []


def test_duplicate_context_rows_are_evaluated_once() -> None:
    context = _context()
    repository = FakeMatchingRepository(contexts=[context, context])

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=1,
        context_limit=25,
    )

    assert summary.contexts_evaluated == 1
    assert summary.objective_candidates == 1


def test_global_source_bound_pages_and_reports_truncation() -> None:
    repository = FakeMatchingRepository(
        records=[
            _record(source_record_id="source-record-1"),
            _record(source_record_id="source-record-2"),
            _record(source_record_id="source-record-3"),
        ],
        contexts=[],
    )

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=2,
        page_size=1,
        context_limit=25,
    )

    assert summary.pages_loaded == 2
    assert summary.source_records_loaded == 2
    assert summary.last_source_record_id == "source-record-2"
    assert summary.truncated is True
    assert repository.load_record_limits == [1, 1, 1]
    assert repository.load_record_cursors == [
        None,
        "source-record-1",
        "source-record-2",
    ]


def test_global_source_bound_stops_on_terminal_short_page() -> None:
    repository = FakeMatchingRepository(
        records=[
            _record(source_record_id="source-record-1"),
            _record(source_record_id="source-record-2"),
            _record(source_record_id="source-record-3"),
        ],
        contexts=[],
    )

    summary = DvfAdjudicationMatchingService(repository).run(
        source_limit=10,
        page_size=2,
        context_limit=25,
    )

    assert summary.pages_loaded == 2
    assert summary.source_records_loaded == 3
    assert summary.last_source_record_id == "source-record-3"
    assert summary.truncated is False
    assert repository.load_record_limits == [2, 2]
    assert repository.load_record_cursors == [None, "source-record-2"]
