"""Recorded model responses (nominal, degraded, adversarial) replayed through the validators.

The corpus lives in ``fixtures/llm_recorded_responses.json``. No network call: the responses are
fed to ``_apply_extraction_to_sale`` (structured extraction) and ``validate_reading_points``
(document reading), the two places where free model output is turned into published facts.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src import document_reading as reading
from src.enrichment import extract_structured as extraction
from src.models import AuctionSale

CORPUS = json.loads((Path(__file__).parent / "fixtures" / "llm_recorded_responses.json").read_text(encoding="utf-8"))


def _sale() -> AuctionSale:
    return AuctionSale(source_name="test", source_url="https://example.test/sale")


@pytest.mark.parametrize("case", CORPUS["extraction_cases"], ids=lambda case: case["name"])
def test_recorded_extraction_responses(case: dict) -> None:
    sale = _sale()
    parsed = extraction._validated_llm_extraction(case["response"])

    extraction._apply_extraction_to_sale(sale, parsed, extraction.LLMEnrichmentStats(), case["context"])

    expect = case["expect"]
    for field in ("property_type", "rooms_count", "bedrooms_count", "occupancy_status"):
        if field in expect:
            assert getattr(sale, field) == expect[field], field
    risk_notes = sale.risk_notes or ""
    if "risk_notes" in expect:
        assert (sale.risk_notes or None) == expect["risk_notes"]
    for fragment in expect.get("risk_notes_contains", []):
        assert fragment in risk_notes
    for fragment in expect.get("risk_notes_excludes", []):
        assert fragment not in risk_notes


@pytest.mark.parametrize("case", CORPUS["reading_cases"], ids=lambda case: case["name"])
def test_recorded_reading_responses(case: dict) -> None:
    documents = reading.documents_from_manifest(CORPUS["reading_manifest"])

    points = reading.validate_reading_points(case["response"]["points"], documents)

    assert [point["title"] for point in points] == case["expect_titles"]
    for point in points:
        assert "<" not in str(point["quote"]) or str(point["quote"]) in documents[0].pages[int(point["page"])]
