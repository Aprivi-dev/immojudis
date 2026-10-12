"""Collecte automatique de l'historique des adjudications Licitor.

Lancée par le planificateur unique après chaque passage de la file
d'enrichissement (``autonomous_runner``) : un « tick » borné du collecteur
(au plus 100 requêtes, 2 s entre deux requêtes, robots.txt respecté), puis
l'attestation des nouveaux lots par la porte structurelle des statistiques.

La campagne mensuelle (fenêtre de 36 mois, résultats des 90 derniers jours
relus) est créée une fois par mois ; les ticks suivants la reprennent jusqu'à la
fin. La partie réseau tourne sous le rôle restreint ``licitor_collector``.
"""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Callable
from typing import Any

import psycopg

from src.sources.licitor_cloud import run_tick, start_monthly
from src.sources.licitor_cloud_store import CloudStore

LOGGER = logging.getLogger(__name__)
COLLECTOR_ROLE = "licitor_collector"
ATTEST_SQL = "select app_private.attest_licitor_reported_candidates()"


def _connect(db_url: str) -> psycopg.Connection:
    return psycopg.connect(
        db_url,
        autocommit=True,
        prepare_threshold=None,
        connect_timeout=10,
        options="-c statement_timeout=15000 -c lock_timeout=3000",
    )


def refresh(
    db_url: str,
    *,
    connect: Callable[[str], Any] = _connect,
    tick: Callable[[CloudStore], dict] = run_tick,
    start: Callable[[CloudStore], dict] = start_monthly,
) -> dict[str, object]:
    """One bounded refresh: make sure the month's campaign exists, run one tick, attest."""
    report: dict[str, object] = {}
    with connect(db_url) as connection:
        try:
            connection.execute(f"set role {COLLECTOR_ROLE}")
        except psycopg.Error as exc:
            return {"status": "collector_role_unavailable", "error": type(exc).__name__}
        try:
            store = CloudStore(connection)
            report["campaign"] = start(store).get("status")
            report["tick"] = tick(store)
        finally:
            # The session pooler hands the connection to someone else afterwards.
            connection.execute("reset role")
        # The attestation needs the main role: the collector cannot vouch for its own lots.
        attested = connection.execute(ATTEST_SQL).fetchone()
        report["attested"] = int(next(iter(attested.values())) if isinstance(attested, dict) else attested[0])
    report["status"] = "ok"
    return report


def main() -> int:
    from src.config import load_settings

    db_url = str(load_settings().get("supabase_db_url") or "")
    if not db_url:
        print(json.dumps({"status": "skipped", "reason": "SUPABASE_DB_URL is not set"}))
        return 0
    report = refresh(db_url)
    print(json.dumps(report, ensure_ascii=False, default=str))
    return 0 if report.get("status") == "ok" else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
