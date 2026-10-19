"""Tribunal lu dans la description (Avoventes, Enchères Immobilières), alias de site et libellés pollués."""

import pytest

from src.court_competence import OfficialCourt, OfficialCourtLabelIndex
from src.normalize import normalize_sale
from src.tribunal import _resolve_polluted_label_court, fill_tribunal


def _court(code: str, city: str, department: str) -> OfficialCourt:
    return OfficialCourt(
        court_code=code,
        court_name=f"TJ {city}",
        official_court_name=f"Tribunal judiciaire de {city}",
        court_origin_code="1",
        court_srj_code=code,
        court_department=department,
        court_city=city,
    )


COURTS = OfficialCourtLabelIndex(
    [
        _court("nice", "Nice", "06"),
        _court("toulouse", "Toulouse", "31"),
        _court("lille", "Lille", "59"),
        _court("gaudens", "Saint-Gaudens", "31"),
    ]
)


@pytest.fixture(autouse=True)
def national_court_registry(monkeypatch):
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", COURTS.resolve)


def _sale(source: str, **extra: object):
    return normalize_sale(
        {
            "source_name": source,
            "source_url": f"https://example.test/{source}/1",
            "title": "Maison à Menton",
            **extra,
        }
    )


@pytest.mark.parametrize("source", ["avoventes", "encheres_immobilieres"])
def test_empty_tribunal_is_read_from_the_description(source: str) -> None:
    sale = _sale(
        source,
        description="Vente aux enchères publiques au Tribunal Judiciaire de Nice, le 5 novembre.",
        raw_text="Maison à Menton",
    )
    assert not sale.tribunal

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Nice"
    assert sale.tribunal_code == "nice"
    assert "tribunal_competence_unverified" in sale.quality_flags


def test_a_filled_tribunal_field_wins_over_the_description() -> None:
    sale = _sale(
        "avoventes",
        tribunal="Tribunal Judiciaire de Lille",
        description="Audience au Tribunal Judiciaire de Nice.",
        raw_text="Maison à Menton",
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Lille"


def test_other_sources_do_not_read_the_description() -> None:
    sale = _sale(
        "vench",
        description="Audience au Tribunal Judiciaire de Nice.",
        raw_text="Maison à Menton",
    )

    fill_tribunal(sale)

    assert sale.tribunal is None


@pytest.mark.parametrize(
    "label",
    [
        "Toulouse Site Deville",
        "TJ Toulouse Site Deville",
        "Tribunal Judiciaire de Toulouse Site Deville",
        "TJ Toulouse Site Deville le",
    ],
)
def test_toulouse_site_deville_is_the_toulouse_court(label: str) -> None:
    sale = _sale("avoventes", tribunal=label)

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Toulouse"
    assert sale.tribunal_code == "toulouse"


def test_toulouse_site_deville_in_the_description_is_the_toulouse_court() -> None:
    sale = _sale(
        "encheres_immobilieres",
        description="Adjudication au Tribunal Judiciaire de Toulouse Site Deville le 12 novembre 2026.",
        raw_text="Maison à Muret",
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Toulouse"


@pytest.mark.parametrize("label", ["Saint Gaudens", "Saint-Gaudens", "SAINT GAUDENS", "TJ St Gaudens"])
def test_saint_gaudens_spellings_attach_to_the_court(label: str) -> None:
    sale = _sale("avoventes", tribunal=label)

    fill_tribunal(sale)

    assert sale.tribunal_code == "gaudens"


@pytest.mark.parametrize(
    "label,court,cleaned",
    [
        ("TJ Tribunal Judiciaire de LILLE le", "TJ Lille", "TJ lille"),
        ("TJ Tribunal Judiciaire de SAINT GAUDENS le", "TJ Saint-Gaudens", "TJ saint gaudens"),
        ("Tribunal Judiciaire de SAINT GAUDENS le 3 décembre", "TJ Saint-Gaudens", "TJ saint gaudens"),
    ],
)
def test_polluted_labels_are_cleaned_to_the_named_court(label: str, court: str, cleaned: str) -> None:
    resolved, source_label = _resolve_polluted_label_court(label)

    assert resolved is not None and resolved.court_name == court
    assert source_label == cleaned

    sale = _sale("avoventes", tribunal=label)
    fill_tribunal(sale)

    assert sale.tribunal == court


@pytest.mark.parametrize(
    "label,expected",
    [
        # L'article « de l » ne doit pas manger l'initiale du nom (« de Lille » -> « ille »).
        ("TJ Tribunal Judiciaire de LILLE le", ["lille le", "lille"]),
        ("Tribunal judiciaire de Lyon", ["lyon"]),
        ("Tribunal judiciaire de Laval", ["laval"]),
        ("TJ Dax", ["dax"]),
        ("Tribunal judiciaire du Mans", ["mans"]),
        ("Tribunal judiciaire de l'Isle-Adam", ["isle adam"]),
        ("Tribunal judiciaire d'Arras", ["arras"]),
    ],
)
def test_leading_court_words_keep_the_initial_of_the_name(label: str, expected: list[str]) -> None:
    from src.tribunal_labels import court_name_candidates

    assert court_name_candidates(label) == expected
