from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from src.official_sources.base import canonical_sha256
from src.outcome_ingestion.judilibre_matching import (
    JudilibreDecisionMatchingService,
    persisted_judilibre_matchable_decision,
)
from src.outcome_ingestion.repository import (
    PersistedSourceRecordMatch,
    StoredJudilibreAuctionMatchContext,
    StoredJudilibreCourtResolution,
    StoredJudilibreDecisionRecord,
)


def _projection(**overrides: object) -> dict[str, object]:
    projection: dict[str, object] = {
        "schema_version": "judilibre_decision_candidate_v3",
        "record_type": "judicial_decision_candidate",
        "judilibre_id": "private-decision-id",
        "jurisdiction": "tj",
        "location": "tj33063",
        "chamber": "chambre des saisies immobilières",
        "formation": None,
        "number": "22/00001",
        "numbers": ["DBXX-V-B7G-ABCDE"],
        "ecli": None,
        "nac": "78A",
        "decision_date": "2025-05-14",
        "update_date": "2025-05-15",
        "decision_type": "jugement",
        "solution": "adjudication",
        "solution_alt": None,
        "publication": [],
        "themes": [],
        "partial": False,
        "raw_representation_sha256": "e" * 64,
        "candidate_grade": "C",
        "review_status": "pending",
        "training_eligible": False,
        "text_storage": "private_raw_artifact",
        "personal_identity_features_allowed": False,
        "extraction_status": "candidate_facts_extracted",
        "extraction_rule_version": "judilibre_candidate_claims_v1",
        "ambiguous_claim_types": [],
        "text_available": True,
        "to_be_deleted": False,
        "claims": [
            {
                "claim_id": "a" * 64,
                "claim_type": "hammer_price_eur",
                "normalized_value": "185000.00",
                "confidence": 0.85,
                "evidence_hash": "b" * 64,
                "currency": "EUR",
            }
        ],
    }
    projection.update(overrides)
    return projection


def _record(
    *,
    source_record_id: str = "source-record-1",
    projection: dict[str, object] | None = None,
) -> StoredJudilibreDecisionRecord:
    data = projection or _projection()
    return StoredJudilibreDecisionRecord(
        source_record_id=source_record_id,
        external_record_id="private-decision-id",
        decision_date=date(2025, 5, 14),
        content_hash=canonical_sha256(data),
        normalized_data=data,
    )


def _court() -> StoredJudilibreCourtResolution:
    return StoredJudilibreCourtResolution(
        court_id="court-1",
        court_code="bordeaux",
        resolution_method="justice_structure_insee_exact_name",
        reference_sha256="c" * 64,
    )


def _context(
    *,
    case_id: str = "case-1",
    lot_id: str = "lot-1",
    round_id: str = "round-1",
    delta: int = 0,
    case_number: bool = False,
    portalis: bool = True,
) -> StoredJudilibreAuctionMatchContext:
    return StoredJudilibreAuctionMatchContext(
        case_id=case_id,
        lot_id=lot_id,
        round_id=round_id,
        court_id="court-1",
        scheduled_date=date(2025, 5, 14) + timedelta(days=delta),
        date_delta_days=delta,
        case_number_match=case_number,
        portalis_number_match=portalis,
    )


class FakeJudilibreMatchingRepository:
    def __init__(
        self,
        *,
        records: list[StoredJudilibreDecisionRecord] | None = None,
        courts: list[StoredJudilibreCourtResolution] | None = None,
        contexts: list[StoredJudilibreAuctionMatchContext] | None = None,
        matchable_rounds: bool = True,
        existing_match_id: str | None = None,
    ) -> None:
        self.records = records if records is not None else [_record()]
        self.courts = courts if courts is not None else [_court()]
        self.contexts = contexts if contexts is not None else [_context()]
        self.matchable_rounds = matchable_rounds
        self.existing_match_id = existing_match_id
        self.record_calls: list[dict[str, object]] = []
        self.court_calls: list[dict[str, object]] = []
        self.context_calls: list[dict[str, object]] = []
        self.append_calls: list[dict[str, object]] = []

    def require_judilibre_matching_schema(self) -> None:
        return None

    def has_matchable_judilibre_rounds(self) -> bool:
        return self.matchable_rounds

    def load_active_judilibre_decision_records(
        self,
        *,
        limit: int,
        after_source_record_id: str | None,
    ) -> list[StoredJudilibreDecisionRecord]:
        self.record_calls.append(
            {"limit": limit, "after_source_record_id": after_source_record_id}
        )
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
        return self.records[start : start + limit]

    def load_judilibre_court_resolutions(
        self, **kwargs: object
    ) -> list[StoredJudilibreCourtResolution]:
        self.court_calls.append(dict(kwargs))
        return self.courts

    def load_judilibre_auction_match_contexts(
        self, **kwargs: object
    ) -> list[StoredJudilibreAuctionMatchContext]:
        self.context_calls.append(dict(kwargs))
        limit = int(kwargs["limit"])
        return self.contexts[:limit]

    def append_judilibre_match_candidate(
        self, **kwargs: object
    ) -> PersistedSourceRecordMatch:
        self.append_calls.append(dict(kwargs))
        return PersistedSourceRecordMatch(
            match_id=self.existing_match_id or "match-1",
            inserted_new_candidate=self.existing_match_id is None,
        )


def test_matcher_stops_before_scanning_when_no_scheduled_round_exists() -> None:
    repository = FakeJudilibreMatchingRepository(matchable_rounds=False)

    summary = JudilibreDecisionMatchingService(repository).run(source_limit=10)

    assert summary.empty_reason == "no_matchable_auction_rounds"
    assert summary.source_records_loaded == 0
    assert summary.writes == 0
    assert repository.record_calls == []


def test_invalid_resume_cursor_fails_before_schema_or_round_queries() -> None:
    repository = FakeJudilibreMatchingRepository(matchable_rounds=False)

    with pytest.raises(ValueError, match="must be a UUID"):
        JudilibreDecisionMatchingService(repository).run(
            source_limit=10,
            after_source_record_id="not-a-uuid",
        )

    assert repository.record_calls == []


def test_dry_run_uses_canonical_court_date_and_exact_reference_without_writes() -> None:
    repository = FakeJudilibreMatchingRepository()

    summary = JudilibreDecisionMatchingService(repository).run(source_limit=10)

    assert summary.dry_run is True
    assert summary.source_records_loaded == 1
    assert summary.contexts_evaluated == 1
    assert summary.objective_candidates == 1
    assert summary.dry_run_candidates == 1
    assert summary.persisted_candidates == 0
    assert summary.automatic_matches == 0
    assert summary.outcomes_created == 0
    assert summary.training_eligibility_changes == 0
    assert repository.append_calls == []
    assert repository.court_calls == [{"location": "tj33063"}]
    assert repository.context_calls[0]["case_references"] == (
        "22/00001",
        "dbxx-v-b7g-abcde",
    )
    assert repository.context_calls[0]["limit"] == 251


def test_persist_appends_only_a_review_candidate_with_hash_only_provenance() -> None:
    repository = FakeJudilibreMatchingRepository()

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=10,
        persist=True,
    )

    assert summary.persisted_candidates == summary.writes == 1
    assert summary.automatic_matches == 0
    assert summary.outcomes_created == 0
    assert summary.training_eligibility_changes == 0
    payload = repository.append_calls[0]
    assert payload["expected_source_content_hash"] == _record().content_hash
    assert payload["expected_court_id"] == "court-1"
    assert payload["expected_decision_date"] == date(2025, 5, 14)
    assert payload["max_date_delta_days"] == 7
    assert payload["case_id"] == "case-1"
    assert payload["lot_id"] == "lot-1"
    assert payload["round_id"] == "round-1"
    assert "outcome_id" not in payload
    assert payload["match_method"] == "exact_portalis_number"
    assert payload["match_score"] == "0.9800"
    signals = payload["match_signals"]
    assert isinstance(signals, dict)
    assert signals["selection_requires_human_review"] is True
    assert signals["automatic_link_allowed"] is False
    assert signals["outcome_creation_allowed"] is False
    assert signals["training_eligible"] is False
    assert signals["claim_value_used_for_matching"] is False
    assert signals["price_used_for_matching"] is False
    assert signals["text_used_for_matching"] is False
    assert signals["address_used_for_matching"] is False
    assert signals["personal_identity_used_for_matching"] is False
    serialized = json.dumps(signals, sort_keys=True)
    for private_value in (
        "private-decision-id",
        "22/00001",
        "DBXX-V-B7G-ABCDE",
        "185000.00",
        "Mme Exemple",
    ):
        assert private_value not in serialized


def test_near_date_without_exact_reference_is_never_a_candidate() -> None:
    repository = FakeJudilibreMatchingRepository(
        contexts=[_context(delta=2, portalis=False, case_number=False)]
    )

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=10,
        persist=True,
    )

    assert summary.weak_contexts_skipped == 1
    assert summary.objective_candidates == 0
    assert summary.empty_reason == "no_objective_match_candidates"
    assert repository.append_calls == []


def test_unique_exact_court_and_date_can_only_create_a_review_candidate() -> None:
    repository = FakeJudilibreMatchingRepository(
        contexts=[_context(portalis=False, case_number=False)]
    )

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=10,
        persist=True,
    )

    assert summary.persisted_candidates == 1
    payload = repository.append_calls[0]
    assert payload["match_method"] == "composite"
    assert payload["match_score"] == "0.7500"
    assert payload["match_signals"]["court"] is True
    assert payload["match_signals"]["hearing_date_exact"] is True
    assert payload["match_signals"]["case_number"] is False
    assert payload["match_signals"]["portalis_number"] is False


def test_tied_objective_targets_fail_closed_as_ambiguous() -> None:
    repository = FakeJudilibreMatchingRepository(
        contexts=[
            _context(portalis=False, case_number=False),
            _context(
                case_id="case-2",
                lot_id="lot-2",
                round_id="round-2",
                portalis=False,
                case_number=False,
            ),
        ]
    )

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=10,
        persist=True,
    )

    assert summary.ambiguous_targets == 1
    assert summary.objective_candidates == 0
    assert repository.append_calls == []


def test_conflicting_exact_identifiers_fail_closed_instead_of_preferring_portalis() -> None:
    repository = FakeJudilibreMatchingRepository(
        contexts=[
            _context(delta=1, portalis=True, case_number=False),
            _context(
                case_id="case-2",
                lot_id="lot-2",
                round_id="round-2",
                portalis=False,
                case_number=True,
            ),
        ]
    )

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=10,
        persist=True,
    )

    assert summary.ambiguous_targets == 1
    assert summary.objective_candidates == 0
    assert repository.append_calls == []


def test_context_truncation_prevents_partial_selection_and_any_write() -> None:
    repository = FakeJudilibreMatchingRepository(
        contexts=[_context(), _context(round_id="round-2")]
    )

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=10,
        context_limit=1,
        persist=True,
    )

    assert summary.context_limits_reached == 1
    assert summary.contexts_evaluated == 0
    assert repository.context_calls[0]["limit"] == 2
    assert repository.append_calls == []


def test_ambiguous_claim_projection_fails_closed_before_court_lookup() -> None:
    data = _projection(ambiguous_claim_types=["hammer_price_eur"])
    repository = FakeJudilibreMatchingRepository(records=[_record(projection=data)])

    summary = JudilibreDecisionMatchingService(repository).run(source_limit=10)

    assert summary.invalid_source_records == 1
    assert summary.objective_candidates == 0
    assert repository.court_calls == []


def test_unknown_projection_field_is_rejected_by_the_closed_safe_schema() -> None:
    data = _projection(raw_text="Mme Exemple")
    repository = FakeJudilibreMatchingRepository(records=[_record(projection=data)])

    summary = JudilibreDecisionMatchingService(repository).run(source_limit=10)

    assert summary.invalid_source_records == 1
    assert summary.objective_candidates == 0
    assert repository.court_calls == []


def test_unresolved_or_ambiguous_court_never_reaches_context_matching() -> None:
    for courts, expected_field in (([], "unresolved_courts"), ([_court(), _court()], "ambiguous_courts")):
        repository = FakeJudilibreMatchingRepository(courts=courts)

        summary = JudilibreDecisionMatchingService(repository).run(source_limit=10)

        assert getattr(summary, expected_field) == 1
        assert repository.context_calls == []
        assert repository.append_calls == []


def test_existing_candidate_is_idempotently_skipped() -> None:
    repository = FakeJudilibreMatchingRepository(existing_match_id="match-existing")

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=10,
        persist=True,
    )

    assert summary.objective_candidates == 1
    assert summary.existing_candidates == 1
    assert summary.persisted_candidates == 0
    assert len(repository.append_calls) == 1


def test_global_limit_pages_and_reports_truncation_without_unbounded_scan() -> None:
    repository = FakeJudilibreMatchingRepository(
        records=[
            _record(source_record_id="source-record-1"),
            _record(source_record_id="source-record-2"),
            _record(source_record_id="source-record-3"),
        ],
        contexts=[],
    )

    summary = JudilibreDecisionMatchingService(repository).run(
        source_limit=2,
        page_size=1,
    )

    assert summary.pages_loaded == 2
    assert summary.source_records_loaded == 2
    assert summary.last_source_record_id == "source-record-2"
    assert summary.truncated is True
    assert repository.record_calls == [
        {"limit": 1, "after_source_record_id": None},
        {"limit": 1, "after_source_record_id": "source-record-1"},
        {"limit": 1, "after_source_record_id": "source-record-2"},
    ]


def test_projection_validator_detects_content_hash_drift() -> None:
    record = _record()
    tampered = StoredJudilibreDecisionRecord(
        source_record_id=record.source_record_id,
        external_record_id=record.external_record_id,
        decision_date=record.decision_date,
        content_hash="f" * 64,
        normalized_data=record.normalized_data,
    )

    try:
        persisted_judilibre_matchable_decision(tampered)
    except ValueError as exc:
        assert "hash mismatch" in str(exc)
    else:  # pragma: no cover - defensive assertion.
        raise AssertionError("tampered projection was accepted")
