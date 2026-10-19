"""Filtre des données personnelles : cas partagés avec src/lib/personal-data-filter.test.ts."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from src.enrichment.prompts import build_display_description_prompt, build_user_prompt
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.personal_data import (
    redact_payload,
    redact_personal_data,
    redact_personal_text,
    redact_storage_row,
)
from src.storage import sale_row_builders, supabase_client

_CASES = json.loads((Path(__file__).parent / "fixtures" / "personal_data_filter_cases.json").read_text("utf-8"))


@pytest.mark.parametrize("case", _CASES["changed"], ids=lambda case: case["name"])
def test_shared_cases_are_rewritten(case: dict[str, str]) -> None:
    assert redact_personal_text(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", _CASES["unchanged"], ids=lambda case: case["name"])
def test_shared_false_positives_are_left_alone(case: dict[str, str]) -> None:
    assert redact_personal_text(case["input"]) == case["input"]


@pytest.mark.parametrize("case", _CASES["changed"], ids=lambda case: case["name"])
def test_personal_details_do_not_survive(case: dict[str, object]) -> None:
    result = redact_personal_text(str(case["input"])) or ""
    for fragment in case["absent"]:  # type: ignore[attr-defined]
        assert fragment not in result


@pytest.mark.parametrize("case", _CASES["changed"], ids=lambda case: case["name"])
def test_filter_is_idempotent(case: dict[str, str]) -> None:
    once = redact_personal_text(case["input"])
    assert redact_personal_text(once) == once


def test_none_and_non_strings_pass_through() -> None:
    assert redact_personal_text(None) is None
    assert redact_personal_data(42) == 42
    assert redact_personal_data(None) is None


def test_redact_personal_data_walks_json_values() -> None:
    value = {
        "a": ["Occupé par Monsieur Pierre DUPONT suivant bail", 3, None],
        "b": {"c": "À la requête de Madame Anne ROUX, demeurant 3 rue X 75000 Paris."},
    }
    assert redact_personal_data(value) == {
        "a": ["Occupé par un occupant suivant bail", 3, None],
        "b": {"c": "À la requête du créancier poursuivant."},
    }


def test_redact_payload_only_touches_text_keys() -> None:
    payload = {
        "source_description": "Occupé par Monsieur Pierre DUPONT suivant bail.",
        "source_checks": {"https://x.test/a": {"fingerprint": "occupé par Monsieur Pierre DUPONT"}},
        "llm_extraction": {"occupancy_details": "Locataire Madame Sara LOPEZ", "risks": ["Bail consenti à Paul ROY"]},
        "source_blocks": {"detail": {"Occupation": "occupé par Monsieur Luc PETIT"}},
    }
    result = redact_payload(payload)
    assert result["source_description"] == "Occupé par un occupant suivant bail."
    assert result["source_checks"] == payload["source_checks"]
    assert result["llm_extraction"] == {"occupancy_details": "Locataire", "risks": ["Bail consenti à un locataire"]}
    assert result["source_blocks"] == {"detail": {"Occupation": "occupé par un occupant"}}
    assert payload["source_description"].startswith("Occupé par Monsieur")  # entrée non modifiée


def test_redact_storage_row_covers_columns_payload_and_observations() -> None:
    row = {
        "description": "Appartement occupé par Monsieur Pierre DUPONT suivant bail.",
        "risk_notes": "Locataire Madame Sara LOPEZ",
        "investment_summary": None,
        "surface_evidence": "Surface de 62 m² occupée par Madame Eva ROY",
        "lawyer_contact": "Me X, avocat, demeurant 5 rue de la Paix 75002 Paris",
        "raw_payload": {"source_description": "À la requête de Monsieur Henri FAURE, demeurant 1 rue A 75000 Paris."},
        "observations": [
            {
                "source_url": "https://x.test/1",
                "raw_payload": {"source_blocks": {"t": "occupé par Madame Eva ROY"}},
            },
            "autre",
        ],
    }
    result = redact_storage_row(row)
    assert result is row
    assert row["description"] == "Appartement occupé par un occupant suivant bail."
    assert row["risk_notes"] == "Locataire"
    assert row["surface_evidence"] == "Surface de 62 m² occupée par un occupant"
    assert row["lawyer_contact"].startswith("Me X, avocat, demeurant")
    assert row["raw_payload"]["source_description"] == "À la requête du créancier poursuivant."
    assert row["observations"][0]["raw_payload"]["source_blocks"] == {"t": "occupé par un occupant"}
    assert row["observations"][1] == "autre"


def _sale_with_names() -> AuctionSale:
    return normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/sale-with-names",
            "city": "Lyon",
            "starting_price_eur": 90000,
            "description": "Appartement occupé par Monsieur Pierre DUPONT suivant bail.",
            "source_description": "À la requête de Monsieur Henri FAURE, demeurant 14 rue des Lilas 69003 Lyon.",
            "source_blocks": {"detail": {"Occupation": "Locataire Madame Sara LOPEZ"}},
            "source_checks": {"https://example.test/sale-with-names": {"fingerprint": "abc"}},
        }
    )


def test_upsert_writes_redacted_text_and_keeps_the_in_memory_sale(monkeypatch: pytest.MonkeyPatch) -> None:
    sale = _sale_with_names()
    captured: list[dict[str, object]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(supabase_client, "_upsert_with_rest", lambda _url, _key, payload: captured.extend(payload))
    monkeypatch.setattr(supabase_client, "_write_fact_claims_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_enqueue_due_enrichment", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_sync_normalized_sale_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_upsert_asset_tables_with_rest", lambda *args, **kwargs: None)

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1

    row = captured[0]
    assert row["description"] == "Appartement occupé par un occupant suivant bail."
    payload = row["raw_payload"]
    assert payload["source_description"] == "À la requête du créancier poursuivant."
    assert payload["source_blocks"] == {"detail": {"Occupation": "Locataire"}}
    assert payload["source_checks"] == {"https://example.test/sale-with-names": {"fingerprint": "abc"}}
    # La collecte continue de travailler sur le texte d'origine (empreintes, extraction).
    assert "DUPONT" in (sale.description or "")
    assert "FAURE" in sale.raw_payload["source_description"]


def test_normalized_tables_and_risk_excerpts_are_redacted() -> None:
    sale = _sale_with_names()
    properties = sale_row_builders._property_rows_for_sales([sale], "2026-07-06T10:00:00+00:00")
    judicial = sale_row_builders._judicial_sale_rows_for_sales([sale], "2026-07-06T10:00:00+00:00")
    assert properties[0]["description"] == "Appartement occupé par un occupant suivant bail."
    assert properties[0]["raw_payload"]["source_description"] == "À la requête du créancier poursuivant."
    assert judicial[0]["raw_payload"]["source_blocks"] == {"detail": {"Occupation": "Locataire"}}

    occurrence = sale_row_builders._public_occurrence_row(
        {
            "source_url": "https://example.test/sale-with-names",
            "risk_type": "occupancy",
            "risk_label": "Locataire en place",
            "severity": 2,
            "excerpt": "Bail consenti à Monsieur Olivier MOREAU pour neuf ans.",
        }
    )
    assert occurrence["excerpt"] == "Bail consenti à un locataire pour neuf ans."


def test_prompts_forbid_reproducing_personal_data() -> None:
    display = build_display_description_prompt("[FAITS CANONIQUES]\n- NATURE_VENTE : vente judiciaire.")
    extraction = build_user_prompt("Annonce : appartement occupé.")
    for prompt in (display, extraction):
        folded = prompt.casefold()
        assert "nom, la date de naissance" in folded
        assert "adresse personnelle" in folded
        for role in ("le saisi", "l'occupant", "le locataire"):
            assert role in folded
    assert "Interdits (liste noire)" in display
    assert display.index("Interdits (liste noire)") < display.index("adresse personnelle")
    assert "occupancy_details" in extraction[extraction.index("Règles données personnelles") :][:400]


def test_fact_input_key_does_not_depend_on_personal_names() -> None:
    from src.enrichment.extract_structured import _fact_input_cache_key

    raw = "[ANNONCE]\nAppartement occupé par Monsieur Pierre DUPONT suivant bail."
    stored = "[ANNONCE]\nAppartement occupé par un occupant suivant bail."
    other = "[ANNONCE]\nAppartement libre."
    assert _fact_input_cache_key(raw, "model", "v1") == _fact_input_cache_key(stored, "model", "v1")
    assert _fact_input_cache_key(raw, "model", "v1") != _fact_input_cache_key(other, "model", "v1")


def test_fact_chunk_and_display_keys_do_not_depend_on_personal_names() -> None:
    from src.enrichment.extract_structured import _display_cache_key, _fact_chunk_cache_key

    raw = "[ANNONCE]\nAppartement occupé par Monsieur Pierre DUPONT suivant bail, né le 3 mai 1950 à Lyon."
    stored = "[ANNONCE]\nAppartement occupé par un occupant suivant bail."
    other = "[ANNONCE]\nAppartement libre."
    for key in (_fact_chunk_cache_key, _display_cache_key):
        assert key(raw, "model", "v1") == key(stored, "model", "v1")
        assert key(raw, "model", "v1") != key(other, "model", "v1")
        assert key(stored, "model", "v1") != key(stored, "model", "v2")


_LINEAR_BUDGET_SECONDS = 0.2


_LONG_WHITESPACE_TEXTS = {
    "né et 20 000 espaces": "né" + " " * 20000,
    "née et 20 000 espaces": "Madame X, née" + " " * 20000,
    "demeurant et 20 000 espaces": "Madame X, demeurant" + " " * 20000,
    "20 000 espaces avant né": " " * 20000 + "né le 3 mai 1950",
    "20 000 espaces avant demeurant": "Madame X," + " " * 20000 + "demeurant 3 rue A 75000 Paris",
    "naissance répétée": ("Madame X, née le 3 mai 1950" + " " * 300) * 200,
    "résidence répétée": ("Madame X, demeurant 3 rue des Lilas 69000 Lyon" + " " * 300) * 200,
    "locataire répété": ("Le locataire" + " " * 300) * 200,
    "bail consenti répété": ("bail consenti" + " " * 300) * 200,
    "occupé par répété": ("occupé par Madame Eva ROY" + " " * 300) * 200,
    "à la requête de répété": ("à la requête de" + " " * 300) * 200,
    "à la requête de : répété": ("à la requête de :" + " " * 300 + "la" + " " * 300) * 100,
    "rôle répété": ("Le débiteur" + " " * 300) * 200,
    "rôle suivi d'un nom répété": ("Le saisi, Paul" + " " * 300 + "ROY" + " " * 300) * 100,
    "NOM Prénom répété": ("occupé par DUPONT" + " " * 300 + "Pierre" + " " * 300) * 100,
    "longue suite de noms en capitales": "occupé par " + "DUPONT " * 5000,
    "longue suite de prénoms": "Le saisi, " + "Pierre " * 5000,
    "longue suite de NOM Prénom": "occupé par " + "DUPONT Pierre " * 3000,
}


@pytest.mark.parametrize("name", list(_LONG_WHITESPACE_TEXTS))
def test_redaction_time_is_linear_on_long_whitespace(name: str) -> None:
    started = time.perf_counter()
    redact_personal_text(_LONG_WHITESPACE_TEXTS[name])
    assert time.perf_counter() - started < _LINEAR_BUDGET_SECONDS


def test_birth_and_residence_are_still_removed_with_their_leading_separator() -> None:
    assert redact_personal_text("Madame X , née le 3 mai 1950 à Lyon , demeurant 3 rue A 75000 Paris.") == "Madame X."
    assert redact_personal_text("Madame X    née le 3 mai 1950 vend.") == "Madame X vend."
    long = ("Madame X, née le 3 mai 1950" + " " * 300) * 200
    assert "1950" not in (redact_personal_text(long) or "")


def test_first_names_are_the_same_as_in_the_typescript_mirror() -> None:
    """La liste de prénoms de `NOM Prénom` est copiée mot pour mot des deux côtés."""
    import re

    from src.personal_data import _FIRST_NAMES

    source = (Path(__file__).resolve().parents[3] / "src" / "lib" / "personal-data-filter.ts").read_text("utf-8")
    block = re.search(r"const FIRST_NAMES =([\s\S]*?);\n", source)
    assert block is not None
    typescript = "".join(re.findall(r'"([^"]*)"', block.group(1)))

    assert len(_FIRST_NAMES.split(" ")) > 300
    assert _FIRST_NAMES == typescript
