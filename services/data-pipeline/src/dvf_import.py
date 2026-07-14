from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import logging
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from itertools import chain
from pathlib import Path
from typing import Any, TextIO

try:
    from psycopg import sql
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - optional for dry-run parsing tests.
    sql = None
    Jsonb = None

from src.config import load_settings
from src.storage.supabase_client import _postgres_connect

LOGGER = logging.getLogger(__name__)

DVF_SOURCE = "DVF"
DEFAULT_BATCH_SIZE = 1_000
TEXT_EXTENSIONS = {".csv", ".txt"}
GZIP_EXTENSION = ".gz"
CSV_DELIMITERS = ("|", ";", ",", "\t")

DVF_TRANSACTION_COLUMNS = (
    "import_batch_id",
    "source",
    "source_mutation_id",
    "source_url",
    "sale_date",
    "mutation_nature",
    "total_price_eur",
    "built_surface_m2",
    "land_surface_m2",
    "property_type",
    "dvf_property_type_code",
    "rooms_count",
    "lots_count",
    "address",
    "city",
    "postal_code",
    "insee_code",
    "department",
    "parcel_id",
    "latitude",
    "longitude",
    "raw_payload",
    "source_last_seen_at",
    "updated_at",
)


@dataclass(frozen=True)
class DvfImportOptions:
    path: Path
    source_url: str | None = None
    batch_size: int = DEFAULT_BATCH_SIZE
    limit: int | None = None
    dry_run: bool = False


@dataclass
class DvfImportSummary:
    file_name: str
    parsed_rows: int = 0
    valid_rows: int = 0
    skipped_rows: int = 0
    upserted_rows: int = 0
    batch_id: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    errors: list[str] = field(default_factory=list)


def import_dvf_file(options: DvfImportOptions) -> DvfImportSummary:
    path = options.path
    summary = DvfImportSummary(file_name=path.name)
    rows = iter_dvf_rows(path)
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not options.dry_run and not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to import DVF transactions.")

    if options.dry_run:
        for transaction in _iter_normalized_transactions(rows, options, summary):
            _record_period(summary, transaction["sale_date"])
        return summary

    now = datetime.now(UTC).isoformat()
    with _postgres_connect(str(db_url)) as connection:
        batch_id = _create_import_batch(
            connection,
            file_name=path.name,
            source_url=options.source_url,
            metadata={
                "path": str(path),
                "limit": options.limit,
                "batch_size": options.batch_size,
            },
        )
        summary.batch_id = batch_id
        connection.commit()
        try:
            payload: list[dict[str, object]] = []
            for transaction in _iter_normalized_transactions(rows, options, summary):
                transaction["import_batch_id"] = batch_id
                transaction["source_last_seen_at"] = now
                transaction["updated_at"] = now
                payload.append(transaction)
                _record_period(summary, transaction["sale_date"])
                if len(payload) >= options.batch_size:
                    _upsert_transactions(connection, payload)
                    summary.upserted_rows += len(payload)
                    payload = []
            if payload:
                _upsert_transactions(connection, payload)
                summary.upserted_rows += len(payload)
            _finish_import_batch(connection, summary)
        except Exception as exc:
            summary.errors.append(str(exc))
            connection.rollback()
            _fail_import_batch(connection, batch_id, str(exc))
            connection.commit()
            raise
    return summary


def iter_dvf_rows(path: Path) -> Iterator[dict[str, str]]:
    if path.suffix.lower() == ".zip":
        yield from _iter_zip_rows(path)
        return
    if path.suffix.lower() == GZIP_EXTENSION:
        with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as handle:
            yield from _iter_text_rows(handle)
        return
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        raise ValueError(f"Unsupported DVF file extension: {path.suffix}")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        yield from _iter_text_rows(handle)


def normalize_dvf_row(row: dict[str, str], *, source_url: str | None = None) -> dict[str, object] | None:
    mutation_nature = clean_text(first_value(row, "nature_mutation", "libnatmut"))
    if mutation_nature and "vente" not in mutation_nature.lower():
        return None

    sale_date = parse_date(first_value(row, "date_mutation", "datemut"))
    total_price = decimal_value(first_value(row, "valeur_fonciere", "valeurfonc"))
    built_surface = positive_decimal_value(first_value(row, "surface_reelle_bati", "sbati"))
    land_surface = nonnegative_decimal_value(first_value(row, "surface_terrain", "sterr"))
    if not sale_date or not total_price or total_price <= 0:
        return None

    property_type = clean_text(first_value(row, "type_local", "libtypbien"))
    property_type_code = normalized_property_type_code(
        first_value(row, "code_type_local", "codtypbien"),
        property_type,
        built_surface,
        land_surface,
    )
    if property_type_code is None:
        return None

    source_mutation_id = clean_text(first_value(row, "id_mutation", "idmutinvar"))
    parcel_id = clean_text(first_value(row, "id_parcelle", "l_idpar"))
    if not source_mutation_id:
        source_mutation_id = stable_mutation_id(row)

    address = compact_address(
        [
            first_value(row, "adresse_numero", "numero_voie"),
            first_value(row, "adresse_suffixe", "suffixe"),
            first_value(row, "adresse_nom_voie", "voie"),
        ]
    )
    postal_code = clean_text(first_value(row, "code_postal", "postal_code"))
    department = clean_text(first_value(row, "code_departement", "department")) or department_from_postal_code(postal_code)
    raw_payload = {
        key: row[key]
        for key in (
            "id_mutation",
            "numero_disposition",
            "code_nature_culture",
            "nature_culture",
            "ancien_id_parcelle",
        )
        if row.get(key) not in ("", None)
    }

    return {
        "import_batch_id": None,
        "source": DVF_SOURCE,
        "source_mutation_id": source_mutation_id,
        "source_url": clean_text(first_value(row, "source_url")) or source_url,
        "sale_date": sale_date,
        "mutation_nature": mutation_nature,
        "total_price_eur": total_price,
        "built_surface_m2": built_surface,
        "land_surface_m2": land_surface,
        "property_type": property_type,
        "dvf_property_type_code": property_type_code,
        "rooms_count": nonnegative_int_value(
            first_value(row, "nombre_pieces_principales", "nb_pieces_principales")
        ),
        "lots_count": nonnegative_int_value(first_value(row, "nombre_lots", "nb_lots")),
        "address": address,
        "city": clean_text(first_value(row, "nom_commune", "commune", "city")),
        "postal_code": postal_code,
        "insee_code": clean_text(first_value(row, "code_commune", "insee_code")),
        "department": department,
        "parcel_id": parcel_id,
        "latitude": decimal_value(first_value(row, "latitude", "lat")),
        "longitude": decimal_value(first_value(row, "longitude", "lon")),
        "raw_payload": raw_payload,
        "source_last_seen_at": None,
        "updated_at": None,
    }


def _iter_normalized_transactions(
    rows: Iterator[dict[str, str]],
    options: DvfImportOptions,
    summary: DvfImportSummary,
) -> Iterator[dict[str, object]]:
    for row in rows:
        if options.limit is not None and summary.parsed_rows >= options.limit:
            break
        summary.parsed_rows += 1
        try:
            transaction = normalize_dvf_row(row, source_url=options.source_url)
        except Exception as exc:
            summary.skipped_rows += 1
            summary.errors.append(f"row {summary.parsed_rows}: {exc}")
            continue
        if transaction is None:
            summary.skipped_rows += 1
            continue
        summary.valid_rows += 1
        yield transaction


def _iter_zip_rows(path: Path) -> Iterator[dict[str, str]]:
    with zipfile.ZipFile(path) as archive:
        names = sorted(
            name
            for name in archive.namelist()
            if not name.endswith("/") and Path(name).suffix.lower() in TEXT_EXTENSIONS
        )
        if not names:
            raise ValueError(f"No .txt or .csv DVF file found in archive: {path}")
        for name in names:
            with archive.open(name) as raw:
                text = (line.decode("utf-8-sig", errors="replace") for line in raw)
                yield from _iter_text_rows(text)


def _iter_text_rows(handle: TextIO | Iterator[str]) -> Iterator[dict[str, str]]:
    sample_lines: list[str] = []
    iterator = iter(handle)
    for _ in range(5):
        try:
            sample_lines.append(next(iterator))
        except StopIteration:
            break
    if not sample_lines:
        return
    delimiter = detect_delimiter("".join(sample_lines))
    reader = csv.DictReader(chain(sample_lines, iterator), delimiter=delimiter)
    for row in reader:
        yield {normalize_header(key): (value or "").strip() for key, value in row.items() if key}


def detect_delimiter(sample: str) -> str:
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters="".join(CSV_DELIMITERS))
        return dialect.delimiter
    except csv.Error:
        scores = {delimiter: sample.count(delimiter) for delimiter in CSV_DELIMITERS}
        return max(scores, key=scores.get)


def first_value(row: dict[str, str], *keys: str) -> str | None:
    for key in keys:
        value = row.get(normalize_header(key))
        if value not in (None, ""):
            return value
    return None


def normalize_header(value: str) -> str:
    return value.strip().lower().replace(" ", "_").replace("-", "_")


def clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.replace("\x00", "").strip().split())
    return cleaned or None


def compact_address(parts: list[str | None]) -> str | None:
    cleaned = [clean_text(part) for part in parts]
    return clean_text(" ".join(part for part in cleaned if part))


def decimal_value(value: str | None) -> Decimal | None:
    if value is None:
        return None
    cleaned = value.replace("\u202f", "").replace(" ", "").replace(",", ".").strip()
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def positive_decimal_value(value: str | None) -> Decimal | None:
    number = decimal_value(value)
    return number if number is not None and number > 0 else None


def nonnegative_decimal_value(value: str | None) -> Decimal | None:
    number = decimal_value(value)
    return number if number is not None and number >= 0 else None


def int_value(value: str | None) -> int | None:
    number = decimal_value(value)
    if number is None:
        return None
    return int(number)


def nonnegative_int_value(value: str | None) -> int | None:
    number = int_value(value)
    return number if number is not None and number >= 0 else None


def normalized_property_type_code(
    raw_code: str | None,
    property_type: str | None,
    built_surface: Decimal | None,
    land_surface: Decimal | None,
) -> str | None:
    code = clean_text(raw_code)
    text = (property_type or "").lower()
    if code in {"111", "121", "112", "122", "123", "141", "142", "151", "152"}:
        return code
    if code == "1" or any(token in text for token in ("maison", "villa", "pavillon", "house")):
        return "111" if built_surface is not None else None
    if code == "2" or any(token in text for token in ("appartement", "studio", "apartment")):
        return "121" if built_surface is not None else None
    if code == "4" or any(
        token in text for token in ("local industriel", "local commercial", "commerce", "bureau")
    ):
        return "141" if built_surface is not None else None
    if code is None and not text and built_surface is None and land_surface is not None and land_surface > 0:
        return "211"
    return None


def parse_date(value: str | None) -> date | None:
    cleaned = clean_text(value)
    if not cleaned:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    return None


def department_from_postal_code(postal_code: str | None) -> str | None:
    if not postal_code:
        return None
    if postal_code.startswith("97") or postal_code.startswith("98"):
        return postal_code[:3]
    return postal_code[:2] if len(postal_code) >= 2 else None


def stable_mutation_id(row: dict[str, str]) -> str:
    payload = json.dumps(row, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _record_period(summary: DvfImportSummary, sale_date: object) -> None:
    if not isinstance(sale_date, date):
        return
    summary.period_start = sale_date if summary.period_start is None else min(summary.period_start, sale_date)
    summary.period_end = sale_date if summary.period_end is None else max(summary.period_end, sale_date)


def _create_import_batch(
    connection: Any,
    *,
    file_name: str,
    source_url: str | None,
    metadata: dict[str, object],
) -> str:
    if Jsonb is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            insert into public.dvf_import_batches (source, source_url, file_name, status, metadata)
            values (%s, %s, %s, 'running', %s)
            returning id
            """,
            (DVF_SOURCE, source_url, file_name, Jsonb(metadata)),
        )
        row = cursor.fetchone()
    if not row:
        raise RuntimeError("DVF import batch creation failed.")
    return str(row[0])


def _finish_import_batch(connection: Any, summary: DvfImportSummary) -> None:
    if Jsonb is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            update public.dvf_import_batches
            set status = 'completed',
                imported_rows = %s,
                period_start = %s,
                period_end = %s,
                completed_at = now(),
                updated_at = now(),
                metadata = coalesce(metadata, '{}'::jsonb) || %s::jsonb
            where id = %s
            """,
            (
                summary.upserted_rows,
                summary.period_start,
                summary.period_end,
                Jsonb({"parsed_rows": summary.parsed_rows, "skipped_rows": summary.skipped_rows}),
                summary.batch_id,
            ),
        )


def _fail_import_batch(connection: Any, batch_id: str, error_message: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            update public.dvf_import_batches
            set status = 'failed', error_message = %s, completed_at = now(), updated_at = now()
            where id = %s
            """,
            (error_message[:2_000], batch_id),
        )


def _upsert_transactions(connection: Any, payload: list[dict[str, object]]) -> None:
    if not payload:
        return
    if sql is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    columns = list(DVF_TRANSACTION_COLUMNS)
    insert_statement = sql.SQL(
        """
        insert into public.dvf_transactions ({columns})
        values ({values})
        on conflict (source, source_mutation_id, coalesce(parcel_id, '')) do update set {updates}
        """
    ).format(
        columns=sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        values=sql.SQL(", ").join(sql.Placeholder() for _ in columns),
        updates=sql.SQL(", ").join(
            sql.SQL("{} = excluded.{}").format(sql.Identifier(column), sql.Identifier(column))
            for column in columns
            if column not in {"source", "source_mutation_id", "parcel_id"}
        ),
    )
    rows = [tuple(postgres_value(row.get(column)) for column in columns) for row in payload]
    with connection.cursor() as cursor:
        cursor.executemany(insert_statement, rows)


def postgres_value(value: object) -> object:
    if isinstance(value, dict) and Jsonb is not None:
        return Jsonb(value)
    return value


def print_summary(summary: DvfImportSummary) -> None:
    print("DVF import summary")
    print(f"- file: {summary.file_name}")
    print(f"- batch_id: {summary.batch_id or 'dry-run'}")
    print(f"- parsed_rows: {summary.parsed_rows}")
    print(f"- valid_rows: {summary.valid_rows}")
    print(f"- skipped_rows: {summary.skipped_rows}")
    print(f"- upserted_rows: {summary.upserted_rows}")
    print(f"- period: {summary.period_start or 'n/a'} -> {summary.period_end or 'n/a'}")
    if summary.errors:
        print(f"- errors: {len(summary.errors)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importe un fichier DVF data.gouv dans Supabase.")
    parser.add_argument("path", type=Path, help="Fichier DVF .txt/.csv ou archive .zip.")
    parser.add_argument("--source-url", default=None, help="URL officielle du fichier source DVF.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=None,
        help="Taille des lots d'upsert. Défaut: DVF_IMPORT_BATCH_SIZE ou 1000.",
    )
    parser.add_argument("--limit", type=int, default=None, help="Nombre maximum de lignes lues pour un test.")
    parser.add_argument("--dry-run", action="store_true", help="Parse et valide sans écrire dans Supabase.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = load_settings()
    batch_size = args.batch_size or int(settings.get("dvf_import_batch_size") or DEFAULT_BATCH_SIZE)
    summary = import_dvf_file(
        DvfImportOptions(
            path=args.path,
            source_url=args.source_url,
            batch_size=max(1, batch_size),
            limit=args.limit,
            dry_run=args.dry_run,
        )
    )
    print_summary(summary)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    raise SystemExit(main())
