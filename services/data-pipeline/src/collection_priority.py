"""Priorité des collectes sur la voie d'enrichissement (décision du 17/11/2026, étape 1).

La file d'enrichissement a sa propre voie de planification (``claim_autonomous_pipeline_run``, migration
20261203100000) et son propre groupe de concurrence GitHub : elle tourne pendant qu'une collecte est demandée ou en
cours. Elle ne travaille pourtant jamais en même temps qu'elle :

* le travailleur (``src.queued_runner``) ne prend plus de lot dès qu'une collecte est en attente ou en cours, et rend
  le verrou des écritures du catalogue en se terminant ;
* l'unité d'enrichissement (``src.autonomous_runner``) attend la fin de la collecte avant le passage suivant, et
  saute ses passes facultatives tant qu'une collecte est demandée ;
* la collecte attend, avant de démarrer (et avant que son budget ne coure), que le verrou du catalogue soit libre :
  le lot en cours du travailleur se termine.

Une seule source de vérité pour « une collecte est demandée » : ``COLLECTION_PENDING_SQL``. Une collecte planifiée
compte dès que son lancement est en vol ou accepté par GitHub ; une exécution manuelle (sans lancement planifié) dès
qu'elle est en file. Un lancement refusé ou en attente d'une nouvelle tentative ne retient pas l'enrichissement :
quand il repart, il redevient « en vol ».
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from src.config import load_settings

LOGGER = logging.getLogger(__name__)

ENRICHMENT_SOURCE = "enrichment-queue"
#: Attente entre deux lectures, pour une unité d'enrichissement qui attend la fin d'une collecte.
COLLECTION_POLL_SECONDS = 30.0

COLLECTION_PENDING_SQL = """
select exists (
  select 1
    from public.auction_runs r
   where r.source is distinct from %s
     and (
       r.status = 'running'
       or (
         r.status = 'queued'
         and coalesce(r.summary #>> '{github_dispatch,state}', 'manual') in ('manual', 'in_flight', 'accepted')
       )
     )
)
"""


def collection_pending(db_url: str, *, connect: Callable[..., Any] | None = None) -> bool:
    """True quand une collecte (planifiée ou manuelle) est demandée ou en cours.

    Une lecture impossible rend False : le travailleur continue, et la collecte, elle, attend toujours le verrou du
    catalogue avant de démarrer ; rien n'est écrit hors verrou.
    """
    if not db_url:
        return False
    if connect is None:
        from src.storage.supabase_client import connect as default_connect

        connect = default_connect
    try:
        with connect(db_url, connect_timeout=3, retry_delays=()) as connection:
            connection.execute("set transaction read only")
            connection.execute("set local statement_timeout = '3000ms'")
            row = connection.execute(COLLECTION_PENDING_SQL, (ENRICHMENT_SOURCE,)).fetchone()
    except Exception as exc:  # noqa: BLE001 - lecture facultative : jamais d'arrêt du travailleur ici
        LOGGER.warning("Could not read pending collections (%s): %s", type(exc).__name__, exc)
        return False
    return bool(row and row[0])


def collection_pending_now() -> bool:
    """``collection_pending`` sur la base configurée (False sans base)."""
    return collection_pending(str(load_settings().get("supabase_db_url") or ""))


def wait_while_collection_pending(
    *,
    deadline: float,
    pending: Callable[[], bool] | None = None,
    poll_seconds: float = COLLECTION_POLL_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> float:
    """Attend qu'aucune collecte ne soit demandée, au plus jusqu'à ``deadline`` ; rend les secondes attendues.

    ``pending`` vaut par défaut ``collection_pending_now``, lu à l'appel.
    """
    is_pending = pending if pending is not None else collection_pending_now
    started = clock()
    while clock() < deadline and is_pending():
        sleep(max(0.0, min(poll_seconds, deadline - clock())))
    return clock() - started
