from __future__ import annotations

import json
from copy import deepcopy
from datetime import date, timedelta
from typing import Any

import pytest

from scripts import check_judilibre_contract as canary_module
from scripts.check_judilibre_contract import (
    CANARY_LAG_DAYS,
    CANARY_MAX_SEARCH_ATTEMPTS,
    CANARY_PAGE_SIZE,
    CANARY_PROFILE_ID,
    CANARY_WINDOW_DAYS,
    build_canary_query,
    run_contract_canary,
)
from src.official_sources.judilibre import (
    JudilibreDecision,
    JudilibreSearchPage,
    JudilibreSearchQuery,
)
from src.outcome_ingestion.judilibre_extraction import extract_judilibre_candidate_facts
from src.outcome_ingestion.judilibre_ingestion import JUDILIBRE_SEARCH_PROFILES


def _search_payload(
    *,
    relaxed: bool = False,
    identifiers: tuple[str, ...] = ("private-decision-id",),
    jurisdiction: str = "tj",
) -> dict[str, Any]:
    return {
        "page": 0,
        "page_size": 1,
        "query": {"private": "must-not-be-emitted"},
        "total": len(identifiers),
        "relaxed": relaxed,
        "results": [
            {
                "id": identifier,
                "jurisdiction": jurisdiction,
                "location": "Private court name",
                "number": "Private case number",
                "decision_date": "2026-07-30",
                "summary": "Private person and EUR 123456",
            }
            for identifier in identifiers
        ],
    }


def _decision_payload(
    *,
    identifier: str = "private-decision-id",
    jurisdiction: str = "tj",
) -> dict[str, Any]:
    return {
        "id": identifier,
        "jurisdiction": jurisdiction,
        "location": "Private court name",
        "number": "Private case number",
        "decision_date": "2026-07-30",
        "text": "Private person and EUR 123456",
        "zones": {"dispositif": [{"start": 1, "end": 10}]},
        "timeline": None,
        "titlesAndSummaries": [{"title": "Private title"}],
    }


def _extraction_contract_fixture() -> tuple[
    JudilibreDecision,
    dict[str, object],
    dict[str, object],
]:
    decision = JudilibreDecision.model_validate(
        {
            **_decision_payload(),
            "text": (
                "PAR CES MOTIFS Le juge adjuge le bien au prix principal "
                "de 125 000 euros."
            ),
            "zones": {},
        }
    )
    extraction = extract_judilibre_candidate_facts(decision)
    return decision, extraction.normalized_fields(), extraction.field_provenance()


class FakeClient:
    def __init__(
        self,
        search_response: object | tuple[object, ...],
        decision_response: object | None = None,
    ) -> None:
        self.search_response = search_response
        self.decision_response = decision_response
        self.search_queries: list[JudilibreSearchQuery] = []
        self.decision_calls: list[tuple[str, bool]] = []

    def search(self, query: JudilibreSearchQuery) -> object:
        response_index = len(self.search_queries)
        self.search_queries.append(query)
        if type(self.search_response) is tuple:
            if response_index >= len(self.search_response):
                raise AssertionError("unexpected extra search")
            return self.search_response[response_index]
        return self.search_response

    def decision(self, decision_id: str, *, resolve_references: bool) -> object:
        self.decision_calls.append((decision_id, resolve_references))
        if self.decision_response is None:
            raise AssertionError("unexpected decision fetch")
        return self.decision_response


def test_query_is_one_exact_tj_profile_over_thirty_one_days() -> None:
    query = build_canary_query(today=date(2026, 7, 31))
    profile = JUDILIBRE_SEARCH_PROFILES[CANARY_PROFILE_ID]

    assert query.query == profile.query
    assert query.field == list(profile.fields)
    assert query.operator == "exact"
    assert query.jurisdiction == ["tj"]
    assert query.page == 0
    assert query.page_size == CANARY_PAGE_SIZE == 1
    assert query.resolve_references is False
    assert query.date_start is not None
    assert query.date_end is not None
    assert (query.date_end - query.date_start).days + 1 == CANARY_WINDOW_DAYS == 31
    assert query.date_end == date(2026, 7, 31) - timedelta(days=CANARY_LAG_DAYS)


def test_canary_fetches_one_decision_and_emits_only_aggregates_and_booleans() -> None:
    client = FakeClient(_search_payload(), _decision_payload())

    report = run_contract_canary(client, today=date(2026, 7, 31))
    payload = report.public_payload()
    serialized = json.dumps(payload, sort_keys=True)

    assert report.contract_valid is True
    assert report.search_attempt_count == 1
    assert report.search_attempt_limit == CANARY_MAX_SEARCH_ATTEMPTS == 4
    assert report.result_count == 1
    assert report.decision_fetch_count == 1
    assert report.extraction_checked is True
    assert report.extraction_succeeded is True
    assert report.extraction_private_fields_absent is True
    assert report.decision_zones_schema_valid is True
    assert report.candidate_claim_count == report.provenance_anchor_count
    assert len(client.search_queries) == 1
    assert client.decision_calls == [("private-decision-id", False)]
    assert all(type(value) in {bool, int} for value in payload.values())
    for private_value in (
        "private-decision-id",
        "Private court name",
        "Private case number",
        "Private person",
        "123456",
        "Private title",
    ):
        assert private_value not in serialized


def test_relaxed_window_is_ignored_before_older_exact_success() -> None:
    client = FakeClient(
        (
            _search_payload(relaxed=True, identifiers=("relaxed-private-id",)),
            _search_payload(),
        ),
        _decision_payload(),
    )

    report = run_contract_canary(client, today=date(2026, 7, 31))

    assert report.contract_valid is True
    assert report.search_attempt_count == 2
    assert report.response_not_relaxed is True
    assert report.decision_fetch_count == 1
    assert client.decision_calls == [("private-decision-id", False)]


def test_four_relaxed_windows_fail_closed_without_fetching_any_candidate() -> None:
    relaxed = _search_payload(relaxed=True)
    client = FakeClient(
        tuple(deepcopy(relaxed) for _ in range(CANARY_MAX_SEARCH_ATTEMPTS)),
        _decision_payload(),
    )

    report = run_contract_canary(client, today=date(2026, 7, 31))

    assert report.search_schema_valid is True
    assert report.search_attempt_count == CANARY_MAX_SEARCH_ATTEMPTS == 4
    assert report.response_not_relaxed is False
    assert report.result_count == 0
    assert report.contract_valid is False
    assert report.decision_fetch_count == 0
    assert client.decision_calls == []


def test_canary_rejects_invalid_search_schema_without_leaking_input() -> None:
    invalid_page = _search_payload()
    invalid_page["results"] = [{"id": ""}]
    client = FakeClient(invalid_page)

    report = run_contract_canary(client, today=date(2026, 7, 31))

    assert report.search_request_succeeded is True
    assert report.search_schema_valid is False
    assert report.contract_valid is False
    assert report.decision_fetch_count == 0
    assert client.decision_calls == []


def test_canary_rejects_invalid_decision_schema_after_exactly_one_fetch() -> None:
    client = FakeClient(_search_payload(), {"id": ""})

    report = run_contract_canary(client, today=date(2026, 7, 31))

    assert report.decision_schema_checked is True
    assert report.decision_schema_valid is False
    assert report.contract_valid is False
    assert report.decision_fetch_count == 1
    assert len(client.decision_calls) == 1


def test_canary_requires_full_decision_text_for_the_extraction_contract() -> None:
    decision = _decision_payload()
    decision["text"] = None
    client = FakeClient(_search_payload(), decision)

    report = run_contract_canary(client, today=date(2026, 7, 31))

    assert report.decision_schema_valid is True
    assert report.decision_text_present is False
    assert report.contract_valid is False


def test_canary_rejects_out_of_bounds_or_non_tj_results_without_fetching() -> None:
    too_many = JudilibreSearchPage.model_validate(
        _search_payload(identifiers=("private-a", "private-b"))
    )
    wrong_scope = JudilibreSearchPage.model_validate(
        _search_payload(jurisdiction="ca")
    )

    for page in (too_many, wrong_scope):
        client = FakeClient(page, JudilibreDecision.model_validate(_decision_payload()))
        report = run_contract_canary(client, today=date(2026, 7, 31))

        assert report.contract_valid is False
        assert report.decision_fetch_count == 0
        assert client.decision_calls == []


def test_first_empty_window_then_older_success_stops_after_two_contiguous_searches() -> None:
    client = FakeClient(
        (_search_payload(identifiers=()), _search_payload()),
        _decision_payload(),
    )

    report = run_contract_canary(client, today=date(2026, 7, 31))

    assert report.contract_valid is True
    assert report.search_attempt_count == 2
    assert len(client.search_queries) == 2
    newest, older = client.search_queries
    assert newest.date_start is not None
    assert older.date_end is not None
    assert older.date_end == newest.date_start - timedelta(days=1)
    assert report.decision_fetch_count == 1
    assert len(client.decision_calls) == 1


def test_four_empty_windows_fail_closed_without_decision_fetch() -> None:
    empty = _search_payload(identifiers=())
    client = FakeClient(tuple(deepcopy(empty) for _ in range(CANARY_MAX_SEARCH_ATTEMPTS)))

    report = run_contract_canary(client, today=date(2026, 7, 31))

    assert report.search_schema_valid is True
    assert report.search_attempt_count == CANARY_MAX_SEARCH_ATTEMPTS == 4
    assert len(client.search_queries) == CANARY_MAX_SEARCH_ATTEMPTS
    assert report.result_count == 0
    assert report.contract_valid is False
    assert report.decision_fetch_count == 0
    assert client.decision_calls == []

    for newer, older in zip(client.search_queries, client.search_queries[1:], strict=False):
        assert newer.date_start is not None
        assert older.date_end is not None
        assert older.date_end == newer.date_start - timedelta(days=1)


def test_main_redacts_configuration_and_transport_failures(
    monkeypatch: Any,
    capsys: Any,
) -> None:
    private_failure = "private-key-id and private response body"

    class FailingClient:
        @classmethod
        def from_settings(cls, _settings: object) -> object:
            raise RuntimeError(private_failure)

    monkeypatch.setattr(canary_module, "load_settings", lambda: {})
    monkeypatch.setattr(canary_module, "JudilibreClient", FailingClient)

    assert canary_module.main() == 1
    output = capsys.readouterr()
    payload = json.loads(output.out)

    assert output.err == ""
    assert private_failure not in output.out
    assert payload["contract_valid"] is False
    assert all(type(value) in {bool, int} for value in payload.values())


def test_strict_extraction_contract_accepts_only_canonical_hash_anchored_values() -> None:
    decision, normalized, provenance = _extraction_contract_fixture()

    claim_count, anchor_count = canary_module._validate_extraction_contract(
        normalized=normalized,
        provenance=provenance,
        decision=decision,
    )

    assert claim_count == anchor_count
    assert claim_count > 0


def test_semantically_false_but_canonically_rehashed_amount_is_rejected(
    monkeypatch: Any,
) -> None:
    decision, normalized, provenance = _extraction_contract_fixture()
    unsafe_normalized = deepcopy(normalized)
    unsafe_provenance = deepcopy(provenance)
    claims = unsafe_normalized["claims"]
    anchors = unsafe_provenance["claims"]
    assert isinstance(claims, list)
    assert isinstance(anchors, dict)
    money_claim = next(
        claim
        for claim in claims
        if claim["claim_type"] in {"starting_price_eur", "hammer_price_eur"}
    )
    old_claim_id = money_claim["claim_id"]
    money_claim["normalized_value"] = "126000.00"
    new_claim_id = canary_module.canonical_sha256(
        {
            "schema_version": canary_module.JUDILIBRE_CLAIM_SCHEMA_VERSION,
            "claim_type": money_claim["claim_type"],
            "normalized_value": money_claim["normalized_value"],
            "currency": money_claim["currency"],
            "evidence_hash": money_claim["evidence_hash"],
        }
    )
    money_claim["claim_id"] = new_claim_id
    anchors[new_claim_id] = anchors.pop(old_claim_id)

    with pytest.raises(ValueError, match="differs from canonical extraction"):
        canary_module._validate_extraction_contract(
            normalized=unsafe_normalized,
            provenance=unsafe_provenance,
            decision=decision,
        )

    class SemanticallyFalseExtraction:
        def normalized_fields(self) -> dict[str, object]:
            return unsafe_normalized

        def field_provenance(self) -> dict[str, object]:
            return unsafe_provenance

    monkeypatch.setattr(
        canary_module,
        "extract_judilibre_candidate_facts",
        lambda _decision: SemanticallyFalseExtraction(),
    )
    report = run_contract_canary(
        FakeClient(_search_payload(), decision),
        today=date(2026, 7, 31),
    )

    assert report.extraction_checked is True
    assert report.extraction_succeeded is False
    assert report.contract_valid is False
    assert "126000.00" not in json.dumps(report.public_payload())


@pytest.mark.parametrize(
    "dispositif",
    (
        None,
        [],
        ["not-a-fragment"],
        [{"start": "0", "end": 10}],
        [{"start": 0, "end": 10, "unexpected": "private judicial text"}],
        [{"start": 0, "end": 10_000}],
        [{"start": 10, "end": 1}],
    ),
    ids=(
        "invalid-type",
        "empty-list",
        "invalid-fragment",
        "invalid-offset-type",
        "unexpected-fragment-field",
        "offset-outside-text",
        "reversed-offsets",
    ),
)
def test_canary_rejects_invalid_dispositif_zone_schema_without_text_leak(
    dispositif: object,
) -> None:
    decision = _decision_payload()
    private_text = "Mme Personne ne doit jamais apparaître dans le rapport"
    decision["text"] = private_text
    decision["zones"] = {"dispositif": dispositif}
    client = FakeClient(_search_payload(), decision)

    report = run_contract_canary(client, today=date(2026, 7, 31))
    serialized = json.dumps(report.public_payload(), ensure_ascii=False)

    assert report.decision_schema_valid is True
    assert report.decision_zones_present is True
    assert report.decision_zones_schema_valid is False
    assert report.extraction_checked is False
    assert report.contract_valid is False
    assert private_text not in serialized


def test_canary_rejects_judicial_prose_smuggled_through_normalized_value(
    monkeypatch: Any,
) -> None:
    decision, normalized, provenance = _extraction_contract_fixture()
    private_prose = "Mme Personne et le texte intégral ne doivent jamais sortir"
    claims = normalized["claims"]
    assert isinstance(claims, list)
    claims[0]["normalized_value"] = private_prose

    class UnsafeExtraction:
        def normalized_fields(self) -> dict[str, object]:
            return normalized

        def field_provenance(self) -> dict[str, object]:
            return provenance

    monkeypatch.setattr(
        canary_module,
        "extract_judilibre_candidate_facts",
        lambda _decision: UnsafeExtraction(),
    )
    client = FakeClient(_search_payload(), decision)

    report = run_contract_canary(client, today=date(2026, 7, 31))
    serialized_report = json.dumps(report.public_payload(), ensure_ascii=False)

    assert report.extraction_checked is True
    assert report.extraction_succeeded is False
    assert report.extraction_private_fields_absent is False
    assert report.contract_valid is False
    assert private_prose not in serialized_report


def test_strict_extraction_contract_rejects_every_unexpected_projection_field() -> None:
    decision, normalized, provenance = _extraction_contract_fixture()
    claims = normalized["claims"]
    assert isinstance(claims, list)
    mutations = []

    top_level_extra = deepcopy(normalized)
    top_level_extra["unexpected_field"] = "private judicial text"
    mutations.append(top_level_extra)

    claim_extra = deepcopy(normalized)
    claim_extra_claims = claim_extra["claims"]
    assert isinstance(claim_extra_claims, list)
    claim_extra_claims[0]["unexpected_field"] = "private judicial text"
    mutations.append(claim_extra)

    for unsafe_normalized in mutations:
        with pytest.raises(ValueError, match="unexpected Judilibre extraction field"):
            canary_module._validate_extraction_contract(
                normalized=unsafe_normalized,
                provenance=provenance,
                decision=decision,
            )


def test_ambiguous_procedural_event_cannot_also_be_selected() -> None:
    decision, normalized, provenance = _extraction_contract_fixture()
    unsafe_normalized = deepcopy(normalized)
    unsafe_normalized["ambiguous_claim_types"] = ["procedural_event"]

    with pytest.raises(ValueError, match="cannot also be selected"):
        canary_module._validate_extraction_contract(
            normalized=unsafe_normalized,
            provenance=provenance,
            decision=decision,
        )


def test_canonical_ambiguous_procedural_event_without_selected_event_is_allowed() -> None:
    decision = JudilibreDecision.model_validate(
        {
            **_decision_payload(),
            "text": (
                "PAR CES MOTIFS Ordonne le report de la vente. "
                "Le juge adjuge le bien au prix de 140 000 euros."
            ),
            "zones": {},
        }
    )
    extraction = extract_judilibre_candidate_facts(decision)
    normalized = extraction.normalized_fields()

    assert "procedural_event" in normalized["ambiguous_claim_types"]
    assert all(
        claim["claim_type"] != "procedural_event" for claim in normalized["claims"]
    )
    claim_count, anchor_count = canary_module._validate_extraction_contract(
        normalized=normalized,
        provenance=extraction.field_provenance(),
        decision=decision,
    )

    assert claim_count == anchor_count


def test_strict_extraction_contract_rejects_every_unexpected_provenance_field() -> None:
    decision, normalized, provenance = _extraction_contract_fixture()
    provenance_claims = provenance["claims"]
    assert isinstance(provenance_claims, dict)
    claim_id = next(iter(provenance_claims))
    mutations = []

    top_level_extra = deepcopy(provenance)
    top_level_extra["unexpected_field"] = "private judicial text"
    mutations.append(top_level_extra)

    anchor_extra = deepcopy(provenance)
    anchor_claims = anchor_extra["claims"]
    assert isinstance(anchor_claims, dict)
    anchor_claims[claim_id]["unexpected_field"] = "private judicial text"
    mutations.append(anchor_extra)

    for unsafe_provenance in mutations:
        with pytest.raises(ValueError, match="unexpected Judilibre extraction field"):
            canary_module._validate_extraction_contract(
                normalized=normalized,
                provenance=unsafe_provenance,
                decision=decision,
            )


def test_strict_extraction_contract_rejects_unallowlisted_provenance_values() -> None:
    decision, normalized, provenance = _extraction_contract_fixture()
    provenance_claims = provenance["claims"]
    assert isinstance(provenance_claims, dict)
    claim_id = next(iter(provenance_claims))
    unsafe_provenance = deepcopy(provenance)
    unsafe_claims = unsafe_provenance["claims"]
    assert isinstance(unsafe_claims, dict)
    unsafe_claims[claim_id]["source_pointer"] = "/text/private judicial prose"

    with pytest.raises(ValueError, match="unexpected Judilibre provenance pointer"):
        canary_module._validate_extraction_contract(
            normalized=normalized,
            provenance=unsafe_provenance,
            decision=decision,
        )


def test_public_report_is_an_explicit_allowlist_even_if_report_gains_private_attributes() -> None:
    report = canary_module.JudilibreContractReport()
    report.normalized_value = "private judicial text"
    report.provenance = {"unexpected_field": "private judicial text"}

    payload = report.public_payload()
    serialized = json.dumps(payload)

    assert "normalized_value" not in payload
    assert "provenance" not in payload
    assert "private judicial text" not in serialized


def test_public_report_rejects_values_smuggled_through_aggregate_fields() -> None:
    report = canary_module.JudilibreContractReport()
    report.candidate_claim_count = 125_000

    with pytest.raises(ValueError, match="unsafe aggregate"):
        report.public_payload()


def test_client_settings_disable_retries_and_force_all_network_bounds() -> None:
    bounded = canary_module._bounded_settings(
        {
            "judilibre_page_size": 50,
            "judilibre_max_results": 10_000,
            "judilibre_max_retries": 4,
            "judilibre_enabled": True,
        }
    )

    assert bounded["judilibre_page_size"] == 1
    assert bounded["judilibre_max_results"] == 1
    assert bounded["judilibre_max_retries"] == 0
    assert bounded["judilibre_enabled"] is True
