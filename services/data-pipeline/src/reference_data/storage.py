"""Batched upserts of the reference tables through ``jsonb_to_recordset``."""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from datetime import date, datetime
from decimal import Decimal
from typing import Any

DEFAULT_BATCH_SIZE = 1_000
# Through the Supabase transaction pooler a session-level statement_timeout is
# not kept between transactions, so each write sets its own, local, limit.
STATEMENT_TIMEOUT = "5min"


def _json_default(value: object) -> object:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"Unsupported value {value!r}")


def _batches(rows: Iterable[dict[str, object]], size: int) -> Iterator[list[dict[str, object]]]:
    batch: list[dict[str, object]] = []
    for row in rows:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


# table -> (recordset column definitions, conflict key, updated columns)
TABLES: dict[str, tuple[str, tuple[str, ...], tuple[str, ...]]] = {
    "reference_communes": (
        "code_insee text, name text, name_normalized text, department_code text,"
        " postal_codes text[], latitude double precision, longitude double precision, source_url text",
        ("code_insee",),
        ("name", "name_normalized", "department_code", "postal_codes", "latitude", "longitude", "source_url"),
    ),
    "commune_risk_profiles": (
        "code_insee text, commune_name text, risks jsonb, catnat_total integer, catnat_by_type jsonb,"
        " catnat_recent jsonb, prevention_plans jsonb, gaspar_snapshot date, source_url text",
        ("code_insee",),
        (
            "commune_name",
            "risks",
            "catnat_total",
            "catnat_by_type",
            "catnat_recent",
            "prevention_plans",
            "gaspar_snapshot",
            "source_url",
        ),
    ),
    "anil_rents": (
        "commune_code text, segment text, commune_name text, department_code text, epci_code text,"
        " zone_id integer, rent_per_m2 numeric, rent_low_per_m2 numeric, rent_high_per_m2 numeric,"
        " prediction_type text, observations_commune integer, observations_mesh integer,"
        " r2_adj numeric, vintage smallint, source_updated_on date, source_url text",
        ("commune_code", "segment"),
        (
            "commune_name",
            "department_code",
            "epci_code",
            "zone_id",
            "rent_per_m2",
            "rent_low_per_m2",
            "rent_high_per_m2",
            "prediction_type",
            "observations_commune",
            "observations_mesh",
            "r2_adj",
            "vintage",
            "source_updated_on",
            "source_url",
        ),
    ),
    "commune_housing_tension": (
        "commune_code text, commune_name text, department_code text, epci_code text, epci_name text,"
        " zoning_2013 text, zoning_2023 text, zoning_post_decree text, decree_reference text,"
        " decree_date date, source_updated_on date, source_url text",
        ("commune_code",),
        (
            "commune_name",
            "department_code",
            "epci_code",
            "epci_name",
            "zoning_2013",
            "zoning_2023",
            "zoning_post_decree",
            "decree_reference",
            "decree_date",
            "source_updated_on",
            "source_url",
        ),
    ),
    "commune_code_history": (
        "old_code text, new_code text, effective_on date, modality text",
        ("old_code", "new_code", "effective_on"),
        ("modality",),
    ),
    "climate_stations": (
        "station_id text, name text, department_code text, latitude double precision,"
        " longitude double precision, altitude_m integer, first_month date, last_month date,"
        " has_temperature boolean, has_precipitation boolean, has_sunshine boolean, source_url text",
        ("station_id",),
        (
            "name",
            "department_code",
            "latitude",
            "longitude",
            "altitude_m",
            "first_month",
            "last_month",
            "has_temperature",
            "has_precipitation",
            "has_sunshine",
            "source_url",
        ),
    ),
    "climate_station_months": (
        "station_id text, month date, precipitation_mm numeric, mean_temperature_c numeric,"
        " mean_min_temperature_c numeric, mean_max_temperature_c numeric, sunshine_minutes integer,"
        " rain_days smallint, frost_days smallint, hot_days smallint",
        ("station_id", "month"),
        (
            "precipitation_mm",
            "mean_temperature_c",
            "mean_min_temperature_c",
            "mean_max_temperature_c",
            "sunshine_minutes",
            "rain_days",
            "frost_days",
            "hot_days",
        ),
    ),
}


# Tables outside the public schema (private, never reachable through the Data API).
PRIVATE_TABLES = frozenset({"commune_code_history"})


def _relation(table: str) -> str:
    return f"{'app_private' if table in PRIVATE_TABLES else 'public'}.{table}"


def upsert_statement(table: str) -> str:
    definition, key, updated = TABLES[table]
    columns = [part.strip().split(" ", 1)[0] for part in definition.split(",")]
    assignments = [f"{column} = excluded.{column}" for column in updated]
    if table != "climate_station_months":
        assignments.append("imported_at = now()")
    return (
        f"insert into {_relation(table)} ({', '.join(columns)}) "
        f"select {', '.join(columns)} from jsonb_to_recordset(%s::jsonb) as source({definition}) "
        f"on conflict ({', '.join(key)}) do update set {', '.join(assignments)}"
    )


def upsert_rows(
    connection: Any,
    table: str,
    rows: Iterable[dict[str, object]],
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    single_transaction: bool = False,
) -> int:
    """Upsert ``rows`` by batches; one commit per batch, or none with ``single_transaction``.

    With ``single_transaction`` the caller owns the transaction (commit or rollback): nothing is
    visible to other sessions until it ends, so a failure halfway leaves the table as it was.
    """
    statement = upsert_statement(table)
    written = 0
    for batch in _batches(rows, batch_size):
        with connection.cursor() as cursor:
            cursor.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
            cursor.execute(statement, (json.dumps(batch, default=_json_default, ensure_ascii=False),))
        if not single_transaction:
            connection.commit()
        written += len(batch)
    return written


SNAPSHOT_TABLES = frozenset({"anil_rents", "commune_housing_tension", "commune_code_history"})


def database_now(connection: Any, *, commit: bool = True) -> datetime:
    """The database clock: rows written afterwards carry a later ``imported_at``.

    Inside a transaction ``now()`` is the start of that transaction, which is also the
    ``imported_at`` of every row the transaction writes: they are never purged as untouched.
    """
    with connection.cursor() as cursor:
        cursor.execute("select now()")
        row = cursor.fetchone()
    if commit:
        connection.commit()
    return row[0]


def purge_untouched(connection: Any, table: str, started_at: datetime, *, commit: bool = True) -> int:
    """Delete the rows an import did not write (communes gone from the source)."""
    if table not in SNAPSHOT_TABLES:
        raise ValueError(f"{table} is not a snapshot table")
    with connection.cursor() as cursor:
        cursor.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
        cursor.execute(f"delete from {_relation(table)} where imported_at < %s", (started_at,))
        deleted = cursor.rowcount or 0
    if commit:
        connection.commit()
    return deleted


def vintage_counts(connection: Any, table: str, *, commit: bool = True) -> list[tuple[int, int]]:
    """``(vintage, rows)`` pairs of a table that carries a vintage."""
    if table != "anil_rents":
        raise ValueError(f"{table} has no vintage")
    with connection.cursor() as cursor:
        cursor.execute("select vintage, count(*) from public.anil_rents group by vintage order by vintage")
        rows = [(int(vintage), int(count)) for vintage, count in cursor.fetchall()]
    if commit:
        connection.commit()
    return rows


def row_count(connection: Any, table: str, *, commit: bool = True) -> int:
    if table not in SNAPSHOT_TABLES:
        raise ValueError(f"{table} is not a snapshot table")
    with connection.cursor() as cursor:
        cursor.execute(f"select count(*) from {_relation(table)}")
        count = int(cursor.fetchone()[0])
    if commit:
        connection.commit()
    return count


class SnapshotCheckError(RuntimeError):
    """The table does not hold what the import wrote: the transaction was rolled back."""


def replace_snapshot(
    connection: Any, table: str, rows: Iterable[dict[str, object]], *, vintage: int | None = None
) -> tuple[int, int]:
    """Upsert, purge and check a snapshot table in ONE transaction; ``(written, purged)``.

    The check compares what the table would hold (rows, and the vintage when ``vintage`` is given)
    with what was written. On any difference, or any failure, the transaction is rolled back: a
    network failure, a timeout or a CHECK violation halfway never leaves a mix of two editions
    that the web app would read.
    """
    materialized = list(rows)
    try:
        started_at = database_now(connection, commit=False)
        written = upsert_rows(connection, table, materialized, single_transaction=True)
        purged = purge_untouched(connection, table, started_at, commit=False)
        if vintage is not None:
            found = vintage_counts(connection, table, commit=False)
            if found != [(vintage, len(materialized))]:
                raise SnapshotCheckError(
                    f"{table} would hold {found} (vintage, rows) after the import; expected "
                    f"[({vintage}, {len(materialized)})]. A mix of vintages or a wrong row count: "
                    "the transaction was rolled back, nothing changed."
                )
        else:
            count = row_count(connection, table, commit=False)
            if count != len(materialized):
                raise SnapshotCheckError(
                    f"{table} would hold {count} rows after the import; expected {len(materialized)}. "
                    "The transaction was rolled back, nothing changed."
                )
    except BaseException:
        connection.rollback()
        raise
    connection.commit()
    return written, purged


def delete_climate_months_before(connection: Any, first_month: date) -> int:
    with connection.cursor() as cursor:
        cursor.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
        cursor.execute("delete from public.climate_station_months where month < %s", (first_month,))
        deleted = cursor.rowcount or 0
    connection.commit()
    return deleted
