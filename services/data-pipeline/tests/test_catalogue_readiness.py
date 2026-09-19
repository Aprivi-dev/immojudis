from datetime import UTC, datetime
from decimal import Decimal

from src.catalogue_readiness import (
    CATALOGUE_READINESS_POLICY_VERSION,
    apply_catalogue_readiness,
    assess_catalogue_readiness,
)
from src.models import AuctionSale


def _complete_sale(**overrides) -> AuctionSale:
    values = {
        "source_name": "avoventes",
        "source_url": "https://example.test/vente/1",
        "source_urls": ["https://partner.example.test/vente/1"],
        "external_id": "sale-1",
        "tribunal": "Tribunal judiciaire de Bordeaux",
        "sale_venue_type": "judicial",
        "sale_legal_framework": "judicial_auction",
        "sale_verification_status": "verified",
        "sale_procedure": {"type": "auction", "deposit": "10%"},
        "city": "Bordeaux",
        "department": "33",
        "address": "1 rue Test, 33000 Bordeaux",
        "postal_code": "33000",
        "property_type": "apartment",
        "title": "Appartement T3",
        "description": "Appartement lumineux de 68 m2, libre et proche des commerces.",
        "surface_m2": Decimal("68"),
        "starting_price_eur": Decimal("150000"),
        "sale_date": datetime(2027, 1, 10, 14, tzinfo=UTC),
        "visit_dates": ["2027-01-04 10:00"],
        "lawyer_name": "Cabinet Test",
        "lawyer_contact": "contact@example.test",
        "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
        "occupancy_status": "vacant",
        "investment_score": Decimal("82"),
        "investment_summary": "Rendement et risques documentés.",
        "score_confidence": Decimal("0.82"),
        "raw_text": "Appartement T3 à Bordeaux. Mise à prix 150000 euros.",
        "raw_payload": {
            "source_blocks": {
                "titre": "Appartement T3",
                "adresse": "1 rue Test, 33000 Bordeaux",
                "description": "Appartement lumineux de 68 m2.",
                "mise_a_prix": "150000 euros",
            },
            "source_images": ["https://example.test/photo.jpg"],
            "source_energy_diagnostics": {"dpe_class": "D", "ges_class": "B"},
        },
    }
    values.update(overrides)
    return AuctionSale(**values)


def test_complete_sale_is_premium_ready_and_explainable() -> None:
    sale = _complete_sale()

    result = apply_catalogue_readiness(sale)

    assert result.score == 99
    assert result.status == "premium_ready"
    assert result.policy_version == CATALOGUE_READINESS_POLICY_VERSION
    assert sale.premium_readiness_score == 99
    assert sale.premium_readiness_status == "premium_ready"
    assert list(sale.premium_readiness_factors) == [
        "sale_provenance",
        "property",
        "proofs",
        "practical",
        "analysis",
    ]
    assert sale.premium_readiness_blockers == []
    assert sale.premium_readiness_missing_fields == []
    assert sale.premium_readiness_evaluated_at is not None
    assert sale.premium_readiness_evaluated_at.tzinfo is UTC


def test_repeated_identical_evaluation_preserves_timestamp() -> None:
    sale = _complete_sale()

    apply_catalogue_readiness(sale)
    evaluated_at = sale.premium_readiness_evaluated_at
    apply_catalogue_readiness(sale)

    assert sale.premium_readiness_evaluated_at == evaluated_at


def test_mid_score_sale_is_kept_for_enrichment() -> None:
    sale = _complete_sale(
        documents=[],
        source_urls=[],
        raw_payload={"source_blocks": {"description": "Appartement de 68 m2."}},
        raw_text="Appartement de 68 m2.",
        visit_dates=[],
        lawyer_name=None,
        lawyer_contact=None,
        occupancy_status=None,
        investment_score=None,
        investment_summary=None,
        score_confidence=None,
    )

    result = assess_catalogue_readiness(sale)

    assert result.score == 65
    assert result.status == "needs_enrichment"
    assert result.blockers == []
    assert {"documents", "visit_dates", "occupancy_status", "score_confidence"} <= set(result.missing_fields)


def test_missing_source_proof_is_a_hard_blocker() -> None:
    sale = _complete_sale(
        title=None,
        description=None,
        raw_text=None,
        raw_payload={},
        documents=[],
    )

    result = assess_catalogue_readiness(sale)

    assert "source_proof" in result.blockers
    assert result.status == "needs_enrichment"


def test_state_sale_may_have_no_starting_price() -> None:
    sale = _complete_sale(source_name="cessions_etat", starting_price_eur=None)

    result = assess_catalogue_readiness(sale)

    assert "starting_price_eur" not in result.blockers
    assert "starting_price_eur" not in result.missing_fields


def test_confidence_gate_blocks_premium_without_being_hard_blocker() -> None:
    sale = _complete_sale(score_confidence=Decimal("0.69"))

    result = assess_catalogue_readiness(sale)

    assert result.score == 99
    assert result.status == "needs_enrichment"
    assert result.blockers == []
    assert result.factors["analysis"]["confidence_gate"]["passed"] is False


def test_identity_or_procedure_conflict_is_a_hard_blocker() -> None:
    sale = _complete_sale(
        raw_payload={
            "source_blocks": {"description": "Appartement de 68 m2."},
            "source_conflicts": [{"field": "property_identity", "reason": "different lot"}],
        }
    )

    result = assess_catalogue_readiness(sale)

    assert "identity_procedure_conflict" in result.blockers
    assert result.status == "needs_enrichment"


def test_admin_verified_document_counts_as_proof_after_review() -> None:
    sale = _complete_sale(
        documents=[],
        raw_text=None,
        title=None,
        description=None,
        raw_payload={
            "information_agent_verified_facts": {
                "document": {
                    "value": {"public_url": "https://example.test/approved/cahier.pdf"},
                    "display_value": "Cahier des conditions de vente",
                    "fact_id": "fact-1",
                    "source": "professional_email",
                }
            }
        },
    )

    result = assess_catalogue_readiness(sale)

    assert "documents" not in result.missing_fields
    assert "source_proof" not in result.blockers
