"""Retrait d'une source du catalogue : l'interrupteur vu du pipeline.

Infrastructure gardée pour un usage futur : **aucune source n'est retirée à ce jour** (Licitor est collecté
et affiché normalement). L'interrupteur unique est la colonne ``public.auction_source_state.catalogue_withdrawn``,
posée et levée par ``select public.set_catalogue_source_withdrawal('<source>', true|false)`` (migration
``20261021110000_licitor_source_withdrawal.sql``). Le planificateur SQL ne lance déjà pas une source
``enabled = false``, et une source retirée l'est toujours ; ce module couvre les autres chemins :
lancement manuel (``python -m src.main --source <source>``), collecte de l'historique des adjudications,
téléchargement des pièces hébergées par la source.

**Par défaut, aucune source n'est retirée.** Si la base ne répond pas, si la colonne n'existe pas encore
(migration non appliquée) ou si aucune URL de base n'est configurée, ``DEFAULT_WITHDRAWN`` (vide) s'applique :
une panne ou une migration en retard ne coupe jamais une collecte. Retirer une source est donc un geste
explicite en base ; en contrepartie, tant que l'interrupteur est illisible, un retrait posé n'est pas vu.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

LOGGER = logging.getLogger(__name__)

#: Sources retirées quand la base ne dit rien : aucune (Licitor reste collecté et affiché).
DEFAULT_WITHDRAWN: frozenset[str] = frozenset()

#: Hôtes propres à une source retirée (images, pièces, fiches), pour reconnaître son contenu dans une
#: vente fusionnée.
SOURCE_HOSTS: dict[str, tuple[str, ...]] = {"licitor": ("licitor.com",)}

CACHE_SECONDS = 60.0
QUERY = "select lower(source_name) from public.auction_source_state where catalogue_withdrawn"

_cache: tuple[str, float, frozenset[str]] | None = None


class SourceWithdrawn(RuntimeError):
    """La source est retirée du catalogue : aucune requête ne doit partir vers elle."""


class SaleSourceWithdrawn(SourceWithdrawn):
    """Toutes les sources de la vente sont retirées : elle est masquée, on ne l'enrichit pas."""


#: Les tâches d'enrichissement d'une vente masquée attendent un jour (sans consommer d'essai).
SALE_DEFERRAL = timedelta(hours=24)


def read_withdrawn_sources(
    db_url: str | None,
    *,
    connect: Callable[..., object] | None = None,
) -> frozenset[str]:
    """Lit l'interrupteur en base ; ``DEFAULT_WITHDRAWN`` (aucune source retirée) au moindre doute."""
    if not db_url:
        return DEFAULT_WITHDRAWN
    try:
        if connect is None:
            from src.storage.supabase_client import connect as default_connect

            connect = default_connect
        with connect(db_url) as db:  # type: ignore[misc]
            rows = db.execute(QUERY).fetchall()  # type: ignore[attr-defined]
        return frozenset(str(row[0]).lower() for row in rows)
    except Exception as exc:  # colonne absente, base injoignable, droits : aucune source retirée
        LOGGER.warning("Withdrawal switch unreadable (%s); no source treated as withdrawn", type(exc).__name__)
        return DEFAULT_WITHDRAWN


def withdrawn_sources(db_url: str | None = None) -> frozenset[str]:
    """Sources retirées, lues en base au plus une fois par minute et par processus."""
    global _cache
    key = db_url or ""
    now = time.monotonic()
    if _cache is not None and _cache[0] == key and now - _cache[1] < CACHE_SECONDS:
        return _cache[2]
    value = read_withdrawn_sources(db_url)
    _cache = (key, now, value)
    return value


def reset_cache() -> None:
    global _cache
    _cache = None


def is_source_withdrawn(source: str, db_url: str | None = None) -> bool:
    return str(source).lower() in withdrawn_sources(db_url)


def require_source_active(source: str, db_url: str | None = None) -> None:
    """Refuse d'aller plus loin pour une source retirée (levée avant toute requête réseau)."""
    if is_source_withdrawn(source, db_url):
        raise SourceWithdrawn(f"Source {source} retirée du catalogue : collecte interdite tant que le retrait n'est pas levé")


def source_of_url(url: object) -> str | None:
    """Nom de la source dont ``url`` est un hôte propre (image, pièce, fiche), sinon ``None``."""
    if not isinstance(url, str) or not url.strip():
        return None
    try:
        host = (urlsplit(url.strip()).hostname or "").rstrip(".").lower()
    except ValueError:
        return None
    for source, hosts in SOURCE_HOSTS.items():
        if any(host == suffix or host.endswith(f".{suffix}") for suffix in hosts):
            return source
    return None


def is_withdrawn_source_url(url: object, db_url: str | None = None) -> bool:
    """``True`` pour une URL hébergée par une source retirée (à ne pas télécharger)."""
    source = source_of_url(url)
    return source is not None and is_source_withdrawn(source, db_url)


def sale_source_names(source_name: object, observations: object) -> set[str]:
    """Sources d'une vente : la principale et celles de ses observations (même règle que la base)."""
    primary = str(source_name or "").strip().lower()
    names = {primary} if primary else set()
    if isinstance(observations, (list, tuple)):
        for observation in observations:
            name = observation.get("source_name") if isinstance(observation, dict) else None
            names.add(str(name).strip().lower() if name and str(name).strip() else primary)
    return {name for name in names if name}


def sale_is_fully_withdrawn(sale: object, db_url: str | None = None) -> bool:
    """``True`` quand toutes les sources de la vente sont retirées (la vente est masquée du catalogue).

    Miroir de ``app_private.sale_is_fully_withdrawn`` : une vente fusionnée avec une source non
    retirée reste dans le catalogue.
    """
    names = sale_source_names(getattr(sale, "source_name", None), getattr(sale, "observations", None))
    withdrawn = withdrawn_sources(db_url)
    return bool(names) and bool(withdrawn) and names <= withdrawn


def require_sale_not_withdrawn(sale: object, db_url: str | None = None) -> None:
    """Levée avant tout enrichissement (pièces, fiche, LLM) d'une vente dont toutes les sources sont retirées."""
    if sale_is_fully_withdrawn(sale, db_url):
        raise SaleSourceWithdrawn("Source withdrawn from the catalogue; enrichment waits for the withdrawal to be lifted")


def deferral_for(error: Exception):
    """Report de la file d'enrichissement pour un refus d'accès (source retirée ou accès non autorisé)."""
    from src.pipeline_usage import QueueJobDeferred

    if isinstance(error, SaleSourceWithdrawn):
        return QueueJobDeferred(str(error), retry_after=datetime.now(UTC) + SALE_DEFERRAL)
    return QueueJobDeferred("Encheres Publiques access authorization required before general enrichment")


def without_withdrawn(scrapers: dict, settings: dict) -> dict:
    """Retire des collecteurs ceux d'une source retirée, même demandée explicitement."""
    withdrawn = withdrawn_sources(str(settings.get("supabase_db_url") or ""))
    for name in sorted(set(scrapers) & withdrawn):
        LOGGER.warning("Source %s retirée du catalogue : collecte ignorée", name)
    return {name: fn for name, fn in scrapers.items() if name not in withdrawn}


def refuse_withdrawn_run(source: str, settings: dict) -> bool:
    """``True`` (avec un message) quand un lancement manuel vise une source retirée."""
    if source == "all" or not is_source_withdrawn(source, str(settings.get("supabase_db_url") or "")):
        return False
    print(f"Source {source} retirée du catalogue : rien à collecter (voir src/source_withdrawal.py).")
    return True
