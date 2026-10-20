"""Surfaces et types incohérents : Carrez au-dessus de l'habitable, box typé terrain, « appartement » de 5 m²."""

from decimal import Decimal

import pytest

from src.asset_normalization import normalize_asset_features
from src.normalize import (
    carrez_is_implausible_against_habitable,
    carrez_rejection_basis,
    is_parking_label,
    normalize_property_type,
    normalize_sale,
)


def _raw(**overrides: object) -> dict[str, object]:
    return {
        "source_name": "avoventes",
        "source_url": "https://example.test/vente/coherence",
        "city": "Bordeaux",
        "postal_code": "33000",
        "starting_price_eur": "50 000 €",
        **overrides,
    }


# --- Carrez au-dessus de l'habitable -------------------------------------------------------------------------


def test_a_carrez_above_the_habitable_surface_plus_two_percent_is_rejected() -> None:
    habitable = Decimal("60")

    assert carrez_rejection_basis(Decimal("61.2"), habitable) is None  # +2 % : tolérance de mesure
    assert carrez_rejection_basis(Decimal("61.21"), habitable) == "carrez_above_habitable_surface"
    assert carrez_rejection_basis(Decimal("11"), habitable) == "carrez_below_20_percent_of_habitable_surface"
    assert carrez_rejection_basis(Decimal("58"), habitable) is None
    assert carrez_rejection_basis(None, habitable) is None
    assert carrez_is_implausible_against_habitable(Decimal("75"), habitable)


def test_normalisation_drops_a_carrez_above_the_habitable_and_traces_it() -> None:
    sale = normalize_sale(_raw(property_type="apartment", carrez_surface_m2="75", habitable_surface_m2="60"))
    normalize_asset_features(sale)

    assert sale.carrez_surface_m2 is None
    assert sale.habitable_surface_m2 == Decimal("60")
    assert sale.app_surface_m2 == Decimal("60")
    reconciliation = sale.raw_payload["carrez_surface_reconciliation"]
    assert reconciliation["basis"] == "carrez_above_habitable_surface"
    assert reconciliation["rejected_carrez_surface_m2"] == "75"


def test_a_plausible_carrez_is_kept() -> None:
    sale = normalize_sale(_raw(property_type="apartment", carrez_surface_m2="58", habitable_surface_m2="60"))
    normalize_asset_features(sale)

    assert sale.carrez_surface_m2 == Decimal("58")


# --- box et stationnement -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "label",
    ["Box", "Un box fermé", "box", "Garage", "Parking", "Stationnement", "Place de stationnement n° 12",
     "Emplacement de stationnement", "Un box situé dans un ensemble immobilier"],
)
def test_a_box_or_a_parking_space_is_typed_parking(label: str) -> None:
    assert normalize_property_type(label) == "parking"


@pytest.mark.parametrize(
    ("label", "expected"),
    [("Appartement avec box", "apartment"), ("Maison et garage", "house"), ("Terrain - box", "land"),
     ("Local commercial et box", "commercial")],
)
def test_a_dwelling_or_a_plot_with_a_box_keeps_its_type(label: str, expected: str) -> None:
    assert normalize_property_type(label) == expected
    assert not is_parking_label(label)


def test_a_box_classified_as_land_by_the_source_is_typed_parking_from_its_title() -> None:
    sale = normalize_sale(_raw(property_type="Terrain", title="Un box dans une résidence", surface_m2="12"))

    assert sale.property_type == "parking"


def test_a_plot_whose_title_does_not_name_a_box_stays_land() -> None:
    sale = normalize_sale(_raw(property_type="Terrain", title="Terrain à bâtir", surface_m2="800"))

    assert sale.property_type == "land"


# --- « Appartement » de moins de 9 m² -------------------------------------------------------------------------


def test_an_apartment_under_nine_square_meters_becomes_an_annex_with_a_matching_title() -> None:
    sale = normalize_sale(_raw(property_type="apartment", surface_m2="5.2", title="Appartement 5 m²"))
    normalize_asset_features(sale)

    assert sale.property_type == "other"
    assert sale.title == "Annexe"
    assert sale.surface_scope == "room_or_annex"
    assert sale.app_surface_m2 is None
    assert "annex_lot" in sale.quality_flags and "ambiguous_surface" in sale.quality_flags
    assert sale.raw_payload["annex_reclassification"]["from_property_type"] == "apartment"


def test_the_reclassification_is_stable_when_normalised_again() -> None:
    sale = normalize_sale(_raw(property_type="apartment", surface_m2="5.2"))
    normalize_asset_features(sale)
    normalize_asset_features(sale)

    assert (sale.property_type, sale.title) == ("other", "Annexe")


def test_a_studio_of_twenty_square_meters_stays_an_apartment() -> None:
    sale = normalize_sale(_raw(property_type="apartment", surface_m2="20.46"))
    normalize_asset_features(sale)

    assert sale.property_type == "apartment"
    assert sale.title.startswith("Appartement")
