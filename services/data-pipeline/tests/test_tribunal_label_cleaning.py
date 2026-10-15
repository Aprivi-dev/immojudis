"""Rattachement des libellés de tribunal : suffixe « (Département) », préfixes répétés, variantes, notaires."""

import pytest

from src.court_competence import (
    OfficialCourt,
    OfficialCourtLabelIndex,
    _short_court_name,
    court_label_variants,
)
from src.normalize import normalize_sale
from src.sale_procedure import classify_sale_procedure
from src.tribunal import fill_tribunal
from src.tribunal_labels import tribunal_label_is_notarial_venue


def _court(code: str, short: str, official: str, department: str) -> OfficialCourt:
    return OfficialCourt(
        court_code=code,
        court_name=short,
        official_court_name=official,
        court_origin_code="1",
        court_srj_code=code,
        court_department=department,
        court_city=short[3:],
    )


NATIONAL_COURTS = OfficialCourtLabelIndex(
    [
        _court("arras", "TJ Arras", "Tribunal judiciaire d'Arras", "62"),
        _court("versailles", "TJ Versailles", "Tribunal judiciaire de Versailles", "78"),
        _court("lemans", "TJ Le Mans", "Tribunal judiciaire du Mans", "72"),
        _court("lehavre", "TJ Le Havre", "Tribunal judiciaire du Havre", "76"),
        _court("sables", "TJ Les Sables-d'Olonne", "Tribunal judiciaire des Sables-d'Olonne", "85"),
        _court("gaudens", "TJ Saint-Gaudens", "Tribunal judiciaire de Saint-Gaudens", "31"),
        _court("briey", "TJ Val-de-Briey", "Tribunal judiciaire de Val-de-Briey", "54"),
        _court("nancy", "TJ Nancy", "Tribunal judiciaire de Nancy", "54"),
    ]
)


@pytest.fixture(autouse=True)
def national_court_registry(monkeypatch):
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", NATIONAL_COURTS.resolve)


def _filled(label: str, **extra: object):
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": f"https://www.licitor.com/annonce/{abs(hash(label))}.html",
            "tribunal": label,
            **extra,
        }
    )
    return fill_tribunal(sale)


@pytest.mark.parametrize(
    "label,code",
    [
        ("Tribunal Judiciaire d'Arras (Pas de Calais)", "arras"),
        ("Tribunal Judiciaire de Versailles (Yvelines)", "versailles"),
        ("Tribunal Judiciaire du Mans (Sarthe)", "lemans"),
        ("Tribunal Judiciaire du Havre (Seine-Maritime)", "lehavre"),
        ("Tribunal Judiciaire des Sables-d'Olonne (Vendée)", "sables"),
        # Préfixe répété produit par Vench / Petites Affiches.
        ("TJ Tribunal judiciaire du Mans", "lemans"),
        ("TJ Tribunal judiciaire du Havre", "lehavre"),
        # Variantes non rattachées jusqu'ici.
        ("TJ Saint Gaudens", "gaudens"),
        ("TJ St Gaudens", "gaudens"),
        ("TJ Briey", "briey"),
        ("TJ Val de Briey", "briey"),
        ("TJ Les Sables D Olonne", "sables"),
        ("TJ Le Mans", "lemans"),
    ],
)
def test_tribunal_labels_attach_to_the_national_registry(label: str, code: str) -> None:
    sale = _filled(label)

    assert sale.tribunal_code == code
    assert sale.tribunal and sale.tribunal.startswith("TJ ")
    assert "Tribunal" not in sale.tribunal
    assert "tribunal_competence_unverified" in sale.quality_flags
    assert "tribunal_inconsistent" not in sale.quality_flags


def test_a_label_naming_no_known_court_stays_unattached() -> None:
    sale = _filled("Tribunal Judiciaire de Quimperlé (Finistère)")

    assert sale.tribunal_code is None


def test_a_bare_commune_is_never_a_court() -> None:
    assert NATIONAL_COURTS.resolve("Marseille (Bouches-du-Rhône)") is None
    assert NATIONAL_COURTS.resolve("Le Mans") is None


def test_label_variants_clean_without_inventing() -> None:
    assert court_label_variants("TJ Nancy") == ["TJ Nancy"]
    assert court_label_variants("Marseille (13)") == ["Marseille (13)"]
    assert court_label_variants("Tribunal Judiciaire d'Arras (Pas de Calais)")[-1] == "tj arras"
    assert court_label_variants("TJ Briey")[-1] == "tj val de briey"


@pytest.mark.parametrize(
    "official,short",
    [
        ("Tribunal judiciaire de Pau", "TJ Pau"),
        ("Tribunal judiciaire d'Arras", "TJ Arras"),
        ("Tribunal judiciaire du Mans", "TJ Le Mans"),
        ("Tribunal judiciaire du Havre", "TJ Le Havre"),
        ("Tribunal judiciaire des Sables-d'Olonne", "TJ Les Sables-d'Olonne"),
    ],
)
def test_canonical_short_names_never_repeat_the_court_prefix(official: str, short: str) -> None:
    assert _short_court_name(official) == short


def test_a_notary_office_is_not_a_court() -> None:
    assert tribunal_label_is_notarial_venue("TJ En L'Étude Du Notaire")
    assert tribunal_label_is_notarial_venue("Tribunal judiciaire de En l'étude du Notaire")
    assert not tribunal_label_is_notarial_venue("TJ Nancy")


@pytest.mark.parametrize("label", ["TJ En L'Étude Du Notaire", "Tribunal judiciaire de En l'étude du Notaire"])
def test_a_vench_notarial_sale_has_no_court_and_a_notarial_procedure(label: str) -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-170001-une-maison-testville.html",
            "tribunal": label,
            "city": "Testville",
            "postal_code": "47000",
            "department": "47",
            "raw_text": "Vente aux enchères. Tribunal judiciaire de En l'étude du Notaire. Mise à prix 50 000 €",
            "source_blocks": {"tribunal": "Tribunal judiciaire de En l'étude du Notaire"},
        }
    )

    fill_tribunal(sale)
    fill_tribunal(sale)  # recalcul : le libellé écarté ne doit pas être retrouvé dans le texte brut

    assert sale.tribunal is None
    assert sale.tribunal_code is None
    assert "non_judicial_sale_context" in sale.quality_flags
    assert sale.raw_payload["tribunal_label_rejected"]

    classify_sale_procedure(sale)

    assert sale.sale_venue_type == "notary"


def test_a_vench_sale_with_a_real_court_keeps_its_court() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-170002-une-maison-nancy.html",
            "tribunal": "Tribunal judiciaire de Nancy",
            "city": "Nancy",
            "raw_text": "Tribunal judiciaire de Nancy. Mise à prix 50 000 €",
        }
    )

    fill_tribunal(sale)
    classify_sale_procedure(sale)

    assert sale.tribunal == "TJ Nancy"
    assert sale.sale_venue_type == "tribunal"
