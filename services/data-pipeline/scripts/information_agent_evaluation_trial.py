"""Essai réel du modèle sur le jeu d'évaluation de la publication automatique (proposition 8). PAYANT.

Chaque dossier passe par le vrai worker (``information_agent_evaluation.run_case``, base en mémoire) avec le
VRAI client Replicate du pipeline : même prompt, même version (``semantic_evidence_v3``), mêmes paramètres
que la lecture des réponses (``run_configured_semantic_analysis`` règle le plafond de sortie, un seul essai,
l'échéance de 25 s). La sortie de chaque appel est enregistrée pièce par pièce, avec ce que le fournisseur
renvoie (jetons d'entrée et de sortie, durée, identifiant et version de la prédiction, sortie brute quand le
JSON est invalide), dans un fichier que le banc rejoue (``model_outputs/<nom>.json``).

Garde-fous :

- plafond DUR de 5 USD par lancement et par fichier (``HARD_CAP_USD``, reprises comprises) ; ``--budget-usd``
  ne peut que l'abaisser. Avant chaque appel, son coût maximal est estimé (octets du prompt comme plafond
  des jetons d'entrée, plafond de jetons de sortie, tarif de ``TOKEN_PRICES`` majoré de 25 %) et l'appel
  n'est pas fait s'il ferait dépasser le plafond. Après chaque appel, la dépense retenue est le plus prudent
  de l'estimation et du coût réel calculé sur les jetons facturés ; l'essai s'arrête dès qu'elle dépasse ;
- l'appel est inscrit AVANT d'être fait : un arrêt brutal laisse un fichier exploitable et compte l'appel ;
- reprise : une pièce réussie n'est jamais rappelée ; une pièce en erreur ou interrompue est rejouée, et
  chaque tentative compte dans la dépense ;
- pilote (``--max-calls``) : arrêt après N appels et résumé (jetons facturés face à l'estimation, sortie
  au-delà du plafond de jetons, durée face à l'échéance) ;
- refus de toute clé Supabase et de tout identifiant de passage autonome : aucune écriture en base.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
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
    asset_text,
    load_cases,
    load_rules_stage,
    output_key,
    prompt_sha256,
    run_case,
)
from src.config import load_settings  # noqa: E402
from src.enrichment import llm_client  # noqa: E402
from src.information_agent_semantic import (  # noqa: E402
    SEMANTIC_PROCESSOR_VERSION,
    SEMANTIC_SYSTEM_PROMPT,
    SEMANTIC_TIMEOUT_SECONDS,
    build_semantic_user_prompt,
    contains_prompt_injection,
)
from src.normalize import clean_text  # noqa: E402
from src.pipeline_usage import TOKEN_PRICES, _token_counts  # noqa: E402

HARD_CAP_USD = Decimal("5")
PRICE_MARGIN = Decimal("1.25")
# Marge du gabarit de conversation du fournisseur, comme `reserve_prediction`.
TEMPLATE_TOKENS = 256
MAX_RAW_OUTPUT_CHARS = 20_000
DONE_STATUSES = {"ok", "not_called"}


class BudgetExhausted(RuntimeError):
    """Le plafond est atteint : plus aucun appel."""


class PilotLimitReached(RuntimeError):
    """Le nombre d'appels du pilote est atteint."""


def budget_cap(requested: str | None) -> Decimal:
    """Plafond de l'essai : 5 USD au plus, jamais plus, quel que soit le paramètre."""
    if requested is None or requested == "":
        return HARD_CAP_USD
    value = Decimal(requested)
    if not value.is_finite() or value <= 0 or value > HARD_CAP_USD:
        raise SystemExit(f"--budget-usd doit être compris entre 0 (exclu) et {HARD_CAP_USD} USD")
    return value


def _prices(model: str) -> tuple[Decimal, Decimal]:
    prices = TOKEN_PRICES.get(model)
    if prices is None:
        raise SystemExit(f"Modèle {model!r} sans tarif dans TOKEN_PRICES : coût non bornable, essai refusé")
    return prices[0], prices[1]


def estimated_call_cost_usd(model: str, system_prompt: str, user_prompt: str, output_tokens: int) -> Decimal:
    """Coût maximal d'un appel : un octet compte comme un jeton (plafond prudent), tarif majoré de 25 %."""
    input_price, output_price = _prices(model)
    prompt = llm_client._user_prompt_for_model(model, system_prompt, user_prompt)
    input_tokens = len(prompt.encode("utf-8")) + len(system_prompt.encode("utf-8")) + TEMPLATE_TOKENS
    cost = (Decimal(input_tokens) * input_price + Decimal(output_tokens) * output_price) / Decimal(1_000_000)
    return (cost * PRICE_MARGIN).quantize(Decimal("0.000001"))


def real_call_cost_usd(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    input_price, output_price = _prices(model)
    cost = (Decimal(input_tokens) * input_price + Decimal(output_tokens) * output_price) / Decimal(1_000_000)
    return cost.quantize(Decimal("0.000001"))


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
            "spend_usd": "0",
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


def _spend(outputs: Mapping[str, Any]) -> Decimal:
    return sum(
        (Decimal(attempt["charged_usd"]) for entry in outputs["outputs"].values() for attempt in entry.get("attempts", [])),
        Decimal(0),
    )


class RecordingClient:
    """Enveloppe le vrai client : plafond avant et après l'appel, compteurs du fournisseur, sortie brute."""

    def __init__(
        self,
        real: Any,
        outputs: dict[str, Any],
        save: Callable[[], None],
        cap: Decimal,
        max_calls: int | None,
    ) -> None:
        self._real = real
        self._outputs = outputs
        self._save = save
        self._cap = cap
        self._max_calls = max_calls
        self._predictions: list[dict[str, Any]] = []
        self.calls = 0
        # Le worker avale les erreurs du fournisseur (IA « indisponible ») : l'arrêt est noté ici.
        self.stopped: str | None = None
        original_wait = real._wait_for_output

        def wait_and_capture(prediction: dict[str, Any]) -> Any:
            try:
                return original_wait(prediction)
            finally:
                self._predictions.append(prediction)

        real._wait_for_output = wait_and_capture

    def _stop(self, reason: str, message: str) -> None:
        self.stopped = message
        self._outputs["stopped_reason"] = reason
        self._save()

    def call(self, key: str, system_prompt: str, user_prompt: str) -> Mapping[str, object]:
        if self._max_calls is not None and self.calls >= self._max_calls:
            self._stop("pilote", f"pilote : {self._max_calls} appel(s) faits")
            raise PilotLimitReached(self.stopped)
        model = str(self._real.model)
        estimate = estimated_call_cost_usd(model, system_prompt, user_prompt, int(self._real.fact_max_tokens))
        spent = _spend(self._outputs)
        if spent + estimate > self._cap:
            self._stop("budget", f"plafond de {self._cap} USD : {spent} USD engagés, appel suivant {estimate} USD")
            raise BudgetExhausted(self.stopped)
        entry = self._outputs["outputs"].setdefault(key, {"attempts": []})
        entry.update(
            status="in_flight",
            system_prompt_sha256=prompt_sha256(system_prompt),
            user_prompt_sha256=prompt_sha256(user_prompt),
        )
        entry.pop("response", None)
        attempt: dict[str, Any] = {"estimated_usd": str(estimate), "charged_usd": str(estimate), "status": "in_flight"}
        entry["attempts"].append(attempt)
        self._outputs["spend_usd"] = str(_spend(self._outputs))
        self._save()
        self.calls += 1
        self._predictions.clear()
        started = time.monotonic()
        try:
            response = self._real.generate_json_once(system_prompt, user_prompt)
        except Exception as exc:
            self._record(attempt, model, estimate, time.monotonic() - started, error=type(exc).__name__)
            entry["status"] = "error"
            self._after_call()
            raise
        self._record(attempt, model, estimate, time.monotonic() - started)
        entry.update(status="ok", response=response)
        self._after_call()
        return response

    def _record(self, attempt: dict[str, Any], model: str, estimate: Decimal, wall: float, *, error: str | None = None) -> None:
        prediction = self._predictions[-1] if self._predictions else {}
        metrics = dict(prediction.get("metrics") or {})
        counts = _token_counts(prediction, metrics) if prediction else None
        attempt.update(
            status="error" if error else "ok",
            error=error,
            wall_seconds=round(wall, 3),
            prediction_id=prediction.get("id"),
            model_version=prediction.get("version"),
            predict_seconds=metrics.get("predict_time"),
            input_tokens=counts[0] if counts else None,
            output_tokens=counts[1] if counts else None,
        )
        real = real_call_cost_usd(model, counts[0], counts[1]) if counts else None
        attempt["real_usd"] = str(real) if real is not None else None
        # Au plus prudent : le coût réel s'il dépasse l'estimation, l'estimation sinon ou sans compteurs.
        attempt["charged_usd"] = str(max(estimate, real) if real is not None else estimate)
        if error and prediction.get("output") is not None:
            attempt["raw_output"] = llm_client._stringify_output(prediction.get("output"))[:MAX_RAW_OUTPUT_CHARS]

    def _after_call(self) -> None:
        spent = _spend(self._outputs)
        self._outputs["spend_usd"] = str(spent)
        self._save()
        if spent > self._cap:
            self._stop("budget", f"plafond de {self._cap} USD dépassé après un appel : {spent} USD retenus")


class _CaseClient:
    """Client remis au worker pour un dossier : pièce réussie rejouée, sinon appel réel enregistré."""

    def __init__(self, recorder: RecordingClient, outputs: Mapping[str, Any], case_id: str, real: Any) -> None:
        self._recorder = recorder
        self._outputs = outputs
        self._case_id = case_id
        self._real = real
        self.asset_key = ""
        self.model = real.model
        self.fact_max_tokens = real.fact_max_tokens
        self.max_retries = real.max_retries

    def generate_json(self, _system_prompt: str, _user_prompt: str) -> Mapping[str, object]:
        raise RuntimeError("le worker doit appeler generate_json_once (un seul essai)")

    def generate_json_once(self, system_prompt: str, user_prompt: str) -> Mapping[str, object]:
        key = output_key(self._case_id, self.asset_key)
        existing = self._outputs["outputs"].get(key)
        if existing is not None and existing.get("status") == "ok":
            return existing["response"]
        # Les réglages du worker (plafond de sortie, un seul essai) passent au vrai client.
        self._real.fact_max_tokens = self.fact_max_tokens
        self._real.max_retries = self.max_retries
        return self._recorder.call(key, system_prompt, user_prompt)


def summarize(outputs: Mapping[str, Any], fact_max_tokens: int) -> dict[str, Any]:
    """Résumé lisible : jetons facturés face à l'estimation, sortie au-delà du plafond, durées."""
    attempts = [attempt for entry in outputs["outputs"].values() for attempt in entry.get("attempts", [])]
    measured = [attempt for attempt in attempts if attempt.get("output_tokens") is not None]
    return {
        "appels": len(attempts),
        "appels_avec_compteurs": len(measured),
        "estimation_usd": str(sum((Decimal(a["estimated_usd"]) for a in attempts), Decimal(0))),
        "cout_reel_usd": str(sum((Decimal(a["real_usd"]) for a in measured if a.get("real_usd")), Decimal(0))),
        "depense_retenue_usd": str(_spend(outputs)),
        "jetons_sortie_max": max((a["output_tokens"] for a in measured), default=None),
        "sortie_au_dela_du_plafond": [a.get("prediction_id") for a in measured if a["output_tokens"] > fact_max_tokens],
        "duree_max_s": max((a.get("wall_seconds") or 0 for a in attempts), default=None),
        "au_dela_de_l_echeance": sum(1 for a in attempts if (a.get("wall_seconds") or 0) > SEMANTIC_TIMEOUT_SECONDS),
        "erreurs": sum(1 for a in attempts if a.get("status") == "error"),
    }


def run_trial(
    output: Path,
    cap: Decimal,
    *,
    max_calls: int | None = None,
    client_factory: Callable[[], Any] | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Joue les pièces pas encore réussies ; rend le fichier de sorties (aussi écrit sur le disque)."""
    real = (client_factory or llm_client.create_llm_client)()
    model = str(real.model or "")
    _prices(model)
    outputs = load_outputs(output, model)
    outputs["budget_usd"] = str(cap)
    outputs["stopped_reason"] = None

    def save() -> None:
        outputs["updated_at"] = _now()
        save_outputs(output, outputs)

    recorder = RecordingClient(real, outputs, save, cap, max_calls)
    rules = load_rules_stage()
    stopped = False
    for case in load_cases():
        entry = rules[case["id"]]
        keys = asset_keys(case, entry)
        if all(outputs["outputs"].get(output_key(case["id"], key), {}).get("status") in DONE_STATUSES for key in keys):
            continue

        def after_asset(key: str, case_id: str = case["id"]) -> None:
            if recorder.stopped:
                # Pièce non lue faute de budget ou fin du pilote : rien n'est noté, la reprise la jouera.
                raise BudgetExhausted(recorder.stopped)
            # Pièce lue sans appel (consigne adressée à un modèle repérée) : notée pour ne pas la rejouer.
            outputs["outputs"].setdefault(output_key(case_id, key), {"status": "not_called", "attempts": []})

        try:
            run_case(case, entry, _CaseClient(recorder, outputs, case["id"], real), after_asset=after_asset)
        except (BudgetExhausted, PilotLimitReached) as exc:
            log(f"Arrêt propre : {exc}")
            stopped = True
            break
        save()
    if not stopped:
        outputs["stopped_reason"] = "complete"
    outputs["resume"] = summarize(outputs, int(real.fact_max_tokens or 1_024))
    save()
    log(json.dumps(outputs["resume"], ensure_ascii=False, indent=1))
    log(f"{recorder.calls} appel(s) ; fin : {outputs['stopped_reason']} (plafond {cap} USD)")
    return outputs


def estimate_full_run_usd(model: str, output_tokens: int) -> tuple[int, Decimal]:
    """Nombre d'appels et coût maximal estimé de l'essai complet, sans appel (pour le guide et les tests)."""
    calls = 0
    total = Decimal(0)
    rules = load_rules_stage()
    for case in load_cases():
        entry = rules[case["id"]]
        for key in asset_keys(case, entry):
            pages = [{"page": 1, "text": clean_text(asset_text(case, entry, key)) or ""}]
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
    parser.add_argument("--max-calls", type=int, default=None, help="pilote : nombre maximal d'appels")
    parser.add_argument("--estimate-only", action="store_true", help="affiche le coût maximal estimé, sans appel")
    args = parser.parse_args(argv)
    cap = budget_cap(args.budget_usd)
    if args.max_calls is not None and args.max_calls < 1:
        raise SystemExit("--max-calls doit être au moins 1")
    if args.estimate_only:
        model = str(load_settings()["replicate_model"])
        calls, total = estimate_full_run_usd(model, 1_024)
        print(f"{calls} appels au plus, coût maximal estimé {total} USD (plafond {cap} USD)")
        return 0
    refuse_production_credentials()
    settings = load_settings()
    if settings.get("llm_provider") != "replicate" or not settings.get("replicate_api_token"):
        raise SystemExit("Essai refusé : LLM_PROVIDER=replicate et REPLICATE_API_TOKEN sont requis")
    outputs = run_trial(args.output, cap, max_calls=args.max_calls)
    return 0 if outputs["stopped_reason"] in {"complete", "pilote"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
