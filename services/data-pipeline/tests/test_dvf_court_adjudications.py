from __future__ import annotations

import csv
import gzip
import io
from contextlib import nullcontext
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import src.dvf_court_adjudications as dvf

FIELDS = [
    "id_mutation",
    "date_mutation",
    "nature_mutation",
    "valeur_fonciere",
    "code_commune",
    "code_departement",
    "id_parcelle",
    "lot1_numero",
    "code_type_local",
    "surface_reelle_bati",
    "code_nature_culture",
    "surface_terrain",
]


def row(**values: str) -> dict[str, str]:
    base = {field: "" for field in FIELDS}
    base.update(nature_mutation="Adjudication", date_mutation="2024-03-14", code_commune="93008", code_departement="93")
    base.update(values)
    return base


ROWS = [
    # A flat with its cellar: one apartment of 52 m².
    row(
        id_mutation="2024-1",
        valeur_fonciere="120000",
        id_parcelle="93008000AB0001",
        lot1_numero="12",
        code_type_local="2",
        surface_reelle_bati="52",
    ),
    row(
        id_mutation="2024-1",
        valeur_fonciere="120000",
        id_parcelle="93008000AB0001",
        lot1_numero="40",
        code_type_local="3",
    ),
    # A house listed once per culture of its parcel: one house, two land surfaces.
    row(
        id_mutation="2024-2",
        valeur_fonciere="210000",
        id_parcelle="93008000AC0002",
        code_type_local="1",
        surface_reelle_bati="90",
        code_nature_culture="S",
        surface_terrain="300",
    ),
    row(
        id_mutation="2024-2",
        valeur_fonciere="210000",
        id_parcelle="93008000AC0002",
        code_type_local="1",
        surface_reelle_bati="90",
        code_nature_culture="J",
        surface_terrain="200",
    ),
    # Bare land.
    row(
        id_mutation="2024-3",
        valeur_fonciere="15000",
        id_parcelle="93008000AD0003",
        code_nature_culture="T",
        surface_terrain="1200",
    ),
    # Not an adjudication.
    row(
        id_mutation="2024-4",
        nature_mutation="Vente",
        valeur_fonciere="300000",
        code_type_local="2",
        surface_reelle_bati="60",
    ),
    # No price: unusable.
    row(id_mutation="2024-5", code_type_local="2", surface_reelle_bati="30"),
]


def test_one_adjudication_per_mutation() -> None:
    result = {item.mutation_id: item for item in dvf.iter_adjudications(ROWS)}
    assert sorted(result) == ["2024-1", "2024-2", "2024-3"]
    flat = result["2024-1"]
    assert (flat.property_type, flat.built_surface_m2, flat.local_count, flat.price_eur) == (
        "apartment",
        Decimal(52),
        1,
        Decimal(120000),
    )
    house = result["2024-2"]
    assert (house.property_type, house.built_surface_m2, house.land_surface_m2) == ("house", Decimal(90), Decimal(500))
    assert result["2024-3"].property_type == "land"
    assert result["2024-3"].mutation_date == date(2024, 3, 14)


def test_portfolio_transfers_are_left_out() -> None:
    rows = [
        row(
            id_mutation="2024-9",
            valeur_fonciere="4000000",
            id_parcelle="P",
            lot1_numero=str(n),
            code_type_local="2",
            surface_reelle_bati="40",
        )
        for n in range(dvf.MAX_LOCALS_PER_MUTATION + 1)
    ]
    assert list(dvf.iter_adjudications(rows)) == []


def test_arrondissements_fall_back_to_the_city() -> None:
    courts = {
        "75056": SimpleNamespace(court_code="justice_tj_paris"),
        "93008": SimpleNamespace(court_code="justice_tj_bobigny"),
    }
    assert dvf.court_code_for("75118", courts.get) == "justice_tj_paris"
    assert dvf.court_code_for("93008", courts.get) == "justice_tj_bobigny"
    assert dvf.court_code_for("01001", courts.get) is None


def test_department_listing_is_read_from_the_index() -> None:
    html = (
        '<a href="/geo-dvf/latest/csv/2024/departements/01.csv.gz">01</a><a href="2A.csv.gz">2A</a><a href="../">..</a>'
    )
    assert dvf.department_files(2024, html) == ["01", "2A"]


def _gzip_csv(rows: list[dict[str, str]]) -> bytes:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=FIELDS)
    writer.writeheader()
    writer.writerows(rows)
    return gzip.compress(buffer.getvalue().encode("utf-8"))


def test_import_upserts_each_department(monkeypatch) -> None:
    executed: list[list[tuple]] = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def executemany(self, _sql, rows):
            executed.append(list(rows))

    connection = SimpleNamespace(cursor=lambda: Cursor(), commit=lambda: None)
    monkeypatch.setattr("src.storage.supabase_client.connect", lambda _url: nullcontext(connection))

    def fetch(url: str) -> bytes:
        if url.endswith("/93.csv.gz"):
            return _gzip_csv(ROWS)
        raise OSError("missing file")

    counts = dvf.import_years(
        "postgresql://test",
        [2024],
        resolve=lambda insee: SimpleNamespace(court_code="justice_tj_bobigny") if insee == "93008" else None,
        fetch=fetch,
        departments=["93", "94"],
    )
    assert counts == {"departments": 1, "adjudications": 3, "with_court": 3, "failed_departments": 1}
    assert executed[0][0][4] == "justice_tj_bobigny" and executed[0][0][-1] == 2024


def test_default_years_cover_three_published_years_and_more() -> None:
    assert dvf.default_years(date(2026, 10, 12)) == [2022, 2023, 2024, 2025]
