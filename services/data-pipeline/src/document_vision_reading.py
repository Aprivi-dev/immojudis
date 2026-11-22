"""Une lecture des pièces d'une vente par deux modèles : lecteurs, plafonds, déroulé.

Partagé par le banc (``scripts/compare_document_vision.py``) et la passe d'écriture (``src.document_vision_pass``) :
les mêmes pièces, les mêmes pages, les mêmes deux lecteurs et les mêmes verdicts (``src.document_vision``). Le banc
y ajoute ses comptes, la passe ses règles d'écriture.

Déroulé (:func:`read_sale`) : les pages qui s'adressent à un modèle sont écartées, les pièces qui parlent des champs
sont téléchargées, la sélection ne choisit que des pages qu'un PDF disponible porte, Claude Haiku 5.5 lit l'extrait,
Claude Sonnet 5.5 relit les seules pages citées par les valeurs candidates, et seules les valeurs sur lesquelles les
deux s'accordent sont retenues.

Chaque appel est réservé et compté dans ``llm_usage_events`` (``src.enrichment.anthropic_reader``), dans le budget
quotidien partagé : un refus arrête la lecture (:class:`ReadingStopped`), comme le plafond d'appels d'un lecteur ou
le plafond de dépense de l'appelant.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from decimal import Decimal
from typing import Any

import anthropic

from src.document_reading import ReadingDocument, documents_from_manifest, injected_pages, without_pages
from src.document_reading_exclusions import EXCLUDED_SALE_SQL
from src.document_vision import (
    CANDIDATE,
    FIELDS,
    SYSTEM_PROMPT,
    PageRef,
    Reading,
    Verdict,
    build_document_excerpt,
    build_user_prompt,
    final_verdicts,
    page_field_score,
    parse_reading,
    primary_verdicts,
    response_schema,
    sale_context,
    second_reader_pages,
    select_vision_pages,
)
from src.document_vision_pieces import (
    FetchedPieces,
    FetchPdfs,
    image_pages,
    ocr_read_pages,
    tesseract_page_reader,
    usable_documents,
)
from src.enrichment.anthropic_reader import (
    DEFAULT_MAX_TOKENS,
    AnthropicDocumentReader,
    DocumentReaderRefused,
    ReaderCall,
    ReaderInvalidJSON,
    ReaderOutputCut,
    call_ceiling_cost,
    input_token_ceiling,
    pdf_page_count,
)
from src.llm_requests import LLMRequestDeterministicCooldown, LLMRequestTransportAmbiguous, llm_request_context
from src.pipeline_usage import LLMModelNotPriced, PipelineBudgetExhausted

PRIMARY_TIMEOUT_SECONDS = 300.0
# Sonnet réfléchit plus longtemps que Haiku sur les mêmes pages.
SECOND_TIMEOUT_SECONDS = 600.0

# Les ventes qu'une lecture peut prendre, pour le banc comme pour la passe d'écriture : à venir, pièces lues par la
# chaîne actuelle (texte des pages persisté, extraction des faits complète), hors des ventes masquées par le retrait
# de leurs sources et des ventes exclues de la lecture automatique des pièces (écartées ici, avant tout
# téléchargement). Alias ``sale`` (la vente) et ``latest`` (son dernier texte des pièces : ``result``,
# ``updated_at``) ; à compléter par la liste des colonnes, puis par d'autres conditions, l'ordre et la limite.
CANDIDATE_SALES_SQL = f"""
  from public.auction_sales sale
  join lateral (
    select extraction.result, extraction.updated_at
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
   and not {EXCLUDED_SALE_SQL}"""

Generate = Callable[[str, str, bytes, Mapping[str, Any]], Mapping[str, object]]
FAILURE_KINDS = (
    "refus", "max_tokens", "400", "délai", "json_invalide", "bloquée_24h", "limite_de_débit", "autre",
)  # fmt: skip

# Pourquoi une vente n'est pas lue jusqu'au bout (:func:`read_sale`).
NO_FIELD_PAGE = "aucune page sur les champs visés"
NOT_DOWNLOADED = "pièces non téléchargées"
NO_USABLE_PAGE = "aucune page utilisable"
EMPTY_EXCERPT = "extrait vide"
PRIMARY_FAILED = "lecture principale en échec"


class ReadingStopped(RuntimeError):
    """Le budget, le plafond de dépense ou le plafond d'appels arrête la lecture : la vente en cours n'est pas lue."""


def failure_kind(error: BaseException) -> str:
    """Le type d'un échec d'appel, pour un compte (jamais son message : il pourrait citer une pièce)."""
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
    """Plafond de dépense : un appel n'est lancé que si son coût maximal y tient encore.

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
            raise ReadingStopped(f"{self.role} : plafond de {self.max_calls} appels atteint")
        schema = response_schema(fields)
        ceiling = call_ceiling_cost(
            self.stats.model, input_token_ceiling(pdf_page_count(pdf), SYSTEM_PROMPT, user_prompt, schema), self.max_tokens
        )
        if self.spend.committed + ceiling > self.spend.max_usd:
            raise ReadingStopped(f"{self.role} : plafond de dépense de {self.spend.max_usd} $ atteint")
        self.stats.calls += 1
        self.stats.pages += len(pages)
        usage_before = len(self.stats.usage)
        try:
            payload = self.generate(SYSTEM_PROMPT, user_prompt, pdf, schema)
        except LLMRequestTransportAmbiguous as exc:
            # Issue incertaine (délai, connexion coupée) : comptée à son coût maximal, la lecture continue.
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
            raise ReadingStopped(f"{self.role} : {type(exc).__name__}") from exc
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


def anthropic_reader(role: str, model: str, max_calls: int, spend: SpendCap, timeout_seconds: float) -> Reader:
    """Un lecteur qui appelle l'API Anthropic (``ANTHROPIC_API_KEY``)."""
    client = AnthropicDocumentReader(model=model, timeout_seconds=timeout_seconds)
    stats = ReaderStats(model=model, usage=client.usage)
    return Reader(role, client.generate_json_with_pdf, stats, max_calls, spend, client.max_tokens)


@dataclass
class SaleReading:
    """Ce que la lecture d'une vente rend : verdicts, pièces lues, pages envoyées et pièces écartées."""

    primary: dict[str, Verdict]
    final: dict[str, Verdict]
    # Les pièces que le modèle pouvait lire (sans les pages qui s'adressent à un modèle), par index, et toutes celles
    # du dossier.
    documents: dict[int, ReadingDocument]
    all_documents: list[ReadingDocument]
    # Les pièces que l'extrait pouvait porter, et les pages envoyées au lecteur principal.
    usable: list[ReadingDocument]
    pages: list[PageRef]
    # Pages qui parlent des champs, écartées faute de PDF utilisable, par motif.
    unusable: Counter[str]
    # Pièces que pymupdf n'a pas ouvertes, par type d'erreur.
    unreadable: Counter[str]
    # Des valeurs candidates attendaient le second lecteur, et son appel a échoué : rien n'est retenu.
    second_failed: bool = False


def read_sale(
    row: Mapping[str, Any],
    primary: Reader,
    second: Reader,
    fetch_pdfs: FetchPdfs,
    *,
    today: date,
    stage: str,
    reason: str,
) -> tuple[SaleReading | None, str | None]:
    """La lecture d'une vente, ou pourquoi elle n'est pas lue jusqu'au bout.

    ``row`` : la vente (``id``, ``source_url``, ``raw_payload``, ``property_type``, ``city``, ``quality_flags``) et le
    manifeste ``pdf_text`` de ses pièces (``result``). ``stage`` et ``reason`` : l'étape et le motif sous lesquels les
    appels sont comptés dans ``llm_usage_events``. Lève :class:`ReadingStopped` quand un plafond ou le budget arrête.
    """
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
        return None, NO_FIELD_PAGE
    try:
        fetched: FetchedPieces = fetch_pdfs(row, urls)
    except Exception:
        return None, NOT_DOWNLOADED
    unreadable: Counter[str] = Counter()
    pdfs, usable, unusable = usable_documents(manifest, documents, fetched, unreadable)
    pages = select_vision_pages(usable)
    if not pages:
        main = unusable.most_common(1)[0][0] if unusable else NO_FIELD_PAGE
        return None, f"{NO_USABLE_PAGE} ({main})"
    excerpt, pages = build_document_excerpt(pdfs, pages)
    if not pages:
        return None, EMPTY_EXCERPT
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
        sale_id=str(row.get("id") or ""), source_url=str(row.get("source_url") or ""), stage=stage, reason=reason
    ):
        reading = primary.read(build_user_prompt(pages, FIELDS, today=today, sold_lot=context.sold_lot), excerpt, FIELDS, pages)
        if reading is None:
            return None, PRIMARY_FAILED
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
    return (
        SaleReading(
            primary=candidates,
            final=final,
            documents={doc.index: doc for doc in documents},
            all_documents=all_documents,
            usable=usable,
            pages=pages,
            unusable=unusable,
            unreadable=unreadable,
            second_failed=bool(fields) and second_reading is None,
        ),
        None,
    )
