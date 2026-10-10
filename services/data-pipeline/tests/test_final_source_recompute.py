from decimal import Decimal

import pytest

from src.enrichment.surface_reasoning import extract_surface_facts_from_text, reason_about_surfaces
from src.extraction_profiles import build_procedure_profile
from src.recompute_scoring import _recomputed_sale_from_storage_row


@pytest.mark.parametrize("previous_surface", ["83.21", "117", "117.58"])
def test_stored_multi_unit_sale_keeps_explicit_carrez_total(previous_surface: str) -> None:
    text = (
        "Appartement T3 d'une surface de 83,21 m² carrez avec studio indépendant "
        "mais contigu d'une surface de 34,37 m² carrez au 4ème étage soit une "
        "surface carrez totale de 117,58 m² avec deux parkings couverts. "
        "L'APPARTEMENT T3 de 83,21 m² carrez. LE STUDIO de 34,37 m² carrez."
    )
    row = {
        "source_name": "notaires",
        "source_url": "https://example.test/ensemble",
        "property_type": "apartment",
        "surface_m2": previous_surface,
        "carrez_surface_m2": previous_surface,
        "app_surface_m2": previous_surface,
        "habitable_surface_m2": "117",
        "surface_scope": "total",
        "raw_payload": {"description": text},
    }
    for _ in range(2):
        sale = _recomputed_sale_from_storage_row(row)
        assert sale.carrez_surface_m2 == Decimal("117.58")
        assert sale.surface_m2 == sale.app_surface_m2 == Decimal("117.58")
        assert sale.surface_scope == "total"
        assert "117,58" in sale.surface_evidence
        row = sale.model_dump(mode="json")


def test_notarial_profile_does_not_use_generic_notaires_branding_as_study() -> None:
    profile = build_procedure_profile({
        "source_url": "https://example.test/vente",
        "source_blocks": {"guide": "Guide des ventes aux enchères des Notaires de France"},
        "sale_procedure": {"venue_type": "notary", "verification_status": "verified"},
    })
    assert profile["fields"]["notary_study"]["state"] == "unknown"


def test_notarial_profile_prefers_identified_notary_over_generic_guide() -> None:
    profile = build_procedure_profile({
        "source_url": "https://example.test/vente",
        "source_blocks": {"guide": "Guide des ventes aux enchères des Notaires de France"},
        "sale_procedure": {
            "venue_type": "notary", "verification_status": "verified",
            "organizer_type": "notary", "organizer_name": "Catherine LESCURE",
        },
    })
    field = profile["fields"]["notary_study"]
    assert field["value"] == "Catherine LESCURE"
    assert field["provenance"] == "verified_metadata"
    assert "organizer_name" in field["evidence"]


def test_notarial_profile_keeps_explicit_study_label() -> None:
    profile = build_procedure_profile({
        "description": "Vente notariale. Étude notariale : Dupont et Associés.",
    })
    assert profile["fields"]["notary_study"]["value"] == "Dupont et Associés"


def test_total_priority_requires_a_typed_total_for_that_measurement() -> None:
    text = "Appartement de 40 m² carrez. Terrain de 2000 m² au total."
    asset = extract_surface_facts_from_text(text)
    result = reason_about_surfaces([asset], context=text, property_type="apartment")
    assert result.selected.value_m2 == Decimal("40")
    assert all(candidate.scope != "sale" for candidate in result.candidates)


def test_unverified_notary_organizer_is_not_promoted_to_verified_study() -> None:
    profile = build_procedure_profile({
        "description": "Vente notariale.",
        "sale_procedure": {
            "venue_type": "notary", "verification_status": "pending",
            "organizer_type": "notary", "organizer_name": "À confirmer",
        },
    })
    assert profile["fields"]["notary_study"]["state"] == "unknown"
