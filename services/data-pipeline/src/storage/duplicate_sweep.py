"""Balayage des doublons déjà publiés : lecture paginée, plan de fusion et rapport de candidats.

Ce module ne fait aucune écriture. ``supabase_client.reconcile_duplicate_sales_in_supabase`` applique le
plan (fusion puis suppression des lignes secondaires) ; ``python -m src.dedupe_candidates`` ou
``DEDUPE_RECONCILE_MODE=candidates`` n'en publient que le rapport, pour relecture par le propriétaire
avant d'activer ``DEDUPE_RECONCILE_ENABLED``. Le rapport ne contient ni adresse ni coordonnée de contact.
"""

from __future__ import annotations

import json
import logging
import os
from collections import Counter
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from pathlib import Path
from typing import Any

import httpx

from src.dedupe import SWEEP_STRICT_EXCLUDED_SOURCES, SWEEP_STRICT_MAX_GROUP, merge_duplicate_sales
from src.models import AuctionSale
from src.position_quality import PROBABLE_DUPLICATE
from src.reviewed_aliases import ReviewedAliasRegistry
from src.storage.column_sets import DEDUPLICATION_SALE_SELECT
from src.storage.postgrest_helpers import _postgrest_in_filter, _rest_headers
from src.storage.sale_row_builders import _secondary_source_urls

LOGGER = logging.getLogger(__name__)

# Lignes complètes (raw_payload, raw_text...) : 1 000 par page dépassait le statement_timeout (57014, 28/10/2026).
PAGE_SIZE = 100
MIN_PAGE_SIZE = 10
PAGE_SIZE_ENV = "DEDUPE_RECONCILE_PAGE_SIZE"
_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
# Un groupe de plus de 5 lignes (la fiche conservée et ses lignes secondaires) n'est jamais fusionné
# automatiquement : il reste à relire à la main.
MAX_GROUP_ROWS = 5

# Raisons internes (dedupe_confidence) rendues lisibles.
REASON_LABELS = {
    "listing_id": "identifiant d'annonce commun (Vench / Petites Affiches), même lieu, même jour ou même prix",
    "address": "même adresse précise",
    "content_hash": "même contenu (hash)",
    "source_url": "même URL source",
    "strict_key": "clé de repli stricte (même tribunal, même jour, même mise à prix, même bien), hors Vench / Petites Affiches",
    "streetless": "annonce sans voie rattachée à la vente qui a l'adresse (même tribunal, même audience, même commune, mise à prix à 1 % près)",
}

# Mention du rapport quand le balayage est partiel : des doublons peuvent exister hors des lignes lues.
PARTIAL_LABELS = {
    "read_ceiling": "plafond de lecture atteint : balayage partiel",
    "fetch_error": "lecture interrompue par une erreur Supabase : balayage partiel",
}


@dataclass(frozen=True)
class DuplicateRowSummary:
    id: str | None
    source_name: str
    source_url: str
    city: str | None
    sale_date: str | None
    starting_price_eur: str | None
    status: str | None
    # Drapeaux de qualité de la ligne avant la fusion (``src.probable_duplicates`` y pose ou retire un drapeau).
    quality_flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class DuplicateMergeGroup:
    """Une ligne conservée (primary) et les lignes que le balayage supprimerait (secondaries)."""

    primary: DuplicateRowSummary
    secondaries: tuple[DuplicateRowSummary, ...]
    reason: str


@dataclass
class DuplicateSweepPlan:
    scanned: int = 0
    truncated: bool = False
    # Pourquoi le balayage est partiel : « read_ceiling » (plafond de lignes) ou « fetch_error » (lecture
    # interrompue par une erreur HTTP). ``None`` quand ``truncated`` est faux.
    truncation_reason: str | None = None
    groups: list[DuplicateMergeGroup] = dataclass_field(default_factory=list)
    # Lignes fusionnées à écrire (usage interne de l'application, absent du rapport).
    impacted_sales: list[AuctionSale] = dataclass_field(default_factory=list)
    deferred_rows: int = 0
    # Groupes écartés parce qu'ils dépassent MAX_GROUP_ROWS lignes (à relire à la main).
    oversized_groups: int = 0
    reviewed_aliases: ReviewedAliasRegistry | None = None

    @property
    def secondary_count(self) -> int:
        return sum(len(group.secondaries) for group in self.groups)


@dataclass
class DedupeScan:
    truncated: bool = False
    truncation_reason: str | None = None

    def mark_truncated(self, reason: str) -> None:
        self.truncated = True
        # La première cause reste : une erreur survenue avant le plafond ne doit pas être masquée.
        self.truncation_reason = self.truncation_reason or reason


def _summary(sale: AuctionSale) -> DuplicateRowSummary:
    return DuplicateRowSummary(
        id=sale.id,
        source_name=sale.source_name,
        source_url=sale.source_url,
        city=sale.city,
        sale_date=sale.sale_date.isoformat() if sale.sale_date else None,
        starting_price_eur=str(sale.starting_price_eur) if sale.starting_price_eur is not None else None,
        status=sale.status,
        quality_flags=tuple(flag for flag in sale.quality_flags if isinstance(flag, str)),
    )


def _page_size() -> int:
    """Taille de page demandée : ``DEDUPE_RECONCILE_PAGE_SIZE`` (10 à 1 000), 100 par défaut."""
    try:
        requested = int(os.getenv(PAGE_SIZE_ENV, "") or PAGE_SIZE)
    except ValueError:
        requested = PAGE_SIZE
    return min(1000, max(MIN_PAGE_SIZE, requested))


def _is_statement_timeout(response: Any) -> bool:
    """Délai SQL dépassé : code Postgres 57014 (renvoyé en 500 par PostgREST) ou 408 / 504."""
    text = str(getattr(response, "text", "") or "")
    return response.status_code in {408, 504} or "57014" in text or "statement timeout" in text.lower()


def fetch_candidate_rows(
    supabase_url: str,
    api_key: str,
    *,
    statuses: tuple[str, ...],
    limit: int,
    protected_ids: frozenset[str] | set[str],
    scan: DedupeScan | None = None,
) -> list[dict[str, Any]]:
    """Lit toutes les pages jusqu'à ``limit`` lignes (hors lignes protégées par un alias relu).

    Pagination par curseur sur ``id`` (``order=id.asc`` puis ``id=gt.<dernier id>``) : stable même si des
    lignes changent pendant le balayage, et sans le coût croissant d'un décalage. Les lignes sont lourdes
    (``raw_payload``, ``raw_text``) : pages de ``DEDUPE_RECONCILE_PAGE_SIZE`` lignes (100 par défaut). Un
    délai dépassé (code 57014, 408/504, délai réseau) divise la taille de page par deux et relit la même page,
    jusqu'à ``MIN_PAGE_SIZE`` ; au-delà, ou pour toute autre erreur, le balayage est partiel.
    La fin des données est une page vide : le serveur peut plafonner la taille de page (``max_rows`` de
    PostgREST) sous la taille demandée, et une page courte ne prouve alors rien. Une erreur HTTP ou réseau
    en cours de route, comme le plafond de lecture, rend le balayage partiel (``scan.truncated``).
    """
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/auction_sales"
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    page_size = _page_size()
    while True:
        params: dict[str, str] = {
            "select": DEDUPLICATION_SALE_SELECT,
            "order": "id.asc",
            "limit": str(page_size),
        }
        if cursor is not None:
            params["id"] = f"gt.{cursor}"
        if statuses:
            params["status"] = _postgrest_in_filter(list(statuses))
        timed_out = False
        try:
            response = httpx.get(
                endpoint,
                params=params,
                headers=_rest_headers(api_key, prefer="count=none"),
                timeout=_TIMEOUT,
            )
            failure = f"({response.status_code}) {response.text[:300]}" if response.is_error else None
            timed_out = failure is not None and _is_statement_timeout(response)
        except httpx.HTTPError as exc:
            failure, timed_out = str(exc), isinstance(exc, httpx.TimeoutException)
        if failure is not None:
            if timed_out and page_size > MIN_PAGE_SIZE:
                smaller = max(MIN_PAGE_SIZE, page_size // 2)
                LOGGER.warning(
                    "Supabase duplicate reconciliation page timed out after %s rows (%s rows per page): "
                    "retrying with %s",
                    len(rows),
                    page_size,
                    smaller,
                )
                page_size = smaller
                continue
            LOGGER.warning(
                "Supabase duplicate reconciliation fetch failed %s after %s rows; the scan is partial",
                failure,
                len(rows),
            )
            if scan is not None:
                scan.mark_truncated("fetch_error")
            break
        page_rows = response.json()
        if not page_rows:
            break
        rows.extend(
            row
            for row in page_rows
            if isinstance(row, dict) and (not row.get("id") or str(row["id"]) not in protected_ids)
        )
        last = page_rows[-1]
        if not isinstance(last, dict) or not last.get("id"):
            LOGGER.warning("Duplicate reconciliation page without row id after %s rows; the scan is partial", len(rows))
            if scan is not None:
                scan.mark_truncated("fetch_error")
            break
        cursor = str(last["id"])
        if len(rows) >= limit:
            # Plafond de lecture atteint sans avoir vu la page vide : le balayage est partiel.
            if scan is not None:
                scan.mark_truncated("read_ceiling")
            LOGGER.warning(
                "Duplicate reconciliation reached its read ceiling (%s rows); later rows are not examined. "
                "Raise DEDUPE_RECONCILE_MAX_ROWS if the catalogue is larger.",
                limit,
            )
            break
    return rows[:limit]


def build_plan(
    sales: list[AuctionSale],
    reviewed_aliases: ReviewedAliasRegistry,
    *,
    max_merges: int | None,
    truncated: bool = False,
    truncation_reason: str | None = None,
) -> DuplicateSweepPlan:
    """Fusionne en mémoire les lignes lues et en déduit les groupes à fusionner.

    ``max_merges`` plafonne les lignes secondaires supprimées par passage, par groupes entiers : les
    groupes au-delà restent en l'état (``deferred_rows``) et sont repris au passage suivant. ``None`` :
    pas de plafond (rapport de candidats).
    """
    plan = DuplicateSweepPlan(
        scanned=len(sales),
        truncated=truncated,
        truncation_reason=(truncation_reason or "read_ceiling") if truncated else None,
        reviewed_aliases=reviewed_aliases,
    )
    if len(sales) < 2:
        return plan
    # Résumés pris avant la fusion : elle recopie dans la survivante les champs des lignes absorbées.
    summaries = {sale.source_url: _summary(sale) for sale in sales}
    # Le balayage supprime les lignes secondaires : la preuve (adresse précise, identifiant d'annonce
    # commun) d'abord ; la clé de repli stricte seulement hors Vench / Petites Affiches et hors d'un
    # (jour, prix) partagé par plus de SWEEP_STRICT_MAX_GROUP annonces (lots distincts au même prix).
    merged = merge_duplicate_sales(
        sales,
        strict_excluded_sources=SWEEP_STRICT_EXCLUDED_SOURCES,
        strict_max_group=SWEEP_STRICT_MAX_GROUP,
    )
    protected_urls = reviewed_aliases.protected_source_urls()
    # Seule une ligne lue est une ligne à supprimer. Une URL absorbée par un passage précédent reste dans les
    # source_urls de la survivante sans ligne propre : elle ne doit ni ouvrir un groupe ni compter dans le plafond.
    all_secondary = set(_secondary_source_urls(merged)) & set(summaries)
    kept = 0
    for sale in merged:
        secondary_urls = [
            source_url
            for source_url in dict.fromkeys(sale.source_urls)
            if source_url and source_url in all_secondary and source_url not in protected_urls
        ]
        if not secondary_urls:
            continue
        # Plus de MAX_GROUP_ROWS lignes pour une même fiche : trop pour une preuve automatique, à relire.
        if len(secondary_urls) + 1 > MAX_GROUP_ROWS:
            plan.oversized_groups += 1
            continue
        # Un groupe plus gros que le plafond ne se fusionne jamais seul : il reste à relire à la main.
        if max_merges is not None and kept + len(secondary_urls) > max_merges:
            plan.deferred_rows += len(secondary_urls)
            continue
        kept += len(secondary_urls)
        # La fusion recopie les drapeaux de la ligne absorbée : la survivante n'est pas une copie.
        sale.quality_flags = [flag for flag in sale.quality_flags if flag != PROBABLE_DUPLICATE]
        plan.impacted_sales.append(sale)
        plan.groups.append(
            DuplicateMergeGroup(
                primary=summaries.get(sale.source_url) or _summary(sale),
                secondaries=tuple(summaries[url] for url in secondary_urls if url in summaries),
                reason=sale.dedupe_confidence or "unknown",
            )
        )
    return plan


# --- Rapport de candidats (lecture seule) -------------------------------------------------------


def _row_text(row: DuplicateRowSummary) -> str:
    return (
        f"{row.id or '-'} | {row.source_name} | {row.city or '-'} | {row.sale_date or '-'} | "
        f"{row.starting_price_eur or '-'} EUR | {row.source_url}"
    )


def _cell(row: DuplicateRowSummary) -> str:
    return (
        f"`{(row.id or '-')[:8]}` {row.source_name}, {row.city or '-'}, "
        f"{(row.sale_date or '-')[:16]}, {row.starting_price_eur or '-'} EUR"
    )


def candidate_lines(plan: DuplicateSweepPlan) -> list[str]:
    """Une ligne par paire (conservée / supprimée), prête pour un journal."""
    return [
        f"CONSERVEE {_row_text(group.primary)} <- SUPPRIMEE {_row_text(secondary)} :: "
        f"{REASON_LABELS.get(group.reason, group.reason)}"
        for group in plan.groups
        for secondary in group.secondaries
    ]


def candidates_as_dicts(plan: DuplicateSweepPlan) -> list[dict[str, object]]:
    def row(summary: DuplicateRowSummary) -> dict[str, object]:
        return {
            "id": summary.id,
            "source": summary.source_name,
            "city": summary.city,
            "sale_date": summary.sale_date,
            "starting_price_eur": summary.starting_price_eur,
            "status": summary.status,
            "source_url": summary.source_url,
        }

    return [
        {
            "reason": group.reason,
            "reason_label": REASON_LABELS.get(group.reason, group.reason),
            "kept": row(group.primary),
            "removed": [row(secondary) for secondary in group.secondaries],
        }
        for group in plan.groups
    ]


def markdown_summary(plan: DuplicateSweepPlan) -> str:
    by_reason = Counter(group.reason for group in plan.groups for _ in group.secondaries)
    partial = f" ({PARTIAL_LABELS.get(plan.truncation_reason or '', 'balayage partiel')})" if plan.truncated else ""
    parts = [
        "### Doublons candidats (aucune écriture)",
        f"- Lignes lues : {plan.scanned}{partial}",
        f"- Groupes à fusionner : {len(plan.groups)} ; lignes qui seraient supprimées : {plan.secondary_count}",
    ]
    for reason, count in sorted(by_reason.items()):
        parts.append(f"  - {REASON_LABELS.get(reason, reason)} : {count}")
    if plan.oversized_groups:
        parts.append(
            f"- Groupes de plus de {MAX_GROUP_ROWS} lignes écartés (à relire à la main) : {plan.oversized_groups}"
        )
    if plan.groups:
        parts += [
            "",
            "| Conservée (id, source, commune, date, prix) | Supprimée (id, source, commune, date, prix) | Raison |",
            "| --- | --- | --- |",
        ]
        for group in plan.groups:
            label = REASON_LABELS.get(group.reason, group.reason)
            parts += [f"| {_cell(group.primary)} | {_cell(secondary)} | {label} |" for secondary in group.secondaries]
    return "\n".join(parts) + "\n"


def emit_candidates_report(plan: DuplicateSweepPlan, *, output: Path | None = None) -> None:
    """Écrit le rapport dans le journal, le résumé de job GitHub (si présent) et un fichier JSON facultatif."""
    LOGGER.info(
        "Duplicate candidates (no write): scanned=%s truncated=%s reason=%s groups=%s rows_to_remove=%s",
        plan.scanned,
        plan.truncated,
        plan.truncation_reason,
        len(plan.groups),
        plan.secondary_count,
    )
    for line in candidate_lines(plan):
        LOGGER.info("DUPLICATE_CANDIDATE %s", line)
    summary_path = os.getenv("GITHUB_STEP_SUMMARY")
    if summary_path:
        with Path(summary_path).open("a", encoding="utf-8") as handle:
            handle.write(markdown_summary(plan))
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        report = {
            "scanned": plan.scanned,
            "truncated": plan.truncated,
            "truncation_reason": plan.truncation_reason,
            "oversized_groups": plan.oversized_groups,
            "groups": candidates_as_dicts(plan),
        }
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
