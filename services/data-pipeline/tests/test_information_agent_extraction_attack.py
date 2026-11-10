"""Cas d'attaque de l'extraction (relecture du 10/11/2026), communs au validateur Python et aux règles
TypeScript (`src/lib/information-agent-inbound/extraction-attack.test.ts`) : aucun faux fait net, aucune
perte des cas nominaux."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.information_agent_semantic import contains_prompt_injection, semantic_lot_context, validate_semantic_facts

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "information_agent_extraction_attack.json").read_text("utf-8"))
LOTS = {"sold_lot_2_of_3": semantic_lot_context(["multi_lot_sale"], {"status": "selected", "lot_number": 2, "lot_count": 3})}


def _verdict(case: dict) -> str:
    facts = validate_semantic_facts(
        [
            {
                "fact_key": case["fact_key"],
                "proposed_value": {"value": case["value"]},
                "evidence_excerpt": case["excerpt"],
                "source_page": 1,
                "confidence": 0.9,
            }
        ],
        [{"page": 1, "text": case["text"]}],
        lot_context=LOTS.get(case["lot"]) if case["lot"] else None,
    )
    if not facts:
        return "rejet"
    return "relecture" if facts[0].review_reasons else "fait_net"


@pytest.mark.parametrize("case", FIXTURE["facts"], ids=[case["id"] for case in FIXTURE["facts"]])
def test_attack_case_is_never_a_false_clear_fact(case: dict) -> None:
    expected = case.get("decision") or case["expected"]
    got = _verdict(case)
    if expected == "fait_net":
        assert got == "fait_net", case["id"]
    else:
        assert got != "fait_net", case["id"]


def test_attack_suite_counts() -> None:
    assert len(FIXTURE["facts"]) == 44
    assert len(FIXTURE["injection"]) == 20


@pytest.mark.parametrize("case", FIXTURE["injection"], ids=[case["id"] for case in FIXTURE["injection"]])
def test_injection_case(case: dict) -> None:
    assert contains_prompt_injection(case["text"]) is case["expected"], case["id"]
