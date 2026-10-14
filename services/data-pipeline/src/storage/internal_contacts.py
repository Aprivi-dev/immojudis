"""Écriture des adresses internes (``AuctionSale.internal_contacts``) dans le registre de l'agent.

Décision du propriétaire (14/10/2026) : l'adresse e-mail décodée d'un avocat Licitor est conservée
uniquement dans ``public.information_agent_contacts`` (service_role, aucun grant pour anon ni
authenticated) et n'est jamais publiée. Aucune colonne de ``auction_sales`` ne la porte.

Règles, identiques pour la transaction Postgres et pour PostgREST :

* ligne typée ``source_kind = 'sale_listing'``, ``source_url`` = page Licitor, ``observed_by = 'agent'``,
  ``observed_at`` = maintenant, portée ``scope_sale_id`` = la vente ;
* une adresse déjà marquée ``opposed`` (par adresse) n'est jamais écrite ni rafraîchie ; l'opposition par
  identité reste contrôlée à l'envoi par l'agent ;
* à chaque recollecte, une ligne ``sale_listing`` existante est rafraîchie (``observed_at``, ``source_url``,
  ``last_seen_at``), ce qui repousse la purge de 21 jours ; une adresse non recollectée et non utilisée est
  purgée comme prévu. Une ligne d'un autre type (saisie d'administrateur, annuaire…) n'est jamais réécrite ;
* ni écriture ni rafraîchissement pour une vente dont l'audience est passée, ou retirée, annulée ou
  reportée sans nouvelle date (``registers_internal_contacts``) : l'adresse n'est donc plus entretenue
  après la vente et la purge de 21 jours (hebdomadaire) la supprime au plus tard 28 jours après la
  dernière consultation de l'annonce ;
* ``created_at`` n'est jamais réécrit : il garde la date du premier relevé ;
* aucune adresse n'est journalisée : l'appelant ne consigne que des compteurs et le type de l'erreur.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

import httpx

from src.admission import is_catalogue_expired
from src.models import AuctionSale
from src.storage.fact_claim_rows import _sale_ids_for_connection
from src.storage.postgrest_helpers import _postgrest_in_filter, _rest_headers

try:
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - psycopg est absent des environnements REST seuls.
    Jsonb = None

LOGGER = logging.getLogger(__name__)
TABLE = "information_agent_contacts"
SOURCE_KIND = "sale_listing"
OBSERVED_BY = "agent"
OBSERVATION_CHANNEL = "licitor_cloudflare_decoded"
REST_TIMEOUT = httpx.Timeout(60.0, connect=30.0)
PAGE_SIZE = 1000  # plafond de lignes d'une réponse PostgREST
MAX_PAGES = 50
SALE_ID_CHUNK = 50

_INSERT_SQL = """
insert into public.information_agent_contacts
  (sale_id, scope_sale_id, email, display_name, role, provenance, verification_status,
   source_name, source_url, source_kind, observed_at, observed_by, last_seen_at, metadata)
select %(sale_id)s::uuid, %(sale_id)s::uuid, %(email)s::text, %(name)s::text, %(role)s::text,
       %(provenance)s::jsonb, 'source_observed', %(source_name)s::text, %(source_url)s::text,
       'sale_listing', %(now)s::timestamptz, 'agent', %(now)s::timestamptz, %(metadata)s::jsonb
where not exists (
  select 1 from public.information_agent_contacts opposed
  where opposed.normalized_email = lower(btrim(%(email)s::text)) and opposed.opposition_status = 'opposed'
)
on conflict (scope_sale_id, normalized_email) do update
  set observed_at = excluded.observed_at,
      source_url = excluded.source_url,
      last_seen_at = excluded.last_seen_at
  where public.information_agent_contacts.source_kind = 'sale_listing'
    and public.information_agent_contacts.opposition_status <> 'opposed'
"""


def contact_rows(sales: list[AuctionSale], sale_ids: dict[str, str], now: str) -> list[dict[str, Any]]:
    """Lignes du registre pour les ventes dont l'id est connu (une par vente et par adresse)."""
    rows: list[dict[str, Any]] = []
    for sale in sales:
        sale_id = sale_ids.get(sale.source_url)
        if not sale_id:
            continue
        for contact in sale.internal_contacts:
            email = contact["email"]
            # La source de l'adresse (Licitor) peut différer de celle de la vente survivante d'une fusion.
            source_name = contact.get("source_name") or sale.source_name
            source_url = contact.get("source_url") or sale.source_url
            rows.append(
                {
                    "sale_id": sale_id,
                    "email": email,
                    "name": (contact.get("name") or "")[:180] or None,
                    "role": contact.get("role") or "lawyer",
                    "source_name": source_name,
                    "source_url": source_url,
                    "now": now,
                    "provenance": [
                        {
                            "kind": "source_block",
                            "field": "source_blocks.avocats",
                            "source_name": source_name,
                            "source_url": source_url,
                        }
                    ],
                    "metadata": {"observation_channel": OBSERVATION_CHANNEL, "confidence": "high"},
                }
            )
    return rows


_CLOSED_STATUSES = frozenset({"cancelled", "withdrawn", "past", "adjudicated"})


def registers_internal_contacts(sale: AuctionSale) -> bool:
    """Vente dont l'adresse est encore entretenue : audience à venir, ni retirée ni annulée.

    Une vente reportée sans nouvelle date n'est pas entretenue ; une audience passée non plus
    (``is_catalogue_expired`` : même règle que le catalogue, heure ou jour de l'audience).
    """
    status = (sale.status or "").lower()
    if status in _CLOSED_STATUSES or (status == "postponed" and sale.sale_date is None):
        return False
    return not is_catalogue_expired(sale)


def sales_with_internal_contacts(sales: list[AuctionSale]) -> list[AuctionSale]:
    return [sale for sale in sales if sale.internal_contacts and registers_internal_contacts(sale)]


def write_internal_contacts_connection(connection: Any, sales: list[AuctionSale], now: str) -> int:
    """Écrit dans la transaction de publication, un point de sauvegarde par ligne (jamais d'échec propagé).

    La relecture des ids et chaque ligne ont leur propre point de sauvegarde : une erreur annule seulement
    ce point ; la transaction de publication (la vente et le reste) n'est jamais abandonnée. Les erreurs
    sont comptées et journalisées par type, sans adresse.
    """
    eligible = sales_with_internal_contacts(sales)
    if not eligible or Jsonb is None:
        return 0
    try:
        with connection.transaction():
            sale_ids = _sale_ids_for_connection(connection, eligible)
    except Exception as exc:  # noqa: BLE001 - la vente reste publiée
        LOGGER.warning("Internal contacts registry lookup skipped: error=%s sales=%s", type(exc).__name__, len(eligible))
        return 0
    written = failed = 0
    last_error = ""
    for row in contact_rows(eligible, sale_ids, now):
        try:
            with connection.transaction():
                connection.execute(
                    _INSERT_SQL,
                    {**row, "provenance": Jsonb(row["provenance"]), "metadata": Jsonb(row["metadata"])},
                )
            written += 1
        except Exception as exc:  # noqa: BLE001 - une ligne en échec n'arrête ni les autres ni la collecte
            failed += 1
            last_error = type(exc).__name__
    if failed:
        LOGGER.warning("Internal contacts registry rows skipped: error=%s failed=%s written=%s", last_error, failed, written)
    return written


def _read_pages(
    get: Callable[..., httpx.Response],
    endpoint: str,
    params: dict[str, str],
    api_key: str,
    check: Callable[[httpx.Response], httpx.Response],
) -> list[dict[str, Any]]:
    """Toutes les lignes d'une lecture PostgREST, par pages de ``PAGE_SIZE`` triées par id.

    PostgREST plafonne une réponse : sans pagination une lecture tronquée passerait pour complète. Un
    nombre de pages au-delà de ``MAX_PAGES`` lève une erreur (rien n'est alors écrit).
    """
    rows: list[dict[str, Any]] = []
    for page in range(MAX_PAGES):
        batch = check(
            get(
                endpoint,
                params={**params, "order": "id", "limit": str(PAGE_SIZE), "offset": str(page * PAGE_SIZE)},
                headers=_rest_headers(api_key, prefer="count=none"),
                timeout=REST_TIMEOUT,
            )
        ).json()
        if not isinstance(batch, list):
            raise RuntimeError("registre des contacts : réponse inattendue")
        rows.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < PAGE_SIZE:
            return rows
    raise RuntimeError("registre des contacts : trop de pages, aucune adresse écrite")


def write_internal_contacts_rest(
    supabase_url: str,
    api_key: str,
    sales: list[AuctionSale],
    sale_ids: dict[str, str],
    now: str,
    *,
    get: Callable[..., httpx.Response] = httpx.get,
    post: Callable[..., httpx.Response] = httpx.post,
    patch: Callable[..., httpx.Response] = httpx.patch,
) -> int:
    """Même règles par PostgREST : lire les oppositions et les lignes existantes, puis insérer ou rafraîchir."""
    rows = contact_rows(sales_with_internal_contacts(sales), sale_ids, now)
    if not rows:
        return 0
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{TABLE}"

    def check(response: httpx.Response) -> httpx.Response:
        if response.is_error:
            # Le corps de la réponse peut citer une ligne (donc une adresse) : seul le statut remonte.
            raise RuntimeError(f"registre des contacts : réponse {response.status_code}")
        return response

    # Aucune adresse dans une URL : le client HTTP journalise les URL complètes. Les oppositions sont donc
    # lues en entier (pagination) et les lignes existantes par lots de ventes.
    opposed = {
        str(item.get("normalized_email"))
        for item in _read_pages(
            get, endpoint, {"select": "normalized_email", "opposition_status": "eq.opposed"}, api_key, check
        )
    }
    sale_ids = sorted({row["sale_id"] for row in rows})
    existing: dict[tuple[str, str], dict[str, Any]] = {}
    for start in range(0, len(sale_ids), SALE_ID_CHUNK):
        for item in _read_pages(
            get,
            endpoint,
            {
                "select": "id,scope_sale_id,normalized_email,source_kind,opposition_status",
                "scope_sale_id": _postgrest_in_filter(sale_ids[start : start + SALE_ID_CHUNK]),
            },
            api_key,
            check,
        ):
            existing[(str(item.get("scope_sale_id")), str(item.get("normalized_email")))] = item
    inserts: list[dict[str, Any]] = []
    refreshes: list[dict[str, Any]] = []
    for row in rows:
        if row["email"] in opposed:
            continue
        found = existing.get((row["sale_id"], row["email"]))
        if found is None:
            inserts.append(
                {
                    "sale_id": row["sale_id"],
                    "scope_sale_id": row["sale_id"],
                    "email": row["email"],
                    "display_name": row["name"],
                    "role": row["role"],
                    "provenance": row["provenance"],
                    "verification_status": "source_observed",
                    "source_name": row["source_name"],
                    "source_url": row["source_url"],
                    "source_kind": SOURCE_KIND,
                    "observed_at": now,
                    "observed_by": OBSERVED_BY,
                    "last_seen_at": now,
                    "metadata": row["metadata"],
                }
            )
        elif found.get("source_kind") == SOURCE_KIND and found.get("opposition_status") != "opposed":
            refreshes.append({**row, "id": found.get("id")})
    if inserts:
        check(
            post(
                endpoint,
                params={"on_conflict": "scope_sale_id,normalized_email"},
                headers=_rest_headers(api_key, prefer="resolution=ignore-duplicates,return=minimal"),
                json=inserts,
                timeout=REST_TIMEOUT,
            )
        )
    for row in refreshes:
        check(
            patch(
                endpoint,
                params={"id": f"eq.{row['id']}"},
                headers=_rest_headers(api_key, prefer="return=minimal"),
                json={"observed_at": now, "source_url": row["source_url"], "last_seen_at": now},
                timeout=REST_TIMEOUT,
            )
        )
    return len(inserts) + len(refreshes)


def write_safely(
    sales: list[AuctionSale],
    supabase_url: str,
    api_key: str,
    now: str,
    connection: Any,
    sale_ids_for_rest: Callable[[str, str, list[AuctionSale]], dict[str, str]],
) -> int:
    """Adresses internes des ventes vers le registre de l'agent, jamais vers la vente.

    Écrit après l'écriture de la vente : dans la transaction de publication quand il y en a une (point de
    sauvegarde), sinon par PostgREST une fois l'id de la vente relu. Un échec n'interrompt jamais la
    collecte : il est journalisé sans adresse (type de l'erreur et compteur seulement).
    """
    eligible = sales_with_internal_contacts(sales)
    if not eligible:
        return 0
    try:
        if connection is not None:
            return write_internal_contacts_connection(connection, eligible, now)
        return write_internal_contacts_rest(
            supabase_url, api_key, eligible, sale_ids_for_rest(supabase_url, api_key, eligible), now
        )
    except Exception as exc:  # noqa: BLE001 - jamais d'échec de collecte pour un registre interne
        LOGGER.warning("Internal contacts registry write skipped: error=%s sales=%s", type(exc).__name__, len(eligible))
        return 0
