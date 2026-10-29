"""Recalcule le marché local par commune (``app_private.commune_market_trends``) après l'import DVF.

L'agrégat alimente les critères de marché de la règle de pépite ``pepite-v1.2`` (migration 20261109130100) : ventes
sur 12 mois, prix médian au m² de l'année la plus récente et de trois ans plus tôt, par commune et type de logement.
Il est recalculé par ``app_private.refresh_commune_market_trends()`` depuis ``dvf_transactions``.

Appelé par le workflow manuel « Immojudis DVF Import » (``.github/workflows/dvf-import.yml``), à la suite de l'import :
aucune planification n'est créée. Sans la migration (fonction absente), le recalcul est ignoré avec un avertissement :
la règle traite alors l'absence d'agrégat comme « pas de donnée, pas d'exclusion ».
"""

from __future__ import annotations

import argparse
import logging
from typing import Any

from src.config import load_settings
from src.storage.supabase_client import connect

# Alias de compatibilité : des tests patchent ce nom de module.
_postgres_connect = connect

LOGGER = logging.getLogger(__name__)

# Le délai de la requête en cours est déjà armé quand la fonction le règle elle-même : on le pose avant l'appel
# (``set local`` : il prend fin avec la transaction). Le recalcul prend quelques secondes avec l'index de la
# migration 20261109130000, plus sans lui (table remplacée par l'import DVF).
STATEMENT_TIMEOUT_SQL = "set local statement_timeout = '10min'"
REFRESH_SQL = "select app_private.refresh_commune_market_trends()"
UNDEFINED_FUNCTION_SQLSTATE = "42883"


def refresh_commune_market_trends(connection: Any) -> int | None:
    """Recalcule l'agrégat ; rend le nombre de lignes écrites, ou ``None`` si la fonction n'existe pas encore."""
    try:
        with connection.transaction():
            connection.execute(STATEMENT_TIMEOUT_SQL)
            row = connection.execute(REFRESH_SQL).fetchone()
    except Exception as exc:  # noqa: BLE001 - seule la fonction absente est tolérée
        if getattr(exc, "sqlstate", None) == UNDEFINED_FUNCTION_SQLSTATE:
            LOGGER.warning("Commune market trends refresh skipped: the function is not migrated yet (%s).", exc)
            return None
        raise
    return int(row[0]) if row and row[0] is not None else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recalcule le marché local par commune (règle de pépite pepite-v1.2) après l'import DVF."
    )
    return parser.parse_args()


def main() -> int:
    parse_args()
    db_url = load_settings().get("supabase_db_url")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to refresh the commune market trends.")
    with _postgres_connect(str(db_url)) as connection:
        written = refresh_commune_market_trends(connection)
    if written is None:
        print("::warning::Commune market trends were not refreshed: apply the migration 20261109130100 first.")
        return 0
    print("Commune market trends refresh summary")
    print(f"- rows: {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
