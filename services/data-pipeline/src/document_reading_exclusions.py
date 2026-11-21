"""Ventes exclues de la lecture automatique des pièces (lot V3b-0, migration 20261208100000).

Une vente exclue n'est plus lue par aucun modèle : ni par le banc de lecture des pièces
(``scripts/compare_document_vision.py``), ni par la passe d'écriture du lot V3b-1. La règle « cette vente est-elle
exclue ? » n'est écrite qu'ici : :data:`EXCLUDED_SALE_SQL` pour une requête qui parcourt les ventes (alias ``sale``),
:func:`is_sale_excluded_from_document_reading` pour une vente seule. Les deux disent la même chose : l'URL de
l'exclusion est l'URL source de la vente, ou l'une des URL qu'elle a reprises en absorbant un doublon.

L'inscription se fait par la commande opérateur ``python -m scripts.exclude_sale_from_document_reading``.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

REASONS = ("opposition", "correction", "autre")

# Condition SQL vraie quand la vente ``sale`` (public.auction_sales) est exclue.
EXCLUDED_SALE_SQL = """exists (
    select 1
      from public.document_reading_exclusions exclusion
     where exclusion.source_url = sale.source_url
        or coalesce(sale.source_urls, '[]'::jsonb) ? exclusion.source_url
  )"""

_SALE_EXCLUDED_SQL = f"""
select exists (select 1 from public.document_reading_exclusions where source_url = %s)
    or coalesce((select {EXCLUDED_SALE_SQL} from public.auction_sales sale where sale.source_url = %s), false)
"""

_EXCLUDE_SQL = """
insert into public.document_reading_exclusions (source_url, reason, data_subject_request_id)
values (%s, %s, %s)
on conflict (source_url) do nothing
returning source_url
"""


def is_sale_excluded_from_document_reading(conn: Any, source_url: str) -> bool:
    """La vente d'URL source ``source_url`` est exclue de toute lecture automatique de ses pièces.

    Vraie aussi quand la vente n'est plus en base mais que son URL est inscrite (vente absorbée par un doublon).
    """
    row = conn.execute(_SALE_EXCLUDED_SQL, (source_url, source_url)).fetchone()
    return bool(row and row[0])


def exclude_sale_from_document_reading(
    conn: Any, source_url: str, *, reason: str, request_id: UUID | None = None
) -> bool:
    """Inscrit l'exclusion ; rend False si la vente l'était déjà (l'inscription existante reste telle quelle)."""
    if reason not in REASONS:
        raise ValueError(f"motif hors liste : attendu l'un de {', '.join(REASONS)}")
    row = conn.execute(_EXCLUDE_SQL, (source_url, reason, str(request_id) if request_id else None)).fetchone()
    return row is not None
