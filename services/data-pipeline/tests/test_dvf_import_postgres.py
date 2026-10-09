"""Atomic DVF replacement against a disposable local PostgreSQL database."""

from __future__ import annotations

import os
from datetime import date
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from src import dvf_import

LOCAL_TEST_HOSTS = {"127.0.0.1", "localhost"}

LIVE_SCHEMA = """
create table public.dvf_import_batches (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'DVF',
  source_url text,
  file_name text,
  period_start date,
  period_end date,
  status text not null default 'pending',
  imported_rows integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.dvf_transactions (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.dvf_import_batches(id) on delete set null,
  source text not null default 'DVF',
  source_mutation_id text not null,
  sale_date date not null,
  mutation_nature text,
  total_price_eur numeric not null check (total_price_eur > 0),
  built_surface_m2 numeric check (built_surface_m2 is null or built_surface_m2 > 0),
  land_surface_m2 numeric check (land_surface_m2 is null or land_surface_m2 >= 0),
  price_per_m2 numeric generated always as (
    case when total_price_eur > 0 and built_surface_m2 > 0
      then round(total_price_eur / built_surface_m2) else null end
  ) stored,
  property_type text,
  dvf_property_type_code text,
  rooms_count integer,
  lots_count integer,
  address text,
  city text,
  postal_code text,
  insee_code text,
  department text,
  parcel_id text,
  latitude double precision,
  longitude double precision
);
create unique index dvf_transactions_source_mutation_uidx
  on public.dvf_transactions (source, source_mutation_id);
create index dvf_transactions_sale_date_idx on public.dvf_transactions (sale_date desc);
create index dvf_transactions_department_sale_date_idx
  on public.dvf_transactions (department, sale_date desc);
create index dvf_transactions_lat_lng_idx on public.dvf_transactions (latitude, longitude)
  where latitude is not null and longitude is not null;
alter table public.dvf_transactions enable row level security;
revoke all on table public.dvf_transactions from anon, authenticated;
grant select, insert, update, delete on table public.dvf_transactions to service_role;
"""


def _root_dsn() -> str:
    dsn = os.getenv("PIPELINE_TEST_DB_URL")
    if not dsn:
        pytest.skip("Requires disposable PostgreSQL")
    host = str(conninfo_to_dict(dsn).get("host") or "").split(",", 1)[0]
    if host not in LOCAL_TEST_HOSTS:
        pytest.fail(f"Refusing non-local DVF integration database: {host}")
    return dsn


@pytest.fixture
def dvf_connection():
    root_dsn = _root_dsn()
    database_name = f"immojudis_dvf_test_{os.getpid()}_{uuid4().hex[:10]}"
    with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
        for role in ("anon", "authenticated", "service_role"):
            root_db.execute(
                sql.SQL(
                    "do $$ begin if not exists(select from pg_roles where rolname={name}) "
                    "then create role {ident}; end if; end $$"
                ).format(name=sql.Literal(role), ident=sql.Identifier(role))
            )
        root_db.execute(sql.SQL("create database {}").format(sql.Identifier(database_name)))
    database_dsn = make_conninfo(root_dsn, dbname=database_name)
    with psycopg.connect(database_dsn, autocommit=True, prepare_threshold=None) as setup_db:
        setup_db.execute(LIVE_SCHEMA)
    connection = psycopg.connect(database_dsn, prepare_threshold=None)
    try:
        yield connection
    finally:
        connection.close()
        with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
            root_db.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(database_name)))


def _row(mutation_id: str, price: int, batch_id: str | None = None) -> dict[str, object]:
    return {
        "import_batch_id": batch_id,
        "source": "DVF",
        "source_mutation_id": mutation_id,
        "sale_date": date(2025, 5, 1),
        "mutation_nature": "Vente",
        "total_price_eur": price,
        "built_surface_m2": 50,
        "department": "75",
        "property_type": "Appartement",
    }


def _seed_live(connection, ids: list[str]) -> None:
    with connection.cursor() as cursor:
        for mutation_id in ids:
            cursor.execute(
                "insert into public.dvf_transactions (source_mutation_id, sale_date, total_price_eur) "
                "values (%s, '2024-01-01', 100000)",
                (mutation_id,),
            )
    connection.commit()


def _live_ids(connection) -> list[str]:
    rows = connection.execute(
        "select source_mutation_id from public.dvf_transactions order by 1"
    ).fetchall()
    connection.rollback()
    return [row[0] for row in rows]


def _stage(connection, payload: list[dict[str, object]], *, reset: bool) -> None:
    dvf_import._prepare_staging_table(connection, reset=reset)
    dvf_import._copy_transactions(connection, payload)
    connection.commit()


def _relations(connection) -> set[str]:
    rows = connection.execute(
        "select relname from pg_class where relnamespace = 'public'::regnamespace"
    ).fetchall()
    connection.rollback()
    return {row[0] for row in rows}


def test_interrupted_import_leaves_live_table_untouched(dvf_connection) -> None:
    _seed_live(dvf_connection, ["old-1", "old-2"])
    batch_id = dvf_import._create_import_batch(
        dvf_connection, file_name="a.csv", source_url=None, metadata={}
    )
    dvf_connection.commit()
    _stage(dvf_connection, [_row("new-1", 200000, batch_id)], reset=True)
    # The second file never arrives, so the swap is never run.

    assert _live_ids(dvf_connection) == ["old-1", "old-2"]
    assert "dvf_transactions_staging" in _relations(dvf_connection)


def test_swap_replaces_live_table_in_one_step_and_keeps_its_contract(dvf_connection) -> None:
    _seed_live(dvf_connection, ["old-1", "old-2"])
    batch_id = dvf_import._create_import_batch(
        dvf_connection, file_name="a.csv", source_url=None, metadata={}
    )
    dvf_connection.commit()
    _stage(dvf_connection, [_row("new-1", 200000, batch_id)], reset=True)
    _stage(dvf_connection, [_row("new-2", 300000, batch_id)], reset=False)

    dvf_import.swap_staging_into_live(dvf_connection)

    assert _live_ids(dvf_connection) == ["new-1", "new-2"]
    relations = _relations(dvf_connection)
    assert "dvf_transactions_staging" not in relations
    assert "dvf_transactions_old" not in relations
    assert not [name for name in relations if name.endswith("_old") or "_staging" in name]
    assert {
        "dvf_transactions_pkey",
        "dvf_transactions_source_mutation_uidx",
        "dvf_transactions_sale_date_idx",
        "dvf_transactions_department_sale_date_idx",
        "dvf_transactions_lat_lng_idx",
    } <= relations
    rls, price = dvf_connection.execute(
        "select c.relrowsecurity, (select price_per_m2 from public.dvf_transactions "
        "where source_mutation_id = 'new-1') from pg_class c where c.oid = 'public.dvf_transactions'::regclass"
    ).fetchone()
    assert rls is True
    assert price == 4000
    privileges = dvf_connection.execute(
        "select has_table_privilege('anon', 'public.dvf_transactions', 'select'), "
        "has_table_privilege('authenticated', 'public.dvf_transactions', 'select'), "
        "has_table_privilege('service_role', 'public.dvf_transactions', 'delete')"
    ).fetchone()
    assert privileges == (False, False, True)
    # on delete set null still applies to the swapped-in rows.
    dvf_connection.execute("delete from public.dvf_import_batches where id = %s", (batch_id,))
    assert dvf_connection.execute(
        "select count(*) from public.dvf_transactions where import_batch_id is not null"
    ).fetchone() == (0,)
    dvf_connection.rollback()


def test_swap_with_duplicate_mutations_fails_and_keeps_live_table(dvf_connection) -> None:
    _seed_live(dvf_connection, ["old-1"])
    _stage(dvf_connection, [_row("dup", 100000), _row("dup", 120000)], reset=True)

    with pytest.raises(psycopg.errors.UniqueViolation):
        dvf_import.swap_staging_into_live(dvf_connection)
    dvf_connection.rollback()

    assert _live_ids(dvf_connection) == ["old-1"]
    assert "dvf_transactions_old" not in _relations(dvf_connection)


def test_swap_refuses_an_empty_staging_table(dvf_connection) -> None:
    _seed_live(dvf_connection, ["old-1"])
    dvf_import._prepare_staging_table(dvf_connection, reset=True)

    with pytest.raises(RuntimeError, match="empty"):
        dvf_import.swap_staging_into_live(dvf_connection)
    dvf_connection.rollback()

    assert _live_ids(dvf_connection) == ["old-1"]


def test_failure_inside_the_swap_transaction_rolls_everything_back(dvf_connection, monkeypatch) -> None:
    _seed_live(dvf_connection, ["old-1"])
    _stage(dvf_connection, [_row("new-1", 200000)], reset=True)
    statements = dvf_import.build_swap_statements()
    statements.insert(-1, "select 1/0")  # fails right before the final drop
    monkeypatch.setattr(dvf_import, "build_swap_statements", lambda: statements)

    with pytest.raises(psycopg.errors.DivisionByZero):
        dvf_import.swap_staging_into_live(dvf_connection)

    assert _live_ids(dvf_connection) == ["old-1"]
    relations = _relations(dvf_connection)
    assert "dvf_transactions_old" not in relations
    assert "dvf_transactions_staging" in relations


def test_staging_requires_reset_when_missing(dvf_connection) -> None:
    with pytest.raises(RuntimeError, match="--reset-staging"):
        dvf_import._prepare_staging_table(dvf_connection, reset=False)
    dvf_connection.rollback()
