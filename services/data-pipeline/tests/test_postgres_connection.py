"""Default statement timeout and per-process connection reuse (P2-19)."""

from __future__ import annotations

import os

import psycopg
import pytest

from src import pipeline_usage, source_detail_worker
from src.storage import supabase_client


class FakePsycopg:
    OperationalError = psycopg.OperationalError
    InterfaceError = psycopg.InterfaceError

    def __init__(self, *, reject_options: bool = False) -> None:
        self.connects: list[tuple[tuple, dict]] = []
        self.reject_options = reject_options
        self.connections: list[FakeConnection] = []

    def connect(self, *args, **kwargs):
        self.connects.append((args, kwargs))
        if self.reject_options and "options" in kwargs:
            raise psycopg.OperationalError("unsupported startup parameter: options")
        connection = FakeConnection()
        self.connections.append(connection)
        return connection


class FakeConnection:
    def __init__(self) -> None:
        self.closed = False
        self.autocommit = False
        self.statements: list[str] = []
        self.commits = 0
        self.fail_next: Exception | None = None

    def execute(self, statement, parameters=None):
        if self.fail_next is not None:
            error, self.fail_next = self.fail_next, None
            raise error
        self.statements.append(" ".join(str(statement).split()))
        return self

    def fetchone(self):
        return None

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def fake_psycopg(monkeypatch):
    fake = FakePsycopg()
    monkeypatch.setattr(supabase_client, "psycopg", fake)
    return fake


def test_default_statement_timeout_is_two_minutes(fake_psycopg) -> None:
    supabase_client._postgres_connect("postgresql://example/db")

    assert fake_psycopg.connects[0][1]["options"] == "-c statement_timeout=120000"
    assert supabase_client.POSTGRES_STATEMENT_TIMEOUT_MS == 120_000


def test_training_gets_a_longer_limit_and_zero_disables_it(fake_psycopg) -> None:
    supabase_client._postgres_connect(
        "postgresql://example/db",
        statement_timeout_ms=supabase_client.POSTGRES_TRAINING_STATEMENT_TIMEOUT_MS,
    )
    supabase_client._postgres_connect("postgresql://example/db", statement_timeout_ms=0)
    supabase_client._postgres_connect("postgresql://example/db", statement_timeout_ms=None)

    options = [kwargs.get("options") for _, kwargs in fake_psycopg.connects]
    assert options == ["-c statement_timeout=900000", "-c statement_timeout=0", None]
    assert supabase_client.POSTGRES_TRAINING_STATEMENT_TIMEOUT_MS > supabase_client.POSTGRES_STATEMENT_TIMEOUT_MS


def test_an_explicit_options_parameter_in_the_url_is_respected(fake_psycopg) -> None:
    supabase_client._postgres_connect("postgresql://u@h/db?options=-c%20statement_timeout%3D5000")

    assert "options" not in fake_psycopg.connects[0][1]


def test_pooler_rejecting_startup_options_falls_back_to_a_session_set(monkeypatch) -> None:
    fake = FakePsycopg(reject_options=True)
    monkeypatch.setattr(supabase_client, "psycopg", fake)

    connection = supabase_client._postgres_connect("postgresql://example/db", retry_delays=())

    assert "options" not in fake.connects[-1][1]
    assert connection.statements == ["set statement_timeout = 120000"]
    assert connection.commits == 1


def test_real_connect_applies_the_timeout_to_the_session() -> None:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with supabase_client._postgres_connect(url) as connection:
        assert connection.execute("show statement_timeout").fetchone()[0] == "2min"
    with supabase_client._postgres_connect(url, statement_timeout_ms=0) as connection:
        assert connection.execute("show statement_timeout").fetchone()[0] == "0"
    with supabase_client._postgres_connect(url) as connection:
        connection.execute("set statement_timeout = 200")
        with pytest.raises(psycopg.errors.QueryCanceled):
            connection.execute("select pg_sleep(2)")


def test_shared_connection_is_opened_once_per_process(fake_psycopg) -> None:
    for _ in range(3):
        with supabase_client._shared_postgres_connection("postgresql://example/db") as db:
            db.execute("select 1")

    assert len(fake_psycopg.connects) == 1
    assert fake_psycopg.connections[0].autocommit is True


def test_shared_connection_reconnects_after_it_was_closed(fake_psycopg) -> None:
    with supabase_client._shared_postgres_connection("postgresql://example/db"):
        pass
    fake_psycopg.connections[0].closed = True

    with supabase_client._shared_postgres_connection("postgresql://example/db"):
        pass

    assert len(fake_psycopg.connects) == 2


def test_idle_shared_connection_is_pinged_and_replaced_when_dead(fake_psycopg, monkeypatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(supabase_client.time, "monotonic", lambda: clock[0])
    with supabase_client._shared_postgres_connection("postgresql://example/db"):
        pass
    clock[0] += supabase_client.POSTGRES_SHARED_CONNECTION_PING_AFTER_SECONDS + 1
    fake_psycopg.connections[0].fail_next = psycopg.OperationalError("server closed the connection")

    with supabase_client._shared_postgres_connection("postgresql://example/db") as db:
        assert db is fake_psycopg.connections[1]

    assert fake_psycopg.connections[0].closed


def test_transport_errors_discard_the_shared_connection_but_sql_errors_keep_it(fake_psycopg) -> None:
    with pytest.raises(psycopg.errors.RaiseException):
        with supabase_client._shared_postgres_connection("postgresql://example/db"):
            raise psycopg.errors.RaiseException("budget exhausted")
    with supabase_client._shared_postgres_connection("postgresql://example/db"):
        pass
    assert len(fake_psycopg.connects) == 1

    with pytest.raises(psycopg.OperationalError):
        with supabase_client._shared_postgres_connection("postgresql://example/db"):
            raise psycopg.OperationalError("connection lost")
    with supabase_client._shared_postgres_connection("postgresql://example/db"):
        pass
    assert len(fake_psycopg.connects) == 2
    assert fake_psycopg.connections[0].closed


def test_predictions_reuse_one_connection_instead_of_one_per_call(fake_psycopg, monkeypatch) -> None:
    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "run-1")
    monkeypatch.setattr(
        pipeline_usage, "load_settings", lambda: {"supabase_db_url": "postgresql://example/db"}
    )
    monkeypatch.setattr(pipeline_usage, "_spend_groups_via_postgres", lambda db_url, since: [])
    fake_psycopg_connection_rows = iter(range(100))
    monkeypatch.setattr(FakeConnection, "fetchone", lambda self: (f"usage-{next(fake_psycopg_connection_rows)}",))

    for _ in range(3):
        pipeline_usage.reserve_prediction(
            "qwen/qwen3-7-plus", input_token_ceiling=10, output_token_ceiling=10
        )
        pipeline_usage.record_prediction({"id": "p", "status": "starting"}, model="qwen/qwen3-7-plus")

    assert len(fake_psycopg.connects) == 1


def test_source_gate_checks_reuse_one_connection(fake_psycopg, monkeypatch) -> None:
    monkeypatch.setattr(FakeConnection, "fetchone", lambda self: (True, True, True, None))
    settings = {"supabase_db_url": "postgresql://example/db"}

    results = [source_detail_worker.source_detail_source_enabled("licitor", settings) for _ in range(4)]

    assert results == [True, True, True, True]
    assert len(fake_psycopg.connects) == 1


def test_valuation_training_reads_with_the_training_timeout(monkeypatch) -> None:
    from src import valuation_training

    seen: list[int | None] = []

    def stop_connecting(url, **kwargs):
        seen.append(kwargs.get("statement_timeout_ms"))
        raise RuntimeError("stop")

    monkeypatch.setattr(supabase_client, "_postgres_connect", stop_connecting)
    monkeypatch.setattr(valuation_training, "valuation_database_url", lambda: "postgresql://example/db")

    with pytest.raises(RuntimeError, match="stop"):
        valuation_training.train_valuation_models(
            valuation_training.TrainingOptions(segments=("apartment",))
        )

    assert seen == [supabase_client.POSTGRES_TRAINING_STATEMENT_TIMEOUT_MS]


def test_public_connect_keeps_the_private_connection_behaviour(fake_psycopg) -> None:
    connection = supabase_client.connect(
        "postgresql://example/db", connect_timeout=3, retry_delays=(), statement_timeout_ms=0
    )

    assert connection is fake_psycopg.connections[0]
    assert fake_psycopg.connects[0][1] == {
        "connect_timeout": 3,
        "prepare_threshold": None,
        "options": "-c statement_timeout=0",
    }


def test_public_connect_follows_a_patched_private_connect(monkeypatch) -> None:
    seen: list[tuple[str, dict]] = []

    def fake_connect(url, **options):
        seen.append((url, options))
        return "patched"

    monkeypatch.setattr(supabase_client, "_postgres_connect", fake_connect)

    assert supabase_client.connect("postgresql://x/db", retry_delays=()) == "patched"
    assert seen == [("postgresql://x/db", {"retry_delays": ()})]


def test_no_module_reaches_for_the_private_connect_symbol() -> None:
    """Outside supabase_client, connections go through the public ``connect``."""
    import ast
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    offenders: list[str] = []
    for folder in ("src", "scripts"):
        for path in (root / folder).rglob("*.py"):
            if path.name == "supabase_client.py":
                continue
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                private_import = isinstance(node, ast.ImportFrom) and any(
                    alias.name == "_postgres_connect" and (node.module or "").startswith("src.storage")
                    for alias in node.names
                )
                private_attribute = (
                    isinstance(node, ast.Attribute)
                    and node.attr == "_postgres_connect"
                    and isinstance(node.value, ast.Name)
                    and node.value.id in {"storage", "supabase_client"}
                )
                if private_import or private_attribute:
                    offenders.append(f"{path.relative_to(root)}:{node.lineno}")
    assert offenders == []
