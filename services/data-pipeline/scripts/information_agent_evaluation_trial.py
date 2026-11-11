"""Essai réel du modèle sur le jeu d'évaluation de la publication automatique (proposition 8). PAYANT.

Chaque cas passe par le vrai worker (``information_agent_evaluation.run_case``, base en mémoire) avec le
VRAI client Replicate du pipeline : même prompt, même version (``semantic_evidence_v3``), mêmes paramètres
que la lecture des réponses (``run_configured_semantic_analysis`` règle le plafond de sortie, un seul essai,
l'échéance). Seule la sortie brute du modèle est enregistrée, pièce par pièce, dans un fichier que le banc
rejoue (``model_outputs/<nom>.json``, puis ``python -m scripts.information_agent_evaluation --write``).

Garde-fous :

- plafond DUR de 5 USD (``HARD_CAP_USD``), cumulé sur tout le fichier (reprises comprises) : avant chaque
  appel, le coût maximal de l'appel est estimé (octets du prompt comme plafond des jetons d'entrée, plafond
  de jetons de sortie, tarif de ``pipeline_usage.TOKEN_PRICES`` majoré de 25 %) ; si le total dépasserait le
  plafond, l'essai s'arrête proprement sans faire l'appel. ``--budget-usd`` ne peut que l'abaisser ;
- l'estimation est inscrite dans le fichier AVANT l'appel : un arrêt brutal laisse un fichier exploitable,
  et l'appel interrompu compte comme payé ;
- reprise : une pièce déjà présente dans le fichier n'est jamais rappelée ;
- refus de toute clé Supabase et de tout identifiant de passage autonome : aucune écriture en base.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from scripts.information_agent_evaluation import (  # noqa: E402
    MODEL_OUTPUTS_FORMAT,
    asset_keys,
    load_cases,
    load_rules_stage,
    output_key,
    prompt_sha256,
    run_case,
)
from src.config import load_settings  # noqa: E402
from src.enrichment import llm_client  # noqa: E402
from src.information_agent_semantic import SEMANTIC_PROCESSOR_VERSION, SEMANTIC_SYSTEM_PROMPT  # noqa: E402
from src.pipeline_usage import TOKEN_PRICES  # noqa: E402

HARD_CAP_USD = Decimal("5")
PRICE_MARGIN = Decimal("1.25")
# Marge du gabarit de conversation du fournisseur, comme `reserve_prediction`.
TEMPLATE_TOKENS = 256


class BudgetExhausted(RuntimeError):
    """Le prochain appel ferait dépasser le plafond : il n'est pas fait."""


def budget_cap(requested: str | None) -> Decimal:
    """Plafond de l'essai : 5 USD au plus, jamais plus, quel que soit le paramètre."""
    if requested is None or requested == "":
        return HARD_CAP_USD
    value = Decimal(requested)
    if not value.is_finite() or value <= 0 or value > HARD_CAP_USD:
        raise SystemExit(f"--budget-usd doit être compris entre 0 (exclu) et {HARD_CAP_USD} USD")
    return value


def estimated_call_cost_usd(model: str, system_prompt: str, user_prompt: str, output_tokens: int) -> Decimal:
    """Coût maximal d'un appel : un octet compte comme un jeton (plafond prudent), tarif majoré de 25 %."""
    prices = TOKEN_PRICES.get(model)
    if prices is None:
        raise SystemExit(f"Modèle {model!r} sans tarif dans TOKEN_PRICES : coût non bornable, essai refusé")
    prompt = llm_client._user_prompt_for_model(model, system_prompt, user_prompt)
    input_tokens = len(prompt.encode("utf-8")) + len(system_prompt.encode("utf-8")) + TEMPLATE_TOKENS
    cost = (Decimal(input_tokens) * prices[0] + Decimal(output_tokens) * prices[1]) / Decimal(1_000_000)
    return (cost * PRICE_MARGIN).quantize(Decimal("0.000001"))


def refuse_production_credentials(environ: Mapping[str, str] | None = None) -> None:
    environ = os.environ if environ is None else environ
    forbidden = [
        name
        for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL", "PIPELINE_AUTONOMOUS_RUN_ID")
        if environ.get(name)
    ]
    if forbidden:
        raise SystemExit(f"Essai refusé : variables de production présentes ({', '.join(forbidden)})")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def load_outputs(path: Path, model: str) -> dict[str, Any]:
    if not path.is_file():
        return {
            "format": MODEL_OUTPUTS_FORMAT,
            "model": model,
            "semantic_processor_version": SEMANTIC_PROCESSOR_VERSION,
            "system_prompt_sha256": prompt_sha256(SEMANTIC_SYSTEM_PROMPT),
            "budget_usd": None,
            "estimated_spend_usd": "0",
            "stopped_reason": None,
            "started_at": _now(),
            "updated_at": _now(),
            "outputs": {},
        }
    outputs = json.loads(path.read_text("utf-8"))
    if outputs.get("format") != MODEL_OUTPUTS_FORMAT:
        raise SystemExit(f"{path} : format inconnu, reprise refusée")
    if outputs.get("model") != model or outputs.get("system_prompt_sha256") != prompt_sha256(SEMANTIC_SYSTEM_PROMPT):
        raise SystemExit(f"{path} : autre modèle ou autre prompt, reprise refusée")
    return outputs


def save_outputs(path: Path, outputs: Mapping[str, Any]) -> None:
    """Écriture atomique : un arrêt n'importe quand laisse un fichier lisible."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(outputs, ensure_ascii=False, indent=1, sort_keys=True) + "\n", "utf-8")
    temporary.replace(path)


class RecordingClient:
    """Enveloppe le vrai client : contrôle du plafond avant l'appel, enregistrement de la sortie brute."""

    def __init__(self, real: Any, outputs: dict[str, Any], save: Callable[[], None], cap: Decimal) -> None:
        self._real = real
        self._outputs = outputs
        self._save = save
        self._cap = cap
        self.case_id = ""
        self.asset_key = ""
        self.calls = 0
        # Le worker avale les erreurs du fournisseur (IA « indisponible ») : l'arrêt pour plafond est noté ici.
        self.exhausted: str | None = None

    # `run_configured_semantic_analysis` règle ces attributs sur le client : ils sont transmis au vrai client.
    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in {"fact_max_tokens", "max_retries"}:
            setattr(self._real, name, value)
        else:
            object.__setattr__(self, name, value)

    def generate_json(self, _system_prompt: str, _user_prompt: str) -> Mapping[str, object]:
        raise RuntimeError("le worker doit appeler generate_json_once (un seul essai)")

    def generate_json_once(self, system_prompt: str, user_prompt: str) -> Mapping[str, object]:
        key = output_key(self.case_id, self.asset_key)
        if key in self._outputs["outputs"]:
            raise RuntimeError(f"{key} : déjà enregistré, jamais rappelé")
        estimate = estimated_call_cost_usd(
            str(self._real.model), system_prompt, user_prompt, int(self._real.fact_max_tokens)
        )
        spent = Decimal(self._outputs["estimated_spend_usd"])
        if spent + estimate > self._cap:
            self._outputs["stopped_reason"] = "budget"
            self._save()
            self.exhausted = f"plafond de {self._cap} USD : {spent} USD engagés, appel suivant {estimate} USD"
            raise BudgetExhausted(self.exhausted)
        entry: dict[str, Any] = {
            "status": "in_flight",
            "estimated_cost_usd": str(estimate),
            "system_prompt_sha256": prompt_sha256(system_prompt),
            "user_prompt_sha256": prompt_sha256(user_prompt),
        }
        self._outputs["outputs"][key] = entry
        self._outputs["estimated_spend_usd"] = str(spent + estimate)
        self._save()
        self.calls += 1
        try:
            response = self._real.generate_json_once(system_prompt, user_prompt)
        except Exception as exc:
            entry.update(status="error", error=type(exc).__name__)
            self._save()
            raise
        entry.update(status="ok", response=response)
        self._save()
        return response


def run_trial(
    output: Path,
    cap: Decimal,
    *,
    client_factory: Callable[[], Any] | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Joue tous les cas pas encore enregistrés ; rend le fichier de sorties (aussi écrit sur le disque)."""
    real = (client_factory or llm_client.create_llm_client)()
    model = str(real.model or "")
    outputs = load_outputs(output, model)
    outputs["budget_usd"] = str(cap)
    outputs["stopped_reason"] = None

    def save() -> None:
        outputs["updated_at"] = _now()
        save_outputs(output, outputs)

    recorder = RecordingClient(real, outputs, save, cap)
    rules = load_rules_stage()
    for case in load_cases():
        entry = rules[case["id"]]
        keys = asset_keys(case, entry)
        if all(output_key(case["id"], key) in outputs["outputs"] for key in keys):
            continue

        def mark_skipped(key: str, case_id: str = case["id"]) -> None:
            if recorder.exhausted:
                # Pièce non lue faute de budget : rien n'est noté, la reprise la jouera.
                raise BudgetExhausted(recorder.exhausted)
            # Pièce lue sans appel (consigne adressée à un modèle repérée) : notée pour ne pas la rejouer.
            outputs["outputs"].setdefault(output_key(case_id, key), {"status": "not_called"})

        recorder.case_id = case["id"]
        try:
            run_case(case, entry, _ReplayThenRecord(recorder, outputs, case["id"]), after_asset=mark_skipped)
        except BudgetExhausted as exc:
            log(f"Arrêt propre : {exc}")
            break
        save()
    else:
        outputs["stopped_reason"] = "complete"
    save()
    log(
        f"{recorder.calls} appel(s) ; dépense estimée cumulée {outputs['estimated_spend_usd']} USD "
        f"(plafond {cap} USD) ; fin : {outputs['stopped_reason']}"
    )
    return outputs


class _ReplayThenRecord:
    """Client remis au worker pour un cas : pièce déjà enregistrée rejouée, sinon appel réel enregistré."""

    def __init__(self, recorder: RecordingClient, outputs: Mapping[str, Any], case_id: str) -> None:
        self._recorder = recorder
        self._outputs = outputs
        self._case_id = case_id
        self.asset_key = ""
        self.model = recorder.model
        self.fact_max_tokens = recorder.fact_max_tokens
        self.max_retries = 0

    def generate_json(self, _system_prompt: str, _user_prompt: str) -> Mapping[str, object]:
        raise RuntimeError("le worker doit appeler generate_json_once (un seul essai)")

    def generate_json_once(self, system_prompt: str, user_prompt: str) -> Mapping[str, object]:
        existing = self._outputs["outputs"].get(output_key(self._case_id, self.asset_key))
        if existing is not None:
            if existing.get("status") != "ok":
                raise RuntimeError("recorded provider failure")
            return existing["response"]
        # Les réglages du worker (plafond de sortie, un seul essai) passent au vrai client.
        self._recorder.fact_max_tokens = self.fact_max_tokens
        self._recorder.max_retries = self.max_retries
        self._recorder.asset_key = self.asset_key
        return self._recorder.generate_json_once(system_prompt, user_prompt)

    def __setattr__(self, name: str, value: Any) -> None:
        object.__setattr__(self, name, value)


def estimate_full_run_usd(model: str, output_tokens: int) -> tuple[int, Decimal]:
    """Nombre d'appels et coût maximal estimé de l'essai complet, sans appel (pour le guide et les tests)."""
    from src.information_agent_semantic import build_semantic_user_prompt, contains_prompt_injection
    from src.normalize import clean_text

    calls = 0
    total = Decimal(0)
    rules = load_rules_stage()
    for case in load_cases():
        entry = rules[case["id"]]
        for key in asset_keys(case, entry):
            text = (
                entry["body_evidence_text"]
                if key == "corps"
                else next(item["texte"] for item in case["message"]["pieces_jointes"] if item["nom"] == key)
            )
            pages = [{"page": 1, "text": clean_text(text) or ""}]
            if contains_prompt_injection(pages[0]["text"]):
                continue
            user_prompt, _ = build_semantic_user_prompt(pages)
            calls += 1
            total += estimated_call_cost_usd(model, SEMANTIC_SYSTEM_PROMPT, user_prompt, output_tokens)
    return calls, total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Essai réel du modèle sur le jeu d'évaluation (payant).")
    parser.add_argument("--output", required=True, type=Path, help="fichier des sorties (créé ou repris)")
    parser.add_argument("--budget-usd", default=None, help=f"plafond en USD, {HARD_CAP_USD} au plus")
    parser.add_argument("--estimate-only", action="store_true", help="affiche le coût maximal estimé, sans appel")
    args = parser.parse_args(argv)
    cap = budget_cap(args.budget_usd)
    if args.estimate_only:
        model = str(load_settings()["replicate_model"])
        calls, total = estimate_full_run_usd(model, 1_024)
        print(f"{calls} appels au plus, coût maximal estimé {total} USD (plafond {cap} USD)")
        return 0
    refuse_production_credentials()
    settings = load_settings()
    if settings.get("llm_provider") != "replicate" or not settings.get("replicate_api_token"):
        raise SystemExit("Essai refusé : LLM_PROVIDER=replicate et REPLICATE_API_TOKEN sont requis")
    outputs = run_trial(args.output, cap)
    return 0 if outputs["stopped_reason"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
