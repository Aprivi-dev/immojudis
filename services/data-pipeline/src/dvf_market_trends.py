"""Recalcule le marché local par commune (``app_private.commune_market_trends``) après l'import DVF.

L'agrégat alimente les critères de marché de la règle de pépite ``pepite-v1.2`` (migration 20261109130100) : ventes
sur 12 mois, prix médian au m² de l'année la plus récente et de trois ans plus tôt, par commune et type de logement.
Il est recalculé par ``app_private.refresh_commune_market_trends()`` depuis ``dvf_transactions``.

Appelé par le workflow manuel « Immojudis DVF Import » (``.github/workflows/dvf-import.yml``), à la suite de l'import :
aucune planification n'est créée. Toute erreur de la base fait échouer le recalcul.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from typing import Any

from src.config import load_settings
from src.storage.supabase_client import connect as postgres_connect

# Le délai de la requête en cours est déjà armé quand la fonction le règle elle-même : on le pose avant l'appel
# (``set local`` : il prend fin avec la transaction). Le recalcul prend quelques secondes avec l'index de la
# migration 20261109130000, plus sans lui (table remplacée par l'import DVF).
STATEMENT_TIMEOUT_SQL = "set local statement_timeout = '10min'"
REFRESH_SQL = "select app_private.refresh_commune_market_trends()"


def refresh_commune_market_trends(connection: Any) -> int:
    """Recalcule l'agrégat ; rend le nombre de lignes écrites."""
    with connection.transaction():
        connection.execute(STATEMENT_TIMEOUT_SQL)
        row = connection.execute(REFRESH_SQL).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recalcule le marché local par commune (règle de pépite pepite-v1.2) après l'import DVF."
    )
    return parser.parse_args()


def main(*, connect: Callable[[str], Any] = postgres_connect) -> int:
    parse_args()
    db_url = load_settings().get("supabase_db_url")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to refresh the commune market trends.")
    with connect(str(db_url)) as connection:
        written = refresh_commune_market_trends(connection)
    print("Commune market trends refresh summary")
    print(f"- rows: {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
