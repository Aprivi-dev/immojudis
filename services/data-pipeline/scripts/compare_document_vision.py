"""Banc de comparaison : lecture des pièces par deux modèles Claude, contre la chaîne actuelle.

Lots V1 et V2, mode fantôme. Prend les N ventes à venir dont les pièces ont été lues le plus récemment par la chaîne
actuelle (texte des pages ``pdf_text`` et extraction des faits complète), choisit au plus dix pages par vente
(``src.document_vision.select_vision_pages``), en découpe un extrait PDF que Claude Haiku 5.5 lit en entier, puis
fait relire à Claude Sonnet 5.5 les seules pages citées par les valeurs qui seraient retenues. Le verdict par champ
(``src.document_vision``) est comparé à la valeur actuelle de la fiche. Une page citée en partie image, que ni la
couche texte ni l'OCR du pipeline ne couvrent, est lue par Tesseract (``src.pdf_ocr``) le temps de la vérification.
Une vente exclue de la lecture automatique des pièces (``src.document_reading_exclusions``) n'est jamais prise.
La lecture elle-même (pièces, pages, lecteurs, verdicts) est celle de la passe d'écriture du lot V3b-1 :
``src.document_vision_reading`` et ``src.document_vision_pieces``. Le banc y ajoute ses comptes et son rapport.

LECTURE SEULE sur les ventes : la connexion qui les lit est passée en lecture seule avant sa première requête et rien
n'est écrit sur une fiche. Restent, comme pour tout appel du pipeline : la réservation et le compte rendu de chaque
appel au modèle dans ``llm_usage_events`` (étape ``vision_trial``), dans le budget quotidien partagé (un refus arrête
le banc proprement), et la copie partagée des robots.txt lors du téléchargement poli des pièces. Le banc s'arrête
aussi avant qu'un appel puisse porter sa propre dépense au-delà de ``--max-usd``.

Le rapport est agrégé : par champ, accords, désaccords, « inconnu », rejets, écarts avec la fiche, diagnostic des
rejets et des « inconnu », et pour chaque lecteur ses échecs par type et son coût réel. Il ne contient ni
identifiant de vente, ni citation, ni texte, ni URL des pièces (le journal du téléchargement est réduit aux
erreurs).

Liste des écarts, en option (``--differences CHEMIN``, activée par le workflow, en artefact) : pour chaque valeur
retenue qui diffère de la fiche, l'identifiant de la vente, le champ, les deux valeurs, le numéro et le type de la
pièce et le numéro de page, en JSON Lines (mode 0600). Jamais la citation, ni aucun texte de la pièce, ni son URL :
l'URL se retrouve en base, en lecture seule, pour vérifier en relisant la page qui a raison.

Revue privée des écarts, en option seulement (``--private-review CHEMIN``) : la même chose avec la citation, dans un
fichier JSON Lines lisible du seul propriétaire (mode 0600). Jamais par défaut, jamais en artefact : le workflow ne
l'active pas.

    python -m scripts.compare_document_vision --sample 10 --max-usd 3 --output document-vision-report.md
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, TextIO

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from scripts.fact_chunk_trial import SALE_COLUMNS, _bounded_int, publish, sale_from_row  # noqa: E402
from src.config import load_settings  # noqa: E402
from src.document_reading import ReadingDocument  # noqa: E402
from src.document_vision import (  # noqa: E402
    ACCEPTED,
    BENCH_OCR,
    CANDIDATE,
    CUE_NOT_SENT,
    CUE_SENT,
    DISAGREEMENT,
    EXACT,
    FIELDS,
    LOT_UNCERTAIN,
    MAX_PAGES,
    NATIVE_TEXT_DIFFERS,
    NO_CUE,
    NO_TEXT,
    NORMALIZED,
    OCR_TEXT_DIFFERS,
    OCR_TOLERANCE,
    ONE_LOT,
    ONE_LOT_GUARDED,
    OTHER_PAGE,
    PAST_VISITS,
    PROMPT_VERSION,
    REJECTED,
    SEVERAL_LOTS,
    UNKNOWN_STATUS,
    VISITS,
    Verdict,
    compare_with_sale,
    page_field_score,
    visit_days,
)
from src.document_vision_pieces import (  # noqa: E402
    NO_PDF_OTHER,
    NO_PDF_REASONS,
    UNUSABLE_REASONS,
    FetchedPieces,
    FetchPdfs,
    download_sale_pdfs,
    manifest_pages,
    page_number,
)
from src.document_vision_reading import (  # noqa: E402
    CANDIDATE_SALES_SQL,
    FAILURE_KINDS,
    PRIMARY_TIMEOUT_SECONDS,
    SECOND_TIMEOUT_SECONDS,
    Reader,
    ReaderStats,
    ReadingStopped,
    SpendCap,
    anthropic_reader,
    read_sale,
)
from src.enrichment.anthropic_reader import HAIKU, SONNET, ReaderCall  # noqa: E402
from src.french_dates import PARIS  # noqa: E402
from src.pdf_document_types import (  # noqa: E402
    PDF_CONDITIONS_GROUP,
    PDF_DESCRIPTION_GROUP,
    PDF_DIAGNOSTICS_GROUP,
)
from src.pdf_page_analysis import SETTLED_EXCLUDED_PAGE_STATUSES  # noqa: E402

MAX_SAMPLE = 30
DEFAULT_MAX_USD = Decimal("3")
TRIAL_STAGE = "vision_trial"
TRIAL_REASON = "document_vision_comparison"
DEFAULT_OUTPUT = "document-vision-report.md"

# Les ventes que la lecture peut prendre (``CANDIDATE_SALES_SQL`` : exclues écartées avant tout téléchargement), les
# plus récemment lues d'abord. Seuls les identifiants sont lus ici.
CANDIDATES_SQL = f"""
select sale.id::text
{CANDIDATE_SALES_SQL}
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


@dataclass
class FieldStats:
    statuses: Counter[str] = field(default_factory=Counter)
    reasons: Counter[str] = field(default_factory=Counter)
    versus_sale: Counter[str] = field(default_factory=Counter)
    # Détail de diagnostic des verdicts finaux, par « motif ou statut:détail » (``Verdict.detail``).
    details: Counter[str] = field(default_factory=Counter)
    # Citations des candidats du lecteur principal, par façon dont elles ont été retrouvées.
    quote_matches: Counter[str] = field(default_factory=Counter)


@dataclass
class PageStats:
    """Pages des ventes comparées : ce que la sélection pouvait envoyer et ce qu'elle a envoyé."""

    with_field_words: int = 0
    sent: int = 0
    # Ventes dont le plafond de pages a laissé de côté des pages qui parlent des champs.
    capped_sales: int = 0
    # Pages du dossier sans texte exploitable (scan non lu), hors pages blanches et pages de photographies réglées.
    unread: int = 0
    # Pages qui parlent des champs mais que l'extrait ne peut pas porter, par motif (:func:`usable_documents`).
    unusable: Counter[str] = field(default_factory=Counter)
    # Pièces demandées et non obtenues, par motif (:data:`NO_PDF_REASONS`), dans toutes les ventes dont les pièces
    # ont été demandées, comparées ou non.
    missing_pieces: Counter[str] = field(default_factory=Counter)


@dataclass
class BenchReport:
    sample: int
    max_usd: Decimal = DEFAULT_MAX_USD
    candidates: int = 0
    processed: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    fields: dict[str, FieldStats] = field(default_factory=lambda: {name: FieldStats() for name in FIELDS})
    pages: PageStats = field(default_factory=PageStats)
    unreadable: Counter[str] = field(default_factory=Counter)
    readers: dict[str, ReaderStats] = field(default_factory=dict)
    stop_reason: str | None = None


@dataclass
class SaleResult:
    """Ce que la comparaison d'une vente rend au banc : verdicts, pièces lues, chiffres de la sélection."""

    primary: dict[str, Verdict]
    final: dict[str, Verdict]
    documents: dict[int, ReadingDocument]
    pages: PageStats
    # Pièces que pymupdf n'a pas ouvertes pendant la vérification, par type d'erreur.
    unreadable: Counter[str] = field(default_factory=Counter)


def unread_page_count(manifest: object, documents: Sequence[ReadingDocument]) -> int:
    """Pages du dossier sans texte exploitable, hors pages blanches et pages de photographies réglées : un modèle qui
    lit l'image pourrait y trouver une valeur, mais la sélection, qui part du texte, ne peut pas les choisir."""
    read = {(doc.url, number) for doc in documents for number in doc.pages}
    return sum(
        1
        for url, page in manifest_pages(manifest)
        if (url, page_number(page)) not in read and page.get("status") not in SETTLED_EXCLUDED_PAGE_STATUSES
    )


def compare_sale(
    row: Mapping[str, Any],
    primary: Reader,
    second: Reader,
    fetch_pdfs: FetchPdfs,
    *,
    today: date,
) -> tuple[SaleResult | None, str | None]:
    """Verdicts d'une vente, ou la raison pour laquelle elle n'est pas comparée."""
    reading, skipped = read_sale(row, primary, second, fetch_pdfs, today=today, stage=TRIAL_STAGE, reason=TRIAL_REASON)
    if reading is None:
        return None, skipped
    with_field_words = sum(1 for doc in reading.usable for text in doc.pages.values() if page_field_score(text) > 0)
    page_stats = PageStats(
        with_field_words=with_field_words,
        sent=len(reading.pages),
        capped_sales=int(with_field_words > MAX_PAGES),
        unread=unread_page_count(row.get("result"), reading.all_documents),
        unusable=reading.unusable,
    )
    return SaleResult(reading.primary, reading.final, reading.documents, page_stats, reading.unreadable), None


def _jsonable(value: object) -> object:
    if isinstance(value, (frozenset, set)):
        return sorted(_jsonable(item) for item in value)  # type: ignore[type-var]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, (date, Decimal)):
        return str(value)
    return value


# Type de pièce de la liste des écarts : une liste fermée, tirée du seul type normalisé de la pièce, jamais de son
# libellé ni de son URL.
_DIFFERENCE_DOCUMENT_TYPES = (
    ("cahier", PDF_CONDITIONS_GROUP),
    ("proces_verbal", PDF_DESCRIPTION_GROUP),
    ("diagnostic", PDF_DIAGNOSTICS_GROUP),
)
DIFFERENCE_OTHER_DOCUMENT = "autre"


def difference_document_type(document_type: str) -> str:
    """« cahier », « proces_verbal », « diagnostic » ou « autre »."""
    return next((name for name, group in _DIFFERENCE_DOCUMENT_TYPES if document_type in group), DIFFERENCE_OTHER_DOCUMENT)


def public_difference(row: Mapping[str, Any], name: str, verdict: Verdict, result: SaleResult) -> dict[str, object]:
    """Une ligne de la liste des écarts (``--differences``, en artefact) : l'identifiant de la vente
    (``auction_sales.id``), le champ, la valeur retenue, celle de la fiche, la pièce (son numéro dans le dossier, D1…Dn
    de ``documents_from_manifest``, et son type, :func:`difference_document_type`) et le numéro de page.

    Rien qui vienne du texte d'une pièce ni de son adresse : ni la citation, ni le libellé, ni l'URL (un jeton signé ou
    un nom peuvent s'y trouver ; elle se retrouve en base, en lecture seule, par la vente et le numéro de la pièce).
    Les dates de visite de la fiche, texte libre (une adresse, un nom, un téléphone peuvent s'y trouver), sont
    données par les seuls jours qu'elles nomment (:func:`visit_days` ; le banc n'en compare que les jours à venir).
    """
    page = verdict.page
    document = result.documents.get(page.document) if page is not None else None
    sale_value = row.get(name)
    return {
        "sale_id": str(row.get("id") or ""),
        "field": name,
        "retained_value": _jsonable(verdict.value),
        "sale_value": _jsonable(visit_days(sale_value) if name == VISITS else sale_value),
        "document_index": page.document if page is not None else None,
        "document_type": difference_document_type(document.document_type) if document is not None else None,
        "page": page.page if page is not None else None,
    }


def private_difference(row: Mapping[str, Any], name: str, verdict: Verdict, result: SaleResult) -> dict[str, object]:
    """Une ligne de la revue privée : la vente, le champ, la valeur retenue, celle de la fiche, la citation, la page."""
    page = verdict.page
    document = result.documents.get(page.document) if page is not None else None
    return {
        "sale_id": str(row.get("id") or ""),
        "source_url": row.get("source_url"),
        "field": name,
        "retained_value": _jsonable(verdict.value),
        "sale_value": _jsonable(row.get(name)),
        "quote": verdict.quote,
        "document": {"ref": document.ref, "label": document.label, "url": document.url} if document else None,
        "page": page.page if page is not None else None,
    }


def open_private_review(path: Path) -> TextIO:
    """Ouvre la revue privée, ou la liste des écarts (JSON Lines), lisible du seul propriétaire (0600, même si le
    fichier existait). Un lien symbolique n'est pas suivi : le fichier visé ne peut pas être ailleurs que là où on
    l'a dit."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    handle = os.fdopen(descriptor, "w", encoding="utf-8")
    os.fchmod(handle.fileno(), 0o600)
    return handle


def write_difference(handle: TextIO, entry: Mapping[str, object]) -> None:
    """Une ligne par écart, écrite tout de suite : un banc arrêté en route garde les écarts déjà vus."""
    handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    handle.flush()


def run_bench(
    connection: Any,
    primary: Reader,
    second: Reader,
    fetch_pdfs: FetchPdfs,
    *,
    sample: int,
    today: date,
    private_review: Callable[[dict[str, object]], None] | None = None,
    differences: Callable[[dict[str, object]], None] | None = None,
) -> BenchReport:
    """Lit les ventes (lecture seule), les compare et agrège le résultat. Aucune écriture sur une vente.

    ``private_review`` : s'il est donné, il reçoit, au fil du banc, chaque valeur retenue qui diffère de la fiche
    (:func:`private_difference`) ; elle n'entre jamais dans le rapport. ``differences`` : de même, la ligne publique
    de chacun de ces écarts (:func:`public_difference`).
    """
    # Avant la première requête : chaque transaction de cette connexion est READ ONLY, une écriture échouerait.
    connection.read_only = True
    report = BenchReport(
        sample=sample, max_usd=primary.spend.max_usd, readers={"principal": primary.stats, "second": second.stats}
    )

    def fetch_and_count(row: Mapping[str, Any], urls: Sequence[str]) -> FetchedPieces:
        # Les pièces non obtenues sont comptées pour toute vente dont les pièces sont demandées, même si elle n'est
        # pas comparée ensuite (« aucune page utilisable »).
        fetched = fetch_pdfs(row, urls)
        report.pages.missing_pieces.update(
            fetched.missing.get(url, NO_PDF_OTHER) for url in urls if url not in fetched.pdfs
        )
        return fetched

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
            result, skipped = compare_sale(row, primary, second, fetch_and_count, today=today)
        except ReadingStopped as exc:
            report.stop_reason = str(exc)
            break
        if result is None:
            report.skipped[skipped or "non traitée"] += 1
            continue
        report.processed += 1
        report.pages.with_field_words += result.pages.with_field_words
        report.pages.sent += result.pages.sent
        report.pages.capped_sales += result.pages.capped_sales
        report.pages.unread += result.pages.unread
        report.pages.unusable.update(result.pages.unusable)
        report.unreadable.update(result.unreadable)
        for name, verdict in result.primary.items():
            if verdict.status == CANDIDATE and verdict.detail:
                report.fields[name].quote_matches[verdict.detail] += 1
        for name, verdict in result.final.items():
            stats = report.fields[name]
            stats.statuses[verdict.status] += 1
            if verdict.reason:
                stats.reasons[verdict.reason] += 1
            if verdict.detail:
                stats.details[f"{verdict.reason or verdict.status}:{verdict.detail}"] += 1
            if verdict.status == ACCEPTED:
                versus = compare_with_sale(name, verdict.value, row.get(name), today=today)
                stats.versus_sale[versus] += 1
                if versus == "different" and private_review is not None:
                    private_review(private_difference(row, name, verdict, result))
                if versus == "different" and differences is not None:
                    differences(public_difference(row, name, verdict, result))
    connection.rollback()
    return report


def _known_cost(usage: Sequence[ReaderCall]) -> Decimal:
    return sum((call.cost_usd for call in usage if call.cost_usd is not None), Decimal(0))


def _tokens(values: Sequence[int | None]) -> str:
    known = [value for value in values if value is not None]
    return f"{sum(known):,}".replace(",", " ") if known else "0"


# Tableaux du diagnostic : (titre, clé « motif ou statut » des détails, colonnes (détail, libellé)). Libellés fixes :
# rien de ce qui vient d'une vente n'entre dans le rapport.
_DIAGNOSTIC_TABLES = (
    (
        "Citations introuvables, selon la page citée",
        "citation_introuvable",
        (
            (NO_TEXT, "Sans couche texte ni OCR"),
            (OTHER_PAGE, "Sur une autre page envoyée"),
            (NATIVE_TEXT_DIFFERS, "Couche texte, citation absente"),
            (OCR_TEXT_DIFFERS, "OCR, citation absente"),
        ),
    ),
    (
        "Lot non identifié, selon la fiche",
        "lot_non_identifie",
        (
            (ONE_LOT, "Un lot (dossier ou lecteur : plusieurs)"),
            (ONE_LOT_GUARDED, "Un lot, biens concurrents dans les pièces"),
            (SEVERAL_LOTS, "Plusieurs lots"),
            (LOT_UNCERTAIN, "Lot inconnu"),
        ),
    ),
    (
        "« Inconnu », selon les pages",
        UNKNOWN_STATUS,
        (
            (CUE_SENT, "Indice dans les pages envoyées (pas de réponse)"),
            (CUE_NOT_SENT, "Indice hors des pages envoyées"),
            (NO_CUE, "Aucun indice dans le texte"),
            (PAST_VISITS, "Dates passées"),
        ),
    ),
)
_QUOTE_MATCH_COLUMNS = (
    (EXACT, "Exacte (règle V1)"),
    (NORMALIZED, "Typographie normalisée"),
    (OCR_TOLERANCE, "Tolérance OCR"),
    (BENCH_OCR, "OCR de la page par le banc"),
)


def _counts_table(title: str, columns: Sequence[tuple[str, str]], counts: Callable[[FieldStats, str], int], report: BenchReport) -> list[str]:
    lines = [f"#### {title}", "", "| Champ | " + " | ".join(label for _, label in columns) + " |"]
    lines.append("|---" * (len(columns) + 1) + "|")
    for name, stats in report.fields.items():
        lines.append(f"| {name} | " + " | ".join(str(counts(stats, key)) for key, _ in columns) + " |")
    return [*lines, ""]


def render_report(report: BenchReport) -> str:
    """Rapport Markdown agrégé : aucun identifiant de vente, aucune citation, aucun texte des pièces."""
    lines = [
        "## Banc de lecture des pièces (mode fantôme)",
        "",
        f"- Échantillon demandé : {report.sample} ; ventes candidates : {report.candidates} ; "
        f"comparées : {report.processed} ; plafond de dépense : {report.max_usd} $.",
        f"- Version du prompt : {PROMPT_VERSION}.",
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
    pages = report.pages
    lines += [
        "",
        "### Diagnostic",
        "",
        f"- Pages : {pages.with_field_words} parlent des champs dans un PDF utilisable, {pages.sent} envoyées au "
        f"lecteur principal ; ventes dont le plafond de {MAX_PAGES} pages en a laissé de côté : {pages.capped_sales} ; "
        f"pages sans texte exploitable (scan non lu), que la sélection ne peut pas choisir : {pages.unread}.",
        "- Pages qui parlent des champs, écartées faute de PDF utilisable : "
        + ", ".join(f"{reason} {pages.unusable[reason]}" for reason in UNUSABLE_REASONS)
        + ".",
        "- Pièces qui parlent des champs, demandées et non obtenues (ventes comparées ou non), par motif : "
        + ", ".join(f"{reason} {pages.missing_pieces[reason]}" for reason in NO_PDF_REASONS)
        + ".",
        "- Pièces que pymupdf n'a pas ouvertes, par type d'erreur : "
        + (", ".join(f"{kind} {count}" for kind, count in sorted(report.unreadable.items())) or "aucune")
        + ".",
        "",
    ]
    lines += _counts_table(
        "Citations des candidats du lecteur principal, selon la façon dont elles ont été retrouvées",
        _QUOTE_MATCH_COLUMNS,
        lambda stats, key: stats.quote_matches[key],
        report,
    )
    for title, prefix, columns in _DIAGNOSTIC_TABLES:
        lines += _counts_table(title, columns, lambda stats, key, prefix=prefix: stats.details[f"{prefix}:{key}"], report)
    lines += ["### Lecteurs et coût réel", ""]
    for role, stats in report.readers.items():
        unpriced = sum(1 for call in stats.usage if call.cost_usd is None)
        failures = ", ".join(f"{kind} {stats.failures[kind]}" for kind in FAILURE_KINDS if stats.failures[kind]) or "aucun"
        lines.append(
            f"- {role} (`{stats.model}`) : {stats.calls} appel(s), {stats.pages} page(s) ; échecs : {failures} ; "
            f"jetons facturés : {_tokens([call.input_tokens for call in stats.usage])} en entrée, "
            f"{_tokens([call.output_tokens for call in stats.usage])} en sortie (réflexion comprise) ; "
            f"coût : {_known_cost(stats.usage):.4f} $"
            + (f" ; {unpriced} appel(s) sans jetons connus (issue incertaine ou erreur)" if unpriced else "")
            + "."
        )
    total = sum((_known_cost(stats.usage) for stats in report.readers.values()), Decimal(0))
    lines.append(f"- Total (un dollar compté pour un euro) : {total:.4f} €.")
    return "\n".join(lines) + "\n"


def download_row_pdfs(row: Mapping[str, Any], urls: Sequence[str]) -> FetchedPieces:
    """Les pièces ``urls`` de la vente lue par le banc (``download_sale_pdfs`` sur la vente de la ligne)."""
    return download_sale_pdfs(sale_from_row(row), urls)


def _positive_usd(text: str) -> Decimal:
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise argparse.ArgumentTypeError("montant en dollars attendu") from exc
    if not value.is_finite() or value <= 0 or value > 5:
        raise argparse.ArgumentTypeError("attendu entre 0 (exclu) et 5, le budget quotidien partagé")
    return value


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sample", type=_bounded_int(1, MAX_SAMPLE), required=True)
    parser.add_argument("--max-usd", type=_positive_usd, default=DEFAULT_MAX_USD)
    parser.add_argument("--output", type=Path, default=Path(DEFAULT_OUTPUT))
    parser.add_argument(
        "--private-review",
        type=Path,
        default=None,
        help="fichier JSON Lines (mode 0600) des valeurs retenues qui diffèrent de la fiche, avec vente et citation ; "
        "jamais en artefact",
    )
    parser.add_argument(
        "--differences",
        type=Path,
        default=None,
        help="fichier JSON Lines (mode 0600) des valeurs retenues qui diffèrent de la fiche : vente, champ, valeurs, "
        "numéro et type de la pièce, page ; sans citation, texte ni URL de la pièce",
    )
    args = parser.parse_args(argv)
    paths = [path.resolve() for path in (args.output, args.private_review, args.differences) if path is not None]
    if len(set(paths)) != len(paths):
        parser.error("--output, --private-review et --differences doivent viser trois fichiers différents")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    # Le téléchargement des pièces journalise leurs URL (avertissements, informations) : seules les erreurs sortent
    # dans le journal de l'exécution.
    logging.getLogger("src.pdf_enrichment").setLevel(logging.ERROR)
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not db_url:
        print("SUPABASE_DB_URL est requise (lecture des ventes).", file=sys.stderr)
        return 2
    if not settings.get("anthropic_api_key"):
        print("ANTHROPIC_API_KEY est requise.", file=sys.stderr)
        return 2
    spend = SpendCap(max_usd=args.max_usd)
    # Au plus un appel de chaque lecteur par vente.
    primary = anthropic_reader("principal", HAIKU, args.sample, spend, PRIMARY_TIMEOUT_SECONDS)
    second = anthropic_reader("second", SONNET, args.sample, spend, SECOND_TIMEOUT_SECONDS)
    from src.storage.supabase_client import connect

    # Ouverte avant la première vente : un chemin refusé arrête le banc avant tout appel au modèle.
    review = open_private_review(args.private_review) if args.private_review is not None else None
    differences = open_private_review(args.differences) if args.differences is not None else None
    connection = connect(str(db_url))
    try:
        report = run_bench(
            connection,
            primary,
            second,
            download_row_pdfs,
            sample=args.sample,
            today=datetime.now(PARIS).date(),
            private_review=(lambda entry: write_difference(review, entry)) if review is not None else None,
            differences=(lambda entry: write_difference(differences, entry)) if differences is not None else None,
        )
    finally:
        connection.close()
        for handle in (review, differences):
            if handle is not None:
                handle.close()
    markdown = render_report(report)
    args.output.write_text(markdown, encoding="utf-8")
    publish(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
