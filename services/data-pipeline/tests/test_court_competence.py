from __future__ import annotations

from pathlib import Path

import pytest

from src.court_competence import (
    COURT_ASSIGNMENT_METHOD,
    COURT_ASSIGNMENT_SCHEMA_VERSION,
    CompetentCourtAssignment,
    CourtCompetenceReference,
    tribunal_reference_rows,
    verified_sale_insee_code,
)
from src.normalize import normalize_sale

RAW_ROOT = Path(__file__).parents[1] / "data" / "raw" / "outcome_sources" / "justice_courts"


def test_verified_sale_insee_code_requires_accepted_ban_evidence() -> None:
    sale = normalize_sale(
        {
            "source_name": "fixture",
            "source_url": "https://example.test/sale",
            "raw_payload": {
                "geocode": {
                    "provider": "ban_geoplateforme",
                    "accepted": True,
                    "citycode": "33063",
                }
            },
        }
    )
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme",
        "accepted": True,
        "citycode": "33063",
    }

    assert verified_sale_insee_code(sale) == "33063"
    sale.raw_payload["geocode"]["accepted"] = False
    assert verified_sale_insee_code(sale) is None


def test_reference_resolves_exact_insee_to_ministry_tj_when_cache_is_available() -> None:
    competences = RAW_ROOT / "resource-e2a1941b-observed-competences.csv"
    structures = RAW_ROOT / "2026-domaine-juridique-adresse.csv"
    if not competences.exists() or not structures.exists():
        pytest.skip("local Justice open-data cache is not present")

    reference = CourtCompetenceReference(competences, structures)

    bordeaux = reference.resolve("33063")
    haut_valromey = reference.resolve("01187")
    assert bordeaux is not None
    assert (bordeaux.court_code, bordeaux.court_name) == ("bordeaux", "TJ Bordeaux")
    assert haut_valromey is not None
    assert haut_valromey.court_name == "TJ Bourg-en-Bresse"
    assert haut_valromey.court_code == "justice_tj_1_39"


def test_tribunal_reference_rows_accept_only_complete_verified_assignment() -> None:
    assignment = CompetentCourtAssignment(
        insee_code="01187",
        commune_name="HAUT VALROMEY",
        court_code="justice_tj_1_39",
        court_name="TJ Bourg-en-Bresse",
        official_court_name="Tribunal judiciaire de Bourg-en-Bresse",
        court_origin_code="1",
        court_srj_code="39",
        court_department="01",
        court_city="Bourg-en-Bresse",
        reference_sha256="a" * 64,
    )
    sale = normalize_sale(
        {
            "source_name": "fixture",
            "source_url": "https://example.test/sale",
            "raw_payload": {"tribunal_assignment": assignment.evidence()},
        }
    )
    sale.raw_payload["tribunal_assignment"] = assignment.evidence()

    assert assignment.evidence()["schema_version"] == COURT_ASSIGNMENT_SCHEMA_VERSION
    assert assignment.evidence()["mapping_method"] == COURT_ASSIGNMENT_METHOD
    assert tribunal_reference_rows([sale]) == [assignment.tribunal_reference_row()]

    sale.raw_payload["tribunal_assignment"]["reference_sha256"] = "invalid"
    assert tribunal_reference_rows([sale]) == []
