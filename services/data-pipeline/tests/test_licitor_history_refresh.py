from __future__ import annotations

import os
from contextlib import contextmanager, nullcontext

import psycopg
import pytest

from src.sources import licitor_history_refresh as refresh_module

SET_LOCAL = f"set local role {refresh_module.COLLECTOR_ROLE}"


class FakeConnection:
    """Records statements with the transaction they ran in (0 = autocommit)."""

    def __init__(
        self,
        *,
        refuse_role: bool = False,
        snapshot_error: Exception | bool = False,
        snapshot_age_seconds: float | None = 3600,
    ) -> None:
        self.statements: list[tuple[int, str]] = []
        self.params: list[object] = []
        self.refuse_role = refuse_role
        self.snapshot_error = snapshot_error
        self.snapshot_age_seconds = snapshot_age_seconds
        self.row_factory = None
        self.transactions = 0
        self.open: int | None = None

    @contextmanager
    def transaction(self):
        outer = self.open is None
        if outer:
            self.transactions += 1
            self.open = self.transactions
        try:
            yield None
        finally:
            if outer:
                self.open = None

    def execute(self, statement, params=None):
        self.statements.append((self.open or 0, statement))
        if statement.startswith("set") and "role" in statement and self.refuse_role:
            raise psycopg.errors.InsufficientPrivilege("permission denied to set role")

        if "refresh_auction_scenario_observations" in statement and self.snapshot_error:
            raise (
                self.snapshot_error
                if isinstance(self.snapshot_error, Exception)
                else psycopg.errors.QueryCanceled("canceling statement due to statement timeout")
            )
        self.params.append(params)
        age = self.snapshot_age_seconds

        class Result:
            def fetchone(self):
                if "auction_scenario_snapshot_state" in statement:
                    return None if age is None else {"age": age}
                if "attest" in statement:
                    return {"attest_licitor_reported_candidates": 7}
                if "refresh_auction_scenario_observations" in statement:
                    return {"refresh_auction_scenario_observations": 3783 if params == (True,) else None}
                return None

        return Result()


def test_one_tick_under_the_collector_role_then_attestation() -> None:
    connection = FakeConnection()
    calls: list[str] = []

    def start(store):
        calls.append("start")
        store.db.execute("select 1 from licitor_ingestion.control")
        return {"status": "already_exists", "run_id": "monthly-2026-10"}

    def tick(store):
        calls.append("tick")
        with store.db.transaction():
            store.db.execute("update licitor_ingestion.tasks set status='done'")
            store.db.execute("insert into licitor_ingestion.events values (1)")
        return {"status": "checkpointed", "run_id": "monthly-2026-10", "processed": 42}

    report = refresh_module.refresh(
        "postgresql://test", connect=lambda _url: nullcontext(connection), tick=tick, start=start
    )

    assert report == {
        "campaign": "already_exists",
        "tick": {"status": "checkpointed", "run_id": "monthly-2026-10", "processed": 42},
        "attested": 7,
        "scenario_snapshot": {"status": "refreshed", "lots": 3783},
        "status": "ok",
    }
    assert calls == ["start", "tick"]
    # A session-level role would leak through the transaction pooler.
    assert not any(statement in {f"set role {refresh_module.COLLECTOR_ROLE}", "reset role"}
                   for _, statement in connection.statements)
    collector_statements = [
        (tx, statement) for tx, statement in connection.statements
        if statement
        not in {
            SET_LOCAL,
            refresh_module.ATTEST_SQL,
            refresh_module.SCENARIO_SNAPSHOT_SQL,
            refresh_module.SNAPSHOT_STATEMENT_TIMEOUT,
        }
    ]
    first_statement: dict[int, str] = {}
    for tx, statement in connection.statements:
        first_statement.setdefault(tx, statement)
    for tx, _statement in collector_statements:
        assert tx, "collector statements always run inside a transaction"
        assert first_statement[tx] == SET_LOCAL
    # Both statements of the explicit block share one transaction and one role switch.
    tick_transactions = {tx for tx, statement in collector_statements if "licitor_ingestion.tasks" in statement
                         or "licitor_ingestion.events" in statement}
    assert len(tick_transactions) == 1
    # The attestation runs as the main role, outside any collector transaction.
    assert (0, refresh_module.ATTEST_SQL) in connection.statements
    # New lots were attested: the scenarios' copy is refreshed at once, as the main role, in its
    # own transaction with a longer statement timeout (it ends with the transaction).
    refresh_tx = next(tx for tx, statement in connection.statements if statement == refresh_module.SCENARIO_SNAPSHOT_SQL)
    assert refresh_tx
    assert (refresh_tx, refresh_module.SNAPSHOT_STATEMENT_TIMEOUT) in connection.statements
    assert (refresh_tx, SET_LOCAL) not in connection.statements
    assert connection.params[-1] == (True,)


class NothingAttestedConnection(FakeConnection):
    def execute(self, statement, params=None):
        result = super().execute(statement, params)
        if "attest" not in statement:
            return result

        class Result:
            def fetchone(self):
                return {"attest_licitor_reported_candidates": 0}

        return Result()


def test_without_new_lots_the_snapshot_refresh_is_not_forced() -> None:
    connection = NothingAttestedConnection()
    report = refresh_module.refresh(
        "postgresql://test",
        connect=lambda _url: nullcontext(connection),
        tick=lambda _store: {"status": "idle"},
        start=lambda _store: {"status": "already_exists"},
    )
    assert report["attested"] == 0
    assert connection.params[-1] == (False,)
    assert report["scenario_snapshot"] == {"status": "skipped"}
    assert report["status"] == "ok"


def test_a_stale_copy_is_forced_even_without_new_lots() -> None:
    connection = NothingAttestedConnection(snapshot_age_seconds=25 * 3600)
    report = refresh_module.refresh(
        "postgresql://test",
        connect=lambda _url: nullcontext(connection),
        tick=lambda _store: {"status": "idle"},
        start=lambda _store: {"status": "already_exists"},
    )
    assert report["attested"] == 0
    assert connection.params[-1] == (True,)
    assert report["status"] == "ok"


def test_a_missing_copy_is_forced_too() -> None:
    connection = NothingAttestedConnection(snapshot_age_seconds=None)
    refresh_module.refresh(
        "postgresql://test",
        connect=lambda _url: nullcontext(connection),
        tick=lambda _store: {"status": "idle"},
        start=lambda _store: {"status": "already_exists"},
    )
    assert connection.params[-1] == (True,)


def test_a_failing_snapshot_refresh_is_reported_as_not_ok() -> None:
    connection = FakeConnection(snapshot_error=True)
    report = refresh_module.refresh(
        "postgresql://test",
        connect=lambda _url: nullcontext(connection),
        tick=lambda _store: {"status": "idle"},
        start=lambda _store: {"status": "already_exists"},
    )
    assert report["scenario_snapshot"] == {"status": "error", "error": "QueryCanceled"}
    assert report["status"] == "snapshot_error"
    assert connection.open is None


def test_a_refused_shrink_is_reported_as_refused() -> None:
    connection = FakeConnection(
        snapshot_error=psycopg.errors.ObjectNotInPrerequisiteState("refresh refused: 10 lots instead of 3783")
    )
    report = refresh_module.refresh(
        "postgresql://test",
        connect=lambda _url: nullcontext(connection),
        tick=lambda _store: {"status": "idle"},
        start=lambda _store: {"status": "already_exists"},
    )
    assert report["scenario_snapshot"] == {"status": "refused", "error": "ObjectNotInPrerequisiteState"}
    assert report["status"] == "snapshot_refused"


def test_a_failing_tick_still_attests_and_refreshes_the_copy() -> None:
    connection = FakeConnection()

    def tick(_store):
        raise RuntimeError("network down")

    with pytest.raises(RuntimeError):
        refresh_module.refresh(
            "postgresql://test",
            connect=lambda _url: nullcontext(connection),
            tick=tick,
            start=lambda _store: {"status": "queued"},
        )
    assert connection.open is None
    assert all(tx for tx, statement in connection.statements if "role" in statement)
    statements = [statement for _, statement in connection.statements]
    assert refresh_module.ATTEST_SQL in statements
    assert refresh_module.SCENARIO_SNAPSHOT_SQL in statements


def test_a_database_error_after_a_failing_tick_does_not_hide_the_tick_error() -> None:
    connection = FakeConnection(snapshot_error=True)

    def tick(_store):
        raise RuntimeError("network down")

    with pytest.raises(RuntimeError, match="network down"):
        refresh_module.refresh(
            "postgresql://test",
            connect=lambda _url: nullcontext(connection),
            tick=tick,
            start=lambda _store: {"status": "queued"},
        )


def test_snapshot_only_refreshes_the_copy_without_collecting() -> None:
    connection = FakeConnection(snapshot_age_seconds=30 * 3600)
    report = refresh_module.refresh_snapshot_only(
        "postgresql://test", connect=lambda _url: nullcontext(connection)
    )
    assert report == {"scenario_snapshot": {"status": "refreshed", "lots": 3783}, "status": "ok"}
    statements = [statement for _, statement in connection.statements]
    assert refresh_module.ATTEST_SQL not in statements
    assert SET_LOCAL not in statements


def test_a_missing_role_grant_is_reported_without_collecting() -> None:
    connection = FakeConnection(refuse_role=True)
    report = refresh_module.refresh(
        "postgresql://test",
        connect=lambda _url: nullcontext(connection),
        tick=lambda _store: {"status": "never"},
        start=lambda _store: {"status": "never"},
    )
    assert report["status"] == "collector_role_unavailable"
    assert all(statement != refresh_module.ATTEST_SQL for _, statement in connection.statements)


def test_the_role_never_outlives_a_statement_on_a_real_connection() -> None:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    role = refresh_module.COLLECTOR_ROLE
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(
            f"do $$ begin if not exists (select from pg_roles where rolname = '{role}') "
            f"then create role {role} nologin; end if; end $$"
        )
    with psycopg.connect(url, autocommit=True) as connection:
        main_role = connection.execute("select current_user").fetchone()[0]
        collector = refresh_module.CollectorRoleConnection(connection)
        assert collector.execute("select current_user").fetchone()[0] == role
        # What the next client of the pooled server connection would see.
        assert connection.execute("select current_user").fetchone()[0] == main_role
        with collector.transaction():
            assert collector.execute("select current_user").fetchone()[0] == role
            with collector.transaction():
                assert collector.execute("select current_user").fetchone()[0] == role
        assert connection.execute("select current_user").fetchone()[0] == main_role
        with pytest.raises(psycopg.errors.DivisionByZero):
            collector.execute("select 1/0")
        assert connection.execute("select current_user").fetchone()[0] == main_role
