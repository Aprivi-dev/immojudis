"""Géocodage BAN en lot des ventes à venir qui ont une adresse mais pas de position précise.

Pourquoi : la finalisation automatique ne géocode plus par BAN (appels en série, trop lents pour le budget d'un run,
voir ``src.municipality_location``) et la BAN n'est appelée que pour une vente qui a une tâche d'enrichissement. Mesure
du 28/10/2026 : 341 ventes à venir avaient le centre de commune de ``reference_communes`` alors que 310 avaient un
numéro et une voie (« 20 rue Marcel Sembat, Longvic »).

Ce passage, exécuté après la file d'enrichissement du lanceur planifié (``src.autonomous_runner``, aucune nouvelle
planification), traite au plus ``MAX_SALES_PER_PASS`` ventes :

* ventes ``upcoming`` / ``unknown`` / ``postponed`` dont la date n'est pas passée ;
* dont le point est un centre de commune (``geo_precision = municipality`` ou preuve ``reference_communes``) ou qui n'ont
  aucun point ;
* dont l'adresse contient une voie ou un lieu-dit (``has_street_or_place``).

Les requêtes sont celles de ``geocode_sale`` (``src.geocode_query``) et partent en un seul envoi CSV par lot de
``CHUNK_SIZE`` adresses, au géocodage en masse de la Géoplateforme (``POST {geocode_api_url}/csv``, colonnes ``q`` et
``postcode``). Les règles d'acceptation sont exactement celles de ``geocode_sale`` : score minimal, rue concordante,
département (``src.geocode.apply_address_result``). Un résultat au niveau de la commune ne remplace jamais le point
existant.

Cache : une requête déjà essayée depuis moins de 14 jours (sans résultat, refusée ou au niveau commune) n'est pas
renvoyée ; une requête différente, si. Les ventes jamais essayées passent d'abord, puis les plus anciennes tentatives.

Écriture : une ligne à la fois, ``latitude``, ``longitude``, ``quality_flags`` et seulement les clés ``geo_precision``,
``geocode`` et ``commune`` de ``raw_payload`` (fusion ``||``, le reste du JSON n'est pas relu ni réécrit). La ligne
n'est écrite que si ``updated_at`` n'a pas bougé depuis la lecture : une ligne réécrite par une collecte entre-temps est
laissée au passage suivant. ``updated_at`` n'est pas modifié (comme le point de reprise des pièces), et le verrou des
écritures du catalogue est pris pour la durée du passage.

Code de sortie : 0 (fait, désactivé ou verrou occupé), 1 (base ou BAN indisponible).
"""

from __future__ import annotations

import argparse
import copy
import csv
import io
import json
import logging
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
from psycopg.types.json import Jsonb

from src.commune_insee import record_sale_commune
from src.config import load_settings
from src.geocode import (
    RATE_LIMIT_BACKOFF_SECONDS,
    GeocodeResult,
    apply_address_result,
    geocode_attempt_is_cached,
    result_from_feature,
)
from src.geocode_query import build_geocode_query, geocode_postcode, has_street_or_place
from src.models import AuctionSale

LOGGER = logging.getLogger(__name__)

MAX_SALES_PER_PASS = 500
CHUNK_SIZE = 250
READ_LIMIT = 3000
REQUEST_TIMEOUT_SECONDS = 120.0
LOCK_WAIT_SECONDS = 120.0
DEFAULT_BUDGET_SECONDS = 170.0
RESULT_COLUMNS = (
    "latitude",
    "longitude",
    "result_score",
    "result_type",
    "result_label",
    "result_street",
    "result_name",
    "result_city",
    "result_citycode",
    "result_postcode",
    "result_status",
)
# Clés de raw_payload écrites par ce passage : rien d'autre n'est touché.
PAYLOAD_KEYS = ("geo_precision", "geocode", "commune")

CANDIDATES_SQL = """
select id, source_name, source_url, updated_at, address, city, postal_code, department,
       latitude, longitude, quality_flags,
       raw_payload->'geo_precision', raw_payload->'geocode', raw_payload->'commune',
       raw_payload->'invalid_address_evidence'
  from public.auction_sales
 where status in ('upcoming', 'unknown', 'postponed')
   and (sale_date is null or sale_date >= now())
   and address is not null and btrim(address) <> ''
   and jsonb_typeof(raw_payload) = 'object'
   and (
     latitude is null or longitude is null
     or raw_payload->>'geo_precision' = 'municipality'
     or raw_payload->'geocode'->>'provider' = 'reference_communes'
   )
 order by sale_date nulls last, id
 limit %s
"""

# Ligne dont la position change : coordonnées, drapeaux et clés de raw_payload du passage.
UPDATE_POSITION_SQL = """
update public.auction_sales
   set latitude = %s,
       longitude = %s,
       quality_flags = %s,
       raw_payload = coalesce(raw_payload, '{}'::jsonb) || %s
 where id = %s and updated_at = %s and jsonb_typeof(raw_payload) = 'object'
"""

# Ligne dont seule la tentative est consignée (cache négatif) : les coordonnées ne sont pas dans le SET, le
# déclencheur d'estimation de marché n'est donc pas relancé.
UPDATE_ATTEMPT_SQL = """
update public.auction_sales
   set raw_payload = coalesce(raw_payload, '{}'::jsonb) || %s
 where id = %s and updated_at = %s and jsonb_typeof(raw_payload) = 'object'
"""


@dataclass
class Candidate:
    row_id: str
    updated_at: Any
    sale: AuctionSale
    query: str
    postcode: str | None
    before: tuple[Any, Any]
    payload_before: dict[str, Any]


def positions_enabled() -> bool:
    return str(os.getenv("ADDRESS_POSITIONS_ENABLED", "true")).strip().lower() not in {"0", "false", "no", "off"}


def sale_from_row(row: tuple[Any, ...]) -> tuple[str, Any, AuctionSale]:
    """Vente allégée (adresse, position, preuves de position) à partir d'une ligne de ``CANDIDATES_SQL``."""
    (row_id, source_name, source_url, updated_at, address, city, postal_code, department, latitude, longitude,
     flags, precision, geocode, commune, invalid_address) = row
    payload: dict[str, Any] = {}
    for key, value in (("geo_precision", precision), ("geocode", geocode), ("commune", commune)):
        if value is not None:
            payload[key] = value
    if invalid_address:
        payload["invalid_address_evidence"] = invalid_address
    sale = AuctionSale(
        id=str(row_id),
        source_name=str(source_name),
        source_url=str(source_url),
        address=address,
        city=city,
        postal_code=postal_code,
        department=department,
        latitude=latitude,
        longitude=longitude,
        quality_flags=[flag for flag in (flags or []) if isinstance(flag, str)],
        raw_payload=payload,
    )
    return str(row_id), updated_at, sale


def _attempted_at(sale: AuctionSale) -> str:
    geocode = sale.raw_payload.get("geocode")
    if isinstance(geocode, dict) and geocode.get("provider") == "ban_geoplateforme":
        return str(geocode.get("attempted_at") or "")
    return ""


def select_candidates(rows: list[tuple[Any, ...]], *, limit: int) -> tuple[list[Candidate], dict[str, int]]:
    """Les ventes à envoyer : jamais essayées d'abord, puis les tentatives les plus anciennes ; au plus ``limit``."""
    counts = {"read": len(rows), "no_street": 0, "invalid_address": 0, "cached": 0}
    candidates: list[Candidate] = []
    for row in rows:
        row_id, updated_at, sale = sale_from_row(row)
        if sale.raw_payload.get("invalid_address_evidence"):
            # Une adresse écartée (prix, bloc de cabinet) n'est jamais géocodée.
            counts["invalid_address"] += 1
            continue
        if not has_street_or_place(sale.address):
            counts["no_street"] += 1
            continue
        query = build_geocode_query(sale)
        if not query:
            counts["no_street"] += 1
            continue
        if geocode_attempt_is_cached(sale, query):
            counts["cached"] += 1
            continue
        candidates.append(
            Candidate(
                row_id,
                updated_at,
                sale,
                query,
                geocode_postcode(sale),
                (sale.latitude, sale.longitude),
                copy.deepcopy(sale.raw_payload),
            )
        )
    candidates.sort(key=lambda candidate: (bool(_attempted_at(candidate.sale)), _attempted_at(candidate.sale)))
    counts["eligible"] = len(candidates)
    return candidates[: max(0, limit)], counts


def csv_payload(candidates: list[Candidate]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["id", "q", "postcode"])
    for candidate in candidates:
        writer.writerow([candidate.row_id, candidate.query, candidate.postcode or ""])
    return buffer.getvalue().encode("utf-8")


def batch_url(api_url: str) -> str:
    """``https://data.geopf.fr/geocodage/search/`` -> ``https://data.geopf.fr/geocodage/search/csv``."""
    return api_url.rstrip("/") + "/csv"


def post_batch(
    candidates: list[Candidate],
    *,
    api_url: str,
    post: Callable[..., Any] = httpx.post,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Un envoi CSV au géocodage en masse ; renvoie le CSV de la réponse. Lève sur une erreur HTTP."""
    files = {"data": ("ventes.csv", csv_payload(candidates), "text/csv")}
    data = {"columns": "q", "postcode": "postcode", "result_columns": list(RESULT_COLUMNS)}
    response = post(batch_url(api_url), files=files, data=data, timeout=REQUEST_TIMEOUT_SECONDS)
    for delay in RATE_LIMIT_BACKOFF_SECONDS:
        if getattr(response, "status_code", None) != 429:
            break
        LOGGER.warning("BAN batch rate limit reached; retrying in %ss", delay)
        sleep(delay)
        response = post(batch_url(api_url), files=files, data=data, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    return str(response.text)


def parse_batch_response(text: str, *, min_score: float) -> dict[str, GeocodeResult | None]:
    """Résultat par identifiant, avec les seuils de ``geocode_sale`` ; ``None`` : la BAN n'a rien trouvé de recevable.

    Une ligne en erreur ou ignorée (``result_status`` autre que ``ok`` et ``not-found``) est absente du résultat : elle
    n'est pas mise en cache et sera renvoyée au passage suivant.
    """
    results: dict[str, GeocodeResult | None] = {}
    for row in csv.DictReader(io.StringIO(text)):
        row_id = (row.get("id") or "").strip()
        status = (row.get("result_status") or "").strip()
        if not row_id or status not in {"ok", "not-found"}:
            continue
        if status == "not-found" or not row.get("latitude") or not row.get("longitude"):
            results[row_id] = None
            continue
        try:
            feature = {
                "properties": {
                    "score": float(row.get("result_score") or 0),
                    "type": row.get("result_type") or None,
                    "label": row.get("result_label") or None,
                    "street": row.get("result_street") or None,
                    "name": row.get("result_name") or None,
                    "city": row.get("result_city") or None,
                    "citycode": row.get("result_citycode") or None,
                    "postcode": row.get("result_postcode") or None,
                },
                "geometry": {"coordinates": [float(row["longitude"]), float(row["latitude"])]},
            }
        except (TypeError, ValueError):
            continue
        results[row_id] = result_from_feature(feature, min_score)
    return results


def apply_results(candidates: list[Candidate], results: dict[str, GeocodeResult | None]) -> dict[str, int]:
    """Applique les résultats aux ventes (mêmes règles que ``geocode_sale``) ; remplit ``Candidate.sale``."""
    counts = {"accepted": 0, "refused": 0, "unanswered": 0}
    for candidate in candidates:
        if candidate.row_id not in results:
            counts["unanswered"] += 1
            continue
        accepted = apply_address_result(candidate.sale, query=candidate.query, result=results[candidate.row_id])
        if accepted:
            record_sale_commune(candidate.sale)
            counts["accepted"] += 1
        else:
            counts["refused"] += 1
    return counts


def _payload_patch(candidate: Candidate) -> dict[str, Any]:
    """Les clés de ``raw_payload`` que le passage a ajoutées ou changées."""
    payload = candidate.sale.raw_payload
    return {
        key: payload[key]
        for key in PAYLOAD_KEYS
        if key in payload and payload[key] != candidate.payload_before.get(key)
    }


def write_candidate(connection: Any, candidate: Candidate) -> bool:
    """Écrit la position d'une vente ; faux si la ligne a changé depuis la lecture (reprise au passage suivant)."""
    sale = candidate.sale
    patch = Jsonb(_payload_patch(candidate))
    if (sale.latitude, sale.longitude) != candidate.before:
        cursor = connection.execute(
            UPDATE_POSITION_SQL,
            (sale.latitude, sale.longitude, Jsonb(sale.quality_flags), patch, candidate.row_id, candidate.updated_at),
        )
    else:
        cursor = connection.execute(UPDATE_ATTEMPT_SQL, (patch, candidate.row_id, candidate.updated_at))
    return bool(getattr(cursor, "rowcount", 0))


def run_pass(
    connection_factory: Callable[[], Any],
    *,
    api_url: str,
    min_score: float,
    max_sales: int = MAX_SALES_PER_PASS,
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
    dry_run: bool = False,
    post: Callable[..., Any] = httpx.post,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, int]:
    """Un passage : lecture, envoi en lot, application des résultats, écriture. Ne lève pas sur une seule vente."""
    started = clock()
    with connection_factory() as connection:
        connection.execute("set transaction read only")
        rows = connection.execute(CANDIDATES_SQL, (READ_LIMIT,)).fetchall()
    selected, counts = select_candidates(rows, limit=max_sales)
    counts.update(selected=len(selected), accepted=0, refused=0, unanswered=0, written=0, changed_meanwhile=0)
    pending: list[Candidate] = []
    for start in range(0, len(selected), CHUNK_SIZE):
        if clock() - started >= budget_seconds:
            break
        chunk = selected[start : start + CHUNK_SIZE]
        results = parse_batch_response(post_batch(chunk, api_url=api_url, post=post), min_score=min_score)
        for key, value in apply_results(chunk, results).items():
            counts[key] += value
        pending.extend(candidate for candidate in chunk if candidate.row_id in results)
    if dry_run or not pending:
        return counts
    with connection_factory() as connection:
        for candidate in pending:
            try:
                if write_candidate(connection, candidate):
                    counts["written"] += 1
                else:
                    counts["changed_meanwhile"] += 1
            except Exception as exc:  # une ligne en échec ne bloque pas les autres
                LOGGER.warning("Position not written for %s: %s", candidate.sale.source_url, exc)
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Géocodage BAN en lot des ventes à venir sans position précise")
    parser.add_argument("--max-sales", type=int, default=int(os.getenv("ADDRESS_POSITIONS_MAX_SALES", MAX_SALES_PER_PASS)))
    parser.add_argument("--budget-seconds", type=float, default=DEFAULT_BUDGET_SECONDS)
    parser.add_argument("--dry-run", action="store_true", help="n'écrit rien en base")
    args = parser.parse_args(argv)
    settings = load_settings()
    if not positions_enabled() or not settings.get("geocode_enabled"):
        print(json.dumps({"skipped": "ADDRESS_POSITIONS_ENABLED or GEOCODE_ENABLED is off"}))
        return 0
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required for address positions")
    from src.catalogue_lock import CatalogueLockTimeout, catalogue_writer_lock
    from src.storage.supabase_client import connect

    try:
        with catalogue_writer_lock(db_url, label="address positions", wait_seconds=LOCK_WAIT_SECONDS):
            counts = run_pass(
                lambda: connect(db_url),
                api_url=str(settings["geocode_api_url"]),
                min_score=float(settings["geocode_min_score"]),
                max_sales=max(1, min(args.max_sales, MAX_SALES_PER_PASS)),
                budget_seconds=max(30.0, args.budget_seconds),
                dry_run=args.dry_run,
            )
    except CatalogueLockTimeout as exc:
        print(json.dumps({"skipped": str(exc)}))
        return 0
    except httpx.HTTPError as exc:
        LOGGER.error("Address positions: BAN batch failed: %s", exc)
        return 1
    print(json.dumps(counts, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
