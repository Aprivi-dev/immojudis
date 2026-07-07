from __future__ import annotations

import zipfile
from datetime import date
from decimal import Decimal

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
        "id_mutation|date_mutation|nature_mutation|valeur_fonciere\n"
        "2024-1|2024-02-15|Vente|200000\n",
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
            "id_mutation;date_mutation;nature_mutation;valeur_fonciere\n"
            "2024-2;2024-03-20;Vente;180000\n",
        )

    rows = list(iter_dvf_rows(archive_path))

    assert rows[0]["id_mutation"] == "2024-2"
    assert rows[0]["valeur_fonciere"] == "180000"


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
    assert summary.upserted_rows == 0
    assert summary.period_start == date(2024, 2, 15)
    assert summary.period_end == date(2024, 2, 15)
