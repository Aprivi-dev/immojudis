"""Banc de comparaison : lecture des pièces par deux modèles Claude, contre la chaîne actuelle.

Lot V1, mode fantôme. Prend les N ventes à venir dont les pièces ont été lues le plus récemment par la chaîne
actuelle (texte des pages ``pdf_text`` et extraction des faits complète), choisit au plus dix pages par vente
(``src.document_vision.select_vision_pages``), en découpe un extrait PDF que Claude Haiku 5.5 lit en entier, puis
fait relire à Claude Sonnet 5.5 les seules pages citées par les valeurs qui seraient retenues. Le verdict par champ
(``src.document_vision``) est comparé à la valeur actuelle de la fiche.

LECTURE SEULE sur les ventes : la connexion qui les lit est en lecture seule et rien n'est écrit sur une fiche.
Restent, comme pour tout appel du pipeline : la réservation et le compte rendu de chaque appel au modèle dans
``llm_usage_events`` (étape ``vision_trial``), dans le budget quotidien partagé (un refus arrête le banc
proprement), et la copie partagée des robots.txt lors du téléchargement poli des pièces.

Le rapport est agrégé : par champ, accords, désaccords, « inconnu », rejets, écarts avec la fiche, et coût réel
de chaque lecteur. Il ne contient ni identifiant de vente, ni citation, ni texte des pièces.

    python -m scripts.compare_document_vision --sample 10 --output document-vision-report.md
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tempfile
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from scripts.fact_chunk_trial import SALE_COLUMNS, _bounded_int, publish, sale_from_row  # noqa: E402
from src.config import load_settings  # noqa: E402
from src.document_reading import (  # noqa: E402
    ReadingDocument,
    documents_from_manifest,
    injected_pages,
    sold_lot_from_sale,
    without_pages,
)
from src.document_vision import (  # noqa: E402
    ACCEPTED,
    CANDIDATE,
    DISAGREEMENT,
    FIELDS,
    REJECTED,
    SYSTEM_PROMPT,
    UNKNOWN_STATUS,
    PageRef,
    Reading,
    SaleContext,
    Verdict,
    build_user_prompt,
    cited_pages,
    compare_with_sale,
    final_verdicts,
    parse_reading,
    pdf_extract,
    primary_verdicts,
    response_schema,
    select_vision_pages,
)
from src.enrichment.anthropic_reader import HAIKU, SONNET, AnthropicDocumentReader, ReaderCall  # noqa: E402
from src.french_dates import PARIS  # noqa: E402
from src.llm_requests import llm_request_context  # noqa: E402
from src.lot_scope import is_lot_scoped  # noqa: E402
from src.pipeline_usage import LLMModelNotPriced, PipelineBudgetExhausted  # noqa: E402

MAX_SAMPLE = 30
TRIAL_STAGE = "vision_trial"
TRIAL_REASON = "document_vision_comparison"
DEFAULT_OUTPUT = "document-vision-report.md"

# Ventes à venir dont les pièces ont été lues par la chaîne actuelle (texte des pages persisté, extraction des
# faits complète), les plus récemment lues d'abord. Seuls les identifiants sont lus ici.
CANDIDATES_SQL = """
select sale.id::text
  from public.auction_sales sale
  join lateral (
    select extraction.updated_at
      from public.auction_extractions extraction
     where extraction.source_url = sale.source_url
       and extraction.provider = 'pdf_text'
       and jsonb_typeof(extraction.result) = 'array'
     order by extraction.updated_at desc
     limit 1
  ) latest on true
 where sale.status in ('upcoming', 'unknown', 'postponed')
   and (sale.sale_date is null or sale.sale_date >= now())
   and not app_private.sale_is_fully_withdrawn(
     sale.source_name, sale.observations, (select app_private.catalogue_withdrawn_sources())
   )
   and sale.raw_payload -> 'llm_fact_coverage' ->> 'complete' = 'true'
 order by latest.updated_at desc, sale.id
 limit %s
"""

SALE_VALUE_COLUMNS = (
    "property_type",
    "quality_flags",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
    "rooms_count",
    "occupancy_status",
    "visit_dates",
)
SALE_SQL = f"""
select {", ".join(f"sale.{column}" for column in (*SALE_COLUMNS, *SALE_VALUE_COLUMNS))}, latest.result
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

Generate = Callable[[str, str, bytes, Mapping[str, Any]], Mapping[str, object]]
FetchPdfs = Callable[[Mapping[str, Any], Sequence[str]], Mapping[str, bytes]]


class BenchStopped(RuntimeError):
    """Le budget ou le plafond d'appels arrête le banc : la vente en cours n'est pas comptée."""


@dataclass
class ReaderStats:
    model: str
    calls: int = 0
    failures: int = 0
    pages: int = 0
    usage: list[ReaderCall] = field(default_factory=list)


@dataclass
class FieldStats:
    statuses: Counter[str] = field(default_factory=Counter)
    reasons: Counter[str] = field(default_factory=Counter)
    versus_sale: Counter[str] = field(default_factory=Counter)


@dataclass
class BenchReport:
    sample: int
    candidates: int = 0
    processed: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    fields: dict[str, FieldStats] = field(default_factory=lambda: {name: FieldStats() for name in FIELDS})
    readers: dict[str, ReaderStats] = field(default_factory=dict)
    stop_reason: str | None = None


@dataclass
class Reader:
    """Un lecteur : son appel au modèle, son plafond d'appels et ses compteurs."""

    role: str
    generate: Generate
    stats: ReaderStats
    max_calls: int

    def read(self, user_prompt: str, pdf: bytes, fields: Sequence[str], pages: Sequence[PageRef]) -> Reading | None:
        if self.stats.calls >= self.max_calls:
            raise BenchStopped(f"{self.role} : plafond de {self.max_calls} appels atteint")
        self.stats.calls += 1
        self.stats.pages += len(pages)
        try:
            payload = self.generate(SYSTEM_PROMPT, user_prompt, pdf, response_schema(fields))
        except (PipelineBudgetExhausted, LLMModelNotPriced) as exc:
            # Budget quotidien ou horaire, issue incertaine d'un appel, palier de prix dépassé : on s'arrête.
            raise BenchStopped(f"{self.role} : {type(exc).__name__}") from exc
        except Exception:
            self.stats.failures += 1
            return None
        return parse_reading(payload, fields, pages)


def sale_context(raw_payload: Mapping[str, Any], property_type: object, city: object, quality_flags: object) -> SaleContext:
    """Le lot vendu, s'il est désigné, et si la vente porte sur une annonce à plusieurs lots."""
    flags = quality_flags if isinstance(quality_flags, list) else []
    several = is_lot_scoped(dict(raw_payload)) or "multi_lot_sale" in flags or bool(raw_payload.get("pdf_multi_lot_guard"))
    return SaleContext(
        sold_lot=sold_lot_from_sale(property_type, city, raw_payload.get("source_lot_selection")),
        several_lots=several,
    )


def readable_documents(manifest: object, pdfs: Mapping[str, bytes]) -> dict[int, bytes]:
    """Le PDF de chaque pièce, seulement s'il est celui dont le texte a été lu (même empreinte quand elle est connue)."""
    by_url: dict[str, bytes] = {}
    for item in manifest if isinstance(manifest, list) else []:
        if not isinstance(item, Mapping):
            continue
        url = item.get("url")
        content = pdfs.get(url) if isinstance(url, str) else None
        if content is None:
            continue
        expected = item.get("sha256")
        if isinstance(expected, str) and expected and hashlib.sha256(content).hexdigest() != expected:
            continue
        by_url[str(url)] = content
    return {doc.index: by_url[doc.url] for doc in documents_from_manifest(manifest) if doc.url in by_url}


def compare_sale(
    row: Mapping[str, Any],
    primary: Reader,
    second: Reader,
    fetch_pdfs: FetchPdfs,
    *,
    today: date,
) -> tuple[dict[str, Verdict] | None, str | None]:
    """Verdicts d'une vente, ou la raison pour laquelle elle n'est pas comparée."""
    raw_payload = row.get("raw_payload") if isinstance(row.get("raw_payload"), Mapping) else {}
    manifest = row.get("result")
    documents: list[ReadingDocument] = documents_from_manifest(manifest)
    # Une page qui s'adresse à un modèle n'est jamais lue (même détecteur que la lecture des pièces).
    documents = without_pages(documents, injected_pages(documents))
    pages = select_vision_pages(documents)
    if not pages:
        return None, "aucune page sur les champs visés"
    urls = sorted({doc.url for doc in documents if doc.url and any(ref.document == doc.index for ref in pages)})
    try:
        pdfs = readable_documents(manifest, fetch_pdfs(row, urls))
    except Exception:
        return None, "pièces non téléchargées"
    extract, pages = pdf_extract(pdfs, pages)
    if not pages:
        return None, "pièces modifiées ou illisibles depuis leur lecture"
    context = sale_context(raw_payload, row.get("property_type"), row.get("city"), row.get("quality_flags"))
    texts = {doc.index: doc.pages for doc in documents}
    context.page_texts = {ref: texts[ref.document][ref.page] for ref in pages}
    with llm_request_context(
        sale_id=str(row.get("id") or ""), source_url=str(row.get("source_url") or ""), stage=TRIAL_STAGE, reason=TRIAL_REASON
    ):
        reading = primary.read(build_user_prompt(pages, FIELDS, today=today, sold_lot=context.sold_lot), extract, FIELDS, pages)
        if reading is None:
            return None, "lecture principale en échec"
        candidates = primary_verdicts(reading, context, today=today)
        fields = [name for name, verdict in candidates.items() if verdict.status == CANDIDATE]
        second_reading = None
        if fields:
            second_extract, second_pages = pdf_extract(pdfs, cited_pages(candidates))
            second_reading = second.read(
                build_user_prompt(second_pages, fields, today=today, sold_lot=context.sold_lot),
                second_extract,
                fields,
                second_pages,
            )
    return final_verdicts(candidates, second_reading, context, today=today), None


def run_bench(
    connection: Any,
    primary: Reader,
    second: Reader,
    fetch_pdfs: FetchPdfs,
    *,
    sample: int,
    today: date,
) -> BenchReport:
    """Lit les ventes (lecture seule), les compare et agrège le résultat. Aucune écriture sur une vente."""
    report = BenchReport(sample=sample, readers={"principal": primary.stats, "second": second.stats})
    sale_ids = [str(row[0]) for row in connection.execute(CANDIDATES_SQL, (sample,)).fetchall()]
    connection.rollback()
    report.candidates = len(sale_ids)
    columns = (*SALE_COLUMNS, *SALE_VALUE_COLUMNS, "result")
    for sale_id in sale_ids:
        fetched = connection.execute(SALE_SQL, (sale_id,)).fetchone()
        # Chaque lecture termine sa transaction : aucune ne reste ouverte pendant que le modèle répond.
        connection.rollback()
        if fetched is None:
            report.skipped["vente introuvable"] += 1
            continue
        row = dict(zip(columns, fetched, strict=True))
        try:
            verdicts, skipped = compare_sale(row, primary, second, fetch_pdfs, today=today)
        except BenchStopped as exc:
            report.stop_reason = str(exc)
            break
        if verdicts is None:
            report.skipped[skipped or "non traitée"] += 1
            continue
        report.processed += 1
        for name, verdict in verdicts.items():
            stats = report.fields[name]
            stats.statuses[verdict.status] += 1
            if verdict.reason:
                stats.reasons[verdict.reason] += 1
            if verdict.status == ACCEPTED:
                stats.versus_sale[compare_with_sale(name, verdict.value, row.get(name), today=today)] += 1
    connection.rollback()
    return report


def _known_cost(usage: Sequence[ReaderCall]) -> Decimal:
    return sum((call.cost_usd for call in usage if call.cost_usd is not None), Decimal(0))


def _tokens(values: Sequence[int | None]) -> str:
    known = [value for value in values if value is not None]
    return f"{sum(known):,}".replace(",", " ") if known else "0"


def render_report(report: BenchReport) -> str:
    """Rapport Markdown agrégé : aucun identifiant de vente, aucune citation, aucun texte des pièces."""
    lines = [
        "## Banc de lecture des pièces (mode fantôme)",
        "",
        f"- Échantillon demandé : {report.sample} ; ventes candidates : {report.candidates} ; "
        f"comparées : {report.processed}.",
        f"- Arrêt : {report.stop_reason or 'aucun (banc complet)'}.",
    ]
    for reason, count in sorted(report.skipped.items()):
        lines.append(f"- Ventes non comparées, {reason} : {count}.")
    lines += [
        "",
        "### Par champ",
        "",
        "| Champ | Retenues (accord) | Désaccords | Inconnu | Rejets | Retenue = fiche | Retenue ≠ fiche | Fiche vide |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for name, stats in report.fields.items():
        lines.append(
            f"| {name} | {stats.statuses[ACCEPTED]} | {stats.statuses[DISAGREEMENT]} | {stats.statuses[UNKNOWN_STATUS]} "
            f"| {stats.statuses[REJECTED]} | {stats.versus_sale['same']} | {stats.versus_sale['different']} "
            f"| {stats.versus_sale['empty']} |"
        )
    lines += ["", "### Motifs des désaccords et des rejets", ""]
    for name, stats in report.fields.items():
        reasons = ", ".join(f"{reason} {count}" for reason, count in sorted(stats.reasons.items())) or "aucun"
        lines.append(f"- {name} : {reasons}.")
    lines += ["", "### Lecteurs et coût réel", ""]
    for role, stats in report.readers.items():
        unpriced = sum(1 for call in stats.usage if call.cost_usd is None)
        lines.append(
            f"- {role} (`{stats.model}`) : {stats.calls} appel(s), {stats.failures} en échec, {stats.pages} page(s) ; "
            f"jetons facturés : {_tokens([call.input_tokens for call in stats.usage])} en entrée, "
            f"{_tokens([call.output_tokens for call in stats.usage])} en sortie (réflexion comprise) ; "
            f"coût : {_known_cost(stats.usage):.4f} $"
            + (f" ; {unpriced} appel(s) sans jetons connus (issue incertaine ou erreur)" if unpriced else "")
            + "."
        )
    total = sum((_known_cost(stats.usage) for stats in report.readers.values()), Decimal(0))
    lines.append(f"- Total (un dollar compté pour un euro) : {total:.4f} €.")
    return "\n".join(lines) + "\n"


def download_sale_pdfs(row: Mapping[str, Any], urls: Sequence[str]) -> dict[str, bytes]:
    """Les pièces ``urls`` de la vente, par le téléchargement poli du pipeline (robots.txt, cadence par hôte,
    sources retirées, garde d'Enchères Publiques), dans un dossier temporaire effacé ensuite."""
    from src.pdf_enrichment import download_documents

    sale = sale_from_row(row)
    wanted = set(urls)
    sale.documents = [document for document in sale.documents if document.get("url") in wanted]
    # Copie en mémoire : sans l'état de lecture des pièces, la sélection ne saute pas les pièces déjà lues
    # (celles-là mêmes dont on veut les pages).
    sale.raw_payload = {key: value for key, value in sale.raw_payload.items() if key != "document_analysis"}
    with tempfile.TemporaryDirectory(prefix="document-vision-") as directory:
        downloaded = download_documents(sale, output_root=Path(directory))
        return {
            str(item["url"]): Path(item["file_path"]).read_bytes()
            for item in downloaded
            if item.get("file_format") == "pdf" and item.get("url") in wanted
        }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sample", type=_bounded_int(1, MAX_SAMPLE), required=True)
    parser.add_argument("--output", type=Path, default=Path(DEFAULT_OUTPUT))
    return parser.parse_args(argv)


def _reader(role: str, model: str, max_calls: int) -> Reader:
    client = AnthropicDocumentReader(model=model)
    return Reader(role, client.generate_json_with_pdf, ReaderStats(model=model, usage=client.usage), max_calls)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not db_url:
        print("SUPABASE_DB_URL est requise (lecture des ventes).", file=sys.stderr)
        return 2
    if not settings.get("anthropic_api_key"):
        print("ANTHROPIC_API_KEY est requise.", file=sys.stderr)
        return 2
    # Au plus un appel de chaque lecteur par vente.
    primary = _reader("principal", HAIKU, args.sample)
    second = _reader("second", SONNET, args.sample)
    from src.storage.supabase_client import connect

    connection = connect(str(db_url))
    try:
        # Chaque requête de cette connexion tourne dans une transaction READ ONLY : une écriture échouerait.
        connection.read_only = True
        report = run_bench(
            connection, primary, second, download_sale_pdfs, sample=args.sample, today=datetime.now(PARIS).date()
        )
    finally:
        connection.close()
    markdown = render_report(report)
    args.output.write_text(markdown, encoding="utf-8")
    publish(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
