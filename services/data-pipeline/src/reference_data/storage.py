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


def upsert_statement(table: str) -> str:
    definition, key, updated = TABLES[table]
    columns = [part.strip().split(" ", 1)[0] for part in definition.split(",")]
    assignments = [f"{column} = excluded.{column}" for column in updated]
    if table != "climate_station_months":
        assignments.append("imported_at = now()")
    return (
        f"insert into public.{table} ({', '.join(columns)}) "
        f"select {', '.join(columns)} from jsonb_to_recordset(%s::jsonb) as source({definition}) "
        f"on conflict ({', '.join(key)}) do update set {', '.join(assignments)}"
    )


def upsert_rows(
    connection: Any,
    table: str,
    rows: Iterable[dict[str, object]],
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    statement = upsert_statement(table)
    written = 0
    for batch in _batches(rows, batch_size):
        with connection.cursor() as cursor:
            cursor.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
            cursor.execute(statement, (json.dumps(batch, default=_json_default, ensure_ascii=False),))
        connection.commit()
        written += len(batch)
    return written


SNAPSHOT_TABLES = frozenset({"anil_rents", "commune_housing_tension"})


def database_now(connection: Any) -> datetime:
    """The database clock: rows written afterwards carry a later ``imported_at``."""
    with connection.cursor() as cursor:
        cursor.execute("select now()")
        row = cursor.fetchone()
    connection.commit()
    return row[0]


def purge_untouched(connection: Any, table: str, started_at: datetime) -> int:
    """Delete the rows an import did not write (communes gone from the source)."""
    if table not in SNAPSHOT_TABLES:
        raise ValueError(f"{table} is not a snapshot table")
    with connection.cursor() as cursor:
        cursor.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
        cursor.execute(f"delete from public.{table} where imported_at < %s", (started_at,))
        deleted = cursor.rowcount or 0
    connection.commit()
    return deleted


def vintage_counts(connection: Any, table: str) -> list[tuple[int, int]]:
    """``(vintage, rows)`` pairs of a table that carries a vintage."""
    if table != "anil_rents":
        raise ValueError(f"{table} has no vintage")
    with connection.cursor() as cursor:
        cursor.execute("select vintage, count(*) from public.anil_rents group by vintage order by vintage")
        rows = [(int(vintage), int(count)) for vintage, count in cursor.fetchall()]
    connection.commit()
    return rows


def row_count(connection: Any, table: str) -> int:
    if table not in SNAPSHOT_TABLES:
        raise ValueError(f"{table} is not a snapshot table")
    with connection.cursor() as cursor:
        cursor.execute(f"select count(*) from public.{table}")
        count = int(cursor.fetchone()[0])
    connection.commit()
    return count


def delete_climate_months_before(connection: Any, first_month: date) -> int:
    with connection.cursor() as cursor:
        cursor.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
        cursor.execute("delete from public.climate_station_months where month < %s", (first_month,))
        deleted = cursor.rowcount or 0
    connection.commit()
    return deleted
