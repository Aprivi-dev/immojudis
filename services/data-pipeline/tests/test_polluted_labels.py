"""Libellés pollués : tribunal rattaché au référentiel national, ville sans texte d'annonce."""

import pytest

from src.court_competence import OfficialCourt, OfficialCourtLabelIndex, _valid_label_assignment_evidence
from src.normalize import normalize_sale
from src.tribunal import LABEL_ASSIGNMENT_KEY, fill_tribunal
from src.tribunal_labels import (
    clean_city_label,
    court_name_candidates,
    tribunal_label_is_polluted,
    trim_court_city,
)


def _court(code: str, city: str, department: str, srj: str) -> OfficialCourt:
    return OfficialCourt(
        court_code=code,
        court_name=f"TJ {city}",
        official_court_name=f"Tribunal judiciaire de {city}",
        court_origin_code="1",
        court_srj_code=srj,
        court_department=department,
        court_city=city,
    )


REGISTRY = OfficialCourtLabelIndex(
    [
        _court("justice_tj_1_54", "Nancy", "54", "54"),
        _court("justice_tj_1_34", "Béziers", "34", "34"),
        _court("justice_tj_1_39", "Lons-le-Saunier", "39", "39"),
        _court("justice_tj_1_93", "Saint-Denis", "93", "93"),
        _court("justice_tj_1_974", "Saint-Denis de la Réunion", "974", "974"),
    ]
)


@pytest.fixture(autouse=True)
def national_court_registry(monkeypatch):
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", REGISTRY.resolve)


def _sale(tribunal: str | None, **extra: object):
    return normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/vente/pollution",
            "tribunal": tribunal,
            "city": "Chanteheux",
            **extra,
        }
    )


def test_court_label_with_duplicated_prefix_and_trailing_word_resolves_to_the_court() -> None:
    sale = _sale("TJ Tribunal Judiciaire de NANCY le")
    fill_tribunal(sale)

    assert sale.tribunal == "TJ Nancy"
    assert sale.tribunal_code == "justice_tj_1_54"
    evidence = sale.raw_payload[LABEL_ASSIGNMENT_KEY]
    assert evidence["raw_source_label"] == "TJ Tribunal Judiciaire de NANCY le"
    assert evidence["source_label"] == "TJ nancy"
    assert _valid_label_assignment_evidence(evidence)
    assert "tribunal_competence_unverified" in sale.quality_flags


def test_court_label_followed_by_announcement_text_resolves_to_the_court() -> None:
    sale = _sale("TJ Béziers Suite À Des Poursuites…")
    fill_tribunal(sale)

    assert sale.tribunal == "TJ Béziers"
    assert sale.tribunal_code == "justice_tj_1_34"
    assert "tribunal_inconsistent" not in sale.quality_flags


def test_compound_court_names_are_not_cut() -> None:
    sale = _sale("TJ Lons le Saunier")
    fill_tribunal(sale)
    assert sale.tribunal == "TJ Lons-le-Saunier"

    sale = _sale("Tribunal Judiciaire de Saint Denis de la Réunion statuant en audience")
    fill_tribunal(sale)
    assert sale.tribunal == "TJ Saint-Denis de la Réunion"
    assert sale.tribunal_code == "justice_tj_1_974"


def test_unknown_polluted_court_label_stays_absent() -> None:
    sale = _sale("TJ Inconnuville Suite À Des Poursuites…")
    fill_tribunal(sale)

    assert sale.tribunal is None
    assert sale.tribunal_code is None
    assert sale.raw_payload["tribunal_label_rejected"] == "TJ Inconnuville Suite À Des Poursuites…"
    assert "tribunal_inconsistent" in sale.quality_flags
    assert LABEL_ASSIGNMENT_KEY not in sale.raw_payload


def test_unknown_but_clean_court_label_is_kept_as_before() -> None:
    sale = _sale("TJ Inconnuville")
    fill_tribunal(sale)

    assert sale.tribunal == "TJ Inconnuville"
    assert "tribunal_competence_unverified" in sale.quality_flags


def test_explicit_court_read_in_the_text_stops_before_the_rest_of_the_sentence() -> None:
    sale = _sale(None, raw_text="Vente au Tribunal Judiciaire de NANCY le 15 octobre 2026 à 14h")
    fill_tribunal(sale)

    assert sale.tribunal == "TJ Nancy"
    assert sale.tribunal_code == "justice_tj_1_54"


def test_candidates_and_pollution_detection() -> None:
    assert court_name_candidates("TJ Tribunal Judiciaire de NANCY le") == ["nancy le", "nancy"]
    assert court_name_candidates("TJ Béziers Suite À Des Poursuites…")[-1] == "beziers"
    assert "saint denis" not in court_name_candidates("Tribunal judiciaire de Saint Denis de la Réunion")
    assert tribunal_label_is_polluted("TJ Béziers Suite À Des Poursuites…")
    assert tribunal_label_is_polluted("TJ Tribunal Judiciaire de NANCY")
    assert not tribunal_label_is_polluted("TJ Lons le Saunier")
    assert not tribunal_label_is_polluted("Tribunal judiciaire de Bordeaux")
    assert trim_court_city("Béziers Suite À Des Poursuites") == "Béziers"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("USAGE D'HABITATION à Chanteheux", "Chanteheux"),
        ("Maison à usage d'habitation à Chanteheux", "Chanteheux"),
        ("USAGE D'HABITATION", None),
        ("Chanteheux", "Chanteheux"),
        ("Saint-Étienne", "Saint-Étienne"),
        ("Maisons-Laffitte", "Maisons-Laffitte"),
        ("Bourg-en-Bresse", "Bourg-en-Bresse"),
        ("Aix en Provence", "Aix en Provence"),
        (None, None),
    ],
)
def test_clean_city_label(value: str | None, expected: str | None) -> None:
    assert clean_city_label(value) == expected


def test_normalize_cuts_the_city_before_a_when_the_prefix_is_not_a_commune() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/vente/ville",
            "city": "USAGE D'HABITATION à Chanteheux",
        }
    )
    assert sale.city == "Chanteheux"

    absent = normalize_sale(
        {"source_name": "avoventes", "source_url": "https://example.test/vente/ville2", "city": "USAGE D'HABITATION"}
    )
    assert absent.city is None


def test_label_with_street_and_digits_is_not_dropped_when_the_registry_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", lambda label: None)
    sale = _sale("Tribunal Judiciaire de Bordeaux, 12 rue du Palais de Justice 33000")
    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert "tribunal_label_rejected" not in sale.raw_payload
