from __future__ import annotations

import csv
from pathlib import Path

import pytest

from src.official_sources.justice_open_data import (
    COMPETENCE_SCHEMA,
    JUSTICE_COMPETENCES_DATASET_URL,
    JUSTICE_STRUCTURES_DATASET_URL,
    STRUCTURE_SCHEMA,
    JusticeOpenDataSchemaError,
    parse_justice_competences_csv,
    parse_justice_open_data_csv,
    parse_justice_structures_csv,
)

RAW_ROOT = Path(__file__).parents[1] / "data" / "raw" / "outcome_sources" / "justice_courts"


def _write_csv(
    path: Path,
    headers: tuple[str, ...],
    rows: list[dict[str, str]],
    *,
    delimiter: str = ";",
    encoding: str = "utf-8",
) -> None:
    with path.open("w", encoding=encoding, newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, delimiter=delimiter)
        writer.writeheader()
        writer.writerows(rows)


def _competence_row(**overrides: str) -> dict[str, str]:
    row = {
        "Commune": "01001",
        "Libellé Commune": "L ABERGEMENT CLEMENCIAT",
        "Orig. CA": "1",
        "N° CA": "23",
        "Cour d'Appel compétente": "Cour d'Appel de Lyon",
        "Orig. TJ": "1",
        "N° TJ": "39",
        "Tribunal judiciaire compétent": "Tribunal judiciaire de Bourg-en-Bresse",
        "Orig. TPRX": "9",
        "N° TPRX": "63071",
        "Tribunal de proximité compétent": "Tribunal de proximité de Trévoux",
        "Orig. CPH": "1",
        "N° CPH": "937",
        "Conseil de Prud'hommes compétent": "Conseil de Prud'hommes de Bourg-en-Bresse",
    }
    row.update(overrides)
    return row


def _structure_row(**overrides: str) -> dict[str, str]:
    row = {
        "TYPE": "TGI",
        "CODE_INSEE": "10387",
        "CODE_ORIG": "1",
        "NUM": "53",
        "NOM_ETABLISSEMENT": "Tribunal judiciaire de Troyes",
        "NUMÉRO_ET_LIBELLÉ_VOIE": "83 RUE DU GENERAL DE GAULLE",
        "LIEU_DIT": "",
        "CODE_POSTAL": "10000",
        "LIGNE_D_ACHEMINEMENT": "TROYES",
        "PAYS_OU_DÉNOMINATION_TOM_COM": "",
        "COORDONNÉES_X": "4.069397",
        "COORDONNÉES_Y": "48.297172",
        "NU_TEL": "0325435570",
        "ADRESSE_MAIL": "tj-troyes@justice.fr",
    }
    row.update(overrides)
    return row


def test_parse_competence_detects_delimiter_and_preserves_srj_codes(tmp_path: Path) -> None:
    path = tmp_path / "competences.csv"
    _write_csv(path, COMPETENCE_SCHEMA, [_competence_row()], delimiter="|")

    result = parse_justice_open_data_csv(path)

    assert result.quality.dataset_kind == "justice_court_competence"
    assert result.quality.detected_delimiter == "|"
    assert result.quality.detected_encoding == "utf-8"
    assert result.quality.total_rows == result.quality.valid_rows == 1
    record = result.records[0]
    assert record["stable_id"] == "justice_open_data:competence:01001"
    assert record["insee_code"] == "01001"
    assert record["ca_origin_code"] == "1"
    assert record["ca_srj_code"] == "23"
    assert record["tj_origin_code"] == "1"
    assert record["tj_srj_code"] == "39"
    assert record["tprx_srj_code"] == "63071"
    assert record["source_url"] == JUSTICE_COMPETENCES_DATASET_URL
    assert len(record["canonical_hash"]) == 64


def test_parse_competence_accepts_corsican_insee_and_optional_tprx(tmp_path: Path) -> None:
    path = tmp_path / "corsica.csv"
    row = _competence_row(
        Commune="2A001",
        **{
            "Orig. TPRX": "",
            "N° TPRX": "",
            "Tribunal de proximité compétent": "",
        },
    )
    _write_csv(path, COMPETENCE_SCHEMA, [row])

    result = parse_justice_competences_csv(path)

    assert result.records[0]["insee_code"] == "2A001"
    assert result.records[0]["tprx_srj_code"] is None
    assert result.quality.null_counts["N° TPRX"] == 1


def test_parse_structures_detects_cp1252_and_builds_address(tmp_path: Path) -> None:
    path = tmp_path / "structures.csv"
    _write_csv(
        path,
        STRUCTURE_SCHEMA,
        [_structure_row(NOM_ETABLISSEMENT="Tribunal judiciaire de Très-sur-Aube")],
        encoding="cp1252",
    )

    result = parse_justice_structures_csv(path)

    assert result.quality.detected_encoding == "cp1252"
    record = result.records[0]
    assert record["record_type"] == "justice_court_structure"
    assert record["srj_code"] == "53"
    assert record["longitude"] == pytest.approx(4.069397)
    assert record["latitude"] == pytest.approx(48.297172)
    assert record["full_address"] == "83 RUE DU GENERAL DE GAULLE, 10000, TROYES"
    assert record["source_url"] == JUSTICE_STRUCTURES_DATASET_URL


def test_duplicate_and_partial_reference_are_reported_without_overwrite(tmp_path: Path) -> None:
    path = tmp_path / "quality.csv"
    valid = _competence_row()
    partial = _competence_row(Commune="01002", **{"N° TPRX": ""})
    _write_csv(path, COMPETENCE_SCHEMA, [valid, valid, partial])

    result = parse_justice_competences_csv(path)

    assert len(result.records) == 1
    assert result.quality.total_rows == 3
    assert result.quality.valid_rows == 1
    assert result.quality.duplicate_rows == 1
    assert result.quality.rejected_rows == 1
    assert result.quality.anomaly_counts["partial_proximity_court_reference"] == 1


def test_canonical_hash_is_independent_of_header_order_and_delimiter(tmp_path: Path) -> None:
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"
    reversed_schema = tuple(reversed(COMPETENCE_SCHEMA))
    _write_csv(first, COMPETENCE_SCHEMA, [_competence_row()], delimiter=";")
    _write_csv(second, reversed_schema, [_competence_row()], delimiter=",")

    first_record = parse_justice_open_data_csv(first).records[0]
    second_record = parse_justice_open_data_csv(second).records[0]

    assert first_record["stable_id"] == second_record["stable_id"]
    assert first_record["canonical_hash"] == second_record["canonical_hash"]


@pytest.mark.parametrize(
    "payload",
    [
        "<!doctype html><html><body>download failed</body></html>",
        "Commune;Libellé Commune;Prix;Résultat\n01001;TEST;100000;adjugé\n",
    ],
)
def test_deceptive_downloads_are_rejected(tmp_path: Path, payload: str) -> None:
    path = tmp_path / "looks-like-data.csv"
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(JusticeOpenDataSchemaError):
        parse_justice_open_data_csv(path)


def test_wrong_supported_schema_is_rejected_by_specific_parser(tmp_path: Path) -> None:
    path = tmp_path / "structures.csv"
    _write_csv(path, STRUCTURE_SCHEMA, [_structure_row()])

    with pytest.raises(JusticeOpenDataSchemaError, match="expected justice_court_competence"):
        parse_justice_competences_csv(path)


def test_observed_downloads_are_fully_parsed_when_available() -> None:
    competences = RAW_ROOT / "resource-e2a1941b-observed-competences.csv"
    structures = RAW_ROOT / "2026-domaine-juridique-adresse.csv"
    failed_download = RAW_ROOT / "resource-88bda661-download-failed.html"
    if not competences.exists() or not structures.exists():
        pytest.skip("local raw open-data downloads are not present")

    competence_result = parse_justice_competences_csv(competences)
    structure_result = parse_justice_structures_csv(structures)

    assert competence_result.quality.total_rows == 35_029
    assert competence_result.quality.valid_rows == 35_029
    assert competence_result.quality.rejected_rows == 0
    assert structure_result.quality.total_rows == 1_470
    assert structure_result.quality.valid_rows == 1_470
    assert structure_result.quality.null_counts["ADRESSE_MAIL"] == 788
    if failed_download.exists():
        with pytest.raises(JusticeOpenDataSchemaError, match="HTML"):
            parse_justice_open_data_csv(failed_download)
