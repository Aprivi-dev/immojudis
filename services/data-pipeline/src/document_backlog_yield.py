"""Rendement du vidage des pièces jointes : alerte ``pipeline.documents_backlog.low_yield``.

Le 04/11/2026, des vidages d'environ 45 minutes ont fini 8 lectures chacun : leurs passes concluaient
« PDF document manifest is partial » sans lire de pièce (53 passes pour 27 ventes à 11:20) et des points
d'étape étaient refusés. Seule la lecture du journal du workflow l'a montré
(docs/audits/2026-11-04-post-mortem-vidage-pieces.md).

En fin de vidage, ``src.document_backlog`` écrit son bilan (ventes lues, passes partielles, points d'étape
refusés, durée, lecture en avance) dans le résumé d'étape et le journal, puis ce module décide :

* un vidage de plus de ``LOW_YIELD_MIN_DURATION_SECONDS`` (30 min), attente du verrou du catalogue retranchée,
  est évalué ; un vidage plus court (celui de 8 minutes qui suit chaque passage de la file d'enrichissement)
  ne mesure rien et ne touche pas l'alerte, pas plus qu'un vidage arrêté faute d'avoir obtenu le verrou du
  catalogue (``catalogue_lock``) : il n'a pas pu travailler ;
* l'alerte est active si son débit est inférieur à ``LOW_YIELD_MIN_SALES_READ_PER_HOUR`` ventes lues par
  heure (référence saine du 05/11/2026 : 43 ventes en 150 minutes, environ 17 par heure), ou si plus de
  ``LOW_YIELD_MAX_PARTIAL_PASS_SHARE`` de ses passes sont partielles.

L'enregistrement passe par ``app_private.sync_documents_backlog_low_yield_alert`` (migration
20261111131500), qui appelle le mécanisme commun ``app_private.sync_operational_alert``. Ce module ne lève
jamais : une erreur est notée dans le journal et le vidage se termine comme avant. Procédure :
docs/runbooks/vidage-des-pieces.md.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

LOGGER = logging.getLogger(__name__)

ALERT_KEY = "pipeline.documents_backlog.low_yield"

#: Seuils de l'alerte (décision du 08/11/2026, T9, revue de code du 08/11 ; à recalibrer sur les vidages suivants).
LOW_YIELD_MIN_DURATION_SECONDS = 30 * 60
#: Environ le quart du débit sain (43 ventes en 150 minutes, soit 17 par heure) : un vidage qui tourne sans
#: lire, pas un vidage simplement plus lent.
LOW_YIELD_MIN_SALES_READ_PER_HOUR = 4.0
LOW_YIELD_MAX_PARTIAL_PASS_SHARE = 0.30
#: Arrêt sur l'attente du verrou du catalogue (src/document_backlog.py) : le vidage n'a pas pu travailler.
LOCK_WAIT_STOP_REASON = "catalogue_lock"

#: Champs du bilan recopiés dans le détail de l'alerte (aucune adresse de vente, aucune donnée personnelle).
DETAIL_KEYS = (
    "stop_reason",
    "elapsed_seconds",
    "lock_wait_seconds",
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
    """Décide si le bilan d'un vidage ouvre l'alerte.

    ``evaluated`` faux : vidage trop court une fois l'attente du verrou retranchée, ou arrêté sur l'attente du
    verrou ; l'alerte reste inchangée.
    """
    elapsed = float(summary.get("elapsed_seconds") or 0.0)
    lock_wait = min(elapsed, max(0.0, float(summary.get("lock_wait_seconds") or 0.0)))
    working = elapsed - lock_wait
    sales_read = int(summary.get("sales_read") or 0)
    rate = round(sales_read * 3600.0 / working, 1) if working > 0 else 0.0
    share = partial_pass_share(int(summary.get("passes") or 0), int(summary.get("partial_passes") or 0))
    evaluated = working > LOW_YIELD_MIN_DURATION_SECONDS and summary.get("stop_reason") != LOCK_WAIT_STOP_REASON
    reasons: list[str] = []
    if evaluated and rate < LOW_YIELD_MIN_SALES_READ_PER_HOUR:
        reasons.append("low_read_rate")
    if evaluated and share > LOW_YIELD_MAX_PARTIAL_PASS_SHARE:
        reasons.append("partial_passes")
    return {
        "alert_key": ALERT_KEY,
        "evaluated": evaluated,
        "active": bool(reasons),
        "reasons": reasons,
        "evaluated_seconds": round(working, 1),
        "sales_read_per_hour": rate,
        "thresholds": {
            "min_duration_seconds": LOW_YIELD_MIN_DURATION_SECONDS,
            "min_sales_read_per_hour": LOW_YIELD_MIN_SALES_READ_PER_HOUR,
            "max_partial_pass_share": LOW_YIELD_MAX_PARTIAL_PASS_SHARE,
        },
    }


def alert_details(summary: dict[str, Any], evaluation: dict[str, Any]) -> dict[str, Any]:
    details = {key: summary.get(key) for key in DETAIL_KEYS if key in summary}
    details["evaluated_seconds"] = evaluation.get("evaluated_seconds")
    details["sales_read_per_hour"] = evaluation.get("sales_read_per_hour")
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
    """Enregistre la décision ; renvoie ``skipped``, ``opened``, ``clear`` ou ``error``."""
    if not evaluation.get("evaluated") or not db_url:
        return "skipped"
    active = bool(evaluation.get("active"))
    try:
        if connect is None:
            from src.storage.supabase_client import connect as default_connect

            connect = default_connect
        with connect(db_url) as db:
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
