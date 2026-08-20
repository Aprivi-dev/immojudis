from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from src.official_sources.base import canonical_sha256
from src.outcome_ingestion.repository import (
    OutcomeIngestionError,
    OutcomeIngestionRepository,
)


class QueryCursor:
    def __init__(
        self,
        *,
        one_values: list[tuple[object, ...] | None] | None = None,
        all_values: list[list[tuple[object, ...]]] | None = None,
    ) -> None:
        self.one_values = list(one_values or [])
        self.all_values = list(all_values or [])
        self.calls: list[tuple[str, object]] = []

    def __enter__(self) -> QueryCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: object = None) -> None:
        self.calls.append((" ".join(statement.split()), parameters))

    def fetchone(self) -> tuple[object, ...] | None:
        return self.one_values.pop(0) if self.one_values else None

    def fetchall(self) -> list[tuple[object, ...]]:
        return self.all_values.pop(0) if self.all_values else []


class QueryConnection:
    def __init__(self, cursor: QueryCursor) -> None:
        self._cursor = cursor
        self.commits = 0

    def __enter__(self) -> QueryConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> QueryCursor:
        return self._cursor

    def commit(self) -> None:
        self.commits += 1


def _repository(cursor: QueryCursor) -> OutcomeIngestionRepository:
    connection = QueryConnection(cursor)
    return OutcomeIngestionRepository(
        "postgresql://example",
        connect=lambda _url: connection,
    )


def _review_match_signals() -> dict[str, object]:
    references = ("22/00001",)
    claims = _review_claims()
    return {
        "schema_version": "judilibre_match_signals_v1",
        "match_rule_version": "judilibre-review-match-v1",
        "court": True,
        "court_resolution_method": "justice_structure_insee_exact_name",
        "court_resolution_reference_sha256": "b" * 64,
        "hearing_date": True,
        "hearing_date_exact": True,
        "hearing_date_delta_days": 0,
        "case_number": True,
        "portalis_number": False,
        "claim_types": ["hammer_price_eur"],
        "claims_manifest_sha256": canonical_sha256(
            {
                "schema_version": "judilibre_claim_manifest_v1",
                "claims": claims,
            }
        ),
        "case_reference_manifest_sha256": canonical_sha256(
            {
                "schema_version": "judilibre_case_reference_manifest_v1",
                "references": references,
            }
        ),
        "source_projection_sha256": "a" * 64,
        "target_context_sha256": canonical_sha256(
            {
                "schema_version": "judilibre_target_context_v1",
                "case_id": "case-1",
                "lot_id": "lot-1",
                "round_id": "round-1",
                "court_id": "court-1",
                "scheduled_date": date(2025, 5, 14),
            }
        ),
        "source_record_version_current_at_scan": True,
        "source_training_eligible": False,
        "selection_requires_human_review": True,
        "automatic_link_allowed": False,
        "outcome_creation_allowed": False,
        "training_eligible": False,
        "claim_value_used_for_matching": False,
        "price_used_for_matching": False,
        "text_used_for_matching": False,
        "address_used_for_matching": False,
        "personal_identity_used_for_matching": False,
        "source_record_sha256": canonical_sha256(
            {
                "schema_version": "judilibre_source_record_reference_v1",
                "source_record_id": "record-1",
            }
        ),
    }


def _review_claims() -> list[dict[str, object]]:
    return [
        {
            "claim_id": "c" * 64,
            "claim_type": "hammer_price_eur",
            "normalized_value": "185000.00",
            "confidence": 0.85,
            "evidence_hash": "d" * 64,
            "currency": "EUR",
        }
    ]


def _review_source_projection() -> dict[str, object]:
    return {
        "location": "tj33063",
        "number": "22/00001",
        "numbers": [],
        "claims": _review_claims(),
    }


def test_load_judilibre_records_is_current_approved_non_purged_and_claim_bounded() -> None:
    projection = {
        "schema_version": "judilibre_decision_candidate_v3",
        "training_eligible": False,
        "claims": [],
    }
    cursor = QueryCursor(
        all_values=[
            [
                (
                    "record-1",
                    "decision-private",
                    date(2025, 5, 14),
                    "a" * 64,
                    projection,
                )
            ]
        ]
    )

    records = _repository(cursor).load_active_judilibre_decision_records(limit=25)

    assert records[0].source_record_id == "record-1"
    assert records[0].decision_date == date(2025, 5, 14)
    statement, parameters = cursor.calls[0]
    assert "source.name = 'judilibre'" in statement
    assert "source.official" in statement
    assert "source.active" in statement
    assert "source.legal_review_status = 'approved'" in statement
    assert "source.ingestion_policy = 'allowed_automated'" in statement
    assert "join public.artifact_extractions extraction" in statement
    assert "extraction.extractor_name = 'judilibre_candidate_extraction'" in statement
    assert "extraction.output_hash = record.content_hash" in statement
    assert "judilibre-evidence-sha256-v1" in statement
    assert "evidence_sha256" in statement
    assert "raw_artifact_sha256" in statement
    assert "not record.training_eligible" in statement
    assert "judilibre_decision_candidate_v3" in statement
    assert '"ambiguous_claim_types": []' in statement
    assert "record.normalized_data->'ambiguous_claim_types' = '[]'::jsonb" in statement
    assert "jsonb_array_length(record.normalized_data->'claims') between 1 and 7" in statement
    assert "count(distinct claim->>'claim_type')" in statement
    assert "newer.record_version > record.record_version" in statement
    assert "public.source_purge_events" in statement
    assert "jsonb_build_object" in statement
    assert "record.normalized_data ?& array[" in statement
    assert "jsonb_object_keys(record.normalized_data)" in statement
    assert "'raw_text'" not in statement
    assert statement.endswith("limit %s")
    assert parameters == (25,)


def test_load_judilibre_records_uses_stable_composite_cursor() -> None:
    cursor_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    created_at = datetime(2025, 5, 14, 9, tzinfo=UTC)
    cursor = QueryCursor(
        one_values=[(created_at, cursor_id)],
        all_values=[[]],
    )

    records = _repository(cursor).load_active_judilibre_decision_records(
        limit=10,
        after_source_record_id=cursor_id,
    )

    assert records == []
    cursor_statement, cursor_parameters = cursor.calls[0]
    page_statement, page_parameters = cursor.calls[1]
    assert "record.id = %s::uuid" in cursor_statement
    assert "source.name = 'judilibre'" in cursor_statement
    assert cursor_parameters == (cursor_id,)
    assert "(record.created_at, record.id) > (%s::timestamptz, %s::uuid)" in page_statement
    assert "order by record.created_at, record.id" in page_statement
    assert page_parameters == (created_at, cursor_id, 10)


def test_load_judilibre_records_rejects_unknown_cursor_and_unbounded_page() -> None:
    cursor_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    cursor = QueryCursor(one_values=[None])
    repository = _repository(cursor)

    with pytest.raises(OutcomeIngestionError, match="cursor does not exist"):
        repository.load_active_judilibre_decision_records(
            limit=10,
            after_source_record_id=cursor_id,
        )
    with pytest.raises(ValueError, match="between 1 and 10000"):
        repository.load_active_judilibre_decision_records(limit=10_001)


def test_court_resolution_accepts_an_exact_active_outcome_code_without_fuzzy_text() -> None:
    cursor = QueryCursor(all_values=[[('court-1', 'bordeaux')]])

    resolutions = _repository(cursor).load_judilibre_court_resolutions(
        location="bordeaux"
    )

    assert len(resolutions) == 1
    assert resolutions[0].court_id == "court-1"
    assert resolutions[0].resolution_method == "outcome_court_code_exact"
    assert len(resolutions[0].reference_sha256) == 64
    statement, parameters = cursor.calls[0]
    assert "lower(btrim(court_row.code)) = lower(btrim(%s))" in statement
    assert "court_row.active" in statement
    assert parameters == ("bordeaux",)


def test_tj_insee_resolution_requires_current_official_justice_structure_and_exact_alias() -> None:
    cursor = QueryCursor(
        all_values=[
            [],
            [("court-1", "bordeaux", "c" * 64)],
        ]
    )

    resolutions = _repository(cursor).load_judilibre_court_resolutions(
        location="tj33063"
    )

    assert len(resolutions) == 1
    assert resolutions[0].resolution_method == "justice_structure_insee_exact_name"
    justice_statement, parameters = cursor.calls[1]
    assert "source.name = 'justice_open_data'" in justice_statement
    assert "source.official" in justice_statement
    assert "source.legal_review_status = 'approved'" in justice_statement
    assert "source.ingestion_policy = 'allowed_automated'" in justice_statement
    assert "justice_court_structure_v1" in justice_statement
    assert "record.normalized_data->>'structure_type_code' in ('TJ', 'TGI')" in justice_statement
    assert "newer.record_version > record.record_version" in justice_statement
    assert "public.source_purge_events" in justice_statement
    assert "extensions.unaccent" in justice_statement
    assert "extensions.unaccent(lower(court_row.name))" in justice_statement
    assert "jsonb_array_elements_text" in justice_statement
    assert "join public.outcome_courts" in justice_statement
    assert parameters == ("33063",)


def test_unrecognized_court_code_is_diagnostic_only_without_fuzzy_query() -> None:
    cursor = QueryCursor(all_values=[[]])

    resolutions = _repository(cursor).load_judilibre_court_resolutions(
        location="private court prose"
    )

    assert resolutions == []
    assert len(cursor.calls) == 1


def test_context_lookup_is_court_date_and_exact_reference_scoped_and_bounded() -> None:
    cursor = QueryCursor(
        all_values=[
            [
                (
                    "case-1",
                    "lot-1",
                    "round-1",
                    "court-1",
                    date(2025, 5, 14),
                    0,
                    True,
                    False,
                )
            ]
        ]
    )

    contexts = _repository(cursor).load_judilibre_auction_match_contexts(
        court_id="court-1",
        decision_date=date(2025, 5, 14),
        case_references=(" 22/00001 ", "DBXX-V-B7G-ABCDE"),
        max_date_delta_days=7,
        limit=251,
    )

    assert contexts[0].date_delta_days == 0
    assert contexts[0].case_number_match is True
    statement, parameters = cursor.calls[0]
    assert "public.auction_rounds" in statement
    assert "public.auction_lots" in statement
    assert "public.auction_cases" in statement
    assert "public.outcome_courts" in statement
    assert "round_row.court_id = %s" in statement
    assert "case_row.court_id = %s" in statement
    assert "between %s::date - %s and %s::date + %s" in statement
    assert "case_row.court_case_number" in statement
    assert "case_row.portalis_number" in statement
    assert statement.endswith("limit %s")
    normalized = ["22/00001", "dbxx-v-b7g-abcde"]
    assert parameters[1:5] == (
        normalized,
        normalized,
        normalized,
        normalized,
    )
    assert parameters[-1] == 251


def test_persist_revalidates_current_source_target_and_signals_in_one_transaction() -> None:
    cursor = QueryCursor(
        one_values=[
            (_review_source_projection(), date(2025, 5, 14)),
            (
                "case-1",
                "lot-1",
                "round-1",
                "court-1",
                date(2025, 5, 14),
                "22/00001",
                None,
            ),
            ("case-1", "lot-1", "round-1", 1, 0, 1, 1),
            None,
            ("match-1",),
        ],
        all_values=[[], [("court-1", "bordeaux", "b" * 64)]],
    )

    persisted = _repository(cursor).append_judilibre_match_candidate(
        source_record_id="record-1",
        expected_source_content_hash="a" * 64,
        expected_court_id="court-1",
        expected_decision_date=date(2025, 5, 14),
        max_date_delta_days=7,
        case_id="case-1",
        lot_id="lot-1",
        round_id="round-1",
        match_score="0.9500",
        match_method="exact_case_number",
        match_signals=_review_match_signals(),
    )

    assert persisted.match_id == "match-1"
    assert persisted.inserted_new_candidate is True
    assert len(cursor.calls) == 10
    assert "pg_advisory_xact_lock" in cursor.calls[0][0]
    assert "lock table" in cursor.calls[1][0]
    assert "public.source_purge_events" in cursor.calls[1][0]
    assert "public.auction_rounds" in cursor.calls[1][0]
    assert "public.source_record_matches" in cursor.calls[2][0]
    assert "share row exclusive mode" in cursor.calls[2][0]
    source_statement = cursor.calls[3][0]
    assert "source.name = 'judilibre'" in source_statement
    assert "join public.artifact_extractions extraction" in source_statement
    assert "evidence_sha256" in source_statement
    assert "source.legal_review_status = 'approved'" in source_statement
    assert "newer.record_version > record.record_version" in source_statement
    assert "public.source_purge_events" in source_statement
    assert "for share of record, source" in source_statement
    assert cursor.calls[3][1] == ("record-1", "a" * 64)
    assert "source.name = 'justice_open_data'" in cursor.calls[5][0]
    target_statement = cursor.calls[6][0]
    assert "case_row.id = %s" in target_statement
    assert "round_row.court_id = %s" in target_statement
    assert "for share of case_row, lot, round_row, court_row" in target_statement
    assert cursor.calls[6][1] == (
        "case-1",
        "lot-1",
        "round-1",
        "court-1",
        "court-1",
    )
    objective_top_statement = cursor.calls[7][0]
    assert "tied_at_rank" in objective_top_statement
    assert "reference_rank > 0 or date_delta_days = 0" in objective_top_statement
    existing_statement = cursor.calls[8][0]
    assert "match_row.outcome_id is null" in existing_statement
    insert_statement = cursor.calls[9][0]
    assert "'candidate'" in insert_statement
    assert "outcome_id" in insert_statement
    assert cursor.calls[9][1][4:6] == ("0.9500", "exact_case_number")


def test_persist_refuses_stale_source_before_target_or_insert() -> None:
    cursor = QueryCursor(one_values=[None])

    with pytest.raises(OutcomeIngestionError, match="no longer current"):
        _repository(cursor).append_judilibre_match_candidate(
            source_record_id="record-1",
            expected_source_content_hash="a" * 64,
            expected_court_id="court-1",
            expected_decision_date=date(2025, 5, 14),
            max_date_delta_days=7,
            case_id="case-1",
            lot_id="lot-1",
            round_id="round-1",
            match_score="0.9500",
            match_method="exact_case_number",
            match_signals=_review_match_signals(),
        )

    assert len(cursor.calls) == 4
    assert all("insert into public.source_record_matches" not in call[0] for call in cursor.calls)


def test_persist_reuses_only_an_identical_historical_candidate() -> None:
    signals = _review_match_signals()
    cursor = QueryCursor(
        one_values=[
            (_review_source_projection(), date(2025, 5, 14)),
            (
                "case-1",
                "lot-1",
                "round-1",
                "court-1",
                date(2025, 5, 14),
                "22/00001",
                None,
            ),
            ("case-1", "lot-1", "round-1", 1, 0, 1, 1),
            (
                "match-existing",
                Decimal("0.9500"),
                "exact_case_number",
                signals,
            ),
        ],
        all_values=[[], [("court-1", "bordeaux", "b" * 64)]],
    )

    persisted = _repository(cursor).append_judilibre_match_candidate(
        source_record_id="record-1",
        expected_source_content_hash="a" * 64,
        expected_court_id="court-1",
        expected_decision_date=date(2025, 5, 14),
        max_date_delta_days=7,
        case_id="case-1",
        lot_id="lot-1",
        round_id="round-1",
        match_score="0.9500",
        match_method="exact_case_number",
        match_signals=signals,
    )

    assert persisted.match_id == "match-existing"
    assert persisted.inserted_new_candidate is False
    assert len(cursor.calls) == 9
    assert all(
        "insert into public.source_record_matches" not in statement
        for statement, _parameters in cursor.calls
    )


def test_persist_refuses_a_stale_historical_candidate_payload() -> None:
    stale_signals = _review_match_signals()
    stale_signals["target_context_sha256"] = "e" * 64
    cursor = QueryCursor(
        one_values=[
            (_review_source_projection(), date(2025, 5, 14)),
            (
                "case-1",
                "lot-1",
                "round-1",
                "court-1",
                date(2025, 5, 14),
                "22/00001",
                None,
            ),
            ("case-1", "lot-1", "round-1", 1, 0, 1, 1),
            (
                "match-existing",
                Decimal("0.9500"),
                "exact_case_number",
                stale_signals,
            ),
        ],
        all_values=[[], [("court-1", "bordeaux", "b" * 64)]],
    )

    with pytest.raises(OutcomeIngestionError, match="history differs"):
        _repository(cursor).append_judilibre_match_candidate(
            source_record_id="record-1",
            expected_source_content_hash="a" * 64,
            expected_court_id="court-1",
            expected_decision_date=date(2025, 5, 14),
            max_date_delta_days=7,
            case_id="case-1",
            lot_id="lot-1",
            round_id="round-1",
            match_score="0.9500",
            match_method="exact_case_number",
            match_signals=_review_match_signals(),
        )

    assert len(cursor.calls) == 9
    assert all(
        "insert into public.source_record_matches" not in statement
        for statement, _parameters in cursor.calls
    )


def test_persist_refuses_a_newly_ambiguous_objective_top_rank() -> None:
    cursor = QueryCursor(
        one_values=[
            (_review_source_projection(), date(2025, 5, 14)),
            (
                "case-1",
                "lot-1",
                "round-1",
                "court-1",
                date(2025, 5, 14),
                "22/00001",
                None,
            ),
            ("case-1", "lot-1", "round-1", 1, 0, 2, 1),
        ],
        all_values=[[], [("court-1", "bordeaux", "b" * 64)]],
    )

    with pytest.raises(OutcomeIngestionError, match="ambiguous"):
        _repository(cursor).append_judilibre_match_candidate(
            source_record_id="record-1",
            expected_source_content_hash="a" * 64,
            expected_court_id="court-1",
            expected_decision_date=date(2025, 5, 14),
            max_date_delta_days=7,
            case_id="case-1",
            lot_id="lot-1",
            round_id="round-1",
            match_score="0.9500",
            match_method="exact_case_number",
            match_signals=_review_match_signals(),
        )

    assert len(cursor.calls) == 8
    assert all(
        "insert into public.source_record_matches" not in statement
        for statement, _parameters in cursor.calls
    )


def test_persist_refuses_conflicting_exact_case_references() -> None:
    cursor = QueryCursor(
        one_values=[
            (_review_source_projection(), date(2025, 5, 14)),
            (
                "case-1",
                "lot-1",
                "round-1",
                "court-1",
                date(2025, 5, 14),
                "22/00001",
                None,
            ),
            ("case-1", "lot-1", "round-1", 1, 0, 1, 2),
        ],
        all_values=[[], [("court-1", "bordeaux", "b" * 64)]],
    )

    with pytest.raises(OutcomeIngestionError, match="conflicting cases"):
        _repository(cursor).append_judilibre_match_candidate(
            source_record_id="record-1",
            expected_source_content_hash="a" * 64,
            expected_court_id="court-1",
            expected_decision_date=date(2025, 5, 14),
            max_date_delta_days=7,
            case_id="case-1",
            lot_id="lot-1",
            round_id="round-1",
            match_score="0.9500",
            match_method="exact_case_number",
            match_signals=_review_match_signals(),
        )

    assert len(cursor.calls) == 8
    assert all(
        "insert into public.source_record_matches" not in statement
        for statement, _parameters in cursor.calls
    )


def test_persist_refuses_a_changed_canonical_court_resolution() -> None:
    cursor = QueryCursor(
        one_values=[(_review_source_projection(), date(2025, 5, 14))],
        all_values=[[], [("court-2", "libourne", "b" * 64)]],
    )

    with pytest.raises(OutcomeIngestionError, match="court resolution changed"):
        _repository(cursor).append_judilibre_match_candidate(
            source_record_id="record-1",
            expected_source_content_hash="a" * 64,
            expected_court_id="court-1",
            expected_decision_date=date(2025, 5, 14),
            max_date_delta_days=7,
            case_id="case-1",
            lot_id="lot-1",
            round_id="round-1",
            match_score="0.9500",
            match_method="exact_case_number",
            match_signals=_review_match_signals(),
        )

    assert len(cursor.calls) == 6
    assert all(
        "insert into public.source_record_matches" not in statement
        for statement, _parameters in cursor.calls
    )


def test_persist_recomputes_and_refuses_a_noncanonical_score() -> None:
    cursor = QueryCursor(
        one_values=[
            (_review_source_projection(), date(2025, 5, 14)),
            (
                "case-1",
                "lot-1",
                "round-1",
                "court-1",
                date(2025, 5, 14),
                "22/00001",
                None,
            ),
        ],
        all_values=[[], [("court-1", "bordeaux", "b" * 64)]],
    )

    with pytest.raises(OutcomeIngestionError, match="not canonical"):
        _repository(cursor).append_judilibre_match_candidate(
            source_record_id="record-1",
            expected_source_content_hash="a" * 64,
            expected_court_id="court-1",
            expected_decision_date=date(2025, 5, 14),
            max_date_delta_days=7,
            case_id="case-1",
            lot_id="lot-1",
            round_id="round-1",
            match_score="0.9000",
            match_method="exact_case_number",
            match_signals=_review_match_signals(),
        )

    assert len(cursor.calls) == 7
    assert all(
        "insert into public.source_record_matches" not in statement
        for statement, _parameters in cursor.calls
    )


def test_persist_signal_allowlist_rejects_raw_text_before_opening_a_transaction() -> None:
    cursor = QueryCursor()
    signals = _review_match_signals()
    signals["raw_text"] = "private person"

    with pytest.raises(ValueError, match="reviewed schema"):
        _repository(cursor).append_judilibre_match_candidate(
            source_record_id="record-1",
            expected_source_content_hash="a" * 64,
            expected_court_id="court-1",
            expected_decision_date=date(2025, 5, 14),
            max_date_delta_days=7,
            case_id="case-1",
            lot_id="lot-1",
            round_id="round-1",
            match_score="0.9500",
            match_method="exact_case_number",
            match_signals=signals,
        )

    assert cursor.calls == []


def test_schema_preflight_and_round_presence_are_explicit() -> None:
    schema_cursor = QueryCursor(
        one_values=[
            (
                "judicial_source_records",
                "artifact_extractions",
                "source_record_matches",
                "source_purge_events",
                "data_sources",
                "outcome_courts",
                "tribunals",
                "auction_cases",
                "auction_lots",
                "auction_rounds",
            )
        ]
    )
    _repository(schema_cursor).require_judilibre_matching_schema()
    assert "to_regclass('public.artifact_extractions')" in schema_cursor.calls[0][0]
    assert "to_regclass('public.source_record_matches')" in schema_cursor.calls[0][0]

    rounds_cursor = QueryCursor(one_values=[(True,)])
    assert _repository(rounds_cursor).has_matchable_judilibre_rounds() is True
    statement = rounds_cursor.calls[0][0]
    assert "round_row.scheduled_at is not null" in statement
    assert "lot.active" in statement
    assert "court_row.active" in statement
