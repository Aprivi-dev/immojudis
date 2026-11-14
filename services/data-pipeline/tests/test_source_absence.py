"""Ventes disparues de leur source : appel pipeline, garde-fous côté Python et comptage des inventaires."""

from __future__ import annotations

import os
from contextlib import nullcontext
from pathlib import Path

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
        self.state_updates: list[tuple] = []

    def execute(self, sql, params=None):
        if "update public.auction_source_state set" in sql:
            self.state_updates.append(params)
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
    monkeypatch.setattr(autonomous_runner, "record_source_presence", lambda *a, **k: None)

    def fake_withdraw(db_url, source, connect=None):
        calls.append((db_url, source))
        return {"action": "withdrawn", "withdrawn": 1}

    monkeypatch.setattr(autonomous_runner, "withdraw_missing_sales", fake_withdraw)
    autonomous_runner.finish_source("db", "run-1", connect=lambda url: nullcontext(db))


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


# --- Ventes à venir sans date non revues (14/11/2026, D13) ---------------------------------------------------------

UNSEEN_MIGRATION = (
    Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "20261119101020_mark_unseen_undated_sales.sql"
)


def _unseen_function_sql() -> str:
    """The function definition of the migration, without its transaction (to run inside a test transaction)."""
    text = UNSEEN_MIGRATION.read_text(encoding="utf-8")
    start = text.index("create or replace function app_private.mark_unseen_undated_sales(")
    end = text.index("$function$;", start) + len("$function$;")
    return text[start:end]


def test_undated_upcoming_sales_unseen_for_fourteen_days_go_through_the_sql_function() -> None:
    db = _FakeDb(result={"action": "marked", "marked": 2})

    result = source_absence.mark_unseen_undated_sales("db", "notaires", connect=_connect(db))

    assert result == {"action": "marked", "marked": 2}
    assert db.calls[-1] == ("select app_private.mark_unseen_undated_sales(%s, true)", ("notaires",))
    assert db.calls[0][1] == (source_absence.UNSEEN_FUNCTION,)


def test_the_undated_sweep_never_raises_into_the_run_closing() -> None:
    assert source_absence.mark_unseen_undated_sales("db", "notaires", connect=_connect(_FakeDb(fail=True))) is None
    assert source_absence.mark_unseen_undated_sales("db", "notaires", connect=_connect(_FakeDb(deployed=False))) is None
    assert source_absence.mark_unseen_undated_sales("", "notaires") is None


def test_the_sql_function_keeps_the_python_constants() -> None:
    text = UNSEEN_MIGRATION.read_text(encoding="utf-8")
    assert f"c_unseen_days constant integer := {source_absence.UNSEEN_UNDATED_DAYS};" in text
    assert source_absence.UNSEEN_UNDATED_DAYS == 14
    assert f"c_max_share constant numeric := {source_absence.MAX_WITHDRAWN_SHARE};" in text
    assert f"c_min_marks constant integer := {source_absence.MIN_WITHDRAWALS};" in text
    # Twice the « not seen again » threshold of the health report.
    health = (Path(__file__).resolve().parents[1] / "src" / "pipeline_health.py").read_text(encoding="utf-8")
    assert "last_seen_at < now() - interval '7 days'" in health


def test_a_blocked_undated_sweep_is_flagged_in_the_job_log(capsys) -> None:
    source_absence.report_unseen_undated("notaires", {"action": "blocked", "candidates": 9, "population": 40})

    out = capsys.readouterr().out
    assert "Ventes non revues bloquées" in out and "9 of 40" in out


class _DisabledDb(_FakeDb):
    def __init__(self, disabled: list[str], **kwargs):
        super().__init__(**kwargs)
        self.disabled = disabled

    def execute(self, sql, params=None):
        if "where not enabled" in sql:
            self.calls.append((sql, params))
            return _FetchAll([(name,) for name in self.disabled])
        return super().execute(sql, params)


def test_every_disabled_source_is_swept_without_an_inventory() -> None:
    db = _DisabledDb(["avoventes", "encheres_publiques"], result={"action": "marked", "marked": 1})

    results = source_absence.mark_unseen_undated_sales_of_disabled_sources("db", connect=_connect(db))

    assert len(results) == 2
    calls = [params for sql, params in db.calls if sql.startswith("select app_private.mark_unseen_undated_sales")]
    assert calls == [("avoventes",), ("encheres_publiques",)]


def _finish_with_sweeps(monkeypatch, *, status, coverage) -> tuple[list[str], list[str], list[dict]]:
    swept: list[str] = []
    disabled_sweeps: list[str] = []
    summaries: list[dict] = []

    class Db(_FinishDb):
        def execute(self, sql, params=None):
            if "summary=coalesce(summary,'{}') || %s" in sql and "unseen_undated" in str(params):
                summaries.append(params[0].obj)
            return super().execute(sql, params)

    def sweep(db_url, source, connect=None):
        swept.append(source)
        return {"action": "marked", "marked": 2}

    def sweep_disabled(db_url, connect=None):
        disabled_sweeps.append(db_url)
        return [{"source": "encheres_publiques", "action": "marked", "marked": 1}]

    monkeypatch.setattr(autonomous_runner, "mark_unseen_undated_sales", sweep)
    monkeypatch.setattr(autonomous_runner, "mark_unseen_undated_sales_of_disabled_sources", sweep_disabled)
    _finish(monkeypatch, Db(status=status, coverage=coverage), [])
    return swept, disabled_sweeps, summaries


def test_finish_source_sweeps_its_undated_sales_only_after_a_complete_inventory(monkeypatch) -> None:
    swept, disabled, summaries = _finish_with_sweeps(
        monkeypatch, status="succeeded", coverage={"coverage_complete": True, "listings_emitted": 5}
    )

    assert swept == ["vench"] and disabled == ["db"]
    assert {"unseen_undated_sales": {"action": "marked", "marked": 2}} in summaries
    assert {"unseen_undated_disabled_sources": [{"source": "encheres_publiques", "action": "marked", "marked": 1}]} in (
        summaries
    )


@pytest.mark.parametrize(
    ("status", "coverage"),
    [
        ("succeeded", {"coverage_complete": False, "listings_emitted": 5}),
        ("failed", {"coverage_complete": True, "listings_emitted": 5}),
        ("succeeded", {"coverage_complete": True, "listings_emitted": 5, "access_denials": 2}),
    ],
)
def test_a_partial_failed_or_refused_inventory_sweeps_only_the_disabled_sources(monkeypatch, status, coverage) -> None:
    swept, disabled, _ = _finish_with_sweeps(monkeypatch, status=status, coverage=coverage)

    assert swept == [] and disabled == ["db"]


def _unseen_schema(db) -> None:
    db.execute("create schema if not exists app_private")
    db.execute(
        """create table public.auction_source_state(
             source_name text primary key, enabled boolean not null, last_inventory_complete_at timestamptz)"""
    )
    db.execute(
        """create table public.auction_sales(
             id uuid primary key, source_name text, status text, sale_date timestamptz,
             last_seen_at timestamptz, updated_at timestamptz, raw_payload jsonb)"""
    )
    db.execute("create table public.pgtest_alerts(alert_key text, active boolean, details jsonb)")
    db.execute(
        """create or replace function app_private.auction_sale_is_publicly_visible(uuid) returns boolean
           language sql as $$ select true $$"""
    )
    db.execute(
        """create or replace function app_private.sync_operational_alert(
             p_alert_key text, p_category text, p_severity text, p_details jsonb, p_active boolean,
             p_now timestamptz default statement_timestamp()) returns void
           language sql as $$ insert into public.pgtest_alerts values (p_alert_key, p_active, p_details) $$"""
    )
    db.execute(_unseen_function_sql())


def test_the_undated_sweep_marks_only_old_undated_upcoming_sales_of_the_source() -> None:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            _unseen_schema(db)
            db.execute(
                """insert into public.auction_source_state values
                   ('notaires', true, now() - interval '10 minutes'),
                   ('licitor', true, now() - interval '3 hours'),
                   ('encheres_publiques', false, null)"""
            )
            sales = [
                ("20", "notaires", "upcoming", None, "20 days"),
                ("21", "notaires", "upcoming", None, "13 days"),  # seen 13 days ago
                ("22", "notaires", "upcoming", "9 days", "20 days"),  # dated: its date ends it
                ("23", "notaires", "postponed", None, "20 days"),
                ("24", "licitor", "upcoming", None, "20 days"),  # its last complete inventory is 3 hours old
                ("25", "encheres_publiques", "upcoming", None, "20 days"),  # disabled source: no inventory needed
            ]
            sales += [(str(30 + n), "notaires", "upcoming", "9 days", "1 day") for n in range(6)]  # population
            for suffix, source, status, sale_in, unseen in sales:
                db.execute(
                    """insert into public.auction_sales(id, source_name, status, sale_date, last_seen_at, raw_payload)
                       values (%s::uuid, %s, %s, now() + %s::interval, now() - %s::interval, '{"source_blocks": {}}')""",
                    (f"42800000-0000-4000-8000-0000000000{suffix}", source, status, sale_in, unseen),
                )

            def sweep(source: str) -> dict:
                return source_absence.mark_unseen_undated_sales(url, source, connect=lambda _url: nullcontext(db))

            assert sweep("notaires")["marked"] == 1
            assert sweep("licitor")["reason"] == "no_recent_complete_inventory"
            assert sweep("encheres_publiques")["marked"] == 1
            rows = dict(db.execute("select right(id::text, 2), status from public.auction_sales").fetchall())
            assert {key: rows[key] for key in ("20", "21", "22", "23", "24", "25")} == {
                "20": "unknown", "21": "upcoming", "22": "upcoming", "23": "postponed", "24": "upcoming",
                "25": "unknown",
            }
            trace = db.execute(
                "select raw_payload from public.auction_sales where id = '42800000-0000-4000-8000-000000000020'"
            ).fetchone()[0]
            assert trace["source_blocks"] == {} and trace["unseen_undated"]["status_before"] == "upcoming"
            assert trace["unseen_undated"]["unseen_days"] == 14

            # Cap of the withdrawal: more than 15 % of the visible sales at once (at least one) is refused, and alerted.
            db.execute(
                "update public.auction_sales set status = 'upcoming', sale_date = null, last_seen_at = now() - "
                "interval '20 days' where source_name = 'notaires' and status <> 'postponed'"
            )
            blocked = sweep("notaires")
            assert blocked["action"] == "blocked"
            assert db.execute(
                "select count(*) from public.auction_sales where source_name = 'notaires' and status = 'unknown'"
            ).fetchone()[0] == 0
            assert db.execute(
                "select active from public.pgtest_alerts where alert_key = 'catalogue.unseen_undated.notaires'"
                " order by ctid desc limit 1"
            ).fetchone()[0] is True
        finally:
            db.rollback()


@pytest.mark.parametrize(
    ("status", "coverage", "inventory_complete"),
    [
        ("succeeded", {"coverage_complete": True, "listings_emitted": 5}, True),
        # Un run en échec dont la couverture se dit complète ne fait avancer ni le compteur d'absence ni la
        # date du dernier inventaire complet (qui autorise le retrait).
        ("failed", {"coverage_complete": True, "listings_emitted": 5}, False),
        ("succeeded", {"coverage_complete": False, "listings_emitted": 5}, False),
    ],
)
def test_finish_source_records_a_complete_inventory_only_for_a_succeeded_run(
    monkeypatch, status, coverage, inventory_complete
) -> None:
    presence: list[tuple] = []
    db = _FinishDb(status=status, coverage=coverage)
    monkeypatch.setattr(autonomous_runner, "record_source_presence", lambda *args: presence.append(args[1:]))
    monkeypatch.setattr(autonomous_runner, "withdraw_missing_sales", lambda *args, **kwargs: None)

    autonomous_runner.finish_source("db", "run-1", connect=lambda url: nullcontext(db))

    assert [args[-1] for args in presence] == [inventory_complete]
    # Paramètres de la mise à jour de l'état : ..., inventaire complet, publication complète, source, run.
    (params,) = db.state_updates
    assert params[-4] is inventory_complete


# --- compteur d'inventaires complets (PostgreSQL jetable) -------------------------------------------


def _presence_schema(db) -> None:
    db.execute("create schema if not exists app_private")
    db.execute(
        """create table public.auction_sales(
            id uuid primary key, source_url text not null, source_name text,
            observations jsonb not null default '[]'::jsonb)"""
    )
    db.execute("create table public.auction_collection_items(run_id text, source_url text, canonical_source_url text)")
    db.execute("create table public.auction_runs(id text primary key, started_at timestamptz, finished_at timestamptz)")
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


def _finished(db, run_id, ago):
    """Run clos il y a ``ago`` (intervalle SQL) : date du dernier inventaire compté pour l'écart minimal."""
    db.execute(
        "insert into public.auction_runs(id, started_at, finished_at) values (%s, now() - %s::interval, now() - %s::interval)"
        " on conflict (id) do update set started_at = excluded.started_at, finished_at = excluded.finished_at",
        (run_id, ago, ago),
    )


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
            _finished(db, "run-2", "30 minutes")
            record(db, "run-2", "vench", "available", True)
            assert _counter(db, sale_id) == ("absent", 1, True, "run-2")
            # Le même inventaire clos deux fois n'est compté qu'une fois.
            record(db, "run-2", "vench", "available", True)
            assert _counter(db, sale_id)[1] == 1

            # Un passage partiel ou en échec ne compte pas et ne remet rien à zéro.
            record(db, "run-3", "vench", "unavailable", False)
            assert _counter(db, sale_id)[0:2] == ("absent", 1)

            # Un deuxième inventaire complet 30 minutes après le précédent compté ne compte pas : il faut 12 h.
            record(db, "run-3b", "vench", "available", True)
            assert _counter(db, sale_id) == ("absent", 1, True, "run-2")

            # Le dernier inventaire compté date de 13 h : le suivant compte, deux, la vente peut être retirée.
            _finished(db, "run-2", "13 hours")
            record(db, "run-4", "vench", "available", True)
            assert _counter(db, sale_id) == ("absent", 2, True, "run-4")

            # Un inventaire de plus, trop proche du précédent compté, ne le fait pas avancer.
            _finished(db, "run-4", "2 hours")
            record(db, "run-4b", "vench", "available", True)
            assert _counter(db, sale_id)[0:2] == ("absent", 2)

            # Elle réapparaît : le compteur repart de zéro, sans attendre 12 h.
            db.execute("insert into public.auction_collection_items(run_id, source_url) values ('run-5', %s)", ("https://example.test/absence",))
            record(db, "run-5", "vench", "available", True)
            assert _counter(db, sale_id) == ("present", 0, False, None)
        finally:
            db.rollback()


def test_a_counter_set_before_the_run_column_waits_twelve_hours_from_absent_since() -> None:
    """Ligne reprise de la migration 20261028110100 (absent_inventories = 1, absent_since posé, pas de run)."""
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    recent, old = "42800000-0000-4000-8000-000000000002", "42800000-0000-4000-8000-000000000003"
    with _postgres_connect(url) as db:
        try:
            _presence_schema(db)
            for sale_id, source_url in ((recent, "https://example.test/recent"), (old, "https://example.test/old")):
                db.execute(
                    "insert into public.auction_sales(id, source_url, source_name) values (%s, %s, %s)",
                    (sale_id, source_url, "vench"),
                )
            db.execute(
                """insert into app_private.auction_sale_source_presence
                     (sale_id, source_name, availability, state, checked_at, run_id, absent_inventories, absent_since)
                   values (%s, 'vench', 'available', 'absent', now(), 'run-0', 1, now() - interval '30 minutes'),
                          (%s, 'vench', 'available', 'absent', now(), 'run-0', 1, now() - interval '13 hours')""",
                (recent, old),
            )

            autonomous_runner.record_source_presence(db, "run-1", "vench", "available", True)

            assert _counter(db, recent)[0:2] == ("absent", 1)
            assert _counter(db, old)[0:2] == ("absent", 2)
        finally:
            db.rollback()
