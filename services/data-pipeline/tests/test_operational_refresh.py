from copy import deepcopy

import pytest

from src.enrichment.display_quality import has_current_display
from src.enrichment.operational_display import refresh_operational_display
from src.freshness import record_source_checks
from src.models import AuctionSale


def _revision():
    raw = {"source_url": "https://example.test/operational", "source_name": "avoventes",
           "raw_text": "Appartement de trois pièces à Bordeaux.", "starting_price_eur": 100000,
           "sale_date": "2026-11-01", "status": "upcoming"}
    record_source_checks([raw], {})
    raw.pop("source_content_changed", None)
    raw.update(llm_display_description="Vente le 1 novembre 2026. Mise à prix 100000 euros.",
               llm_fact_extraction={"rooms_count": 3, "display_description": "Ancien texte"},
               llm_fact_coverage={"complete": True}, llm_fact_input_key="proof",
               document_facts_version="current", investment_analysis={"price": 100000})
    known = {raw["source_url"]: {"raw_payload": deepcopy(raw)}}
    return raw, known


def test_operational_revision_preserves_facts_and_removes_old_prose():
    raw, known = _revision()
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    assert raw["source_operational_changed"] is True
    assert raw["llm_fact_coverage"]["complete"]
    assert raw["llm_fact_input_key"] == "proof"
    assert raw["document_facts_version"] == "current"
    assert raw["llm_fact_extraction"]["display_description"] is None
    assert "llm_display_description" not in raw
    assert "investment_analysis" not in raw


def test_changed_evidence_invalidates_fact_completion():
    raw, known = _revision()
    raw["raw_text"] += " Occupation sans titre."
    record_source_checks([raw], known)
    assert "source_operational_changed" not in raw
    assert "llm_fact_coverage" not in raw
    assert "llm_fact_input_key" not in raw


def test_identical_rescan_keeps_display_and_fact_coverage():
    raw, known = _revision()
    record_source_checks([raw], known)
    assert "source_content_changed" not in raw
    assert "llm_display_description" in raw
    assert raw["llm_fact_coverage"]["complete"]


def test_legacy_revision_is_not_assumed_operational_only():
    raw, known = _revision()
    known[raw["source_url"]]["raw_payload"]["source_checks"][raw["source_url"]].pop("evidence_fingerprint")
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    assert "llm_fact_coverage" not in raw


def test_operational_display_is_new_and_network_free():
    raw, known = _revision()
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    sale = AuctionSale(source_name="avoventes", source_url=raw["source_url"], city="Bordeaux",
                       property_type="apartment", rooms_count=3, raw_payload=raw)
    assert refresh_operational_display(sale)
    assert has_current_display(sale.raw_payload)
    text = sale.raw_payload["llm_display_description"]
    assert "100000" not in text and "novembre" not in text
    assert "3 pièces" in text
    assert "source_content_changed" not in sale.raw_payload


def test_operational_refresh_preserves_source_legal_constraints():
    sale = AuctionSale(source_name="avoventes", source_url="https://example.test/risk",
                       city="Bordeaux", property_type="apartment",
                       raw_payload={"source_operational_changed": True,
                                    "description": "Appartement à Bordeaux. Le bien est en indivision."})
    assert refresh_operational_display(sale)
    assert "indivision" in sale.raw_payload["llm_display_description"]


@pytest.mark.parametrize("facts", [
    {"servitudes": ["Passage imposé par le cahier des conditions de vente"]},
    {"occupancy_details": "Locataire dont le bail fait l'objet d'une contestation"},
])
def test_operational_refresh_does_not_drop_pdf_only_qualifiers(facts):
    sale = AuctionSale(source_name="avoventes", source_url="https://example.test/pdf-risk",
                       raw_payload={"source_operational_changed": True, "llm_fact_extraction": facts})
    assert not refresh_operational_display(sale)
    assert "llm_display_description" not in sale.raw_payload
