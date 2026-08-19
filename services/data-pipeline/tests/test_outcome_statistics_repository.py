from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest

from src.outcome_statistics import repository as repository_module
from src.outcome_statistics.engine import build_statistics_bundle
from src.outcome_statistics.repository import (
    OutcomeStatisticsRepository,
    OutcomeStatisticsRepositoryError,
    _persist_snapshot,
    _round_observations,
)

CUTOFF = datetime(2026, 7, 31, 12, tzinfo=UTC)


def _uuid(value: int) -> str:
    return str(UUID(int=value))


def _database_row() -> dict[str, object]:
    return {
        "round_id": _uuid(1),
        "feature_snapshot_id": _uuid(2),
        "lot_id": _uuid(3),
        "court_id": _uuid(4),
        "court_code": "TJ-001",
        "court_name": "Tribunal 1",
        "judicial_region": "Région 1",
        "round_kind": "initial",
        "scheduled_at": datetime(2026, 1, 1, tzinfo=UTC),
        "local_timezone": "Europe/Paris",
        "timezone_is_valid": True,
        "initial_starting_price_eur": Decimal("100000"),
        "effective_starting_price_eur": Decimal("110000"),
        "outcome_id": _uuid(5),
        "outcome_version": 1,
        "outcome_valid_from": datetime(2026, 1, 2, tzinfo=UTC),
        "outcome_valid_to": None,
        "outcome_created_at": datetime(2026, 1, 2, tzinfo=UTC),
        "outcome_recorded_at": datetime(2026, 1, 2, tzinfo=UTC),
        "supersedes_outcome_id": None,
        "outcome_status": "held_adjudicated",
        "initial_hammer_price_eur": Decimal("120000"),
        "final_hammer_price_eur": Decimal("150000"),
        "finality_status": "procedurally_definitive",
        "surenchere_status": "not_filed",
        "result_observed_at": datetime(2026, 1, 3, tzinfo=UTC),
        "eligible_outcome_status": True,
        "eligible_initial_starting_price": True,
        "eligible_effective_starting_price": True,
        "eligible_initial_hammer_price": True,
        "eligible_final_hammer_price": True,
        "eligible_finality_status": True,
        "eligible_surenchere_status": True,
        "eligible_result_observed_at": True,
        "status_double_reviewed": True,
    }


def test_row_mapping_carries_frozen_snapshot_and_claim_specific_gates() -> None:
    observations = _round_observations((_database_row(),), CUTOFF)

    assert len(observations) == 1
    observation = observations[0]
    assert observation.feature_snapshot_id == _uuid(2)
    assert len(observation.outcomes) == 1
    outcome = observation.outcomes[0]
    assert outcome.valid_to is None
    assert outcome.eligibility_evaluated_at == CUTOFF
    assert outcome.status_independently_double_reviewed is True
    assert outcome.eligible_claims == {
        "outcome_status",
        "initial_starting_price_eur",
        "effective_starting_price_eur",
        "initial_hammer_price_eur",
        "final_hammer_price_eur",
        "finality_status",
        "surenchere_status",
        "result_observed_at",
    }


def test_row_mapping_fails_closed_on_an_invalid_timezone_without_echoing_it() -> None:
    row = _database_row()
    secret_timezone = f"invalid/{_uuid(999)}"
    row["local_timezone"] = secret_timezone
    row["timezone_is_valid"] = False

    with pytest.raises(ValueError) as captured:
        _round_observations((row,), CUTOFF)

    assert secret_timezone not in str(captured.value)
    assert str(captured.value) == "invalid local timezone in statistics input"


def test_loader_binds_feature_snapshot_cutoff_before_round_kind() -> None:
    class FakeCursor:
        description: list[SimpleNamespace] = []

        def __init__(self) -> None:
            self.parameters: tuple[object, ...] | None = None
            self.sql = ""

        def __enter__(self) -> FakeCursor:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def execute(self, sql: str, parameters: tuple[object, ...]) -> None:
            self.sql = sql
            self.parameters = parameters

        def fetchall(self) -> list[tuple[()]]:
            return []

    class FakeConnection:
        def __init__(self, cursor: FakeCursor) -> None:
            self._cursor = cursor

        def __enter__(self) -> FakeConnection:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def cursor(self) -> FakeCursor:
            return self._cursor

    cursor = FakeCursor()
    repository = OutcomeStatisticsRepository(
        "postgresql://test",
        connect=lambda _url: FakeConnection(cursor),
    )
    rows = repository.load_rounds(
        period_start=date(2025, 7, 2),
        period_end=date(2026, 7, 1),
        knowledge_cutoff_at=CUTOFF,
        round_kind="initial",
        max_rounds=50,
    )

    assert rows == ()
    assert cursor.parameters is not None
    assert cursor.parameters[0] == CUTOFF
    assert cursor.parameters[1:4] == (CUTOFF, CUTOFF, CUTOFF)
    assert cursor.parameters[4] == "initial"
    assert cursor.parameters[5] == CUTOFF
    assert cursor.parameters[7:11] == (
        date(2025, 7, 2),
        date(2026, 7, 1),
        date(2025, 7, 2),
        date(2026, 7, 1),
    )
    assert cursor.parameters[11] == 51
    assert len(cursor.parameters) == cursor.sql.count("%s") == 24
    assert "snapshot_row.built_at <= %s" in cursor.sql
    assert "snapshot_row.recorded_at <= %s" in cursor.sql
    assert "snapshot_row.feature_cutoff_at <= %s" in cursor.sql
    assert "round_row.recorded_at <= %s" in cursor.sql
    assert "outcome_row.recorded_at <= %s" in cursor.sql
    assert "left join pg_catalog.pg_timezone_names" in cursor.sql
    assert "timezone_row.name is null" in cursor.sql
    assert "not snapshot_row.retrospective" in cursor.sql
    assert "snapshot_row.leakage_check_status = 'passed'" in cursor.sql


def test_serialized_source_view_holds_the_global_transaction_lock_for_the_run() -> None:
    class FakeCursor:
        def __init__(self) -> None:
            self.queries: list[str] = []
            self.responses = iter(((None,),))

        def __enter__(self) -> FakeCursor:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def execute(
            self,
            sql: str,
            parameters: tuple[object, ...] | None = None,
        ) -> None:
            if "pg_advisory_xact_lock" in sql:
                assert parameters == ("immojudis:tribunal-statistics-source-v1",)
            else:
                assert parameters is None
            self.queries.append(sql)

        def fetchone(self) -> tuple[object, ...]:
            return next(self.responses)

    class FakeConnection:
        def __init__(self) -> None:
            self.cursor_instance = FakeCursor()
            self.commits = 0
            self.rollbacks = 0

        def __enter__(self) -> FakeConnection:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def cursor(self) -> FakeCursor:
            return self.cursor_instance

        def commit(self) -> None:
            self.commits += 1

        def rollback(self) -> None:
            self.rollbacks += 1

    connection = FakeConnection()
    repository = OutcomeStatisticsRepository(
        "postgresql://test",
        connect=lambda _url: connection,
    )

    with repository.serialized_source_view():
        assert len(connection.cursor_instance.queries) == 2
        assert "read committed" in connection.cursor_instance.queries[0].lower()
        assert "pg_advisory_xact_lock" in connection.cursor_instance.queries[1]

    assert len(connection.cursor_instance.queries) == 2
    assert connection.commits == 1
    assert connection.rollbacks == 0


def test_serialized_source_view_reuses_one_transaction_for_load_and_persist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeCursor:
        description: list[SimpleNamespace] = []

        def __init__(self) -> None:
            self.queries: list[str] = []

        def __enter__(self) -> FakeCursor:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def execute(self, sql: str, _parameters: Any = None) -> None:
            self.queries.append(sql)

        def fetchone(self) -> tuple[None]:
            return (None,)

        def fetchall(self) -> list[tuple[()]]:
            return []

    class FakeConnection:
        def __init__(self) -> None:
            self.cursor_instance = FakeCursor()
            self.commits = 0
            self.rollbacks = 0

        def __enter__(self) -> FakeConnection:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def cursor(self) -> FakeCursor:
            return self.cursor_instance

        def commit(self) -> None:
            self.commits += 1

        def rollback(self) -> None:
            self.rollbacks += 1

    connection = FakeConnection()
    connect_calls = 0

    def connect(_url: str) -> FakeConnection:
        nonlocal connect_calls
        connect_calls += 1
        return connection

    repository = OutcomeStatisticsRepository("postgresql://test", connect=connect)
    bundle = build_statistics_bundle(
        (),
        knowledge_cutoff_at=CUTOFF,
        window_months=12,
        computed_at=CUTOFF + timedelta(seconds=1),
    )

    def persist_on_active_cursor(
        cursor: Any,
        _snapshot: Any,
        *,
        parent_snapshot_id: str | None,
    ) -> tuple[str, bool]:
        assert cursor is connection.cursor_instance
        assert parent_snapshot_id is None
        return _uuid(90), True

    monkeypatch.setattr(repository_module, "_persist_snapshot", persist_on_active_cursor)

    with repository.serialized_source_view():
        rows = repository.load_rounds(
            period_start=date(2025, 7, 2),
            period_end=date(2026, 7, 1),
            knowledge_cutoff_at=CUTOFF,
            round_kind="initial",
            max_rounds=10,
        )
        summary = repository.persist_bundles((bundle,))

    assert rows == ()
    assert summary.inserted_snapshots == 1
    assert connect_calls == 1
    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert "read committed" in connection.cursor_instance.queries[0].lower()
    assert "pg_advisory_xact_lock" in connection.cursor_instance.queries[1]
    assert "with bounded_rounds as (" in connection.cursor_instance.queries[2]


def test_persist_failure_rolls_back_the_whole_serialized_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeCursor:
        def __enter__(self) -> FakeCursor:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def execute(self, _sql: str, _parameters: Any = None) -> None:
            pass

        def fetchone(self) -> tuple[None]:
            return (None,)

    class FakeConnection:
        def __init__(self) -> None:
            self.cursor_instance = FakeCursor()
            self.commits = 0
            self.rollbacks = 0

        def __enter__(self) -> FakeConnection:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def cursor(self) -> FakeCursor:
            return self.cursor_instance

        def commit(self) -> None:
            self.commits += 1

        def rollback(self) -> None:
            self.rollbacks += 1

    connection = FakeConnection()
    repository = OutcomeStatisticsRepository(
        "postgresql://test",
        connect=lambda _url: connection,
    )
    bundle = build_statistics_bundle(
        (),
        knowledge_cutoff_at=CUTOFF,
        window_months=12,
        computed_at=CUTOFF + timedelta(seconds=1),
    )

    def fail_persist(*_args: object, **_kwargs: object) -> tuple[str, bool]:
        raise RuntimeError("write failure")

    monkeypatch.setattr(repository_module, "_persist_snapshot", fail_persist)

    with pytest.raises(OutcomeStatisticsRepositoryError, match="snapshot transaction failed"):
        with repository.serialized_source_view():
            repository.persist_bundles((bundle,))

    assert connection.commits == 0
    assert connection.rollbacks == 1


def test_existing_database_hash_reuses_snapshot_without_insert() -> None:
    snapshot = build_statistics_bundle(
        _round_observations((_database_row(),), CUTOFF),
        knowledge_cutoff_at=CUTOFF,
        window_months=12,
        computed_at=CUTOFF + timedelta(seconds=1),
    ).national

    class FakeCursor:
        def __init__(self) -> None:
            self.queries: list[str] = []
            self.responses = iter((({snapshot.members[0].round_id: "a" * 64},), ("b" * 64,), (_uuid(99),)))

        def execute(self, sql: str, _parameters: Any = None) -> None:
            self.queries.append(sql)

        def fetchone(self) -> tuple[str]:
            return next(self.responses)

    cursor = FakeCursor()
    snapshot_id, inserted = _persist_snapshot(cursor, snapshot, parent_snapshot_id=None)

    assert snapshot_id == _uuid(99)
    assert inserted is False
    assert not any("insert into public.tribunal_statistics_snapshots" in query for query in cursor.queries)
    member_query = next(query for query in cursor.queries if "tribunal_statistics_member_hash" in query)
    assert member_query.count("%s") == 3
    assert "jsonb_to_recordset" in member_query
    source_query = next(query for query in cursor.queries if "tribunal_statistics_source_manifest_hash" in query)
    assert source_query.count("%s") == 13


def test_database_source_hash_receives_the_private_unfrozen_round_ids() -> None:
    row = _database_row()
    row["feature_snapshot_id"] = None
    snapshot = build_statistics_bundle(
        _round_observations((row,), CUTOFF),
        knowledge_cutoff_at=CUTOFF,
        window_months=12,
        computed_at=CUTOFF + timedelta(seconds=1),
    ).national

    class FakeCursor:
        def __init__(self) -> None:
            self.calls: list[tuple[str, Any]] = []
            self.responses = iter((("b" * 64,), (_uuid(99),)))

        def execute(self, sql: str, parameters: Any = None) -> None:
            self.calls.append((sql, parameters))

        def fetchone(self) -> tuple[str]:
            return next(self.responses)

    cursor = FakeCursor()
    snapshot_id, inserted = _persist_snapshot(cursor, snapshot, parent_snapshot_id=None)

    assert snapshot_id == _uuid(99)
    assert inserted is False
    source_sql, source_parameters = next(
        call for call in cursor.calls if "tribunal_statistics_source_manifest_hash" in call[0]
    )
    assert source_sql.count("%s") == len(source_parameters) == 13
    assert source_parameters[10] == 1
    assert source_parameters[11] == [str(row["round_id"])]
    assert "'scheduledAtEpoch', extract(epoch from round_row.scheduled_at)" in source_sql


def test_repository_rejects_persistence_without_the_source_lock() -> None:
    repository = OutcomeStatisticsRepository(
        "postgresql://test",
        connect=lambda _url: (_ for _ in ()).throw(AssertionError("must not connect")),
    )

    with pytest.raises(
        OutcomeStatisticsRepositoryError,
        match="requires serialized_source_view",
    ):
        repository.persist_bundles(())


def test_new_snapshot_and_member_statements_have_exact_parameter_arity() -> None:
    snapshot = build_statistics_bundle(
        _round_observations((_database_row(),), CUTOFF),
        knowledge_cutoff_at=CUTOFF,
        window_months=12,
        computed_at=CUTOFF + timedelta(seconds=1),
    ).national

    class FakeCursor:
        def __init__(self) -> None:
            self.queries: list[str] = []
            self.responses = iter(
                (
                    ({snapshot.members[0].round_id: "a" * 64},),
                    ("b" * 64,),
                    None,
                    (_uuid(100),),
                )
            )

        def execute(self, sql: str, parameters: Any = None) -> None:
            self.queries.append(sql)
            if parameters is not None:
                assert sql.count("%s") == len(parameters)

        def fetchone(self) -> tuple[str] | None:
            return next(self.responses)

    cursor = FakeCursor()
    snapshot_id, inserted = _persist_snapshot(cursor, snapshot, parent_snapshot_id=None)

    assert snapshot_id == _uuid(100)
    assert inserted is True
    assert any("insert into public.tribunal_statistics_snapshots" in query for query in cursor.queries)
    assert any("insert into public.tribunal_statistics_members" in query for query in cursor.queries)


def test_member_hashing_and_insert_are_constant_query_batches_for_large_snapshots() -> None:
    snapshot = build_statistics_bundle(
        _round_observations((_database_row(),), CUTOFF),
        knowledge_cutoff_at=CUTOFF,
        window_months=12,
        computed_at=CUTOFF + timedelta(seconds=1),
    ).national
    base_member = snapshot.members[0]
    members = tuple(
        replace(
            base_member,
            round_id=_uuid(10_000 + index),
            feature_snapshot_id=_uuid(20_000 + index),
            outcome_id=_uuid(30_000 + index),
        )
        for index in range(500)
    )
    large_snapshot = replace(snapshot, members=members, eligible_round_count=len(members))

    class FakeCursor:
        def __init__(self) -> None:
            self.calls: list[tuple[str, Any]] = []
            self.responses = iter(
                (
                    ({member.round_id: "a" * 64 for member in members},),
                    ("b" * 64,),
                    None,
                    (_uuid(100),),
                )
            )

        def execute(self, sql: str, parameters: Any = None) -> None:
            self.calls.append((sql, parameters))

        def fetchone(self) -> tuple[object] | None:
            return next(self.responses)

    cursor = FakeCursor()
    snapshot_id, inserted = _persist_snapshot(cursor, large_snapshot, parent_snapshot_id=None)

    assert snapshot_id == _uuid(100)
    assert inserted is True
    assert len(cursor.calls) == 6
    hash_calls = [call for call in cursor.calls if "tribunal_statistics_member_hash" in call[0]]
    insert_calls = [call for call in cursor.calls if "insert into public.tribunal_statistics_members" in call[0]]
    assert len(hash_calls) == 1
    assert len(insert_calls) == 1
    assert len(hash_calls[0][1][0].obj) == 500
    assert len(insert_calls[0][1][1].obj) == 500


def test_database_errors_are_wrapped_without_echoing_connection_details() -> None:
    def failing_connect(_url: str) -> object:
        raise RuntimeError("password=do-not-echo")

    repository = OutcomeStatisticsRepository(
        "postgresql://user:secret@example.test/database",
        connect=failing_connect,
    )

    with pytest.raises(OutcomeStatisticsRepositoryError) as captured:
        repository.load_rounds(
            period_start=date(2025, 7, 2),
            period_end=date(2026, 7, 1),
            knowledge_cutoff_at=CUTOFF,
            round_kind="initial",
            max_rounds=10,
        )

    assert str(captured.value) == "failed to load the frozen mature-round universe"
    assert "secret" not in str(captured.value)
