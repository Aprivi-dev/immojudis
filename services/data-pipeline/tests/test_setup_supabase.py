from __future__ import annotations

import pytest

from src.storage import setup_supabase


def test_hosted_supabase_schema_bootstrap_is_refused(monkeypatch) -> None:
    monkeypatch.setattr(
        setup_supabase,
        "load_settings",
        lambda: {
            "supabase_db_url": (
                "postgresql://postgres.project:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
            )
        },
    )

    with pytest.raises(RuntimeError, match="versioned supabase/migrations"):
        setup_supabase.apply_schema()


@pytest.mark.parametrize(
    ("db_url", "expected"),
    [
        ("postgresql://postgres:postgres@127.0.0.1:54322/postgres", False),
        ("postgresql://postgres:postgres@db.example.net:5432/postgres", False),
        ("postgresql://postgres.ref:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres", True),
        ("postgresql://postgres:secret@db.ref.supabase.com:5432/postgres", True),
        ("postgresql://postgres:secret@db.ref.supabase.co:5432/postgres", True),
    ],
)
def test_hosted_supabase_url_detection(db_url: str, expected: bool) -> None:
    assert setup_supabase._is_hosted_supabase_url(db_url) is expected


def test_schema_bootstrap_connects_with_the_tls_guard(monkeypatch, tmp_path) -> None:
    db_url = "postgresql://postgres:postgres@db.example.net:5432/postgres"
    schema_path = tmp_path / "schema.sql"
    schema_path.write_text("select 1;", encoding="utf-8")
    monkeypatch.delenv("POSTGRES_SSL", raising=False)
    monkeypatch.delenv("PGSSLMODE", raising=False)
    monkeypatch.setattr(setup_supabase, "load_settings", lambda: {"supabase_db_url": db_url})
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def cursor(self):
            return self

        def execute(self, _sql):
            return None

        def commit(self):
            return None

    def fake_connect(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeConnection()

    monkeypatch.setattr(setup_supabase.psycopg, "connect", fake_connect)

    setup_supabase.apply_schema(schema_path)

    assert calls == [((db_url,), {"sslmode": "require"})]
