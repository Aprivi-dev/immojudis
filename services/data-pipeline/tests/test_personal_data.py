"""Filtre des données personnelles : cas partagés avec src/lib/personal-data-filter.test.ts."""

from __future__ import annotations

import gc
import json
import sys
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
    # The projections no longer copy the source payload: no name can leak through it.
    assert set(properties[0]["raw_payload"]) <= {"publication_quarantine"}
    assert set(judicial[0]["raw_payload"]) <= {"publication_quarantine"}
    assert "DUPONT" not in str(properties[0]) and "FAURE" not in str(judicial[0])

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


# Linéarité plutôt qu'un plafond absolu : un temps fixe (0,2 s) dépend de la machine et de sa charge, alors qu'un
# filtre quadratique se voit au rapport entre deux tailles. Chaque texte est construit pour une taille ``n`` ;
# doubler ``n`` ne doit pas faire plus que tripler le temps (2 = linéaire, 4 = quadratique), à la meilleure de
# trois mesures pour chaque taille.
_LINEARITY_MAX_RATIO = 3.0
_LINEARITY_MEASURES = 7
_LINEARITY_TIMER_FLOOR_SECONDS = 0.002

_LONG_WHITESPACE_TEXTS = {
    "né et espaces": lambda n: "né" + " " * (100 * n),
    "née et espaces": lambda n: "Madame X, née" + " " * (100 * n),
    "demeurant et espaces": lambda n: "Madame X, demeurant" + " " * (100 * n),
    "espaces avant né": lambda n: " " * (100 * n) + "né le 3 mai 1950",
    "espaces avant demeurant": lambda n: "Madame X," + " " * (100 * n) + "demeurant 3 rue A 75000 Paris",
    "naissance répétée": lambda n: ("Madame X, née le 3 mai 1950" + " " * 300) * n,
    "résidence répétée": lambda n: ("Madame X, demeurant 3 rue des Lilas 69000 Lyon" + " " * 300) * n,
    "locataire répété": lambda n: ("Le locataire" + " " * 300) * n,
    "bail consenti répété": lambda n: ("bail consenti" + " " * 300) * n,
    "occupé par répété": lambda n: ("occupé par Madame Eva ROY" + " " * 300) * n,
    "à la requête de répété": lambda n: ("à la requête de" + " " * 300) * n,
    "à la requête de : répété": lambda n: ("à la requête de :" + " " * 300 + "la" + " " * 300) * (n // 2),
    "rôle répété": lambda n: ("Le débiteur" + " " * 300) * n,
    "rôle suivi d'un nom répété": lambda n: ("Le saisi, Paul" + " " * 300 + "ROY" + " " * 300) * (n // 2),
    "NOM Prénom répété": lambda n: ("occupé par DUPONT" + " " * 300 + "Pierre" + " " * 300) * (n // 2),
    "Prénom Nom en casse mixte répété": lambda n: ("occupé par Pierre" + " " * 300 + "Martin" + " " * 300) * (n // 2),
    "longue suite de noms en capitales": lambda n: "occupé par " + "DUPONT " * (25 * n),
    "longue suite de prénoms": lambda n: "Le saisi, " + "Pierre " * (25 * n),
    "longue suite de NOM Prénom": lambda n: "occupé par " + "DUPONT Pierre " * (15 * n),
    "longue suite de mots en casse mixte": lambda n: "occupé par " + "Pierre Martin " * (15 * n),
    "famille et indivision répétées": lambda n: ("la famille" + " " * 300 + "indivision" + " " * 300) * (n // 2),
    "associé répété": lambda n: ("l'associé de" + " " * 300) * n,
}
_LINEARITY_BASE_SIZE = 200


def _best_time(text: str) -> float:
    best = float("inf")
    for _ in range(_LINEARITY_MEASURES):
        gc.collect()  # une collecte déclenchée en cours de mesure la fausserait
        started = time.process_time()  # temps CPU : insensible à la charge de la machine et aux horloges décalées
        redact_personal_text(text)
        best = min(best, time.process_time() - started)
    return max(best, _LINEARITY_TIMER_FLOOR_SECONDS)


@pytest.mark.parametrize("name", list(_LONG_WHITESPACE_TEXTS))
def test_redaction_time_is_linear_on_long_whitespace(name: str) -> None:
    build = _LONG_WHITESPACE_TEXTS[name]

    single = _best_time(build(_LINEARITY_BASE_SIZE))
    double = _best_time(build(2 * _LINEARITY_BASE_SIZE))

    assert double <= _LINEARITY_MAX_RATIO * single, f"{name}: {single:.4f}s then {double:.4f}s for twice the size"


def test_the_linearity_check_catches_a_superlinear_filter(monkeypatch) -> None:
    """Le contrôle lui-même : un traitement bien plus que linéaire dépasse le rapport de 3 entre n et 2n."""

    def superlinear(text: str) -> str:
        size = len(text) // 200
        return str(sum(1 for _ in range(size**3)))

    monkeypatch.setattr(sys.modules[__name__], "redact_personal_text", superlinear)

    single = _best_time(" " * 20_000)
    double = _best_time(" " * 40_000)

    assert double > _LINEARITY_MAX_RATIO * single


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
