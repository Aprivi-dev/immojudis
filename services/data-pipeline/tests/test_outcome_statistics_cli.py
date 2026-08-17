from __future__ import annotations

import json
from contextlib import nullcontext

import pytest

from src.outcome_statistics import cli
from src.outcome_statistics.models import PersistSummary
from src.outcome_statistics.repository import OutcomeStatisticsRepositoryError


def test_parser_is_dry_run_by_default_and_initial_only() -> None:
    args = cli.build_parser().parse_args(["--max-rounds", "100"])
    assert args.persist is False
    assert args.round_kind == "initial"
    assert args.windows is None

    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["--max-rounds", "100", "--round-kind", "surenchere"])


@pytest.mark.parametrize("value", ("TRUE", " true", "true ", "1", "yes", ""))
def test_kill_switch_accepts_only_the_exact_value_true(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("TRIBUNAL_STATISTICS_ENABLED", value)
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://unused")
    monkeypatch.setattr(
        cli,
        "OutcomeStatisticsRepository",
        lambda _url: (_ for _ in ()).throw(AssertionError("repository must stay closed")),
    )

    assert cli.main(["--max-rounds", "10"]) == 2


def test_dry_run_never_calls_persistence(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class FakeRepository:
        persisted = False

        def __init__(self, db_url: str) -> None:
            assert db_url == "postgresql://test"

        def load_rounds(self, **_kwargs: object) -> tuple[()]:
            return ()

        def serialized_source_view(self) -> object:
            return nullcontext()

        def persist_bundles(self, _bundles: object) -> PersistSummary:
            self.persisted = True
            raise AssertionError("dry-run must not persist")

    monkeypatch.setenv("TRIBUNAL_STATISTICS_ENABLED", "true")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://test")
    monkeypatch.setattr(cli, "OutcomeStatisticsRepository", FakeRepository)

    result = cli.main(
        [
            "--max-rounds",
            "10",
            "--window-months",
            "12",
            "--knowledge-cutoff-at",
            "2026-07-31T12:00:00+00:00",
        ]
    )

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "dry-run"
    assert payload["loaded_rounds"] == 0
    assert payload["writes"] == {
        "members_inserted": 0,
        "snapshots_inserted": 0,
        "snapshots_reused": 0,
    }
    window = payload["windows"][0]
    assert "computation_hash" not in window
    assert len(window["python_preview_source_manifest_hash"]) == 64
    assert len(window["python_preview_statistics_hash"]) == 64


def test_persist_requires_the_explicit_flag(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class FakeRepository:
        def __init__(self, _db_url: str) -> None:
            pass

        def load_rounds(self, **_kwargs: object) -> tuple[()]:
            return ()

        def serialized_source_view(self) -> object:
            return nullcontext()

        def persist_bundles(self, bundles: object) -> PersistSummary:
            assert len(bundles) == 1  # type: ignore[arg-type]
            return PersistSummary(
                inserted_snapshots=1,
                reused_snapshots=0,
                inserted_members=0,
            )

    monkeypatch.setenv("TRIBUNAL_STATISTICS_ENABLED", "true")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://test")
    monkeypatch.setattr(cli, "OutcomeStatisticsRepository", FakeRepository)

    result = cli.main(
        [
            "--max-rounds",
            "10",
            "--window-months",
            "12",
            "--knowledge-cutoff-at",
            "2026-07-31T12:00:00Z",
            "--persist",
        ]
    )

    assert result == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "persist"
    assert payload["writes"]["snapshots_inserted"] == 1
    assert "computation_hash" not in payload["windows"][0]
    assert len(payload["windows"][0]["python_preview_statistics_hash"]) == 64


@pytest.mark.parametrize(
    ("failure", "public_message"),
    (
        (
            ValueError("invalid round 00000000-0000-0000-0000-000000000123"),
            "statistics input or computation validation failed",
        ),
        (
            OutcomeStatisticsRepositoryError("database failure for 00000000-0000-0000-0000-000000000456"),
            "statistics database operation failed",
        ),
    ),
)
def test_cli_never_prints_raw_validation_errors_or_identifiers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failure: Exception,
    public_message: str,
) -> None:
    class FakeRepository:
        def __init__(self, _db_url: str) -> None:
            pass

        def serialized_source_view(self) -> object:
            return nullcontext()

        def load_rounds(self, **_kwargs: object) -> tuple[()]:
            raise failure

    monkeypatch.setenv("TRIBUNAL_STATISTICS_ENABLED", "true")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://test")
    monkeypatch.setattr(cli, "OutcomeStatisticsRepository", FakeRepository)

    result = cli.main(
        [
            "--max-rounds",
            "10",
            "--window-months",
            "12",
            "--knowledge-cutoff-at",
            "2026-07-31T12:00:00Z",
        ]
    )

    captured = capsys.readouterr()
    assert result == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {"error": public_message}
    assert "00000000-0000-0000-0000" not in captured.err
    assert str(failure) not in captured.err
