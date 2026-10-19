"""Ventes disparues de leur source : appel pipeline, garde-fous côté Python et comptage des inventaires."""

from __future__ import annotations

import os
from contextlib import nullcontext

import pytest

from src import autonomous_runner, source_absence
from src.storage.supabase_client import _postgres_connect


class _Result:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class _FakeDb:
    def __init__(self, *, deployed=True, result=None, fail=False):
        self.deployed = deployed
        self.result = result if result is not None else {"action": "withdrawn", "withdrawn": 2}
        self.fail = fail
        self.calls: list[tuple[str, object]] = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if "to_regprocedure" in sql:
            return _Result((source_absence.FUNCTION if self.deployed else None,))
        if self.fail:
            raise RuntimeError("boom")
        return _Result((self.result,))


def _connect(db):
    return lambda url: nullcontext(db)


def test_the_withdrawal_is_called_for_the_source_and_reported() -> None:
    db = _FakeDb()

    result = source_absence.withdraw_missing_sales("db", "vench", connect=_connect(db))

    assert result == {"action": "withdrawn", "withdrawn": 2}
    assert db.calls[-1] == ("select app_private.withdraw_missing_source_sales(%s, true)", ("vench",))


def test_a_database_without_the_migration_does_nothing() -> None:
    db = _FakeDb(deployed=False)

    assert source_absence.withdraw_missing_sales("db", "vench", connect=_connect(db)) is None
    assert len(db.calls) == 1


def test_a_failure_never_raises_into_the_run_closing() -> None:
    assert source_absence.withdraw_missing_sales("db", "vench", connect=_connect(_FakeDb(fail=True))) is None

    def unreachable(url):
        raise OSError("down")

    assert source_absence.withdraw_missing_sales("db", "vench", connect=unreachable) is None
    assert source_absence.withdraw_missing_sales("", "vench") is None
    assert source_absence.withdraw_missing_sales("db", "") is None


def test_a_blocked_withdrawal_is_flagged_in_the_job_log(capsys) -> None:
    db = _FakeDb(result={"action": "blocked", "population": 20, "candidates": 6})

    result = source_absence.withdraw_missing_sales("db", "vench", connect=_connect(db))

    assert result is not None and result["action"] == "blocked"
    output = capsys.readouterr().out
    assert "::warning" in output and "6 of 20" in output and "15 %" in output


# --- finish_source : seulement après un inventaire complet réussi ----------------------------------


class _FinishDb:
    def __init__(self, *, status, coverage, errors=None):
        from datetime import UTC, datetime

        self.row = ("vench", status, {"scrape_coverage": {"vench": coverage}}, errors or {}, datetime.now(UTC))
        self.summaries: list[object] = []

    def execute(self, sql, params=None):
        if "select source,status,summary,errors,started_at" in sql:
            return _Result(self.row)
        if "select consecutive_failures" in sql:
            return _Result((0,))
        if "select decision,count(*)" in sql:
            return _FetchAll([("published", 5)])
        if "from public.auction_collection_items i" in sql:
            return _FetchAll([])
        if "summary=coalesce(summary,'{}') || %s" in sql and "source_absence" in str(params):
            self.summaries.append(params)
        return _Result(None)


class _FetchAll(_Result):
    def __init__(self, rows):
        super().__init__(None)
        self.rows = rows

    def fetchall(self):
        return self.rows


def _finish(monkeypatch, db, calls):
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda url: nullcontext(db))
    monkeypatch.setattr(autonomous_runner, "record_source_presence", lambda *a, **k: None)

    def fake_withdraw(db_url, source, connect=None):
        calls.append((db_url, source))
        return {"action": "withdrawn", "withdrawn": 1}

    monkeypatch.setattr(autonomous_runner, "withdraw_missing_sales", fake_withdraw)
    autonomous_runner.finish_source("db", "run-1")


def test_finish_source_withdraws_after_a_complete_successful_inventory(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []
    db = _FinishDb(status="succeeded", coverage={"coverage_complete": True, "listings_emitted": 5})

    _finish(monkeypatch, db, calls)

    assert calls == [("db", "vench")]
    assert db.summaries and "source_absence" in str(db.summaries[0])


@pytest.mark.parametrize(
    ("status", "coverage"),
    [
        ("succeeded", {"coverage_complete": False, "listings_emitted": 5}),
        ("succeeded", {"listings_emitted": 5}),
        ("failed", {"coverage_complete": True, "listings_emitted": 5}),
        ("succeeded", {"coverage_complete": True, "listings_emitted": 5, "access_denials": 2}),
    ],
)
def test_finish_source_never_withdraws_on_a_partial_failed_or_refused_inventory(monkeypatch, status, coverage) -> None:
    calls: list[tuple[str, str]] = []

    _finish(monkeypatch, _FinishDb(status=status, coverage=coverage), calls)

    assert calls == []


# --- compteur d'inventaires complets (PostgreSQL jetable) -------------------------------------------


def _presence_schema(db) -> None:
    db.execute("create schema if not exists app_private")
    db.execute(
        """create table public.auction_sales(
            id uuid primary key, source_url text not null, source_name text,
            observations jsonb not null default '[]'::jsonb)"""
    )
    db.execute("create table public.auction_collection_items(run_id text, source_url text, canonical_source_url text)")
    db.execute(
        """create table app_private.auction_sale_source_presence(
            sale_id uuid not null, source_name text not null,
            availability text not null, state text, attempted_at timestamptz,
            checked_at timestamptz, run_id text,
            legacy_raw boolean not null default false,
            absent_inventories integer not null default 0,
            absent_since timestamptz, absent_run_id text,
            primary key (sale_id, source_name))"""
    )
    db.execute("create view public.auction_sale_source_presence as select * from app_private.auction_sale_source_presence")
    db.execute(
        """create function app_private.auction_sale_source_presence_json(uuid)
            returns jsonb language sql immutable as $$ select '{}'::jsonb $$"""
    )


def _counter(db, sale_id):
    return db.execute(
        """select state, absent_inventories, absent_since is not null, absent_run_id
             from app_private.auction_sale_source_presence where sale_id = %s and source_name = 'vench'""",
        (sale_id,),
    ).fetchone()


def test_absent_inventories_count_complete_inventories_only_and_reset_when_the_sale_returns() -> None:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    sale_id = "42800000-0000-4000-8000-000000000001"
    with _postgres_connect(url) as db:
        try:
            _presence_schema(db)
            db.execute(
                "insert into public.auction_sales(id, source_url, source_name) values (%s, %s, %s)",
                (sale_id, "https://example.test/absence", "vench"),
            )
            record = autonomous_runner.record_source_presence

            # Vue dans l'inventaire 1.
            db.execute("insert into public.auction_collection_items(run_id, source_url) values ('run-1', %s)", ("https://example.test/absence",))
            record(db, "run-1", "vench", "available", True)
            assert _counter(db, sale_id) == ("present", 0, False, None)

            # Absente de l'inventaire complet 2 : un.
            record(db, "run-2", "vench", "available", True)
            assert _counter(db, sale_id) == ("absent", 1, True, "run-2")
            # Le même inventaire clos deux fois n'est compté qu'une fois.
            record(db, "run-2", "vench", "available", True)
            assert _counter(db, sale_id)[1] == 1

            # Un passage partiel ou en échec ne compte pas et ne remet rien à zéro.
            record(db, "run-3", "vench", "unavailable", False)
            assert _counter(db, sale_id)[0:2] == ("absent", 1)

            # Absente d'un deuxième inventaire complet : deux, la vente peut être retirée.
            record(db, "run-4", "vench", "available", True)
            assert _counter(db, sale_id)[0:2] == ("absent", 2)

            # Elle réapparaît : le compteur repart de zéro.
            db.execute("insert into public.auction_collection_items(run_id, source_url) values ('run-5', %s)", ("https://example.test/absence",))
            record(db, "run-5", "vench", "available", True)
            assert _counter(db, sale_id) == ("present", 0, False, None)
        finally:
            db.rollback()
