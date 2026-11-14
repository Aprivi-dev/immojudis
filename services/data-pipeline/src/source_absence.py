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
* si plus de 15 % des ventes visibles de la source (et plus d'une vente : plancher des petites sources)
  seraient retirées d'un coup, rien n'est fait et une alerte opérationnelle
  (``catalogue.source_absence.<source>``) est levée : un inventaire tronqué ressemble à cela ;
* deux inventaires ne comptent pour deux que s'ils sont distants d'au moins 12 h (voir
  ``src.autonomous_runner.count_absent_inventories``) ; la fonction SQL exige le même écart avant le retrait.

Ce module n'est que l'appel côté pipeline : il ne lève jamais (une panne ici ne doit pas empêcher de clore le run)
et ignore une base où la migration n'est pas encore appliquée.

Ventes sans date non revues (14/11/2026, D13). Une vente datée quitte « à venir » avec sa date ; une vente sans
date d'audience n'a pas d'échéance. Le retrait ci-dessus ne voit que les inventaires complets : 33 ventes à venir sans
date, que leur source n'avait plus montrées depuis août ou septembre, restaient présentées comme à venir
(encheres_publiques, notaires, avoventes, cessions_etat). Après chaque passage d'une source,
:func:`mark_unseen_undated_sales` passe en ``unknown`` ses ventes ``upcoming`` sans date qu'aucune collecte n'a revues
(``last_seen_at``) depuis :data:`UNSEEN_UNDATED_DAYS` jours. Rien n'est retiré ni supprimé : la vente reste visible,
son statut précédent est gardé dans ``raw_payload.unseen_undated``, et la collecte qui la revoit la republie avec le
statut que la source donne.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from typing import Any

LOGGER = logging.getLogger(__name__)

FUNCTION = "app_private.withdraw_missing_source_sales(text,boolean,timestamptz)"
#: Même valeurs que la fonction SQL (migration 20261029150100) ; tests/test_source_absence.py les compare au
#: texte de la migration.
MAX_WITHDRAWN_SHARE = 0.15
MIN_ABSENT_INVENTORIES = 2
#: Plancher absolu : une petite source (moins de 7 ventes visibles) peut toujours perdre une vente.
MIN_WITHDRAWALS = 1
MIN_INVENTORY_SPACING_HOURS = 12

#: 14 jours sans être revue : 28 inventaires manqués à la cadence de 12 h (``autonomous_runner.INVENTORY_CADENCE``),
#: deux fois le seuil d'une vente « non revue » du rapport de santé (7 jours, ``src.pipeline_health``). Une panne de
#: source, signalée en 18 h par ``pipeline.source.<source>.missed``, a deux semaines pour être réparée avant que ses
#: ventes sans date changent de statut ; une vente disparue quitte « à venir » en deux semaines, et non plus jamais.
UNSEEN_UNDATED_DAYS = 14
UNSEEN_UNDATED_SQL = """
update public.auction_sales sale
   set status = 'unknown',
       updated_at = now(),
       raw_payload = (
         case when pg_catalog.jsonb_typeof(sale.raw_payload) = 'object' then sale.raw_payload else '{}'::jsonb end
       ) || pg_catalog.jsonb_build_object(
         'unseen_undated', pg_catalog.jsonb_build_object(
           'status_before', sale.status,
           'marked_at', now(),
           'last_seen_at', sale.last_seen_at,
           'unseen_days', %(days)s::integer
         )
       )
 where sale.source_name = %(source)s
   and sale.status = 'upcoming'
   and sale.sale_date is null
   and sale.last_seen_at < now() - make_interval(days => %(days)s::integer)
returning sale.id
"""


def mark_unseen_undated_sales(
    db_url: str,
    source: str,
    *,
    connect: Callable[[str], Any] | None = None,
) -> dict[str, Any] | None:
    """Passe en ``unknown`` les ventes à venir sans date de ``source`` non revues depuis UNSEEN_UNDATED_DAYS jours.

    Renvoie ``{"marked": n, "sample_sale_ids": [...], "unseen_days": 14}`` ; ``None`` en cas d'erreur, journalisée
    (jamais d'échec ici).
    """
    if not db_url or not source:
        return None
    try:
        if connect is None:
            from src.storage.supabase_client import connect as default_connect

            connect = default_connect
        with connect(db_url) as db:
            rows = db.execute(UNSEEN_UNDATED_SQL, {"source": source, "days": UNSEEN_UNDATED_DAYS}).fetchall()
    except Exception as exc:  # le run est déjà clos : jamais d'échec ici
        LOGGER.warning("Unseen undated sales: %s failed (%s: %s)", source, type(exc).__name__, exc)
        return None
    marked = [str(row[0]) for row in rows or []]
    if marked:
        LOGGER.info(
            "Unseen undated sales: %s upcoming sales of %s without a date and unseen for %s days are now unknown.",
            len(marked),
            source,
            UNSEEN_UNDATED_DAYS,
        )
    return {"marked": len(marked), "sample_sale_ids": marked[:10], "unseen_days": UNSEEN_UNDATED_DAYS}


def max_withdrawals(population: int) -> int:
    """Retraits permis d'un coup pour une source dont ``population`` ventes sont visibles (comme la fonction SQL)."""
    return max(MIN_WITHDRAWALS, math.floor(MAX_WITHDRAWN_SHARE * max(population, 0) + 1e-9))


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
            f"are absent from the last two complete inventories (limit {int(MAX_WITHDRAWN_SHARE * 100)} %, "
            f"at least {MIN_WITHDRAWALS}): nothing withdrawn, operational alert raised."
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
