"""Candidate selection and storage of document readings against a real PostgreSQL."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from src import document_reading as reading
from src.storage.supabase_client import _postgres_connect

ROOT = Path(__file__).resolve().parents[3]


def migration(name: str) -> str:
    return (ROOT / "supabase/migrations" / name).read_text(encoding="utf-8").removeprefix("begin;").removesuffix("commit;\n")


def setup(db) -> None:
    for role in ("anon", "authenticated", "service_role"):
        db.execute(
            f"do $$ begin if not exists(select from pg_roles where rolname='{role}') "
            f"then create role {role}; end if; end $$"
        )
    db.execute(
        """create table auction_sales(id uuid primary key default gen_random_uuid(), source_url text unique,
        status text default 'upcoming', sale_date timestamptz)"""
    )
    db.execute(
        """create table auction_extractions(source_url text, provider text, result jsonb,
        updated_at timestamptz default now())"""
    )
    db.execute(migration("20261018110000_auction_document_readings.sql"))
    db.execute(migration("20261020120021_document_readings_attempt_count.sql"))


def add_sale(db, url: str, *, status: str | None, attempts: int = 0, generated_hours_ago: float = 0,
             version: str = reading.DOCUMENT_READING_VERSION) -> None:
    sale_id = db.execute(
        "insert into auction_sales(source_url) values (%s) returning id", (url,)
    ).fetchone()[0]
    db.execute(
        "insert into auction_extractions(source_url, provider, result, updated_at) "
        "values (%s, 'pdf_text', '[]', now() - interval '2 days')",
        (url,),
    )
    if status is not None:
        db.execute(
            """insert into auction_document_readings(sale_id, source_url, input_fingerprint, prompt_version,
            status, attempt_count, generated_at, updated_at)
            values (%s, %s, 'f', %s, %s, %s, now() - make_interval(secs => %s), now())""",
            (sale_id, url, version, status, attempts, generated_hours_ago * 3600),
        )


def candidates(db) -> dict[str, tuple[object, object, object]]:
    rows = db.execute(reading.CANDIDATES_SQL, (reading.DOCUMENT_READING_VERSION, 100)).fetchall()
    return {row[1]: (row[4], row[5], row[6]) for row in rows}


def test_failed_readings_come_back_only_when_their_backoff_has_elapsed():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            setup(db)
            add_sale(db, "new", status=None)
            add_sale(db, "first-due", status="failed", attempts=1, generated_hours_ago=13)
            add_sale(db, "first-waiting", status="failed", attempts=1, generated_hours_ago=11)
            add_sale(db, "second-waiting", status="failed", attempts=2, generated_hours_ago=13)
            add_sale(db, "second-due", status="failed", attempts=2, generated_hours_ago=25)
            add_sale(db, "third-waiting", status="failed", attempts=3, generated_hours_ago=71)
            add_sale(db, "third-due", status="failed", attempts=3, generated_hours_ago=73)
            add_sale(db, "abandoned", status="failed", attempts=4, generated_hours_ago=1000)
            add_sale(db, "legacy-failed", status="failed", attempts=0, generated_hours_ago=13)
            add_sale(db, "completed", status="completed", generated_hours_ago=1000)
            add_sale(db, "old-version", status="completed", version="document_reading_v1")

            found = candidates(db)

            assert set(found) == {"new", "first-due", "second-due", "third-due", "legacy-failed", "old-version"}
            assert found["new"] == (None, 0, False)
            assert found["first-due"] == ("failed", 1, True)
            assert found["second-due"] == ("failed", 2, True)
            assert found["third-due"] == ("failed", 3, True)
            assert found["legacy-failed"] == ("failed", 0, True)
            assert found["old-version"] == ("completed", 0, False)
        finally:
            db.rollback()


def test_upsert_stores_and_resets_the_attempt_count():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            setup(db)
            sale_id = db.execute("insert into auction_sales(source_url) values ('s') returning id").fetchone()[0]

            def upsert(status: str, error_code: str | None, attempts: int) -> None:
                db.execute(
                    reading.UPSERT_SQL,
                    (sale_id, "s", "f", "v", None, status, "[]", "[]", False, error_code, attempts),
                )

            def stored():
                return db.execute(
                    "select status, error_code, attempt_count from auction_document_readings where sale_id=%s",
                    (sale_id,),
                ).fetchone()

            upsert("failed", "RuntimeError", 1)
            assert stored() == ("failed", "RuntimeError", 1)
            upsert("failed", reading.abandoned_error_code("RuntimeError"), 4)
            assert stored() == ("failed", "READING_ABANDONED_AFTER_4_ATTEMPTS:RuntimeError", 4)
            upsert("completed", None, 0)
            assert stored() == ("completed", None, 0)
            with pytest.raises(Exception, match="attempt_count"):
                upsert("failed", "x", -1)
        finally:
            db.rollback()
