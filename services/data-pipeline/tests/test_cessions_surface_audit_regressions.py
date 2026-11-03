"""Cessions de l'État / AGRASC, surfaces et pièces : audit du 03/11/2026 (extraits réels)."""

from decimal import Decimal

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import (
    apply_surface_reasoning_to_sale,
    extract_surface_facts_from_text,
)
from src.land_parcels import parcel_m2_list
from src.models import AuctionSale
from src.room_counts import extract_bedrooms_count_from_text


def _sale(property_type: str, text: str, **fields: object) -> AuctionSale:
    return AuctionSale(
        source_name="cessions_etat",
        source_url="https://example.test/cession",
        property_type=property_type,
        description=text,
        **fields,
    )


def test_0e0a261d_dot_is_a_thousands_separator() -> None:
    text = "Ensemble de bâtiments d'activité sur une surface totale de 7.552 m² en zone d'activités"
    sale = _sale("commercial", text)
    asset = extract_surface_facts_from_text(text)
    assert asset is not None
    apply_surface_reasoning_to_sale(sale, [asset], context=text, source="deterministic_surface_reasoning")

    assert sale.surface_m2 == Decimal("7552.00")


def test_5003b2a5_per_house_surface_is_not_the_sale_surface() -> None:
    text = (
        "Implantées sur un terrain arboré de 1 521 m², les trois maisons disposent d’une surface habitable "
        "d’environ 95 m² et de 10 pièces dont 9 chambres."
    )
    sale = _sale("house", text)
    asset = extract_surface_facts_from_text(text)
    assert asset is not None
    apply_surface_reasoning_to_sale(sale, [asset], context=text, source="deterministic_surface_reasoning")

    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None

    counted = normalize_asset_features(_sale("house", text, rooms_count=10, bedrooms_count=9))
    assert counted.rooms_count is None
    assert counted.bedrooms_count is None


def test_listed_parcels_in_square_metres() -> None:
    assert parcel_m2_list(
        "Parcelles en nature de sols, en bordure de la Route nationale 44 : Parcelle YE n°53 de 15 840 m² "
        "Parcelle Yi n°75 de 10 065 m²"
    ) == [Decimal("15840"), Decimal("10065")]
    assert parcel_m2_list(
        "Il s agit de deux parcelles en nature de terres agricoles Superficie : 912 et 871 m2"
    ) == [Decimal("912"), Decimal("871")]
    assert parcel_m2_list(
        "l'Etat cède deux parcelles d'une superficie respective de 170 m² et 605 m² situées Lieudit Pompa"
    ) == [Decimal("170"), Decimal("605")]
    assert parcel_m2_list("Maison de 120 m² et garage de 20 m²") == []


def test_27804e28_land_is_the_sum_of_the_listed_parcels_not_the_first() -> None:
    text = (
        "Terrain 15 840 m² Parcelles en nature de sols, en bordure de la Route nationale 44 : Parcelle YE n°53 de "
        "15 840 m² Parcelle Yi n°75 de 10 065 m²"
    )
    sale = normalize_asset_features(_sale("land", text, land_surface_m2=Decimal("15840")))

    assert sale.land_surface_m2 == Decimal("25905")


def test_a7ebfee0_bedrooms_of_both_floors() -> None:
    text = (
        "Au rez-de-chaussée : une entrée, une cuisine, un salon, une salle d’eau,un WC et une chambre. - À l’étage : "
        "une salle d’eau, deux chambres et un WC."
    )
    assert extract_bedrooms_count_from_text(text) == 3
