"""Traces de rétention : ne pas laisser une ligne refusée par la base bloquer tout un lot.

Quand la rétention retire une vente, elle laisse dans ``public.auction_sale_retention_tombstones`` une
trace (URL source + dernière date de vente retirée). Le déclencheur
``app_private.prevent_retention_tombstone_reimport`` (migrations ``20261003130000`` et ``20261004191000``)
refuse alors toute ligne ``auction_sales`` de même ``source_url`` dont la date n'est pas strictement
postérieure à celle de la trace, ou qui n'a pas de date, avec l'erreur 23505
« This auction sale date was retired by retention. ». Comme la publication se fait par lot transactionnel,
une seule ligne ainsi refusée faisait échouer tout le lot.

Le test se fait au bon endroit : dans la transaction de ``upsert_sales_to_supabase``, APRÈS la résolution
d'identité (``resolve_publication_identities`` réécrit ``source_url`` et ``sale_date`` quand la vente est
rattachée à une ligne existante), sur les valeurs que le déclencheur verra. ``drop_retired`` reprend
EXACTEMENT son prédicat :

    exists (select 1 from public.auction_sale_retention_tombstones tombstone
            where tombstone.source_url = new.source_url
              and (tombstone.sale_date is null
                   or new.sale_date is null
                   or new.sale_date <= tombstone.sale_date))

Il n'agit que si l'appelant a ouvert ``publish_batch`` (collecteur actif) ; les autres écritures gardent
leur comportement. ``publish_batch`` note ensuite ces ventes ``expired`` / ``retention_tombstone`` et les
retire de la liste du run. Si la base refuse malgré tout une ligne pour ce motif, le groupe fautif (jamais
les groupes déjà validés) est republié ligne par ligne.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import NamedTuple

from src import listing_minimum

LOGGER = logging.getLogger(__name__)

#: Motif enregistré avec la décision ``expired`` (code, jamais une donnée de la vente).
RETENTION_TOMBSTONE_REASON = "retention_tombstone"

#: Message levé par le déclencheur (``errcode`` 23505).
TRIGGER_MESSAGE = "This auction sale date was retired by retention"

QUERY = (
    "select source_url, sale_date from public.auction_sale_retention_tombstones "
    "where source_url = any(%s)"
)

#: Taille des transactions de ``upsert_sales_to_supabase`` : le repli ne touche que le groupe fautif.
CHUNK = 25

#: Liste où ``drop_retired`` dépose les ventes écartées ; ``None`` hors de ``publish_batch``.
_RETIRED: ContextVar[list | None] = ContextVar("retention_tombstones_retired", default=None)


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def blocks(source_url: object, sale_date: datetime | None, tombstones: Mapping[str, datetime | None]) -> bool:
    """Prédicat du déclencheur pour une ligne ``(source_url, sale_date)``."""
    if not source_url or source_url not in tombstones:
        return False
    tombstone_date = tombstones[source_url]
    return tombstone_date is None or sale_date is None or _aware(sale_date) <= _aware(tombstone_date)


def sale_is_blocked(sale: object, tombstones: Mapping[str, datetime | None]) -> bool:
    return blocks(getattr(sale, "source_url", None), getattr(sale, "sale_date", None), tombstones)


def drop_retired(connection, resolved: list, submitted: list) -> list:
    """Retire de ``resolved`` (ventes après résolution d'identité) celles que le déclencheur refuserait.

    Une requête, sur la connexion de la transaction. Les ventes ``submitted`` par l'appelant qui se
    résolvent vers une ligne écartée sont déposées dans le collecteur de ``publish_batch``.
    """
    retired = _RETIRED.get()
    urls = sorted({str(sale.source_url) for sale in resolved if sale.source_url})
    if retired is None or not urls:
        return resolved
    tombstones = {str(row[0]): row[1] for row in connection.execute(QUERY, (urls,)).fetchall()}
    blocked = {sale.source_url for sale in resolved if sale_is_blocked(sale, tombstones)}
    if not blocked:
        return resolved
    retired.extend(sale for sale in submitted if sale.source_url in blocked)
    return [sale for sale in resolved if sale.source_url not in blocked]


def is_tombstone_error(exc: BaseException) -> bool:
    return TRIGGER_MESSAGE in str(exc)


class Published(NamedTuple):
    count: int
    sales: list


def _record(record: Callable[..., None], run_id: str | None, group: list, **fields: str) -> None:
    """Un journal de décision qui échoue ne doit ni perdre la publication ni arrêter le repli."""
    try:
        record(run_id, group, **fields)
    except Exception as exc:
        LOGGER.error("Unable to record decision %s for %s sales: %s", fields.get("decision"), len(group), exc)


def publish_batch(
    sales: list,
    publish: Callable[..., int],
    run_id: str | None,
    record: Callable[..., None],
    errors: dict[str, list[str]],
    forget: list | None = None,
) -> Published:
    """Publie par groupes de ``CHUNK`` ; écarte les ventes à trace de rétention ; ne perd pas le reste.

    ``publish(groupe)`` renvoie le nombre de lignes écrites ; ``record(run_id, groupe, decision=...,
    reason=...)`` écrit la décision. Les ventes écartées par ``drop_retired`` reçoivent ``expired`` /
    ``retention_tombstone`` et sont retirées de ``forget`` (en place). Si la base refuse quand même une ligne
    pour rétention, SEUL le groupe fautif est republié ligne par ligne ; une autre erreur de ce groupe est
    relevée telle quelle (le traitement d'échec existant s'applique), et une autre erreur sur une ligne la
    note ``publication_failed`` sans empêcher les suivantes. Renvoie le nombre d'écritures et les ventes
    effectivement publiées.
    """
    count = 0
    done: list = []

    def attempt(group: list) -> None:
        nonlocal count
        retired: list = []
        token = _RETIRED.set(retired)
        try:
            with listing_minimum.collecting() as refused:
                count += publish(group)
        finally:
            _RETIRED.reset(token)
        gone = {id(sale) for sale in retired} | {id(sale) for sale in refused}
        done.extend(sale for sale in group if id(sale) not in gone)
        retire(retired)
        forget_refused(refused)

    def retire(group: list) -> None:
        if not group:
            return
        _record(record, run_id, group, decision="expired", reason=RETENTION_TOMBSTONE_REASON)
        if forget is not None:
            gone = {id(sale) for sale in group}
            forget[:] = [sale for sale in forget if id(sale) not in gone]

    def forget_refused(group: list) -> None:
        """Annonces refusées par la règle d'entrée : jamais écrites, hors de la liste du run (ni enrichies ni republiées)."""
        if group and forget is not None:
            gone = {id(sale) for sale in group}
            forget[:] = [sale for sale in forget if id(sale) not in gone]

    for offset in range(0, len(sales), CHUNK):
        group = sales[offset:offset + CHUNK]
        try:
            attempt(group)
        except Exception as exc:
            if not is_tombstone_error(exc):
                raise
            LOGGER.warning("Group refused by a retention tombstone; republishing %s sales one by one", len(group))
            for sale in group:
                try:
                    attempt([sale])
                except Exception as single:
                    if is_tombstone_error(single):
                        retire([sale])
                    else:
                        _record(record, run_id, [sale], decision="publication_failed", reason=str(single)[:1000])
                        errors.setdefault("supabase", []).append(str(single)[:1000])
                        LOGGER.error("Publication failed for %s: %s", getattr(sale, "source_url", None), single)
    return Published(count, done)
