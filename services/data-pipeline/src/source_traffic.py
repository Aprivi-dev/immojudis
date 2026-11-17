"""Un seul processus à la fois envoie des requêtes aux sites des annonces (relecture du 17/11/2026, point M4).

Depuis la voie d'enrichissement séparée, la file tourne à côté des collectes. Le verrou des écritures du catalogue
sépare leurs écritures, pas leur trafic : une passe d'historique Licitor démarrée juste avant une collecte Licitor,
ou la copie des photos d'une collecte pendant que le travailleur relit des fiches, interrogeraient le même site en
même temps. Ce verrou consultatif de session, ``SOURCE_TRAFFIC_LOCK_NAME``, est le tour de parole vers les sources :

* une collecte planifiée le prend avant de démarrer et le garde jusqu'à la fin de ses écritures
  (``src.autonomous_runner``) ; la copie de ses photos le prend à son tour (``python -m src.source_traffic``) ;
* l'unité d'enrichissement le prend autour de chaque passe facultative qui contacte un hôte extérieur ;
* le travailleur de la file le prend pour chaque lot, sans attendre (``SourceTrafficTurns.try_take``), et cède la
  place dès qu'un autre le tient ou l'attend.

L'attente est celle de PostgreSQL (``pg_advisory_lock`` borné par ``lock_timeout``) : les demandes sont servies
dans l'ordre, et une demande qui attend fait échouer la prise sans attente du travailleur (une demande en conflit
avec une attente ne passe pas devant elle). Le travailleur ne peut donc pas affamer une collecte.

Une connexion de session est nécessaire (``catalogue_lock.session_lock_url``) ; un battement garde la session
ouverte. Sans base (exécution locale, tests), le tour est toujours accordé.

Modes (voie parallèle, 17/11/2026) : les travailleurs de la voie prennent le tour en partage
(``PIPELINE_WORKER_LOCK_MODE``, ``src.enrichment_lane_settings``) : ils parlent aux sources côte à côte, chacun
attendant le tour de l'hôte qu'il interroge (``src.host_turn``). Tout le reste le prend en exclusif. Une demande
exclusive en attente fait échouer leurs prises partagées : ils cèdent la place comme avant.
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from src.catalogue_lock import EXCLUSIVE, LOCK_HEARTBEAT_SECONDS, lock_sql, session_lock_url
from src.config import load_settings

LOGGER = logging.getLogger(__name__)

SOURCE_TRAFFIC_LOCK_NAME = "immojudis:source-traffic:v1"
_TRY_LOCK_SQL, _LOCK_SQL, _UNLOCK_SQL = lock_sql(EXCLUSIVE)


def _default_connect(url: str) -> Any:
    from src.storage.supabase_client import connect

    return connect(url)


def _heartbeat(connection: Any, stop: threading.Event) -> None:
    while not stop.wait(LOCK_HEARTBEAT_SECONDS):
        try:
            connection.execute("select 1")
        except Exception:  # noqa: BLE001 - la session perdue rend le tour ; rien d'autre à faire ici
            LOGGER.warning("Source traffic lock heartbeat failed; the turn may have been released")
            return


@contextmanager
def source_traffic_turn(
    db_url: str, *, label: str, wait_seconds: float, connect: Callable[[str], Any] | None = None
) -> Iterator[bool]:
    """Tient le tour de parole vers les sources pendant le bloc ; rend False (sans le tour) après ``wait_seconds``."""
    if not db_url:
        yield True
        return
    connection = (connect or _default_connect)(session_lock_url(db_url))
    connection.autocommit = True
    stop = threading.Event()
    try:
        connection.execute(f"set lock_timeout = '{max(1, int(wait_seconds * 1000))}ms'")
        try:
            connection.execute(_LOCK_SQL, (SOURCE_TRAFFIC_LOCK_NAME,))
        except Exception as exc:  # noqa: BLE001 - lock_timeout (55P03) : le tour n'est pas venu
            if getattr(exc, "sqlstate", None) != "55P03":
                raise
            print(f"Source traffic turn not obtained within {wait_seconds:g} s; {label} does not run.", flush=True)
            yield False
            return
        threading.Thread(target=_heartbeat, args=(connection, stop), daemon=True).start()
        try:
            yield True
        finally:
            stop.set()
            try:
                connection.execute(_UNLOCK_SQL, (SOURCE_TRAFFIC_LOCK_NAME,))
            except Exception:  # noqa: BLE001 - fermer la session rend le tour de toute façon
                LOGGER.warning("Could not release the source traffic turn explicitly")
    finally:
        stop.set()
        try:
            connection.close()
        except Exception:  # noqa: BLE001
            pass


class SourceTrafficTurns:
    """Le tour du travailleur de la file, pris lot par lot sans attendre et rendu avant le lot suivant.

    ``mode`` : ``exclusive`` (travailleur unique) ou ``shared`` (travailleurs de la voie parallèle).
    """

    def __init__(self, db_url: str, *, connect: Callable[[str], Any] | None = None, mode: str = EXCLUSIVE) -> None:
        self._db_url = db_url
        self._connect = connect or _default_connect
        self._try_sql, _, self._unlock_sql = lock_sql(mode)
        self._connection: Any = None
        self._held = False

    def try_take(self) -> bool:
        """Rend le tour du lot précédent, puis le reprend si personne d'autre ne le tient ni ne l'attend."""
        if not self._db_url:
            return True
        if self._connection is None:
            self._connection = self._connect(session_lock_url(self._db_url))
            self._connection.autocommit = True
        if self._held:
            self._connection.execute(self._unlock_sql, (SOURCE_TRAFFIC_LOCK_NAME,))
            self._held = False
        row = self._connection.execute(self._try_sql, (SOURCE_TRAFFIC_LOCK_NAME,)).fetchone()
        self._held = bool(row and row[0])
        return self._held


def main(argv: list[str] | None = None) -> int:
    """``python -m src.source_traffic --wait-seconds N -- commande…`` : lance la commande pendant le tour."""
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("--wait-seconds", type=float, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args(argv)
    command = [part for part in arguments.command if part != "--"]
    if not command:
        parser.error("a command is required after --")
    db_url = str(load_settings().get("supabase_db_url") or "")
    with source_traffic_turn(db_url, label=" ".join(command), wait_seconds=arguments.wait_seconds) as turn:
        if not turn:
            print(f"::warning title=Tour des sources non obtenu::{' '.join(command)} reportée au passage suivant")
            return 0
        return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
