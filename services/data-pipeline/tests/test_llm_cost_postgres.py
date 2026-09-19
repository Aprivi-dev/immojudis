"""PostgreSQL integration tests for LLM request reservations and durable cache.

These tests create a disposable database on the explicitly local PostgreSQL
instance.  They never connect to a hosted Supabase database and do not reuse
the root database for application objects.
"""

from __future__ import annotations

import hashlib
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[3]
BUDGET_MIGRATION = next((ROOT / "supabase/migrations").glob("*_llm_request_budget.sql"))
CACHE_MIGRATION = next((ROOT / "supabase/migrations").glob("*_llm_analysis_cache.sql"))
DAILY_BUDGET_MIGRATION = ROOT / "supabase/migrations/20260912125514_pipeline_usage_budget.sql"
LLM_USAGE_MIGRATION = ROOT / "supabase/migrations/20260916143341_llm_usage_tracking_and_queue_guards.sql"
LLM_TOKEN_MIGRATION = ROOT / "supabase/migrations/20260916144149_add_llm_token_estimates.sql"
LOCAL_TEST_HOSTS = {"127.0.0.1", "localhost"}
PINNED_MODEL = (
    "zsxkib/qwen2-7b-instruct:"
    "5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4"
)


def _migration(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _test_root_dsn() -> str:
    dsn = os.getenv("LLM_TEST_DATABASE_URL") or os.getenv("PIPELINE_TEST_DB_URL")
    if not dsn:
        pytest.skip("Set LLM_TEST_DATABASE_URL to the disposable local PostgreSQL root")
    info = conninfo_to_dict(dsn)
    host = str(info.get("host") or "").split(",", 1)[0]
    if host not in LOCAL_TEST_HOSTS:
        pytest.fail(
            "Refusing non-local LLM integration database; expected a localhost PostgreSQL instance, "
            f"got {host}"
        )
    return dsn


def _role_exists(db: psycopg.Connection, role: str) -> bool:
    return bool(db.execute("select exists(select 1 from pg_roles where rolname=%s)", (role,)).fetchone()[0])


def _set_role(db: psycopg.Connection, role: str) -> None:
    db.execute(sql.SQL("set role {}").format(sql.Identifier(role)))


def _create_support_schema(db: psycopg.Connection) -> None:
    """Create only the historical objects needed by the daily-budget migration."""

    db.execute("create extension if not exists pgcrypto")
    db.execute(
        """
        create table public.auction_runs (
          id uuid primary key default gen_random_uuid(),
          status text not null default 'running',
          scheduler_owned boolean not null default false,
          created_at timestamptz not null default now(),
          summary jsonb not null default '{}'
        )
        """
    )
    db.execute(
        """
        create table public.auction_pipeline_control (
          id boolean primary key default true check (id)
        )
        """
    )
    db.execute("insert into public.auction_pipeline_control(id) values (true)")


def _service_call(db_url: str, query: str, parameters: tuple[object, ...] = ()) -> object:
    with psycopg.connect(db_url, autocommit=True, prepare_threshold=None) as db:
        _set_role(db, "service_role")
        return db.execute(query, parameters).fetchone()[0]


def _reservation_parameters(*, job_id: str, source_url: str, attempt: int = 1, cap: int = 20) -> tuple[object, ...]:
    return (
        "replicate",
        PINNED_MODEL,
        "fact_extraction",
        attempt,
        cap,
        hashlib.sha256(f"{job_id}:{source_url}:{attempt}".encode()).hexdigest(),
        str(uuid4()),
        job_id,
        source_url,
        "facts",
        "cache_miss",
    )


@pytest.fixture(scope="session")
def llm_database(tmp_path_factory: pytest.TempPathFactory) -> str:
    del tmp_path_factory  # The fixture owns a server-side temporary database.
    root_dsn = _test_root_dsn()
    database_name = f"immojudis_llm_test_{os.getpid()}_{uuid4().hex[:10]}"
    database_dsn = make_conninfo(root_dsn, dbname=database_name)
    created_roles: list[str] = []

    with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
        for role in ("anon", "authenticated", "service_role"):
            if not _role_exists(root_db, role):
                role_sql = "create role {} nologin bypassrls" if role == "service_role" else "create role {} nologin"
                root_db.execute(sql.SQL(role_sql).format(sql.Identifier(role)))
                created_roles.append(role)
        root_db.execute(sql.SQL("create database {}").format(sql.Identifier(database_name)))

    try:
        with psycopg.connect(database_dsn, autocommit=True, prepare_threshold=None) as db:
            _create_support_schema(db)
            db.execute(_migration(DAILY_BUDGET_MIGRATION))
            db.execute(_migration(LLM_USAGE_MIGRATION))
            db.execute(_migration(LLM_TOKEN_MIGRATION))
            db.execute("grant all on public.auction_runs, public.auction_pipeline_control to service_role")

            # Establish a known pre-existing daily-budget reservation before
            # applying the new migrations. The new budget must leave it intact.
            db.execute("update public.auction_pipeline_control set max_ai_predictions_per_run=40, daily_ai_budget_usd=5")
            with db.transaction():
                _set_role(db, "service_role")
                run_id = db.execute(
                    "insert into public.auction_runs(status,scheduler_owned) values ('running',true) returning id"
                ).fetchone()[0]
                db.execute(
                    "select public.reserve_pipeline_prediction(%s,%s)",
                    (run_id, PINNED_MODEL),
                )
                db.execute("reset role")

            db.execute(_migration(BUDGET_MIGRATION))
            db.execute(_migration(CACHE_MIGRATION))

        yield database_dsn
    finally:
        # All worker connections are closed by the tests before teardown.
        with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
            root_db.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(database_name)))
            for role in created_roles:
                root_db.execute(sql.SQL("drop role if exists {}").format(sql.Identifier(role)))


@pytest.fixture(autouse=True)
def clean_llm_rows(llm_database: str):
    with psycopg.connect(llm_database, autocommit=True, prepare_threshold=None) as db:
        db.execute("truncate public.llm_usage_events, public.llm_analysis_cache")


def test_concurrent_reservations_never_exceed_hourly_cap(llm_database: str) -> None:
    worker_count = 12
    cap = 3
    barrier = Barrier(worker_count)

    def reserve(worker: int) -> tuple[str, str]:
        parameters = _reservation_parameters(
            job_id=str(uuid4()),
            source_url=f"https://example.test/llm-cost/{worker}",
            cap=cap,
        )
        try:
            barrier.wait(timeout=10)
            reservation = _service_call(
                llm_database,
                "select public.reserve_llm_request(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                parameters,
            )
            return "reserved", str(reservation)
        except Exception as exc:  # psycopg exposes a backend exception per rejected reservation.
            return "rejected", str(exc)

    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        outcomes = list(pool.map(reserve, range(worker_count)))

    reserved = [value for status, value in outcomes if status == "reserved"]
    rejected = [value for status, value in outcomes if status == "rejected"]
    assert len(reserved) == cap, outcomes
    assert len(set(reserved)) == cap, outcomes
    assert len(rejected) == worker_count - cap, outcomes
    assert all(re.search(r"budget|hourly|limit|exceed", message, flags=re.I) for message in rejected), outcomes

    with psycopg.connect(llm_database, autocommit=True) as db:
        assert db.execute("select count(*) from public.llm_usage_events").fetchone()[0] == cap


def test_reservation_logical_key_is_idempotent(llm_database: str) -> None:
    job_id = str(uuid4())
    parameters = _reservation_parameters(
        job_id=job_id,
        source_url="https://example.test/llm-cost/idempotent",
        cap=20,
    )
    first = str(
        _service_call(
            llm_database,
            "select public.reserve_llm_request(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            parameters,
        )
    )
    assert first
    with pytest.raises(psycopg.errors.RaiseException, match="Unresolved LLM request key"):
        _service_call(
            llm_database,
            "select public.reserve_llm_request(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            parameters,
        )
    with psycopg.connect(llm_database, autocommit=True) as db:
        assert db.execute("select count(*) from public.llm_usage_events").fetchone()[0] == 1


def test_anon_and_authenticated_have_no_budget_or_cache_access(llm_database: str) -> None:
    with psycopg.connect(llm_database, autocommit=True) as db:
        for role in ("anon", "authenticated"):
            for table in ("public.llm_usage_events", "public.llm_analysis_cache"):
                assert db.execute("select has_table_privilege(%s,%s,'select')", (role, table)).fetchone()[0] is False
                assert db.execute("select has_table_privilege(%s,%s,'insert')", (role, table)).fetchone()[0] is False

            function_privileges = db.execute(
                """
                select p.proname, has_function_privilege(%s,p.oid,'execute')
                from pg_proc p
                join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname in ('reserve_llm_request','finalize_llm_request')
                """,
                (role,),
            ).fetchall()
            assert function_privileges
            assert all(granted is False for _, granted in function_privileges)

        _set_role(db, "anon")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute("select * from public.llm_analysis_cache")
        db.execute("reset role")


def test_service_role_can_write_and_read_cache_and_stage_is_part_of_key(llm_database: str) -> None:
    cache_key = hashlib.sha256(b"same source content").hexdigest()
    other_key = hashlib.sha256(b"different source content").hexdigest()
    with psycopg.connect(llm_database, autocommit=True, prepare_threshold=None) as db:
        _set_role(db, "service_role")
        db.execute(
            "insert into public.llm_analysis_cache(cache_key,stage,result,model) values (%s,%s,%s,%s)",
            (cache_key, "facts", Jsonb({"surface_m2": 80}), "qwen-test"),
        )
        db.execute(
            "insert into public.llm_analysis_cache(cache_key,stage,result,model) values (%s,%s,%s,%s)",
            (cache_key, "display", Jsonb({"description": "Maison"}), "qwen-test"),
        )
        db.execute(
            "insert into public.llm_analysis_cache(cache_key,stage,result,model) values (%s,%s,%s,%s)",
            (other_key, "facts", Jsonb({"surface_m2": 90}), "qwen-test"),
        )
        rows = db.execute(
            "select cache_key,stage,result from public.llm_analysis_cache order by cache_key,stage"
        ).fetchall()
        assert len(rows) == 3
        assert db.execute(
            "select result from public.llm_analysis_cache where cache_key=%s and stage='display'",
            (cache_key,),
        ).fetchone()[0] == {"description": "Maison"}
        with pytest.raises(psycopg.errors.UniqueViolation):
            db.execute(
                "insert into public.llm_analysis_cache(cache_key,stage,result,model) values (%s,%s,%s,%s)",
                (cache_key, "facts", Jsonb({"surface_m2": 81}), "qwen-test"),
            )


def test_daily_prediction_budget_survives_new_llm_migrations(llm_database: str) -> None:
    with psycopg.connect(llm_database, autocommit=True, prepare_threshold=None) as db:
        assert db.execute(
            "select max_ai_predictions_per_run,daily_ai_budget_usd from public.auction_pipeline_control where id"
        ).fetchone() == (40, 5)
        assert db.execute("select count(*) from public.auction_pipeline_usage").fetchone()[0] == 1
        assert db.execute(
            "select exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname='reserve_pipeline_prediction')"
        ).fetchone()[0] is True

        _set_role(db, "service_role")
        run_id = db.execute(
            "insert into public.auction_runs(status,scheduler_owned) values ('running',true) returning id"
        ).fetchone()[0]
        reservation = db.execute(
            "select public.reserve_pipeline_prediction(%s,%s)",
            (run_id, PINNED_MODEL),
        ).fetchone()[0]
        assert reservation is not None
        db.execute("reset role")
        assert db.execute("select count(*) from public.auction_pipeline_usage").fetchone()[0] == 2
