"""PostgreSQL integration tests for token-priced pipeline reservations.

The fixture creates a disposable database on an explicitly local PostgreSQL
instance.  It applies only the historical pipeline budget migration and the
new token-pricing migration, so the test never mutates a hosted Supabase
database or the developer's application database.
"""

from __future__ import annotations

import os
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

ROOT = Path(__file__).resolve().parents[3]
DAILY_BUDGET_MIGRATION = ROOT / "supabase/migrations/20260912125514_pipeline_usage_budget.sql"
TOKEN_PRICING_MIGRATION = ROOT / "supabase/migrations/20260921110000_pipeline_token_pricing.sql"

PINNED_MODEL = (
    "zsxkib/qwen2-7b-instruct:"
    "5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4"
)
QWEN_MODEL = "qwen/qwen3-7-plus"
GEMINI_MODEL = "google/gemini-2.5-flash"
BASELINE_RUN_ID = UUID("f9000000-0000-4000-8000-000000000001")
LOCAL_TEST_HOSTS = {"127.0.0.1", "localhost", "::1"}


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
            "Refusing non-local pipeline budget integration database; expected localhost, "
            f"got {host}"
        )
    return dsn


def _role_exists(db: psycopg.Connection, role: str) -> bool:
    return bool(db.execute("select exists(select 1 from pg_roles where rolname=%s)", (role,)).fetchone()[0])


def _set_role(db: psycopg.Connection, role: str) -> None:
    db.execute(sql.SQL("set role {}").format(sql.Identifier(role)))


def _create_support_schema(db: psycopg.Connection) -> None:
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


def _service_call(database_dsn: str, query: str, parameters: tuple[object, ...] = ()) -> object:
    with psycopg.connect(database_dsn, autocommit=True, prepare_threshold=None) as db:
        _set_role(db, "service_role")
        return db.execute(query, parameters).fetchone()[0]


def _new_run(database_dsn: str) -> UUID:
    with psycopg.connect(database_dsn, autocommit=True, prepare_threshold=None) as db:
        return db.execute(
            "insert into public.auction_runs(status,scheduler_owned) values ('running',true) returning id"
        ).fetchone()[0]


@pytest.fixture(scope="session")
def token_pricing_database(tmp_path_factory: pytest.TempPathFactory) -> str:
    del tmp_path_factory
    root_dsn = _test_root_dsn()
    database_name = f"immojudis_token_pricing_{os.getpid()}_{uuid4().hex[:10]}"
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
            db.execute(
                "grant all on public.auction_runs, public.auction_pipeline_control, public.auction_pipeline_usage to service_role"
            )
            db.execute(
                "insert into public.auction_runs(id,status,scheduler_owned) values (%s,'running',true)",
                (BASELINE_RUN_ID,),
            )
            baseline_reservation = _service_call(
                database_dsn,
                "select public.reserve_pipeline_prediction(%s,%s)",
                (BASELINE_RUN_ID, PINNED_MODEL),
            )
            db.execute(
                "update public.auction_pipeline_usage set created_at=now()-interval '1 day' where id=%s",
                (baseline_reservation,),
            )
            db.execute(_migration(TOKEN_PRICING_MIGRATION))

        yield database_dsn
    finally:
        with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
            root_db.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(database_name)))
            for role in created_roles:
                root_db.execute(sql.SQL("drop role if exists {}").format(sql.Identifier(role)))


@pytest.fixture(autouse=True)
def clean_token_pricing_rows(token_pricing_database: str):
    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        db.execute("delete from public.auction_pipeline_usage where run_id <> %s", (BASELINE_RUN_ID,))
        db.execute("delete from public.auction_runs where id <> %s", (BASELINE_RUN_ID,))
        db.execute("update public.auction_pipeline_control set max_ai_predictions_per_run=40, daily_ai_budget_usd=5 where id")


def test_token_models_reserve_priced_ceilings_and_keep_legacy_reservation_unchanged(
    token_pricing_database: str,
) -> None:
    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        baseline_before = db.execute(
            "select model,status,reserved_usd,rate_source,created_at from public.auction_pipeline_usage where run_id=%s",
            (BASELINE_RUN_ID,),
        ).fetchone()

    qwen_run = _new_run(token_pricing_database)
    gemini_run = _new_run(token_pricing_database)
    qwen_reservation = _service_call(
        token_pricing_database,
        "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
        (qwen_run, QWEN_MODEL, 1000, 500),
    )
    gemini_reservation = _service_call(
        token_pricing_database,
        "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
        (gemini_run, GEMINI_MODEL, 1000, 500),
    )

    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        qwen_row = db.execute(
            "select model,reserved_usd,rate_source from public.auction_pipeline_usage where id=%s",
            (qwen_reservation,),
        ).fetchone()
        gemini_row = db.execute(
            "select model,reserved_usd,rate_source from public.auction_pipeline_usage where id=%s",
            (gemini_reservation,),
        ).fetchone()
        baseline_after = db.execute(
            "select model,status,reserved_usd,rate_source,created_at from public.auction_pipeline_usage where run_id=%s",
            (BASELINE_RUN_ID,),
        ).fetchone()

    assert qwen_row == (
        QWEN_MODEL,
        Decimal("0.0008265"),
        "https://replicate.com/qwen/qwen3-7-plus; checked 2026-09-21",
    )
    assert gemini_row == (
        GEMINI_MODEL,
        Decimal("0.00155"),
        "https://replicate.com/google/gemini-2.5-flash; checked 2026-09-21",
    )
    assert baseline_after == baseline_before


def test_four_argument_legacy_model_delegates_to_two_argument_reservation(
    token_pricing_database: str,
) -> None:
    run_id = _new_run(token_pricing_database)
    reservation = _service_call(
        token_pricing_database,
        "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
        (run_id, PINNED_MODEL, None, None),
    )
    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        assert db.execute(
            "select model,reserved_usd,rate_source from public.auction_pipeline_usage where id=%s",
            (reservation,),
        ).fetchone() == (PINNED_MODEL, Decimal("0.2925"), None)


@pytest.mark.parametrize(
    ("model", "input_ceiling", "output_ceiling", "message"),
    [
        ("unknown/provider-model", 1, 1, "no configured cost reservation"),
        (QWEN_MODEL, None, 1, "Input token ceiling"),
        (QWEN_MODEL, 0, 1, "Input token ceiling"),
        (QWEN_MODEL, 262145, 1, "Input token ceiling"),
        (QWEN_MODEL, 1, None, "Output token ceiling"),
        (QWEN_MODEL, 1, 0, "Output token ceiling"),
        (QWEN_MODEL, 1, 32769, "Output token ceiling"),
    ],
)
def test_unknown_and_unbounded_token_reservations_are_rejected(
    token_pricing_database: str,
    model: str,
    input_ceiling: int | None,
    output_ceiling: int | None,
    message: str,
) -> None:
    run_id = _new_run(token_pricing_database)
    with pytest.raises(psycopg.Error, match=message) as error:
        _service_call(
            token_pricing_database,
            "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
            (run_id, model, input_ceiling, output_ceiling),
        )
    assert error.value.sqlstate == ("P0001" if model.startswith("unknown/") else "22023")

    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        assert db.execute(
            "select count(*) from public.auction_pipeline_usage where run_id=%s",
            (run_id,),
        ).fetchone()[0] == 0


def test_daily_and_per_run_caps_apply_to_token_reservations(token_pricing_database: str) -> None:
    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        db.execute(
            "update public.auction_pipeline_control "
            "set max_ai_predictions_per_run=40, daily_ai_budget_usd=0.0008265 where id"
        )

    run_id = _new_run(token_pricing_database)
    first = _service_call(
        token_pricing_database,
        "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
        (run_id, QWEN_MODEL, 1000, 500),
    )
    assert first

    with pytest.raises(psycopg.errors.RaiseException, match="Daily AI budget exhausted"):
        _service_call(
            token_pricing_database,
            "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
            (run_id, QWEN_MODEL, 1, 1),
        )

    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        db.execute(
            "update public.auction_pipeline_control "
            "set max_ai_predictions_per_run=1, daily_ai_budget_usd=5 where id"
        )

    with pytest.raises(psycopg.errors.RaiseException, match="AI prediction budget exhausted"):
        _service_call(
            token_pricing_database,
            "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
            (run_id, GEMINI_MODEL, 1, 1),
        )


def test_new_overload_is_service_role_only_invoker_with_empty_search_path(
    token_pricing_database: str,
) -> None:
    signature = "public.reserve_pipeline_prediction(uuid,text,integer,integer)"
    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        privileges = db.execute(
            "select has_function_privilege(%s,%s,'EXECUTE')",
            ("service_role", signature),
        ).fetchone()[0]
        assert privileges is True
        for role in ("anon", "authenticated"):
            assert db.execute(
                "select has_function_privilege(%s,%s,'EXECUTE')",
                (role, signature),
            ).fetchone()[0] is False

        prosecdef, proconfig = db.execute(
            "select prosecdef,proconfig from pg_proc where oid=%s::regprocedure",
            (signature,),
        ).fetchone()

    assert prosecdef is False
    assert any(value in {"search_path=", 'search_path=""'} for value in (proconfig or []))


def test_usage_summary_lists_all_rate_sources(token_pricing_database: str) -> None:
    run_id = _new_run(token_pricing_database)
    _service_call(
        token_pricing_database,
        "select public.reserve_pipeline_prediction(%s,%s,%s,%s)",
        (run_id, QWEN_MODEL, 1, 1),
    )
    with psycopg.connect(token_pricing_database, autocommit=True, prepare_threshold=None) as db:
        _set_role(db, "service_role")
        summary = db.execute("select public.pipeline_usage_summary()").fetchone()[0]

    assert "qwen/qwen3-7-plus" in summary["rate_source"]
    assert "google/gemini-2.5-flash" in summary["rate_source"]
    assert "0.276 USD/M" in summary["rate_source"]
    assert "2.50 USD/M" in summary["rate_source"]
