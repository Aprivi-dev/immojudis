from datetime import date

from src.dvf_statistics_import import normalize_statistics_row


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
