"""n° 66 : alias de tribunal « Saint Gaudens », tribunal déduit du lieu de vente, prix au m², emails du descriptif."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest

from src.asset_normalization import _fill_quality_flags
from src.asset_normalization_helpers import PRICE_PER_M2_IMPLAUSIBLE_FLAG
from src.court_competence import OfficialCourt, OfficialCourtLabelIndex
from src.normalize import normalize_sale
from src.personal_data import EMAIL_PLACEHOLDER, redact_email_addresses, redact_payload, redact_storage_row
from src.tribunal import fill_tribunal


def _court(code: str, name: str, official: str, department: str) -> OfficialCourt:
    return OfficialCourt(
        court_code=code,
        court_name=name,
        official_court_name=official,
        court_origin_code="1",
        court_srj_code=code,
        court_department=department,
        court_city=name,
    )


# Le référentiel national écrit « St Gaudens » (migration 20260824163134) : c'est ce libellé que la source
# « Saint Gaudens » doit retrouver.
REGISTRY = OfficialCourtLabelIndex(
    [
        _court("justice_tj_9_48313", "TJ St Gaudens", "Tribunal judiciaire de St Gaudens", "31"),
        _court("pontoise", "TJ Pontoise", "Tribunal judiciaire de Pontoise", "95"),
        _court("paris", "TJ Paris", "Tribunal judiciaire de Paris", "75"),
    ]
)


@pytest.fixture(autouse=True)
def national_court_registry(monkeypatch):
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", REGISTRY.resolve)
    monkeypatch.setattr("src.tribunal.resolve_competent_court", lambda sale: None)


def _sale(source: str = "licitor", **extra: object):
    return normalize_sale(
        {"source_name": source, "source_url": f"https://example.test/{source}/1", "title": "Maison", **extra}
    )


# --- alias Saint Gaudens -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "label",
    [
        "Saint Gaudens",
        "Saint-Gaudens",
        "SAINT GAUDENS",
        "TJ Saint Gaudens",
        "TJ St Gaudens",
        "Tribunal Judiciaire de Saint-Gaudens",
        "Tribunal Judiciaire de SAINT GAUDENS le 3 décembre",
    ],
)
def test_every_spelling_of_saint_gaudens_reaches_the_registry_court(label: str) -> None:
    sale = _sale(tribunal=label)

    fill_tribunal(sale)

    assert sale.tribunal_code == "justice_tj_9_48313"


def test_a_label_naming_another_saint_court_does_not_match_saint_gaudens() -> None:
    sale = _sale(tribunal="TJ Saint Girons")

    fill_tribunal(sale)

    assert sale.tribunal_code != "justice_tj_9_48313"


# --- tribunal déduit du lieu de vente ---------------------------------------------------------------------


def test_a_venue_city_from_petites_affiches_gives_a_flagged_deduced_tribunal() -> None:
    sale = _sale("petites_affiches", tribunal="Bordeaux", city="Bordeaux")

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert "tribunal_deduced" in sale.quality_flags
    assert sale.raw_payload["tribunal_deduced"] == {
        "source_label": "Bordeaux",
        "tribunal": "TJ Bordeaux",
        "method": "city_list",
    }


def test_a_tribunal_deduced_from_the_commune_competence_is_flagged_too(monkeypatch) -> None:
    court = SimpleNamespace(court_name="TJ Paris", court_code="paris", evidence=lambda: {"status": "verified"})
    monkeypatch.setattr("src.tribunal.resolve_competent_court", lambda sale: court)
    sale = _sale("petites_affiches", tribunal="Paris", city="Paris")

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Paris"
    assert sale.raw_payload["tribunal_deduced"]["method"] == "commune_competence"
    assert sale.raw_payload["tribunal_deduced"]["source_label"] == "Paris"


def test_an_explicit_tribunal_label_is_not_flagged() -> None:
    sale = _sale("petites_affiches", tribunal="Tribunal Judiciaire de PONTOISE")

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Pontoise"
    assert "tribunal_deduced" not in sale.quality_flags
    assert "tribunal_deduced" not in sale.raw_payload


def test_other_sources_are_not_flagged() -> None:
    sale = _sale("licitor", tribunal="Bordeaux", city="Bordeaux")

    fill_tribunal(sale)

    assert "tribunal_deduced" not in sale.quality_flags


def test_the_deduced_marker_survives_a_second_pass_over_the_stored_tribunal() -> None:
    sale = _sale("petites_affiches", tribunal="Bordeaux", city="Bordeaux")
    fill_tribunal(sale)
    stored = _sale("petites_affiches", tribunal=sale.tribunal, city="Bordeaux")
    stored.raw_payload["tribunal_deduced"] = dict(sale.raw_payload["tribunal_deduced"])

    fill_tribunal(stored)

    assert "tribunal_deduced" in stored.quality_flags
    assert stored.raw_payload["tribunal_deduced"]["source_label"] == "Bordeaux"


# --- prix au m² ----------------------------------------------------------------------------------------


def _priced(price: str, surface: str | None, *flags: str):
    sale = _sale(property_type="apartment", city="Paris")
    sale.starting_price_eur = Decimal(price)
    sale.app_surface_m2 = Decimal(surface) if surface else None
    sale.quality_flags = list(flags)
    return sale


def test_3_5_million_euros_for_23_6_m2_is_flagged() -> None:
    sale = _priced("3500000", "23.6")

    _fill_quality_flags(sale)

    assert PRICE_PER_M2_IMPLAUSIBLE_FLAG in sale.quality_flags


@pytest.mark.parametrize(("price", "surface"), [("120000", "60"), ("1000", "120"), ("600000", "30"), ("100000", None)])
def test_ordinary_prices_are_not_flagged(price: str, surface: str | None) -> None:
    sale = _priced(price, surface)

    _fill_quality_flags(sale)

    assert PRICE_PER_M2_IMPLAUSIBLE_FLAG not in sale.quality_flags


def test_a_multi_lot_sale_is_not_flagged_and_a_stale_flag_goes_away() -> None:
    multi = _priced("3500000", "23.6", "multi_lot_sale")
    _fill_quality_flags(multi)
    assert PRICE_PER_M2_IMPLAUSIBLE_FLAG not in multi.quality_flags

    stale = _priced("120000", "60", PRICE_PER_M2_IMPLAUSIBLE_FLAG)
    _fill_quality_flags(stale)
    assert PRICE_PER_M2_IMPLAUSIBLE_FLAG not in stale.quality_flags


# --- emails du descriptif -----------------------------------------------------------------------------------


def test_emails_are_masked_in_a_published_text() -> None:
    text = "Visites sur rendez-vous : cabinet.dupont@avocats-lyon.fr ou jean_martin+vente@mail.example.com."

    assert redact_email_addresses(text) == f"Visites sur rendez-vous : {EMAIL_PLACEHOLDER} ou {EMAIL_PLACEHOLDER}."


@pytest.mark.parametrize("text", ["Rue de l'@venir", "contact@", "prix 100 @ 2", "", None])
def test_text_without_an_email_is_unchanged(text: str | None) -> None:
    assert redact_email_addresses(text) == text


def test_the_storage_row_masks_the_description_and_the_published_payload_texts_only() -> None:
    row = {
        "description": "Écrire à greffe@tj.example.fr pour visiter.",
        "lawyer_contact": "avocat@cabinet.example.fr",
        "raw_payload": {
            "description": "Contact : avocat@cabinet.example.fr",
            "llm_display_description": "Contactez avocat@cabinet.example.fr",
            "source_blocks": {"avocat": "avocat@cabinet.example.fr"},
        },
    }

    result = redact_storage_row(row)

    assert result["description"] == f"Écrire à {EMAIL_PLACEHOLDER} pour visiter."
    assert result["raw_payload"]["description"] == f"Contact : {EMAIL_PLACEHOLDER}"
    assert result["raw_payload"]["llm_display_description"] == f"Contactez {EMAIL_PLACEHOLDER}"
    # Les coordonnées de l'avocat restent là où l'application les lit.
    assert result["lawyer_contact"] == "avocat@cabinet.example.fr"
    assert result["raw_payload"]["source_blocks"] == {"avocat": "avocat@cabinet.example.fr"}


def test_redact_payload_masks_emails_of_observations_payloads() -> None:
    payload = {"source_description": "écrire a x@y.fr", "title": "x@y.fr"}

    assert redact_payload(payload) == {"source_description": f"écrire a {EMAIL_PLACEHOLDER}", "title": "x@y.fr"}
