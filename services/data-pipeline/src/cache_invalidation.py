"""Invalidation du cache public après le retrait d'une vente (point 4 du compte-rendu du 18/10/2026).

``python -m src.cache_invalidation --flush``

Un déclencheur de ``public.auction_sales`` (migration ``20261028100000_catalogue_invalidations.sql``) écrit
l'identifiant d'une vente dans ``app_private.catalogue_invalidations`` quand elle quitte le catalogue public
(statut, quarantaine, date) ou quand une ligne visible est supprimée, dans la transaction même de la
modification : aucun chemin d'écriture ne peut l'oublier, et rien n'est lu avant le COMMIT.

Ce module vide cette boîte d'envoi. Il est lancé à la fin de chaque collecte planifiée, dans une étape
dédiée de ``data-pipeline.yml`` (la seule avec ``CRON_SECRET``) :

* lit au plus ``BATCH_SIZE`` (100) lignes à la fois, ``for update skip locked`` : deux passages qui se
  chevauchent ne se marchent pas dessus ;
* ``POST {SITE_URL}/api/pipeline/revalidate-sale`` avec ``Authorization: Bearer $CRON_SECRET`` et les
  identifiants distincts du lot ; 10 s au plus, aucune redirection suivie (le secret ne part pas ailleurs) ;
* ne supprime les lignes que sur une réponse 2xx. Sur toute autre réponse (ou une erreur réseau), le lot
  reste en place, le passage s'arrête (inutile d'insister auprès d'un site qui répond mal) et le suivant
  reprend ;
* au plus ``MAX_BATCHES`` lots par passage, pour que l'étape reste courte même après une fusion massive ;
* ne lève jamais et sort toujours avec le code 0 : une invalidation en échec ne doit pas faire échouer la
  collecte (le cache expire de toute façon en quelques minutes). L'échec est visible dans les compteurs
  journalisés et dans une annotation ``::warning::`` du workflow.

Ne journalise jamais le secret, ni l'URL de connexion.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from src.storage.supabase_client import connect as postgres_connect

LOGGER = logging.getLogger(__name__)

BATCH_SIZE = 100
"""Identifiants par appel : le maximum que la route accepte (``MAX_SALES_PER_CALL``)."""
MAX_BATCHES = 20
"""Lots par passage (2 000 lignes) : une fusion massive de doublons s'écoule en quelques passages."""
REQUEST_TIMEOUT_SECONDS = 10.0
REVALIDATE_PATH = "/api/pipeline/revalidate-sale"

SELECT_SQL = """
select id, sale_id::text
  from app_private.catalogue_invalidations
 order by at, id
 limit %s
   for update skip locked
"""
DELETE_SQL = "delete from app_private.catalogue_invalidations where id = any(%s)"

PostFunction = Callable[[str, list[str], str], int]


@dataclass
class FlushSummary:
    """Compteurs d'un passage. Aucune donnée personnelle, aucun secret."""

    batches: int = 0
    rows_read: int = 0
    sales_notified: int = 0
    requests_ok: int = 0
    requests_failed: int = 0
    rows_deleted: int = 0
    last_status: int | None = None
    skipped: str | None = None
    error: str | None = None
    capped: bool = False


def site_origin(value: str | None) -> str | None:
    """Origine ``https://hôte`` de ``SITE_URL``, ou ``None`` si l'adresse ne convient pas.

    Le secret part vers cette adresse : https obligatoire (http seulement en local), ni identifiants, ni
    chemin, ni paramètres.
    """
    text = (value or "").strip()
    if not text:
        return None
    try:
        parts = urlsplit(text)
        host = parts.hostname
        parts.port  # noqa: B018 - lève ValueError sur un port illisible
    except ValueError:
        return None
    if not host or parts.username or parts.password or parts.query or parts.fragment:
        return None
    if parts.path not in ("", "/"):
        return None
    local = host in ("localhost", "127.0.0.1", "::1")
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        return None
    return f"{parts.scheme}://{parts.netloc}"


def post_revalidation(url: str, sale_ids: list[str], secret: str) -> int:
    """Un appel à la route d'invalidation ; renvoie le code HTTP, ou 0 si l'appel n'a pas abouti."""
    try:
        response = httpx.post(
            url,
            json={"saleIds": sale_ids},
            headers={"authorization": f"Bearer {secret}", "user-agent": "Immojudis-cache-invalidation"},
            timeout=REQUEST_TIMEOUT_SECONDS,
            follow_redirects=False,
        )
    except httpx.HTTPError as exc:
        LOGGER.warning("Cache invalidation: request failed (%s)", type(exc).__name__)
        return 0
    return response.status_code


def flush(
    *,
    db_url: str,
    site_url: str,
    cron_secret: str,
    connect: Callable[..., Any] = postgres_connect,
    post: PostFunction = post_revalidation,
    batch_size: int = BATCH_SIZE,
    max_batches: int = MAX_BATCHES,
) -> FlushSummary:
    """Vide la boîte d'envoi par lots. Ne lève jamais."""
    summary = FlushSummary()
    origin = site_origin(site_url)
    if origin is None:
        summary.skipped = "invalid_site_url"
        return summary
    url = f"{origin}{REVALIDATE_PATH}"
    try:
        with connect(db_url) as db:
            while summary.batches < max_batches:
                rows = db.execute(SELECT_SQL, (batch_size,)).fetchall()
                if not rows:
                    break
                summary.batches += 1
                summary.rows_read += len(rows)
                # Une vente peut avoir plusieurs lignes (plusieurs bascules) : un identifiant par appel.
                sale_ids = list(dict.fromkeys(str(row[1]).lower() for row in rows))
                summary.sales_notified += len(sale_ids)
                status = post(url, sale_ids, cron_secret)
                summary.last_status = status
                if 200 <= status < 300:
                    summary.requests_ok += 1
                    db.execute(DELETE_SQL, ([row[0] for row in rows],))
                    db.commit()
                    summary.rows_deleted += len(rows)
                    continue
                # Le lot reste en place (relâche aussi les verrous) : le prochain passage le reprend.
                summary.requests_failed += 1
                db.rollback()
                break
            else:
                summary.capped = True
    except Exception as exc:  # noqa: BLE001 - jamais d'échec de collecte à cause de l'invalidation
        summary.error = type(exc).__name__
        LOGGER.warning("Cache invalidation: %s", summary.error)
    return summary


def main(argv: list[str] | None = None, *, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Invalidation du cache public après un retrait de vente.")
    parser.add_argument("--flush", action="store_true", required=True, help="vider la boîte d'envoi")
    parser.parse_args(argv)
    values = os.environ if env is None else env

    db_url = (values.get("SUPABASE_DB_URL") or "").strip()
    site_url = (values.get("SITE_URL") or "").strip()
    secret = (values.get("CRON_SECRET") or "").strip()
    missing = [
        name
        for name, value in (("SUPABASE_DB_URL", db_url), ("SITE_URL", site_url), ("CRON_SECRET", secret))
        if not value
    ]
    if missing:
        summary = FlushSummary(skipped="missing_" + "_".join(name.lower() for name in missing))
    else:
        summary = flush(db_url=db_url, site_url=site_url, cron_secret=secret)

    _emit(summary)
    return 0


def _emit(summary: FlushSummary) -> None:
    payload = {"event": "cache_invalidation", **asdict(summary)}
    print(json.dumps(payload, sort_keys=True), flush=True)
    problem = summary.skipped or summary.error or (summary.requests_failed and "request_failed")
    if problem:
        # Annotation visible dans le résumé du workflow ; l'étape reste verte.
        print(
            f"::warning title=Invalidate public cache::cache non invalidé ({problem}) ; "
            "les lignes restent dans app_private.catalogue_invalidations pour le prochain passage",
            flush=True,
        )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
