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
* aucune adresse n'est journalisée : l'appelant ne consigne que des compteurs et le type de l'erreur.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from src.models import AuctionSale
from src.storage.fact_claim_rows import _sale_ids_for_connection
from src.storage.postgrest_helpers import _postgrest_in_filter, _rest_headers

try:
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - psycopg est absent des environnements REST seuls.
    Jsonb = None

TABLE = "information_agent_contacts"
SOURCE_KIND = "sale_listing"
OBSERVED_BY = "agent"
OBSERVATION_CHANNEL = "licitor_cloudflare_decoded"
REST_TIMEOUT = httpx.Timeout(60.0, connect=30.0)
OPPOSED_LIMIT = 10000

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
            source_url = contact.get("source_url") or sale.source_url
            rows.append(
                {
                    "sale_id": sale_id,
                    "email": email,
                    "name": (contact.get("name") or "")[:180] or None,
                    "role": contact.get("role") or "lawyer",
                    "source_name": sale.source_name,
                    "source_url": source_url,
                    "now": now,
                    "provenance": [
                        {
                            "kind": "source_block",
                            "field": "source_blocks.avocats",
                            "source_name": sale.source_name,
                            "source_url": source_url,
                        }
                    ],
                    "metadata": {"observation_channel": OBSERVATION_CHANNEL, "confidence": "high"},
                }
            )
    return rows


def sales_with_internal_contacts(sales: list[AuctionSale]) -> list[AuctionSale]:
    return [sale for sale in sales if sale.internal_contacts]


def write_internal_contacts_connection(connection: Any, sales: list[AuctionSale], now: str) -> int:
    """Écrit dans la transaction de publication, dans un point de sauvegarde (jamais d'échec propagé).

    Un échec de ce bloc annule seulement ses propres lignes ; la vente et la collecte continuent.
    """
    eligible = sales_with_internal_contacts(sales)
    if not eligible or Jsonb is None:
        return 0
    rows = contact_rows(eligible, _sale_ids_for_connection(connection, eligible), now)
    written = 0
    with connection.transaction():
        for row in rows:
            connection.execute(
                _INSERT_SQL,
                {**row, "provenance": Jsonb(row["provenance"]), "metadata": Jsonb(row["metadata"])},
            )
            written += 1
    return written


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
    # lues en entier (liste courte) et les lignes existantes par vente.
    opposed_rows = check(
        get(
            endpoint,
            params={"select": "normalized_email", "opposition_status": "eq.opposed", "limit": str(OPPOSED_LIMIT)},
            headers=_rest_headers(api_key, prefer="count=none"),
            timeout=REST_TIMEOUT,
        )
    ).json()
    if not isinstance(opposed_rows, list) or len(opposed_rows) >= OPPOSED_LIMIT:
        raise RuntimeError("liste d'opposition incomplète : aucune adresse écrite")
    opposed = {str(item.get("normalized_email")) for item in opposed_rows if isinstance(item, dict)}
    existing_rows = check(
        get(
            endpoint,
            params={
                "select": "id,scope_sale_id,normalized_email,source_kind,opposition_status",
                "scope_sale_id": _postgrest_in_filter(sorted({row["sale_id"] for row in rows})),
            },
            headers=_rest_headers(api_key, prefer="count=none"),
            timeout=REST_TIMEOUT,
        )
    ).json()
    existing = {
        (str(item.get("scope_sale_id")), str(item.get("normalized_email"))): item
        for item in (existing_rows if isinstance(existing_rows, list) else [])
        if isinstance(item, dict)
    }
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
