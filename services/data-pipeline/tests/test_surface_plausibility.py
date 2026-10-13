"""Surfaces invraisemblables : « hors Carrez », Carrez minuscule, moins de 9 m² pour un logement."""

from decimal import Decimal

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import (
    ExtractedAsset,
    SurfaceCandidate,
    SurfaceEvidence,
    apply_surface_reasoning_to_sale,
    extract_and_apply_deterministic_surface_reasoning,
    extract_surface_facts_from_text,
    reason_about_surfaces,
)
from src.models import AuctionSale
from src.normalize import (
    _extract_carrez_surface_from_text,
    carrez_is_implausible_against_habitable,
    is_outside_carrez_context,
    normalize_sale,
)

HORS_CARREZ_TEXT = (
    "Un appartement de type T3, surface habitable : 63,83 m2. "
    "Surface hors Carrez : 4,16 m2 (cave au sous-sol)."
)


def _raw(**overrides: object) -> dict[str, object]:
    return {
        "source_name": "avoventes",
        "source_url": "https://example.test/vente/hors-carrez",
        "property_type": "apartment",
        "city": "Bordeaux",
        "department": "33",
        **overrides,
    }


def test_hors_carrez_value_is_not_a_carrez_candidate() -> None:
    asset = extract_surface_facts_from_text(HORS_CARREZ_TEXT)

    assert asset is not None
    kinds = {(item.kind, item.value_m2) for item in asset.explicit_surfaces}
    assert ("explicit_habitable", Decimal("63.83")) in kinds
    assert all(value != Decimal("4.16") for _, value in kinds)
    assert all(item.value_m2 != Decimal("4.16") for item in asset.spaces)


def test_hors_carrez_value_is_not_read_as_carrez_by_the_normalizer() -> None:
    assert _extract_carrez_surface_from_text("Hors Carrez : 4,16 m2") is None
    assert _extract_carrez_surface_from_text("Hors loi Carrez 4,16 m2") is None
    # La Carrez annoncée à côté reste lue.
    assert _extract_carrez_surface_from_text("Loi Carrez : 58,10 m2. Hors Carrez : 4,16 m2.") == Decimal("58.10")
    assert _extract_carrez_surface_from_text("Hors Carrez : 4,16 m2. Loi Carrez : 58,10 m2.") == Decimal("58.10")
    assert is_outside_carrez_context("hors Carrez : 4,16 m2", 14, 21)


def test_apartment_with_hors_carrez_text_keeps_the_habitable_surface() -> None:
    sale = normalize_sale(_raw(description=HORS_CARREZ_TEXT, raw_text=HORS_CARREZ_TEXT))
    extract_and_apply_deterministic_surface_reasoning(sale, HORS_CARREZ_TEXT)
    normalize_asset_features(sale)

    assert sale.carrez_surface_m2 is None
    assert sale.habitable_surface_m2 == Decimal("63.83")
    assert sale.app_surface_m2 == Decimal("63.83")
    assert sale.app_surface_kind == "habitable"


def test_carrez_under_a_fifth_of_the_habitable_surface_is_dropped_but_traced() -> None:
    sale = normalize_sale(
        _raw(carrez_surface_m2="4.16", habitable_surface_m2="63.83", surface_m2="4.16")
    )

    assert sale.carrez_surface_m2 is None
    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 == Decimal("63.83")
    assert sale.app_surface_m2 == Decimal("63.83")
    assert sale.app_surface_kind == "habitable"
    assert sale.raw_payload["carrez_surface_reconciliation"]["rejected_carrez_surface_m2"] == "4.16"
    assert "surface_conflict_resolved" in sale.quality_flags

    normalize_asset_features(sale)
    assert sale.app_surface_m2 == Decimal("63.83")
    assert sale.carrez_surface_m2 is None


def test_plausible_carrez_is_kept_over_the_habitable_surface() -> None:
    sale = normalize_sale(_raw(carrez_surface_m2="58.10", habitable_surface_m2="63.83"))
    normalize_asset_features(sale)

    assert sale.carrez_surface_m2 == Decimal("58.10")
    assert sale.app_surface_m2 == Decimal("58.10")
    assert sale.app_surface_kind == "carrez"
    assert carrez_is_implausible_against_habitable(Decimal("12.76"), Decimal("63.83"))
    assert not carrez_is_implausible_against_habitable(Decimal("12.77"), Decimal("63.83"))
    assert not carrez_is_implausible_against_habitable(None, Decimal("63.83"))


def test_reasoning_prefers_the_habitable_candidate_over_a_tiny_carrez() -> None:
    def candidate(kind: str, value: str, quote: str) -> SurfaceCandidate:
        return SurfaceCandidate(
            value_m2=Decimal(value),
            kind=kind,  # type: ignore[arg-type]
            scope="asset",
            confidence=0.96,
            evidence=SurfaceEvidence(quote=quote),
        )

    context = "Surface Carrez 10.20 m2. Surface habitable 63.83 m2."
    asset = ExtractedAsset(
        explicit_surfaces=[
            candidate("explicit_carrez", "10.20", "Surface Carrez 10.20 m2"),
            candidate("explicit_habitable", "63.83", "Surface habitable 63.83 m2"),
        ]
    )
    result = reason_about_surfaces([asset], context=context, property_type="apartment")

    assert result.selected is not None
    assert result.selected.kind == "explicit_habitable"
    assert result.selected.value_m2 == Decimal("63.83")
    assert any(item["kind"] == "carrez_below_20_percent_of_habitable" for item in result.contradictions)


def test_reasoning_ignores_a_parking_sized_surface_for_a_dwelling() -> None:
    text = "Une maison. Surface habitable : 6,50 m2."
    sale = AuctionSale(source_name="avoventes", source_url="https://example.test/m", property_type="house")
    asset = extract_surface_facts_from_text(text)
    assert asset is not None
    apply_surface_reasoning_to_sale(sale, [asset], context=text, source="test")

    assert sale.habitable_surface_m2 is None
    assert sale.surface_m2 is None


def test_dwelling_under_nine_square_meters_has_no_application_surface() -> None:
    for property_type in ("apartment", "house"):
        sale = normalize_sale(
            _raw(property_type=property_type, surface_m2="4.16", description="Bien vendu sur saisie.")
        )
        normalize_asset_features(sale)

        assert sale.app_surface_m2 is None, property_type
        assert sale.surface_scope == "room_or_annex", property_type
        assert "ambiguous_surface" in sale.quality_flags, property_type


def test_small_surfaces_are_still_accepted_for_other_property_types() -> None:
    sale = normalize_sale(_raw(property_type="commercial", surface_m2="6.5"))
    normalize_asset_features(sale)

    assert sale.app_surface_m2 == Decimal("6.5")
