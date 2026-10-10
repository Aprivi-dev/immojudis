"""Procedure-specific documentary coverage must not require a judicial PV everywhere."""

from src.models import AuctionSale
from src.pdf_document_types import classify_document_type
from src.pdf_enrichment import _store_document_analysis_status


def _coverage(*, venue: str, framework: str, property_type: str = "apartment") -> dict:
    sale = AuctionSale(
        source_name="aggregator",
        source_url="https://example.test/sale",
        property_type=property_type,
        sale_venue_type=venue,
        sale_legal_framework=framework,
        sale_verification_status="verified",
        sale_procedure={"venue_type": venue, "legal_framework": framework, "verification": {"status": "verified"}},
    )
    docs = [
        {
            "url": "https://example.test/conditions.pdf",
            "label": "Conditions de vente",
            "document_type": "conditions_vente",
        }
    ]
    if property_type != "land":
        docs.append(
            {"url": "https://example.test/diag.pdf", "label": "Diagnostics", "document_type": "diagnostics_techniques"}
        )
    payloads = [{**doc, "text": "Texte du dossier officiel.", "extraction_status": "extracted"} for doc in docs]
    _store_document_analysis_status(sale, docs, payloads)
    return sale.raw_payload["document_analysis"]


def test_notarial_dossier_does_not_require_a_judicial_pv() -> None:
    analysis = _coverage(venue="notary", framework="voluntary_notarial")
    assert analysis["procedure_family"] == "notarial"
    assert analysis["missing_core_documents"] == []
    assert analysis["required_core_document_groups"] == ["conditions_vente", "diagnostics"]


def test_state_land_sale_uses_state_profile_even_at_notary() -> None:
    analysis = _coverage(venue="notary", framework="state_sale", property_type="land")
    assert analysis["procedure_family"] == "state"
    assert analysis["missing_core_documents"] == []
    assert analysis["required_core_document_groups"] == ["conditions_vente"]


def test_judicial_dossier_retains_descriptive_pv_requirement() -> None:
    analysis = _coverage(venue="tribunal", framework="judicial_seizure")
    assert analysis["missing_core_documents"] == ["pv_descriptif"]


def test_notarial_regulation_is_sale_conditions_not_descriptive_pv() -> None:
    assert classify_document_type("Règlement de vente", "https://notaires.example/reglement.pdf") == "conditions_vente"
