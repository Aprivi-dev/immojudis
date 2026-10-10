from __future__ import annotations

import gzip
import zipfile
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from src.reference_data import climate, communes, gaspar, storage
from src.reference_data.download import ReferenceDownloadError, validate_reference_url
from src.reference_data.names import department_from_insee, normalize_commune_name


def test_commune_names_are_normalized_like_the_web_lookup() -> None:
    assert normalize_commune_name("Saint-Étienne") == "saint etienne"
    assert normalize_commune_name("ST ETIENNE") == "saint etienne"
    assert normalize_commune_name("Ste-Foy-lès-Lyon") == "sainte foy les lyon"
    assert normalize_commune_name("L'Haÿ-les-Roses") == "l hay les roses"
    assert normalize_commune_name("Fontaine-St-Martin") == "fontaine saint martin"
    assert normalize_commune_name(None) == ""


def test_department_of_corsican_and_overseas_communes() -> None:
    assert department_from_insee("2A004") == "2A"
    assert department_from_insee("97411") == "974"
    assert department_from_insee("33063") == "33"


def test_only_allow_listed_https_hosts_are_downloaded() -> None:
    assert validate_reference_url("https://files.georisques.fr/GASPAR/gaspar.zip")
    for url in (
        "http://files.georisques.fr/GASPAR/gaspar.zip",
        "https://example.com/gaspar.zip",
        "https://user:pass@geo.api.gouv.fr/communes",
    ):
        with pytest.raises(ReferenceDownloadError):
            validate_reference_url(url)


def test_communes_keep_valid_codes_postal_codes_and_centre() -> None:
    rows = communes.normalize_communes(
        [
            {
                "code": "33063",
                "nom": "Bordeaux",
                "codeDepartement": "33",
                "codesPostaux": ["33100", "33000", "bad"],
                "centre": {"type": "Point", "coordinates": [-0.5874, 44.8572]},
            },
            {"code": "XXXXX", "nom": "Invalide", "codeDepartement": "33"},
            {"code": "2A004", "nom": "Ajaccio", "codeDepartement": "2A", "codesPostaux": ["20000"]},
        ]
    )

    assert [row["code_insee"] for row in rows] == ["33063", "2A004"]
    assert rows[0]["postal_codes"] == ["33000", "33100"]
    assert (rows[0]["latitude"], rows[0]["longitude"]) == (44.8572, -0.5874)
    assert rows[1]["latitude"] is None and rows[1]["name_normalized"] == "ajaccio"


def test_fetch_communes_walks_every_department() -> None:
    calls: list[str] = []

    def fake_fetch(url: str):
        calls.append(url)
        if url.endswith("/departements?fields=code"):
            return [{"code": "2A"}, {"code": "33"}, {"code": "ZZ"}]
        return [
            {
                "code": "33063" if "/33/" in url else "2A004",
                "nom": "X",
                "codeDepartement": "33" if "/33/" in url else "2A",
            }
        ]

    rows = communes.fetch_communes(fake_fetch)

    assert len(rows) == 2
    assert len(calls) == 3


def _gaspar_archive(path: Path) -> Path:
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.writestr(
            "ddrm_risq_gaspar_2026-10-05.csv",
            "cod_commune;lib_commune;lib_risque;num_risque\r\n"
            "33063;Bordeaux;Séisme;13\r\n"
            "33063;Bordeaux;Par une crue à débordement lent de cours d'eau;112\r\n"
            "33063;Bordeaux;Inondation;11\r\n"
            "33063;Bordeaux;Risque industriel;21\r\n",
        )
        bundle.writestr(
            "catnat_gaspar_2026-10-05.csv",
            "id_gaspar;code_commune;libelle_commune;num_risque_jo;lib_risque_jo;date_debut;date_fin;"
            "date_signature_arrete;date_publication_jo;date_modification\r\n"
            "A1;33063;Bordeaux;ICB;Inondations et/ou Coulées de Boue;1999-12-25 12:00:00;1999-12-29 12:00:00;"
            "1999-12-29 12:00:00;1999-12-30 12:00:00;\r\n"
            "A1;33063;Bordeaux;ICB;Inondations et/ou Coulées de Boue;1999-12-25 12:00:00;1999-12-29 12:00:00;"
            "1999-12-29 12:00:00;1999-12-30 12:00:00;\r\n"
            "A2;33063;Bordeaux;SEC;Sécheresse;2022-07-01 00:00:00;2022-09-30 00:00:00;2023-04-03 00:00:00;"
            "2023-05-03 00:00:00;\r\n"
            "A3;37100;Ã‰peignÃ©-les-Bois;MVT;Mouvement de Terrain;1999-12-25 12:00:00;;;;\r\n",
        )
        header = (
            "CODE MODELE;LIBELLE MODELE;CODE PROCEDURE;LIBELLE PROCEDURE;CODE INSEE COMMUNE;NOM COMMUNE;"
            "LIBELLE RISQUE 2;LIBELLE RISQUE 3;PRESCRIPTION;APPROBATION;LIBELLE ETAT;LIBELLE SOUS-ETAT\r\n"
        )
        bundle.writestr(
            "pprn_gaspar_2026-10-05.csv",
            header + "PPRN-I;PPRN Inondation;P1;PPR Bordeaux;33063;Bordeaux;Inondation;Par submersion marine;"
            "2012-03-02;2023-12-05;Opposable;Approuvé\r\n"
            + "PPRN-I;PPRN Inondation;P1;PPR Bordeaux;33063;Bordeaux;Inondation;Par une crue lente;"
            "2012-03-02;2023-12-05;Opposable;Approuvé\r\n"
            + "PPRN-I;PPRN Inondation;P0;PSS Bordeaux;33063;Bordeaux;Inondation;;1964-08-06;1964-08-06;"
            "Caduque;Abrogé\r\n",
        )
    return path


def test_gaspar_profiles_group_risks_decrees_and_active_plans(tmp_path: Path) -> None:
    profiles, snapshot = gaspar.build_risk_profiles(_gaspar_archive(tmp_path / "gaspar.zip"))
    by_code = {profile["code_insee"]: profile for profile in profiles}

    assert snapshot == date(2026, 10, 5)
    bordeaux = by_code["33063"]
    assert [risk["code"] for risk in bordeaux["risks"]] == ["11", "112", "13", "21"]
    assert bordeaux["catnat_total"] == 2  # the duplicated A1 line counts once
    assert bordeaux["catnat_recent"][0]["code"] == "SEC"
    assert bordeaux["catnat_recent"][0]["start"] == "2022-07-01"
    assert [plan["label"] for plan in bordeaux["prevention_plans"]] == ["PPR Bordeaux"]
    assert bordeaux["prevention_plans"][0]["risks"] == ["Par submersion marine", "Par une crue lente"]
    assert by_code["37100"]["commune_name"] == "Épeigné-les-Bois"


def _climate_file(path: Path, rows: list[str]) -> Path:
    header = "NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMM;RR;QRR;NBRR;TM;QTM;NBTM;TN;QTN;NBTN;TX;QTX;NBTX;INST;QINST;NBINST;NBJRR1;NBJGELEE;NBJTX30"
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join([header, *rows]) + "\n")
    return path


def test_climate_rows_drop_doubtful_incomplete_and_old_months(tmp_path: Path) -> None:
    path = _climate_file(
        tmp_path / "MENSQ_33_latest-2025-2026.csv.gz",
        [
            "33281001;BORDEAUX-MERIGNAC;44.8307;-0.6913;47;202501;143.1;1;31;7.5;1;31;3.3;1;31;11.7;1;31;4200;9;31;18;10;0",
            "33281001;BORDEAUX-MERIGNAC;44.8307;-0.6913;47;202502;62.7;2;28;8.0;1;20;4.6;1;28;15.3;1;28;;;0;9;4;0",
            "33281001;BORDEAUX-MERIGNAC;44.8307;-0.6913;47;201512;10.0;1;31;9.0;1;31;;;;;;;;;;3;;",
            "33999001;FERMEE;44.0;-0.5;10;201601;50.0;1;31;;;;;;;;;;;;;5;;",
        ],
    )
    stations: dict[str, climate.ClimateStationAccumulator] = {}
    climate.parse_climate_file(path, "33", stations)

    merignac = stations["33281001"]
    assert sorted(merignac.months) == [date(2025, 1, 1), date(2025, 2, 1)]
    january = merignac.months[date(2025, 1, 1)]
    assert january["precipitation_mm"] == Decimal("143.1")
    assert january["sunshine_minutes"] == 4200
    assert (january["rain_days"], january["frost_days"], january["hot_days"]) == (18, 10, 0)
    february = merignac.months[date(2025, 2, 1)]
    assert february["precipitation_mm"] is None  # quality code 2 = doubtful
    assert february["rain_days"] is None
    assert february["mean_temperature_c"] is None  # 20 of 28 days observed
    assert february["mean_max_temperature_c"] == Decimal("15.3")

    active = climate.active_stations(stations, active_since=date(2025, 1, 1))
    assert [station.station_id for station in active] == ["33281001"]
    row = next(climate.station_rows(active))
    assert row["has_sunshine"] and row["has_temperature"] and row["last_month"] == date(2025, 2, 1)


def test_climate_listing_follows_pagination_and_ignores_other_files() -> None:
    pages = [
        "<ListBucketResult><IsTruncated>true</IsTruncated>"
        "<Key>data/synchro_ftp/BASE/MENS/MENSQ_01_avant-1949.csv.gz</Key>"
        "<Key>data/synchro_ftp/BASE/MENS/MENSQ_01_latest-2025-2026.csv.gz</Key></ListBucketResult>",
        "<ListBucketResult><IsTruncated>false</IsTruncated>"
        "<Key>data/synchro_ftp/BASE/MENS/MENSQ_971_previous-1950-2024.csv.gz</Key>"
        "<Key>data/synchro_ftp/BASE/MENS/MENSQ_descriptif_champs.csv</Key></ListBucketResult>",
    ]
    urls: list[str] = []

    def fake_fetch(url: str) -> str:
        urls.append(url)
        return pages[len(urls) - 1]

    files = climate.list_climate_files(fake_fetch)

    assert [(item.department, item.name) for item in files] == [
        ("01", "MENSQ_01_latest-2025-2026.csv.gz"),
        ("971", "MENSQ_971_previous-1950-2024.csv.gz"),
    ]
    assert "marker=" in urls[1]


def test_upsert_statement_targets_the_primary_key() -> None:
    statement = storage.upsert_statement("climate_station_months")

    assert "on conflict (station_id, month)" in statement
    assert "jsonb_to_recordset" in statement
    assert "imported_at" not in statement
    assert "imported_at = now()" in storage.upsert_statement("commune_risk_profiles")


def test_each_write_sets_its_own_statement_timeout() -> None:
    executed: list[str] = []

    class Cursor:
        rowcount = 0

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, statement, params=None):
            executed.append(statement)

    class Connection:
        commits = 0

        def cursor(self):
            return Cursor()

        def commit(self):
            self.commits += 1

    connection = Connection()
    rows = [{"code_insee": f"{index:05d}"} for index in range(2_500)]

    assert storage.upsert_rows(connection, "reference_communes", rows) == 2_500
    assert connection.commits == 3
    assert executed[0::2] == ["set local statement_timeout = '5min'"] * 3
