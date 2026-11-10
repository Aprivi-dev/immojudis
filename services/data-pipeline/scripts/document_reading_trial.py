"""Essai de qualité : lecture des pièces avec une version candidate, comparée à la lecture stockée.

La lecture des pièces (``src/document_reading.py``) est ce que l'abonné voit point par point. Cet essai relit
les pièces de quelques ventes à venir avec les profils candidats de ``src/document_reading_candidate.py``
(« v4 » : même coût que la production ; « v4_wide » : deux fois plus de texte lu) et rend, pour chaque vente,
les points stockés, les points de chaque profil et les listes de l'extraction des faits (ce que les mêmes pièces
contiennent selon l'autre lecture), pour une comparaison point par point.

LECTURE SEULE sur la base : la connexion est ouverte en lecture seule (``read_only``) ; aucune lecture n'est
écrite. Seuls les appels au modèle passent par le client Replicate du pipeline, avec ses réservations et son
budget (horaire et quotidien) : ils sont notés dans ``llm_usage_events`` sous l'étape ``reading_trial``.

Un appel par vente et par profil, au plus ``--max-calls`` au total. Quand le budget HORAIRE partagé avec le
pipeline est épuisé, l'essai attend puis relance le même appel, jusqu'à ``--budget-minutes``.

Rapport Markdown sur la sortie standard et dans ``$GITHUB_STEP_SUMMARY`` ; le détail (une ligne
``READING_DETAIL {json}`` par vente) suit sur la sortie standard seulement. Tous les textes du détail passent
par le filtre des noms de personnes.

    python -m scripts.document_reading_trial --sales 10 --profiles v4,v4_wide --max-calls 40
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from scripts.fact_chunk_trial import (  # noqa: E402
    HOURLY_WAIT_SECONDS,
    CallCapReached,
    CallUsage,
    MeteredReplicateClient,
    TrialClient,
    _bounded_int,
    _fmt,
    _fmt_cost,
    _hourly_budget_refusal,
    _sum,
    pick_varied,
    publish,
)
from src.config import load_settings  # noqa: E402
from src.document_reading import (  # noqa: E402
    ReadingProfile,
    documents_from_manifest,
    filtered_for_model,
    read_sale_documents,
    sold_lot_from_sale,
)
from src.document_reading_candidate import CANDIDATE_PROFILES  # noqa: E402
from src.llm_requests import llm_request_context  # noqa: E402
from src.personal_data import redact_personal_text  # noqa: E402

DEFAULT_SALES = 10
DEFAULT_MAX_CALLS = 40
DEFAULT_BUDGET_MINUTES = 90
TRIAL_STAGE = "reading_trial"
TRIAL_REASON = "document_reading_trial"
TRUNCATION_RATIO = 0.98
FACT_LISTS = ("legal_risks", "physical_risks", "servitudes", "investment_facts")
SALE_PREFIX_CHARS = 8

# Upcoming sales with a completed reading that has points, a complete fact extraction and a persisted PDF text:
# the fact lists are the reference the readings are compared to. Only ids and sizes are read here.
CANDIDATES_SQL = """
select sale.id::text, jsonb_array_length(reading.documents) as documents
  from public.auction_sales sale
  join public.auction_document_readings reading on reading.sale_id = sale.id
 where sale.status in ('upcoming', 'unknown', 'postponed')
   and (sale.sale_date is null or sale.sale_date >= now())
   and not app_private.sale_is_fully_withdrawn(
     sale.source_name, sale.observations, (select app_private.catalogue_withdrawn_sources())
   )
   and reading.status = 'completed'
   and jsonb_typeof(reading.points) = 'array'
   and jsonb_array_length(reading.points) > 0
   and jsonb_typeof(reading.documents) = 'array'
   and sale.raw_payload -> 'llm_fact_coverage' ->> 'complete' = 'true'
   and jsonb_typeof(sale.raw_payload -> 'llm_fact_extraction') = 'object'
   and exists (
     select 1 from public.auction_extractions extraction
      where extraction.source_url = sale.source_url
        and extraction.provider = 'pdf_text'
        and jsonb_typeof(extraction.result) = 'array'
   )
 order by 2, 1
"""

SALE_SQL = """
select sale.id::text, sale.source_url, sale.property_type, sale.city,
       sale.raw_payload -> 'source_lot_selection', sale.raw_payload -> 'llm_fact_extraction',
       latest.result, reading.points, reading.prompt_version, reading.input_truncated
  from public.auction_sales sale
  join public.auction_document_readings reading on reading.sale_id = sale.id
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


@dataclass
class TrialOptions:
    sales: int = DEFAULT_SALES
    profiles: tuple[str, ...] = tuple(CANDIDATE_PROFILES)
    sale_prefixes: tuple[str, ...] = ()
    max_calls: int = DEFAULT_MAX_CALLS
    budget_minutes: float = DEFAULT_BUDGET_MINUTES


@dataclass
class ProfileResult:
    profile: str
    status: str = "non traitée"
    error: str | None = None
    truncated: bool = False
    pages_read: int = 0
    raw_points: int = 0
    points: list[dict[str, object]] = field(default_factory=list)
    rejections: dict[str, int] = field(default_factory=dict)
    usage: list[CallUsage] = field(default_factory=list)
    output_cut: bool = False
    budget_waits: int = 0


@dataclass
class SaleResult:
    sale_id: str
    documents: int = 0
    pages: int = 0
    stored_version: str = ""
    stored_truncated: bool = False
    stored_points: list[dict[str, object]] = field(default_factory=list)
    facts: dict[str, list[str]] = field(default_factory=dict)
    profiles: dict[str, ProfileResult] = field(default_factory=dict)
    skipped: str | None = None


@dataclass
class TrialReport:
    options: TrialOptions
    model: str
    candidates: int = 0
    selected: list[str] = field(default_factory=list)
    results: list[SaleResult] = field(default_factory=list)
    stop_reason: str | None = None


def _safe(value: object) -> str:
    text = str(value) if value is not None else ""
    return redact_personal_text(text) or text


def fact_texts(payload: object) -> dict[str, list[str]]:
    """The fact lists as short texts (statement or description, without the evidence), names filtered."""
    payload = payload if isinstance(payload, Mapping) else {}
    texts: dict[str, list[str]] = {}
    for name in FACT_LISTS:
        values = payload.get(name)
        items: list[str] = []
        for value in values if isinstance(values, list) else []:
            if isinstance(value, Mapping):
                text = value.get("statement") or value.get("description") or value.get("fact") or ""
            else:
                # « risk_type: …; description: …; evidence: quote: … » : the evidence is left out.
                text = str(value).split("; evidence:")[0]
            text = _safe(text).strip()
            if text and text not in items:
                items.append(text[:300])
        texts[name] = items
    return texts


def point_texts(points: object) -> list[dict[str, object]]:
    """Points reduced to what a reader compares, names filtered (stored v2 quotes predate the page filter)."""
    kept: list[dict[str, object]] = []
    for point in points if isinstance(points, list) else []:
        if not isinstance(point, Mapping):
            continue
        kept.append(
            {
                "theme": point.get("theme"),
                "importance": point.get("importance"),
                "title": _safe(point.get("title")),
                "explanation": _safe(point.get("explanation")),
                "quote": _safe(point.get("quote")),
                "document_index": point.get("document_index"),
                "page": point.get("page"),
            }
        )
    return kept


def _pages_read(documents: Sequence[Any], profile: ReadingProfile) -> int:
    selected, _ = profile.select_pages(documents, profile.prompt_chars)
    return sum(len(pages) for pages in selected.values())


def trial_profile(
    name: str,
    profile: ReadingProfile,
    documents: Sequence[Any],
    client: TrialClient,
    *,
    sale_id: str,
    source_url: str,
    sold_lot: Any,
    deadline: float,
    clock: Callable[[], float],
    sleep: Callable[[float], None],
) -> tuple[ProfileResult, str | None]:
    """One reading of the dossier with this profile. Returns the result and a stop reason, if any."""
    result = ProfileResult(profile=name, pages_read=_pages_read(filtered_for_model(documents), profile))
    last_error: list[Exception] = []
    raw_counts: list[int] = []

    def generate(system_prompt: str, user_prompt: str) -> Mapping[str, object]:
        try:
            payload = client.generate_json_once(system_prompt, user_prompt)  # type: ignore[attr-defined]
        except Exception as exc:
            last_error.append(exc)
            raise
        points = payload.get("points") if isinstance(payload, Mapping) else None
        raw_counts.append(len(points) if isinstance(points, list) else 0)
        return payload

    while True:
        if clock() >= deadline:
            return result, "durée maximale atteinte"
        last_error.clear()
        usage_start = len(client.usage)
        client.max_tokens = profile.max_output_tokens  # type: ignore[attr-defined]
        rejections: dict[str, int] = {}
        with llm_request_context(source_url=source_url, sale_id=sale_id, stage=TRIAL_STAGE, reason=TRIAL_REASON):
            reading = read_sale_documents(
                documents,
                generate_json=generate,
                model=str(client.model or ""),
                sold_lot=sold_lot,
                profile=profile,
                rejections=rejections,
            )
        result.usage.extend(client.usage[usage_start:])
        error = last_error[-1] if last_error else None
        if isinstance(error, CallCapReached):
            return result, str(error)
        if error is not None and _hourly_budget_refusal(error) and deadline - clock() > HOURLY_WAIT_SECONDS:
            # The hourly window shared with the pipeline frees up: the same reading is tried again later.
            result.budget_waits += 1
            sleep(HOURLY_WAIT_SECONDS)
            continue
        result.status = reading.status
        result.error = reading.error_code
        result.truncated = reading.input_truncated
        result.raw_points = raw_counts[-1] if raw_counts else 0
        result.points = point_texts(reading.points)
        result.rejections = rejections
        result.output_cut = any(
            call.output_tokens is not None and call.output_tokens >= profile.max_output_tokens * TRUNCATION_RATIO
            for call in result.usage
        )
        stop = None
        if error is not None and not reading.attempt_counted:
            stop = f"budget refusé : {str(error)[:200]}"
        return result, stop


def run_trial(
    connection: Any,
    client: TrialClient,
    *,
    options: TrialOptions,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> TrialReport:
    """Select the sales, read them again with each profile. Reads only; never writes to the database."""
    report = TrialReport(options=options, model=str(client.model or ""))
    deadline = clock() + options.budget_minutes * 60
    candidates = [(str(sale_id), int(count or 0)) for sale_id, count in connection.execute(CANDIDATES_SQL).fetchall()]
    connection.rollback()
    report.candidates = len(candidates)
    if options.sale_prefixes:
        report.selected = [
            sale_id for sale_id, _ in candidates if sale_id[:SALE_PREFIX_CHARS] in options.sale_prefixes
        ]
    else:
        report.selected = [sale_id for sale_id, _ in pick_varied(candidates, options.sales)]
    for sale_id in report.selected:
        if report.stop_reason is not None:
            break
        row = connection.execute(SALE_SQL, (sale_id,)).fetchone()
        # Each read ends its (read-only) transaction: none stays open while the model answers.
        connection.rollback()
        if row is None:
            continue
        (_, source_url, property_type, city, lot_selection, facts, manifest, points, version, truncated) = row
        documents = documents_from_manifest(manifest)
        result = SaleResult(
            sale_id=sale_id,
            documents=len(documents),
            pages=sum(len(doc.pages) for doc in documents),
            stored_version=str(version or ""),
            stored_truncated=bool(truncated),
            stored_points=point_texts(points),
            facts=fact_texts(facts),
        )
        report.results.append(result)
        if not documents:
            result.skipped = "aucun texte"
            continue
        sold_lot = sold_lot_from_sale(property_type, city, lot_selection)
        for name in options.profiles:
            if client.calls_made >= options.max_calls:
                report.stop_reason = f"plafond de {options.max_calls} appels atteint"
                break
            profile_result, stop = trial_profile(
                name,
                CANDIDATE_PROFILES[name],
                documents,
                client,
                sale_id=sale_id,
                source_url=str(source_url or ""),
                sold_lot=sold_lot,
                deadline=deadline,
                clock=clock,
                sleep=sleep,
            )
            result.profiles[name] = profile_result
            if stop is not None:
                report.stop_reason = stop
                break
    connection.rollback()
    return report


def _generic(points: Sequence[Mapping[str, object]]) -> int:
    return sum(1 for point in points if point.get("theme") == "conditions_vente")


def render_report(report: TrialReport) -> str:
    options = report.options
    lines = [
        f"## Essai de la lecture des pièces : {', '.join(options.profiles)} contre la lecture stockée",
        "",
        f"- Modèle : `{report.model}` ; plafond d'appels : {options.max_calls} ; "
        f"durée maximale : {options.budget_minutes:g} min.",
        f"- Ventes candidates (à venir, lecture terminée, faits complets) : {report.candidates} ; "
        f"retenues : {len(report.selected)} ; traitées : {len(report.results)}.",
        f"- Arrêt : {report.stop_reason or 'aucun (essai complet)'}.",
        "",
        "### Par vente (points gardés, dont « conditions de vente »)",
        "",
        "| Vente | Pièces / pages | Stockée | "
        + " | ".join(f"{name} : pages lues | {name} : rendus → gardés | {name} : rejets" for name in options.profiles)
        + " |",
        "|---|---|---|" + "---|---|---|" * len(options.profiles),
    ]
    for result in report.results:
        cells = [
            f"`{result.sale_id[:SALE_PREFIX_CHARS]}`",
            f"{result.documents} / {result.pages}",
            f"{len(result.stored_points)} ({_generic(result.stored_points)})"
            + (" tronquée" if result.stored_truncated else ""),
        ]
        for name in options.profiles:
            trial = result.profiles.get(name)
            if trial is None:
                cells += ["—", "—", "—"]
                continue
            if trial.status != "completed":
                cells += [str(trial.pages_read), f"{trial.status} ({trial.error or '—'})", "—"]
                continue
            rejects = ", ".join(f"{reason} {count}" for reason, count in sorted(trial.rejections.items())) or "—"
            cells += [
                f"{trial.pages_read}" + (" (tronquée)" if trial.truncated else ""),
                f"{trial.raw_points} → {len(trial.points)} ({_generic(trial.points)})"
                + (" sortie coupée" if trial.output_cut else ""),
                rejects,
            ]
        lines.append("| " + " | ".join(cells) + " |")
    lines += ["", "### Total", ""]
    compared = [result for result in report.results if result.profiles]
    lines.append(
        f"- Lecture stockée : {sum(len(r.stored_points) for r in compared)} points, dont "
        f"{sum(_generic(r.stored_points) for r in compared)} « conditions de vente »."
    )
    for name in options.profiles:
        trials = [r.profiles[name] for r in compared if name in r.profiles]
        done = [trial for trial in trials if trial.status == "completed"]
        usage = [call for trial in trials for call in trial.usage]
        lines.append(
            f"- {name} : {len(done)} lecture(s) sur {len(trials)} ; "
            f"{sum(len(trial.points) for trial in done)} points gardés sur "
            f"{sum(trial.raw_points for trial in done)} rendus, dont "
            f"{sum(_generic(trial.points) for trial in done)} « conditions de vente » ; "
            f"{sum(trial.output_cut for trial in done)} sortie(s) coupée(s) ; "
            f"jetons : {_fmt(_sum([call.input_tokens for call in usage]))} en entrée, "
            f"{_fmt(_sum([call.output_tokens for call in usage]))} en sortie ; "
            f"coût estimé : {_fmt_cost([call.cost_usd for call in usage])} ; "
            f"attentes du budget horaire : {sum(trial.budget_waits for trial in trials)}."
        )
    return "\n".join(lines) + "\n"


def render_details(report: TrialReport) -> str:
    """One ``READING_DETAIL {json}`` line per sale: fact lists, stored points, points of each profile."""
    lines = [
        json.dumps(
            {
                "sale_id": result.sale_id,
                "facts": result.facts,
                "stored": {"version": result.stored_version, "points": result.stored_points},
                "trials": {
                    name: {"status": trial.status, "truncated": trial.truncated, "points": trial.points}
                    for name, trial in result.profiles.items()
                },
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        for result in report.results
        if result.profiles
    ]
    if not lines:
        return ""
    return "::group::Détail des lectures\n" + "".join(f"READING_DETAIL {line}\n" for line in lines) + "::endgroup::\n"


def _names(known: Sequence[str], pattern: str) -> Callable[[str], tuple[str, ...]]:
    import re

    def parse(text: str) -> tuple[str, ...]:
        values = tuple(dict.fromkeys(item.strip() for item in text.split(",") if item.strip()))
        for value in values:
            if (known and value not in known) or not re.fullmatch(pattern, value):
                raise argparse.ArgumentTypeError(f"valeur refusée : {value[:40]}")
        return values

    return parse


def parse_args(argv: Sequence[str] | None = None) -> TrialOptions:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sales", type=_bounded_int(1, 30), default=DEFAULT_SALES)
    parser.add_argument(
        "--profiles", type=_names(tuple(CANDIDATE_PROFILES), r"[a-z0-9_]+"), default=tuple(CANDIDATE_PROFILES)
    )
    parser.add_argument(
        "--sale-prefixes",
        type=_names((), rf"[0-9a-f]{{{SALE_PREFIX_CHARS}}}"),
        default=(),
        help="first 8 characters of the sale ids to read, comma separated (instead of --sales)",
    )
    parser.add_argument("--max-calls", type=_bounded_int(1, 120), default=DEFAULT_MAX_CALLS)
    parser.add_argument("--budget-minutes", type=_bounded_int(1, 170), default=DEFAULT_BUDGET_MINUTES)
    args = parser.parse_args(argv)
    if not args.profiles:
        parser.error("--profiles : au moins un profil")
    return TrialOptions(
        sales=args.sales,
        profiles=args.profiles,
        sale_prefixes=args.sale_prefixes,
        max_calls=args.max_calls,
        budget_minutes=args.budget_minutes,
    )


def main(argv: Sequence[str] | None = None) -> int:
    options = parse_args(argv)
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not db_url:
        print("SUPABASE_DB_URL est requise (lecture des ventes).", file=sys.stderr)
        return 2
    client = MeteredReplicateClient().start_meter(options.max_calls)
    client.max_retries = 0
    if not client.is_available():
        print("REPLICATE_API_TOKEN est requise.", file=sys.stderr)
        return 2
    from src.storage.supabase_client import connect

    connection = connect(str(db_url))
    try:
        # Every statement of this connection runs in a READ ONLY transaction: a write would fail.
        connection.read_only = True
        report = run_trial(connection, client, options=options)
    finally:
        connection.close()
    publish(render_report(report))
    # Standard output only: the step summary keeps the counts.
    sys.stdout.write(render_details(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
