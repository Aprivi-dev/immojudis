"""Collecte automatique de l'historique des adjudications Licitor.

Lancée par le planificateur unique après chaque passage de la file
d'enrichissement (``autonomous_runner``) : un « tick » borné du collecteur
(au plus 100 requêtes, 2 s entre deux requêtes, robots.txt respecté), puis
l'attestation des nouveaux lots par la porte structurelle des statistiques.

La campagne mensuelle (fenêtre de 36 mois, résultats des 90 derniers jours
relus) est créée une fois par mois ; les ticks suivants la reprennent jusqu'à la
fin. La partie réseau tourne sous le rôle restreint ``licitor_collector``, posé
transaction par transaction (``set local role``) à cause du pooler.
"""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import psycopg

from src import source_withdrawal
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


class CollectorRoleConnection:
    """Run every statement under ``licitor_collector`` with ``set local role``.

    The pipeline reaches the database through Supabase's transaction pooler: a
    session-level ``set role`` stays on the pooled server connection and is
    handed to the next client (12/10/2026 incident: other collections got
    "permission denied"). A role set with ``set local`` ends with its
    transaction, so each statement outside an explicit transaction gets its own.
    """

    def __init__(self, connection: Any) -> None:
        self._connection = connection
        self._depth = 0

    @property
    def row_factory(self) -> Any:
        return self._connection.row_factory

    @row_factory.setter
    def row_factory(self, value: Any) -> None:
        self._connection.row_factory = value

    def execute(self, query: Any, params: Any = None) -> Any:
        if self._depth:
            return self._connection.execute(query, params)
        with self.transaction():
            return self._connection.execute(query, params)

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        with self._connection.transaction() as block:
            if not self._depth:
                self._connection.execute(f"set local role {COLLECTOR_ROLE}")
            self._depth += 1
            try:
                yield block
            finally:
                self._depth -= 1

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


def refresh(
    db_url: str,
    *,
    connect: Callable[[str], Any] = _connect,
    tick: Callable[[CloudStore], dict] = run_tick,
    start: Callable[[CloudStore], dict] = start_monthly,
) -> dict[str, object]:
    """One bounded refresh: make sure the month's campaign exists, run one tick, attest.

    Nothing is collected while the source is withdrawn from the catalogue (no licence): the refresh
    answers ``skipped`` before opening any connection to the collector.
    """
    if "licitor" in source_withdrawal.withdrawn_sources(db_url):
        return {"status": "skipped", "reason": "source_withdrawn"}
    report: dict[str, object] = {}
    with connect(db_url) as connection:
        collector = CollectorRoleConnection(connection)
        try:
            with collector.transaction():
                pass
        except psycopg.Error as exc:
            return {"status": "collector_role_unavailable", "error": type(exc).__name__}
        store = CloudStore(collector)
        report["campaign"] = start(store).get("status")
        report["tick"] = tick(store)
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
    return 0 if report.get("status") in {"ok", "skipped"} else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
