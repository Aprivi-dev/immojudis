from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import logging
import time
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
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
from src.storage.supabase_client import connect

# Alias de compatibilité : des tests patchent ce nom de module.
_postgres_connect = connect

LOGGER = logging.getLogger(__name__)

DVF_SOURCE = "DVF"
LIVE_TABLE = "dvf_transactions"
STAGING_TABLE = "dvf_transactions_staging"
OLD_TABLE = "dvf_transactions_old"
DVF_MARKET_MUTATION_MARKERS = ("vente",)
DVF_ADJUDICATION_MUTATION_MARKERS = ("adjudication",)
DEFAULT_BATCH_SIZE = 1_000
DEFAULT_REPLACEMENT_BATCH_SIZE = 25_000
FAILURE_FINALIZATION_RETRY_DELAYS_SECONDS = (0, 2, 4, 8, 16, 30)
TEXT_EXTENSIONS = {".csv", ".txt"}
GZIP_EXTENSION = ".gz"
CSV_DELIMITERS = ("|", ";", ",", "\t")

DVF_TRANSACTION_COLUMNS = (
    "import_batch_id",
    "source",
    "source_mutation_id",
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
)


@dataclass(frozen=True)
class DvfImportOptions:
    path: Path
    source_url: str | None = None
    batch_size: int = DEFAULT_BATCH_SIZE
    limit: int | None = None
    replace_existing: bool = False
    dry_run: bool = False
    # Load into dvf_transactions_staging without touching dvf_transactions.
    # ``replace_existing`` is the single-file shortcut: reset staging, load it,
    # then swap it in with one final replacement.
    stage: bool = False
    reset_staging: bool = False

    @property
    def uses_staging(self) -> bool:
        return self.replace_existing or self.stage

    @property
    def resets_staging(self) -> bool:
        return self.replace_existing or self.reset_staging


@dataclass(frozen=True)
class DvfSourceArtifact:
    file_name: str
    sha256: str
    members: tuple[str, ...]


@dataclass
class DvfImportSummary:
    file_name: str
    source_artifact_sha256: str | None = None
    source_members: tuple[str, ...] = ()
    parsed_rows: int = 0
    valid_rows: int = 0
    skipped_rows: int = 0
    collapsed_rows: int = 0
    skipped_complex_mutations: int = 0
    canonical_rows: int = 0
    upserted_rows: int = 0
    batch_id: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    errors: list[str] = field(default_factory=list)


def import_dvf_file(options: DvfImportOptions) -> DvfImportSummary:
    path = options.path
    if options.uses_staging and options.limit is not None:
        raise ValueError("A replacement DVF import cannot be combined with a row limit.")
    if options.reset_staging and not options.uses_staging:
        raise ValueError("--reset-staging requires --stage or --replace-existing.")
    artifact = inspect_dvf_source(path)
    summary = DvfImportSummary(
        file_name=path.name,
        source_artifact_sha256=artifact.sha256,
        source_members=artifact.members,
    )
    rows = iter_dvf_rows(path)
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not options.dry_run and not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to import DVF transactions.")

    transactions = _iter_canonical_transactions(
        _iter_normalized_transactions(rows, options, summary),
        summary,
    )

    if options.dry_run:
        for transaction in transactions:
            _record_period(summary, transaction["sale_date"])
        return summary

    connection = _postgres_connect(str(db_url))
    try:
        batch_id = _create_import_batch(
            connection,
            file_name=path.name,
            source_url=options.source_url,
            metadata={
                "path": str(path),
                "source_artifact_sha256": artifact.sha256,
                "source_members": list(artifact.members),
                "limit": options.limit,
                "batch_size": options.batch_size,
                "replace_existing": options.replace_existing,
                "stage": options.uses_staging,
                "reset_staging": options.resets_staging,
            },
        )
        summary.batch_id = batch_id
        connection.commit()
        try:
            if options.uses_staging:
                _prepare_staging_table(connection, reset=options.resets_staging)
            payload: list[dict[str, object]] = []
            for transaction in transactions:
                transaction["import_batch_id"] = batch_id
                payload.append(transaction)
                _record_period(summary, transaction["sale_date"])
                if len(payload) >= options.batch_size:
                    _commit_transaction_batch(
                        connection,
                        batch_id,
                        payload,
                        summary,
                        replace_existing=options.uses_staging,
                    )
                    payload = []
            if payload:
                _commit_transaction_batch(
                    connection,
                    batch_id,
                    payload,
                    summary,
                    replace_existing=options.uses_staging,
                )
            _finish_import_batch(connection, summary)
            connection.commit()
            if options.replace_existing:
                swap_staging_into_live(connection)
        except Exception as exc:
            summary.errors.append(str(exc))
            try:
                _finalize_failed_import(
                    str(db_url),
                    connection,
                    batch_id,
                    str(exc),
                    restore_indexes=False,
                )
            except Exception as finalization_exc:
                summary.errors.append(f"failure finalization failed: {finalization_exc}")
                LOGGER.exception("DVF import failure could not be finalized")
            raise
    finally:
        _close_connection(connection)
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


def iter_dvf_market_comparables(
    path: Path,
    *,
    source_url: str | None = None,
    limit: int | None = None,
) -> Iterator[dict[str, object]]:
    """Yield canonical free-market ``Vente`` rows without any database write.

    This is deliberately separate from the adjudication candidate stream.
    Unsupported mutation natures, including VEFA, never enter this iterator.
    """
    options = DvfImportOptions(
        path=path,
        source_url=source_url,
        limit=limit,
        dry_run=True,
    )
    summary = DvfImportSummary(file_name=path.name)
    yield from _iter_canonical_transactions(
        _iter_normalized_transactions(iter_dvf_rows(path), options, summary),
        summary,
    )


def inspect_dvf_source(path: Path) -> DvfSourceArtifact:
    """Content-address a local DVF source and list its data members."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)

    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            members = tuple(
                sorted(
                    name
                    for name in archive.namelist()
                    if not name.endswith("/") and Path(name).suffix.lower() in TEXT_EXTENSIONS
                )
            )
    else:
        members = (path.name,)
    return DvfSourceArtifact(
        file_name=path.name,
        sha256=digest.hexdigest(),
        members=members,
    )


def normalize_dvf_row(
    row: dict[str, str],
    *,
    source_url: str | None = None,
    mutation_markers: tuple[str, ...] = DVF_MARKET_MUTATION_MARKERS,
) -> dict[str, object] | None:
    mutation_nature = clean_text(first_value(row, "nature_mutation", "libnatmut"))
    accepted_natures = {marker.casefold() for marker in mutation_markers}
    if not mutation_nature or mutation_nature.casefold() not in accepted_natures:
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
    parcel_id = clean_text(first_value(row, "id_parcelle", "l_idpar")) or build_official_dvf_parcel_id(row)
    if not source_mutation_id:
        source_mutation_id = stable_mutation_id(row)

    address = compact_address(
        [
            first_value(row, "adresse_numero", "numero_voie", "no_voie"),
            first_value(row, "adresse_suffixe", "suffixe", "b/t/q"),
            official_dvf_street_name(row),
        ]
    )
    postal_code = clean_text(first_value(row, "code_postal", "postal_code"))
    department = clean_text(first_value(row, "code_departement", "department")) or department_from_postal_code(
        postal_code
    )
    raw_payload = {
        key: row[key]
        for key in (
            "numero_disposition",
            "no_disposition",
            "code_nature_culture",
            "nature_culture",
            "ancien_id_parcelle",
        )
        if row.get(key) not in ("", None)
    }
    lot_aliases = (
        ("lot1_numero", "1er_lot"),
        ("lot2_numero", "2eme_lot"),
        ("lot3_numero", "3eme_lot"),
        ("lot4_numero", "4eme_lot"),
        ("lot5_numero", "5eme_lot"),
    )
    lot_numbers = [
        lot_number
        for aliases in lot_aliases
        if (lot_number := clean_text(first_value(row, *aliases))) is not None
    ]
    if lot_numbers:
        raw_payload["lot_numbers"] = lot_numbers

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
        "rooms_count": nonnegative_int_value(first_value(row, "nombre_pieces_principales", "nb_pieces_principales")),
        "lots_count": nonnegative_int_value(first_value(row, "nombre_lots", "nombre_de_lots", "nb_lots")),
        "address": address,
        "city": clean_text(first_value(row, "nom_commune", "commune", "city")),
        "postal_code": postal_code,
        "insee_code": build_official_dvf_insee_code(row),
        "department": department,
        "parcel_id": parcel_id,
        "latitude": decimal_value(first_value(row, "latitude", "lat")),
        "longitude": decimal_value(first_value(row, "longitude", "lon")),
        "raw_payload": raw_payload,
    }


def _iter_normalized_transactions(
    rows: Iterator[dict[str, str]],
    options: DvfImportOptions,
    summary: DvfImportSummary,
) -> Iterator[dict[str, object]]:
    current_group_signature: tuple[str, ...] | None = None
    current_derived_mutation_id: str | None = None

    for row in rows:
        if options.limit is not None and summary.parsed_rows >= options.limit:
            break
        summary.parsed_rows += 1
        explicit_mutation_id = clean_text(first_value(row, "id_mutation", "idmutinvar"))
        if explicit_mutation_id is None:
            group_signature = raw_dvf_mutation_group_signature(row)
            if group_signature != current_group_signature:
                # The raw annual export has no durable mutation id. The
                # 1-based source record anchor prevents distinct contiguous
                # groups from colliding while keeping memory bounded.
                identity_signature = (
                    *raw_dvf_mutation_identity_signature(row),
                    f"source_record:{summary.parsed_rows}",
                )
                current_derived_mutation_id = derived_dvf_mutation_id(
                    identity_signature,
                    occurrence=1,
                )
                current_group_signature = group_signature
        else:
            current_group_signature = None
            current_derived_mutation_id = None
        if summary.parsed_rows % 250_000 == 0:
            LOGGER.info(
                "DVF progress: parsed=%s valid=%s canonical=%s skipped=%s",
                summary.parsed_rows,
                summary.valid_rows,
                summary.canonical_rows,
                summary.skipped_rows,
            )
        try:
            transaction = normalize_dvf_row(row, source_url=options.source_url)
        except Exception as exc:
            summary.skipped_rows += 1
            summary.errors.append(f"row {summary.parsed_rows}: {exc}")
            continue
        if transaction is None:
            summary.skipped_rows += 1
            continue
        if explicit_mutation_id is None:
            transaction["source_mutation_id"] = current_derived_mutation_id
        summary.valid_rows += 1
        yield transaction


def _iter_canonical_transactions(
    transactions: Iterator[dict[str, object]],
    summary: DvfImportSummary,
) -> Iterator[dict[str, object]]:
    """Collapse the source's repeated local/parcel lines to one mutation row.

    The official geolocated DVF resource is ordered by mutation identifier and
    repeats the mutation price for every local and parcel line. Keeping those
    rows separately both inflates storage and gives complex sales excessive
    statistical weight. Mutations containing more than one distinct built
    property are deliberately excluded because the shared price cannot be
    allocated reliably between them.
    """

    group: list[dict[str, object]] = []
    current_mutation_id: str | None = None

    for transaction in transactions:
        mutation_id = str(transaction["source_mutation_id"])
        if group and mutation_id != current_mutation_id:
            canonical = canonicalize_dvf_transaction_group(group)
            if canonical is None:
                summary.skipped_complex_mutations += 1
                summary.collapsed_rows += len(group)
            else:
                summary.collapsed_rows += len(group) - 1
                summary.canonical_rows += 1
                yield canonical
            group = []
        group.append(transaction)
        current_mutation_id = mutation_id

    if not group:
        return
    canonical = canonicalize_dvf_transaction_group(group)
    if canonical is None:
        summary.skipped_complex_mutations += 1
        summary.collapsed_rows += len(group)
        return
    summary.collapsed_rows += len(group) - 1
    summary.canonical_rows += 1
    yield canonical


def canonicalize_dvf_transaction_group(
    transactions: list[dict[str, object]],
) -> dict[str, object] | None:
    if not transactions:
        return None

    sale_dates = {transaction.get("sale_date") for transaction in transactions}
    prices = {transaction.get("total_price_eur") for transaction in transactions}
    if len(sale_dates) != 1 or len(prices) != 1:
        return None

    built_transactions: dict[tuple[object, ...], dict[str, object]] = {}
    land_transactions: list[dict[str, object]] = []
    for transaction in transactions:
        code = transaction.get("dvf_property_type_code")
        if code == "211":
            land_transactions.append(transaction)
            continue
        if transaction.get("built_surface_m2") is None:
            continue
        raw_payload = transaction.get("raw_payload")
        lots = ()
        if isinstance(raw_payload, dict):
            raw_lots = raw_payload.get("lot_numbers")
            if isinstance(raw_lots, list):
                lots = tuple(str(value) for value in raw_lots)
        signature = (
            code,
            transaction.get("parcel_id"),
            transaction.get("built_surface_m2"),
            transaction.get("rooms_count"),
            transaction.get("address"),
            lots,
        )
        built_transactions.setdefault(signature, transaction)

    if len(built_transactions) > 1:
        return None
    if built_transactions:
        representative = next(iter(built_transactions.values()))
    elif land_transactions:
        representative = max(
            land_transactions,
            key=lambda transaction: transaction.get("land_surface_m2") or Decimal(0),
        )
    else:
        return None

    canonical = dict(representative)
    parcel_ids = sorted({str(parcel_id) for transaction in transactions if (parcel_id := transaction.get("parcel_id"))})
    canonical["parcel_id"] = representative.get("parcel_id") or (parcel_ids[0] if parcel_ids else None)
    canonical["land_surface_m2"] = _aggregate_land_surface(transactions)
    latitude, longitude = _aggregate_coordinates(transactions)
    canonical["latitude"] = latitude
    canonical["longitude"] = longitude
    canonical["lots_count"] = max(
        (int(value) for transaction in transactions if (value := transaction.get("lots_count")) is not None),
        default=None,
    )

    raw_payload = dict(canonical.get("raw_payload") or {})
    if len(transactions) > 1:
        raw_payload["source_row_count"] = len(transactions)
    if len(parcel_ids) > 1:
        raw_payload["parcel_ids"] = parcel_ids
    canonical["raw_payload"] = raw_payload
    return canonical


def _aggregate_land_surface(transactions: list[dict[str, object]]) -> Decimal | None:
    surfaces_by_parcel: dict[str, Decimal] = {}
    for transaction in transactions:
        surface = transaction.get("land_surface_m2")
        if not isinstance(surface, Decimal):
            continue
        parcel_key = str(transaction.get("parcel_id") or "__unidentified__")
        surfaces_by_parcel[parcel_key] = max(surfaces_by_parcel.get(parcel_key, Decimal(0)), surface)
    return sum(surfaces_by_parcel.values(), Decimal(0)) if surfaces_by_parcel else None


def _aggregate_coordinates(
    transactions: list[dict[str, object]],
) -> tuple[Decimal | None, Decimal | None]:
    coordinates = {
        (latitude, longitude)
        for transaction in transactions
        if isinstance((latitude := transaction.get("latitude")), Decimal)
        and isinstance((longitude := transaction.get("longitude")), Decimal)
    }
    if not coordinates:
        return None, None
    latitude = sum((coordinate[0] for coordinate in coordinates), Decimal(0)) / len(coordinates)
    longitude = sum((coordinate[1] for coordinate in coordinates), Decimal(0)) / len(coordinates)
    return latitude, longitude


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


def official_dvf_street_name(row: dict[str, str]) -> str | None:
    explicit = clean_text(first_value(row, "adresse_nom_voie"))
    if explicit:
        return explicit
    return compact_address(
        [
            first_value(row, "type_de_voie"),
            first_value(row, "voie"),
        ]
    )


def raw_dvf_mutation_group_signature(row: dict[str, str]) -> tuple[str, ...]:
    """Best available contiguous grouping key for raw DGFiP exports.

    Raw annual DVF archives do not expose a durable mutation identifier. The
    signature therefore remains explicitly derived and must only be used while
    rows are in their official source order.
    """
    price = decimal_value(first_value(row, "valeur_fonciere", "valeurfonc"))
    return (
        clean_text(first_value(row, "date_mutation", "datemut")) or "",
        format(price, "f") if price is not None else "",
        clean_text(first_value(row, "nature_mutation", "libnatmut")) or "",
        clean_text(first_value(row, "no_disposition", "numero_disposition")) or "",
        clean_text(first_value(row, "identifiant_de_document", "identifiant_document")) or "",
        clean_text(first_value(row, "reference_document")) or "",
        clean_text(first_value(row, "code_departement")) or "",
        clean_text(first_value(row, "code_commune", "insee_code")) or "",
    )


def raw_dvf_mutation_identity_signature(row: dict[str, str]) -> tuple[str, ...]:
    """Return the price-free part of the derived source identity.

    Keeping price out lets a corrected official amount version the same source
    candidate instead of manufacturing a new identity.
    """
    group_signature = raw_dvf_mutation_group_signature(row)
    return (
        group_signature[0],
        *group_signature[2:],
        build_official_dvf_parcel_id(row) or "",
        clean_text(first_value(row, "no_voie", "adresse_numero", "numero_voie")) or "",
        clean_text(first_value(row, "b/t/q", "adresse_suffixe", "suffixe")) or "",
        official_dvf_street_name(row) or "",
        clean_text(first_value(row, "1er_lot", "lot1_numero")) or "",
        clean_text(first_value(row, "identifiant_local")) or "",
    )


def derived_dvf_mutation_id(
    identity_signature: tuple[str, ...],
    *,
    occurrence: int,
) -> str:
    if occurrence < 1:
        raise ValueError("DVF mutation occurrence must be positive")
    payload = json.dumps(
        {
            "identity_signature": identity_signature,
            "occurrence": occurrence,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return f"dvf-derived:{hashlib.sha256(payload.encode()).hexdigest()[:32]}"


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
    if code == "4" or any(token in text for token in ("local industriel", "local commercial", "commerce", "bureau")):
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


def build_official_dvf_insee_code(row: dict[str, str]) -> str | None:
    explicit = clean_text(first_value(row, "insee_code", "code_insee"))
    if explicit:
        return explicit
    commune = clean_text(first_value(row, "code_commune"))
    department = clean_text(first_value(row, "code_departement"))
    if not commune:
        return None
    if len(commune) >= 5 or not department:
        return commune
    return f"{department}{commune.zfill(3)}"


def build_official_dvf_parcel_id(row: dict[str, str]) -> str | None:
    department = clean_text(first_value(row, "code_departement"))
    commune = clean_text(first_value(row, "code_commune"))
    section = clean_text(first_value(row, "section"))
    plan = clean_text(first_value(row, "no_plan", "numero_plan"))
    if not department or not commune or not section or not plan:
        return None
    prefix = clean_text(first_value(row, "prefixe_de_section", "prefixe_section")) or "000"
    return f"{department}{commune.zfill(3)}{prefix.zfill(3)}{section.zfill(2)}{plan.zfill(4)}".upper()


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
                Jsonb(
                    {
                        "parsed_rows": summary.parsed_rows,
                        "valid_rows": summary.valid_rows,
                        "skipped_rows": summary.skipped_rows,
                        "collapsed_rows": summary.collapsed_rows,
                        "skipped_complex_mutations": summary.skipped_complex_mutations,
                        "canonical_rows": summary.canonical_rows,
                    }
                ),
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


def _finalize_failed_import(
    db_url: str,
    connection: Any,
    batch_id: str,
    error_message: str,
    *,
    restore_indexes: bool,
) -> None:
    """Persist a failed batch even when Supabase restarted the original session."""
    working_connection: Any | None = connection
    last_error: Exception | None = None

    for attempt, delay_seconds in enumerate(FAILURE_FINALIZATION_RETRY_DELAYS_SECONDS, start=1):
        if delay_seconds:
            time.sleep(delay_seconds)
        try:
            if working_connection is None:
                working_connection = _postgres_connect(db_url)
            else:
                try:
                    working_connection.rollback()
                except Exception:
                    _close_connection(working_connection)
                    working_connection = _postgres_connect(db_url)

            if restore_indexes:
                try:
                    _restore_dvf_indexes(working_connection)
                    working_connection.commit()
                except Exception as restore_exc:
                    try:
                        working_connection.rollback()
                    except Exception as rollback_exc:
                        raise restore_exc from rollback_exc
                    if _is_transient_postgres_error(restore_exc):
                        raise
                    LOGGER.exception("DVF index restoration failed after import error")

            _fail_import_batch(working_connection, batch_id, error_message)
            working_connection.commit()
            if working_connection is not connection:
                _close_connection(working_connection)
            return
        except Exception as exc:
            last_error = exc
            if working_connection is not None:
                _close_connection(working_connection)
            working_connection = None
            if (
                attempt >= len(FAILURE_FINALIZATION_RETRY_DELAYS_SECONDS)
                or not _is_transient_postgres_error(exc)
            ):
                break
            LOGGER.warning(
                "DVF failure finalization lost its database session; retrying (%s/%s): %s",
                attempt,
                len(FAILURE_FINALIZATION_RETRY_DELAYS_SECONDS),
                exc,
            )

    if last_error is not None:
        raise last_error


def _is_transient_postgres_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "administrator command",
            "cannot connect now",
            "connection has been closed",
            "connection is lost",
            "connection refused",
            "closed unexpectedly",
            "database system is starting up",
            "server closed the connection",
            "timeout expired",
        )
    )


def _close_connection(connection: Any) -> None:
    try:
        connection.close()
    except Exception:
        pass


def _prepare_staging_table(connection: Any, *, reset: bool) -> None:
    """Make dvf_transactions_staging ready to receive a full reload.

    The live table is never modified here: a full reload is loaded next to it
    and only swapped in once every file made it into the staging table.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "select exists(select 1 from public.dvf_transactions where source <> %s limit 1)",
            (DVF_SOURCE,),
        )
        row = cursor.fetchone()
        if row and bool(row[0]):
            raise RuntimeError("DVF replacement refused because the table contains another source.")
        if reset:
            for statement in build_staging_create_statements():
                cursor.execute(statement)
        else:
            cursor.execute("select to_regclass('public.dvf_transactions_staging') is not null")
            row = cursor.fetchone()
            if not row or not bool(row[0]):
                raise RuntimeError(
                    "dvf_transactions_staging does not exist; load the first file with --reset-staging."
                )
        cursor.execute("set synchronous_commit = off")
        cursor.execute("set statement_timeout = 0")
    connection.commit()


def build_staging_create_statements() -> list[str]:
    """Statements that recreate an empty, index-free copy of dvf_transactions."""
    return [
        f"drop table if exists public.{STAGING_TABLE}",
        f"""
        create table public.{STAGING_TABLE}
          (like public.{LIVE_TABLE} including defaults including constraints including generated)
        """,
    ]


def _dvf_index_statements(*, table: str, prefix: str) -> list[str]:
    """Query and integrity indexes for ``table``, named ``{prefix}<suffix>``."""
    unique_name = f"{prefix}source_mutation_uidx"
    return [
        f"""
        create unique index if not exists {unique_name}
          on public.{table} (source, source_mutation_id)
        """,
        f"""
        comment on index public.{unique_name} is
          'One canonical DVF transaction per source mutation; local and parcel source rows are aggregated by the importer.'
        """,
        f"""
        create index if not exists {prefix}sale_date_idx
          on public.{table} (sale_date desc)
        """,
        f"""
        create index if not exists {prefix}department_sale_date_idx
          on public.{table} (department, sale_date desc)
        """,
        f"""
        create index if not exists {prefix}lat_lng_idx
          on public.{table} (latitude, longitude)
          where latitude is not null and longitude is not null
        """,
    ]


STAGING_INDEX_SUFFIXES = (
    "source_mutation_uidx",
    "sale_date_idx",
    "department_sale_date_idx",
    "lat_lng_idx",
    "pkey",
)


def build_staging_index_statements() -> list[str]:
    """Indexes and constraints built on the staging table once it is fully loaded."""
    return [
        *_dvf_index_statements(table=STAGING_TABLE, prefix=f"{STAGING_TABLE}_"),
        f"alter table public.{STAGING_TABLE} add constraint {STAGING_TABLE}_pkey primary key (id)",
        # NOT VALID skips the scan of the loaded rows; the importer only writes
        # batch ids it has just created, and on delete set null stays enforced.
        f"""
        alter table public.{STAGING_TABLE}
          add constraint {LIVE_TABLE}_import_batch_id_fkey
          foreign key (import_batch_id) references public.dvf_import_batches(id)
          on delete set null not valid
        """,
        f"analyze public.{STAGING_TABLE}",
    ]


def build_swap_statements() -> list[str]:
    """Metadata-only statements run inside the single swap transaction."""
    rename_old_indexes = f"""
        do $swap$
        declare
          index_name text;
        begin
          for index_name in
            select indexname from pg_indexes
            where schemaname = 'public' and tablename = '{OLD_TABLE}'
          loop
            execute format('alter index public.%I rename to %I', index_name, index_name || '_old');
          end loop;
        end
        $swap$
    """
    statements = [
        "set local lock_timeout = '120s'",
        "set local statement_timeout = '15min'",
        f"drop table if exists public.{OLD_TABLE}",
        f"alter table public.{LIVE_TABLE} rename to {OLD_TABLE}",
        rename_old_indexes,
        f"alter table public.{STAGING_TABLE} rename to {LIVE_TABLE}",
    ]
    statements.extend(
        f"alter index public.{STAGING_TABLE}_{suffix} rename to {LIVE_TABLE}_{suffix}"
        for suffix in STAGING_INDEX_SUFFIXES
    )
    statements.extend(
        [
            f"alter table public.{LIVE_TABLE} enable row level security",
            f"revoke all on table public.{LIVE_TABLE} from anon, authenticated",
            f"grant select, insert, update, delete on table public.{LIVE_TABLE} to service_role",
            f"""
            comment on table public.{LIVE_TABLE} is
              'Canonical DVF mutations used by plan-gated comparable, backtest, and valuation services. Import provenance is stored once in dvf_import_batches.'
            """,
            f"drop table public.{OLD_TABLE}",
        ]
    )
    return statements


def swap_staging_into_live(connection: Any) -> None:
    """Replace dvf_transactions with the fully loaded staging table, atomically.

    Index builds happen before the swap, on the staging table, so readers of
    the live table are only blocked for the metadata statements. Any failure
    before the single commit leaves dvf_transactions untouched.
    """
    with connection.cursor() as cursor:
        cursor.execute(f"select exists(select 1 from public.{STAGING_TABLE} limit 1)")
        row = cursor.fetchone()
        if not row or not bool(row[0]):
            raise RuntimeError("DVF swap refused because the staging table is empty or missing.")
        cursor.execute(
            "select exists(select 1 from public.dvf_transactions where source <> %s limit 1)",
            (DVF_SOURCE,),
        )
        row = cursor.fetchone()
        if row and bool(row[0]):
            raise RuntimeError("DVF replacement refused because the table contains another source.")
        cursor.execute("set statement_timeout = 0")
        for statement in build_staging_index_statements():
            cursor.execute(statement)
    connection.commit()
    try:
        with connection.cursor() as cursor:
            for statement in build_swap_statements():
                cursor.execute(statement)
    except Exception:
        connection.rollback()
        raise
    connection.commit()


def _restore_dvf_indexes(connection: Any) -> None:
    """Build query and integrity indexes on the live table (recovery helper)."""
    with connection.cursor() as cursor:
        for statement in _dvf_index_statements(table=LIVE_TABLE, prefix=f"{LIVE_TABLE}_"):
            cursor.execute(statement)


def _commit_transaction_batch(
    connection: Any,
    batch_id: str,
    payload: list[dict[str, object]],
    summary: DvfImportSummary,
    *,
    replace_existing: bool = False,
) -> None:
    if replace_existing:
        _copy_transactions(connection, payload)
    else:
        _upsert_transactions(connection, payload)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            update public.dvf_import_batches
            set imported_rows = imported_rows + %s,
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                  'parsed_rows', %s,
                  'valid_rows', %s,
                  'skipped_rows', %s,
                  'collapsed_rows', %s,
                  'skipped_complex_mutations', %s,
                  'canonical_rows', %s
                ),
                updated_at = now()
            where id = %s
            """,
            (
                len(payload),
                summary.parsed_rows,
                summary.valid_rows,
                summary.skipped_rows,
                summary.collapsed_rows,
                summary.skipped_complex_mutations,
                summary.canonical_rows,
                batch_id,
            ),
        )
    connection.commit()
    summary.upserted_rows += len(payload)


def _copy_transactions(connection: Any, payload: list[dict[str, object]]) -> None:
    """COPY a batch into the staging table; replacement loads never touch the live table."""
    if not payload:
        return
    if sql is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    columns = list(DVF_TRANSACTION_COLUMNS)
    copy_statement = sql.SQL("copy public.{table} ({columns}) from stdin").format(
        table=sql.Identifier(STAGING_TABLE),
        columns=sql.SQL(", ").join(sql.Identifier(column) for column in columns),
    )
    with connection.cursor() as cursor:
        with cursor.copy(copy_statement) as copy:
            for row in payload:
                copy.write_row([postgres_value(row.get(column)) for column in columns])


def _upsert_transactions(connection: Any, payload: list[dict[str, object]]) -> None:
    if not payload:
        return
    if sql is None:
        raise RuntimeError("psycopg is required for direct Postgres writes")
    columns = list(DVF_TRANSACTION_COLUMNS)
    insert_statement = sql.SQL(
        """
        insert into public.dvf_transactions ({columns})
        values {values}
        on conflict (source, source_mutation_id) do update set {updates}
        """
    ).format(
        columns=sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        values=sql.SQL(", ").join(
            sql.SQL("({})").format(sql.SQL(", ").join(sql.Placeholder() for _ in columns)) for _ in payload
        ),
        updates=sql.SQL(", ").join(
            sql.SQL("{} = excluded.{}").format(sql.Identifier(column), sql.Identifier(column))
            for column in columns
            if column not in {"source", "source_mutation_id"}
        ),
    )
    values = [postgres_value(row.get(column)) for row in payload for column in columns]
    with connection.cursor() as cursor:
        cursor.execute(insert_statement, values)


def postgres_value(value: object) -> object:
    if isinstance(value, dict) and Jsonb is not None:
        return Jsonb(value)
    return value


def print_summary(summary: DvfImportSummary) -> None:
    print("DVF import summary")
    print(f"- file: {summary.file_name}")
    print(f"- source_artifact_sha256: {summary.source_artifact_sha256 or 'n/a'}")
    print(f"- source_members: {', '.join(summary.source_members) or 'n/a'}")
    print(f"- batch_id: {summary.batch_id or 'dry-run'}")
    print(f"- parsed_rows: {summary.parsed_rows}")
    print(f"- valid_rows: {summary.valid_rows}")
    print(f"- skipped_rows: {summary.skipped_rows}")
    print(f"- collapsed_rows: {summary.collapsed_rows}")
    print(f"- skipped_complex_mutations: {summary.skipped_complex_mutations}")
    print(f"- canonical_rows: {summary.canonical_rows}")
    print(f"- upserted_rows: {summary.upserted_rows}")
    print(f"- period: {summary.period_start or 'n/a'} -> {summary.period_end or 'n/a'}")
    if summary.errors:
        print(f"- errors: {len(summary.errors)}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importe un fichier DVF data.gouv dans Supabase.")
    parser.add_argument(
        "path",
        type=Path,
        nargs="?",
        help="Fichier DVF .txt/.csv ou archive .zip (absent avec --swap-staging).",
    )
    parser.add_argument("--source-url", default=None, help="URL officielle du fichier source DVF.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=None,
        help="Taille des lots d'upsert. Défaut: DVF_IMPORT_BATCH_SIZE ou 1000.",
    )
    parser.add_argument("--limit", type=int, default=None, help="Nombre maximum de lignes lues pour un test.")
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help=(
            "Remplace dvf_transactions par ce seul fichier : chargement dans dvf_transactions_staging "
            "puis échange atomique (incompatible avec --limit)."
        ),
    )
    parser.add_argument(
        "--stage",
        action="store_true",
        help="Charge le fichier dans dvf_transactions_staging sans toucher à dvf_transactions.",
    )
    parser.add_argument(
        "--reset-staging",
        action="store_true",
        help="Recrée dvf_transactions_staging avant le chargement (premier fichier d'un import multi-fichiers).",
    )
    parser.add_argument(
        "--swap-staging",
        action="store_true",
        help="Échange atomiquement dvf_transactions_staging et dvf_transactions (une seule fois, à la fin).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse et valide sans écrire dans Supabase.")
    args = parser.parse_args(argv)
    if args.swap_staging:
        if args.path is not None or args.stage or args.reset_staging or args.replace_existing:
            parser.error("--swap-staging s'utilise seul.")
    elif args.path is None:
        parser.error("path est requis sauf avec --swap-staging.")
    return args


def _run_swap_staging(dry_run: bool) -> int:
    if dry_run:
        print("DVF swap skipped (dry run).")
        return 0
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to swap the DVF staging table.")
    connection = _postgres_connect(str(db_url))
    try:
        swap_staging_into_live(connection)
    finally:
        _close_connection(connection)
    print("DVF staging table swapped into public.dvf_transactions.")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.swap_staging:
        return _run_swap_staging(args.dry_run)
    settings = load_settings()
    batch_size = args.batch_size or int(settings.get("dvf_import_batch_size") or DEFAULT_BATCH_SIZE)
    if (args.replace_existing or args.stage) and args.batch_size is None:
        batch_size = max(batch_size, DEFAULT_REPLACEMENT_BATCH_SIZE)
    summary = import_dvf_file(
        DvfImportOptions(
            path=args.path,
            source_url=args.source_url,
            batch_size=max(1, batch_size),
            limit=args.limit,
            replace_existing=args.replace_existing,
            dry_run=args.dry_run,
            stage=args.stage,
            reset_staging=args.reset_staging,
        )
    )
    print_summary(summary)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    raise SystemExit(main())
