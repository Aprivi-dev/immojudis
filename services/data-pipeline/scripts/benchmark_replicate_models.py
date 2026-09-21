"""Compare Replicate models on the pipeline's real prompts and fixed source cases.

This script never reads or writes Supabase. Its cases are synthetic and contain
no customer data. It runs only a small fixed set of paid predictions.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path
from typing import Any

from src.config import load_settings
from src.enrichment.extract_structured import LLMExtraction
from src.enrichment.llm_client import ReplicateClient
from src.enrichment.prompts import (
    DISPLAY_DESCRIPTION_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    build_display_description_prompt,
    build_user_prompt,
)
from src.pipeline_usage import PINNED_MODEL, _prediction_cost

DEFAULT_MODELS = (PINNED_MODEL, "qwen/qwen3-7-plus", "google/gemini-2.5-flash")
LONG_DOCUMENT_BACKGROUND = "\n".join(
    f"Annexe administrative {number} : rappel de la procédure de publicité, des délais de consignation "
    "et des modalités de consultation du cahier des conditions de vente. "
    "La référence cadastrale et les mentions de voisinage de cette annexe ne décrivent pas "
    "la surface ni l'occupation du bien mis en vente. "
    for number in range(1, 32)
)
CASES = (
    {
        "id": "apartment_display",
        "stage": "display",
        "context": (
            "Annonce source : vente aux enchères judiciaires à Rouen le 15 novembre 2026. "
            "Mise à prix 68 000 €. Lot 1 : appartement comprenant séjour, cuisine et deux chambres, "
            "surface loi Carrez 60,37 m², surface au sol 62,34 m². "
            "Lot 7 : cave, surface au sol 57,06 m², surface Carrez nulle. "
            "Le procès-verbal indique que le logement est occupé, sans autre précision. "
            "Aucune surface habitable n'est certifiée."
        ),
        "required": ("60,37", "cave"),
        "forbidden": ("119,40", "libre de toute occupation", "surface habitable de 60,37"),
    },
    {
        "id": "two_lots_display",
        "stage": "display",
        "context": (
            "Vente judiciaire à Vidauban le 22 octobre 2026 : deux lots distincts. "
            "Lot A : appartement, surface Carrez 51,82 m², mise à prix 24 000 €. "
            "Lot B : appartement, surface Carrez 42,90 m², mise à prix 30 000 €. "
            "L'occupation de chaque lot est inconnue. Ne pas agréger prix ou surfaces."
        ),
        "required": ("deux lots",),
        "forbidden": ("94,72", "54 000", "sont libres", "sont loués"),
    },
    {
        "id": "sparse_display",
        "stage": "display",
        "context": (
            "Annonce source : vente immobilière judiciaire d'un appartement à Lille. "
            "La surface, l'occupation, les annexes, la date de vente et la mise à prix "
            "ne sont pas indiquées dans le document disponible."
        ),
        "required": ("appartement", "lille"),
        "forbidden": ("est libre", "est occupé", "m²", "mise à prix de"),
    },
    {
        "id": "apartment_facts",
        "stage": "facts",
        "context": (
            "Annonce source : appartement à Rouen, lot 1, avec cave lot 7. "
            "PV descriptif page 2 : appartement de type T3 comprenant un séjour, une cuisine "
            "et deux chambres. Surface loi Carrez de l'appartement : 60,37 m². "
            "Surface au sol de la cave : 57,06 m². Surface Carrez de la cave : 0 m². "
            "Le logement est occupé, sans mention de bail. Aucune surface habitable n'est certifiée."
        ),
        "expected": {"property_type": "apartment", "surface_m2": 60.37, "rooms_count": 3,
                     "bedrooms_count": 2, "occupancy_status": "occupied"},
    },
    {
        "id": "conflicting_occupation_facts",
        "stage": "facts",
        "context": (
            "Annonce source : maison à Montoire. Surface habitable explicitement annoncée : 149,68 m². "
            "L'annonce indique 'bien libre'. PV descriptif page 3, daté plus récemment : "
            "'maison occupée par une personne non identifiée'. Les deux sources se contredisent ; "
            "aucune vérification d'occupation plus récente n'est disponible. "
            "Un commerce voisin a une surface de 155,56 m² et ne fait pas partie de la maison."
        ),
        "expected": {"property_type": "house", "surface_m2": 149.68, "occupancy_status": "unknown"},
    },
    {
        "id": "long_document_facts",
        "stage": "facts",
        "context": (
            "Avis initial : vente d'une maison à Tours. Un local commercial voisin de 173,40 m² "
            "figure dans le même dossier, mais ne fait pas partie de la vente.\n"
            + LONG_DOCUMENT_BACKGROUND
            + "\nProcès-verbal descriptif du bien vendu : maison de trois chambres, "
            "surface habitable explicitement mesurée à 84,20 m². "
            "L'annonce la disait libre, mais le procès-verbal plus récent indique une occupation. "
            "Ces sources se contredisent et l'occupation actuelle n'a pas été vérifiée."
        ),
        "expected": {"property_type": "house", "surface_m2": 84.20,
                     "bedrooms_count": 3, "occupancy_status": "unknown"},
    },
)


class BenchmarkClient(ReplicateClient):
    def __post_init__(self) -> None:
        super().__post_init__()
        self.predictions: list[dict[str, Any]] = []

    def _create_prediction(self, prompt: str, system_prompt: str | None = None) -> dict[str, Any]:
        prediction = super()._create_prediction(prompt, system_prompt=system_prompt)
        self.predictions.append(prediction)
        return prediction


def _evaluate(case: dict[str, Any], response: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    failures: list[str] = []
    if case["stage"] == "display":
        paragraph = response.get("display_description")
        if not isinstance(paragraph, str) or not paragraph.strip():
            return ["missing description"], {}
        normalized = paragraph.lower().replace(".", ",").replace("\u202f", " ")
        for phrase in case["required"]:
            if phrase not in normalized:
                failures.append(f"missing: {phrase}")
        for phrase in case["forbidden"]:
            if phrase in normalized:
                failures.append(f"unsupported: {phrase}")
        if "\n" in paragraph or len(paragraph) > 850:
            failures.append("display format/length")
        return failures, {"description": paragraph}

    extraction = LLMExtraction.model_validate(response)
    observed: dict[str, Any] = {}
    for field, expected in case["expected"].items():
        value = getattr(extraction, field)
        observed[field] = value
        if isinstance(expected, float):
            if value is None or not math.isclose(value, expected, abs_tol=0.01):
                failures.append(f"{field}: expected {expected}, got {value}")
        elif value != expected:
            failures.append(f"{field}: expected {expected}, got {value}")
    return failures, observed


def _prediction_cost_usd(model: str, predictions: list[dict[str, Any]]) -> float | None:
    if not predictions:
        return None
    total = 0.0
    for prediction in predictions:
        metrics = prediction.get("metrics") or {}
        cost, _ = _prediction_cost(model, prediction, dict(metrics))
        if cost is None:
            return None
        total += float(cost)
    return total


def run(models: list[str], output: Path) -> dict[str, Any]:
    settings = load_settings()
    if not os.getenv("REPLICATE_API_TOKEN"):
        raise SystemExit("REPLICATE_API_TOKEN is required")
    # Never attach production database credentials to this benchmark job.
    if settings.get("supabase_db_url") or settings.get("supabase_service_role_key") or os.getenv("PIPELINE_AUTONOMOUS_RUN_ID"):
        raise SystemExit("Benchmark refuses production database credentials")

    results: list[dict[str, Any]] = []
    for case in CASES:
        system_prompt = DISPLAY_DESCRIPTION_SYSTEM_PROMPT if case["stage"] == "display" else SYSTEM_PROMPT
        user_prompt = (
            build_display_description_prompt(case["context"])
            if case["stage"] == "display"
            else build_user_prompt(case["context"])
        )
        for model in models:
            client = BenchmarkClient(
                api_token=os.environ["REPLICATE_API_TOKEN"],
                model=model,
                max_tokens=512,
                fact_max_tokens=4096,
                temperature=0.1,
                thinking_budget=0,
                dynamic_thinking=False,
                min_interval_seconds=0,
                max_retries=1,
                cancel_after="5m",
            )
            started = time.monotonic()
            try:
                parsed = client.generate_json(system_prompt, user_prompt)
                failures, selected_output = _evaluate(case, parsed)
                error = None
            except Exception as exc:
                failures = [type(exc).__name__]
                selected_output = {}
                error = str(exc)[:300]
            result = {
                "case": case["id"],
                "stage": case["stage"],
                "model": model,
                "passed": not failures,
                "failures": failures,
                "output": selected_output,
                "error": error,
                "predictions": len(client.predictions),
                "seconds": round(time.monotonic() - started, 2),
                "estimated_usd": _prediction_cost_usd(model, client.predictions),
            }
            results.append(result)
            print(json.dumps({key: value for key, value in result.items() if key != "output"}, ensure_ascii=False), flush=True)
    summary: dict[str, Any] = {"cases": len(CASES), "models": {}}
    for model in models:
        rows = [result for result in results if result["model"] == model]
        costs = [row["estimated_usd"] for row in rows]
        summary["models"][model] = {
            "passed": sum(row["passed"] for row in rows),
            "total": len(rows),
            "estimated_usd": round(sum(costs), 6) if all(cost is not None for cost in costs) else None,
            "seconds": round(sum(row["seconds"] for row in rows), 2),
        }
    report = {"summary": summary, "results": results}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", nargs="+", choices=DEFAULT_MODELS, default=list(DEFAULT_MODELS))
    parser.add_argument("--output", type=Path, default=Path("model-benchmark.json"))
    args = parser.parse_args()
    run(args.models, args.output)
