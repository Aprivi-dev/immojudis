"""Banc d'évaluation de la publication automatique : jeu de données, étape Python à jour, essai réel (faux
client, aucun appel payant), workflow de l'essai."""

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
OPTIONAL_CASE_KEYS = {"decision_proprietaire"}
REQUIRED_CONTEXT_KEYS = {
    "type_de_bien",
    "quality_flags",
    "lot_vendu",
    "fiche",
    "destinataire",
    "expediteur_est_destinataire",
    "authentification",
    "delai_jours",
    "messages_anterieurs",
    "messages_posterieurs",
}
EMAIL_RE = re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+")


def test_dataset_has_215_cases_with_unique_ids_and_required_fields() -> None:
    cases = bench.load_cases()
    assert len(cases) == 215
    assert {family: sum(case["famille"] == family for case in cases) for family in range(1, 10)} == bench.CASES_PER_FAMILY
    assert len({case["id"] for case in cases}) == 215
    for case in cases:
        assert REQUIRED_CASE_KEYS <= set(case) <= REQUIRED_CASE_KEYS | OPTIONAL_CASE_KEYS, case["id"]
        assert set(case["contexte"]) == REQUIRED_CONTEXT_KEYS, case["id"]
        assert set(case["verite"]) == set(bench.ELIGIBLE_FIELDS), case["id"]
        for field, truth in case["verite"].items():
            if truth["publiable"]:
                assert truth["valeur"] > 0, (case["id"], field)
            else:
                assert len(truth["raison"]) >= 10 and "lecture_modele" in truth, (case["id"], field)


def test_dataset_only_uses_example_addresses() -> None:
    for name in bench.FAMILY_FILES:
        text = (bench.CASES_DIR / name).read_text("utf-8")
        assert [address for address in EMAIL_RE.findall(text) if not address.endswith(".example")] == [], name


@pytest.mark.parametrize("configuration", list(bench.SIMULATED))
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


def test_follower_confirms_every_rules_value_it_can_cite() -> None:
    """Le suiveur confirme une valeur des règles (accord de l'IA), jamais une valeur absente des règles."""
    stage = json.loads(bench.stage_path("suiveur").read_text("utf-8"))
    agreed = sum(
        1
        for entry in stage["cas"].values()
        for row in entry["candidates"]
        if (row.get("metadata") or {}).get("semantic_agreement") is True
    )
    assert agreed >= 80
    # Le suiveur ne propose rien que les règles n'aient lu : aucune ligne de l'IA seule sur un champ éligible
    # sans motif de relecture.
    lone = [
        (case_id, row["fact_key"])
        for case_id, entry in stage["cas"].items()
        for row in entry["candidates"]
        if row["fact_key"] in bench.ELIGIBLE_FIELDS
        and row["evidence_asset_id"]
        and "-asset-pj-" not in row["evidence_asset_id"]
        and (row.get("metadata") or {}).get("processor_version") == "evidence_v1"
        and "rules_only_attachment" not in ((row.get("metadata") or {}).get("review_reasons") or [])
    ]
    assert lone == []


def test_ideal_citation_is_the_whole_sentence() -> None:
    text = "Bonjour,\nsuite a votre demande : surface habitable 71m2, 3 pieces au total.\ncdlt"
    assert bench.full_sentence(text, "surface habitable 71m2") == "suite a votre demande : surface habitable 71m2, 3 pieces au total"
    assert bench.full_sentence("Le terrain fait 1.250 m². Fin.", "1.250 m²") == "Le terrain fait 1.250 m²"


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


def test_trial_completeness_counts_missing_failed_and_uncalled_pieces() -> None:
    cases = bench.load_cases()[:3]
    rules = bench.load_rules_stage()
    keys = [bench.output_key(case["id"], key) for case in cases for key in bench.asset_keys(case, rules[case["id"]])]
    outputs = {"outputs": {keys[0]: {"status": "error"}, keys[1]: {"status": "in_flight"}}}
    report = bench.trial_completeness(outputs, cases, rules)
    assert report["cas_non_joues"]
    outputs = {"outputs": {key: {"status": "ok"} for key in keys}}
    outputs["outputs"][keys[0]] = {"status": "error"}
    outputs["outputs"][keys[1]] = {"status": "not_called"}
    report = bench.trial_completeness(outputs, cases, rules)
    assert report["pieces_en_erreur"] == [keys[0]]
    assert report["pieces_non_appelees_autres"] == [keys[1]]
    assert report["cas_non_joues"] == []


def test_budget_cap_cannot_be_raised_above_five_dollars() -> None:
    assert trial.budget_cap(None) == Decimal("5")
    assert trial.budget_cap("2.5") == Decimal("2.5")
    for value in ("5.01", "50", "0", "-1", "NaN", "Infinity"):
        with pytest.raises(SystemExit):
            trial.budget_cap(value)


def test_full_trial_estimate_stays_under_the_cap() -> None:
    calls, total = trial.estimate_full_run_usd("qwen/qwen3-7-plus", 1_024)
    assert 150 <= calls <= 260
    assert Decimal("0") < total < trial.HARD_CAP_USD


def test_trial_refuses_production_credentials() -> None:
    with pytest.raises(SystemExit, match="SUPABASE_SERVICE_ROLE_KEY"):
        trial.refuse_production_credentials({"SUPABASE_SERVICE_ROLE_KEY": "x"})
    trial.refuse_production_credentials({"REPLICATE_API_TOKEN": "x"})


class FakeReplicate:
    """Faux client du modèle : passe par `_wait_for_output` comme le vrai, avec des compteurs de jetons."""

    model = "qwen/qwen3-7-plus"

    def __init__(self, *, output_tokens: int = 40, input_tokens: int = 900, fail_first: int = 0, invalid_json: bool = False) -> None:
        self.calls = 0
        self.fact_max_tokens = 4_096
        self.max_retries = 2
        self.output_tokens = output_tokens
        self.input_tokens = input_tokens
        self.fail_first = fail_first
        self.invalid_json = invalid_json

    def _wait_for_output(self, prediction: dict) -> object:
        return prediction["output"]

    def generate_json(self, _system: str, _user: str) -> dict:
        raise AssertionError("one attempt only")

    def generate_json_once(self, _system: str, _user: str) -> dict:
        self.calls += 1
        output = "pas du JSON" if self.invalid_json else '{"facts": []}'
        prediction = {
            "id": f"prediction-{self.calls}",
            "version": "fixture-version",
            "status": "succeeded",
            "output": output,
            "metrics": {"input_token_count": self.input_tokens, "output_token_count": self.output_tokens, "predict_time": 1.5},
        }
        self._wait_for_output(prediction)
        if self.calls <= self.fail_first or self.invalid_json:
            raise ValueError("Replicate returned invalid JSON without retry")
        return {"facts": []}


def _quiet(_line: str) -> None:
    return None


def test_trial_stops_before_the_call_that_would_exceed_the_cap_and_resumes_without_paying_twice(tmp_path: Path) -> None:
    output = tmp_path / "essai.json"
    client = FakeReplicate()
    small_cap = Decimal("0.01")
    first = trial.run_trial(output, small_cap, client_factory=lambda: client, log=_quiet)
    assert first["stopped_reason"] == "budget"
    assert Decimal(first["spend_usd"]) <= small_cap
    assert 0 < client.calls < 20
    saved = json.loads(output.read_text("utf-8"))
    assert sum(entry["status"] == "ok" for entry in saved["outputs"].values()) == client.calls
    first_attempt = next(entry for entry in saved["outputs"].values() if entry.get("attempts"))["attempts"][0]
    assert first_attempt["input_tokens"] == 900 and first_attempt["output_tokens"] == 40
    assert first_attempt["prediction_id"] and first_attempt["model_version"] == "fixture-version"
    # Le worker a reçu le plafond de sortie et l'essai unique de la lecture des réponses.
    assert client.fact_max_tokens == 1_024 and client.max_retries == 0

    calls_before = client.calls
    trial.run_trial(output, Decimal("0.02"), client_factory=lambda: client, log=_quiet)
    resumed = json.loads(output.read_text("utf-8"))
    assert client.calls > calls_before
    assert sum(entry["status"] == "ok" for entry in resumed["outputs"].values()) == client.calls
    assert Decimal(resumed["spend_usd"]) <= Decimal("0.02")


def test_trial_charges_the_real_cost_when_it_exceeds_the_estimate_and_stops(tmp_path: Path) -> None:
    output = tmp_path / "essai.json"
    # Raisonnement facturé au-delà du plafond de sortie : 200 000 jetons de sortie par appel.
    client = FakeReplicate(output_tokens=200_000)
    result = trial.run_trial(output, Decimal("0.5"), client_factory=lambda: client, log=_quiet)
    assert result["stopped_reason"] == "budget"
    assert client.calls == 3
    attempt = next(iter(result["outputs"].values()))["attempts"][0]
    assert Decimal(attempt["charged_usd"]) == Decimal(attempt["real_usd"]) > Decimal(attempt["estimated_usd"])
    assert result["resume"]["sortie_au_dela_du_plafond"]


def test_pilot_stops_after_n_calls_with_a_readable_summary(tmp_path: Path) -> None:
    output = tmp_path / "essai.json"
    client = FakeReplicate()
    result = trial.run_trial(output, Decimal("1"), max_calls=5, client_factory=lambda: client, log=_quiet)
    assert client.calls == 5
    assert result["stopped_reason"] == "pilote"
    assert result["resume"]["appels"] == 5 and result["resume"]["appels_avec_compteurs"] == 5
    assert result["resume"]["sortie_au_dela_du_plafond"] == []


def test_failed_piece_is_replayed_on_resume_and_each_attempt_is_charged(tmp_path: Path) -> None:
    output = tmp_path / "essai.json"
    client = FakeReplicate(fail_first=1)
    trial.run_trial(output, Decimal("1"), max_calls=2, client_factory=lambda: client, log=_quiet)
    saved = json.loads(output.read_text("utf-8"))
    failed = [key for key, entry in saved["outputs"].items() if entry["status"] == "error"]
    assert len(failed) == 1
    trial.run_trial(output, Decimal("1"), max_calls=1, client_factory=lambda: client, log=_quiet)
    resumed = json.loads(output.read_text("utf-8"))
    entry = resumed["outputs"][failed[0]]
    assert entry["status"] == "ok" and len(entry["attempts"]) == 2
    assert Decimal(resumed["spend_usd"]) == sum(
        Decimal(attempt["charged_usd"]) for item in resumed["outputs"].values() for attempt in item.get("attempts", [])
    )


def test_invalid_json_keeps_the_raw_output(tmp_path: Path) -> None:
    output = tmp_path / "essai.json"
    client = FakeReplicate(invalid_json=True)
    result = trial.run_trial(output, Decimal("1"), max_calls=1, client_factory=lambda: client, log=_quiet)
    entry = next(entry for entry in result["outputs"].values() if entry.get("attempts"))
    assert entry["status"] == "error"
    assert entry["attempts"][0]["raw_output"] == "pas du JSON"


def test_trial_output_is_replayed_by_the_bench_and_an_incomplete_trial_is_flagged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = tmp_path / "essai.json"
    client = FakeReplicate()
    trial.run_trial(output, Decimal("0.05"), client_factory=lambda: client, log=_quiet)
    monkeypatch.setattr(bench, "MODEL_OUTPUTS_DIR", tmp_path)
    stage = bench.build_worker_stage("enregistrement_essai")
    assert stage["modele_reel"] is True
    played = [case_id for case_id, entry in stage["cas"].items() if "missing" not in entry]
    assert played and len(played) < 215
    assert stage["essai"]["cas_non_joues"]


WORKFLOWS = bench.PIPELINE_ROOT.parents[1] / ".github" / "workflows"


def _env(text: str) -> dict[str, str]:
    job_env = text.split("\n    env:\n", 1)[1].split("\n    steps:", 1)[0]
    return {
        match.group(1): match.group(2).strip('"')
        for match in re.finditer(r"^      ([A-Z][A-Z0-9_]+):\s*(.+?)\s*$", job_env, re.MULTILINE)
    }


def test_trial_workflow_is_manual_main_only_first_attempt_confirmed_and_without_database_access() -> None:
    workflow = (WORKFLOWS / "information-agent-evaluation-trial.yml").read_text("utf-8")
    on_block = workflow.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
    assert re.findall(r"^  (\w+):", on_block, re.MULTILINE) == ["workflow_dispatch"]
    assert "if: github.ref == 'refs/heads/main' && github.run_attempt == 1" in workflow
    assert 'if [ "$CONFIRMATION" != "ESSAI PAYANT 5 USD" ]' in workflow
    assert "group: immojudis-information-agent-evaluation-trial" in workflow
    assert re.findall(r"secrets\.(\w+)", workflow) == ["REPLICATE_API_TOKEN"]
    # Ni variable Supabase, ni d'envoi d'email (le commentaire d'en-tête peut les nommer en minuscules).
    assert not re.search(r"SUPABASE_|RESEND_|SMTP|db:migrate", workflow)
    budget = on_block.split("budget_usd:", 1)[1].split("type:", 1)[0]
    assert 'default: "1"' in budget
    pilot = on_block.split("appels_max:", 1)[1].split("type:", 1)[0]
    assert 'default: "5"' in pilot
    assert "--max-calls" in workflow
    assert "actions/upload-artifact@" in workflow


def test_trial_workflow_uses_the_model_settings_of_the_evidence_worker() -> None:
    trial_env = _env((WORKFLOWS / "information-agent-evaluation-trial.yml").read_text("utf-8"))
    worker_env = _env((WORKFLOWS / "information-agent-evidence.yml").read_text("utf-8"))
    shared = {name for name in worker_env if name.startswith(("REPLICATE_", "LLM_"))}
    assert shared >= {"LLM_PROVIDER", "REPLICATE_MODEL", "REPLICATE_MAX_RETRIES"}
    for name in sorted(shared):
        assert trial_env.get(name) == worker_env[name], name
