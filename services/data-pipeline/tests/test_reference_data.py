from __future__ import annotations

import gzip
import zipfile
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from src.reference_data import __main__ as reference_main
from src.reference_data import climate, communes, gaspar, rents, storage, tension
from src.reference_data import download as download_module
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
    assert validate_reference_url("https://www.data.gouv.fr/api/1/datasets/693aa2feed1bf4da603faa49/")
    assert validate_reference_url("https://static.data.gouv.fr/resources/x/pred-app-mef-dhup.csv")
    for url in (
        "http://static.data.gouv.fr/resources/x.csv",
        "https://data.gouv.fr/api/1/datasets/x/",
        "https://static.data.gouv.fr.example.com/x.csv",
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


ANIL_DATASET = {
    "title": "\"Carte des loyers\" - Indicateurs de loyers d'annonce par commune en 2025",
    "resources": [
        {"title": "Note méthodologique", "format": "pdf", "url": "https://static.data.gouv.fr/a/note.pdf"},
        {
            "title": "Indicateurs de loyer appartement",
            "format": "csv",
            "url": "https://static.data.gouv.fr/a/pred-app-mef-dhup.csv",
            "last_modified": "2025-12-11T14:50:11+00:00",
        },
        {
            "title": "Indicateur de loyer appartement de 1 ou 2 pièces",
            "format": "csv",
            "url": "https://static.data.gouv.fr/a/pred-app12-mef-dhup.csv",
            "last_modified": "2025-12-11T14:58:19+00:00",
        },
        {
            "title": "Indicateur de loyer appartement de 3 pièces ou plus",
            "format": "csv",
            "url": "https://static.data.gouv.fr/a/pred-app3-mef-dhup.csv",
            "last_modified": "2025-12-11T14:49:52+00:00",
        },
        {
            "title": "Indicateurs de loyer maison",
            "format": "csv",
            "url": "https://static.data.gouv.fr/a/pred-mai-mef-dhup.csv",
            "last_modified": "2025-12-11T14:50:40+00:00",
        },
    ],
}

ANIL_HEADER = (
    '"id_zone";"INSEE_C";"LIBGEO";"EPCI";"DEP";"REG";"loypredm2";"lwr.IPm2";"upr.IPm2";'
    '"TYPPRED";"nbobs_com";"nbobs_mail";"R2_adj"\r\n'
)


def test_anil_resources_are_found_by_title_with_their_segment() -> None:
    resources = rents.select_resources(ANIL_DATASET)

    assert list(resources) == ["apt_all", "apt_1_2", "apt_3p", "house"]
    assert resources["apt_1_2"].url.endswith("pred-app12-mef-dhup.csv")
    assert resources["apt_all"].updated_on == date(2025, 12, 11)
    assert rents.dataset_vintage(ANIL_DATASET) == 2025


def test_anil_dataset_without_a_segment_is_refused() -> None:
    partial = {**ANIL_DATASET, "resources": ANIL_DATASET["resources"][:-1]}

    with pytest.raises(RuntimeError, match="house"):
        rents.select_resources(partial)
    with pytest.raises(RuntimeError, match="vintage"):
        rents.dataset_vintage({"title": "Carte des loyers"})


def test_anil_file_is_read_as_latin_1_with_decimal_commas_and_arrondissements(tmp_path: Path) -> None:
    lines = [
        '"1";"26030";"La Bâtie-des-Fonds";"242600534";"26";"84";9,75769624568385;7,57917786912916;12,5623963003751;"maille";0;484;0,77697857231704',
        '"2920";"33063";"Bordeaux";"243300316";"33";"75";15,9931995588236;12,2720522168567;20,8426779489266;"commune";84641;96006;0,821385071888653',
        '"1188";"11376";"La Serpent";"200071926";"11";"76";8,42892621284001;6,03689854512953;11,7687578431844;"EPCI";1;479;0,723468759326147',
        '"10";"75108";"Paris 8e Arrondissement";"200054781";"75";"11";32,5;28,1;37,9;"commune";2000;3000;0,9',
        '"11";"13201";"Marseille 1er Arrondissement";"200054807";"13";"93";16,1;13,0;19,2;"maile";40;900;0,8',
        '"12";"ZZZZZ";"Hors périmètre";"200054807";"13";"93";16,1;13,0;19,2;"commune";40;900;0,8',
        '"13";"33064";"Loyer absurde";"200054807";"33";"75";900;13,0;19,2;"commune";40;900;0,8',
        '"14";"33065";"Type inconnu";"200054807";"33";"75";12,0;10,0;14,0;"autre";40;900;0,8',
        '"15";"26030";"La Bâtie-des-Fonds (doublon)";"242600534";"26";"84";9,0;7,0;11,0;"maille";0;484;0,7',
    ]
    path = tmp_path / "pred-app-mef-dhup.csv"
    path.write_bytes((ANIL_HEADER + "\r\n".join(lines) + "\r\n").encode("cp1252"))

    parsed, stats = rents.parse_rent_file(path, "apt_all", "https://static.data.gouv.fr/a.csv", 2025, date(2025, 12, 11))
    by_code = {row["commune_code"]: row for row in parsed}

    assert (stats.lines, stats.rejected, stats.duplicates) == (9, 3, 1)
    assert sorted(by_code) == ["11376", "13201", "26030", "33063", "75108"]
    assert by_code["26030"]["commune_name"] == "La Bâtie-des-Fonds"
    assert by_code["26030"]["rent_per_m2"] == 9.7577
    assert by_code["26030"]["rent_low_per_m2"] == 7.5792
    assert by_code["26030"]["observations_commune"] == 0
    assert by_code["33063"]["prediction_type"] == "commune"
    assert by_code["33063"]["observations_commune"] == 84641
    assert by_code["33063"]["r2_adj"] == 0.821385
    assert by_code["11376"]["prediction_type"] == "epci"  # published as « EPCI »
    assert by_code["13201"]["prediction_type"] == "maille"  # the « maile » spelling is accepted
    assert rents.arrondissement_count(parsed) == 2
    assert {row["segment"] for row in parsed} == {"apt_all"}
    assert by_code["33063"]["vintage"] == 2025
    assert by_code["33063"]["source_updated_on"] == date(2025, 12, 11)
    assert by_code["33063"]["source_url"] == "https://static.data.gouv.fr/a.csv"


def test_anil_utf8_file_is_not_mangled_and_missing_columns_are_refused() -> None:
    text = ANIL_HEADER + '"2920";"33063";"Épeigné";"243300316";"33";"75";15,9;12,2;20,8;"commune";84641;96006;0,82\r\n'

    assert rents.decode_csv(text.encode("utf-8")).count("Épeigné") == 1
    with pytest.raises(RuntimeError, match="loypredm2"):
        rents.parse_rent_csv(text.replace("loypredm2", "autre"), "house", "https://x", 2025)


def test_tension_resource_gives_the_csv_and_the_decree() -> None:
    dataset = {
        "resources": [
            {
                "title": "Décret n°2025-1267 du 22 décembre 2025 modifiant le décret n°2013-392 du 10 mai 2013",
                "format": "pdf",
                "url": "https://static.data.gouv.fr/a/decret.pdf",
            },
            {
                "title": "Zonage TLV",
                "format": "csv",
                "url": "https://static.data.gouv.fr/a/zonage.csv",
                "last_modified": "2025-12-30T09:48:00+00:00",
            },
        ]
    }

    resource = tension.select_resource(dataset)

    assert resource.url.endswith("zonage.csv")
    assert resource.updated_on == date(2025, 12, 30)
    assert resource.decree_reference == "Décret n° 2025-1267 du 22 décembre 2025"
    with pytest.raises(RuntimeError, match="CSV"):
        tension.select_resource({"resources": []})


def test_tension_file_keeps_the_three_zonings_and_fixes_the_swapped_epci_columns() -> None:
    text = (
        "CODGEO25;DEP;LIBGEO;Code EPCI;Libellé EPCI;Zonage TLV 2013;Zonage TLV 2023;"
        "Zonage TLV post décret 22/12/2025\n"
        "01001;01;L'Abergement-Clémenciat;CC de la Dombes;200069193;Non TLV;3. Non tendue;3. Non tendue\n"
        "33063;33;Bordeaux;Bordeaux Métropole;243300316;TLV;1. Zone tendue;1. Zone tendue\n"
        "17019;17;Ars-en-Ré;CC de l'Île de Ré;241700616;Non TLV;2. Zone touristique et tendue;1. Zone tendue\n"
        "75056;75;Paris;Métropole du Grand Paris;200054781;TLV;1. Zone tendue;1. Zone tendue\n"
        "ZZZZZ;99;Inconnue;CC X;200000000;TLV;1. Zone tendue;1. Zone tendue\n"
        "01002;01;Valeur inconnue;CC X;200069193;TLV;Autre;1. Zone tendue\n"
        "33063;33;Bordeaux (doublon);Bordeaux Métropole;243300316;TLV;1. Zone tendue;1. Zone tendue\n"
    )

    parsed, stats = tension.parse_tension_csv(
        text, "https://static.data.gouv.fr/a/zonage.csv", "Décret n° 2025-1267 du 22 décembre 2025", date(2025, 12, 30)
    )
    by_code = {row["commune_code"]: row for row in parsed}

    assert (stats.lines, stats.rejected, stats.duplicates) == (7, 2, 1)
    assert sorted(by_code) == ["01001", "17019", "33063", "75056"]
    assert by_code["01001"]["epci_code"] == "200069193"
    assert by_code["01001"]["epci_name"] == "CC de la Dombes"
    assert (by_code["01001"]["zoning_2013"], by_code["01001"]["zoning_2023"]) == ("non_tlv", "non_tendue")
    assert by_code["33063"]["zoning_post_decree"] == "tendue"
    assert by_code["33063"]["zoning_2013"] == "tlv"
    assert (by_code["17019"]["zoning_2023"], by_code["17019"]["zoning_post_decree"]) == (
        "touristique_tendue",
        "tendue",
    )
    assert by_code["33063"]["decree_reference"] == "Décret n° 2025-1267 du 22 décembre 2025"
    assert by_code["33063"]["decree_date"] == date(2025, 12, 22)
    assert by_code["33063"]["source_updated_on"] == date(2025, 12, 30)
    with pytest.raises(RuntimeError, match="columns"):
        tension.parse_tension_csv("a;b\n1;2\n", "https://x", "d")


def test_new_reference_tables_are_upserted_on_their_key_with_an_import_date() -> None:
    rents_statement = storage.upsert_statement("anil_rents")
    tension_statement = storage.upsert_statement("commune_housing_tension")

    assert "on conflict (commune_code, segment)" in rents_statement
    assert "on conflict (commune_code)" in tension_statement
    assert "imported_at = now()" in rents_statement and "imported_at = now()" in tension_statement
    assert "r2_adj = excluded.r2_adj" in rents_statement
    assert "zoning_post_decree = excluded.zoning_post_decree" in tension_statement


def _rent_dataset_stub(monkeypatch, communes_per_file: int) -> None:
    def fake_download(url: str, target: Path, **kwargs) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            f'"1";"{10000 + index:05d}";"Commune {index}";"200000000";"01";"84";10,5;9,0;12,0;"commune";50;60;0,8'
            for index in range(communes_per_file)
        ]
        target.write_bytes((ANIL_HEADER + "\r\n".join(lines) + "\r\n").encode("cp1252"))
        return target

    monkeypatch.setattr(reference_main, "fetch_json", lambda url: ANIL_DATASET)
    monkeypatch.setattr(reference_main, "download", fake_download)


class _FakeDatabase:
    """Stands for ``reference_main.Database``: ``connection()`` opens (here: returns) the connection."""

    def __init__(self) -> None:
        self.opened = 0
        self.closed = False

    def connection(self):
        self.opened += 1
        return self

    def close(self) -> None:
        self.closed = True


def _fake_storage(monkeypatch, *, current_rows: int = 0):
    """Replace the storage calls of an import; ``current_rows`` is what the table holds before it."""
    calls: list[tuple] = []
    monkeypatch.setattr(
        storage,
        "row_count",
        lambda connection, table, **kwargs: calls.append(("count", table)) or current_rows,
    )

    def replace_snapshot(connection, table, rows, *, vintage=None):
        calls.append(("replace", table, len(list(rows)), vintage))
        return 7, 3

    monkeypatch.setattr(storage, "replace_snapshot", replace_snapshot)
    return calls


def test_a_truncated_rent_file_is_refused_before_any_write(monkeypatch, tmp_path: Path) -> None:
    _rent_dataset_stub(monkeypatch, communes_per_file=500)
    database = _FakeDatabase()

    with pytest.raises(RuntimeError, match="partial import"):
        reference_main._import_rents(tmp_path, database)

    assert database.opened == 0


def test_the_absolute_floors_follow_the_real_files() -> None:
    # 34 900 lines per ANIL segment and 34 875 communes in the zoning: about 100 communes of slack.
    assert reference_main.MIN_RENT_COMMUNES == reference_main.MIN_TENSION_COMMUNES == 34_800


def test_a_complete_rent_import_writes_in_one_snapshot_transaction(monkeypatch, tmp_path: Path) -> None:
    _rent_dataset_stub(monkeypatch, communes_per_file=reference_main.MIN_RENT_COMMUNES)
    total = 4 * reference_main.MIN_RENT_COMMUNES
    calls = _fake_storage(monkeypatch, current_rows=total)
    database = _FakeDatabase()

    summary = reference_main._import_rents(tmp_path, database)

    # The vintage is checked inside the same transaction as the upsert and the purge.
    assert calls == [("count", "anil_rents"), ("replace", "anil_rents", total, 2025)]
    assert summary["vintage"] == 2025 and summary["house"] == reference_main.MIN_RENT_COMMUNES
    assert summary["updated_on"] == date(2025, 12, 11)
    assert summary["written"] == 7 and summary["purged"] == 3


def test_a_rent_file_far_smaller_than_the_table_is_refused_even_above_the_floor(monkeypatch, tmp_path: Path) -> None:
    _rent_dataset_stub(monkeypatch, communes_per_file=reference_main.MIN_RENT_COMMUNES)
    total = 4 * reference_main.MIN_RENT_COMMUNES
    # The table holds 2 % more than the file: above the absolute floor, below 99 % of the table.
    calls = _fake_storage(monkeypatch, current_rows=int(total * 1.02))

    with pytest.raises(reference_main.ImportRefused, match="99%"):
        reference_main._import_rents(tmp_path, _FakeDatabase())

    assert [call[0] for call in calls] == ["count"]

    # Within 1 % of the table (a few communes merged or created) is accepted.
    calls = _fake_storage(monkeypatch, current_rows=int(total * 1.005))
    reference_main._import_rents(tmp_path, _FakeDatabase())
    assert calls[-1][0] == "replace"


def test_the_web_edition_gap_stops_the_import_before_any_write(monkeypatch, tmp_path: Path) -> None:
    _rent_dataset_stub(monkeypatch, communes_per_file=reference_main.MIN_RENT_COMMUNES)
    calls = _fake_storage(monkeypatch)
    monkeypatch.setattr(reference_main, "web_edition_gap", lambda vintage, updated_on: "ANIL_CURRENT_EDITION says 2024")
    database = _FakeDatabase()

    with pytest.raises(reference_main.ImportRefused, match="web_edition_gap") as refused:
        reference_main._import_rents(tmp_path, database)

    assert refused.value.summary["web_edition_gap"] == "ANIL_CURRENT_EDITION says 2024"
    assert calls == [] and database.opened == 0
    # A dry run reports the gap too: it is the step that precedes the pull request updating the constant.
    with pytest.raises(reference_main.ImportRefused):
        reference_main._import_rents(tmp_path, None)


def test_a_dry_run_import_touches_no_table(monkeypatch, tmp_path: Path) -> None:
    _rent_dataset_stub(monkeypatch, communes_per_file=reference_main.MIN_RENT_COMMUNES)
    calls = _fake_storage(monkeypatch)

    summary = reference_main._import_rents(tmp_path, None)

    assert calls == [] and summary["written"] == 0


def test_the_web_edition_gap_is_reported_when_the_app_still_quotes_an_older_map(tmp_path: Path) -> None:
    page = tmp_path / "rent-source-notice.ts"
    page.write_text(
        'export const ANIL_CURRENT_EDITION = { vintage: 2025, sourceUpdatedOn: "2025-12-11" } as const;\n',
        encoding="utf-8",
    )

    assert reference_main.web_edition_gap(2025, date(2025, 12, 11), page) is None
    assert "update src/lib/rent-source-notice.ts" in reference_main.web_edition_gap(2026, date(2026, 12, 9), page)
    assert reference_main.web_edition_gap(2025, date(2025, 12, 12), page) is not None
    page.write_text("export const other = 1;\n", encoding="utf-8")
    assert "not found" in reference_main.web_edition_gap(2025, date(2025, 12, 11), page)
    # A checkout without the web app has nothing to compare with.
    assert reference_main.web_edition_gap(2025, date(2025, 12, 11), tmp_path / "missing.ts") is None


def test_the_real_web_edition_matches_the_edition_the_dataset_publishes() -> None:
    # The constant of the web app and the edition read by the importer move together.
    assert reference_main.web_edition_gap(2025, date(2025, 12, 11)) is None


def test_the_tension_import_writes_one_snapshot_and_refuses_a_much_smaller_file(monkeypatch, tmp_path: Path) -> None:
    dataset = {
        "resources": [
            {
                "title": "Décret n°2025-1267 du 22 décembre 2025 modifiant le décret n°2013-392",
                "format": "pdf",
                "url": "https://static.data.gouv.fr/a/decret.pdf",
            },
            {
                "title": "Zonage TLV",
                "format": "csv",
                "url": "https://static.data.gouv.fr/a/zonage.csv",
                "last_modified": "2025-12-30T09:48:00+00:00",
            },
        ]
    }
    header = (
        "CODGEO25;DEP;LIBGEO;Code EPCI;Libellé EPCI;Zonage TLV 2013;Zonage TLV 2023;"
        "Zonage TLV post décret 22/12/2025\n"
    )

    def fake_download(url: str, target: Path, **kwargs) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            f"{10000 + index:05d};01;Commune {index};CC X;200069193;Non TLV;3. Non tendue;3. Non tendue"
            for index in range(reference_main.MIN_TENSION_COMMUNES)
        ]
        target.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
        return target

    monkeypatch.setattr(reference_main, "fetch_json", lambda url: dataset)
    monkeypatch.setattr(reference_main, "download", fake_download)
    calls = _fake_storage(monkeypatch, current_rows=reference_main.MIN_TENSION_COMMUNES)

    summary = reference_main._import_tension(tmp_path, _FakeDatabase())

    assert calls[-1] == ("replace", "commune_housing_tension", reference_main.MIN_TENSION_COMMUNES, None)
    assert summary["communes"] == reference_main.MIN_TENSION_COMMUNES and summary["purged"] == 3
    assert summary["decree"] == "Décret n° 2025-1267 du 22 décembre 2025"

    _fake_storage(monkeypatch, current_rows=int(reference_main.MIN_TENSION_COMMUNES * 1.02))
    with pytest.raises(reference_main.ImportRefused, match="99%"):
        reference_main._import_tension(tmp_path, _FakeDatabase())


def test_the_snapshot_helpers_only_touch_the_two_new_tables() -> None:
    class Cursor:
        rowcount = 4

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, statement, params=None):
            executed.append(statement)

        def fetchall(self):
            return [(2025, 10)]

        def fetchone(self):
            return (10,)

    class Connection:
        def cursor(self):
            return Cursor()

        def commit(self):
            pass

    executed: list[str] = []
    connection = Connection()

    assert storage.purge_untouched(connection, "anil_rents", "T0") == 4
    assert storage.vintage_counts(connection, "anil_rents") == [(2025, 10)]
    assert storage.row_count(connection, "commune_housing_tension") == 10
    assert any("delete from public.anil_rents where imported_at <" in statement for statement in executed)
    for call in (
        lambda: storage.purge_untouched(connection, "reference_communes", "T0"),
        lambda: storage.row_count(connection, "reference_communes"),
        lambda: storage.vintage_counts(connection, "commune_housing_tension"),
    ):
        with pytest.raises(ValueError):
            call()


class _FakeResponse:
    def __init__(self, body: bytes, declared: int | None = None) -> None:
        self._body = body
        self._offset = 0
        self.headers = {} if declared is None else {"Content-Length": str(declared)}

    def read(self, size: int = -1) -> bytes:
        size = len(self._body) - self._offset if size < 0 else size
        chunk = self._body[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_a_text_or_a_file_above_the_byte_limit_is_refused(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(download_module, "_open", lambda url, timeout: _FakeResponse(b"x" * 100))

    assert download_module.fetch_text("https://static.data.gouv.fr/a", max_bytes=100) == "x" * 100
    with pytest.raises(ReferenceDownloadError, match="larger than"):
        download_module.fetch_text("https://static.data.gouv.fr/a", max_bytes=99)

    target = tmp_path / "file.bin"
    assert download_module.download("https://static.data.gouv.fr/a", target, max_bytes=100) == target
    assert target.stat().st_size == 100
    target.unlink()
    with pytest.raises(ReferenceDownloadError, match="larger than"):
        download_module.download("https://static.data.gouv.fr/a", target, max_bytes=99)
    # Nothing, not even a partial file, is left behind.
    assert not target.exists() and not list(tmp_path.glob("*.part"))


def test_a_declared_size_above_the_limit_is_refused_before_reading(monkeypatch, tmp_path: Path) -> None:
    response = _FakeResponse(b"x", declared=10_000_000)
    monkeypatch.setattr(download_module, "_open", lambda url, timeout: response)

    with pytest.raises(ReferenceDownloadError, match="declares 10000000 bytes"):
        download_module.fetch_text("https://static.data.gouv.fr/a", max_bytes=1000)
    assert response._offset == 0
    with pytest.raises(ReferenceDownloadError, match="declares"):
        download_module.download("https://static.data.gouv.fr/a", tmp_path / "f", max_bytes=1000)


def test_anil_segments_are_classified_by_file_name_before_the_title() -> None:
    # A republished title cannot send a file to the wrong segment: the file name decides first.
    assert rents.classify_segment("Indicateurs de loyer maison", "https://x/pred-app-mef-dhup.csv") == "apt_all"
    assert rents.classify_segment("Indicateur de loyer appartement de 1 ou 2 pièces", "https://x/a/pred-mai-mef-dhup.csv?v=2") == "house"
    # Without a known file name, the title is used.
    assert rents.classify_segment("Indicateurs de loyer maison", "https://x/renamed.csv") == "house"
    assert rents.classify_segment("Autre chose", "https://x/renamed.csv") is None


def test_the_department_comes_from_the_commune_code_not_from_the_dep_column() -> None:
    text = (
        ANIL_HEADER
        + '"1";"75108";"Paris 8e Arrondissement";"200054781";"99";"11";32,5;28,1;37,9;"commune";2000;3000;0,9\r\n'
        + '"2";"97411";"Saint-Denis";"249740119";"";"04";14,0;12,0;16,0;"commune";900;1200;0,8\r\n'
        + '"3";"2A004";"Ajaccio";"242010056";"20";"94";15,2;12,0;19,3;"commune";7460;7815;0,79\r\n'
    )

    parsed, stats = rents.parse_rent_csv(text, "apt_all", "https://x/a.csv", 2025)

    assert stats.rejected == 0
    assert {row["commune_code"]: row["department_code"] for row in parsed} == {
        "75108": "75",
        "97411": "974",
        "2A004": "2A",
    }


def test_the_tension_department_comes_from_the_commune_code() -> None:
    text = (
        "CODGEO25;DEP;LIBGEO;Code EPCI;Libellé EPCI;Zonage TLV 2013;Zonage TLV 2023;"
        "Zonage TLV post décret 22/12/2025\n"
        "97411;XX;Saint-Denis;CINOR;249740119;Non TLV;1. Zone tendue;1. Zone tendue\n"
    )

    parsed, stats = tension.parse_tension_csv(text, "https://x/z.csv", "Décret n° 2025-1267")

    assert stats.rejected == 0 and parsed[0]["department_code"] == "974"


def test_no_decree_in_the_zoning_documentation_is_an_explicit_error_not_a_guess() -> None:
    dataset = {
        "resources": [
            {"title": "Note", "format": "pdf", "url": "https://static.data.gouv.fr/a/n.pdf"},
            {"title": "Zonage TLV", "format": "csv", "url": "https://static.data.gouv.fr/a/z.csv"},
        ]
    }

    with pytest.raises(RuntimeError, match="does not identify the decree"):
        tension.select_resource(dataset)


def test_the_zoning_dataset_is_pinned_by_identifier() -> None:
    assert tension.TENSION_DATASET_ID == "657c88da2947e13be0597058"
    assert tension.TENSION_DATASET_API_URL.endswith("/datasets/657c88da2947e13be0597058/")


def test_the_new_datasets_are_registered() -> None:
    assert {"rents", "tension"} <= set(reference_main.DATASETS)
    assert set(reference_main.DATASETS) | set(reference_main.EXTRA_DATASETS) == set(reference_main._IMPORTERS)


class _RecordingConnection:
    """A connection that records its statements, commits and rollbacks."""

    def __init__(self, *, vintages=None, count=2, fail_on: str | None = None) -> None:
        self.events: list[str] = []
        self.vintages = [(2025, 2)] if vintages is None else vintages
        self.count = count
        self.fail_on = fail_on
        self._last = ""

    def cursor(self):
        connection = self

        class Cursor:
            rowcount = 5

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def execute(self, statement, params=None):
                connection._last = statement
                if connection.fail_on and connection.fail_on in statement:
                    raise OSError("connection reset by peer")
                connection.events.append(statement.split(" ", 1)[0] + " " + statement.split(" ", 2)[1])

            def fetchone(self):
                return (connection.count,) if "count" in connection._last else ("T0",)

            def fetchall(self):
                return connection.vintages

        return Cursor()

    def commit(self):
        self.events.append("COMMIT")

    def rollback(self):
        self.events.append("ROLLBACK")


def test_a_snapshot_is_one_transaction_with_a_single_commit() -> None:
    connection = _RecordingConnection()
    rows = [{"commune_code": f"{index:05d}"} for index in range(2_500)]

    written, purged = storage.replace_snapshot(connection, "commune_housing_tension", rows[:2], vintage=None)

    assert (written, purged) == (2, 5)
    assert connection.events.count("COMMIT") == 1 and connection.events[-1] == "COMMIT"
    assert "ROLLBACK" not in connection.events
    # More than one batch still means a single commit.
    big = _RecordingConnection(count=2_500)
    storage.replace_snapshot(big, "commune_housing_tension", rows)
    assert big.events.count("COMMIT") == 1


def test_a_failure_halfway_rolls_back_instead_of_leaving_a_mix_of_vintages() -> None:
    rows = [{"commune_code": "01001", "segment": "apt_all"}, {"commune_code": "01002", "segment": "apt_all"}]
    broken = _RecordingConnection(fail_on="insert into public.anil_rents")

    with pytest.raises(OSError):
        storage.replace_snapshot(broken, "anil_rents", rows, vintage=2025)

    assert "COMMIT" not in broken.events and broken.events[-1] == "ROLLBACK"


def test_a_vintage_or_row_count_that_disagrees_after_the_write_is_rolled_back() -> None:
    rows = [{"commune_code": "01001", "segment": "apt_all"}, {"commune_code": "01002", "segment": "apt_all"}]
    mixed = _RecordingConnection(vintages=[(2024, 10), (2025, 2)])

    with pytest.raises(storage.SnapshotCheckError, match="rolled back"):
        storage.replace_snapshot(mixed, "anil_rents", rows, vintage=2025)

    assert "COMMIT" not in mixed.events and mixed.events[-1] == "ROLLBACK"
    wrong_count = _RecordingConnection(count=1)
    with pytest.raises(storage.SnapshotCheckError):
        storage.replace_snapshot(wrong_count, "commune_housing_tension", rows)
    assert "COMMIT" not in wrong_count.events and wrong_count.events[-1] == "ROLLBACK"


def test_upsert_rows_in_a_single_transaction_never_commits_itself() -> None:
    connection = _RecordingConnection()
    rows = [{"code_insee": f"{index:05d}"} for index in range(2_500)]

    assert storage.upsert_rows(connection, "reference_communes", rows, single_transaction=True) == 2_500
    assert "COMMIT" not in connection.events


def test_all_isolates_each_dataset_and_fails_at_the_end(monkeypatch, capsys) -> None:
    ran: list[str] = []
    databases: list[_FakeDatabase] = []

    def importer(name: str, fail: bool = False):
        def run(work_dir, database):
            ran.append(name)
            databases.append(database)
            if fail:
                raise RuntimeError("climate files unavailable")
            return {"ok": name}

        return run

    monkeypatch.setattr(
        reference_main,
        "_IMPORTERS",
        {
            "communes": importer("communes"),
            "risks": importer("risks"),
            "climate": importer("climate", fail=True),
            "rents": importer("rents"),
            "tension": importer("tension"),
        },
    )
    created: list[_FakeDatabase] = []

    def make_database(url):
        created.append(_FakeDatabase())
        return created[-1]

    monkeypatch.setattr(reference_main, "Database", make_database)
    monkeypatch.setattr(reference_main, "load_settings", lambda: {"supabase_db_url": "postgresql://x"})

    exit_code = reference_main.main(["all"])

    assert ran == ["communes", "risks", "climate", "rents", "tension"]
    assert exit_code == 1
    # One connection per dataset, each closed even after a failure.
    assert len(created) == 5 and all(database.closed for database in created)
    output = capsys.readouterr()
    assert "::error title=Import climate::RuntimeError: climate files unavailable" in output.out
    assert "[tension] ok=tension" in output.out


def test_a_clean_run_exits_zero_and_a_dry_run_opens_no_connection(monkeypatch) -> None:
    seen: list[object] = []
    monkeypatch.setattr(reference_main, "_IMPORTERS", {**reference_main._IMPORTERS, "rents": lambda w, d: seen.append(d) or {}})
    monkeypatch.setattr(reference_main, "load_settings", lambda: {})

    assert reference_main.main(["rents", "--dry-run"]) == 0
    assert seen == [None]


def test_check_new_vintage_is_only_for_the_rents_dataset() -> None:
    with pytest.raises(SystemExit):
        reference_main.parse_args(["tension", "--check-new-vintage"])


NEW_VINTAGE_SEARCH = {
    "data": [
        {"id": "693aa2feed1bf4da603faa49", "title": "\"Carte des loyers\" - Indicateurs de loyers d'annonce par commune en 2025"},
        {"id": "aaaaaaaaaaaaaaaaaaaaaaaa", "title": "\"Carte des loyers\" - Indicateurs de loyers d'annonce par commune en 2026"},
        {"id": "bbbbbbbbbbbbbbbbbbbbbbbb", "title": "Observatoire des loyers 2027"},
        "not a dataset",
    ]
}


def test_a_newer_anil_vintage_is_detected_from_the_search_results() -> None:
    found = rents.newer_vintages(NEW_VINTAGE_SEARCH, 2025)

    assert [(item.vintage, item.identifier) for item in found] == [(2026, "aaaaaaaaaaaaaaaaaaaaaaaa")]
    assert rents.newer_vintages(NEW_VINTAGE_SEARCH, 2026) == []
    assert rents.newer_vintages({}, 2025) == []


def test_check_new_vintage_exits_one_with_a_warning_then_zero(monkeypatch, capsys, tmp_path: Path) -> None:
    page = tmp_path / "rent-source-notice.ts"
    page.write_text(
        'export const ANIL_CURRENT_EDITION = { vintage: 2025, sourceUpdatedOn: "2025-12-11" } as const;\n',
        encoding="utf-8",
    )
    search = {"value": NEW_VINTAGE_SEARCH}

    def fetch(url: str):
        return search["value"] if url == rents.ANIL_SEARCH_URL else ANIL_DATASET

    monkeypatch.setattr(reference_main, "fetch_json", fetch)

    assert reference_main.check_new_vintage(page) == 1
    assert "::warning title=Nouveau millésime ANIL::2026" in capsys.readouterr().out

    search["value"] = {"data": NEW_VINTAGE_SEARCH["data"][:1]}
    assert reference_main.check_new_vintage(page) == 0
    # The pinned dataset republished in place under a newer title is caught too.
    monkeypatch.setattr(
        reference_main, "fetch_json", lambda url: {**ANIL_DATASET, "title": "Carte des loyers par commune en 2026"} if url != rents.ANIL_SEARCH_URL else {}
    )
    assert reference_main.check_new_vintage(page) == 1


def test_a_body_shorter_than_content_length_is_retried_then_refused(monkeypatch, tmp_path: Path) -> None:
    attempts: list[int] = []

    def open_cut(url, timeout):
        attempts.append(1)
        return _FakeResponse(b"x" * 50, declared=100)

    monkeypatch.setattr(download_module, "_open", open_cut)
    monkeypatch.setattr(download_module.time, "sleep", lambda seconds: None)
    target = tmp_path / "file.csv"

    with pytest.raises(download_module.IncompleteDownloadError, match="declared 100 bytes but 50"):
        download_module.download("https://static.data.gouv.fr/a", target)

    # The first attempt and one more per retry delay; nothing, not even a partial file, is left.
    assert len(attempts) == 1 + len(download_module.RETRY_DELAYS_SECONDS)
    assert not target.exists() and not list(tmp_path.glob("*.part"))
    with pytest.raises(download_module.IncompleteDownloadError):
        download_module.fetch_text("https://static.data.gouv.fr/a")


def test_http_client_exceptions_are_retried_but_client_errors_are_not() -> None:
    import http.client
    import urllib.error

    def failing(error: Exception):
        calls: list[int] = []

        def action():
            calls.append(1)
            if len(calls) == 1:
                raise error
            return "ok"

        return calls, action

    calls, action = failing(http.client.IncompleteRead(b"abc", 10))
    assert download_module._with_retries(action, retry_delays=(0.0,), sleep=lambda s: None) == "ok"
    assert len(calls) == 2
    for status in (500, 503, 429):
        calls, action = failing(urllib.error.HTTPError("https://x", status, "err", {}, None))
        assert download_module._with_retries(action, retry_delays=(0.0,), sleep=lambda s: None) == "ok"
        assert len(calls) == 2
    for status in (403, 404):
        calls, action = failing(urllib.error.HTTPError("https://x", status, "err", {}, None))
        with pytest.raises(urllib.error.HTTPError):
            download_module._with_retries(action, retry_delays=(0.0, 0.0), sleep=lambda s: None)
        assert len(calls) == 1


def test_the_reference_import_workflow_identifies_its_requests() -> None:
    workflow = (Path(__file__).resolve().parents[3] / ".github" / "workflows" / "reference-data-import.yml").read_text(
        encoding="utf-8"
    )

    assert "AUCTION_USER_AGENT: ${{ vars.AUCTION_USER_AGENT || 'ImmojudisBot/1.0 (+https://immojudis.com/contact)' }}" in workflow
    assert "if: failure()" in workflow and "GITHUB_STEP_SUMMARY" in workflow
    assert "--check-new-vintage" in workflow


def test_the_reference_import_workflow_offers_every_dataset_of_the_command() -> None:
    workflow = (Path(__file__).resolve().parents[3] / ".github" / "workflows" / "reference-data-import.yml").read_text(
        encoding="utf-8"
    )

    # A dataset the command accepts but the dispatch form does not list cannot be run in production.
    for dataset in (*reference_main.DATASETS, *reference_main.EXTRA_DATASETS, "all"):
        assert f"          - {dataset}\n" in workflow


TWO_DECREES = {
    "resources": [
        {"title": "Décret n°2025-1267 du 22 décembre 2025 modifiant le décret n°2013-392", "format": "pdf", "url": "https://static.data.gouv.fr/a/d2.pdf"},
        {"title": "Décret n°2023-822 du 25 août 2023 modifiant le décret n°2013-392", "format": "pdf", "url": "https://static.data.gouv.fr/a/d1.pdf"},
        {"title": "Zonage TLV", "format": "csv", "url": "https://static.data.gouv.fr/a/zonage.csv", "last_modified": "2025-12-30T09:48:00+00:00"},
    ]
}


def test_the_decree_is_the_one_dated_like_the_csv_header_whatever_the_api_order() -> None:
    resource = tension.select_resource(TWO_DECREES)

    # The latest by date, not the last listed.
    assert resource.decree_reference == "Décret n° 2025-1267 du 22 décembre 2025"
    assert len(resource.decree_candidates) == 2
    assert tension.choose_decree(resource, date(2023, 8, 25)) == "Décret n° 2023-822 du 25 août 2023"
    assert tension.choose_decree(resource, date(2025, 12, 22)) == resource.decree_reference
    assert tension.choose_decree(resource, None) == resource.decree_reference
    with pytest.raises(RuntimeError, match="no decree matches"):
        tension.choose_decree(resource, date(2026, 6, 1))


def test_a_decree_that_disagrees_with_the_csv_header_is_refused() -> None:
    header = (
        "CODGEO25;DEP;LIBGEO;Code EPCI;Libellé EPCI;Zonage TLV 2013;Zonage TLV 2023;"
        "Zonage TLV post décret 22/12/2025\n"
    )
    line = "01001;01;L'Abergement;CC X;200069193;Non TLV;3. Non tendue;3. Non tendue\n"

    rows, _ = tension.parse_tension_csv(header + line, "https://x", "Décret n° 2025-1267 du 22 décembre 2025")
    assert rows[0]["decree_date"] == date(2025, 12, 22)
    with pytest.raises(RuntimeError, match="do not match"):
        tension.parse_tension_csv(header + line, "https://x", "Décret n° 2023-822 du 25 août 2023")


def test_the_decree_date_is_read_from_the_csv_header_of_a_file(tmp_path: Path) -> None:
    path = tmp_path / "z.csv"
    path.write_text("CODGEO25;LIBGEO;Zonage TLV post décret 22/12/2025\n01001;A;x\n", encoding="utf-8")

    assert tension.file_decree_date(path) == date(2025, 12, 22)
    path.write_text("CODGEO25;LIBGEO\n01001;A\n", encoding="utf-8")
    assert tension.file_decree_date(path) is None


# Extrait du fichier réel v_mvt_commune_2026.csv de l'INSEE (colonnes, séparateur, guillemets et valeurs de MOD).
MOVEMENTS_HEADER = (
    '"MOD","DATE_EFF","TYPECOM_AV","COM_AV","TNCC_AV","NCC_AV","NCCENR_AV","LIBELLE_AV",'
    '"TYPECOM_AP","COM_AP","TNCC_AP","NCC_AP","NCCENR_AP","LIBELLE_AP"\n'
)
MOVEMENTS_SAMPLE = MOVEMENTS_HEADER + "\n".join(
    [
        '"35","2026-01-01","COMD","02077","0","BERZY LE SEC","Berzy-le-Sec","Berzy-le-Sec","COM","02564","0","B","B","B"',
        # Le chef-lieu garde son code : pas un changement de code.
        '"35","2026-01-01","COMD","02564","0","N","N","N","COM","02564","0","B","B","B"',
        '"34","2026-01-01","COMA","01324","0","RIGNAT","Rignat","Rignat","COM","01245","0","B","B","B"',
        '"32","2019-01-01","COM","49007","0","A","A","A","COM","49018","0","B","B","B"',
        # Même passage répété avec une autre modalité du même jour : un seul passage.
        '"32","2019-01-01","COM","49007","0","A","A","A","COM","49018","0","B","B","B"',
        '"41","2017-01-01","COM","2B033","0","A","A","A","COM","2A004","0","B","B","B"',
        # Trop ancien (le code a pu être réutilisé), création, nom, commune déléguée d'arrivée, arrondissement.
        '"32","2009-01-01","COM","11111","0","A","A","A","COM","22222","0","B","B","B"',
        '"20","2020-01-01","","","0","","","","COM","33333","0","B","B","B"',
        '"10","2020-01-01","COM","44444","0","A","A","A","COM","44444","0","B","B","B"',
        '"32","2020-01-01","COM","55555","0","A","A","A","COMD","55555","0","B","B","B"',
        '"20","2020-01-01","COM","75056","0","A","A","A","ARM","75101","0","B","B","B"',
        # Code mal formé : compté, pas écrit.
        '"32","2020-01-01","COM","9999","0","A","A","A","COM","77777","0","B","B","B"',
    ]
) + "\n"


def test_commune_code_changes_are_read_from_the_insee_movements_file() -> None:
    from src.reference_data import commune_history

    rows, stats = commune_history.parse_movements(MOVEMENTS_SAMPLE)

    assert [(row["old_code"], row["new_code"], row["modality"]) for row in rows] == [
        ("02077", "02564", "35"),
        ("01324", "01245", "34"),
        ("49007", "49018", "32"),
        ("2B033", "2A004", "41"),
    ]
    assert rows[0]["effective_on"] == date(2026, 1, 1)
    assert (stats.lines, stats.kept, stats.duplicates, stats.rejected) == (12, 4, 1, 1)
    older, _ = commune_history.parse_movements(MOVEMENTS_SAMPLE, since=date(2000, 1, 1))
    assert ("11111", "22222") in {(row["old_code"], row["new_code"]) for row in older}


def test_a_movements_file_without_the_expected_columns_is_refused() -> None:
    from src.reference_data import commune_history

    with pytest.raises(RuntimeError, match="MOD"):
        commune_history.parse_movements('"A","B"\n"1","2"\n')


def test_the_commune_history_is_a_private_snapshot_outside_all(monkeypatch, tmp_path: Path) -> None:
    statement = storage.upsert_statement("commune_code_history")
    assert "insert into app_private.commune_code_history" in statement
    assert "on conflict (old_code, new_code, effective_on)" in statement and "imported_at = now()" in statement
    assert "commune_history" not in reference_main.DATASETS and "commune_history" in reference_main.EXTRA_DATASETS
    assert reference_main.parse_args(["commune_history", "--dry-run"]).dataset == "commune_history"
    assert "www.insee.fr" in download_module.ALLOWED_HOSTS

    def fake_download(url: str, target: Path, **kwargs) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            f'"32","2019-01-01","COM","{10000 + index:05d}","0","A","A","A","COM","{50000 + index:05d}","0","B","B","B"'
            for index in range(reference_main.MIN_COMMUNE_CODE_CHANGES)
        ]
        target.write_text(MOVEMENTS_HEADER + "\n".join(lines) + "\n", encoding="utf-8")
        return target

    monkeypatch.setattr(reference_main, "download", fake_download)
    calls = _fake_storage(monkeypatch, current_rows=0)

    summary = reference_main._import_commune_history(tmp_path, _FakeDatabase())

    assert calls[-1] == ("replace", "commune_code_history", reference_main.MIN_COMMUNE_CODE_CHANGES, None)
    assert summary["code_changes"] == reference_main.MIN_COMMUNE_CODE_CHANGES

    monkeypatch.setattr(reference_main, "download", lambda url, target, **kw: _write_sample(target))
    with pytest.raises(RuntimeError, match="partial import"):
        reference_main._import_commune_history(tmp_path, _FakeDatabase())


def _write_sample(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(MOVEMENTS_SAMPLE, encoding="utf-8")
    return target
