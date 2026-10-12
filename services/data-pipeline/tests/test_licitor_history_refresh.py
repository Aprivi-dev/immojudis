from __future__ import annotations

import os
from contextlib import contextmanager, nullcontext

import psycopg
import pytest

from src.sources import licitor_history_refresh as refresh_module

SET_LOCAL = f"set local role {refresh_module.COLLECTOR_ROLE}"


class FakeConnection:
    """Records statements with the transaction they ran in (0 = autocommit)."""

    def __init__(self, *, refuse_role: bool = False) -> None:
        self.statements: list[tuple[int, str]] = []
        self.refuse_role = refuse_role
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

        class Result:
            def fetchone(self):
                return {"attest_licitor_reported_candidates": 7} if "attest" in statement else None

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
        "status": "ok",
    }
    assert calls == ["start", "tick"]
    # A session-level role would leak through the transaction pooler.
    assert not any(statement in {f"set role {refresh_module.COLLECTOR_ROLE}", "reset role"}
                   for _, statement in connection.statements)
    collector_statements = [
        (tx, statement) for tx, statement in connection.statements
        if statement != SET_LOCAL and statement != refresh_module.ATTEST_SQL
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


def test_a_failing_tick_leaves_no_role_behind() -> None:
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
