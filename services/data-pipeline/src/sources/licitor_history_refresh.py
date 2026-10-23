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

import argparse
import json
import logging
import sys
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Any

import psycopg

from src import source_withdrawal
from src.sources.licitor_cloud import run_tick, start_monthly
from src.sources.licitor_cloud_store import CloudStore

LOGGER = logging.getLogger(__name__)
COLLECTOR_ROLE = "licitor_collector"
ATTEST_SQL = "select app_private.attest_licitor_reported_candidates()"
# Copy of the attested lots read by the « Scénarios d'enchères » (migration 20261031100800): forced
# when lots were attested, otherwise refreshed at most once a day (the quality flags of known lots and
# the court mapping can change without a new attestation).
SCENARIO_SNAPSHOT_SQL = "select app_private.refresh_auction_scenario_observations(%s)"
SNAPSHOT_AGE_SQL = (
    "select extract(epoch from (statement_timestamp() - refreshed_at))"
    " from app_private.auction_scenario_snapshot_state"
)
# The copy takes 3.5 to 6 s on the production data; the connection's 15 s ceiling is too tight when
# the database is busy, so the refresh alone gets 60 s (``set local``: it ends with the transaction).
SNAPSHOT_STATEMENT_TIMEOUT = "set local statement_timeout = '60s'"
# A copy older than this is forced whatever the attestation said: a forced refresh that failed
# (timeout, killed run) is caught up by the next run instead of waiting for new lots.
SNAPSHOT_MAX_AGE_SECONDS = 24 * 3600


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


def _first_value(row: Any) -> Any:
    if row is None:
        return None
    return next(iter(row.values())) if isinstance(row, dict) else row[0]


def _snapshot_is_stale(connection: Any) -> bool:
    """True when the copy is missing or older than ``SNAPSHOT_MAX_AGE_SECONDS`` (unreadable: not stale)."""
    try:
        age = _first_value(connection.execute(SNAPSHOT_AGE_SQL).fetchone())
    except psycopg.Error as exc:
        LOGGER.warning("Scenario snapshot age unreadable: %s", exc)
        return False
    return age is None or float(age) > SNAPSHOT_MAX_AGE_SECONDS


def _refresh_scenario_snapshot(connection: Any, *, force: bool) -> dict[str, object]:
    """Refresh the scenarios' copy of the lots; a failure keeps the previous copy and is reported.

    ``refused`` is the database declining to replace the copy by a much smaller one (the guard of
    ``refresh_auction_scenario_observations``); any other database error is ``error``.
    """
    try:
        with connection.transaction():
            connection.execute(SNAPSHOT_STATEMENT_TIMEOUT)
            row = connection.execute(SCENARIO_SNAPSHOT_SQL, (force,)).fetchone()
    except psycopg.errors.ObjectNotInPrerequisiteState as exc:
        LOGGER.warning("Scenario snapshot refresh refused: %s", exc)
        return {"status": "refused", "error": type(exc).__name__}
    except psycopg.Error as exc:
        LOGGER.warning("Scenario snapshot refresh failed: %s", exc)
        return {"status": "error", "error": type(exc).__name__}
    copied = _first_value(row)
    return {"status": "skipped"} if copied is None else {"status": "refreshed", "lots": int(copied)}


def _attest_and_refresh_snapshot(connection: Any, report: dict[str, object]) -> None:
    """Attest the new lots, then refresh the scenarios' copy. Never raises a database error.

    Runs in a ``finally``: the lots collected before a failing tick are still attested and copied,
    and an error here must not hide the one already propagating.
    """
    attested = 0
    try:
        # The attestation needs the main role: the collector cannot vouch for its own lots.
        attested = int(_first_value(connection.execute(ATTEST_SQL).fetchone()) or 0)
        report["attested"] = attested
    except psycopg.Error as exc:
        LOGGER.warning("Attestation failed: %s", exc)
        report["attested"] = {"status": "error", "error": type(exc).__name__}
    force = attested > 0 or _snapshot_is_stale(connection)
    report["scenario_snapshot"] = _refresh_scenario_snapshot(connection, force=force)


def _final_status(report: dict[str, object]) -> str:
    """``ok`` only when the attestation and the copy both went through (or the copy was fresh)."""
    if isinstance(report.get("attested"), dict):
        return "attestation_error"
    snapshot = report.get("scenario_snapshot")
    if isinstance(snapshot, dict) and snapshot.get("status") in {"error", "refused"}:
        return f"snapshot_{snapshot['status']}"
    return "ok"


def refresh(
    db_url: str,
    *,
    connect: Callable[[str], Any] = _connect,
    tick: Callable[[CloudStore], dict] = run_tick,
    start: Callable[[CloudStore], dict] = start_monthly,
) -> dict[str, object]:
    """One bounded refresh: make sure the month's campaign exists, run one tick, attest.

    Licitor is collected normally. Only when the withdrawal switch is set for it
    (``public.set_catalogue_source_withdrawal``, not the case today) does the refresh answer
    ``skipped`` before opening any connection to the collector.
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
        try:
            report["campaign"] = start(store).get("status")
            report["tick"] = tick(store)
        finally:
            # Also when the tick raised: the lots it collected before failing do not wait for the
            # next run to reach the scenarios' copy.
            _attest_and_refresh_snapshot(connection, report)
    report["status"] = _final_status(report)
    return report


def refresh_snapshot_only(db_url: str, *, connect: Callable[[str], Any] = _connect) -> dict[str, object]:
    """Refresh the scenarios' copy alone: the tick used up its budget and was stopped."""
    report: dict[str, object] = {}
    with connect(db_url) as connection:
        report["scenario_snapshot"] = _refresh_scenario_snapshot(
            connection, force=_snapshot_is_stale(connection)
        )
    report["status"] = _final_status(report)
    return report


def main(argv: Sequence[str] = ()) -> int:
    from src.config import load_settings

    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-only", action="store_true")
    arguments = parser.parse_args(list(argv))
    db_url = str(load_settings().get("supabase_db_url") or "")
    if not db_url:
        print(json.dumps({"status": "skipped", "reason": "SUPABASE_DB_URL is not set"}))
        return 0
    report = refresh_snapshot_only(db_url) if arguments.snapshot_only else refresh(db_url)
    print(json.dumps(report, ensure_ascii=False, default=str))
    return 0 if report.get("status") in {"ok", "skipped"} else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main(sys.argv[1:]))
