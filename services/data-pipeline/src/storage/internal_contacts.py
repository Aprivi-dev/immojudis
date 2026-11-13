"""Écriture des adresses internes (``AuctionSale.internal_contacts``) dans le registre de l'agent.

Décision du propriétaire (14/10/2026) : l'adresse e-mail décodée d'un avocat Licitor est conservée
uniquement dans ``public.information_agent_contacts`` (service_role, aucun grant pour anon ni
authenticated) et n'est jamais publiée. Aucune colonne de ``auction_sales`` ne la porte.

Règles (écriture dans la transaction de publication, seul chemin) :

* ligne typée ``source_kind = 'sale_listing'``, ``source_url`` = page Licitor, ``observed_by = 'agent'``,
  ``observed_at`` = maintenant, portée ``scope_sale_id`` = la vente ;
* une adresse déjà marquée ``opposed`` (par adresse) n'est jamais écrite ni rafraîchie ; l'opposition par
  identité reste contrôlée à l'envoi par l'agent ;
* à chaque recollecte, une ligne ``sale_listing`` existante est rafraîchie (``observed_at``, ``source_url``,
  ``last_seen_at``), ce qui repousse la purge de 21 jours ; une adresse non recollectée et non utilisée est
  purgée comme prévu. Une ligne d'un autre type (saisie d'administrateur, annuaire…) n'est jamais réécrite ;
* ni écriture ni rafraîchissement pour une vente sans date d'audience, dont l'audience est passée, ou
  retirée, annulée ou reportée sans nouvelle date (``registers_internal_contacts``) : l'adresse n'est donc plus entretenue
  après la vente et la purge de 21 jours (hebdomadaire) la supprime au plus tard 28 jours après la
  dernière consultation de l'annonce ;
* ``created_at`` n'est jamais réécrit : il garde la date du premier relevé ;
* aucune adresse n'est journalisée : l'appelant ne consigne que des compteurs et le type de l'erreur.
"""

from __future__ import annotations

import logging
from typing import Any

from src.admission import is_catalogue_expired
from src.models import AuctionSale
from src.storage.fact_claim_rows import _sale_ids_for_connection

try:
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - same guard as supabase_client.
    Jsonb = None

LOGGER = logging.getLogger(__name__)
OBSERVATION_CHANNEL = "licitor_cloudflare_decoded"

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
    """Vente dont l'adresse est encore entretenue : audience datée et à venir, ni retirée ni annulée.

    Sans date d'audience, ou reportée sans nouvelle date, rien n'est écrit ni rafraîchi (strict minimum) ;
    une audience passée non plus (``is_catalogue_expired`` : même règle que le catalogue, heure ou jour de
    l'audience).
    """
    status = (sale.status or "").lower()
    if sale.sale_date is None or status in _CLOSED_STATUSES:
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


def write_safely(sales: list[AuctionSale], now: str, connection: Any) -> int:
    """Adresses internes des ventes vers le registre de l'agent, jamais vers la vente.

    Écrit après l'écriture de la vente, dans la transaction de publication (point de sauvegarde). Un échec
    n'interrompt jamais la collecte : il est journalisé sans adresse (type de l'erreur et compteur seulement).
    """
    eligible = sales_with_internal_contacts(sales)
    if not eligible:
        return 0
    try:
        return write_internal_contacts_connection(connection, eligible, now)
    except Exception as exc:  # noqa: BLE001 - jamais d'échec de collecte pour un registre interne
        LOGGER.warning("Internal contacts registry write skipped: error=%s sales=%s", type(exc).__name__, len(eligible))
        return 0
