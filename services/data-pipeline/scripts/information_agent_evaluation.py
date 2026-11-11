"""Banc d'évaluation hors ligne de la publication automatique : étape Python (worker de lecture des pièces).

Le banc fait passer chacune des 200 réponses fictives du jeu
(``tests/fixtures/information_agent_evaluation/cases/``) par la VRAIE chaîne, en trois étapes :

1. règles TypeScript (test Vitest ``src/lib/information-agent/evaluation/evaluation.test.ts``) : elles
   écrivent ``stages/rules_stage.json`` (texte de la pièce « corps du message » et candidats des règles) ;
2. ce module : pour chaque cas, le vrai ``information_agent_evidence._process_job`` lit le corps puis chaque
   pièce jointe, avec une base Supabase simulée en mémoire (``httpx.MockTransport``) et un client de modèle
   de remplacement ; la table des candidats qui en sort est écrite dans ``stages/worker_stage.<config>.json`` ;
3. moteur de décision (même test Vitest) : la vraie passe de simulation lit ces candidats et décide.

Configurations (aucune n'appelle un modèle) :

- ``regles_seules`` : lecture par l'IA désactivée, donc aucun accord de l'IA ; rien ne doit être publiable ;
- ``modele_ideal`` : sortie de modèle SIMULÉE, égale à la vérité de terrain (borne haute de la couverture) ;
- ``enregistrement_<nom>`` : sortie RÉELLE du modèle, enregistrée par ``information_agent_evaluation_trial``
  dans ``model_outputs/<nom>.json`` et rejouée ici à l'identique.

Usage : ``python -m scripts.information_agent_evaluation`` vérifie que les fichiers sont à jour (code 1
sinon) ; ``--write`` les réécrit.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import sys
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import httpx

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src import information_agent_evidence as evidence  # noqa: E402
from src.enrichment import llm_client  # noqa: E402
from src.information_agent_semantic import SEMANTIC_PROCESSOR_VERSION, SEMANTIC_SYSTEM_PROMPT  # noqa: E402

FIXTURE_ROOT = PIPELINE_ROOT / "tests" / "fixtures" / "information_agent_evaluation"
CASES_DIR = FIXTURE_ROOT / "cases"
STAGES_DIR = FIXTURE_ROOT / "stages"
MODEL_OUTPUTS_DIR = FIXTURE_ROOT / "model_outputs"
RULES_STAGE_FILE = STAGES_DIR / "rules_stage.json"
WORKER_STAGE_FORMAT = "information_agent_evaluation_worker_stage_v1"
MODEL_OUTPUTS_FORMAT = "information_agent_evaluation_model_outputs_v1"
FAMILY_FILES = (
    "famille_1_nettes.json",
    "famille_2_reserves.json",
    "famille_3_lots.json",
    "famille_4_corrections.json",
    "famille_5_confusions.json",
    "famille_6_ne_pas_publier.json",
    "famille_7_manipulation.json",
    "famille_8_tiers.json",
)
ELIGIBLE_FIELDS = ("surface_m2", "land_surface_m2", "rooms_count")
BODY_ASSET = "corps"
BASE_URL = "https://evaluation.invalid"
SIMULATED_DESCRIPTIONS = {
    "regles_seules": (
        "SIMULATION, aucune sortie de modèle : lecture par l'IA désactivée, donc aucun accord de l'IA "
        "(test de fermeture : rien ne doit être publiable)."
    ),
    "modele_ideal": (
        "SIMULATION, aucune sortie réelle du modèle : sortie simulée égale à la vérité de terrain "
        "(borne haute de la couverture, pas un résultat du modèle)."
    ),
}


class EvaluationHarnessError(RuntimeError):
    """Le worker a fait autre chose que ce que le banc sait simuler : le banc s'arrête au lieu de deviner."""


def load_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for name in FAMILY_FILES:
        payload = json.loads((CASES_DIR / name).read_text("utf-8"))
        cases.extend(payload["cas"])
    return cases


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_rules_stage() -> dict[str, Any]:
    payload = json.loads(RULES_STAGE_FILE.read_text("utf-8"))
    return payload["cas"]


def asset_keys(case: Mapping[str, Any], rules_entry: Mapping[str, Any]) -> list[str]:
    """Pièces lues par le worker, dans l'ordre : le corps (s'il a une pièce), puis les pièces jointes."""
    keys = [BODY_ASSET] if rules_entry.get("body_evidence_text") else []
    return keys + [str(attachment["nom"]) for attachment in case["message"]["pieces_jointes"]]


def _ids(case: Mapping[str, Any]) -> dict[str, str]:
    case_id = str(case["id"])
    return {
        "sale": f"{case_id}-sale",
        "case": f"{case_id}-case",
        "message": f"{case_id}-message",
        "body_asset": f"{case_id}-asset-body",
    }


def _asset_id(case: Mapping[str, Any], key: str) -> str:
    if key == BODY_ASSET:
        return _ids(case)["body_asset"]
    names = [str(attachment["nom"]) for attachment in case["message"]["pieces_jointes"]]
    return f"{case['id']}-asset-pj-{names.index(key) + 1}"


def _asset_content(case: Mapping[str, Any], rules_entry: Mapping[str, Any], key: str) -> bytes:
    if key == BODY_ASSET:
        return str(rules_entry["body_evidence_text"]).encode("utf-8")
    attachment = next(item for item in case["message"]["pieces_jointes"] if item["nom"] == key)
    return str(attachment["texte"]).encode("utf-8")


class FakeSupabase:
    """Base Supabase en mémoire pour UN cas : seules les requêtes que fait le worker sont servies."""

    def __init__(self, case: Mapping[str, Any], rules_entry: Mapping[str, Any]) -> None:
        self.case = case
        self.ids = _ids(case)
        context = case["contexte"]
        lot = context["lot_vendu"]
        self.sale = {
            **context["fiche"],
            "property_type": context["type_de_bien"],
            "occupancy_status": None,
            "sale_date": None,
            "starting_price_eur": None,
            "address": None,
            "quality_flags": context["quality_flags"],
            "source_lot_selection": {"status": "selected", **lot} if lot else None,
        }
        self.candidates: list[dict[str, Any]] = [dict(row) for row in rules_entry["candidates"]]
        self.assets: dict[str, tuple[dict[str, Any], bytes]] = {}
        for key in asset_keys(case, rules_entry):
            content = _asset_content(case, rules_entry, key)
            asset_id = _asset_id(case, key)
            name = "email-body.txt" if key == BODY_ASSET else key
            self.assets[asset_id] = (
                {
                    "id": asset_id,
                    "case_id": self.ids["case"],
                    "message_id": self.ids["message"],
                    "sale_id": self.ids["sale"],
                    "storage_bucket": "information-agent-evidence",
                    "storage_path": f"{self.ids['case']}/{self.ids['message']}/{asset_id}/{name}",
                    "original_filename": name,
                    "mime_type": "text/plain",
                    "size_bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "metadata": {"evidence_kind": "email_body"} if key == BODY_ASSET else {},
                },
                content,
            )
        self.extractions: list[dict[str, Any]] = []
        self.unexpected: list[str] = []
        self._inserted = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = unquote(request.url.path)
        params = dict(request.url.params)
        method = request.method
        if method == "GET" and path.endswith("/rest/v1/information_agent_evidence_assets"):
            asset = self.assets.get(params.get("id", "").removeprefix("eq."))
            return httpx.Response(200, json=[asset[0]] if asset else [])
        if method == "GET" and path.startswith("/storage/v1/object/information-agent-evidence/"):
            storage_path = path.removeprefix("/storage/v1/object/information-agent-evidence/")
            for row, content in self.assets.values():
                if row["storage_path"] == storage_path:
                    return httpx.Response(200, content=content)
        if method == "GET" and path.endswith("/rest/v1/information_agent_cases"):
            # La réception a déjà mis le dossier en relecture (réponse avec un corps).
            return httpx.Response(200, json=[{"status": "review"}])
        if method == "GET" and path.endswith("/rest/v1/auction_sales"):
            return httpx.Response(200, json=[self.sale])
        if method == "GET" and path.endswith("/rest/v1/information_agent_fact_candidates"):
            return self._existing_body_rows(params)
        if method == "POST" and path.endswith("/rest/v1/information_agent_fact_candidates"):
            return self._insert(json.loads(request.content), params)
        if method == "PATCH" and path.endswith("/rest/v1/information_agent_fact_candidates"):
            return self._patch(json.loads(request.content), params)
        if method == "PATCH" and path.endswith("/rest/v1/information_agent_evidence_extractions"):
            self.extractions.append(json.loads(request.content))
            return httpx.Response(204)
        if method == "PATCH" and path.endswith("/rest/v1/information_agent_cases"):
            return httpx.Response(204)
        self.unexpected.append(f"{method} {path}")
        return httpx.Response(500, json={"message": "unexpected request in evaluation harness"})

    def _existing_body_rows(self, params: Mapping[str, str]) -> httpx.Response:
        if params.get("message_id") != f"eq.{self.ids['message']}" or params.get("evidence_asset_id") != "is.null":
            self.unexpected.append(f"GET information_agent_fact_candidates {sorted(params.items())}")
            return httpx.Response(500)
        return httpx.Response(200, json=[row for row in self.candidates if row.get("evidence_asset_id") is None])

    def _insert(self, rows: list[dict[str, Any]], params: Mapping[str, str]) -> httpx.Response:
        columns = ("message_id", "fact_key", "evidence_asset_id", "source_page", "display_value")
        if params.get("on_conflict") != ",".join(columns):
            self.unexpected.append("POST information_agent_fact_candidates without the expected conflict key")
            return httpx.Response(500)
        for row in rows:
            if row.get("message_id") != self.ids["message"] or row.get("sale_id") != self.ids["sale"]:
                self.unexpected.append("POST information_agent_fact_candidates for another message")
                return httpx.Response(500)
            key = tuple(row.get(column) for column in columns)
            if any(
                tuple({**existing, "message_id": self.ids["message"]}.get(column) for column in columns) == key
                for existing in self.candidates
            ):
                continue
            self._inserted += 1
            self.candidates.append(
                {
                    "id": f"{self.case['id']}-py-{self._inserted:03d}",
                    "fact_key": row["fact_key"],
                    "proposed_value": row["proposed_value"],
                    "display_value": row.get("display_value"),
                    "status": row["status"],
                    "evidence_asset_id": row.get("evidence_asset_id"),
                    "source_page": row.get("source_page"),
                    "metadata": row.get("metadata"),
                }
            )
        return httpx.Response(201)

    def _patch(self, body: Mapping[str, Any], params: Mapping[str, str]) -> httpx.Response:
        candidate_id = params.get("id", "").removeprefix("eq.")
        allowed = params.get("status", "").removeprefix("in.(").removesuffix(")").split(",")
        if set(body) != {"metadata"}:
            self.unexpected.append("PATCH information_agent_fact_candidates outside metadata")
            return httpx.Response(500)
        for row in self.candidates:
            if row["id"] == candidate_id and row["status"] in allowed:
                row["metadata"] = body["metadata"]
        return httpx.Response(204)


@contextlib.contextmanager
def _patched(target: object, name: str, value: object) -> Iterator[None]:
    original = getattr(target, name)
    setattr(target, name, value)
    try:
        yield
    finally:
        setattr(target, name, original)


@contextlib.contextmanager
def _environment(name: str, value: str) -> Iterator[None]:
    original = os.environ.get(name)
    os.environ[name] = value
    try:
        yield
    finally:
        if original is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = original


class StubModelClient:
    """Client de remplacement du worker : ``respond(clé de la pièce, système, utilisateur)`` rend la sortie."""

    model = "evaluation-stub"
    fact_max_tokens = 1_024
    max_retries = 0

    def __init__(self, respond: Callable[[str, str, str], Mapping[str, object]]) -> None:
        self._respond = respond
        self.asset_key = ""
        # Le worker traite toute exception du client comme une IA indisponible : une erreur du banc est
        # gardée ici et relevée par `run_case`, jamais avalée.
        self.harness_error: str | None = None

    def generate_json(self, _system_prompt: str, _user_prompt: str) -> Mapping[str, object]:
        self.harness_error = "le worker doit appeler generate_json_once (un seul essai)"
        raise EvaluationHarnessError(self.harness_error)

    def generate_json_once(self, system_prompt: str, user_prompt: str) -> Mapping[str, object]:
        try:
            return self._respond(self.asset_key, system_prompt, user_prompt)
        except EvaluationHarnessError as exc:
            self.harness_error = str(exc)
            raise


def run_case(
    case: Mapping[str, Any],
    rules_entry: Mapping[str, Any],
    client: Any | None,
    *,
    after_asset: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Fait lire chaque pièce du cas par le vrai worker ; rend la table des candidats et l'état de l'IA.

    ``client`` : ``None`` désactive la lecture par l'IA (règles seules) ; sinon il remplace le client
    Replicate (``create_llm_client``) et reçoit la clé de la pièce lue dans ``asset_key``.
    """
    fake = FakeSupabase(case, rules_entry)
    semantic: list[dict[str, Any]] = []
    settings = {
        "information_agent_evidence_ocr_enabled": False,
        "information_agent_evidence_semantic_enabled": client is not None,
    }

    def no_client() -> Any:
        raise EvaluationHarnessError("règles seules : le client du modèle ne doit pas être créé")

    with (
        _environment("INFORMATION_AGENT_EVIDENCE_SEMANTIC_ENABLED", "true" if client is not None else "false"),
        _patched(evidence, "load_settings", lambda: settings),
        _patched(llm_client, "create_llm_client", (lambda: client) if client is not None else no_client),
        httpx.Client(transport=httpx.MockTransport(fake.handle)) as http,
    ):
        for index, key in enumerate(asset_keys(case, rules_entry)):
            if client is not None:
                client.asset_key = key
            job = {
                "id": f"{case['id']}-extraction-{index + 1}",
                "asset_id": _asset_id(case, key),
                "case_id": fake.ids["case"],
                "message_id": fake.ids["message"],
                "sale_id": fake.ids["sale"],
                "attempts": 1,
            }
            before = len(fake.extractions)
            evidence._process_job(http, BASE_URL, "evaluation-key", job)
            finished = fake.extractions[before:]
            harness_error = getattr(client, "harness_error", None)
            if harness_error:
                raise EvaluationHarnessError(harness_error)
            if fake.unexpected or len(finished) != 1 or finished[0].get("status") != "completed":
                detail = fake.unexpected or [str(item.get("error_message") or item.get("status")) for item in finished]
                raise EvaluationHarnessError(f"{case['id']} / {key} : {detail}")
            semantic_meta = finished[0]["metadata"]["semantic"]
            semantic.append(
                {
                    "asset": key,
                    "status": semantic_meta.get("status"),
                    "error_code": semantic_meta.get("error_code"),
                }
            )
            if after_asset is not None:
                after_asset(key)
    candidates = sorted(fake.candidates, key=lambda row: str(row["id"]))
    return {"candidates": candidates, "semantic": semantic}


def ideal_response(case: Mapping[str, Any]) -> Callable[[str, str, str], Mapping[str, object]]:
    """Sortie simulée d'un modèle exact : la vérité de terrain, citations comprises, pièce par pièce."""

    def respond(asset_key: str, _system_prompt: str, _user_prompt: str) -> Mapping[str, object]:
        facts: list[dict[str, object]] = []
        for field in ELIGIBLE_FIELDS:
            truth = case["verite"][field]
            reading = (
                {"valeur": truth["valeur"], "citation": truth["citation"], "source": BODY_ASSET}
                if truth["publiable"]
                else truth["lecture_modele"]
            )
            if not reading or reading["source"] != asset_key:
                continue
            facts.append(
                {
                    "fact_key": field,
                    "proposed_value": {"value": reading["valeur"]},
                    "display_value": str(reading["valeur"]),
                    "evidence_excerpt": reading["citation"],
                    "source_page": 1,
                    "confidence": 0.95,
                }
            )
        return {"facts": facts}

    return respond


def prompt_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def output_key(case_id: str, asset_key: str) -> str:
    return f"{case_id}/{asset_key}"


class RecordedResponse:
    """Rejoue une sortie réelle enregistrée ; refuse une entrée enregistrée sur un autre texte ou prompt."""

    def __init__(self, outputs: Mapping[str, Any], case_id: str) -> None:
        self.entries: Mapping[str, Any] = outputs["outputs"]
        self.case_id = case_id

    def __call__(self, asset_key: str, system_prompt: str, user_prompt: str) -> Mapping[str, object]:
        entry = self.entries.get(output_key(self.case_id, asset_key))
        if entry is None:
            raise EvaluationHarnessError(f"{self.case_id} / {asset_key} : aucune sortie enregistrée")
        if (
            entry.get("system_prompt_sha256") != prompt_sha256(system_prompt)
            or entry.get("user_prompt_sha256") != prompt_sha256(user_prompt)
        ):
            raise EvaluationHarnessError(
                f"{self.case_id} / {asset_key} : sortie enregistrée sur un autre prompt ou un autre texte"
            )
        if entry.get("status") != "ok":
            # Échec du fournisseur pendant l'essai : le worker le traite comme une IA indisponible.
            raise RuntimeError(f"recorded provider failure: {entry.get('error')}")
        return entry["response"]


def recorded_case_complete(outputs: Mapping[str, Any], case: Mapping[str, Any], rules_entry: Mapping[str, Any]) -> bool:
    """Toutes les pièces du cas ont une sortie (ou ont été écartées sans appel par le worker)."""
    entries = outputs["outputs"]
    return all(output_key(str(case["id"]), key) in entries for key in asset_keys(case, rules_entry))


def build_worker_stage(configuration: str) -> dict[str, Any]:
    """Table des candidats de chaque cas pour une configuration (règles seules, modèle idéal, enregistrement)."""
    cases = load_cases()
    rules = load_rules_stage()
    outputs: dict[str, Any] | None = None
    source: str | None = None
    if configuration.startswith("enregistrement_"):
        source_path = MODEL_OUTPUTS_DIR / f"{configuration.removeprefix('enregistrement_')}.json"
        outputs = json.loads(source_path.read_text("utf-8"))
        if outputs.get("format") != MODEL_OUTPUTS_FORMAT:
            raise EvaluationHarnessError(f"{source_path.name} : format inconnu")
        source = f"model_outputs/{source_path.name}"
    elif configuration not in SIMULATED_DESCRIPTIONS:
        raise EvaluationHarnessError(f"configuration inconnue : {configuration}")
    stage_cases: dict[str, Any] = {}
    for case in cases:
        rules_entry = rules[case["id"]]
        if configuration == "regles_seules":
            stage_cases[case["id"]] = run_case(case, rules_entry, None)
            continue
        if outputs is not None:
            if not recorded_case_complete(outputs, case, rules_entry):
                stage_cases[case["id"]] = {"missing": True}
                continue
            respond: Callable[[str, str, str], Mapping[str, object]] = RecordedResponse(outputs, case["id"])
        else:
            respond = ideal_response(case)
        stage_cases[case["id"]] = run_case(case, rules_entry, StubModelClient(respond))
    return {
        "format": WORKER_STAGE_FORMAT,
        "configuration": configuration,
        "modele_reel": outputs is not None,
        "description": (
            f"Sortie RÉELLE du modèle {outputs.get('model')} enregistrée par l'essai ({source})."
            if outputs is not None
            else SIMULATED_DESCRIPTIONS[configuration]
        ),
        "source": source,
        "semantic_processor_version": SEMANTIC_PROCESSOR_VERSION,
        "system_prompt_sha256": prompt_sha256(SEMANTIC_SYSTEM_PROMPT),
        "rules_stage_sha256": file_sha256(RULES_STAGE_FILE),
        "cas": stage_cases,
    }


def configurations() -> list[str]:
    recorded = sorted(path.stem for path in MODEL_OUTPUTS_DIR.glob("*.json")) if MODEL_OUTPUTS_DIR.is_dir() else []
    return ["regles_seules", "modele_ideal", *(f"enregistrement_{name}" for name in recorded)]


def stage_path(configuration: str) -> Path:
    return STAGES_DIR / f"worker_stage.{configuration}.json"


def serialize(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help="réécrit les fichiers de l'étape Python")
    args = parser.parse_args(argv)
    stale: list[str] = []
    for configuration in configurations():
        content = serialize(build_worker_stage(configuration))
        path = stage_path(configuration)
        if args.write:
            path.write_text(content, "utf-8")
            print(f"écrit : {path.relative_to(PIPELINE_ROOT)}")
        elif not path.is_file() or path.read_text("utf-8") != content:
            stale.append(str(path.relative_to(PIPELINE_ROOT)))
    if stale:
        print("Fichiers de l'étape Python périmés (relancer avec --write) :", *stale, sep="\n  ")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
