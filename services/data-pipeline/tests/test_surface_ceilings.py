"""Plafond de vraisemblance de la surface affichée et surface non établie des immeubles / multi-lots."""

from decimal import Decimal

import pytest

from src.asset_normalization import normalize_asset_features
from src.normalize import normalize_sale


def _sale(property_type: str, surface: str | None, **extra: object):
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": f"https://www.vench.fr/vente-1-{property_type}-{surface}.html",
            "city": "Bordeaux",
            "postal_code": "33000",
            "property_type": property_type,
            "surface_m2": surface,
            "starting_price_eur": "50 000 €",
            "title": f"Vente aux enchères : {property_type}",
            "sale_date": "mardi 10 novembre 2026 à 14h",
            **extra,
        }
    )
    return normalize_asset_features(sale)


@pytest.mark.parametrize("surface", ["34596", "13585", "4206", "501"])
def test_an_apartment_above_500_m2_is_not_displayed_as_its_surface(surface: str) -> None:
    sale = _sale("apartment", surface, title=f"UN APPARTEMENT - {surface}m²")

    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert sale.surface_scope == "unknown"
    assert sale.surface_m2 is None
    assert sale.land_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags
    assert sale.raw_payload["implausible_surface_reconciliation"]["rejected_surface_m2"] == str(Decimal(surface))
    assert sale.raw_payload["implausible_surface_reconciliation"]["status"] == "removed"


def test_an_apartment_at_the_ceiling_keeps_its_surface() -> None:
    sale = _sale("apartment", "500")

    assert sale.app_surface_m2 == Decimal("500")
    assert "implausible_surface_reconciliation" not in sale.raw_payload


def test_a_normal_apartment_is_untouched() -> None:
    sale = _sale("apartment", "62.5")

    assert sale.app_surface_m2 == Decimal("62.5")
    assert "ambiguous_surface" not in sale.quality_flags


def test_a_house_surface_that_the_source_calls_a_plot_becomes_the_land_surface() -> None:
    sale = _sale("house", "48256", description="Maison d'habitation, superficie du sol de 48 256 m².")

    assert sale.app_surface_m2 is None
    assert sale.surface_m2 is None
    assert sale.land_surface_m2 == Decimal("48256")
    assert sale.raw_payload["implausible_surface_reconciliation"]["status"] == "demoted_to_land"
    assert sale.raw_payload["implausible_surface_reconciliation"]["ceiling_m2"] == "1000"


@pytest.mark.parametrize(
    "description",
    [
        "Parcelle cadastrée section AB n°12 d'une contenance de 48256 m².",
        "Une maison avec une superficie du sol de 48 256 m².",
        "48 256 m² de terrain avec maison.",
    ],
)
def test_a_house_surface_qualified_as_land_by_the_source_wording_ends_up_as_land(description: str) -> None:
    sale = _sale("house", "48256", description=description)

    assert sale.app_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("48256")


def test_a_house_surface_not_qualified_by_the_source_is_dropped_not_copied_to_land() -> None:
    sale = _sale("house", "48256")

    assert sale.app_surface_m2 is None
    assert sale.surface_m2 is None
    assert sale.land_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags
    reconciliation = sale.raw_payload["implausible_surface_reconciliation"]
    assert reconciliation["status"] == "removed"
    assert reconciliation["rejected_surface_m2"] == "48256"


def test_a_land_word_next_to_another_number_does_not_qualify_the_rejected_surface() -> None:
    sale = _sale("house", "48256", description="Maison sur un terrain de 800 m². Titre : 48 256 m² au total.")

    assert sale.land_surface_m2 == Decimal("800")
    assert sale.raw_payload["implausible_surface_reconciliation"]["status"] == "removed"


def test_a_built_surface_wording_does_not_qualify_the_rejected_surface_as_land() -> None:
    sale = _sale("house", "48256", description="Maison, terrain non communiqué, surface habitable 48 256 m².")

    assert sale.land_surface_m2 is None
    assert sale.raw_payload["implausible_surface_reconciliation"]["status"] == "removed"


def test_a_house_keeps_a_known_land_surface_and_drops_the_implausible_built_one() -> None:
    sale = _sale("house", "48256", land_surface_m2="3000")

    assert sale.app_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("3000")
    assert sale.raw_payload["implausible_surface_reconciliation"]["status"] == "removed"


def test_the_plausibility_correction_is_stable_when_the_sale_is_recomputed() -> None:
    sale = _sale("house", "48256", description="Maison sur un terrain de 48 256 m².")
    normalize_asset_features(sale)

    assert sale.app_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("48256")


def test_a_large_but_plausible_house_is_kept() -> None:
    sale = _sale("house", "420")

    assert sale.app_surface_m2 == Decimal("420")


def test_an_explicitly_labelled_habitable_house_surface_keeps_the_house_ceiling() -> None:
    # Le plafond « habitable » de 5 000 m² est ramené à 1 000 m² (comme toute maison) : une surface
    # habitable de plus de 1 000 m² sans preuve d'un total bâti est presque toujours une parcelle.
    sale = _sale("house", None, description="Maison. Surface habitable : 2 464,70 m².")

    assert sale.app_surface_m2 is None
    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags
    reconciliation = sale.raw_payload["implausible_surface_reconciliation"]
    assert reconciliation["status"] == "removed"
    assert reconciliation["ceiling_m2"] == "1000"
    assert reconciliation["rejected_surface_m2"] == "2464.70"


def test_a_house_at_the_ceiling_keeps_its_labelled_habitable_surface() -> None:
    sale = _sale("house", None, description="Maison. Surface habitable : 1 000 m².")

    assert sale.app_surface_m2 == Decimal("1000")
    assert "implausible_surface_reconciliation" not in sale.raw_payload


def test_a_proven_built_total_raises_the_ceiling_of_the_labelled_house_surface() -> None:
    sale = _sale("house", None, description="Maison. Surface habitable : 2 464,70 m² (surface totale bâtie).")

    assert sale.app_surface_m2 == Decimal("2464.70")
    assert "implausible_surface_reconciliation" not in sale.raw_payload

    huge = _sale("house", None, description="Maison. Surface habitable : 48 256 m² (surface totale bâtie).")
    assert huge.app_surface_m2 is None


def test_a_total_that_closes_a_parcel_list_is_not_a_proven_built_total() -> None:
    sale = _sale(
        "house",
        None,
        description=(
            "Maison. Surface habitable : 1 550 m². Parcelles cadastrées section AB n°12 pour 5a 20ca "
            "et n°13 pour 10a 30ca, soit superficie totale 1 550 m²."
        ),
    )

    assert sale.app_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("1550")


def test_the_nine_square_meter_rule_is_unchanged() -> None:
    sale = _sale("apartment", "8")

    assert sale.app_surface_m2 is None
    assert sale.surface_scope != "unknown"


BUILDING_TEXT = (
    "Immeuble de 6 appartements. Lot n°1 : appartement de 29,51 m². Lot n°2 : appartement de 41 m²."
)


def test_a_building_of_several_apartments_does_not_show_the_first_lot_surface() -> None:
    sale = _sale("building", "29.51", description=BUILDING_TEXT)

    assert sale.app_surface_m2 is None
    assert sale.surface_scope == "unknown"
    assert "ambiguous_surface" in sale.quality_flags


def test_a_building_with_an_explicit_total_surface_keeps_it() -> None:
    sale = _sale(
        "building",
        "320",
        description="Immeuble de 6 appartements, surface totale de 320 m². Lot n°1 : 29,51 m².",
    )

    assert sale.app_surface_m2 == Decimal("320")


def test_a_building_without_any_multi_unit_signal_keeps_its_surface() -> None:
    sale = _sale("building", "180", description="Un bâtiment à usage de remise de 180 m² au sol.")

    assert sale.app_surface_m2 == Decimal("180")


def test_a_multi_lot_sale_does_not_show_one_lot_surface_as_the_surface_of_the_property() -> None:
    sale = _sale(
        "apartment",
        "51.82",
        title="Appartement / local commercial (vente en 2 lots)",
        description=(
            "PREMIER LOT DE VENTE : surface loi Carrez de 51,82 m². "
            "SECOND LOT DE VENTE : superficie loi Carrez de 42,90 m²."
        ),
    )

    assert "multi_lot_sale" in sale.quality_flags
    assert sale.app_surface_m2 is None
    assert sale.surface_scope == "unknown"
    # La mesure typée du premier lot reste conservée pour l'audit.
    assert sale.carrez_surface_m2 == Decimal("51.82")
