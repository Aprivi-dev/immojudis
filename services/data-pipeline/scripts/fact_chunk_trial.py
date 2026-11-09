"""Essai de qualité : extraction des faits avec des morceaux plus grands, comparée aux faits stockés.

La production découpe le dossier d'une vente en morceaux de 10 000 caractères (LLM_FACT_CHUNK_CHARS dans
.github/workflows/data-pipeline.yml). Chaque appel renvoie aussi ~10 500 caractères de règles fixes : des
morceaux plus grands divisent ce surcoût, mais un morceau long peut faire manquer des faits. Cet essai relance
l'extraction de N ventes à venir dont les faits sont complets, avec des morceaux de ``--chunk-chars`` et un
plafond de sortie ``--max-tokens``, fusionne comme le pipeline (``_merge_llm_extractions``) et compare au
résultat stocké (``raw_payload.llm_fact_extraction``, extrait à 10 000).

LECTURE SEULE sur la base : la connexion est ouverte en lecture seule (``read_only``), aucune vente, aucun
cache (disque ou base) n'est écrit ; les textes restent en mémoire. Seuls les appels au modèle passent par le
client Replicate du pipeline, avec ses réservations et son budget (horaire et quotidien) : ils sont notés dans
``llm_usage_events`` sous l'étape ``facts_trial``.

Plafond dur : ``--max-calls`` prédictions au total (une relance « JSON invalide » compte), et ``--budget-minutes``
de durée. Au-delà, l'essai s'arrête proprement et rend le rapport des ventes déjà traitées.

Rapport Markdown sur la sortie standard et dans ``$GITHUB_STEP_SUMMARY`` s'il existe.

    python -m scripts.fact_chunk_trial --sales 10 --chunk-chars 25000 --max-tokens 8192 --max-calls 120
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src.config import load_settings  # noqa: E402
from src.encheres_publiques_guard import require_encheres_publiques_sale_access  # noqa: E402
from src.enrichment.extract_structured import (  # noqa: E402
    FACT_FINGERPRINT_CHUNK_CHARS,
    LLMExtraction,
    _fact_input_cache_key,
    _merge_llm_extractions,
    _pack_fact_sections,
    _provider_safe_text,
    _validated_llm_extraction,
    extract_source_description,
    fact_sections_for_sale,
)
from src.enrichment.llm_client import ReplicateClient, _is_gemini_model, _is_qwen_model  # noqa: E402
from src.enrichment.prompts import SYSTEM_PROMPT, build_user_prompt  # noqa: E402
from src.llm_requests import (  # noqa: E402
    LLMRequestDeterministicCooldown,
    LLMRequestTransportAmbiguous,
    llm_request_context,
)
from src.llm_task_deadline import LLMTaskDeadlineExceeded  # noqa: E402
from src.models import AuctionSale  # noqa: E402
from src.pipeline_usage import PINNED_MODEL, PipelineBudgetExhausted, _prediction_cost, _token_counts  # noqa: E402

DEFAULT_SALES = 10
DEFAULT_CHUNK_CHARS = 25_000
DEFAULT_MAX_TOKENS = 8_192
DEFAULT_MAX_CALLS = 120
DEFAULT_BUDGET_MINUTES = 60
MIN_TOTAL_CHUNKS = 4
MAX_TOTAL_CHUNKS = 40
TRIAL_STAGE = "facts_trial"
TRIAL_REASON = "fact_chunk_trial"
# A response is counted as cut by the output cap when it used (almost) all of it.
TRUNCATION_RATIO = 0.98

SCALAR_FIELDS = ("property_type", "surface_m2", "rooms_count", "bedrooms_count", "occupancy_status")
LIST_FIELDS = ("legal_risks", "physical_risks", "servitudes", "investment_facts", "contradictions")
ASSET_FIELDS = ("spaces", "explicit_surfaces")
FAILURE_KINDS = ("json_invalide", "validation", "fournisseur")

# Upcoming sales with complete facts, stored total_chunks within bounds, a stored extraction and a persisted
# PDF text: same sale scope as src/document_reading.py CANDIDATES_SQL. Only ids and sizes are read here.
CANDIDATES_SQL = """
select sale.id::text,
       (sale.raw_payload -> 'llm_fact_coverage' ->> 'total_chunks')::numeric::int as total_chunks
  from public.auction_sales sale
 where sale.status in ('upcoming', 'unknown', 'postponed')
   and (sale.sale_date is null or sale.sale_date >= now())
   and not app_private.sale_is_fully_withdrawn(
     sale.source_name, sale.observations, (select app_private.catalogue_withdrawn_sources())
   )
   and sale.raw_payload -> 'llm_fact_coverage' ->> 'complete' = 'true'
   and jsonb_typeof(sale.raw_payload -> 'llm_fact_extraction') = 'object'
   and case
         when jsonb_typeof(sale.raw_payload -> 'llm_fact_coverage' -> 'total_chunks') = 'number'
         then (sale.raw_payload -> 'llm_fact_coverage' ->> 'total_chunks')::numeric
       end between %s and %s
   and exists (
     select 1
       from public.auction_extractions extraction
      where extraction.source_url = sale.source_url
        and extraction.provider = 'pdf_text'
        and jsonb_typeof(extraction.result) = 'array'
   )
 order by 2, 1
"""

SALE_COLUMNS = (
    "id",
    "source_name",
    "source_url",
    "primary_source",
    "source_urls",
    "external_id",
    "title",
    "address",
    "city",
    "postal_code",
    "raw_text",
    "documents",
    "observations",
    "raw_payload",
)
# One sale and its most recent persisted PDF text (provider pdf_text), as src/document_reading.py reads it.
SALE_SQL = f"""
select {", ".join(f"sale.{column}" for column in SALE_COLUMNS)}, latest.result
  from public.auction_sales sale
  join lateral (
    select extraction.result
      from public.auction_extractions extraction
     where extraction.source_url = sale.source_url
       and extraction.provider = 'pdf_text'
       and jsonb_typeof(extraction.result) = 'array'
     order by extraction.updated_at desc
     limit 1
  ) latest on true
 where sale.id::text = %s
"""

# Average production fact call over 30 days (estimates are characters / 4, as recorded by the client).
USAGE_SQL = """
select count(*), avg(input_tokens_estimate), avg(output_tokens_estimate)
  from public.llm_usage_events
 where stage = 'facts'
   and request_kind = 'fact_extraction'
   and succeeded
   and created_at >= now() - interval '30 days'
"""


class CallCapReached(RuntimeError):
    """The trial's hard cap on model calls is reached: no new prediction is created."""


@dataclass
class CallUsage:
    succeeded: bool
    input_tokens: int | None
    output_tokens: int | None
    input_tokens_estimate: int
    output_tokens_estimate: int
    cost_usd: Decimal | None = None
    truncated: bool = False
    error: str | None = None


class TrialClient(Protocol):
    model: str | None
    calls_made: int
    usage: list[CallUsage]

    def is_available(self) -> bool: ...

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, Any]: ...


class MeteredReplicateClient(ReplicateClient):
    """The pipeline's Replicate client, with a hard call cap and per-call token capture.

    Reservations, hourly and daily budgets and telemetry are those of :class:`ReplicateClient`.
    """

    def start_meter(self, max_calls: int) -> MeteredReplicateClient:
        self.max_calls = max(0, int(max_calls))
        self.calls_made = 0
        self.usage: list[CallUsage] = []
        return self

    def _create_prediction(self, prompt: str, system_prompt: str | None = None, **kwargs: Any) -> dict[str, Any]:
        if self.calls_made >= self.max_calls:
            raise CallCapReached(f"plafond de {self.max_calls} appels atteint")
        # Counted before the POST: a call whose outcome is unknown still counts against the cap.
        self.calls_made += 1
        return super()._create_prediction(prompt, system_prompt, **kwargs)

    def _record_usage(self, prediction: dict[str, Any], **kwargs: Any) -> None:
        try:
            self.usage.append(self._call_usage(prediction, kwargs))
        finally:
            # The pipeline telemetry (reservation row, llm_usage_events) is recorded in every case.
            super()._record_usage(prediction, **kwargs)

    def _call_usage(self, prediction: dict[str, Any], kwargs: Mapping[str, Any]) -> CallUsage:
        model = str(self.model or "")
        metrics = dict(prediction.get("metrics") or {}) if isinstance(prediction, dict) else {}
        counts = _token_counts(prediction, dict(metrics)) if isinstance(prediction, dict) else None
        cost, _ = _prediction_cost(model, prediction, dict(metrics)) if isinstance(prediction, dict) else (None, None)
        prompt_chars = int(kwargs.get("prompt_chars") or 0)
        system_chars = int(kwargs.get("system_prompt_chars") or 0)
        input_chars = prompt_chars + system_chars if _is_qwen_model(model) or _is_gemini_model(model) else prompt_chars
        output_tokens = counts[1] if counts else None
        cap = int(self.fact_max_tokens or self.max_tokens or 0)
        return CallUsage(
            succeeded=bool(kwargs.get("succeeded")),
            input_tokens=counts[0] if counts else None,
            output_tokens=output_tokens,
            input_tokens_estimate=round(input_chars / 4),
            output_tokens_estimate=round(int(kwargs.get("output_chars") or 0) / 4),
            cost_usd=cost,
            truncated=bool(cap and output_tokens is not None and output_tokens >= cap * TRUNCATION_RATIO),
            error=kwargs.get("error_message"),
        )


@dataclass
class TrialOptions:
    sales: int = DEFAULT_SALES
    chunk_chars: int = DEFAULT_CHUNK_CHARS
    max_tokens: int = DEFAULT_MAX_TOKENS
    max_calls: int = DEFAULT_MAX_CALLS
    budget_minutes: float = DEFAULT_BUDGET_MINUTES


@dataclass
class SaleResult:
    sale_id: str
    source_url: str
    stored_chunks: int
    rebuilt_chunks_10k: int = 0
    same_input: bool | None = None
    trial_chunks: int = 0
    usage: list[CallUsage] = field(default_factory=list)
    failures: dict[str, int] = field(default_factory=lambda: dict.fromkeys(FAILURE_KINDS, 0))
    errors: list[str] = field(default_factory=list)
    complete: bool = False
    skipped: str | None = None
    stored: dict[str, Any] = field(default_factory=dict)
    trial: dict[str, Any] | None = None


@dataclass
class TrialReport:
    options: TrialOptions
    model: str
    candidates: int = 0
    selected: list[tuple[str, int]] = field(default_factory=list)
    results: list[SaleResult] = field(default_factory=list)
    not_processed: list[str] = field(default_factory=list)
    stop_reason: str | None = None
    usage_10k: tuple[int, float | None, float | None] | None = None


def pick_varied(candidates: Sequence[tuple[str, int]], count: int) -> list[tuple[str, int]]:
    """``count`` candidates spread evenly over the size order (deterministic)."""
    ordered = sorted(candidates, key=lambda item: (item[1], item[0]))
    if count <= 0 or not ordered:
        return []
    if len(ordered) <= count:
        return ordered
    if count == 1:
        return [ordered[len(ordered) // 2]]
    positions = sorted({round(index * (len(ordered) - 1) / (count - 1)) for index in range(count)})
    return [ordered[position] for position in positions]


def fact_summary(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    """Compared values of a fact extraction: five scalar fields and the size of each list."""
    payload = payload if isinstance(payload, Mapping) else {}
    summary: dict[str, Any] = {name: payload.get(name) for name in SCALAR_FIELDS}
    if isinstance(summary["surface_m2"], (int, float)) and not isinstance(summary["surface_m2"], bool):
        summary["surface_m2"] = round(float(summary["surface_m2"]), 2)
    if summary["occupancy_status"] == "unknown":
        summary["occupancy_status"] = None
    if summary["property_type"] == "unknown":
        summary["property_type"] = None
    for name in LIST_FIELDS:
        value = payload.get(name)
        summary[name] = len(value) if isinstance(value, list) else 0
    assets = payload.get("assets")
    assets = [asset for asset in assets if isinstance(asset, Mapping)] if isinstance(assets, list) else []
    for name in ASSET_FIELDS:
        summary[f"assets.{name}"] = sum(len(asset.get(name) or []) for asset in assets)
    return summary


def sale_from_row(values: Mapping[str, Any]) -> AuctionSale:
    data = {name: values.get(name) for name in SALE_COLUMNS if values.get(name) is not None}
    # psycopg returns the uuid column as uuid.UUID; the model keeps ids as text.
    if "id" in data:
        data["id"] = str(data["id"])
    # Only the URLs and labels of the documents matter here; the model types every value as text.
    documents = data.get("documents")
    data["documents"] = [
        {str(key): str(value) for key, value in item.items() if value is not None}
        for item in documents
        if isinstance(item, Mapping)
    ] if isinstance(documents, list) else []
    if not isinstance(data.get("raw_payload"), dict):
        data["raw_payload"] = {}
    if not isinstance(data.get("observations"), list):
        data["observations"] = []
    return AuctionSale.model_validate(data)


def _failure_kind(exc: Exception) -> str:
    if isinstance(exc, ValueError):
        return "json_invalide" if "invalid json" in str(exc).casefold() else "validation"
    return "fournisseur"


def trial_sale(
    row: Sequence[Any],
    client: TrialClient,
    *,
    options: TrialOptions,
    settings: Mapping[str, Any],
    deadline: float,
    clock: Callable[[], float],
) -> tuple[SaleResult, str | None]:
    """Extract one sale again with the trial chunk size. Returns the result and a stop reason, if any."""
    values = dict(zip((*SALE_COLUMNS, "pdf_result"), row, strict=True))
    raw_payload = values.get("raw_payload") if isinstance(values.get("raw_payload"), dict) else {}
    coverage = raw_payload.get("llm_fact_coverage") or {}
    result = SaleResult(
        sale_id=str(values.get("id")),
        source_url=str(values.get("source_url") or ""),
        stored_chunks=int(coverage.get("total_chunks") or 0) if isinstance(coverage, dict) else 0,
        stored=fact_summary(raw_payload.get("llm_fact_extraction")),
    )
    try:
        sale = sale_from_row(values)
        require_encheres_publiques_sale_access(
            source_name=sale.source_name,
            source_url=sale.source_url,
            source_urls=sale.source_urls,
            documents=sale.documents,
            settings=settings,
        )
    except Exception as exc:  # noqa: BLE001 - one unreadable or gated sale does not stop the trial
        result.skipped = f"vente ignorée : {str(exc)[:200]}"
        return result, None

    # Same input as enrich_sale_with_llm: the source description, then every listing block and PDF page.
    source_description = extract_source_description(sale)
    if source_description:
        sale.raw_payload["source_description"] = source_description
    else:
        sale.raw_payload.pop("source_description", None)
    sections = fact_sections_for_sale(sale, values.get("pdf_result"))
    chunks_10k = [chunk for chunk in _pack_fact_sections(sections, chunk_chars=FACT_FINGERPRINT_CHUNK_CHARS) if chunk]
    result.rebuilt_chunks_10k = len(chunks_10k)
    stored_key = raw_payload.get("llm_fact_input_key")
    if stored_key:
        prompt_version = str(settings.get("llm_fact_prompt_version") or settings.get("llm_prompt_version") or "")
        context_10k = "\n\n".join(chunks_10k)
        result.same_input = stored_key in {
            _fact_input_cache_key(context_10k, model, prompt_version)
            for model in (str(client.model or ""), PINNED_MODEL)
        }
    chunks = [chunk for chunk in _pack_fact_sections(sections, chunk_chars=max(3000, options.chunk_chars)) if chunk]
    result.trial_chunks = len(chunks)
    if not chunks:
        result.skipped = "aucun texte à extraire"
        return result, None
    if client.calls_made + len(chunks) > options.max_calls:
        result.skipped = "non traitée"
        return result, (
            f"plafond d'appels : {len(chunks)} appels prévus pour la vente {result.sale_id}, "
            f"{options.max_calls - client.calls_made} restants sur {options.max_calls}"
        )

    usage_start = len(client.usage)
    extractions: list[LLMExtraction] = []
    stop_reason: str | None = None
    for index, context in enumerate(chunks, start=1):
        if clock() >= deadline:
            stop_reason = f"durée maximale de {options.budget_minutes:g} min atteinte"
            break
        try:
            with llm_request_context(
                source_url=sale.source_url, sale_id=sale.id, stage=TRIAL_STAGE, reason=TRIAL_REASON
            ):
                raw = client.generate_json(SYSTEM_PROMPT, build_user_prompt(_provider_safe_text(context)))
            extractions.append(_validated_llm_extraction(raw))
        except CallCapReached as exc:
            stop_reason = str(exc)
            break
        except (LLMRequestDeterministicCooldown, LLMRequestTransportAmbiguous) as exc:
            result.failures["fournisseur"] += 1
            result.errors.append(f"morceau {index}/{len(chunks)} : {str(exc)[:200]}")
        except (PipelineBudgetExhausted, LLMTaskDeadlineExceeded) as exc:
            stop_reason = f"budget refusé : {str(exc)[:200]}"
            break
        except Exception as exc:  # noqa: BLE001 - a failed chunk is a measured outcome of the trial
            result.failures[_failure_kind(exc)] += 1
            result.errors.append(f"morceau {index}/{len(chunks)} : {str(exc)[:200]}")
    result.usage = list(client.usage[usage_start:])
    result.complete = len(extractions) == len(chunks)
    if result.complete:
        result.trial = fact_summary(_merge_llm_extractions(extractions).model_dump(mode="json"))
    return result, stop_reason


def run_trial(
    connection: Any,
    client: TrialClient,
    *,
    options: TrialOptions,
    settings: Mapping[str, Any] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> TrialReport:
    """Select the sales, extract them again and compare. Reads only; never writes to the database."""
    settings = load_settings() if settings is None else settings
    report = TrialReport(options=options, model=str(client.model or ""))
    deadline = clock() + options.budget_minutes * 60
    candidates = [
        (str(sale_id), int(total))
        for sale_id, total in connection.execute(CANDIDATES_SQL, (MIN_TOTAL_CHUNKS, MAX_TOTAL_CHUNKS)).fetchall()
    ]
    report.candidates = len(candidates)
    report.selected = pick_varied(candidates, options.sales)
    try:
        report.usage_10k = tuple(connection.execute(USAGE_SQL).fetchone() or ()) or None  # type: ignore[assignment]
    except Exception:  # noqa: BLE001 - the 10 000 estimate is optional
        report.usage_10k = None
    # Each read ends its (read-only) transaction: none stays open while the model answers.
    connection.rollback()
    for position, (sale_id, _) in enumerate(report.selected):
        if report.stop_reason is not None:
            report.not_processed.extend(item[0] for item in report.selected[position:])
            break
        try:
            row = connection.execute(SALE_SQL, (sale_id,)).fetchone()
            connection.rollback()
        except Exception as exc:  # noqa: BLE001 - stop cleanly and report what was done
            report.stop_reason = f"lecture de la vente {sale_id} impossible : {str(exc)[:200]}"
            report.not_processed.extend(item[0] for item in report.selected[position:])
            break
        if row is None:
            continue
        result, stop_reason = trial_sale(
            row, client, options=options, settings=settings, deadline=deadline, clock=clock
        )
        report.stop_reason = stop_reason
        if result.skipped == "non traitée":
            report.not_processed.extend(item[0] for item in report.selected[position:])
            break
        report.results.append(result)
    connection.rollback()
    return report


def _sum(values: Sequence[int | None]) -> int | None:
    return None if any(value is None for value in values) else sum(int(value or 0) for value in values)


def _fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:,.0f}".replace(",", " ")
    if isinstance(value, int):
        return f"{value:,}".replace(",", " ")
    return str(value)


def _compare(stored: Any, trial: Any) -> str:
    def value(item: Any) -> str:
        return "—" if item is None else str(item)

    return "=" if stored == trial else f"{value(stored)} → {value(trial)}"


def render_report(report: TrialReport) -> str:
    options = report.options
    results = report.results
    compared = [result for result in results if result.complete and result.trial is not None]
    lines = [
        f"## Essai des morceaux de faits : {options.chunk_chars} caractères contre 10 000",
        "",
        f"- Modèle : `{report.model}` ; plafond de sortie : {options.max_tokens} jetons ; "
        f"plafond d'appels : {options.max_calls} ; durée maximale : {options.budget_minutes:g} min.",
        f"- Ventes candidates (à venir, faits complets, {MIN_TOTAL_CHUNKS} à {MAX_TOTAL_CHUNKS} morceaux à 10 000) : "
        f"{report.candidates} ; retenues : {len(report.selected)} ; traitées : {len(results)} ; "
        f"comparées (extraction complète) : {len(compared)}.",
        f"- Arrêt : {report.stop_reason or 'aucun (essai complet)'}.",
    ]
    if report.not_processed:
        lines.append(f"- Non traitées : {', '.join(f'`{sale_id}`' for sale_id in report.not_processed)}.")
    lines += ["", "### Par vente", ""]
    lines.append(
        "| Vente | Appels à 10 000 (stocké / recalculé) | Même texte | Appels essai | Jetons entrée | Jetons sortie "
        "| JSON invalide | Tronqués | Autres échecs | Statut |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for result in results:
        usage = result.usage
        status = result.skipped or ("complète" if result.complete else "incomplète")
        same = {True: "oui", False: "non", None: "—"}[result.same_input]
        lines.append(
            f"| `{result.sale_id[:8]}` | {result.stored_chunks} / {result.rebuilt_chunks_10k} | {same} "
            f"| {len(usage)} | {_fmt(_sum([call.input_tokens for call in usage]))} "
            f"| {_fmt(_sum([call.output_tokens for call in usage]))} | {result.failures['json_invalide']} "
            f"| {sum(call.truncated for call in usage)} "
            f"| {result.failures['validation'] + result.failures['fournisseur']} | {status} |"
        )
    lines += ["", "### Faits : stocké (10 000) → essai", ""]
    headers = [*SCALAR_FIELDS, *LIST_FIELDS, *(f"assets.{name}" for name in ASSET_FIELDS)]
    lines.append("| Vente | " + " | ".join(headers) + " |")
    lines.append("|---|" + "---|" * len(headers))
    for result in compared:
        assert result.trial is not None
        cells = [_compare(result.stored[name], result.trial[name]) for name in headers]
        lines.append(f"| `{result.sale_id[:8]}` | " + " | ".join(cells) + " |")
    lines += ["", "### Total", ""]
    all_usage = [call for result in results for call in result.usage]
    calls_10k = sum(result.stored_chunks for result in compared)
    calls_trial = sum(len(result.usage) for result in compared)
    lines.append(f"- Appels (ventes comparées) : {calls_10k} à 10 000 (stocké) ; {calls_trial} dans l'essai.")
    lines.append(
        f"- Appels de l'essai : {len(all_usage)} (dont {sum(not call.succeeded for call in all_usage)} en échec) ; "
        f"jetons mesurés : {_fmt(_sum([call.input_tokens for call in all_usage]))} en entrée, "
        f"{_fmt(_sum([call.output_tokens for call in all_usage]))} en sortie ; coût estimé : "
        f"{_fmt_cost([call.cost_usd for call in all_usage])}."
    )
    trial_in = sum(call.input_tokens_estimate for result in compared for call in result.usage)
    trial_out = sum(call.output_tokens_estimate for result in compared for call in result.usage)
    if report.usage_10k and report.usage_10k[0] and report.usage_10k[1] is not None:
        count, avg_in, avg_out = report.usage_10k
        lines.append(
            f"- Estimation caractères/4 (ventes comparées) : à 10 000 ≈ {_fmt(float(avg_in or 0) * calls_10k)} "
            f"en entrée et {_fmt(float(avg_out or 0) * calls_10k)} en sortie (moyenne de {count} appels « facts » "
            f"sur 30 jours × appels stockés) ; essai : {_fmt(trial_in)} et {_fmt(trial_out)}."
        )
    else:
        lines.append(f"- Estimation caractères/4 de l'essai (ventes comparées) : {_fmt(trial_in)} en entrée, "
                     f"{_fmt(trial_out)} en sortie ; estimation à 10 000 indisponible.")
    if compared:
        agreement = ", ".join(
            f"{name} {sum(result.stored[name] == result.trial[name] for result in compared if result.trial)}"
            f"/{len(compared)}"
            for name in SCALAR_FIELDS
        )
        lines.append(f"- Champs identiques : {agreement}.")
        totals = ", ".join(
            f"{name} {sum(result.stored[name] for result in compared)} → "
            f"{sum(result.trial[name] for result in compared if result.trial)}"
            for name in [*LIST_FIELDS, *(f"assets.{asset}" for asset in ASSET_FIELDS)]
        )
        lines.append(f"- Éléments (stocké → essai) : {totals}.")
    failures = {kind: sum(result.failures[kind] for result in results) for kind in FAILURE_KINDS}
    lines.append(
        f"- Échecs : {failures['json_invalide']} JSON invalide(s), "
        f"{sum(call.truncated for call in all_usage)} réponse(s) tronquée(s) au plafond, "
        f"{failures['validation']} validation, {failures['fournisseur']} fournisseur."
    )
    errors = [f"`{result.sale_id[:8]}` {error}" for result in results for error in result.errors]
    if errors:
        lines += ["", "<details><summary>Détail des échecs</summary>", ""]
        lines += [f"- {error}" for error in errors[:40]]
        lines += ["", "</details>"]
    lines += [
        "",
        "« Même texte » : l'empreinte recalculée à 10 000 égale `llm_fact_input_key` stockée (le texte relu en "
        "base est celui de l'extraction stockée). Une vente « incomplète » n'est pas comparée, comme le pipeline "
        "n'applique pas des faits partiels.",
    ]
    return "\n".join(lines) + "\n"


def _fmt_cost(values: Sequence[Decimal | None]) -> str:
    known = [value for value in values if value is not None]
    if not known:
        return "—"
    suffix = "" if len(known) == len(values) else f" ({len(values) - len(known)} appel(s) sans coût connu)"
    return f"{sum(known, Decimal(0)):.4f} USD{suffix}"


def _bounded_int(low: int, high: int) -> Callable[[str], int]:
    def parse(text: str) -> int:
        value = int(text)
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(f"attendu entre {low} et {high}")
        return value

    return parse


def parse_args(argv: Sequence[str] | None = None) -> TrialOptions:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sales", type=_bounded_int(1, 50), default=DEFAULT_SALES)
    parser.add_argument("--chunk-chars", type=_bounded_int(3000, 60_000), default=DEFAULT_CHUNK_CHARS)
    parser.add_argument("--max-tokens", type=_bounded_int(512, 16_384), default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--max-calls", type=_bounded_int(1, 500), default=DEFAULT_MAX_CALLS)
    parser.add_argument("--budget-minutes", type=_bounded_int(1, 180), default=DEFAULT_BUDGET_MINUTES)
    args = parser.parse_args(argv)
    return TrialOptions(
        sales=args.sales,
        chunk_chars=args.chunk_chars,
        max_tokens=args.max_tokens,
        max_calls=args.max_calls,
        budget_minutes=args.budget_minutes,
    )


def publish(markdown: str) -> None:
    sys.stdout.write(markdown)
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(markdown)


def main(argv: Sequence[str] | None = None) -> int:
    options = parse_args(argv)
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not db_url:
        print("SUPABASE_DB_URL est requise (lecture des ventes).", file=sys.stderr)
        return 2
    client = MeteredReplicateClient(fact_max_tokens=options.max_tokens).start_meter(options.max_calls)
    if not client.is_available():
        print("REPLICATE_API_TOKEN est requise.", file=sys.stderr)
        return 2
    from src.storage.supabase_client import connect

    connection = connect(str(db_url))
    try:
        # Every statement of this connection runs in a READ ONLY transaction: a write would fail.
        connection.read_only = True
        report = run_trial(connection, client, options=options, settings=settings)
    finally:
        connection.close()
    publish(render_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
