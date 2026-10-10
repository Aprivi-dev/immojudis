"""Batched upserts of the reference tables through ``jsonb_to_recordset``."""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from datetime import date
from decimal import Decimal
from typing import Any

DEFAULT_BATCH_SIZE = 5_000


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
            cursor.execute(statement, (json.dumps(batch, default=_json_default, ensure_ascii=False),))
        connection.commit()
        written += len(batch)
    return written


def delete_climate_months_before(connection: Any, first_month: date) -> int:
    with connection.cursor() as cursor:
        cursor.execute("delete from public.climate_station_months where month < %s", (first_month,))
        deleted = cursor.rowcount or 0
    connection.commit()
    return deleted
