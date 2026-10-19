"""Surfaces implausibles : égale au terrain, deux valeurs pour le même bien, immeuble typé « appartement »."""

from decimal import Decimal

import pytest

from src.asset_normalization import normalize_asset_features
from src.multi_unit_type import is_multi_unit_building_text
from src.normalize import normalize_property_type, normalize_sale
from src.surface_plausibility import (
    conflicting_generic_surfaces,
    is_parcel_total,
    parcel_total_surfaces,
    source_proves_built_total,
)


def _sale(**raw: object):
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": f"https://avoventes.fr/enchere/{abs(hash(str(raw)))}",
            "city": "Bordeaux",
            "postal_code": "33000",
            "department": "33",
            "starting_price_eur": "50 000 €",
            **raw,
        }
    )
    return normalize_asset_features(sale)


# --- surface bâtie égale au terrain ------------------------------------------------------------------------


@pytest.mark.parametrize("field", ["surface_m2", "habitable_surface_m2"])
def test_a_built_surface_equal_to_the_land_is_rejected_and_the_text_value_is_recovered(field: str) -> None:
    """Maison éclusière « d'environ 80 m² » : 1 283 m² est la parcelle, recopiée dans la surface."""
    sale = _sale(
        title="Maison éclusière à Bordeaux",
        property_type="house",
        land_surface_m2="1283",
        description="Maison éclusière d'environ 80 m² sur un terrain de 1 283 m².",
        **{field: "1283"},
    )

    assert sale.land_surface_m2 == Decimal("1283")
    assert sale.habitable_surface_m2 is None
    assert sale.surface_m2 == Decimal("80")
    assert sale.app_surface_m2 == Decimal("80")
    assert sale.raw_payload["built_surface_equal_to_land_reconciliation"]["rejected_surface_m2"] == "1283"
    assert "surface_conflict_resolved" in sale.quality_flags


def test_a_built_surface_equal_to_the_land_without_another_value_is_to_confirm() -> None:
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        habitable_surface_m2="600",
        land_surface_m2="600",
        description="Maison d'habitation avec jardin. Terrain de 600 m².",
    )

    assert sale.land_surface_m2 == Decimal("600")
    assert sale.habitable_surface_m2 is None
    assert sale.surface_m2 is None
    assert sale.app_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags
    assert sale.surface_scope != "total"


def test_the_rejection_is_stable_when_the_sale_is_recomputed() -> None:
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        habitable_surface_m2="600",
        land_surface_m2="600",
        description="Maison. Surface habitable : 600 m². Terrain de 600 m².",
    )
    normalize_asset_features(sale)

    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("600")


def test_different_built_and_land_surfaces_are_untouched() -> None:
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        habitable_surface_m2="120",
        surface_m2="120",
        land_surface_m2="800",
        description="Maison. Surface habitable : 120 m². Terrain de 800 m².",
    )

    assert sale.habitable_surface_m2 == Decimal("120")
    assert sale.surface_m2 == Decimal("120")
    assert sale.app_surface_m2 == Decimal("120")
    assert "built_surface_equal_to_land_reconciliation" not in sale.raw_payload


def test_a_generic_surface_read_from_the_land_wording_is_replaced_by_the_habitable_one() -> None:
    """La lecture du texte donnait « Terrain de 800 m² » comme surface générique : elle est écartée."""
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        habitable_surface_m2="120",
        land_surface_m2="800",
        description="Maison. Surface habitable : 120 m². Terrain de 800 m².",
    )

    assert sale.surface_m2 == Decimal("120")
    assert sale.land_surface_m2 == Decimal("800")
    assert sale.raw_payload["built_surface_equal_to_land_reconciliation"]["fields"] == ["surface_m2"]


# --- deux valeurs pour le même bien -------------------------------------------------------------------------


def test_two_different_unqualified_values_leave_the_surface_to_confirm() -> None:
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        surface_m2="20.70",
        description="Superficie : 90,70 m². Maison de ville. Une superficie de 20,70 m².",
    )

    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert "ambiguous_surface" in sale.quality_flags
    assert sale.raw_payload["surface_values_conflict"]["values_m2"] == ["20.70", "90.70"]


def test_the_conflict_marker_disappears_when_the_text_no_longer_conflicts() -> None:
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        description="Superficie : 90,70 m². Maison de ville. Une superficie de 20,70 m².",
    )
    assert "surface_values_conflict" in sale.raw_payload

    sale.description = "Superficie : 90,70 m². Maison de ville."
    normalize_asset_features(sale)

    assert "surface_values_conflict" not in sale.raw_payload


@pytest.mark.parametrize(
    "text",
    [
        # La même valeur répétée n'est pas un conflit.
        "Superficie : 90,70 m². Maison de ville. Une superficie de 90,70 m².",
        # Mesures typées, totale ou rattachées à autre chose que le bien.
        "Surface habitable : 63,83 m². Surface hors Carrez : 4,16 m².",
        "Surface habitable : 90 m². Superficie de 20 m².",
        "pour une surface totale de 110,80 m², une grange attenante d'une surface d'environ 70 m².",
        "Détail des travaux : mur est, surface : 77 m². Plafond, surface : 60 m².",
        "Lot 1 : superficie 40 m². Lot 2 : superficie 60 m².",
        "Maison. Superficie du terrain : 800 m². Superficie : 90 m².",
        "Maison, séjour d'une surface de 24 m², cuisine d'une surface de 14 m².",
        "Maison de 3 chambres, superficie de 90 m², jardin de 400 m².",
    ],
)
def test_other_surface_mentions_are_not_a_conflict(text: str) -> None:
    assert conflicting_generic_surfaces(text) == []


def test_the_raw_page_text_is_not_compared() -> None:
    """Le texte brut d'une page mêle les ventes voisines : seuls le titre et la description comptent."""
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        description="Maison. Surface habitable : 90 m².",
        raw_text="Maison. Surface habitable : 90 m². Autres biens. Superficie : 35 m². Superficie : 50 m².",
    )

    assert "surface_values_conflict" not in sale.raw_payload
    assert sale.app_surface_m2 == Decimal("90")


# --- immeuble ou maison de plusieurs appartements --------------------------------------------------------------


@pytest.mark.parametrize(
    "title,description",
    [
        ("Immeuble de 4 appartements à Bordeaux", "Immeuble de rapport."),
        ("Maison de 3 appartements à Bordeaux", "Maison de trois appartements loués."),
        ("Vente d'un immeuble comprenant 6 logements", ""),
        ("Bien à Bordeaux", "Immeuble composé de deux appartements et d'un local."),
        ("Bien à Bordeaux", "Maison divisée en 3 appartements."),
    ],
)
def test_a_building_of_several_flats_is_not_typed_as_an_apartment(title: str, description: str) -> None:
    for explicit in (None, "appartement", "Appartement"):
        extra = {"property_type": explicit} if explicit else {}
        sale = normalize_sale(
            {"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/x", "title": title,
             "description": description, **extra}
        )

        assert sale.property_type == "building", (title, explicit)


@pytest.mark.parametrize(
    "title,expected",
    [
        ("Appartement T3 dans un immeuble comprenant 12 appartements", "apartment"),
        ("Appartement de 3 pièces", "apartment"),
        ("Studio dans un immeuble de 8 logements", "apartment"),
        ("Une maison à Bordeaux", "house"),
        ("Immeuble à Bordeaux", "building"),
    ],
)
def test_a_flat_inside_a_building_stays_an_apartment(title: str, expected: str) -> None:
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/y", "title": title})

    assert sale.property_type == expected


def test_the_building_text_rule() -> None:
    assert is_multi_unit_building_text("immeuble de 4 appartements a bordeaux")
    assert is_multi_unit_building_text("l'immeuble compose de deux logements")
    assert not is_multi_unit_building_text("appartement dans un immeuble de 4 appartements")
    assert not is_multi_unit_building_text("immeuble de 1 appartement")
    assert not is_multi_unit_building_text(None)
    assert normalize_property_type("Immeuble de 4 appartements") == "building"
    assert normalize_property_type("Appartement") == "apartment"


def test_a_building_of_flats_has_no_published_surface_of_one_flat() -> None:
    sale = _sale(
        title="Immeuble de 4 appartements à Bordeaux",
        description="Immeuble de 4 appartements. Lot 1 : appartement de 29,51 m².",
    )

    assert sale.property_type == "building"
    assert sale.app_surface_m2 is None


# --- cas réels ---------------------------------------------------------------------------------------------------


PARCELS = (
    "Parcelles cadastrées section AB n°12 pour 5a 20ca et section AB n°13 pour 10a 30ca, "
    "soit superficie totale 1550 m²."
)


def test_a_total_after_cadastral_parcels_is_the_land_surface() -> None:
    sale = _sale(title="Maison à Bordeaux", property_type="house", description=f"Maison d'habitation. {PARCELS}")

    assert sale.land_surface_m2 == Decimal("1550")
    assert sale.surface_m2 is None
    assert sale.app_surface_m2 is None
    assert "parcel_surface_scope_unverified" not in sale.quality_flags


def test_a_total_after_cadastral_parcels_is_not_the_built_surface_of_a_house() -> None:
    sale = _sale(
        title="Maison à Bordeaux",
        property_type="house",
        surface_m2="1550",
        description=f"Maison d'habitation. {PARCELS}",
    )

    assert sale.land_surface_m2 == Decimal("1550")
    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_m2 is None


def test_a_total_after_cadastral_parcels_of_a_land_sale_is_the_whole_plot() -> None:
    sale = _sale(title="Terrain à Bordeaux", description=PARCELS)

    assert sale.property_type == "land"
    assert sale.land_surface_m2 == Decimal("1550")
    assert sale.app_surface_m2 == Decimal("1550")
    assert sale.app_surface_kind == "land"


def test_an_apartment_of_13_585_square_meters_is_not_published() -> None:
    sale = _sale(
        title="UN APPARTEMENT - 13 585 m²",
        property_type="apartment",
        surface_m2="13585",
        description="Un appartement.",
    )

    assert sale.app_surface_m2 is None
    assert sale.surface_m2 is None
    assert sale.raw_payload["implausible_surface_reconciliation"]["rejected_surface_m2"] == "13585"
    assert "ambiguous_surface" in sale.quality_flags


# --- fonctions du module -------------------------------------------------------------------------------------


def test_parcel_totals_need_a_cadastral_context() -> None:
    assert parcel_total_surfaces(PARCELS) == [Decimal("1550")]
    assert parcel_total_surfaces("Appartement, soit superficie totale 62 m².") == []
    assert is_parcel_total([None, PARCELS], Decimal("1550"))
    assert not is_parcel_total([PARCELS], Decimal("520"))
    assert not is_parcel_total([PARCELS], None)


def test_built_total_proof_needs_a_built_qualifier_and_no_land_word() -> None:
    proof = "Maison. Surface habitable : 2 464,70 m² (surface totale bâtie)."
    assert source_proves_built_total([proof], Decimal("2464.70"))
    assert source_proves_built_total(["Surface de plancher totale : 1 200 m²."], Decimal("1200"))
    assert not source_proves_built_total(["Maison. Surface habitable : 2 464,70 m²."], Decimal("2464.70"))
    assert not source_proves_built_total([PARCELS], Decimal("1550"))
    assert not source_proves_built_total([proof], Decimal("999"))
    assert not source_proves_built_total([proof], None)
