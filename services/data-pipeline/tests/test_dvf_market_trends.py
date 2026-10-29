from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest

from src import dvf_market_trends


class _Result:
    def __init__(self, row: tuple[Any, ...] | None) -> None:
        self._row = row

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._row


class _Connection:
    def __init__(self, *, row: tuple[Any, ...] | None = (1234,), error: Exception | None = None) -> None:
        self.statements: list[str] = []
        self.transactions = 0
        self._row = row
        self._error = error

    @contextmanager
    def transaction(self):
        self.transactions += 1
        yield

    def execute(self, statement: str) -> _Result:
        self.statements.append(statement)
        if self._error is not None and statement == dvf_market_trends.REFRESH_SQL:
            raise self._error
        return _Result(self._row if statement == dvf_market_trends.REFRESH_SQL else None)

    def __enter__(self) -> _Connection:
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None


class _SqlError(Exception):
    def __init__(self, message: str, sqlstate: str) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate


def test_refresh_sets_the_timeout_then_calls_the_function_in_one_transaction() -> None:
    connection = _Connection(row=(1234,))

    written = dvf_market_trends.refresh_commune_market_trends(connection)

    assert written == 1234
    assert connection.transactions == 1
    assert connection.statements == [
        "set local statement_timeout = '10min'",
        "select app_private.refresh_commune_market_trends()",
    ]


def test_refresh_reports_zero_when_the_function_returns_nothing() -> None:
    assert dvf_market_trends.refresh_commune_market_trends(_Connection(row=None)) == 0
    assert dvf_market_trends.refresh_commune_market_trends(_Connection(row=(None,))) == 0


def test_a_function_not_migrated_yet_is_skipped_not_failed() -> None:
    connection = _Connection(error=_SqlError("function does not exist", "42883"))

    assert dvf_market_trends.refresh_commune_market_trends(connection) is None


def test_any_other_database_error_fails_the_refresh() -> None:
    for sqlstate in ("55000", "57014", "42501"):
        connection = _Connection(error=_SqlError("boom", sqlstate))
        with pytest.raises(_SqlError):
            dvf_market_trends.refresh_commune_market_trends(connection)


def test_main_refreshes_through_the_configured_database(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    urls: list[str] = []
    connection = _Connection(row=(77,))

    def fake_connect(url: str) -> _Connection:
        urls.append(url)
        return connection

    monkeypatch.setattr(dvf_market_trends, "_postgres_connect", fake_connect)
    monkeypatch.setattr(dvf_market_trends, "load_settings", lambda: {"supabase_db_url": "postgres://example"})
    monkeypatch.setattr("sys.argv", ["dvf_market_trends"])

    assert dvf_market_trends.main() == 0

    assert urls == ["postgres://example"]
    assert "- rows: 77" in capsys.readouterr().out


def test_main_warns_and_succeeds_when_the_migration_is_missing(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    connection = _Connection(error=_SqlError("function does not exist", "42883"))
    monkeypatch.setattr(dvf_market_trends, "_postgres_connect", lambda url: connection)
    monkeypatch.setattr(dvf_market_trends, "load_settings", lambda: {"supabase_db_url": "postgres://example"})
    monkeypatch.setattr("sys.argv", ["dvf_market_trends"])

    assert dvf_market_trends.main() == 0

    assert "::warning::" in capsys.readouterr().out


def test_main_requires_a_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dvf_market_trends, "load_settings", lambda: {"supabase_db_url": None})
    monkeypatch.setattr("sys.argv", ["dvf_market_trends"])

    with pytest.raises(RuntimeError, match="SUPABASE_DB_URL"):
        dvf_market_trends.main()
