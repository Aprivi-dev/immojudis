"""Lot 2b, n° 11 : pas de surface publiée quand elle est ambiguë, bâtiment principal préféré, surface créée écartée."""

from decimal import Decimal

import pytest

from src.app_surface_withholding import AMBIGUOUS_SURFACE_MARKERS, withhold_ambiguous_app_surface
from src.asset_normalization import normalize_asset_features
from src.asset_normalization_helpers import PRICE_PER_M2_IMPLAUSIBLE_FLAG
from src.enrichment.surface_reasoning import (
    MULTIPLE_BUILDINGS_CONTRADICTION,
    ExtractedAsset,
    SurfaceCandidate,
    SurfaceEvidence,
    apply_surface_reasoning_to_sale,
    extract_surface_facts_from_text,
    reason_about_surfaces,
)
from src.models import AuctionSale


def _house(text: str, **fields: object) -> AuctionSale:
    fields.setdefault("property_type", "house")
    return AuctionSale(source_name="test", source_url="https://example.test/vente", raw_text=text, **fields)


def _reason(text: str, property_type: str = "house"):
    asset = extract_surface_facts_from_text(text)
    assert asset is not None
    return reason_about_surfaces([asset], context=text, property_type=property_type)


def test_marker_list_matches_the_flag_written_by_the_normalization() -> None:
    assert PRICE_PER_M2_IMPLAUSIBLE_FLAG in AMBIGUOUS_SURFACE_MARKERS


# --- Lussac : dépendance de 71,95 m² contre maison de 220 m² -----------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Maison d'habitation de 220 m² avec une dépendance de 71,95 m².",
        "Dépendance : surface habitable 71,95 m². Maison d'habitation : surface habitable 220 m².",
    ],
)
def test_lussac_outbuilding_never_replaces_the_dwelling_surface(text: str) -> None:
    result = _reason(text)

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("220.00")
    assert all(item.value_m2 != Decimal("71.95") for item in result.candidates)


def test_lussac_outbuilding_alone_gives_no_surface() -> None:
    text = "Dépendance : surface habitable 71,95 m²."
    sale = _house(text)
    asset = extract_surface_facts_from_text(text)
    assert asset is not None

    result = apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")

    assert result.rejected_candidates[0]["reason"] == "secondary_building_surface"
    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None


# --- Cannes : maison de gardien de 23,6 m² contre villa de 345,7 m² ----------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Villa de 345,7 m² et maison de gardien de 23,6 m².",
        "Une maison de gardien d'une surface de 23,6 m² ainsi qu'une villa de 345,7 m².",
    ],
)
def test_cannes_caretaker_house_never_replaces_the_villa_surface(text: str) -> None:
    sale = _house(text)
    asset = extract_surface_facts_from_text(text)
    assert asset is not None
    apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("345.70")
    assert sale.app_surface_m2 == Decimal("345.70")


def test_hors_garage_is_not_mistaken_for_an_outbuilding() -> None:
    result = _reason("Surface habitable hors garage 98,06 m².")

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("98.06")
    assert result.rejected_candidates == []


# --- Mougins : surface créée par un permis ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Permis de construire pour une maison individuelle, surface créée de 185 m².",
        "Villa avec création d'une surface de 185 m² par permis de construire.",
        "Maison de 185 m² de surface de plancher créée par permis de construire.",
    ],
)
def test_mougins_surface_created_by_a_permit_is_never_retained(text: str) -> None:
    sale = _house(text)
    asset = extract_surface_facts_from_text(text)
    assert asset is not None and asset.explicit_surfaces

    result = apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")

    assert result.selected is None
    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None
    assert any(item["reason"] == "created_surface_of_a_permit" for item in result.rejected_candidates)


def test_surface_created_by_a_permit_is_also_refused_from_a_structured_candidate() -> None:
    quote = "Maison individuelle : création de 185 m² de surface de plancher."
    asset = ExtractedAsset(
        explicit_surfaces=[
            SurfaceCandidate(
                value_m2=Decimal("185"),
                kind="explicit_total",
                confidence=0.96,
                evidence=SurfaceEvidence(quote=quote),
            )
        ]
    )

    result = reason_about_surfaces([asset], context=quote, property_type="house")

    assert result.selected is None
    assert result.rejected_candidates[0]["reason"] == "created_surface_of_a_permit"


def test_existing_surface_next_to_a_permit_sentence_is_kept() -> None:
    result = _reason("Maison d'une surface de 140 m² édifiée suivant permis de construire de 1998.")

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("140.00")


# --- Plusieurs bâtiments : le principal l'emporte, sinon rien n'est publié -----------------------------------------


def test_main_building_is_preferred_among_several_buildings() -> None:
    text = "Le bâtiment principal de 180 m² et un second bâtiment de 95 m²."
    result = _reason(text)

    assert result.selected is not None
    assert result.selected.value_m2 == Decimal("180.00")
    assert result.contradictions == []


def test_several_buildings_without_main_one_publish_no_surface() -> None:
    text = "Une maison de 120 m² et un bâtiment de 80 m² sur la parcelle."
    sale = _house(text)
    asset = extract_surface_facts_from_text(text)
    assert asset is not None

    result = apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")
    normalize_asset_features(sale)

    assert any(item["kind"] == MULTIPLE_BUILDINGS_CONTRADICTION for item in result.contradictions)
    assert result.selected is not None and result.selected.validation_status == "contradicted"
    assert sale.surface_m2 is None
    assert "surface_contradiction" in sale.quality_flags
    assert sale.app_surface_m2 is None


# --- Retrait de app_surface_m2 -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "marker",
    ["ambiguous_surface", "surface_contradiction", "surface_unit_or_consistency_warning", "price_per_m2_implausible"],
)
def test_app_surface_is_withheld_when_an_ambiguity_marker_is_present(marker: str) -> None:
    sale = _house(
        "x",
        surface_m2=Decimal("23.6"),
        habitable_surface_m2=Decimal("345.7"),
        app_surface_m2=Decimal("23.6"),
        app_surface_kind="built",
        quality_flags=[marker],
    )

    withhold_ambiguous_app_surface(sale)

    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert sale.surface_m2 == Decimal("23.6")
    assert sale.raw_payload["app_surface_withheld"] == {
        "withheld_surface_m2": "23.6",
        "app_surface_kind": "built",
        "markers": [marker],
    }


def test_app_surface_is_kept_without_marker() -> None:
    sale = _house("x", app_surface_m2=Decimal("120"), app_surface_kind="habitable", quality_flags=["missing_gps"])

    withhold_ambiguous_app_surface(sale)

    assert sale.app_surface_m2 == Decimal("120")
    assert "app_surface_withheld" not in sale.raw_payload


def test_ambiguous_surface_from_a_rounding_gap_does_not_hide_a_confirmed_surface() -> None:
    sale = _house(
        "x",
        property_type="apartment",
        carrez_surface_m2=Decimal("117.58"),
        habitable_surface_m2=Decimal("117"),
        app_surface_m2=Decimal("117.58"),
        quality_flags=["ambiguous_surface"],
    )

    withhold_ambiguous_app_surface(sale)

    assert sale.app_surface_m2 == Decimal("117.58")


def test_ambiguous_surface_with_diverging_carrez_and_habitable_hides_the_surface() -> None:
    sale = _house(
        "x",
        property_type="apartment",
        carrez_surface_m2=Decimal("45"),
        habitable_surface_m2=Decimal("90"),
        app_surface_m2=Decimal("45"),
        quality_flags=["ambiguous_surface"],
    )

    withhold_ambiguous_app_surface(sale)

    assert sale.app_surface_m2 is None


def test_unit_typo_reconciled_by_the_room_sum_keeps_the_surface() -> None:
    text = (
        "Le bien comprend une entrée 8,92 m², séjour 13,08 m², WC 0,48 m², "
        "salon 27,19 m², chambre 11,45 m², salle d'eau 3,68 m². "
        "Surface habitable de 64.80 m³ (Loi Carrez)."
    )
    sale = AuctionSale(
        source_name="test",
        source_url="https://example.test/beauregard",
        property_type="apartment",
        raw_text=text,
    )
    asset = extract_surface_facts_from_text(text)
    assert asset is not None
    apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")
    normalize_asset_features(sale)

    assert "surface_unit_or_consistency_warning" in sale.quality_flags
    assert sale.app_surface_m2 == Decimal("64.80")


def test_implausible_price_per_m2_withholds_the_published_surface() -> None:
    sale = _house(
        "Maison de 23,6 m².",
        surface_m2=Decimal("23.6"),
        habitable_surface_m2=Decimal("23.6"),
        starting_price_eur=Decimal("3500000"),
    )

    normalize_asset_features(sale)

    assert PRICE_PER_M2_IMPLAUSIBLE_FLAG in sale.quality_flags
    assert sale.app_surface_m2 is None
    assert sale.raw_payload["app_surface_withheld"]["markers"] == [PRICE_PER_M2_IMPLAUSIBLE_FLAG]


def test_a_new_surface_selection_replaces_stale_reasoning_markers() -> None:
    text = "Surface habitable : 98,06 m²."
    sale = _house(text, quality_flags=["surface_contradiction", "surface_unit_or_consistency_warning"])
    asset = extract_surface_facts_from_text(text)
    assert asset is not None

    apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")

    assert "surface_contradiction" not in sale.quality_flags
    assert "surface_unit_or_consistency_warning" not in sale.quality_flags
