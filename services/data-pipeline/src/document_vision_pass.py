"""Passe d'écriture de la lecture des pièces par Claude (lot V3b-1), à blanc par défaut.

Décision du propriétaire (21/11/2026) : la lecture des pièces par Claude Haiku 5.5, contrôlée par Claude Sonnet 5.5,
enrichit les fiches automatiquement. La passe suit la lecture IA des pièces (``src.document_reading``, Claude Haiku
5.5 depuis le 22/11/2026, Qwen avec ``LLM_PROVIDER=replicate``) dans chaque cycle de la
file d'enrichissement (``src.autonomous_runner``) et ne la touche pas. Elle lit les pièces comme le banc
(``src.document_vision_reading``) : seule une valeur sur laquelle les deux modèles s'accordent (verdict ``accepted``)
peut être écrite.

Réglages (``src.config``) :

* ``DOCUMENT_VISION_MODE`` : ``off`` (défaut, rien n'est lu), ``dry_run`` (lit, compte et journalise ce qui serait
  écrit, par champ) ou ``write``. À blanc, seul l'état de la lecture (``raw_payload.document_vision``) est écrit,
  jamais la fiche visible ;
* ``DOCUMENT_VISION_FIELDS`` : les champs ouverts à l'écriture, séparés par des virgules, parmi
  :data:`WRITABLE_FIELDS`. Vide par défaut : rien n'est lu ni écrit, même à blanc. Jamais la mise à prix ni la date
  d'audience, ni les dates de visite. Ouvrir un champ plus tard ne relit pas les ventes déjà lues : seule une nouvelle
  version du prompt (ou de nouvelles pièces) les fait relire.

Bornes : :data:`MAX_SALES` ventes et :data:`BUDGET_SECONDS` secondes par passe. Une vente ne commence que s'il reste
de quoi la finir (:data:`SALE_RESERVE_SECONDS` : ses deux délais d'appel, plus 90 s pour l'attente du verrou et
l'écriture) ; le lanceur donne au processus :data:`PASS_TIMEOUT_SECONDS`, démarrage compris. Les délais d'appel sont
plus courts que ceux du banc.

Avant toute lecture, la passe vérifie que la base porte ses migrations (table des exclusions, colonnes du registre) ;
sinon elle s'arrête (``schema_missing``), sans lire ni payer.

Aucune requête aux sites (décision du 17/11/2026 : pas une requête de plus par site). Les pièces sont lues dans le
cache local des pièces téléchargées par la lecture des PDF du pipeline (``data/documents``, gardé d'une exécution à
l'autre et borné par le workflow), jamais téléchargées. Une vente qu'aucun appel n'a pu lire (pièce absente du cache,
PDF différent du texte lu, pièces illisibles) attend que ses pièces soient relues (état ``waiting_pieces``), sans
essai compté. Sous le verrou, avant d'écrire, l'empreinte des pièces est recalculée : si elles ont changé depuis la
lecture, rien n'est écrit et la vente reste à relire, sans essai compté.

Ventes lues : celles du banc (``CANDIDATE_SALES_SQL`` : à venir, pièces lues, faits complets, non exclues), avec au
moins un champ ouvert vide, et sans lecture déjà faite pour l'empreinte de leurs pièces et la version du prompt. Une
lecture faite à blanc est refaite une fois en écriture. Une lecture en échec est reprise 12 h, puis 24 h, puis 72 h
plus tard, et abandonnée au quatrième échec sur les mêmes pièces. L'état de la lecture est dans
``raw_payload.document_vision`` (:data:`STATE_KEY`), sans valeur ni citation ; il est tenu même à blanc, pour ne pas
payer deux fois la même lecture.

Règles d'écriture, vérifiées sous le verrou d'écriture du catalogue sur la vente relue juste avant l'écriture
(:func:`plan_write`) : verdict ``accepted`` ; champ ouvert ; champ que le registre des pièces ne connaît pas pour
la vente (ni valeur tenue, ni valeur libérée avec mémoire d'écho : ``app_private.sale_registry_columns``) ; colonne
vide (pour une surface bâtie, tout le groupe :data:`BUILT_SURFACE_GROUP`) ; jamais moins de pièces que de
chambres ; vente non exclue (seconde vérification). La vente passe ensuite par ``derive_sale_facts`` (la surface
affichée se déduit de la surface habitable) et par ``upsert_sales_to_supabase(refresh_last_seen=False)``, comme la
reprojection du vidage des pièces. Si la déduction touche une autre colonne déjà remplie, ou si elle changerait à elle
seule un fait déjà rempli de la fiche (règles qui ont changé depuis la dernière écriture), rien n'est écrit.

Trace : ``raw_payload.pdf_fact_provenance[colonne]`` (``src.pdf_fact_scope.pdf_record_fact_projection``), avec
``reader: "document_vision"``, la version du prompt, les deux modèles, le moment de la lecture (``read_at``), l'index et
le type de la pièce, sa page et la valeur d'avant (``baseline``, nulle pour un champ écrit), l'adresse et l'empreinte
du PDF de la pièce. Jamais de citation, ni dans la trace ni dans le journal. La fiche n'en montre que le type de la
pièce et sa page, par ``public.get_public_sale_document_fact_sources`` (migration 20261210100000), tant que la
valeur affichée est celle de la trace. Une relecture de la fiche par la collecte garde ces valeurs
(``src.known_document_backfill``) ; une relecture complète des pièces aussi, tant que la pièce est lue telle quelle
(``src.document_vision.vision_traces_kept``) ; une pièce remplacée, retirée ou révoquée les emporte.

Retrait : ``python -m src.document_vision_pass --withdraw --prompt-version X`` ou ``--withdraw --sale URL`` rejoue
``_clear_pdf_fact_projections`` sur les seules traces de cette lecture ; la case redevient vide (ou reprend la valeur
de l'annonce). ``--sale`` retrouve la vente par la règle des exclusions (son URL, ou une URL qu'elle a absorbée).
Chaque vente attend le verrou du catalogue jusqu'à 10 minutes ; une vente non traitée ou une écriture écartée fait
sortir la commande en erreur, avec la liste des ventes à reprendre. Un retrait par version se fait avec
``DOCUMENT_VISION_MODE=off`` : sinon une passe pourrait écrire de nouvelles valeurs de cette version pendant le
retrait. La commande d'exclusion d'une vente l'appelle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from psycopg.types.json import Jsonb

from src.config import load_settings
from src.document_reading import ReadingDocument, documents_from_manifest, sold_lot_from_sale
from src.document_reading_exclusions import SALES_OF_URL_SQL, is_sale_excluded_from_document_reading
from src.document_vision import (
    ACCEPTED,
    CARREZ,
    HABITABLE,
    LAND,
    OCCUPANCY,
    PROMPT_VERSION,
    ROOMS,
    TRACE_READER,
    Verdict,
)
from src.document_vision_pieces import NO_PDF_NOT_CACHED, FetchedPieces, cached_sale_pdfs
from src.document_vision_reading import CANDIDATE_SALES_SQL, NO_FIELD_PAGE, PRIMARY_FAILED
from src.models import AuctionSale
from src.pdf_fact_scope import _clear_pdf_fact_projections, _pdf_values_match, pdf_record_fact_projection
from src.sale_finalization import derive_sale_facts

LOGGER = logging.getLogger(__name__)

OFF, DRY_RUN, WRITE = "off", "dry_run", "write"
MODES = (OFF, DRY_RUN, WRITE)
# Les champs qu'une lecture peut écrire. Jamais les dates de visite : la lecture n'en donne que les jours, sans heure.
WRITABLE_FIELDS = (HABITABLE, CARREZ, LAND, ROOMS, OCCUPANCY)
# Une surface bâtie ne s'écrit que si toutes ces colonnes sont vides.
BUILT_SURFACE_GROUP = ("surface_m2", "app_surface_m2", HABITABLE, CARREZ)
# Jamais écrites, même par la déduction qui suit l'écriture.
NEVER_WRITTEN = ("starting_price_eur", "sale_date")
# Étiquettes de la surface que la déduction refait quand une surface est écrite : elles changent avec elle, leur
# valeur d'avant est gardée dans la trace (``baseline``) et rendue au retrait.
SURFACE_LABELS = ("app_surface_kind", "surface_scope", "surface_source", "surface_confidence")
# Texte d'appui de la surface, refait par la déduction à partir du texte de la fiche (pièces comprises) : jamais
# recopié dans une trace, il est refait au retrait.
UNTRACED_COLUMNS = ("surface_evidence",)
# Les faits de la fiche que la déduction peut changer après une écriture, et que la passe surveille. Le reste (titre,
# score, procédure) se refait à chaque écriture de la fiche à partir de ces faits, et de même au retrait.
FACT_COLUMNS = (
    *BUILT_SURFACE_GROUP,
    LAND,
    *SURFACE_LABELS,
    *UNTRACED_COLUMNS,
    ROOMS,
    "bedrooms_count",
    OCCUPANCY,
    "property_type",
    "visit_dates",
    *NEVER_WRITTEN,
)

STATE_KEY = "document_vision"
MAX_SALES = 10
# Délais d'appel de la passe, plus courts que ceux du banc (5 et 10 minutes).
PRIMARY_TIMEOUT_SECONDS = 120.0
SECOND_TIMEOUT_SECONDS = 240.0
LOCK_WAIT_SECONDS = 60.0
# Une vente ne commence que s'il reste ses deux délais d'appel, plus 90 s pour l'attente du verrou et l'écriture.
SALE_RESERVE_SECONDS = PRIMARY_TIMEOUT_SECONDS + SECOND_TIMEOUT_SECONDS + 90.0
# Temps de la passe, à partir de son démarrage : la dernière vente y finit.
BUDGET_SECONDS = 10 * 60
# Démarrage du processus (imports, lecture des réglages, connexion) avant le premier tic de son budget.
STARTUP_SECONDS = 60
PASS_TIMEOUT_SECONDS = BUDGET_SECONDS + STARTUP_SECONDS
# Retrait : chaque vente attend le verrou du catalogue jusqu'à 10 minutes (une collecte peut le tenir longtemps).
WITHDRAW_LOCK_WAIT_SECONDS = 10 * 60
RETRY_BACKOFF_HOURS = (12, 24, 72)
MAX_FAILED_ATTEMPTS = len(RETRY_BACKOFF_HOURS) + 1
PASS_STAGE = "vision_pass"
PASS_REASON = "document_vision_write"

# Issue d'un champ retenu par les deux lecteurs (comptes et journal).
WRITTEN = "ecrit"
CLOSED = "champ_ferme"
FILLED = "case_remplie"
FEWER_ROOMS = "moins_de_pieces_que_de_chambres"
TOUCHES_FILLED = "toucherait_une_case_remplie"
FORBIDDEN = "toucherait_la_mise_a_prix_ou_la_date"
NOT_KEPT = "non_garde_par_la_fiche"
EXCLUDED = "vente_exclue"
REGISTRY = "tenu_par_le_registre"
DRIFT = "la_deduction_changerait_la_fiche"
NOT_RECORDED = "ecriture_ecartee"
SECOND_FAILED = "second lecteur en échec"
WRITE_FAILED = "écriture en échec"


# --- Réglages -------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class VisionSettings:
    mode: str = OFF
    fields: tuple[str, ...] = ()


def vision_settings(settings: Mapping[str, object]) -> VisionSettings:
    """Les réglages de la passe ; ``ValueError`` pour un mode ou un champ hors liste (rien n'est alors lu)."""
    mode = str(settings.get("document_vision_mode") or OFF)
    if mode not in MODES:
        raise ValueError(f"DOCUMENT_VISION_MODE : attendu {', '.join(MODES)}")
    raw_fields = settings.get("document_vision_fields") or ()
    fields = tuple(str(name) for name in raw_fields) if isinstance(raw_fields, (list, tuple)) else ()
    unknown = [name for name in fields if name not in WRITABLE_FIELDS]
    if unknown:
        raise ValueError(f"DOCUMENT_VISION_FIELDS : champs hors liste ({', '.join(unknown)}) ; attendu parmi "
                         f"{', '.join(WRITABLE_FIELDS)}")
    return VisionSettings(mode=mode, fields=tuple(name for name in WRITABLE_FIELDS if name in fields))


def required_empty_columns(field_name: str) -> tuple[str, ...]:
    """Les colonnes qui doivent être vides pour écrire ``field_name`` : tout le groupe pour une surface bâtie."""
    return BUILT_SURFACE_GROUP if field_name in (HABITABLE, CARREZ) else (field_name,)


# --- Ventes candidates ----------------------------------------------------------------------------------------------

_STATE = f"sale.raw_payload -> '{STATE_KEY}'"


def _backoff_sql() -> str:
    """Attente SQL après ``attempts`` échecs de suite (:data:`RETRY_BACKOFF_HOURS`)."""
    attempts = f"({_STATE} ->> 'attempts')::integer"
    delays = " ".join(
        f"when {attempts} <= {count} then interval '{hours} hours'"
        for count, hours in enumerate(RETRY_BACKOFF_HOURS[:-1], start=1)
    )
    return f"case {delays} else interval '{RETRY_BACKOFF_HOURS[-1]} hours' end"


_RETRY_DUE_SQL = (
    f"({_STATE} ->> 'status' = 'failed'"
    f" and ({_STATE} ->> 'attempts')::integer < {MAX_FAILED_ATTEMPTS}"
    f" and ({_STATE} ->> 'read_at')::timestamptz <= now() - {_backoff_sql()})"
)


def candidates_sql(fields: Sequence[str]) -> str:
    """Les ventes du banc qui ont un champ ouvert vide et dont la lecture n'est pas faite pour leur texte actuel.

    Paramètres nommés : ``prompt_version``, ``mode``, ``limit``. L'empreinte des pièces se calcule ensuite
    (:func:`reading_fingerprint`) : un texte réécrit à l'identique ramène la vente une fois, sans appel au modèle.
    """
    groups = dict.fromkeys(required_empty_columns(name) for name in fields)
    open_empty = " or ".join("(" + " and ".join(f"sale.{column} is null" for column in group) + ")" for group in groups)
    return f"""
select sale.id::text, sale.source_url, latest.result, latest.updated_at, {_STATE},
       coalesce({_RETRY_DUE_SQL}, false), sale.property_type, sale.city,
       sale.raw_payload -> 'source_lot_selection'
{CANDIDATE_SALES_SQL}
   and ({open_empty})
   and (
     {_STATE} is null
     or {_STATE} ->> 'prompt_version' is distinct from %(prompt_version)s
     or ({_STATE} ->> 'text_at')::timestamptz < latest.updated_at
     or ({_STATE} ->> 'mode' = '{DRY_RUN}' and %(mode)s = '{WRITE}')
     or coalesce({_RETRY_DUE_SQL}, false)
   )
 order by latest.updated_at desc, sale.id
 limit %(limit)s
"""


def reading_fingerprint(manifest: object, sold_lot: object) -> str:
    """Empreinte d'une lecture : version du prompt, pièces (adresse, empreinte du PDF, texte des pages) et lot vendu."""
    items = manifest if isinstance(manifest, list) else []
    digests = {str(item.get("url") or ""): item.get("sha256") for item in items if isinstance(item, Mapping)}
    pieces = [
        (doc.url, doc.document_type, digests.get(doc.url or ""), sorted(doc.pages.items()))
        for doc in documents_from_manifest(manifest)
    ]
    lot = [sold_lot.number, sold_lot.lot_count] if sold_lot is not None else None  # type: ignore[attr-defined]
    payload = json.dumps([PROMPT_VERSION, pieces, lot], ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Candidate:
    sale_id: str
    source_url: str
    manifest: object
    text_at: datetime | None
    state: Mapping[str, Any]
    retry_due: bool
    property_type: object
    city: object
    lot_selection: object


# --- Règles d'écriture ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ReadingSource:
    """D'où viennent les valeurs d'une lecture, pour leurs traces : les pièces lues (par index), les deux modèles, le
    moment de la lecture (ISO 8601, le ``read_at`` de l'état) et l'empreinte du PDF de chaque pièce (par URL, telle
    que le manifeste la donne)."""

    documents: Mapping[int, ReadingDocument]
    models: Mapping[str, str]
    read_at: str
    digests: Mapping[str, str] = field(default_factory=dict)


def manifest_digests(manifest: object) -> dict[str, str]:
    """L'empreinte du PDF de chaque pièce du manifeste ``pdf_text``, par URL."""
    items = manifest if isinstance(manifest, list) else []
    return {
        str(item["url"]): str(item["sha256"])
        for item in items
        if isinstance(item, Mapping) and item.get("url") and item.get("sha256")
    }


@dataclass
class WritePlan:
    """Ce que la passe écrirait sur une vente : la vente prête à écrire (None : rien), et l'issue de chaque champ
    retenu par les deux lecteurs (:data:`WRITTEN` ou un motif de refus)."""

    sale: AuctionSale | None
    outcomes: dict[str, str] = field(default_factory=dict)


def _empty(value: object) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _facts(sale: AuctionSale) -> dict[str, object]:
    return {column: getattr(sale, column) for column in FACT_COLUMNS}


def plan_write(
    sale: AuctionSale,
    verdicts: Mapping[str, Verdict],
    open_fields: Sequence[str],
    source: ReadingSource,
    registry_columns: frozenset[str] = frozenset(),
) -> WritePlan:
    """Applique les règles d'écriture à ``sale`` (jamais modifiée) ; rend la copie à écrire, avec ses traces.

    Après l'écriture, la vente passe par ``derive_sale_facts`` (la surface affichée et la surface bâtie se déduisent
    de la surface habitable ou Carrez) ; on la compare à la même déduction faite sans écriture, sur les faits de la
    fiche (:data:`FACT_COLUMNS`). Un fait qui change à cause de l'écriture doit être vide avant (sinon rien n'est écrit
    sur la vente), sauf les étiquettes de la surface (:data:`SURFACE_LABELS`), dont la valeur d'avant est tracée ; la
    mise à prix et la date d'audience ne changent jamais. Un champ que la déduction ne garde pas (surface sous le
    seuil, Carrez écartée par la surface habitable) n'est pas écrit. Chaque fait changé reçoit sa trace.

    ``registry_columns`` : les colonnes que le registre des pièces tient ou a tenues sur la vente
    (:func:`_registry_columns`). Un champ qui en touche une n'est jamais écrit, même si sa colonne est vide : une valeur
    libérée garde sa mémoire d'écho, qui retiendrait la valeur écrite.
    """
    outcomes: dict[str, str] = {}
    chosen: dict[str, Verdict] = {}
    for name in WRITABLE_FIELDS:
        verdict = verdicts.get(name)
        if verdict is None or verdict.status != ACCEPTED:
            continue
        if name not in open_fields:
            outcomes[name] = CLOSED
        elif registry_columns.intersection(required_empty_columns(name)):
            outcomes[name] = REGISTRY
        elif any(not _empty(getattr(sale, column)) for column in required_empty_columns(name)):
            outcomes[name] = FILLED
        elif name == ROOMS and sale.bedrooms_count is not None and int(str(verdict.value)) < sale.bedrooms_count:
            outcomes[name] = FEWER_ROOMS
        else:
            chosen[name] = verdict
    if not chosen:
        return WritePlan(None, outcomes)
    baseline = sale.model_copy(deep=True)
    derive_sale_facts(baseline)
    stored, before = _facts(sale), _facts(baseline)
    if any(
        not _empty(stored[column]) and not _pdf_values_match(before[column], stored[column])
        for column in FACT_COLUMNS
        if column not in UNTRACED_COLUMNS
    ):
        # La déduction seule changerait un fait déjà rempli (règles qui ont changé depuis la dernière écriture de la
        # fiche) : l'écriture le publierait sans que la lecture y soit pour rien. Rien n'est écrit. Le texte d'appui
        # de la surface n'est pas un fait : il se refait à chaque écriture de la fiche.
        return WritePlan(None, {**outcomes, **dict.fromkeys(chosen, DRIFT)})
    written = sale.model_copy(deep=True)
    for name, verdict in chosen.items():
        setattr(written, name, verdict.value)
    derive_sale_facts(written)
    after = _facts(written)
    changed = [column for column in FACT_COLUMNS if not _pdf_values_match(after[column], before[column])]
    relabelled = (*SURFACE_LABELS, *UNTRACED_COLUMNS)
    refusal = None
    if any(column in NEVER_WRITTEN for column in changed):
        refusal = FORBIDDEN
    elif registry_columns.intersection(changed):
        refusal = REGISTRY
    elif any(not _empty(before[column]) for column in changed if column not in relabelled):
        refusal = TOUCHES_FILLED
    elif (
        written.rooms_count is not None
        and written.bedrooms_count is not None
        and written.rooms_count < written.bedrooms_count
    ):
        refusal = FEWER_ROOMS
    kept = [name for name in chosen if name in changed and _pdf_values_match(after[name], chosen[name].value)]
    for name in chosen:
        outcomes[name] = refusal or (WRITTEN if name in kept else NOT_KEPT)
    if refusal or not kept:
        return WritePlan(None, outcomes)
    for column in changed:
        if column in UNTRACED_COLUMNS or _empty(after[column]):
            continue
        origin = column if column in kept else kept[0]
        _record_trace(
            written, column, chosen[origin], before[column], source, derived_from=None if column in kept else origin
        )
    return WritePlan(written, outcomes)


def _record_trace(
    sale: AuctionSale,
    column: str,
    verdict: Verdict,
    previous: object,
    source: ReadingSource,
    *,
    derived_from: str | None,
) -> None:
    """La trace d'une colonne écrite (ou refaite par la déduction) : jamais la citation."""
    page = verdict.page
    document = source.documents.get(page.document) if page is not None else None
    details: dict[str, object] = {
        "reader": TRACE_READER,
        "prompt_version": PROMPT_VERSION,
        "models": dict(source.models),
        "read_at": source.read_at,
        "document_index": page.document if page is not None else None,
        "document_type": document.document_type if document is not None else None,
    }
    digest = source.digests.get(document.url or "") if document is not None else None
    if digest:
        # Une relecture des pièces garde la trace tant que cette pièce est lue telle quelle (TRACE_READER).
        details["document_sha256"] = digest
    if derived_from is not None:
        details["derived_from"] = derived_from
    pdf_record_fact_projection(
        sale,
        [column],
        document_url=(document.url or "") if document is not None else "",
        page_number=page.page if page is not None else None,
        baseline=previous,
        details=details,
    )


def vision_traces(sale: AuctionSale, *, prompt_version: str | None = None) -> set[str]:
    """Les colonnes dont la trace vient de cette lecture (de cette version du prompt, si elle est donnée)."""
    traces = sale.raw_payload.get("pdf_fact_provenance") if isinstance(sale.raw_payload, dict) else None
    return {
        column
        for column, trace in (traces.items() if isinstance(traces, dict) else [])
        if isinstance(trace, dict)
        and trace.get("reader") == TRACE_READER
        and (prompt_version is None or trace.get("prompt_version") == prompt_version)
    }


def withdraw_values(sale: AuctionSale, *, prompt_version: str | None = None) -> dict[str, set[str]]:
    """Retire de ``sale`` les valeurs écrites par cette lecture : ``_clear_pdf_fact_projections`` sur leurs seules
    traces (la case reprend la valeur de l'annonce, ou redevient vide), puis la déduction de la fiche. Une valeur
    changée depuis par un autre chemin reste, avec sa trace (``preserved``)."""
    columns = vision_traces(sale, prompt_version=prompt_version)
    if not columns:
        return {"cleared": set(), "preserved": set()}
    result = _clear_pdf_fact_projections(sale, fields=columns)
    derive_sale_facts(sale)
    return result


# --- Base et fiche ----------------------------------------------------------------------------------------------------

_RECORD_STATE_SQL = f"""
update public.auction_sales
   set raw_payload = jsonb_set(coalesce(raw_payload, '{{}}'::jsonb), '{{{STATE_KEY}}}', %s, true)
 where source_url = %s
   and (raw_payload is null or jsonb_typeof(raw_payload) = 'object')
"""

_TRACED_SALES_SQL = """
select sale.source_url
  from public.auction_sales sale
 where jsonb_typeof(sale.raw_payload -> 'pdf_fact_provenance') = 'object'
   and exists (
     select 1
       from jsonb_each(sale.raw_payload -> 'pdf_fact_provenance') trace
      where trace.value ->> 'reader' = %s
        and (%s::text is null or trace.value ->> 'prompt_version' = %s)
   )
 order by sale.source_url
"""


# Les colonnes que le registre des pièces tient ou a tenues sur la vente (valeur tenue, ou libérée avec sa mémoire
# d'écho), par la fonction serveur de la migration 20261208100100 : le pipeline ne lit pas lui-même l'état du registre,
# et la correspondance entre champs et colonnes reste celle de la base.
_REGISTRY_COLUMNS_SQL = "select app_private.sale_registry_columns(%s)"

# Les objets des migrations dont la passe dépend (20261208100000 et 20261208100100).
_SCHEMA_SQL = """
select pg_catalog.to_regclass('public.document_reading_exclusions') is not null
   and pg_catalog.to_regprocedure('app_private.sale_registry_columns(text)') is not null
"""

# Le dernier texte des pièces de la vente, relu sous le verrou avant d'écrire (même choix que CANDIDATE_SALES_SQL).
_LATEST_MANIFEST_SQL = """
select extraction.result
  from public.auction_extractions extraction
 where extraction.source_url = %s
   and extraction.provider = 'pdf_text'
   and jsonb_typeof(extraction.result) = 'array'
 order by extraction.updated_at desc
 limit 1
"""


class RegistryUnavailable(RuntimeError):
    """Les colonnes du registre n'ont pas pu être lues : la passe s'arrête, sans compter d'essai."""


class PiecesChanged(RuntimeError):
    """Les pièces ont changé entre la lecture et l'écriture : rien n'est écrit, la vente reste à relire."""


def _connect(db_url: str) -> Any:
    from src.storage.supabase_client import connect

    return connect(db_url)


def _select_candidates(db_url: str, settings: VisionSettings, limit: int) -> list[Candidate]:
    with _connect(db_url) as connection:
        rows = connection.execute(
            candidates_sql(settings.fields),
            {"prompt_version": PROMPT_VERSION, "mode": settings.mode, "limit": int(limit)},
        ).fetchall()
    return [
        Candidate(
            sale_id=str(sale_id),
            source_url=str(source_url),
            manifest=manifest,
            text_at=text_at,
            state=state if isinstance(state, Mapping) else {},
            retry_due=bool(retry_due),
            property_type=property_type,
            city=city,
            lot_selection=lot_selection,
        )
        for (sale_id, source_url, manifest, text_at, state, retry_due, property_type, city, lot_selection) in rows
    ]


def _is_excluded(db_url: str, source_url: str) -> bool:
    with _connect(db_url) as connection:
        return is_sale_excluded_from_document_reading(connection, source_url)


def _schema_ready(db_url: str) -> bool:
    with _connect(db_url) as connection:
        row = connection.execute(_SCHEMA_SQL).fetchone()
    return bool(row and row[0])


def _registry_columns(db_url: str, source_url: str) -> frozenset[str]:
    try:
        with _connect(db_url) as connection:
            row = connection.execute(_REGISTRY_COLUMNS_SQL, (source_url,)).fetchone()
    except Exception as exc:  # fonction absente, droit refusé, base injoignable : rien ne peut être jugé
        raise RegistryUnavailable(type(exc).__name__) from exc
    return frozenset(str(column) for column in (row[0] if row and row[0] else []))


def _latest_manifest(db_url: str, source_url: str) -> object:
    with _connect(db_url) as connection:
        row = connection.execute(_LATEST_MANIFEST_SQL, (source_url,)).fetchone()
    return row[0] if row else None


def _sales_of_url(db_url: str, url: str) -> list[str]:
    """Les ventes que désigne ``url`` par la règle des exclusions : la sienne, ou celle qui l'a absorbée."""
    with _connect(db_url) as connection:
        rows = connection.execute(SALES_OF_URL_SQL, {"url": url}).fetchall()
    return [str(row[0]) for row in rows]


def _record_state(db_url: str, source_url: str, state: Mapping[str, object]) -> None:
    """Écrit l'état de la lecture dans ``raw_payload`` de la vente, et rien d'autre (même à blanc)."""
    with _connect(db_url) as connection:
        connection.execute(_RECORD_STATE_SQL, (Jsonb(dict(state)), source_url))


def _fetch_sale(source_url: str) -> AuctionSale | None:
    from src.storage.supabase_client import fetch_sale_for_data_refresh

    return fetch_sale_for_data_refresh(source_url)


def _write_sale(sale: AuctionSale) -> bool:
    """Écrit la vente par le chemin de la reprojection ; False si l'écriture a été écartée."""
    from src.pdf_pass_outcomes import final_write_was_discarded
    from src.storage.supabase_client import upsert_sales_to_supabase

    written = upsert_sales_to_supabase([sale], refresh_last_seen=False)
    return not final_write_was_discarded(written, sale)


@contextmanager
def _catalogue_lock(db_url: str, wait_seconds: float) -> Iterator[Any]:
    from src.catalogue_lock import catalogue_writer_lock

    with catalogue_writer_lock(db_url, label="document vision", wait_seconds=wait_seconds) as lock:
        yield lock


def _readers(max_calls: int) -> tuple[Any, Any]:
    from src.document_vision_reading import SpendCap, anthropic_reader
    from src.enrichment.anthropic_reader import HAIKU, SONNET
    from src.pipeline_usage import llm_daily_budget_eur

    # Pas de plafond propre à la passe : le budget quotidien partagé (un dollar compté pour un euro) borne déjà
    # chaque appel, réservé avant l'envoi.
    spend = SpendCap(max_usd=llm_daily_budget_eur())
    return (
        anthropic_reader("principal", HAIKU, max_calls, spend, PRIMARY_TIMEOUT_SECONDS),
        anthropic_reader("second", SONNET, max_calls, spend, SECOND_TIMEOUT_SECONDS),
    )


# --- La passe -----------------------------------------------------------------------------------------------------


@dataclass
class PassReport:
    mode: str
    candidates: int = 0
    read: int = 0
    unchanged: int = 0
    waiting: int = 0
    failed: int = 0
    abandoned: int = 0
    missing: int = 0
    # Ventes qu'aucun appel n'a pu lire (pièces absentes du cache, PDF différent, illisible) : lues quand leurs
    # pièces auront été relues.
    waiting_pieces: int = 0
    # Ventes dont les pièces ont changé entre la lecture et l'écriture : à relire.
    pieces_changed: int = 0
    # Pièces prises dans le cache local, et pièces demandées qui n'y étaient pas (jamais téléchargées par la passe).
    pieces_from_cache: int = 0
    pieces_not_cached: int = 0
    stop_reason: str | None = None
    # Par champ retenu par les deux lecteurs : issue (:data:`WRITTEN` ou motif de refus) -> nombre de ventes.
    fields: dict[str, Counter[str]] = field(default_factory=dict)

    def count(self, outcomes: Mapping[str, str]) -> None:
        for name, outcome in outcomes.items():
            self.fields.setdefault(name, Counter())[outcome] += 1

    def as_dict(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "candidates": self.candidates,
            "read": self.read,
            "unchanged": self.unchanged,
            "waiting": self.waiting,
            "failed": self.failed,
            "abandoned": self.abandoned,
            "missing": self.missing,
            "waiting_pieces": self.waiting_pieces,
            "pieces_changed": self.pieces_changed,
            "pieces_from_cache": self.pieces_from_cache,
            "pieces_not_cached": self.pieces_not_cached,
            # La passe n'a aucun chemin vers le réseau des sites : ses pièces viennent du cache local.
            "site_requests": 0,
            "stop_reason": self.stop_reason,
            "fields": {name: dict(sorted(counts.items())) for name, counts in sorted(self.fields.items())},
        }


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _log_outcomes(
    sale_id: str, mode: str, plan: WritePlan, verdicts: Mapping[str, Verdict], documents: Mapping[int, ReadingDocument]
) -> None:
    """Une ligne par champ retenu : identifiant de la vente, champ, valeur, pièce (index et type), page, issue.

    Jamais la citation, ni l'URL de la vente ou de la pièce. À blanc, une valeur qui serait écrite se lit
    ``would_write``."""
    for name, outcome in plan.outcomes.items():
        verdict = verdicts[name]
        page = verdict.page
        document = documents.get(page.document) if page is not None else None
        LOGGER.info(
            "Document vision %s: sale %s field %s value %s piece D%s (%s) page %s -> %s",
            mode,
            sale_id,
            name,
            verdict.value,
            page.document if page is not None else "-",
            document.document_type if document is not None else "-",
            page.page if page is not None else "-",
            "would_write" if mode == DRY_RUN and outcome == WRITTEN else outcome,
        )


def run_pass(
    db_url: str,
    settings: VisionSettings,
    *,
    max_sales: int = MAX_SALES,
    budget_seconds: float = BUDGET_SECONDS,
    readers: tuple[Any, Any] | None = None,
    today: date | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> PassReport:
    """Une passe : lit au plus ``max_sales`` ventes, et n'en commence plus une s'il reste moins de
    :data:`SALE_RESERVE_SECONDS` avant ``budget_seconds``."""
    from src.catalogue_lock import CatalogueLockTimeout
    from src.document_vision_reading import ReadingStopped, read_sale
    from src.french_dates import PARIS

    report = PassReport(mode=settings.mode)
    if settings.mode == OFF or not settings.fields:
        # Sans champ ouvert, aucune lecture ne pourrait rien écrire, même à blanc : rien n'est lu ni payé.
        report.stop_reason = OFF if settings.mode == OFF else "no_open_field"
        return report
    started = clock()
    if not _schema_ready(db_url):
        # Migrations pas encore appliquées : rien n'est lu, rien n'est payé, aucun essai n'est compté.
        report.stop_reason = "schema_missing"
        return report
    candidates = _select_candidates(db_url, settings, max_sales)
    report.candidates = len(candidates)
    if not candidates:
        return report
    primary, second = readers if readers is not None else _readers(max_sales)
    models = {"primary": primary.stats.model, "second": second.stats.model}

    def pieces_of(sale: AuctionSale) -> Callable[[Mapping[str, Any], Sequence[str]], FetchedPieces]:
        def fetch(_row: Mapping[str, Any], urls: Sequence[str]) -> FetchedPieces:
            # Le cache local des pièces seulement : aucune requête aux sites.
            fetched = cached_sale_pdfs(sale, urls)
            report.pieces_from_cache += len(fetched.pdfs)
            report.pieces_not_cached += sum(1 for url in urls if fetched.missing.get(url) == NO_PDF_NOT_CACHED)
            return fetched

        return fetch
    today = today or datetime.now(PARIS).date()
    for candidate in candidates:
        if budget_seconds - (clock() - started) < SALE_RESERVE_SECONDS:
            report.stop_reason = "budget"
            break
        state = dict(candidate.state)
        text_at = candidate.text_at.isoformat() if isinstance(candidate.text_at, datetime) else candidate.text_at
        sold_lot = sold_lot_from_sale(candidate.property_type, candidate.city, candidate.lot_selection)
        fingerprint = reading_fingerprint(candidate.manifest, sold_lot)
        same = state.get("prompt_version") == PROMPT_VERSION and state.get("fingerprint") == fingerprint
        read_in_mode = not (settings.mode == WRITE and state.get("mode") == DRY_RUN)
        if same and state.get("status") == "completed" and read_in_mode:
            # Texte réécrit à l'identique : rien à relire.
            _record_state(db_url, candidate.source_url, {**state, "text_at": text_at})
            report.unchanged += 1
            continue
        if same and state.get("status") == "failed" and not candidate.retry_due:
            _record_state(db_url, candidate.source_url, {**state, "text_at": text_at})
            report.waiting += 1
            continue
        attempts = int(state.get("attempts") or 0) if same and state.get("status") == "failed" else 0
        sale = _fetch_sale(candidate.source_url)
        if sale is None:
            report.missing += 1
            continue
        row = {
            "id": candidate.sale_id,
            "source_url": candidate.source_url,
            "raw_payload": sale.raw_payload,
            "property_type": sale.property_type,
            "city": sale.city,
            "quality_flags": sale.quality_flags,
            "result": candidate.manifest,
        }
        try:
            reading, skipped = read_sale(
                row, primary, second, pieces_of(sale), today=today, stage=PASS_STAGE, reason=PASS_REASON
            )
        except ReadingStopped as exc:
            # Budget partagé ou plafond : la vente n'est pas comptée, son état ne change pas.
            report.stop_reason = str(exc)
            break
        read_at = _now()
        new_state: dict[str, object] = {
            "prompt_version": PROMPT_VERSION,
            "fingerprint": fingerprint,
            "mode": settings.mode,
            "read_at": read_at,
            "text_at": text_at,
        }
        if reading is None and skipped not in (NO_FIELD_PAGE, PRIMARY_FAILED):
            # Aucun appel n'a été fait (pièces absentes du cache, PDF différent du texte lu, illisible, extrait vide) :
            # rien n'a été payé. La vente revient quand ses pièces sont relues (texte réécrit), sans essai compté.
            waiting = {**new_state, "status": "waiting_pieces", "attempts": attempts, "waiting_for": skipped}
            _record_state(db_url, candidate.source_url, waiting)
            report.waiting_pieces += 1
            continue
        failure = SECOND_FAILED if reading is not None and reading.second_failed else None
        if reading is None and skipped != NO_FIELD_PAGE:
            failure = skipped
        if failure is None and reading is not None:
            source = ReadingSource(reading.documents, models, read_at, manifest_digests(candidate.manifest))
            try:
                plan = _apply(db_url, candidate.source_url, sale, settings, reading.final, source, fingerprint)
            except CatalogueLockTimeout:
                report.stop_reason = "catalogue_lock"
                break
            except RegistryUnavailable:
                # Le registre ne se lit plus : aucune écriture ne peut être jugée. La passe s'arrête, l'état de la vente
                # ne change pas (pas d'essai compté).
                report.stop_reason = "registry_unavailable"
                break
            except PiecesChanged:
                report.pieces_changed += 1
                continue
            except Exception as exc:  # une vente n'arrête jamais la passe
                LOGGER.warning("Document vision: sale %s not written (%s)", candidate.sale_id, type(exc).__name__)
                failure = WRITE_FAILED
            else:
                report.count(plan.outcomes)
                _log_outcomes(candidate.sale_id, settings.mode, plan, reading.final, reading.documents)
        if failure is not None:
            attempts += 1
            report.failed += 1
            report.abandoned += int(attempts >= MAX_FAILED_ATTEMPTS)
            failed_state = {**new_state, "status": "failed", "attempts": attempts, "failure": failure}
            _record_state(db_url, candidate.source_url, failed_state)
            continue
        report.read += 1
        _record_state(db_url, candidate.source_url, {**new_state, "status": "completed", "attempts": 0})
    return report


def _apply(
    db_url: str,
    source_url: str,
    sale: AuctionSale,
    settings: VisionSettings,
    verdicts: Mapping[str, Verdict],
    source: ReadingSource,
    fingerprint: str,
) -> WritePlan:
    """À blanc : les règles appliquées à la vente lue, rien n'est écrit. En écriture : sous le verrou du catalogue,
    sur la vente relue, après une seconde vérification de l'exclusion et de l'empreinte des pièces
    (:class:`PiecesChanged`). Le registre des pièces est lu dans les deux cas."""
    if settings.mode != WRITE:
        return plan_write(sale, verdicts, settings.fields, source, _registry_columns(db_url, source_url))
    accepted = [name for name in WRITABLE_FIELDS if name in verdicts and verdicts[name].status == ACCEPTED]
    if not accepted:
        return WritePlan(None)
    with _catalogue_lock(db_url, LOCK_WAIT_SECONDS) as lock:
        if _is_excluded(db_url, source_url):
            return WritePlan(None, dict.fromkeys(accepted, EXCLUDED))
        current = _fetch_sale(source_url)
        if current is None:
            return WritePlan(None)
        lot_selection = current.raw_payload.get("source_lot_selection")
        sold_lot = sold_lot_from_sale(current.property_type, current.city, lot_selection)
        if reading_fingerprint(_latest_manifest(db_url, source_url), sold_lot) != fingerprint:
            raise PiecesChanged(source_url)
        plan = plan_write(current, verdicts, settings.fields, source, _registry_columns(db_url, source_url))
        if plan.sale is None:
            return plan
        lock.ensure_held()
        if not _write_sale(plan.sale):
            outcomes = {
                name: NOT_RECORDED if outcome == WRITTEN else outcome for name, outcome in plan.outcomes.items()
            }
            return WritePlan(None, outcomes)
        return plan


# --- Retrait --------------------------------------------------------------------------------------------------------


def withdraw_sale(db_url: str, source_url: str, *, prompt_version: str | None = None) -> dict[str, int]:
    """Retire d'une vente les valeurs écrites par cette lecture, sous le verrou du catalogue (attendu jusqu'à
    :data:`WITHDRAW_LOCK_WAIT_SECONDS`). Lève ``CatalogueLockTimeout`` si le verrou ne vient pas."""
    with _catalogue_lock(db_url, WITHDRAW_LOCK_WAIT_SECONDS) as lock:
        sale = _fetch_sale(source_url)
        if sale is None:
            return {"sales": 0, "cleared": 0, "preserved": 0, "not_recorded": 0}
        result = withdraw_values(sale, prompt_version=prompt_version)
        recorded = True
        if result["cleared"]:
            lock.ensure_held()
            recorded = _write_sale(sale)
    return {
        "sales": 1,
        "cleared": len(result["cleared"]) if recorded else 0,
        "preserved": len(result["preserved"]),
        "not_recorded": int(not recorded),
    }


def withdraw(db_url: str, *, prompt_version: str | None = None, source_url: str | None = None) -> dict[str, object]:
    """Retrait d'une version du prompt (sur toutes les ventes qui en portent une trace) ou d'une vente (par la règle
    des exclusions : son URL, ou une URL qu'elle a absorbée).

    Rend les comptes et ``pending`` : les ventes à reprendre, dont le verrou n'est pas venu, dont le retrait a échoué
    ou dont l'écriture a été écartée. Une vente n'arrête jamais le retrait des suivantes.
    """
    from src.catalogue_lock import CatalogueLockTimeout

    if source_url is not None:
        urls = _sales_of_url(db_url, source_url)
    else:
        with _connect(db_url) as connection:
            rows = connection.execute(_TRACED_SALES_SQL, (TRACE_READER, prompt_version, prompt_version)).fetchall()
        urls = [str(row[0]) for row in rows]
    totals: Counter[str] = Counter({"sales": 0, "cleared": 0, "preserved": 0, "not_recorded": 0})
    pending: list[str] = []
    for url in urls:
        try:
            result = withdraw_sale(db_url, url, prompt_version=prompt_version)
        except CatalogueLockTimeout:
            pending.append(url)
            continue
        except Exception as exc:  # une vente n'arrête pas le retrait des suivantes
            LOGGER.warning("Document vision withdrawal failed for one sale (%s)", type(exc).__name__)
            pending.append(url)
            continue
        totals.update(result)
        if result["not_recorded"]:
            pending.append(url)
    return {**totals, "pending": pending}


def withdrawal_complete(result: Mapping[str, object]) -> bool:
    """Toutes les ventes visées ont été traitées et chaque écriture de retrait a été enregistrée."""
    return not result.get("pending") and not result.get("not_recorded")


# --- Commande -------------------------------------------------------------------------------------------------------


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-sales", type=int, default=MAX_SALES)
    parser.add_argument("--budget-minutes", type=float, default=BUDGET_SECONDS / 60)
    parser.add_argument("--withdraw", action="store_true", help="retire les valeurs écrites par cette lecture")
    parser.add_argument(
        "--prompt-version",
        help="avec --withdraw : celles de cette version du prompt (avec DOCUMENT_VISION_MODE=off pendant le retrait)",
    )
    parser.add_argument("--sale", help="avec --withdraw : celles de cette vente (URL source)")
    args = parser.parse_args(argv)
    if args.withdraw and (args.prompt_version is None) == (args.sale is None):
        parser.error("--withdraw demande --prompt-version ou --sale, et un seul des deux")
    if not args.withdraw and (args.prompt_version is not None or args.sale is not None):
        parser.error("--prompt-version et --sale vont avec --withdraw")
    if not 1 <= args.max_sales <= MAX_SALES or not 0 < args.budget_minutes <= BUDGET_SECONDS / 60:
        parser.error(f"au plus {MAX_SALES} ventes et {BUDGET_SECONDS // 60} minutes par passe")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    settings = load_settings()
    db_url = str(settings.get("supabase_db_url") or "")
    if args.withdraw:
        if not db_url:
            print("SUPABASE_DB_URL est requise.", file=sys.stderr)
            return 2
        result = withdraw(db_url, prompt_version=args.prompt_version, source_url=args.sale)
        print(json.dumps(result))
        # Une vente non traitée ou une écriture écartée : en erreur, pour relancer la commande.
        return 0 if withdrawal_complete(result) else 1
    try:
        vision = vision_settings(settings)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if vision.mode == OFF:
        print(json.dumps({"skipped": "DOCUMENT_VISION_MODE is off"}))
        return 0
    if not db_url or not settings.get("anthropic_api_key"):
        print("SUPABASE_DB_URL et ANTHROPIC_API_KEY sont requises.", file=sys.stderr)
        return 2
    # Le téléchargement des pièces journalise leurs URL : seules les erreurs sortent dans le journal.
    logging.getLogger("src.pdf_enrichment").setLevel(logging.ERROR)
    report = run_pass(db_url, vision, max_sales=args.max_sales, budget_seconds=args.budget_minutes * 60)
    print(json.dumps(report.as_dict(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
