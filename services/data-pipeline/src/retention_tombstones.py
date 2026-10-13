"""Traces de rétention : écarter avant l'écriture ce que la base refuserait de toute façon.

Quand la rétention retire une vente, elle laisse dans ``public.auction_sale_retention_tombstones`` une
trace (URL source + dernière date de vente retirée). Le déclencheur
``app_private.prevent_retention_tombstone_reimport`` (migrations ``20261003130000`` et ``20261004191000``)
refuse alors toute ligne ``auction_sales`` de même ``source_url`` dont la date n'est pas strictement
postérieure à celle de la trace, ou qui n'a pas de date, avec l'erreur 23505
« This auction sale date was retired by retention. ». Comme la publication se fait par lot transactionnel,
une seule ligne ainsi refusée faisait échouer tout le lot.

Ce module reprend EXACTEMENT le prédicat du déclencheur :

    exists (select 1 from public.auction_sale_retention_tombstones tombstone
            where tombstone.source_url = new.source_url
              and (tombstone.sale_date is null
                   or new.sale_date is null
                   or new.sale_date <= tombstone.sale_date))

Lecture : une seule requête par lot, par la connexion directe du pipeline (``SUPABASE_DB_URL``, rôle
propriétaire des tables ; ``service_role`` a aussi ``select`` sur la table). Si la lecture échoue, aucune
vente n'est écartée (comportement d'avant) et le repli ligne par ligne de ``publish_isolating_tombstones``
prend le relais.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from typing import NamedTuple

LOGGER = logging.getLogger(__name__)

#: Motif enregistré avec la décision ``expired`` (code, jamais une donnée de la vente).
RETENTION_TOMBSTONE_REASON = "retention_tombstone"

#: Message levé par le déclencheur (``errcode`` 23505).
TRIGGER_MESSAGE = "This auction sale date was retired by retention"

QUERY = (
    "select source_url, sale_date from public.auction_sale_retention_tombstones "
    "where source_url = any(%s)"
)


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


def load_retention_tombstones(
    sales: Iterable[object],
    *,
    db_url: str | None = None,
    connect: Callable[..., object] | None = None,
) -> dict[str, datetime | None]:
    """Traces des URL des ventes données (une requête) ; ``{}`` au moindre doute."""
    urls = sorted({str(url) for sale in sales if (url := getattr(sale, "source_url", None))})
    if not urls:
        return {}
    try:
        if db_url is None:
            from src.config import load_settings

            db_url = load_settings().get("supabase_db_url")
        if not db_url:
            return {}
        if connect is None:
            from src.storage.supabase_client import connect as default_connect

            connect = default_connect
        with connect(str(db_url)) as db:  # type: ignore[misc]
            rows = db.execute(QUERY, (urls,)).fetchall()  # type: ignore[attr-defined]
        return {str(row[0]): row[1] for row in rows}
    except Exception as exc:  # table illisible, base injoignable : le repli ligne par ligne couvre
        LOGGER.warning("Retention tombstones unreadable (%s); nothing set aside beforehand", type(exc).__name__)
        return {}


def is_tombstone_error(exc: BaseException) -> bool:
    return TRIGGER_MESSAGE in str(exc)


class Published(NamedTuple):
    count: int
    sales: list


def publish_batch(
    sales: list,
    publish: Callable[[list], int],
    run_id: str | None,
    record: Callable[..., None],
    errors: dict[str, list[str]],
    forget: list | None = None,
) -> Published:
    """Publie le lot ; si la base refuse une ligne pour rétention, republie ligne par ligne.

    ``publish(lot)`` renvoie le nombre de lignes écrites ; ``record(run_id, lot, decision=..., reason=...)``
    écrit la décision. Toute autre erreur du lot est relevée telle quelle (le traitement d'échec existant
    s'applique). En repli, une ligne refusée par la rétention reçoit la décision ``expired`` /
    ``retention_tombstone`` et est retirée de ``forget`` (en place) pour ne pas être réessayée en fin de run ;
    une autre erreur sur une ligne la note ``publication_failed`` sans empêcher les suivantes. Renvoie le
    nombre d'écritures et les ventes effectivement publiées.
    """
    try:
        return Published(publish(sales), list(sales))
    except Exception as exc:
        if not is_tombstone_error(exc):
            raise
    LOGGER.warning("Batch refused by a retention tombstone; republishing %s sales one by one", len(sales))
    count, done, dropped = 0, [], []
    for sale in sales:
        try:
            count += publish([sale])
            done.append(sale)
        except Exception as exc:
            if is_tombstone_error(exc):
                record(run_id, [sale], decision="expired", reason=RETENTION_TOMBSTONE_REASON)
                dropped.append(id(sale))
            else:
                record(run_id, [sale], decision="publication_failed", reason=str(exc)[:1000])
                errors.setdefault("supabase", []).append(str(exc)[:1000])
                LOGGER.error("Publication failed for %s: %s", getattr(sale, "source_url", None), exc)
    if forget is not None and dropped:
        forget[:] = [sale for sale in forget if id(sale) not in dropped]
    return Published(count, done)
