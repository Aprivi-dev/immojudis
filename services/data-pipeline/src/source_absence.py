"""Ventes disparues de leur source : retrait après deux inventaires complets sans les revoir.

Une vente visible dont la source n'a plus trace passait pour « à venir » indéfiniment (22 ventes au 18/10/2026,
dont deux qui répondent 410 chez Vench). ``record_source_presence`` (``src.autonomous_runner``) note, à chaque
inventaire COMPLET d'une source, si chaque vente y figure, et compte les inventaires complets consécutifs sans la
voir (``app_private.auction_sale_source_presence.absent_inventories``, migration 20261028110100). Juste après un
inventaire complet réussi, ``app_private.withdraw_missing_source_sales`` passe en ``withdrawn`` les ventes visibles
absentes des deux derniers inventaires complets, avec ces garde-fous, tous appliqués par la fonction SQL :

* jamais sur un inventaire partiel : les compteurs ne bougent qu'à un inventaire complet, et la fonction exige
  ``auction_source_state.last_inventory_complete_at`` récent ;
* une vente aussi observée par une autre source n'est retirée que si toutes ses sources l'ont perdue deux fois ;
* si plus de 15 % des ventes visibles de la source seraient retirées d'un coup, rien n'est fait et une alerte
  opérationnelle (``catalogue.source_absence.<source>``) est levée : un inventaire tronqué ressemble à cela.

Ce module n'est que l'appel côté pipeline : il ne lève jamais (une panne ici ne doit pas empêcher de clore le run)
et ignore une base où la migration n'est pas encore appliquée.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

LOGGER = logging.getLogger(__name__)

FUNCTION = "app_private.withdraw_missing_source_sales(text,boolean,timestamptz)"
#: Même valeurs que la fonction SQL ; gardées ici pour les journaux et les tests.
MAX_WITHDRAWN_SHARE = 0.15
MIN_ABSENT_INVENTORIES = 2


def withdraw_missing_sales(
    db_url: str,
    source: str,
    *,
    connect: Callable[[str], Any] | None = None,
) -> dict[str, Any] | None:
    """Retire les ventes disparues de ``source`` ; renvoie le compte rendu de la fonction SQL.

    ``None`` : fonction absente (migration non appliquée), ou erreur journalisée. Appelée seulement après un
    inventaire complet réussi de la source.
    """
    if not db_url or not source:
        return None
    try:
        if connect is None:
            from src.storage.supabase_client import connect as default_connect

            connect = default_connect
        with connect(db_url) as db:
            deployed = db.execute("select to_regprocedure(%s)", (FUNCTION,)).fetchone()
            if not deployed or not deployed[0]:
                LOGGER.info("Source absence: the withdrawal function is not deployed yet; nothing done.")
                return None
            row = db.execute(
                "select app_private.withdraw_missing_source_sales(%s, true)", (source,)
            ).fetchone()
    except Exception as exc:  # le run est déjà clos : jamais d'échec ici
        LOGGER.warning("Source absence: withdrawal for %s failed (%s: %s)", source, type(exc).__name__, exc)
        return None
    result = row[0] if row else None
    if not isinstance(result, dict):
        return None
    report(source, result)
    return result


def report(source: str, result: dict[str, Any]) -> None:
    """Journal lisible du compte rendu (et annotation GitHub quand le retrait est bloqué)."""
    action = result.get("action")
    if action == "blocked":
        message = (
            f"Source {source}: {result.get('candidates')} of {result.get('population')} visible sales "
            f"are absent from the last two complete inventories (limit {int(MAX_WITHDRAWN_SHARE * 100)} %): "
            "nothing withdrawn, operational alert raised."
        )
        LOGGER.warning("Source absence: %s", message)
        print(f"::warning title=Ventes disparues bloquées::{message}")
    elif action == "withdrawn":
        LOGGER.info(
            "Source absence: %s sales of %s withdrawn (absent from the last %s complete inventories).",
            result.get("withdrawn"),
            source,
            MIN_ABSENT_INVENTORIES,
        )
    else:
        LOGGER.info("Source absence: %s -> %s", source, action)
