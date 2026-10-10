"""Rapport et suppression CONTRÔLÉE des ventes aux informations insuffisantes déjà en base.

Utilisé par ``python -m src.recompute_scoring --drop-insufficient``. Rien ne s'exécute seul :

* par défaut c'est un RAPPORT (dry-run) : liste d'identifiants par source, motifs, et liens utilisateurs ;
* ``--execute-drop`` supprime réellement, par lots, dans l'ordre des dépendances utilisé par la rétention
  (``purge_expired_auction_sales``) : pont Outcome Graph (exigé par un trigger avant tout DELETE), file de nettoyage
  du stockage, tables sans cascade, observations, puis la vente. AUCUN tombstone n'est écrit : un tombstone dont
  ``sale_date`` est nul interdit définitivement la réimportation de l'URL, alors qu'une vente aujourd'hui
  insuffisante peut le devenir moins demain (extracteur corrigé, e-mail publié) ;
* les ventes liées à des données d'utilisateur (favoris, rapports, espaces de travail, dossiers de l'agent,
  demandes d'avocat) sont PROTÉGÉES et jamais supprimées sans ``--include-user-linked``.

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
CATALOGUE_LOCK_KEY = "immojudis:outcome_catalogue_bridge:v1"
DELETE_BATCH_SIZE = 25
DEFAULT_MAX_DELETIONS = 100

#: (table, colonne vers auction_sales.id) dont une ligne PROTÈGE la vente de la suppression.
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
        stored_status = str(row.get("status") or "").lower()
        if stored_status:
            sale.status = stored_status  # le statut stocké fait foi pour les exemptions
        verdict = sufficient_information(sale, blocklist=blocklist)
        if verdict.exemption:
            stats["exempt"] += 1
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
    *,
    include_user_linked: bool,
) -> dict[str, Any]:
    """Rapport sans donnée personnelle : identifiants techniques, codes et compteurs."""
    protected = set().union(*links.get("protecting", {}).values()) if links.get("protecting") else set()
    to_delete = [c for c in candidates if include_user_linked or c.sale_id not in protected]
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


def _same_instant(left: str | None, right: Any) -> bool:
    if left is None or right is None:
        return False
    try:
        return datetime.fromisoformat(str(left).replace("Z", "+00:00")) == (
            right if isinstance(right, datetime) else datetime.fromisoformat(str(right).replace("Z", "+00:00"))
        )
    except ValueError:
        return False


_STORAGE_QUEUE_SQL = """
insert into public.sale_retention_storage_queue(bucket, object_path)
  select storage_bucket, storage_path
    from public.information_agent_evidence_assets
   where sale_id = %(id)s and storage_bucket = 'information-agent-evidence'
  union
  select 'information-agent-approved', metadata->>'approved_public_path'
    from public.information_agent_evidence_assets
   where sale_id = %(id)s and nullif(metadata->>'approved_public_path', '') is not null
  union
  select 'information-agent-approved', file_path
    from public.auction_documents
   where source_url = %(url)s and file_path like %(prefix)s
     and document_url like '%%/storage/v1/object/public/information-agent-approved/%%'
on conflict (bucket, object_path) do nothing
"""


def delete_batch(connection: Any, batch: Sequence[Candidate]) -> tuple[int, int]:
    """Supprime un lot dans UNE transaction ; renvoie (supprimées, ignorées car modifiées entre-temps).

    Ordre identique à ``purge_expired_auction_sales`` mais SANS tombstone. Le verrou consultatif est celui de la
    rétention et des publications : aucune publication ne s'exécute pendant la suppression.
    """
    connection.execute("select pg_advisory_xact_lock(hashtextextended(%s, 0))", (CATALOGUE_LOCK_KEY,))
    current = {
        str(row[0]): row
        for row in connection.execute(
            "select id::text, source_url, updated_at from public.auction_sales where id = any(%s::uuid[]) for update",
            ([c.sale_id for c in batch],),
        ).fetchall()
    }
    deleted = skipped = 0
    for candidate in batch:
        row = current.get(candidate.sale_id)
        if row is None or not _same_instant(candidate.updated_at, row[2]):
            skipped += 1  # supprimée ou mise à jour depuis l'évaluation : on ne touche à rien
            continue
        sale_id, source_url = candidate.sale_id, str(row[1])
        previous = connection.execute(
            "select id from public.auction_sales where id < %s::uuid order by id desc limit 1", (sale_id,)
        ).fetchone()
        bridge = connection.execute(
            "select complete, next_cursor from public.bridge_auction_sales_to_outcome_graph_batch(%s, 1)",
            (previous[0] if previous else None,),
        ).fetchone()
        if not bridge or not bridge[0] or str(bridge[1]) != sale_id:
            raise RuntimeError("Incomplete Outcome Graph bridge before deletion; nothing was deleted for this batch")
        connection.execute(_STORAGE_QUEUE_SQL, {"id": sale_id, "url": source_url, "prefix": f"{sale_id}/%"})
        connection.execute("delete from public.valuation_estimates where auction_sale_id = %s::uuid", (sale_id,))
        connection.execute("delete from public.information_agent_missions where sale_id = %s::uuid", (sale_id,))
        connection.execute("delete from public.lawyer_placement_events where sale_id = %s::uuid", (sale_id,))
        connection.execute("delete from public.lawyer_referral_requests where sale_id = %s::uuid", (sale_id,))
        connection.execute(
            "delete from public.auction_observations where canonical_source_url = %s or source_url = %s",
            (source_url, source_url),
        )
        connection.execute("delete from public.auction_sales where id = %s::uuid", (sale_id,))
        deleted += 1
    return deleted, skipped


def drop_insufficient_sales(
    *,
    source: str | None,
    limit: int | None,
    execute: bool,
    max_deletions: int,
    include_user_linked: bool,
    report_path: str | None,
) -> int:
    """Rapport (par défaut) ou suppression (``execute``) ; renvoie un code de sortie."""
    from src.config import load_settings
    from src.information_sufficiency import load_contact_blocklist
    from src.recompute_scoring import _fetch_sales, _load_env_fallbacks, _sale_from_storage_row
    from src.storage.supabase_client import _postgres_connect

    _load_env_fallbacks()
    settings = load_settings()
    rows = _fetch_sales(source=source, limit=limit)
    if not rows:
        LOGGER.error("No stored sales matched the requested scope")
        return 1
    blocklist = load_contact_blocklist(settings)
    candidates, stats = evaluate_rows(rows, _sale_from_storage_row, blocklist)
    links = fetch_links(settings, [c.sale_id for c in candidates]) if candidates else {}
    report = build_report(candidates, stats, links, include_user_linked=include_user_linked)
    report["mode"] = "execute" if execute else "dry-run"
    if report_path:
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False, sort_keys=True)
    _print_report(report, report_path)
    if not execute:
        print("- dry-run: nothing was deleted. Re-run with --execute-drop after reading the report.")
        return 0
    if stats["unreadable"]:
        LOGGER.error("%s rows could not be evaluated; refusing to delete anything", stats["unreadable"])
        return 1
    if report["deletable_total"] > max_deletions:
        LOGGER.error(
            "%s sales would be deleted, above --max-deletions=%s; refusing to delete anything",
            report["deletable_total"], max_deletions,
        )
        return 1
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        LOGGER.error("SUPABASE_DB_URL is required for the transactional deletion")
        return 1
    protected = set(report["protected_user_linked"])
    todo = [c for c in candidates if include_user_linked or c.sale_id not in protected]
    deleted = skipped = 0
    for start in range(0, len(todo), DELETE_BATCH_SIZE):
        with _postgres_connect(db_url) as connection:
            batch_deleted, batch_skipped = delete_batch(connection, todo[start : start + DELETE_BATCH_SIZE])
        deleted += batch_deleted
        skipped += batch_skipped
        LOGGER.info("Insufficient-information deletion: %s deleted, %s skipped so far", deleted, skipped)
    print(f"- deleted: {deleted}; skipped (changed since evaluation): {skipped}")
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
