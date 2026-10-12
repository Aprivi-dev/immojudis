from __future__ import annotations

from contextlib import nullcontext

import psycopg

from src.sources import licitor_history_refresh as refresh_module


class FakeConnection:
    def __init__(self, *, refuse_role: bool = False) -> None:
        self.statements: list[str] = []
        self.refuse_role = refuse_role
        self.row_factory = None

    def execute(self, statement, params=()):
        self.statements.append(statement)
        if statement.startswith("set role") and self.refuse_role:
            raise psycopg.errors.InsufficientPrivilege("permission denied to set role")
        connection = self

        class Result:
            def fetchone(self):
                return {"attest_licitor_reported_candidates": 7} if "attest" in statement else None

        del connection
        return Result()


def test_one_tick_under_the_collector_role_then_attestation() -> None:
    connection = FakeConnection()
    calls: list[str] = []

    def start(store):
        calls.append(f"start:{store.db is connection}")
        return {"status": "already_exists", "run_id": "monthly-2026-10"}

    def tick(store):
        calls.append("tick")
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
    assert calls == ["start:True", "tick"]
    assert connection.statements[0] == "set role licitor_collector"
    assert connection.statements.index("reset role") < connection.statements.index(refresh_module.ATTEST_SQL)


def test_the_role_is_reset_even_when_the_tick_fails() -> None:
    connection = FakeConnection()

    def tick(_store):
        raise RuntimeError("network down")

    try:
        refresh_module.refresh(
            "postgresql://test",
            connect=lambda _url: nullcontext(connection),
            tick=tick,
            start=lambda _store: {"status": "queued"},
        )
    except RuntimeError:
        pass
    assert connection.statements[-1] == "reset role"


def test_a_missing_role_grant_is_reported_without_collecting() -> None:
    connection = FakeConnection(refuse_role=True)
    report = refresh_module.refresh(
        "postgresql://test",
        connect=lambda _url: nullcontext(connection),
        tick=lambda _store: {"status": "never"},
        start=lambda _store: {"status": "never"},
    )
    assert report["status"] == "collector_role_unavailable"
    assert refresh_module.ATTEST_SQL not in connection.statements
