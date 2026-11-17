"""Tour de parole par hôte entre processus : jamais deux processus qui interrogent le même site en même temps.

La politesse d'un client (``PoliteHttpClient`` de ``src.sources.common``, ``DocumentPoliteness`` de
``src.document_politeness``) est en mémoire, par processus. Depuis que la voie d'enrichissement fait tourner
plusieurs processus en parallèle (``src.enrichment_lane_settings``), deux d'entre eux pourraient télécharger en même
temps sur le même hôte (pièces Licitor, ``cdn.agorastore.fr``, sites d'avocats…). Ce module est la seule règle qui
l'empêche ; les deux clients l'appellent autour de chaque requête (lecture de robots.txt comprise) :

* le tour d'un hôte est un verrou consultatif de session, clé ``immojudis:host-turn:v1:<hôte>`` (hôte en minuscules,
  sans ``www.`` ni point final : ``www.licitor.com`` et ``licitor.com`` sont le même site) ;
* il est tenu pendant la requête et ses reprises, puis rendu seulement une fois écoulé le délai du site (le plus long
  de notre délai et du ``Crawl-delay``, que l'appelant passe) : le processus suivant ne peut pas interroger le site
  plus tôt que nous ne l'aurions fait nous-mêmes. Le rendu est différé (fil d'arrière-plan) : le processus travaille
  ailleurs pendant ce temps (OCR, autre hôte) ;
* l'attente est bornée par l'échéance de la tâche (``deadline_remaining``) et par ``MAX_WAIT_SECONDS`` ; au-delà,
  ``HostTurnWaitExceeded`` : l'appelant remet la tâche en file sans consommer d'essai ;
* un processus qui meurt perd sa session et le serveur rend ses tours ; une session perdue en cours de route vide
  la table des tours tenus (ils sont rendus côté serveur).

Équité : les demandes ne bloquent pas la connexion (une seule par processus, ``pg_try_advisory_lock`` répété toutes
les ``POLL_SECONDS``). Un processus qui attend se signale en prenant en partage la clé d'attente
``immojudis:host-turn-wait:v1:<hôte>`` ; celui qui tient le tour et veut le garder pour une nouvelle requête vérifie
d'abord que personne n'attend (prise exclusive d'essai de cette clé), sinon il le rend à son échéance et se remet
dans l'attente, derrière.

Réglage ``PIPELINE_HOST_TURNS`` (``src.enrichment_lane_settings``) ; éteint, ou sans base, le tour est toujours
accordé et rien ne change.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from src.enrichment_lane_settings import host_turns_enabled

LOGGER = logging.getLogger(__name__)

TURN_KEY_PREFIX = "immojudis:host-turn:v1:"
WAIT_KEY_PREFIX = "immojudis:host-turn-wait:v1:"
POLL_SECONDS = 0.5
#: Attente la plus longue pour un tour, même quand l'échéance de la tâche est plus lointaine (ou absente).
MAX_WAIT_SECONDS = 180.0
#: Celui qui rend son tour à des processus qui attendent se remet en file un peu après eux.
YIELD_BACKOFF_SECONDS = 2 * POLL_SECONDS

_TRY_LOCK_SQL = "select pg_try_advisory_lock(hashtextextended(%s, 0))"
_UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended(%s, 0))"
_TRY_LOCK_SHARED_SQL = "select pg_try_advisory_lock_shared(hashtextextended(%s, 0))"
_UNLOCK_SHARED_SQL = "select pg_advisory_unlock_shared(hashtextextended(%s, 0))"


class HostTurnWaitExceeded(RuntimeError):
    """Le tour de cet hôte n'est pas venu à temps : la tâche est remise en file, sans consommer d'essai."""

    def __init__(self, host: str, waited: float, *, deadline_reached: bool) -> None:
        super().__init__(f"Host turn for {host} not obtained after {waited:.0f} s")
        self.host = host
        self.waited = waited
        self.deadline_reached = deadline_reached


def host_of(url_or_host: str) -> str | None:
    """Hôte normalisé d'une adresse ou d'un nom d'hôte ; ``None`` sans hôte."""
    text = str(url_or_host or "").strip()
    host = urlparse(text).hostname if "://" in text else text.split("/", 1)[0].split(":", 1)[0]
    host = (host or "").strip().rstrip(".").lower()
    if host.startswith("www."):
        host = host[4:]
    return host or None


@dataclass
class _Held:
    users: int = 0
    release_at: float = 0.0
    yielding: bool = False
    since: float = field(default_factory=time.monotonic)


@dataclass
class HostTurnStats:
    """Ce que le processus a attendu, pour le compte rendu du travailleur."""

    waits: int = 0
    wait_seconds: float = 0.0
    timeouts: int = 0
    by_host: dict[str, float] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        slowest = sorted(self.by_host.items(), key=lambda item: item[1], reverse=True)[:5]
        return {
            "waits": self.waits,
            "wait_seconds": round(self.wait_seconds, 1),
            "timeouts": self.timeouts,
            "slowest_hosts": {host: round(seconds, 1) for host, seconds in slowest},
        }


class HostTurns:
    """Les tours tenus par ce processus, sur une seule connexion de session (``catalogue_lock.session_lock_url``)."""

    def __init__(
        self,
        db_url: str,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        poll_seconds: float = POLL_SECONDS,
    ) -> None:
        self._db_url = db_url
        self._connect = connect
        self._clock = clock
        self._sleep = sleep
        self._poll = poll_seconds
        self._connection: Any = None
        self._db = threading.Lock()
        self._state = threading.Condition()
        self._held: dict[str, _Held] = {}
        # Hôtes rendus à des processus qui attendaient : pas de nouvelle demande avant cette heure.
        self._backoff_until: dict[str, float] = {}
        self._releaser: threading.Thread | None = None
        self.stats = HostTurnStats()

    # -- connexion ---------------------------------------------------------------------------------------------

    def _execute(self, sql: str, key: str) -> bool:
        with self._db:
            if self._connection is None:
                from src.catalogue_lock import session_lock_url

                connect = self._connect
                if connect is None:
                    from src.storage.supabase_client import connect as connect_postgres

                    def connect(url: str) -> Any:
                        return connect_postgres(url, connect_timeout=10, retry_delays=(1.0,))

                self._connection = connect(session_lock_url(self._db_url))
                self._connection.autocommit = True
            try:
                row = self._connection.execute(sql, (key,)).fetchone()
            except Exception:
                # Session perdue : le serveur a rendu tous ses verrous. Rien n'est plus tenu ici.
                self._drop_connection()
                raise
        return bool(row and row[0])

    def _drop_connection(self) -> None:
        connection, self._connection = self._connection, None
        with self._state:
            if self._held:
                LOGGER.warning("Host turn session lost: %s turn(s) released by the server", len(self._held))
            self._held.clear()
            self._state.notify_all()
        try:
            if connection is not None:
                connection.close()
        except Exception:  # noqa: BLE001 - une session perdue ne se ferme pas proprement ; le serveur l'a rendue
            pass

    # -- prise et rendu ----------------------------------------------------------------------------------------

    def _others_waiting(self, host: str) -> bool:
        key = WAIT_KEY_PREFIX + host
        if self._execute(_TRY_LOCK_SQL, key):
            self._execute(_UNLOCK_SQL, key)
            return False
        return True

    def acquire(self, host: str, *, max_wait: float) -> None:
        started = self._clock()
        with self._state:
            held = self._held.get(host)
            reuse = held is not None and not held.yielding
        if reuse and not self._others_waiting(host):
            with self._state:
                held = self._held.get(host)
                if held is not None and not held.yielding:
                    held.users += 1
                    return
        with self._state:
            if host in self._held:
                # D'autres attendent : le tour leur revient à son échéance, nous repassons derrière eux.
                self._held[host].yielding = True
                self._state.notify_all()
        wait_key = WAIT_KEY_PREFIX + host
        announced = False
        try:
            while True:
                with self._state:
                    blocked = host in self._held or self._clock() < self._backoff_until.get(host, float("-inf"))
                if not blocked:
                    if self._execute(_TRY_LOCK_SQL, TURN_KEY_PREFIX + host):
                        with self._state:
                            self._held[host] = _Held(users=1)
                            self._backoff_until.pop(host, None)
                        break
                    if not announced:
                        announced = self._execute(_TRY_LOCK_SHARED_SQL, wait_key)
                waited = self._clock() - started
                if waited >= max_wait:
                    self.stats.timeouts += 1
                    raise HostTurnWaitExceeded(host, waited, deadline_reached=True)
                self._sleep(min(self._poll, max(0.0, max_wait - waited)))
        finally:
            if announced:
                try:
                    self._execute(_UNLOCK_SHARED_SQL, wait_key)
                except Exception:  # noqa: BLE001 - session perdue : la clé d'attente est rendue avec elle
                    pass
        waited = self._clock() - started
        if waited > self._poll:
            self.stats.waits += 1
            self.stats.wait_seconds += waited
            self.stats.by_host[host] = self.stats.by_host.get(host, 0.0) + waited

    def release(self, host: str, *, delay_seconds: float) -> None:
        with self._state:
            held = self._held.get(host)
            if held is None:
                return
            held.users = max(0, held.users - 1)
            held.release_at = max(held.release_at, self._clock() + max(0.0, float(delay_seconds)))
            self._state.notify_all()
            if self._releaser is None or not self._releaser.is_alive():
                self._releaser = threading.Thread(target=self._release_due, name="host-turn-releaser", daemon=True)
                self._releaser.start()

    def release_due_now(self) -> None:
        """Rend les tours dont le délai est écoulé (fil d'arrière-plan, et tests)."""
        while True:
            with self._state:
                now = self._clock()
                due = [host for host, held in self._held.items() if held.users == 0 and held.release_at <= now]
            if not due:
                return
            for host in due:
                try:
                    self._execute(_UNLOCK_SQL, TURN_KEY_PREFIX + host)
                except Exception:  # noqa: BLE001 - session perdue : le tour est rendu par le serveur
                    LOGGER.warning("Host turn for %s could not be released explicitly", host)
                with self._state:
                    held = self._held.get(host)
                    if held is not None and held.users == 0:
                        del self._held[host]
                        if held.yielding:
                            self._backoff_until[host] = self._clock() + YIELD_BACKOFF_SECONDS
                    self._state.notify_all()

    def _release_due(self) -> None:
        while True:
            self.release_due_now()
            with self._state:
                idle = [held.release_at for held in self._held.values() if held.users == 0]
                if not self._held:
                    self._releaser = None
                    return
                pause = max(0.05, min(idle) - self._clock()) if idle else 1.0
                self._state.wait(timeout=min(pause, 1.0))

    def held_hosts(self) -> list[str]:
        with self._state:
            return sorted(self._held)


_TURNS: dict[str, HostTurns] = {}
_TURNS_LOCK = threading.Lock()


def _process_turns() -> HostTurns | None:
    if not host_turns_enabled():
        return None
    from src.config import load_settings

    db_url = str(load_settings().get("supabase_db_url") or "")
    if not db_url:
        return None
    with _TURNS_LOCK:
        turns = _TURNS.get(db_url)
        if turns is None:
            turns = _TURNS[db_url] = HostTurns(db_url)
        return turns


def process_stats() -> dict[str, Any] | None:
    """Attentes de tour de ce processus (``None`` quand les tours sont éteints ou n'ont jamais servi)."""
    with _TURNS_LOCK:
        turns = next(iter(_TURNS.values()), None)
    return turns.stats.to_json() if turns is not None else None


@contextmanager
def host_turn(
    url_or_host: str,
    *,
    delay_seconds: float,
    deadline_remaining: Callable[[], float | None] = lambda: None,
    turns: HostTurns | None = None,
) -> Iterator[None]:
    """Tient le tour de l'hôte de ``url_or_host`` pendant le bloc, puis le rend ``delay_seconds`` après sa fin.

    ``deadline_remaining`` : secondes avant l'échéance de la tâche (``None`` : aucune). L'attente s'arrête à
    l'échéance ou après ``MAX_WAIT_SECONDS`` avec ``HostTurnWaitExceeded`` (``deadline_reached`` dit si c'est
    l'échéance). Tours éteints, sans base ou sans hôte : le bloc s'exécute tout de suite.
    """
    active = turns if turns is not None else _process_turns()
    host = host_of(url_or_host)
    if active is None or host is None:
        yield
        return
    remaining = deadline_remaining()
    max_wait = MAX_WAIT_SECONDS if remaining is None else max(0.0, min(MAX_WAIT_SECONDS, remaining))
    try:
        active.acquire(host, max_wait=max_wait)
    except HostTurnWaitExceeded as exc:
        exc.deadline_reached = remaining is not None and remaining <= MAX_WAIT_SECONDS
        raise
    except Exception as exc:
        # Base injoignable : sans tour, pas de requête (une requête de trop vaut moins qu'une tâche remise en file).
        LOGGER.warning("Host turn for %s unavailable (%s): the request is not sent", host, type(exc).__name__)
        raise HostTurnWaitExceeded(host, 0.0, deadline_reached=False) from exc
    try:
        yield
    finally:
        active.release(host, delay_seconds=delay_seconds)
