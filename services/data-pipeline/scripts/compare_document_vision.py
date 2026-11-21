"""Banc de comparaison : lecture des pièces par deux modèles Claude, contre la chaîne actuelle.

Lots V1 et V2, mode fantôme. Prend les N ventes à venir dont les pièces ont été lues le plus récemment par la chaîne
actuelle (texte des pages ``pdf_text`` et extraction des faits complète), choisit au plus dix pages par vente
(``src.document_vision.select_vision_pages``), en découpe un extrait PDF que Claude Haiku 5.5 lit en entier, puis
fait relire à Claude Sonnet 5.5 les seules pages citées par les valeurs qui seraient retenues. Le verdict par champ
(``src.document_vision``) est comparé à la valeur actuelle de la fiche. Une page citée en partie image, que ni la
couche texte ni l'OCR du pipeline ne couvrent, est lue par Tesseract (``src.pdf_ocr``) le temps de la vérification.

LECTURE SEULE sur les ventes : la connexion qui les lit est passée en lecture seule avant sa première requête et rien
n'est écrit sur une fiche. Restent, comme pour tout appel du pipeline : la réservation et le compte rendu de chaque
appel au modèle dans ``llm_usage_events`` (étape ``vision_trial``), dans le budget quotidien partagé (un refus arrête
le banc proprement), et la copie partagée des robots.txt lors du téléchargement poli des pièces. Le banc s'arrête
aussi avant qu'un appel puisse porter sa propre dépense au-delà de ``--max-usd``.

Le rapport est agrégé : par champ, accords, désaccords, « inconnu », rejets, écarts avec la fiche, diagnostic des
rejets et des « inconnu », et pour chaque lecteur ses échecs par type et son coût réel. Il ne contient ni
identifiant de vente, ni citation, ni texte, ni URL des pièces (le journal du téléchargement est réduit aux
erreurs).

Revue privée des écarts, en option seulement (``--private-review CHEMIN``) : pour chaque valeur retenue qui diffère
de la fiche, la vente, le champ, les deux valeurs, la citation et la page, dans un fichier JSON Lines lisible du
seul propriétaire (mode 0600). Jamais par défaut, jamais en artefact : le workflow ne l'active pas.

    python -m scripts.compare_document_vision --sample 10 --max-usd 3 --output document-vision-report.md
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import tempfile
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, TextIO

import anthropic
import pymupdf

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
    SYSTEM_PROMPT,
    UNKNOWN_STATUS,
    PageRef,
    Reading,
    SaleContext,
    Verdict,
    build_document_excerpt,
    build_user_prompt,
    compare_with_sale,
    final_verdicts,
    page_field_score,
    parse_reading,
    primary_verdicts,
    response_schema,
    second_reader_pages,
    select_vision_pages,
)
from src.enrichment.anthropic_reader import (  # noqa: E402
    DEFAULT_MAX_TOKENS,
    HAIKU,
    SONNET,
    AnthropicDocumentReader,
    DocumentReaderRefused,
    ReaderCall,
    ReaderInvalidJSON,
    ReaderOutputCut,
    call_ceiling_cost,
    input_token_ceiling,
    pdf_page_count,
)
from src.french_dates import PARIS  # noqa: E402
from src.llm_requests import (  # noqa: E402
    LLMRequestDeterministicCooldown,
    LLMRequestTransportAmbiguous,
    llm_request_context,
)
from src.lot_scope import is_lot_scoped  # noqa: E402
from src.normalize import clean_text  # noqa: E402
from src.pdf_deadline import PdfExtractionDeferred  # noqa: E402
from src.pdf_ocr import (  # noqa: E402
    OCR_NO_TEXT_METHOD,
    OCR_NO_TEXT_UNVERIFIED_METHOD,
    OCR_PICTURE_NO_TEXT_METHOD,
    extract_page_text_with_ocr_result,
    pdf_document_ocr_budget_scope,
)
from src.pdf_page_analysis import SETTLED_EXCLUDED_PAGE_STATUSES, page_has_substantial_image  # noqa: E402
from src.pipeline_usage import LLMModelNotPriced, PipelineBudgetExhausted  # noqa: E402

MAX_SAMPLE = 30
DEFAULT_MAX_USD = Decimal("3")
TRIAL_STAGE = "vision_trial"
TRIAL_REASON = "document_vision_comparison"
DEFAULT_OUTPUT = "document-vision-report.md"
PRIMARY_TIMEOUT_SECONDS = 300.0
# Sonnet réfléchit plus longtemps que Haiku sur les mêmes pages.
SECOND_TIMEOUT_SECONDS = 600.0
# OCR d'une page citée, le temps de la vérification : le même délai qu'une page du pipeline (``src.pdf_ocr``).
OCR_PAGE_SECONDS = 60.0
# Méthodes de ``pdf_ocr`` qui gardent le texte natif faute d'avoir lu quoi que ce soit : pas un texte d'OCR.
_OCR_WITHOUT_TEXT = frozenset({OCR_NO_TEXT_METHOD, OCR_NO_TEXT_UNVERIFIED_METHOD, OCR_PICTURE_NO_TEXT_METHOD})

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
FAILURE_KINDS = (
    "refus", "max_tokens", "400", "délai", "json_invalide", "bloquée_24h", "limite_de_débit", "autre",
)  # fmt: skip


class BenchStopped(RuntimeError):
    """Le budget, le plafond de dépense ou le plafond d'appels arrête le banc : la vente en cours n'est pas comptée."""


def failure_kind(error: BaseException) -> str:
    """Le type d'un échec d'appel, pour le rapport (jamais son message : il pourrait citer une pièce)."""
    if isinstance(error, LLMRequestDeterministicCooldown):
        return "bloquée_24h"
    if isinstance(error, DocumentReaderRefused):
        return "refus"
    if isinstance(error, ReaderOutputCut):
        return "max_tokens"
    if isinstance(error, ReaderInvalidJSON):
        return "json_invalide"
    if isinstance(error, (LLMRequestTransportAmbiguous, anthropic.APIConnectionError)):
        return "délai"
    if isinstance(error, anthropic.RateLimitError):
        return "limite_de_débit"
    if isinstance(error, anthropic.BadRequestError):
        return "400"
    return "autre"


@dataclass
class SpendCap:
    """Plafond de dépense du banc (``--max-usd``) : un appel n'est lancé que si son coût maximal y tient encore.

    Chaque appel fait y compte pour son coût réel, ou pour son coût maximal quand ses jetons sont inconnus (issue
    incertaine).
    """

    max_usd: Decimal
    committed: Decimal = Decimal(0)


@dataclass
class ReaderStats:
    model: str
    calls: int = 0
    failures: Counter[str] = field(default_factory=Counter)
    pages: int = 0
    usage: list[ReaderCall] = field(default_factory=list)


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


@dataclass
class Reader:
    """Un lecteur : son appel au modèle, son plafond d'appels, le plafond de dépense partagé et ses compteurs."""

    role: str
    generate: Generate
    stats: ReaderStats
    max_calls: int
    spend: SpendCap
    max_tokens: int = DEFAULT_MAX_TOKENS

    def read(self, user_prompt: str, pdf: bytes, fields: Sequence[str], pages: Sequence[PageRef]) -> Reading | None:
        if self.stats.calls >= self.max_calls:
            raise BenchStopped(f"{self.role} : plafond de {self.max_calls} appels atteint")
        schema = response_schema(fields)
        ceiling = call_ceiling_cost(
            self.stats.model, input_token_ceiling(pdf_page_count(pdf), SYSTEM_PROMPT, user_prompt, schema), self.max_tokens
        )
        if self.spend.committed + ceiling > self.spend.max_usd:
            raise BenchStopped(f"{self.role} : plafond de dépense de {self.spend.max_usd} $ atteint")
        self.stats.calls += 1
        self.stats.pages += len(pages)
        usage_before = len(self.stats.usage)
        try:
            payload = self.generate(SYSTEM_PROMPT, user_prompt, pdf, schema)
        except LLMRequestTransportAmbiguous as exc:
            # Issue incertaine (délai, connexion coupée) : comptée à son coût maximal, le banc continue.
            self.spend.committed += ceiling
            self.stats.failures[failure_kind(exc)] += 1
            return None
        except LLMRequestDeterministicCooldown as exc:
            # La même lecture a rendu un JSON invalide il y a moins de 24 heures : refusée avant l'envoi, sans coût.
            # Seule cette pièce est sautée.
            self.stats.failures[failure_kind(exc)] += 1
            return None
        except (PipelineBudgetExhausted, LLMModelNotPriced) as exc:
            # Budget quotidien ou horaire partagé, palier de prix dépassé : rien n'a été envoyé, on s'arrête.
            raise BenchStopped(f"{self.role} : {type(exc).__name__}") from exc
        except Exception as exc:
            self._commit(usage_before)
            self.stats.failures[failure_kind(exc)] += 1
            return None
        self._commit(usage_before, ceiling)
        return parse_reading(payload, fields, pages)

    def _commit(self, usage_before: int, ceiling: Decimal = Decimal(0)) -> None:
        """Ajoute au plafond de dépense le coût des appels notés depuis ``usage_before`` (coût maximal s'il manque)."""
        new_calls = self.stats.usage[usage_before:]
        for call in new_calls:
            self.spend.committed += call.cost_usd if call.cost_usd is not None else ceiling
        if not new_calls:
            self.spend.committed += ceiling


def sale_context(raw_payload: Mapping[str, Any], property_type: object, city: object, quality_flags: object) -> SaleContext:
    """Le lot vendu, s'il est désigné, et la situation de la vente quant aux lots, d'après la fiche."""
    flags = quality_flags if isinstance(quality_flags, list) else []
    sold_lot = sold_lot_from_sale(property_type, city, raw_payload.get("source_lot_selection"))
    lot_scoped = is_lot_scoped(dict(raw_payload))
    if lot_scoped and sold_lot is None:
        situation = LOT_UNCERTAIN
    elif lot_scoped or "multi_lot_sale" in flags:
        situation = SEVERAL_LOTS
    elif raw_payload.get("pdf_multi_lot_guard"):
        situation = ONE_LOT_GUARDED
    else:
        situation = ONE_LOT
    return SaleContext(sold_lot=sold_lot, lot_situation=situation)


# Pourquoi une page qui parle des champs ne peut pas entrer dans l'extrait envoyé au modèle.
NO_PDF = "pièce sans PDF"  # pièce non téléchargée, ou qui n'est pas un PDF (document Word)
PDF_CHANGED = "PDF modifié depuis la lecture"  # empreinte différente de celle du texte lu
PDF_UNREADABLE = "PDF illisible"  # pymupdf ne l'ouvre pas
PAGE_OUT_OF_RANGE = "page hors bornes"  # numéro de page au-delà des pages du PDF
UNUSABLE_REASONS = (NO_PDF, PDF_CHANGED, PDF_UNREADABLE, PAGE_OUT_OF_RANGE)


def usable_documents(
    manifest: object, documents: Sequence[ReadingDocument], fetched: Mapping[str, bytes], unreadable: Counter[str]
) -> tuple[dict[int, bytes], list[ReadingDocument], Counter[str]]:
    """Les pièces que l'extrait peut porter : leur PDF par index, ces pièces réduites aux pages que le PDF contient,
    et le décompte, par motif, des pages qui parlent des champs et qui sont écartées.

    Un PDF ne sert que s'il est celui dont le texte a été lu (même empreinte quand le manifeste la donne) et que
    pymupdf l'ouvre. Les numéros de page du manifeste comptent à partir de 1 (``extract_pdf_pages``) : la page n est
    la page d'indice n - 1 pour pymupdf, comme dans ``build_document_excerpt``.
    """
    items = manifest if isinstance(manifest, list) else []
    expected = {clean_text(item.get("url")): item.get("sha256") for item in items if isinstance(item, Mapping)}
    pdfs: dict[int, bytes] = {}
    kept: list[ReadingDocument] = []
    unusable: Counter[str] = Counter()
    for doc in documents:
        scored = [number for number, text in doc.pages.items() if page_field_score(text) > 0]
        content = fetched.get(doc.url) if doc.url else None
        sha256 = expected.get(doc.url)
        if content is None:
            unusable[NO_PDF] += len(scored)
            continue
        if isinstance(sha256, str) and sha256 and hashlib.sha256(content).hexdigest() != sha256:
            unusable[PDF_CHANGED] += len(scored)
            continue
        document = _open_pdf(content, unreadable)
        if document is None:
            unusable[PDF_UNREADABLE] += len(scored)
            continue
        with document:
            page_count = document.page_count
        if not sha256 and doc.pages and max(doc.pages) > page_count:
            # Sans empreinte, un PDF plus court que le texte lu n'est pas celui qui a été lu : la pièce entière est
            # écartée, et ses pages restantes ne sont pas réputées être celles du texte.
            unusable[PDF_CHANGED] += len(scored)
            continue
        unusable[PAGE_OUT_OF_RANGE] += sum(1 for number in scored if not 1 <= number <= page_count)
        pages = {number: text for number, text in doc.pages.items() if 1 <= number <= page_count}
        if pages:
            pdfs[doc.index] = content
            kept.append(ReadingDocument(doc.index, doc.label, doc.url, doc.document_type, pages))
    return pdfs, kept, +unusable


def _manifest_pages(manifest: object) -> list[tuple[str | None, Mapping[str, Any]]]:
    """Chaque page du manifeste ``pdf_text``, avec l'URL de sa pièce."""
    pages: list[tuple[str | None, Mapping[str, Any]]] = []
    for item in manifest if isinstance(manifest, list) else []:
        if isinstance(item, Mapping):
            url = clean_text(item.get("url"))
            pages += [(url, page) for page in item.get("pages") or [] if isinstance(page, Mapping)]
    return pages


def _page_number(page: Mapping[str, Any]) -> int:
    try:
        return int(page.get("page") or 0)
    except (TypeError, ValueError):
        return 0


def ocr_read_pages(manifest: object, documents: Sequence[ReadingDocument]) -> frozenset[PageRef]:
    """Les pages dont le texte gardé par le pipeline vient d'un OCR qui a lu quelque chose."""
    read_by_ocr = {
        (url, _page_number(page))
        for url, page in _manifest_pages(manifest)
        if str(page.get("method") or "").startswith("ocr_") and page.get("method") not in _OCR_WITHOUT_TEXT
    }
    return frozenset(PageRef(doc.index, n) for doc in documents for n in doc.pages if (doc.url, n) in read_by_ocr)


def unread_page_count(manifest: object, documents: Sequence[ReadingDocument]) -> int:
    """Pages du dossier sans texte exploitable, hors pages blanches et pages de photographies réglées : un modèle qui
    lit l'image pourrait y trouver une valeur, mais la sélection, qui part du texte, ne peut pas les choisir."""
    read = {(doc.url, number) for doc in documents for number in doc.pages}
    return sum(
        1
        for url, page in _manifest_pages(manifest)
        if (url, _page_number(page)) not in read and page.get("status") not in SETTLED_EXCLUDED_PAGE_STATUSES
    )


def _open_pdf(content: bytes, unreadable: Counter[str]) -> Any | None:
    """La pièce ouverte par pymupdf, ou None : une pièce qu'il n'ouvre pas est sautée et comptée par type d'erreur
    (jamais par message, qui pourrait citer la pièce), sans arrêter le banc."""
    try:
        return pymupdf.open(stream=content, filetype="pdf")
    except Exception as exc:  # pymupdf lève selon le défaut FileDataError, RuntimeError, ValueError…
        unreadable[type(exc).__name__] += 1
        return None


def image_pages(
    pdfs: Mapping[int, bytes], pages: Sequence[PageRef], ocr_pages: frozenset[PageRef], unreadable: Counter[str]
) -> frozenset[PageRef]:
    """Parmi ``pages``, celles dont une image couvre une part notable (même seuil que le pipeline pour lancer l'OCR
    d'une page mixte) et dont le texte ne vient pas d'un OCR : la couche texte n'en dit peut-être qu'un en-tête."""
    found: set[PageRef] = set()
    for document_index in sorted({ref.document for ref in pages}):
        content = pdfs.get(document_index)
        document = _open_pdf(content, unreadable) if content else None
        if document is None:
            continue
        with document:
            for ref in pages:
                if (
                    ref.document == document_index
                    and ref not in ocr_pages
                    and 1 <= ref.page <= document.page_count
                    and page_has_substantial_image(document[ref.page - 1])
                ):
                    found.add(ref)
    return frozenset(found)


def tesseract_page_reader(pdfs: Mapping[int, bytes], unreadable: Counter[str]) -> Callable[[PageRef], str | None]:
    """OCR d'une page d'une pièce par le Tesseract du pipeline (``src.pdf_ocr``), borné à ``OCR_PAGE_SECONDS``.

    Rend le seul texte lu par l'OCR, sans la couche texte de la page (déjà dans le texte gardé par le pipeline) : un
    titre de lot n'y est pas compté deux fois et la tolérance de l'OCR ne s'applique pas au texte natif. None si
    l'OCR n'a rien lu, a échoué ou n'est pas installé.
    """
    settings = load_settings()

    def read(ref: PageRef) -> str | None:
        content = pdfs.get(ref.document)
        document = _open_pdf(content, unreadable) if content else None
        if document is None:
            return None
        try:
            with document:
                if not 1 <= ref.page <= document.page_count:
                    return None
                with pdf_document_ocr_budget_scope(OCR_PAGE_SECONDS):
                    result = extract_page_text_with_ocr_result(document[ref.page - 1], "", settings=settings)
        except PdfExtractionDeferred:
            return None
        return clean_text(result.get("text"))

    return read


def compare_sale(
    row: Mapping[str, Any],
    primary: Reader,
    second: Reader,
    fetch_pdfs: FetchPdfs,
    *,
    today: date,
) -> tuple[SaleResult | None, str | None]:
    """Verdicts d'une vente, ou la raison pour laquelle elle n'est pas comparée."""
    raw_payload = row.get("raw_payload") if isinstance(row.get("raw_payload"), Mapping) else {}
    manifest = row.get("result")
    all_documents: list[ReadingDocument] = documents_from_manifest(manifest)
    # Une page qui s'adresse à un modèle n'est jamais lue (même détecteur que la lecture des pièces).
    documents = without_pages(all_documents, injected_pages(all_documents))
    # Les pièces d'abord, la sélection ensuite : elle ne choisit que des pages qu'un PDF disponible porte. Choisies
    # avant le téléchargement, les pages d'une pièce sans PDF (document Word, pièce non téléchargée) prenaient des
    # places, ou toutes, et l'extrait restait vide.
    urls = sorted(
        {doc.url for doc in documents if doc.url and any(page_field_score(text) > 0 for text in doc.pages.values())}
    )
    if not urls:
        return None, "aucune page sur les champs visés"
    try:
        fetched = fetch_pdfs(row, urls)
    except Exception:
        return None, "pièces non téléchargées"
    unreadable: Counter[str] = Counter()
    pdfs, usable, unusable = usable_documents(manifest, documents, fetched, unreadable)
    pages = select_vision_pages(usable)
    if not pages:
        main = unusable.most_common(1)[0][0] if unusable else "aucune page sur les champs visés"
        return None, f"aucune page utilisable ({main})"
    excerpt, pages = build_document_excerpt(pdfs, pages)
    if not pages:
        return None, "extrait vide"
    with_field_words = sum(1 for doc in usable for text in doc.pages.values() if page_field_score(text) > 0)
    page_stats = PageStats(
        with_field_words=with_field_words,
        sent=len(pages),
        capped_sales=int(with_field_words > MAX_PAGES),
        unread=unread_page_count(manifest, all_documents),
        unusable=unusable,
    )
    context = sale_context(raw_payload, row.get("property_type"), row.get("city"), row.get("quality_flags"))
    texts = {doc.index: doc.pages for doc in documents}
    context.page_texts = {ref: texts[ref.document][ref.page] for ref in pages}
    # « libre » ne doit être contredit sur aucune page du dossier, envoyée ou non (texte déjà produit, sans coût).
    context.dossier_texts = tuple(text for doc in all_documents for text in doc.pages.values())
    context.dossier_pages = {PageRef(doc.index, number): text for doc in documents for number, text in doc.pages.items()}
    context.ocr_pages = ocr_read_pages(manifest, documents)
    context.image_pages = image_pages(pdfs, pages, context.ocr_pages, unreadable)
    context.ocr_reader = tesseract_page_reader(pdfs, unreadable) if context.image_pages else None
    with llm_request_context(
        sale_id=str(row.get("id") or ""), source_url=str(row.get("source_url") or ""), stage=TRIAL_STAGE, reason=TRIAL_REASON
    ):
        reading = primary.read(build_user_prompt(pages, FIELDS, today=today, sold_lot=context.sold_lot), excerpt, FIELDS, pages)
        if reading is None:
            return None, "lecture principale en échec"
        candidates = primary_verdicts(reading, context, today=today)
        fields = [name for name, verdict in candidates.items() if verdict.status == CANDIDATE]
        second_reading = None
        second_context = context
        if fields:
            second_excerpt, second_pages = build_document_excerpt(
                pdfs, second_reader_pages(candidates, context, reading.several_lots is True)
            )
            # Une page précédente ajoutée pour le second lecteur lui est envoyée : ses citations y sont cherchées. Une
            # copie du contexte, pour ne pas changer les pages envoyées au lecteur principal (même cache d'OCR).
            added = {ref: context.dossier_pages[ref] for ref in second_pages if ref not in context.page_texts}
            second_context = replace(context, page_texts={**context.page_texts, **added})
            second_reading = second.read(
                build_user_prompt(second_pages, fields, today=today, sold_lot=context.sold_lot),
                second_excerpt,
                fields,
                second_pages,
            )
    final = final_verdicts(candidates, second_reading, second_context, today=today)
    return SaleResult(candidates, final, {doc.index: doc for doc in documents}, page_stats, unreadable), None


def _jsonable(value: object) -> object:
    if isinstance(value, (frozenset, set)):
        return sorted(_jsonable(item) for item in value)  # type: ignore[type-var]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, (date, Decimal)):
        return str(value)
    return value


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
    """Ouvre la revue privée (JSON Lines), lisible du seul propriétaire (0600, même si le fichier existait). Un lien
    symbolique n'est pas suivi : le fichier visé ne peut pas être ailleurs que là où on l'a dit."""
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
) -> BenchReport:
    """Lit les ventes (lecture seule), les compare et agrège le résultat. Aucune écriture sur une vente.

    ``private_review`` : s'il est donné, il reçoit, au fil du banc, chaque valeur retenue qui diffère de la fiche
    (:func:`private_difference`) ; elle n'entre jamais dans le rapport.
    """
    # Avant la première requête : chaque transaction de cette connexion est READ ONLY, une écriture échouerait.
    connection.read_only = True
    report = BenchReport(
        sample=sample, max_usd=primary.spend.max_usd, readers={"principal": primary.stats, "second": second.stats}
    )
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
            result, skipped = compare_sale(row, primary, second, fetch_pdfs, today=today)
        except BenchStopped as exc:
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
            (ONE_LOT, "Un lot (lecteur : plusieurs)"),
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
    args = parser.parse_args(argv)
    if args.private_review is not None and args.private_review.resolve() == args.output.resolve():
        parser.error("--private-review doit viser un autre fichier que le rapport agrégé")
    return args


def _reader(role: str, model: str, max_calls: int, spend: SpendCap, timeout_seconds: float) -> Reader:
    client = AnthropicDocumentReader(model=model, timeout_seconds=timeout_seconds)
    stats = ReaderStats(model=model, usage=client.usage)
    return Reader(role, client.generate_json_with_pdf, stats, max_calls, spend, client.max_tokens)


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
    primary = _reader("principal", HAIKU, args.sample, spend, PRIMARY_TIMEOUT_SECONDS)
    second = _reader("second", SONNET, args.sample, spend, SECOND_TIMEOUT_SECONDS)
    from src.storage.supabase_client import connect

    # Ouverte avant la première vente : un chemin refusé arrête le banc avant tout appel au modèle.
    review = open_private_review(args.private_review) if args.private_review is not None else None
    connection = connect(str(db_url))
    try:
        report = run_bench(
            connection,
            primary,
            second,
            download_sale_pdfs,
            sample=args.sample,
            today=datetime.now(PARIS).date(),
            private_review=(lambda entry: write_difference(review, entry)) if review is not None else None,
        )
    finally:
        connection.close()
        if review is not None:
            review.close()
    markdown = render_report(report)
    args.output.write_text(markdown, encoding="utf-8")
    publish(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
