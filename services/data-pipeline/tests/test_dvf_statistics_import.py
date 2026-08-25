from datetime import date

from src import dvf_statistics_import
from src.dvf_statistics_import import (
    DvfStatisticsImportOptions,
    import_dvf_statistics,
    normalize_statistics_row,
)


def test_normalize_statistics_row_expands_supported_segments() -> None:
    rows = normalize_statistics_row(
        {
            "code_geo": "65099",
            "libelle_geo": "Bordères-Louron",
            "code_parent": "246500482",
            "echelle_geo": "commune",
            "nb_ventes_whole_appartement": "2",
            "moy_prix_m2_whole_appartement": "2100",
            "med_prix_m2_whole_appartement": "2050",
            "nb_ventes_whole_maison": "18",
            "moy_prix_m2_whole_maison": "2380",
            "med_prix_m2_whole_maison": "2250",
            "nb_ventes_whole_apt_maison": "20",
            "moy_prix_m2_whole_apt_maison": "2350",
            "med_prix_m2_whole_apt_maison": "2220",
            "nb_ventes_whole_local": "",
            "moy_prix_m2_whole_local": "",
            "med_prix_m2_whole_local": "",
        },
        source_updated_at=date(2026, 4, 27),
    )

    assert [row["segment"] for row in rows] == ["apartment", "house", "residential"]
    assert rows[1]["geography_level"] == "commune"
    assert rows[1]["geography_code"] == "65099"
    assert rows[1]["parent_code"] == "246500482"
    assert rows[1]["sales_count"] == 18
    assert str(rows[1]["median_price_per_m2"]) == "2250"
    assert rows[1]["source_updated_at"] == date(2026, 4, 27)


def test_normalize_statistics_row_ignores_sections_and_empty_values() -> None:
    rows = normalize_statistics_row(
        {
            "code_geo": "650990000A",
            "libelle_geo": "650990000A",
            "code_parent": "65099",
            "echelle_geo": "section",
            "nb_ventes_whole_maison": "4",
            "med_prix_m2_whole_maison": "1800",
        }
    )

    assert rows == []


def test_normalize_statistics_row_drops_ambiguous_epci_department_parent() -> None:
    rows = normalize_statistics_row(
        {
            "code_geo": "200006682",
            "libelle_geo": "CA Beaune, Cote et Sud",
            "code_parent": "21",
            "echelle_geo": "epci",
            "nb_ventes_whole_maison": "42",
            "moy_prix_m2_whole_maison": "2300",
            "med_prix_m2_whole_maison": "2250",
        }
    )

    assert len(rows) == 1
    assert rows[0]["parent_code"] is None


def test_upsert_statistics_uses_one_multi_row_statement() -> None:
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)
    payload = [
        {column: f"first-{column}" for column in dvf_statistics_import.STATISTICS_COLUMNS},
        {column: f"second-{column}" for column in dvf_statistics_import.STATISTICS_COLUMNS},
    ]

    upserted_rows = dvf_statistics_import._upsert_statistics(connection, payload)

    assert upserted_rows == 2
    assert len(cursor.calls) == 1
    assert len(cursor.calls[0][1]) == 2 * len(dvf_statistics_import.STATISTICS_COLUMNS)
    assert cursor.calls[0][1][0] == "first-geography_level"
    assert cursor.calls[0][1][-1] == "second-imported_at"


def test_upsert_statistics_deduplicates_conflicting_keys_within_batch() -> None:
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)
    first = {column: f"first-{column}" for column in dvf_statistics_import.STATISTICS_COLUMNS}
    second = {column: f"second-{column}" for column in dvf_statistics_import.STATISTICS_COLUMNS}
    for column, value in {
        "geography_level": "epci",
        "geography_code": "200006682",
        "segment": "house",
    }.items():
        first[column] = value
        second[column] = value

    upserted_rows = dvf_statistics_import._upsert_statistics(connection, [first, second])

    assert upserted_rows == 1
    assert len(cursor.calls) == 1
    assert len(cursor.calls[0][1]) == len(dvf_statistics_import.STATISTICS_COLUMNS)
    assert cursor.calls[0][1][2] == "second-geography_label"


def test_import_statistics_commits_each_batch(tmp_path, monkeypatch) -> None:
    path = tmp_path / "statistics.csv"
    path.write_text(
        "code_geo,libelle_geo,echelle_geo,nb_ventes_whole_maison,med_prix_m2_whole_maison\n"
        "65099,Bordères-Louron,commune,2,2250\n",
        encoding="utf-8",
    )
    cursor = RecordingCursor()
    connection = RecordingConnection(cursor)
    monkeypatch.setattr(
        dvf_statistics_import,
        "load_settings",
        lambda: {"supabase_db_url": "postgresql://example"},
    )
    monkeypatch.setattr(
        dvf_statistics_import,
        "_postgres_connect",
        lambda db_url: connection,
    )
    monkeypatch.setattr(dvf_statistics_import, "_upsert_statistics", lambda conn, rows: len(rows))

    summary = import_dvf_statistics(DvfStatisticsImportOptions(path=path, batch_size=1))

    assert summary.upserted_rows == 1
    assert connection.commits == 1


class RecordingCursor:
    def __init__(self) -> None:
        self.calls: list[tuple[object, list[object]]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None

    def execute(self, statement: object, values: list[object]) -> None:
        self.calls.append((statement, values))

    def executemany(self, statement: object, values: object) -> None:
        raise AssertionError("DVF imports must not use psycopg pipeline mode")


class RecordingConnection:
    def __init__(self, cursor: RecordingCursor) -> None:
        self._cursor = cursor
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None

    def cursor(self) -> RecordingCursor:
        return self._cursor

    def commit(self) -> None:
        self.commits += 1
