from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from src import outcome_sources_cli
from src.outcome_ingestion.service import JsonSourceRecord
from src.outcome_sources_cli import _bounded_records, build_parser, main


def _record(identifier: str) -> JsonSourceRecord:
    return JsonSourceRecord(
        source_name="test",
        external_record_id=identifier,
        requested_url="https://example.test/source",
        canonical_url=None,
        record_kind="other_candidate",
        raw_payload={"id": identifier},
        normalized_data={"id": identifier, "training_eligible": False},
        connector_version="test/1",
        extractor_name="test",
        extractor_version="1",
        schema_version="test_v1",
        source_updated_at=datetime(2026, 7, 30, tzinfo=UTC),
    )


def test_ingest_local_requires_explicit_bound() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["ingest-local", "dvf-adjudications", "source.zip"])


def test_match_dvf_requires_explicit_bound_and_defaults_to_dry_run() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["match-dvf"])

    args = parser.parse_args(["match-dvf", "--limit", "10"])

    assert args.limit == 10
    assert args.all is False
    assert args.context_limit == 250
    assert args.page_size == 500
    assert args.persist is False

    resumed = parser.parse_args(
        [
            "match-dvf",
            "--limit",
            "10",
            "--page-size",
            "100",
            "--after-source-record-id",
            "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        ]
    )
    assert resumed.page_size == 100
    assert resumed.after_source_record_id == "3fa85f64-5717-4562-b3fc-2c963f66afa6"

    with pytest.raises(SystemExit):
        parser.parse_args(["match-dvf", "--limit", "10", "--page-size", "5001"])


def test_judilibre_search_sync_requires_a_closed_profile_window_and_result_cap() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(
            [
                "judilibre-search-sync",
                "--profile",
                "adjudication_v1",
                "--date-start",
                "2025-05-01",
                "--date-end",
                "2025-05-31",
            ]
        )
    with pytest.raises(SystemExit):
        parser.parse_args(
            [
                "judilibre-search-sync",
                "--profile",
                "free-form-query",
                "--date-start",
                "2025-05-01",
                "--date-end",
                "2025-05-31",
                "--max-results",
                "10",
            ]
        )
    with pytest.raises(SystemExit):
        parser.parse_args(
            [
                "judilibre-search-sync",
                "--profile",
                "adjudication_v1",
                "--date-start",
                "2025-05-01",
                "--date-end",
                "2025-05-31",
                "--max-results",
                "501",
            ]
        )

    args = parser.parse_args(
        [
            "judilibre-search-sync",
            "--profile",
            "adjudication_v1",
            "--date-start",
            "2025-05-01",
            "--date-end",
            "2025-05-31",
            "--max-results",
            "10",
        ]
    )
    assert args.profile == "adjudication_v1"
    assert args.max_results == 10
    assert not hasattr(args, "query")
    assert not hasattr(args, "stream_key")
    assert not hasattr(args, "all")


def test_judilibre_search_sync_validates_window_before_live_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    setup_calls = 0

    def live_setup() -> object:
        nonlocal setup_calls
        setup_calls += 1
        raise AssertionError("live setup must not be called")

    monkeypatch.setattr(outcome_sources_cli, "_live_judilibre_ingestor", live_setup)

    assert (
        main(
            [
                "judilibre-search-sync",
                "--profile",
                "adjudication_v1",
                "--date-start",
                "2099-01-01",
                "--date-end",
                "2099-01-01",
                "--max-results",
                "10",
            ]
        )
        == 2
    )
    assert setup_calls == 0


def test_judilibre_search_sync_closes_client_and_emits_only_aggregate_data(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class FakeIngestor:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def sync_targeted_search(self, **kwargs: object) -> object:
            self.calls.append(kwargs)
            return SimpleNamespace(
                pages=2,
                metadata_examined=3,
                reported_total=3,
                selected_decisions=3,
                deletions=0,
                stored_versions=2,
                unchanged_versions=1,
                truncated=False,
                checkpoint_advanced=True,
            )

    class FakeClient:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    ingestor = FakeIngestor()
    client = FakeClient()
    monkeypatch.setattr(
        outcome_sources_cli,
        "_live_judilibre_ingestor",
        lambda: (ingestor, client),
    )

    assert (
        main(
            [
                "judilibre-search-sync",
                "--profile",
                "saisie_immobiliere_v1",
                "--date-start",
                "2025-05-01",
                "--date-end",
                "2025-05-31",
                "--max-results",
                "10",
            ]
        )
        == 0
    )

    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "judilibre-search-sync"
    assert payload["profile"] == "saisie_immobiliere_v1"
    assert payload["selected_decisions"] == 3
    assert payload["checkpoint_advanced"] is True
    assert client.closed is True
    assert ingestor.calls[0]["profile"].profile_id == "saisie_immobiliere_v1"
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "Mme Exemple" not in serialized
    assert "highlights" not in serialized


def test_match_dvf_dry_run_reports_missing_outcome_lots_without_writes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    repository = EmptyMatchingRepository()
    monkeypatch.setattr(outcome_sources_cli, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(
        outcome_sources_cli.OutcomeIngestionRepository,
        "from_settings",
        lambda _settings: repository,
    )

    assert main(["match-dvf", "--limit", "10"]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "match-dvf"
    assert payload["dry_run"] is True
    assert payload["empty_reason"] == "no_active_outcome_lots"
    assert payload["page_size"] == 500
    assert payload["pages_loaded"] == 0
    assert payload["truncated"] is False
    assert payload["writes"] == 0
    assert payload["persist_requested"] is False
    assert repository.policy_calls == []


def test_bounded_records_does_not_overconsume() -> None:
    consumed: list[str] = []

    def records():
        for value in ("one", "two", "three"):
            consumed.append(value)
            yield _record(value)

    assert [item.external_record_id for item in _bounded_records(records(), 2)] == ["one", "two"]
    assert consumed == ["one", "two"]


def test_plan_is_secret_free_and_describes_closed_sources(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["plan"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["sources"]["judilibre"]["default_state"] == "disabled_pending_legal_and_piste"
    assert payload["sources"]["encheres_publiques_open_data"]["training_eligible"] is False


class EmptyMatchingRepository:
    def __init__(self) -> None:
        self.policy_calls: list[tuple[str, str]] = []

    def require_source_policy(self, source_name: str, channel: str) -> object:
        self.policy_calls.append((source_name, channel))
        return object()

    def require_dvf_matching_schema(self) -> None:
        return None

    def has_active_outcome_lots(self) -> bool:
        return False
