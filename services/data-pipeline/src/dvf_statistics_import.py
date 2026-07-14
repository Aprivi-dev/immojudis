from __future__ import annotations

import argparse
import csv
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

try:
    from psycopg import sql
except ModuleNotFoundError:  # pragma: no cover - optional for parsing-only tests.
    sql = None

from src.config import load_settings
from src.storage.supabase_client import _postgres_connect

DEFAULT_SOURCE_URL = "https://www.data.gouv.fr/datasets/statistiques-dvf"
DEFAULT_BATCH_SIZE = 1_000
SUPPORTED_LEVELS = {
    "departement": "department",
    "department": "department",
    "epci": "epci",
    "commune": "commune",
}
SEGMENT_COLUMNS = {
    "apartment": "appartement",
    "house": "maison",
    "residential": "apt_maison",
    "commercial": "local",
}
STATISTICS_COLUMNS = (
    "geography_level",
    "geography_code",
    "geography_label",
    "parent_code",
    "segment",
    "sales_count",
    "mean_price_per_m2",
    "median_price_per_m2",
    "source_url",
    "source_updated_at",
    "imported_at",
)


@dataclass(frozen=True)
class DvfStatisticsImportOptions:
    path: Path
    source_url: str = DEFAULT_SOURCE_URL
    source_updated_at: date | None = None
    batch_size: int = DEFAULT_BATCH_SIZE
    dry_run: bool = False


@dataclass
class DvfStatisticsImportSummary:
    parsed_geographies: int = 0
    normalized_rows: int = 0
    upserted_rows: int = 0


def import_dvf_statistics(options: DvfStatisticsImportOptions) -> DvfStatisticsImportSummary:
    summary = DvfStatisticsImportSummary()
    rows = iter_statistics_rows(options.path)
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not options.dry_run and not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to import DVF market statistics.")

    normalized = _iter_normalized_statistics(rows, options, summary)
    if options.dry_run:
        for _ in normalized:
            pass
        return summary

    with _postgres_connect(str(db_url)) as connection:
        payload: list[dict[str, object]] = []
        for row in normalized:
            payload.append(row)
            if len(payload) >= options.batch_size:
                _upsert_statistics(connection, payload)
                summary.upserted_rows += len(payload)
                payload = []
        if payload:
            _upsert_statistics(connection, payload)
            summary.upserted_rows += len(payload)
        connection.commit()
    return summary


def iter_statistics_rows(path: Path) -> Iterator[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            yield {str(key).strip(): (value or "").strip() for key, value in row.items() if key}


def normalize_statistics_row(
    row: dict[str, str],
    *,
    source_url: str = DEFAULT_SOURCE_URL,
    source_updated_at: date | None = None,
) -> list[dict[str, object]]:
    level = SUPPORTED_LEVELS.get(row.get("echelle_geo", "").strip().lower())
    code = clean_text(row.get("code_geo"))
    label = clean_text(row.get("libelle_geo"))
    if not level or not code or not label:
        return []

    # Une intercommunalité peut couvrir plusieurs départements et apparaît alors
    # plusieurs fois dans la source avec le même code et les mêmes statistiques.
    # Seul le lien commune -> EPCI est nécessaire au moteur de repli.
    parent_code = clean_text(row.get("code_parent")) if level == "commune" else None
    imported_at = datetime.now().astimezone().isoformat()
    result: list[dict[str, object]] = []
    for segment, suffix in SEGMENT_COLUMNS.items():
        sales_count = integer(row.get(f"nb_ventes_whole_{suffix}"))
        median = decimal(row.get(f"med_prix_m2_whole_{suffix}"))
        mean = decimal(row.get(f"moy_prix_m2_whole_{suffix}"))
        if sales_count is None or sales_count <= 0 or median is None or median <= 0:
            continue
        result.append(
            {
                "geography_level": level,
                "geography_code": code,
                "geography_label": label,
                "parent_code": parent_code,
                "segment": segment,
                "sales_count": sales_count,
                "mean_price_per_m2": mean if mean is not None and mean > 0 else None,
                "median_price_per_m2": median,
                "source_url": source_url,
                "source_updated_at": source_updated_at,
                "imported_at": imported_at,
            }
        )
    return result


def _iter_normalized_statistics(
    rows: Iterator[dict[str, str]],
    options: DvfStatisticsImportOptions,
    summary: DvfStatisticsImportSummary,
) -> Iterator[dict[str, object]]:
    for row in rows:
        summary.parsed_geographies += 1
        normalized = normalize_statistics_row(
            row,
            source_url=options.source_url,
            source_updated_at=options.source_updated_at,
        )
        summary.normalized_rows += len(normalized)
        yield from normalized


def _upsert_statistics(connection: Any, payload: list[dict[str, object]]) -> None:
    if not payload:
        return
    if sql is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    columns = list(STATISTICS_COLUMNS)
    statement = sql.SQL(
        """
        insert into public.dvf_market_statistics ({columns})
        values ({values})
        on conflict (geography_level, geography_code, segment) do update set
          geography_label = excluded.geography_label,
          parent_code = excluded.parent_code,
          sales_count = excluded.sales_count,
          mean_price_per_m2 = excluded.mean_price_per_m2,
          median_price_per_m2 = excluded.median_price_per_m2,
          source_url = excluded.source_url,
          source_updated_at = excluded.source_updated_at,
          imported_at = excluded.imported_at
        """
    ).format(
        columns=sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        values=sql.SQL(", ").join(sql.Placeholder() for _ in columns),
    )
    values = [tuple(row.get(column) for column in columns) for row in payload]
    with connection.cursor() as cursor:
        cursor.executemany(statement, values)


def clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.strip().split())
    return cleaned or None


def decimal(value: str | None) -> Decimal | None:
    cleaned = clean_text(value)
    if not cleaned:
        return None
    try:
        return Decimal(cleaned.replace(" ", "").replace(",", "."))
    except InvalidOperation:
        return None


def integer(value: str | None) -> int | None:
    number = decimal(value)
    return int(number) if number is not None else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importe les statistiques DVF data.gouv dans Supabase.")
    parser.add_argument("path", type=Path, help="Fichier stats_whole_period.csv")
    parser.add_argument("--source-url", default=DEFAULT_SOURCE_URL)
    parser.add_argument("--source-updated-at", type=date.fromisoformat, default=None)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    summary = import_dvf_statistics(
        DvfStatisticsImportOptions(
            path=args.path,
            source_url=args.source_url,
            source_updated_at=args.source_updated_at,
            batch_size=max(1, args.batch_size),
            dry_run=args.dry_run,
        )
    )
    print("DVF statistics import summary")
    print(f"- parsed_geographies: {summary.parsed_geographies}")
    print(f"- normalized_rows: {summary.normalized_rows}")
    print(f"- upserted_rows: {summary.upserted_rows}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
