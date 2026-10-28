"""Cache des annonces refusées par la règle de minimum : on ne relit pas leur fiche de détail pendant 7 jours.

Une annonce refusée (``listing_minimum``) n'est pas en base. Sans mémoire, le collecteur relirait sa fiche à chaque
passage : 400 à 600 requêtes à 1,5 s pour Vench et Petites Affiches, sur des passages que le chien de garde coupe
déjà. La table ``app_private.rejected_listings`` (migration ``20261108202200``) garde l'URL, la date du refus et
l'empreinte de la vignette (date, prix, statut).

* **Lecture** (``skip_detail``, appelée par ``sources.common.should_fetch_detail``) : une annonce absente de la base,
  refusée depuis moins de 7 jours et dont la vignette n'a pas changé n'est pas relue. Elle reste dans le résultat
  du collecteur (inventaire, couverture et santé de la source inchangés) ; elle est marquée ``_known_unchanged``
  (comme une fiche connue et inchangée : ni point de contrôle, ni preuve de fraîcheur) et ``_recently_rejected``.
  Comptée ``skipped_recently_rejected`` dans le résumé du passage, elle reçoit la décision ``excluded`` comme une
  annonce refusée après lecture.
* **Écriture** (``remember``, appelée dans la transaction de publication par ``publication_identity``) : seule une
  annonce refusée APRÈS lecture de sa fiche est mémorisée ou rafraîchie. Une annonce sautée ne renouvelle pas son
  délai : après 7 jours la fiche est relue, elle a pu s'enrichir (email publié, pièce).
* **Conservation** : 30 jours (``app_private.purge_rejected_listings``, appelée au chargement du cache).

Le cache est un confort, jamais une condition : table absente, base injoignable, interrupteur coupé
(``IMMOJUDIS_REJECTED_LISTING_CACHE=off``) ou hors passage autonome, les fiches sont relues comme avant. Il n'est actif
que pour un passage autonome (``PIPELINE_AUTONOMOUS_RUN_ID``) ou avec ``IMMOJUDIS_REJECTED_LISTING_CACHE=on``.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any
from urllib.parse import urldefrag

from src.config import load_settings

LOGGER = logging.getLogger(__name__)

ENV = "IMMOJUDIS_REJECTED_LISTING_CACHE"
#: Une annonce refusée depuis moins longtemps n'est pas relue.
RECHECK_AFTER = timedelta(days=7)
CONNECT_TIMEOUT = 5

_TABLE_UNAVAILABLE = False


def normalize_url(url: object) -> str:
    """URL publique sans fragment ni espace : la clé du cache."""
    return urldefrag(str(url or "").strip())[0]


def _db_url() -> str:
    return str(load_settings().get("supabase_db_url") or "")


def _active() -> bool:
    """Interrupteur et contexte : actif pour un passage autonome, ou avec ``IMMOJUDIS_REJECTED_LISTING_CACHE=on``."""
    mode = (os.getenv(ENV) or "").strip().lower()
    if mode in {"off", "0", "false", "no"} or _TABLE_UNAVAILABLE:
        return False
    return mode in {"on", "1", "true", "yes"} or bool(os.getenv("PIPELINE_AUTONOMOUS_RUN_ID"))


def enabled() -> bool:
    return _active() and bool(_db_url())


@lru_cache(maxsize=1)
def _load() -> dict[str, tuple[datetime, str | None]]:
    """Refus de moins de 7 jours : ``{url: (date du refus, empreinte)}`` ; vide au moindre problème."""
    global _TABLE_UNAVAILABLE
    from src.storage.supabase_client import connect

    try:
        with connect(_db_url(), connect_timeout=CONNECT_TIMEOUT, retry_delays=()) as db:
            with db.transaction():
                db.execute("set local lock_timeout = '5s'")
                db.execute("set local statement_timeout = '15s'")
                if not db.execute("select to_regclass('app_private.rejected_listings')").fetchone()[0]:
                    _TABLE_UNAVAILABLE = True
                    return {}
                db.execute("select app_private.purge_rejected_listings()")
                rows = db.execute(
                    "select source_url, rejected_at, fingerprint from app_private.rejected_listings "
                    "where rejected_at > now() - %s",
                    (RECHECK_AFTER,),
                ).fetchall()
    except Exception as exc:  # noqa: BLE001 - un cache indisponible ne doit jamais arrêter la collecte
        LOGGER.warning("Rejected listings cache unavailable; detail pages are read as usual (%s)", type(exc).__name__)
        return {}
    return {normalize_url(url): (rejected_at, fingerprint) for url, rejected_at, fingerprint in rows}


def reset_cache() -> None:
    """Oublie le cache chargé (tests, début d'un passage)."""
    global _TABLE_UNAVAILABLE
    _TABLE_UNAVAILABLE = False
    _load.cache_clear()


def skip_detail(sale: dict[str, Any], *, now: datetime | None = None) -> bool:
    """Vrai si la fiche de cette annonce, absente de la base, ne doit pas être relue.

    Pose ``_list_signature`` (empreinte de la vignette) quand le cache est actif, pour que l'écriture la mémorise.
    """
    if not enabled():
        return False
    from src.sources.common import listing_signature

    signature = listing_signature(sale)
    sale["_list_signature"] = signature
    entry = _load().get(normalize_url(sale.get("source_url")))
    if entry is None:
        return False
    rejected_at, fingerprint = entry
    if rejected_at.tzinfo is None:
        rejected_at = rejected_at.replace(tzinfo=UTC)
    if (now or datetime.now(UTC)) - rejected_at >= RECHECK_AFTER:
        return False
    if fingerprint and signature and fingerprint != signature:
        return False  # la date, le prix ou le statut a changé : la fiche est relue
    sale["_known_unchanged"] = True
    sale["_recently_rejected"] = True
    return True


def is_skipped(payload: object) -> bool:
    return isinstance(payload, dict) and bool(payload.get("_recently_rejected"))


def remember(connection: Any, sales: list[Any]) -> int:
    """Mémorise des annonces refusées après lecture de leur fiche (dans la transaction de publication).

    Une annonce sautée ne renouvelle pas son délai. Table absente : le cache est coupé pour le reste du passage.
    """
    global _TABLE_UNAVAILABLE
    rows = [
        (
            normalize_url(sale.source_url),
            str(sale.primary_source or sale.source_name or "unknown"),
            (sale.raw_payload or {}).get("_list_signature"),
        )
        for sale in sales
        if sale.source_url and not is_skipped(sale.raw_payload)
    ]
    if not rows or not _active():
        return 0
    try:
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.executemany(
                    """insert into app_private.rejected_listings(source_url, source_name, fingerprint)
                       values (%s, %s, %s)
                       on conflict (source_url) do update set
                         source_name = excluded.source_name, fingerprint = excluded.fingerprint, rejected_at = now()""",
                    rows,
                )
    except Exception as exc:  # noqa: BLE001 - le cache ne doit jamais faire échouer la publication
        _TABLE_UNAVAILABLE = getattr(exc, "sqlstate", None) == "42P01" or _TABLE_UNAVAILABLE
        LOGGER.warning("Rejected listings not remembered (%s)", type(exc).__name__)
        return 0
    return len(rows)
