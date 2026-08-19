from __future__ import annotations

import json

import pytest

from scripts import match_judilibre_candidates as cli
from src.outcome_ingestion.judilibre_matching import JudilibreMatchingSummary


def test_parser_requires_a_global_bound_and_defaults_to_read_only() -> None:
    parser = cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])

    args = parser.parse_args(["--limit", "25"])

    assert args.limit == 25
    assert args.page_size == 100
    assert args.context_limit == 250
    assert args.max_date_delta_days == 7
    assert args.persist is False

    with pytest.raises(SystemExit):
        parser.parse_args(["--limit", "10001"])
    with pytest.raises(SystemExit):
        parser.parse_args(["--limit", "25", "--page-size", "1001"])
    with pytest.raises(SystemExit):
        parser.parse_args(["--limit", "25", "--context-limit", "5001"])
    with pytest.raises(SystemExit):
        parser.parse_args(["--limit", "25", "--max-date-delta-days", "31"])


def test_main_emits_aggregate_diagnostics_only_and_does_not_gate_dry_run_writes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class FakeRepository:
        def __init__(self) -> None:
            self.policy_calls: list[tuple[str, str]] = []

        def require_source_policy(self, source: str, channel: str) -> None:
            self.policy_calls.append((source, channel))

    repository = FakeRepository()

    class FakeRepositoryClass:
        @staticmethod
        def from_settings(_settings: object) -> FakeRepository:
            return repository

    class FakeService:
        def __init__(self, received_repository: object) -> None:
            assert received_repository is repository

        def run(self, **kwargs: object) -> JudilibreMatchingSummary:
            assert kwargs["persist"] is False
            return JudilibreMatchingSummary(
                dry_run=True,
                source_limit=25,
                context_limit=250,
                max_date_delta_days=7,
                source_records_loaded=1,
                objective_candidates=1,
                dry_run_candidates=1,
            )

    monkeypatch.setattr(cli, "load_settings", lambda: {"supabase_db_url": "private"})
    monkeypatch.setattr(cli, "OutcomeIngestionRepository", FakeRepositoryClass)
    monkeypatch.setattr(cli, "JudilibreDecisionMatchingService", FakeService)

    assert cli.main(["--limit", "25"]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == "judilibre_match_diagnostic_v1"
    assert payload["dry_run"] is True
    assert payload["persist_requested"] is False
    assert payload["review_required"] is True
    assert payload["raw_text_read"] is False
    assert payload["automatic_matches"] == 0
    assert payload["outcomes_created"] == 0
    assert payload["training_eligibility_changes"] == 0
    assert payload["writes"] == 0
    assert repository.policy_calls == []
    serialized = json.dumps(payload, sort_keys=True)
    assert "private-decision-id" not in serialized
    assert "private person" not in serialized


def test_persist_requires_approved_policy_before_service_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class FakeRepository:
        def require_source_policy(self, source: str, channel: str) -> None:
            events.append(f"policy:{source}:{channel}")

    repository = FakeRepository()

    class FakeRepositoryClass:
        @staticmethod
        def from_settings(_settings: object) -> FakeRepository:
            return repository

    class FakeService:
        def __init__(self, _repository: object) -> None:
            events.append("service:init")

        def run(self, **kwargs: object) -> JudilibreMatchingSummary:
            events.append("service:run")
            assert kwargs["persist"] is True
            return JudilibreMatchingSummary(
                dry_run=False,
                source_limit=1,
                context_limit=250,
                max_date_delta_days=7,
            )

    monkeypatch.setattr(cli, "load_settings", lambda: {"supabase_db_url": "private"})
    monkeypatch.setattr(cli, "OutcomeIngestionRepository", FakeRepositoryClass)
    monkeypatch.setattr(cli, "JudilibreDecisionMatchingService", FakeService)

    assert cli.main(["--limit", "1", "--persist"]) == 0
    assert events == ["policy:judilibre:automated", "service:init", "service:run"]
