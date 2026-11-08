"""Rendement du vidage des pièces jointes : alerte ``pipeline.documents_backlog.low_yield``.

Le 04/11/2026, des vidages d'environ 45 minutes ont fini 8 lectures chacun : leurs passes concluaient
« PDF document manifest is partial » sans lire de pièce (53 passes pour 27 ventes à 11:20) et des points
d'étape étaient refusés. Seule la lecture du journal du workflow l'a montré
(docs/audits/2026-11-04-post-mortem-vidage-pieces.md).

En fin de vidage, ``src.document_backlog`` écrit son bilan (ventes lues, passes partielles, points d'étape
refusés, durée, lecture en avance) dans le résumé d'étape et le journal, puis ce module décide :

* un vidage de plus de ``LOW_YIELD_MIN_DURATION_SECONDS`` (60 min) est évalué ; un vidage plus court (celui de
  8 minutes qui suit chaque passage de la file d'enrichissement) ne mesure rien et ne touche pas l'alerte ;
* l'alerte est active s'il a lu moins de ``LOW_YIELD_MIN_SALES_READ`` ventes, ou si plus de
  ``LOW_YIELD_MAX_PARTIAL_PASS_SHARE`` de ses passes sont partielles.

L'enregistrement passe par ``app_private.sync_documents_backlog_low_yield_alert`` (migration
20261111131500), qui appelle le mécanisme commun ``app_private.sync_operational_alert``. Ce module ne lève
jamais : une base sans la fonction, ou une erreur, est notée dans le journal et le vidage se termine comme
avant. Procédure : docs/runbooks/vidage-des-pieces.md.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

LOGGER = logging.getLogger(__name__)

ALERT_KEY = "pipeline.documents_backlog.low_yield"
FUNCTION = "app_private.sync_documents_backlog_low_yield_alert(boolean,jsonb,timestamptz)"

#: Seuils de l'alerte (décision du 08/11/2026, T9 ; supposés, à recalibrer sur les vidages suivants).
LOW_YIELD_MIN_DURATION_SECONDS = 60 * 60
LOW_YIELD_MIN_SALES_READ = 5
LOW_YIELD_MAX_PARTIAL_PASS_SHARE = 0.30

#: Champs du bilan recopiés dans le détail de l'alerte (aucune adresse de vente, aucune donnée personnelle).
DETAIL_KEYS = (
    "stop_reason",
    "elapsed_seconds",
    "sales_seen",
    "sales_processed",
    "sales_read",
    "passes",
    "partial_passes",
    "partial_pass_share",
    "refused_checkpoints",
    "prefetch",
)


def partial_pass_share(passes: int, partial_passes: int) -> float:
    """Part des passes partielles ; 0 sans passe."""
    return round(partial_passes / passes, 3) if passes > 0 else 0.0


def evaluate_low_yield(summary: dict[str, Any]) -> dict[str, Any]:
    """Décide si le bilan d'un vidage ouvre l'alerte. ``evaluated`` faux : vidage trop court, alerte inchangée."""
    elapsed = float(summary.get("elapsed_seconds") or 0.0)
    sales_read = int(summary.get("sales_read") or 0)
    share = partial_pass_share(int(summary.get("passes") or 0), int(summary.get("partial_passes") or 0))
    evaluated = elapsed > LOW_YIELD_MIN_DURATION_SECONDS
    reasons: list[str] = []
    if evaluated and sales_read < LOW_YIELD_MIN_SALES_READ:
        reasons.append("few_sales_read")
    if evaluated and share > LOW_YIELD_MAX_PARTIAL_PASS_SHARE:
        reasons.append("partial_passes")
    return {
        "alert_key": ALERT_KEY,
        "evaluated": evaluated,
        "active": bool(reasons),
        "reasons": reasons,
        "thresholds": {
            "min_duration_seconds": LOW_YIELD_MIN_DURATION_SECONDS,
            "min_sales_read": LOW_YIELD_MIN_SALES_READ,
            "max_partial_pass_share": LOW_YIELD_MAX_PARTIAL_PASS_SHARE,
        },
    }


def alert_details(summary: dict[str, Any], evaluation: dict[str, Any]) -> dict[str, Any]:
    details = {key: summary.get(key) for key in DETAIL_KEYS if key in summary}
    details["reasons"] = list(evaluation.get("reasons") or [])
    details["thresholds"] = dict(evaluation.get("thresholds") or {})
    return details


def sync_low_yield_alert(
    db_url: str,
    summary: dict[str, Any],
    evaluation: dict[str, Any],
    *,
    connect: Callable[[str], Any] | None = None,
) -> str:
    """Enregistre la décision ; renvoie ``skipped``, ``not_deployed``, ``opened``, ``clear`` ou ``error``."""
    if not evaluation.get("evaluated") or not db_url:
        return "skipped"
    active = bool(evaluation.get("active"))
    try:
        if connect is None:
            from src.storage.supabase_client import connect as default_connect

            connect = default_connect
        with connect(db_url) as db:
            deployed = db.execute("select to_regprocedure(%s)", (FUNCTION,)).fetchone()
            if not deployed or not deployed[0]:
                LOGGER.warning(
                    "Document backlog yield: %s is not deployed yet (migration 20261111131500); alert %s not synced.",
                    FUNCTION,
                    ALERT_KEY,
                )
                return "not_deployed"
            db.execute(
                "select app_private.sync_documents_backlog_low_yield_alert(%s, %s::jsonb)",
                (active, json.dumps(alert_details(summary, evaluation), ensure_ascii=False, default=str)),
            )
    except Exception as exc:  # noqa: BLE001 - le vidage est fini : jamais d'échec ici
        LOGGER.warning("Document backlog yield: alert sync failed (%s: %s)", type(exc).__name__, exc)
        return "error"
    if active:
        LOGGER.warning("Document backlog yield: %s active (%s)", ALERT_KEY, ", ".join(evaluation["reasons"]))
        return "opened"
    return "clear"
