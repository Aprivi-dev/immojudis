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
