"""Rapport des ventes sans le minimum d'une annonce déjà en base (src/listing_minimum.py), et suppression par la base.

La règle est la même que celle de l'écriture. La SUPPRESSION n'est plus faite ici : ``--execute-drop`` appelle
``app_private.delete_empty_listings`` (migration ``20261108202000``), la même fonction que la réparation
``supabase/repairs/20261108202100_delete_empty_listings.sql``. Elle lit les clés étrangères vers ``auction_sales`` dans la
base (une liste figée ici était incomplète : déblocages, événements de compte, avis, rappels, alias revus...), garde
toute vente qui a une trace utilisateur, un prix d'adjudication ou une issue connue, refait ce contrôle pour chaque vente
juste avant son delete et complète le pont du graphe des issues. Cette commande n'a donc PLUS de liste de protection
propre : celle du rapport (``PROTECTING_LINKS``) est indicative.

Utilisé par ``python -m src.recompute_scoring --drop-insufficient``. Rien ne s'exécute seul :

* par défaut c'est un RAPPORT (dry-run) : liste d'identifiants par source, motifs, et liens utilisateurs ;
* ``--execute-drop`` applique la fonction SQL à TOUT le catalogue (pas de ``--source`` ni ``--limit``, refusés) après un
  comptage : plus de ``--max-deletions`` ventes supprimables, rien n'est supprimé. AUCUN tombstone n'est écrit.

Le rapport ne contient que des identifiants techniques, des codes et des compteurs.
"""

from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from src.information_sufficiency import ContactBlocklist, sufficient_information

LOGGER = logging.getLogger(__name__)
DEFAULT_MAX_DELETIONS = 100
#: Plafond de ``p_limit`` de ``app_private.delete_empty_listings``.
CLEANUP_FUNCTION_MAX = 5000

#: (table, colonne vers auction_sales.id) lues par le RAPPORT seulement (indicatif : la suppression lit les clés
#: étrangères dans la base, ``app_private.empty_listing_links``).
PROTECTING_LINKS: tuple[tuple[str, str], ...] = (
    ("user_favorites", "sale_id"),
    ("saved_property_reports", "sale_id"),
    ("sale_workspaces", "sale_id"),
    ("sale_workspace_annotations", "sale_id"),
    ("user_sale_analysis_items", "sale_id"),
    ("information_agent_cases", "sale_id"),
    ("information_agent_missions", "sale_id"),
    ("lawyer_referral_requests", "sale_id"),
    ("lawyer_placement_events", "sale_id"),
    ("listing_publication_requests", "published_sale_id"),
)
#: Liens simplement signalés dans le rapport (supprimés en cascade, générés par le système).
INFORMATIONAL_LINKS: tuple[tuple[str, str], ...] = (
    ("user_alert_matches", "sale_id"),
    ("user_alert_notifications", "sale_id"),
)


@dataclass(frozen=True)
class Candidate:
    sale_id: str
    source_url: str
    source: str
    updated_at: str | None
    reasons: tuple[str, ...]


def evaluate_rows(
    rows: Iterable[Mapping[str, Any]],
    to_sale: Callable[[dict[str, Any]], Any],
    blocklist: ContactBlocklist,
) -> tuple[list[Candidate], Counter[str]]:
    """Rejoue les extracteurs sur les lignes stockées puis applique la règle (aucune écriture)."""
    candidates: list[Candidate] = []
    stats: Counter[str] = Counter()
    for row in rows:
        stats["evaluated"] += 1
        try:
            sale = to_sale(dict(row))
        except Exception as exc:  # noqa: BLE001 - une ligne illisible est comptée, jamais supprimée
            stats["unreadable"] += 1
            LOGGER.warning("Insufficient-information check skipped a row (%s)", type(exc).__name__)
            continue
        verdict = sufficient_information(sale, blocklist=blocklist)
        if verdict.sufficient:
            stats["kept"] += 1
            continue
        stats["insufficient"] += 1
        candidates.append(
            Candidate(
                sale_id=str(row["id"]),
                source_url=str(row.get("source_url") or ""),
                source=str(row.get("primary_source") or row.get("source_name") or "unknown"),
                updated_at=str(row["updated_at"]) if row.get("updated_at") else None,
                reasons=verdict.reasons,
            )
        )
    return candidates, stats


def fetch_links(settings: Mapping[str, Any], sale_ids: Sequence[str]) -> dict[str, dict[str, set[str]]]:
    """Pour chaque table liée, les identifiants de vente qui y sont référencés (lecture seule, REST)."""
    import httpx

    url = str(settings.get("supabase_url") or "").rstrip("/")
    key = str(settings.get("supabase_service_role_key") or "")
    if not url or not key:
        raise RuntimeError("Supabase URL/service role key are missing")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}
    found: dict[str, dict[str, set[str]]] = {"protecting": defaultdict(set), "informational": defaultdict(set)}
    for kind, links in (("protecting", PROTECTING_LINKS), ("informational", INFORMATIONAL_LINKS)):
        for table, column in links:
            for start in range(0, len(sale_ids), 100):
                chunk = sale_ids[start : start + 100]
                response = httpx.get(
                    f"{url}/rest/v1/{table}",
                    params={"select": column, column: f"in.({','.join(chunk)})", "limit": "1000"},
                    headers=headers,
                    timeout=60,
                )
                response.raise_for_status()
                for item in response.json():
                    if item.get(column):
                        found[kind][table].add(str(item[column]))
    return found


def build_report(
    candidates: Sequence[Candidate],
    stats: Mapping[str, int],
    links: Mapping[str, Mapping[str, set[str]]],
) -> dict[str, Any]:
    """Rapport sans donnée personnelle : identifiants techniques, codes et compteurs."""
    protected = set().union(*links.get("protecting", {}).values()) if links.get("protecting") else set()
    to_delete = [c for c in candidates if c.sale_id not in protected]
    by_source: dict[str, list[str]] = defaultdict(list)
    for candidate in to_delete:
        by_source[candidate.source].append(candidate.sale_id)
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "stats": dict(stats),
        "insufficient_total": len(candidates),
        "protected_user_linked": sorted(c.sale_id for c in candidates if c.sale_id in protected),
        "deletable_total": len(to_delete),
        "deletable_by_source": {source: sorted(ids) for source, ids in sorted(by_source.items())},
        "reasons": dict(Counter("+".join(c.reasons) for c in to_delete)),
        "links_among_candidates": {
            kind: {table: len(ids) for table, ids in tables.items()} for kind, tables in links.items()
        },
        "tombstones": "none: the URL stays re-importable",
    }


def execute_empty_listing_cleanup(connection: Any, max_deletions: int) -> dict[str, Any] | None:
    """Comptage puis suppression par ``app_private.delete_empty_listings``, dans la transaction de ``connection``.

    Renvoie le compte rendu de la fonction, ou ``None`` (rien supprimé) si le comptage dépasse ``max_deletions``.
    """
    if not 1 <= max_deletions <= CLEANUP_FUNCTION_MAX:
        raise ValueError(f"max_deletions must be between 1 and {CLEANUP_FUNCTION_MAX}")
    connection.execute("set local lock_timeout = '5s'")
    connection.execute("set local statement_timeout = '10min'")
    counted = connection.execute(
        "select app_private.delete_empty_listings(%s, false)", (CLEANUP_FUNCTION_MAX,)
    ).fetchone()[0]
    if int(counted.get("deletable") or 0) > max_deletions:
        LOGGER.error(
            "%s sales would be deleted, above --max-deletions=%s; refusing to delete anything",
            counted.get("deletable"), max_deletions,
        )
        return None
    return connection.execute("select app_private.delete_empty_listings(%s, true)", (max_deletions,)).fetchone()[0]


def drop_insufficient_sales(
    *,
    source: str | None,
    limit: int | None,
    execute: bool,
    max_deletions: int,
    report_path: str | None,
) -> int:
    """Rapport (par défaut) ou suppression (``execute``) ; renvoie un code de sortie."""
    from src.config import load_settings
    from src.information_sufficiency import load_contact_blocklist
    from src.recompute_scoring import _fetch_sales, _load_env_fallbacks, _sale_from_storage_row
    from src.storage.supabase_client import connect

    if execute and (source or limit):
        LOGGER.error(
            "--execute-drop applies app_private.delete_empty_listings to the whole catalogue: "
            "--source and --limit are refused with it (use the report to read a scope)"
        )
        return 1
    _load_env_fallbacks()
    settings = load_settings()
    rows = _fetch_sales(source=source, limit=limit)
    if not rows:
        LOGGER.error("No stored sales matched the requested scope")
        return 1
    blocklist = load_contact_blocklist(settings)
    candidates, stats = evaluate_rows(rows, _sale_from_storage_row, blocklist)
    links = fetch_links(settings, [c.sale_id for c in candidates]) if candidates else {}
    report = build_report(candidates, stats, links)
    report["mode"] = "execute" if execute else "dry-run"
    if report_path:
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False, sort_keys=True)
    _print_report(report, report_path)
    if not execute:
        print("- dry-run: nothing was deleted. Re-run with --execute-drop (whole catalogue) after reading the report.")
        return 0
    if stats["unreadable"]:
        LOGGER.error("%s rows could not be evaluated; refusing to delete anything", stats["unreadable"])
        return 1
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        LOGGER.error("SUPABASE_DB_URL is required for the transactional deletion")
        return 1
    with connect(db_url) as connection:
        result = execute_empty_listing_cleanup(connection, max_deletions)
    if result is None:
        return 1
    print(
        f"- deleted: {result['deleted']}; skipped: {result['skipped']}; "
        f"kept for a user trace: {result['kept_for_user_trace']}; kept for a known outcome: "
        f"{result['kept_for_known_outcome']}; set aside by a blocking link: {result['set_aside_by_blocking_link']}; "
        f"kept after the recheck: {result['kept_after_recheck']}"
    )
    return 0


def _print_report(report: Mapping[str, Any], report_path: str | None) -> None:
    print("Insufficient-information report")
    print(f"- stats: {report['stats']}")
    print(f"- insufficient: {report['insufficient_total']} (user-linked, protected: {len(report['protected_user_linked'])})")
    print(f"- deletable: {report['deletable_total']}")
    for source, ids in report["deletable_by_source"].items():
        print(f"  - {source}: {len(ids)}")
    print(f"- reasons: {report['reasons']}")
    print(f"- links among candidates: {report['links_among_candidates']}")
    if report_path:
        print(f"- ids written to {report_path}")
