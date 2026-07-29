from __future__ import annotations

import gzip
import zipfile
from datetime import date
from decimal import Decimal

import pytest

from src import dvf_import
from src.dvf_import import DvfImportOptions, import_dvf_file, iter_dvf_rows, normalize_dvf_row


def test_normalize_dvf_row_maps_official_columns() -> None:
    row = {
        "id_mutation": "2024-123",
        "date_mutation": "15/02/2024",
        "nature_mutation": "Vente",
        "valeur_fonciere": "210000,50",
        "adresse_numero": "12",
        "adresse_suffixe": "B",
        "adresse_nom_voie": "RUE DU TEST",
        "code_postal": "33000",
        "code_commune": "33063",
        "nom_commune": "Bordeaux",
        "code_departement": "33",
        "id_parcelle": "33063000AB0123",
        "nombre_lots": "1",
        "code_type_local": "2",
        "type_local": "Appartement",
        "surface_reelle_bati": "52",
        "nombre_pieces_principales": "3",
        "surface_terrain": "",
        "longitude": "-0,57918",
        "latitude": "44,83779",
    }

    transaction = normalize_dvf_row(row, source_url="https://data.gouv.fr/dvf")

    assert transaction is not None
    assert transaction["source_mutation_id"] == "2024-123"
    assert transaction["sale_date"] == date(2024, 2, 15)
    assert transaction["total_price_eur"] == Decimal("210000.50")
    assert transaction["built_surface_m2"] == Decimal("52")
    assert transaction["address"] == "12 B RUE DU TEST"
    assert transaction["postal_code"] == "33000"
    assert transaction["department"] == "33"
    assert transaction["parcel_id"] == "33063000AB0123"
    assert transaction["latitude"] == Decimal("44.83779")
    assert transaction["longitude"] == Decimal("-0.57918")
    assert transaction["source_url"] == "https://data.gouv.fr/dvf"
    assert transaction["dvf_property_type_code"] == "121"


def test_normalize_dvf_row_skips_non_sale_mutations() -> None:
    transaction = normalize_dvf_row(
        {
            "date_mutation": "2024-02-15",
            "nature_mutation": "Echange",
            "valeur_fonciere": "100000",
            "surface_reelle_bati": "50",
        }
    )

    assert transaction is None


def test_iter_dvf_rows_reads_pipe_delimited_file(tmp_path) -> None:
    path = tmp_path / "valeursfoncieres-2024.txt"
    path.write_text(
        "id_mutation|date_mutation|nature_mutation|valeur_fonciere\n2024-1|2024-02-15|Vente|200000\n",
        encoding="utf-8",
    )

    rows = list(iter_dvf_rows(path))

    assert rows == [
        {
            "id_mutation": "2024-1",
            "date_mutation": "2024-02-15",
            "nature_mutation": "Vente",
            "valeur_fonciere": "200000",
        }
    ]


def test_iter_dvf_rows_reads_zip_archives(tmp_path) -> None:
    archive_path = tmp_path / "dvf.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(
            "nested/valeursfoncieres.csv",
            "id_mutation;date_mutation;nature_mutation;valeur_fonciere\n2024-2;2024-03-20;Vente;180000\n",
        )

    rows = list(iter_dvf_rows(archive_path))

    assert rows[0]["id_mutation"] == "2024-2"
    assert rows[0]["valeur_fonciere"] == "180000"


def test_iter_dvf_rows_reads_geolocated_gzip(tmp_path) -> None:
    path = tmp_path / "dvf.csv.gz"
    with gzip.open(path, "wt", encoding="utf-8") as archive:
        archive.write(
            "id_mutation,date_mutation,nature_mutation,valeur_fonciere,longitude,latitude\n"
            "2025-1,2025-02-15,Vente,200000,-0.57918,44.83779\n"
        )

    rows = list(iter_dvf_rows(path))

    assert rows[0]["id_mutation"] == "2025-1"
    assert rows[0]["longitude"] == "-0.57918"


def test_normalize_dvf_row_turns_zero_surface_into_null_and_skips_dependency() -> None:
    transaction = normalize_dvf_row(
        {
            "id_mutation": "2025-dependency",
            "date_mutation": "2025-01-07",
            "nature_mutation": "Vente",
            "valeur_fonciere": "468000",
            "surface_reelle_bati": "0",
            "surface_terrain": "133",
            "code_type_local": "3",
            "type_local": "Dépendance",
        }
    )

    assert transaction is None


def test_normalize_dvf_row_maps_land_only_sale() -> None:
    transaction = normalize_dvf_row(
        {
            "id_mutation": "2025-land",
            "date_mutation": "2025-04-08",
            "nature_mutation": "Vente",
            "valeur_fonciere": "85000",
            "surface_reelle_bati": "",
            "surface_terrain": "720",
            "code_type_local": "",
            "type_local": "",
            "id_parcelle": "13013000AB0001",
        }
    )

    assert transaction is not None
    assert transaction["dvf_property_type_code"] == "211"
    assert transaction["land_surface_m2"] == Decimal("720")


def test_canonicalize_mutation_collapses_repeated_parcel_rows() -> None:
    house = normalize_dvf_row(
        {
            "id_mutation": "2026-1",
            "date_mutation": "2026-01-10",
            "nature_mutation": "Vente",
            "valeur_fonciere": "320000",
            "code_type_local": "1",
            "type_local": "Maison",
            "surface_reelle_bati": "110",
            "surface_terrain": "400",
            "id_parcelle": "33063000AB0001",
            "longitude": "-0.579",
            "latitude": "44.837",
        }
    )
    second_parcel = normalize_dvf_row(
        {
            "id_mutation": "2026-1",
            "date_mutation": "2026-01-10",
            "nature_mutation": "Vente",
            "valeur_fonciere": "320000",
            "surface_terrain": "200",
            "id_parcelle": "33063000AB0002",
            "longitude": "-0.578",
            "latitude": "44.838",
        }
    )

    assert house is not None
    assert second_parcel is not None
    canonical = dvf_import.canonicalize_dvf_transaction_group([house, second_parcel])

    assert canonical is not None
    assert canonical["source_mutation_id"] == "2026-1"
    assert canonical["dvf_property_type_code"] == "111"
    assert canonical["built_surface_m2"] == Decimal("110")
    assert canonical["land_surface_m2"] == Decimal("600")
    assert canonical["latitude"] == Decimal("44.8375")
    assert canonical["longitude"] == Decimal("-0.5785")
    assert canonical["raw_payload"]["parcel_ids"] == ["33063000AB0001", "33063000AB0002"]


def test_canonicalize_mutation_excludes_multi_property_sale() -> None:
    apartment = normalize_dvf_row(
        {
            "id_mutation": "2026-complex",
            "date_mutation": "2026-02-10",
            "nature_mutation": "Vente",
            "valeur_fonciere": "500000",
            "code_type_local": "2",
            "type_local": "Appartement",
            "surface_reelle_bati": "55",
            "id_parcelle": "75056000AB0001",
            "lot1_numero": "10",
        }
    )
    second_apartment = normalize_dvf_row(
        {
            "id_mutation": "2026-complex",
            "date_mutation": "2026-02-10",
            "nature_mutation": "Vente",
            "valeur_fonciere": "500000",
            "code_type_local": "2",
            "type_local": "Appartement",
            "surface_reelle_bati": "42",
            "id_parcelle": "75056000AB0001",
            "lot1_numero": "11",
        }
    )

    assert apartment is not None
    assert second_apartment is not None
    assert dvf_import.canonicalize_dvf_transaction_group([apartment, second_apartment]) is None


def test_upsert_transactions_uses_one_multi_row_statement() -> None:
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)
    payload = [
        {column: f"first-{column}" for column in dvf_import.DVF_TRANSACTION_COLUMNS},
        {column: f"second-{column}" for column in dvf_import.DVF_TRANSACTION_COLUMNS},
    ]

    dvf_import._upsert_transactions(connection, payload)

    assert len(cursor.calls) == 1
    assert len(cursor.calls[0][1]) == 2 * len(dvf_import.DVF_TRANSACTION_COLUMNS)
    assert cursor.calls[0][1][0] == "first-import_batch_id"
    assert cursor.calls[0][1][-1] == "second-longitude"


def test_copy_transactions_streams_rows_through_postgres_copy() -> None:
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)
    payload = [
        {column: f"first-{column}" for column in dvf_import.DVF_TRANSACTION_COLUMNS},
        {column: f"second-{column}" for column in dvf_import.DVF_TRANSACTION_COLUMNS},
    ]

    dvf_import._copy_transactions(connection, payload)

    assert len(cursor.copy_calls) == 1
    assert len(cursor.copy_calls[0].rows) == 2
    assert cursor.copy_calls[0].rows[0][0] == "first-import_batch_id"
    assert cursor.copy_calls[0].rows[1][-1] == "second-longitude"


def test_commit_transaction_batch_persists_progress_before_commit(monkeypatch) -> None:
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)
    summary = dvf_import.DvfImportSummary(
        file_name="dvf.csv.gz",
        parsed_rows=4,
        skipped_rows=2,
    )
    payload = [{"source_mutation_id": "2026-1"}, {"source_mutation_id": "2026-2"}]
    upserted: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        dvf_import,
        "_upsert_transactions",
        lambda received_connection, received_payload: upserted.append(received_payload),
    )

    dvf_import._commit_transaction_batch(connection, "batch-id", payload, summary)

    assert upserted == [payload]
    assert connection.commits == 1
    assert cursor.calls[0][1] == (2, 4, 0, 2, 0, 0, 0, "batch-id")
    assert summary.upserted_rows == 2


def test_commit_transaction_batch_uses_copy_for_replacement(monkeypatch) -> None:
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)
    summary = dvf_import.DvfImportSummary(file_name="dvf.csv.gz")
    payload = [{"source_mutation_id": "2026-1"}]
    copied: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        dvf_import,
        "_copy_transactions",
        lambda received_connection, received_payload: copied.append(received_payload),
    )
    monkeypatch.setattr(
        dvf_import,
        "_upsert_transactions",
        lambda received_connection, received_payload: (_ for _ in ()).throw(
            AssertionError("replacement imports must not use ON CONFLICT")
        ),
    )

    dvf_import._commit_transaction_batch(
        connection,
        "batch-id",
        payload,
        summary,
        replace_existing=True,
    )

    assert copied == [payload]
    assert connection.commits == 1
    assert summary.upserted_rows == 1


def test_prepare_replacement_import_refuses_other_sources() -> None:
    cursor = RecordingCursor(fetchone_row=(True,))
    connection = RecordingConnection(cursor)

    with pytest.raises(RuntimeError, match="another source"):
        dvf_import._prepare_replacement_import(connection)

    assert len(cursor.calls) == 1
    assert connection.commits == 0


def test_prepare_replacement_import_truncates_dvf_only_table() -> None:
    cursor = RecordingCursor(fetchone_row=(False,))
    connection = RecordingConnection(cursor)

    dvf_import._prepare_replacement_import(connection)

    assert len(cursor.calls) == 8
    assert connection.commits == 1


def test_restore_dvf_indexes_builds_integrity_and_query_indexes() -> None:
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)

    dvf_import._restore_dvf_indexes(connection)

    assert len(cursor.calls) == 4
    statements = " ".join(str(statement) for statement, _ in cursor.calls)
    assert "create unique index" in statements.lower()
    assert "dvf_transactions_lat_lng_idx" in statements


def test_finalize_failed_import_reconnects_after_administrator_restart(monkeypatch) -> None:
    original_connection = BrokenConnection()
    recovered_cursor = RecordingCursor()
    recovered_connection = RecordingConnection(recovered_cursor)
    restored: list[RecordingConnection] = []

    monkeypatch.setattr(
        dvf_import,
        "_postgres_connect",
        lambda _db_url: recovered_connection,
    )
    monkeypatch.setattr(
        dvf_import,
        "_restore_dvf_indexes",
        lambda connection: restored.append(connection),
    )

    dvf_import._finalize_failed_import(
        "postgresql://database",
        original_connection,
        "batch-id",
        "terminating connection due to administrator command",
        restore_indexes=True,
    )

    assert original_connection.closed
    assert restored == [recovered_connection]
    assert recovered_connection.commits == 2
    assert recovered_connection.closed
    assert recovered_cursor.calls[-1][1] == (
        "terminating connection due to administrator command",
        "batch-id",
    )


def test_import_dvf_file_dry_run_counts_valid_and_skipped_rows(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(dvf_import, "load_settings", lambda: {"supabase_db_url": None})
    path = tmp_path / "valeursfoncieres-2024.txt"
    path.write_text(
        "id_mutation|date_mutation|nature_mutation|valeur_fonciere|surface_reelle_bati|type_local\n"
        "2024-1|2024-02-15|Vente|200000|50|Appartement\n"
        "2024-2|2024-03-20|Echange|180000|45|Appartement\n"
        "2024-3|2024-04-10|Vente||40|Maison\n",
        encoding="utf-8",
    )

    summary = import_dvf_file(DvfImportOptions(path=path, dry_run=True))

    assert summary.parsed_rows == 3
    assert summary.valid_rows == 1
    assert summary.skipped_rows == 2
    assert summary.collapsed_rows == 0
    assert summary.skipped_complex_mutations == 0
    assert summary.canonical_rows == 1
    assert summary.upserted_rows == 0
    assert summary.period_start == date(2024, 2, 15)
    assert summary.period_end == date(2024, 2, 15)


class RecordingCursor:
    def __init__(self, *, fetchone_row: tuple[object, ...] | None = None) -> None:
        self.calls: list[tuple[object, object]] = []
        self.copy_calls: list[RecordingCopy] = []
        self.fetchone_row = fetchone_row

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None

    def execute(self, statement: object, values: object = None) -> None:
        self.calls.append((statement, values))

    def fetchone(self) -> tuple[object, ...] | None:
        return self.fetchone_row

    def executemany(self, statement: object, values: object) -> None:
        raise AssertionError("DVF imports must not use psycopg pipeline mode")

    def copy(self, statement: object) -> RecordingCopy:
        copy = RecordingCopy(statement)
        self.copy_calls.append(copy)
        return copy


class RecordingCopy:
    def __init__(self, statement: object) -> None:
        self.statement = statement
        self.rows: list[list[object]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None

    def write_row(self, row: list[object]) -> None:
        self.rows.append(row)


class RecordingConnection:
    def __init__(self, cursor: RecordingCursor) -> None:
        self._cursor = cursor
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self) -> RecordingCursor:
        return self._cursor

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def close(self) -> None:
        self.closed = True


class BrokenConnection:
    def __init__(self) -> None:
        self.closed = False

    def rollback(self) -> None:
        raise RuntimeError("connection is lost")

    def close(self) -> None:
        self.closed = True
