"""Banc d'évaluation de la publication automatique : jeu de données, étape Python à jour, essai réel (faux
client, aucun appel payant)."""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from scripts import information_agent_evaluation as bench
from scripts import information_agent_evaluation_trial as trial
from src.information_agent_semantic import SEMANTIC_SYSTEM_PROMPT

REQUIRED_CASE_KEYS = {"id", "famille", "titre", "message", "contexte", "verite"}
REQUIRED_CONTEXT_KEYS = {
    "type_de_bien",
    "quality_flags",
    "lot_vendu",
    "fiche",
    "destinataire",
    "expediteur_est_destinataire",
    "authentification",
    "delai_jours",
    "messages_posterieurs",
}
EMAIL_RE = re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+")


def test_dataset_has_200_cases_in_8_families_of_25_with_unique_ids() -> None:
    cases = bench.load_cases()
    assert len(cases) == 200
    assert {family: sum(case["famille"] == family for case in cases) for family in range(1, 9)} == {
        family: 25 for family in range(1, 9)
    }
    assert len({case["id"] for case in cases}) == 200
    for case in cases:
        assert set(case) == REQUIRED_CASE_KEYS, case["id"]
        assert set(case["contexte"]) == REQUIRED_CONTEXT_KEYS, case["id"]
        assert set(case["verite"]) == set(bench.ELIGIBLE_FIELDS), case["id"]
        for field, truth in case["verite"].items():
            if truth["publiable"]:
                assert truth["valeur"] > 0 and truth["citation"] in case["message"]["corps"], (case["id"], field)
            else:
                assert len(truth["raison"]) >= 10 and "lecture_modele" in truth, (case["id"], field)


def test_dataset_only_uses_example_addresses() -> None:
    for name in bench.FAMILY_FILES:
        text = (bench.CASES_DIR / name).read_text("utf-8")
        assert [address for address in EMAIL_RE.findall(text) if not address.endswith(".example")] == [], name


@pytest.mark.parametrize("configuration", ["regles_seules", "modele_ideal"])
def test_worker_stage_files_are_up_to_date(configuration: str) -> None:
    """Le fichier relu par le moteur (Vitest) est celui que produit le vrai worker aujourd'hui."""
    expected = bench.serialize(bench.build_worker_stage(configuration))
    assert bench.stage_path(configuration).read_text("utf-8") == expected, (
        "relancer python -m scripts.information_agent_evaluation --write"
    )


def test_rules_only_never_marks_a_semantic_agreement() -> None:
    stage = json.loads(bench.stage_path("regles_seules").read_text("utf-8"))
    for case_id, entry in stage["cas"].items():
        for row in entry["candidates"]:
            assert (row.get("metadata") or {}).get("semantic_agreement") is not True, case_id
        assert {item["status"] for item in entry["semantic"]} <= {"disabled"}, case_id


def _first_case() -> tuple[dict, dict]:
    case = bench.load_cases()[0]
    return case, bench.load_rules_stage()[case["id"]]


def test_harness_refuses_a_request_it_does_not_simulate() -> None:
    case, rules = _first_case()
    fake = bench.FakeSupabase(case, rules)
    response = fake.handle(httpx.Request("DELETE", "https://evaluation.invalid/rest/v1/auction_sales"))
    assert response.status_code == 500
    assert fake.unexpected == ["DELETE /rest/v1/auction_sales"]


def test_recorded_output_is_refused_on_another_prompt() -> None:
    case, rules = _first_case()
    outputs = {
        "outputs": {
            bench.output_key(case["id"], "corps"): {
                "status": "ok",
                "system_prompt_sha256": bench.prompt_sha256(SEMANTIC_SYSTEM_PROMPT),
                "user_prompt_sha256": bench.prompt_sha256("un autre texte"),
                "response": {"facts": []},
            }
        }
    }
    with pytest.raises(bench.EvaluationHarnessError, match="autre prompt"):
        bench.run_case(case, rules, bench.StubModelClient(bench.RecordedResponse(outputs, case["id"])))


def test_budget_cap_cannot_be_raised_above_five_dollars() -> None:
    assert trial.budget_cap(None) == Decimal("5")
    assert trial.budget_cap("2.5") == Decimal("2.5")
    for value in ("5.01", "50", "0", "-1", "NaN", "Infinity"):
        with pytest.raises(SystemExit):
            trial.budget_cap(value)


def test_full_trial_estimate_stays_under_the_cap() -> None:
    calls, total = trial.estimate_full_run_usd("qwen/qwen3-7-plus", 1_024)
    assert 150 <= calls <= 230
    assert Decimal("0") < total < trial.HARD_CAP_USD


def test_trial_refuses_production_credentials() -> None:
    with pytest.raises(SystemExit, match="SUPABASE_SERVICE_ROLE_KEY"):
        trial.refuse_production_credentials({"SUPABASE_SERVICE_ROLE_KEY": "x"})
    trial.refuse_production_credentials({"REPLICATE_API_TOKEN": "x"})


class FakeReplicate:
    """Faux client du modèle : rend une liste de faits vide et compte les appels."""

    model = "qwen/qwen3-7-plus"
    fact_max_tokens = 4_096
    max_retries = 2

    def __init__(self) -> None:
        self.calls = 0

    def generate_json(self, _system: str, _user: str) -> dict:
        raise AssertionError("one attempt only")

    def generate_json_once(self, _system: str, _user: str) -> dict:
        self.calls += 1
        return {"facts": []}


def test_trial_stops_before_the_call_that_would_exceed_the_cap_and_resumes_without_paying_twice(
    tmp_path: Path,
) -> None:
    output = tmp_path / "essai.json"
    client = FakeReplicate()
    small_cap = Decimal("0.01")
    first = trial.run_trial(output, small_cap, client_factory=lambda: client, log=lambda _line: None)
    assert first["stopped_reason"] == "budget"
    assert Decimal(first["estimated_spend_usd"]) <= small_cap
    assert 0 < client.calls < 20
    saved = json.loads(output.read_text("utf-8"))
    assert saved["stopped_reason"] == "budget"
    assert sum(entry["status"] == "ok" for entry in saved["outputs"].values()) == client.calls
    # Le worker a reçu le plafond de sortie et l'essai unique de la lecture des réponses.
    assert client.fact_max_tokens == 1_024 and client.max_retries == 0

    calls_before = client.calls
    trial.run_trial(output, Decimal("0.02"), client_factory=lambda: client, log=lambda _line: None)
    resumed = json.loads(output.read_text("utf-8"))
    assert client.calls > calls_before
    assert sum(entry["status"] == "ok" for entry in resumed["outputs"].values()) == client.calls
    assert Decimal(resumed["estimated_spend_usd"]) <= Decimal("0.02")


def test_trial_output_is_replayed_by_the_bench(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = tmp_path / "essai.json"
    client = FakeReplicate()
    trial.run_trial(output, Decimal("0.05"), client_factory=lambda: client, log=lambda _line: None)
    monkeypatch.setattr(bench, "MODEL_OUTPUTS_DIR", tmp_path)
    stage = bench.build_worker_stage("enregistrement_essai")
    assert stage["modele_reel"] is True
    played = [case_id for case_id, entry in stage["cas"].items() if "missing" not in entry]
    assert played and len(played) < 200
    assert all(entry == {"missing": True} for entry in stage["cas"].values() if "candidates" not in entry)


WORKFLOWS = bench.PIPELINE_ROOT.parents[1] / ".github" / "workflows"


def _env_value(text: str, name: str) -> str:
    match = re.search(rf"^\s+{name}:\s*(.+?)\s*$", text, re.MULTILINE)
    assert match, name
    return match.group(1).strip('"')


def test_trial_workflow_is_manual_main_only_confirmed_and_without_database_access() -> None:
    workflow = (WORKFLOWS / "information-agent-evaluation-trial.yml").read_text("utf-8")
    on_block = workflow.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
    assert re.findall(r"^  (\w+):", on_block, re.MULTILINE) == ["workflow_dispatch"]
    assert "if: github.ref == 'refs/heads/main'" in workflow
    assert 'if [ "$CONFIRMATION" != "ESSAI PAYANT 5 USD" ]' in workflow
    assert "group: immojudis-information-agent-evaluation-trial" in workflow
    assert re.findall(r"secrets\.(\w+)", workflow) == ["REPLICATE_API_TOKEN"]
    # Ni variable Supabase, ni d'envoi d'email (le commentaire d'en-tête peut les nommer en minuscules).
    assert not re.search(r"SUPABASE_|RESEND_|SMTP|db:migrate", workflow)
    assert "scripts.information_agent_evaluation_trial" in workflow
    assert "actions/upload-artifact@" in workflow


def test_trial_workflow_uses_the_model_settings_of_the_evidence_worker() -> None:
    trial_workflow = (WORKFLOWS / "information-agent-evaluation-trial.yml").read_text("utf-8")
    worker_workflow = (WORKFLOWS / "information-agent-evidence.yml").read_text("utf-8")
    for name in ("LLM_PROVIDER", "REPLICATE_MODEL", "REPLICATE_MIN_INTERVAL_SECONDS", "REPLICATE_MAX_RETRIES"):
        assert _env_value(trial_workflow, name) == _env_value(worker_workflow, name), name
