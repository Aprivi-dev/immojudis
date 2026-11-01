"""Lot 2b, n° 44 : la connexion directe au Postgres est chiffrée (sslmode=require) quand l'URL n'en dit rien."""

from __future__ import annotations

import pytest

from src.storage import audit_database, supabase_client
from src.storage.connection_guards import POSTGRES_SSL_ENV, postgres_ssl_options


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch):
    monkeypatch.delenv(POSTGRES_SSL_ENV, raising=False)
    monkeypatch.delenv("PGSSLMODE", raising=False)


REMOTE_URL = "postgresql://postgres.abc:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres"


def test_a_remote_url_without_sslmode_is_forced_to_require() -> None:
    assert postgres_ssl_options(REMOTE_URL) == {"sslmode": "require"}
    assert postgres_ssl_options("postgresql://u:p@db.example.com/db") == {"sslmode": "require"}
    assert postgres_ssl_options("host=db.example.com dbname=postgres user=u") == {"sslmode": "require"}


@pytest.mark.parametrize(
    "url",
    [
        REMOTE_URL + "?sslmode=verify-full",
        "postgresql://u@db.example.com/db?application_name=x&SSLMODE=prefer",
        "host=db.example.com dbname=postgres sslmode=verify-ca",
    ],
)
def test_an_url_that_carries_its_own_sslmode_keeps_control(url: str) -> None:
    assert postgres_ssl_options(url) == {}


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://postgres:pipeline-test-only@localhost:5432/postgres",
        "postgresql://postgres@127.0.0.1:54322/postgres",
        "postgresql://postgres@[::1]:5432/postgres",
        "postgresql:///postgres?host=/var/run/postgresql",
        "host=/var/run/postgresql dbname=postgres",
    ],
)
def test_the_local_database_of_the_ci_is_not_forced_to_use_tls(url: str) -> None:
    assert postgres_ssl_options(url) == {}


def test_the_exception_variable_disables_tls_for_a_local_database_only(monkeypatch) -> None:
    monkeypatch.setenv(POSTGRES_SSL_ENV, "disable")

    assert postgres_ssl_options("postgresql://postgres@localhost:5432/postgres") == {"sslmode": "disable"}
    with pytest.raises(ValueError, match="local database"):
        postgres_ssl_options(REMOTE_URL)


def test_the_exception_variable_never_overrides_an_explicit_sslmode(monkeypatch) -> None:
    monkeypatch.setenv(POSTGRES_SSL_ENV, "disable")

    assert postgres_ssl_options("postgresql://u@localhost/db?sslmode=require") == {}


@pytest.mark.parametrize("mode", ["require", "verify-ca", "verify-full"])
def test_the_variable_can_ask_for_a_stricter_mode(monkeypatch, mode: str) -> None:
    monkeypatch.setenv(POSTGRES_SSL_ENV, mode)

    assert postgres_ssl_options(REMOTE_URL) == {"sslmode": mode}


def test_an_unknown_mode_is_refused(monkeypatch) -> None:
    monkeypatch.setenv(POSTGRES_SSL_ENV, "prefer")

    with pytest.raises(ValueError, match="POSTGRES_SSL"):
        postgres_ssl_options(REMOTE_URL)


def test_pgsslmode_of_the_environment_is_respected(monkeypatch) -> None:
    monkeypatch.setenv("PGSSLMODE", "verify-full")

    assert postgres_ssl_options(REMOTE_URL) == {}


class _Psycopg:
    OperationalError = RuntimeError
    InterfaceError = RuntimeError

    def __init__(self) -> None:
        self.connects: list[tuple[tuple, dict]] = []

    def connect(self, *args, **kwargs):
        self.connects.append((args, kwargs))
        return object()


def test_the_pipeline_connection_carries_sslmode_require(monkeypatch) -> None:
    fake = _Psycopg()
    monkeypatch.setattr(supabase_client, "psycopg", fake)

    supabase_client._postgres_connect(REMOTE_URL)

    assert fake.connects[0][1]["sslmode"] == "require"


def test_the_pipeline_connection_to_the_local_database_sets_no_sslmode(monkeypatch) -> None:
    fake = _Psycopg()
    monkeypatch.setattr(supabase_client, "psycopg", fake)

    supabase_client._postgres_connect("postgresql://postgres@localhost:5432/postgres")

    assert "sslmode" not in fake.connects[0][1]


def test_the_audit_connection_carries_sslmode_require(monkeypatch) -> None:
    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return self

        def execute(self, *args, **kwargs):
            return self

        description: list = []

        def fetchall(self):
            return []

    seen: list[dict] = []
    monkeypatch.setattr(audit_database.psycopg, "connect", lambda url, **kwargs: seen.append(kwargs) or Connection())
    monkeypatch.setattr(audit_database, "load_settings", lambda: {"supabase_db_url": REMOTE_URL})
    monkeypatch.setattr(audit_database, "QUERIES", {"x": "select 1"})

    audit_database.run_audit()

    assert seen == [{"sslmode": "require"}]
