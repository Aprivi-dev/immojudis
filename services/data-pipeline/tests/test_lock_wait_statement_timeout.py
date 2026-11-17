"""Une attente de verrou consultatif n'est jamais coupée par le ``statement_timeout`` de sa session (17/11/2026).

Défaut observé en production : l'unité d'enrichissement attendait le tour des sources derrière une collecte de
13 minutes ; le ``statement_timeout`` de 2 minutes de sa session (``supabase_client.connect``) a annulé
``pg_advisory_lock`` (57014) et l'unité est morte. Ici, sur un vrai PostgreSQL, chaque session de verrou a un
``statement_timeout`` d'une seconde et un autre processus tient le verrou plus longtemps.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from src import catalogue_lock, source_traffic
from src.catalogue_lock import CATALOGUE_WRITER_LOCK_NAME, CatalogueLockTimeout, catalogue_writer_lock
from src.host_turn import TURN_KEY_PREFIX, HostTurns, HostTurnWaitExceeded
from src.storage.supabase_client import connect as connect_postgres

# Pris à l'import, avant la fixture automatique de conftest qui accorde le tour d'emblée.
REAL_TURN = source_traffic.source_traffic_turn
SHORT_STATEMENT_TIMEOUT_MS = 1000
HOLD_SECONDS = 2.5


@pytest.fixture
def database_url() -> str:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    host = str(conninfo_to_dict(url).get("host") or "").split(",", 1)[0]
    if host not in {"127.0.0.1", "localhost"}:
        pytest.fail(f"Refusing non-local lock test database: {host}")
    return url


class ShortTimeoutSessions:
    """Les sessions de verrou, ouvertes comme en production mais avec un ``statement_timeout`` d'une seconde."""

    def __init__(self) -> None:
        self.opened: list[Any] = []

    def __call__(self, url: str) -> Any:
        connection = connect_postgres(url, statement_timeout_ms=SHORT_STATEMENT_TIMEOUT_MS, retry_delays=())
        self.opened.append(connection)
        return connection

    @staticmethod
    def statement_timeout(connection: Any) -> str:
        return str(connection.execute("show statement_timeout").fetchone()[0])


@contextmanager
def held_elsewhere(url: str, key: str, *, seconds: float | None, shared: bool = False) -> Iterator[None]:
    """Un autre processus tient ``key`` ; il le rend après ``seconds`` (None : à la sortie du bloc)."""
    suffix = "_shared" if shared else ""
    holder = psycopg.connect(url, autocommit=True)
    holder.execute(f"select pg_advisory_lock{suffix}(hashtextextended(%s, 0))", (key,))
    lock = threading.Lock()

    def release() -> None:
        with lock:
            if not holder.closed:
                holder.close()  # la fin de la session rend le verrou

    timer = threading.Timer(seconds, release) if seconds is not None else None
    if timer is not None:
        timer.start()
    try:
        yield
    finally:
        if timer is not None:
            timer.cancel()
        release()


def test_before_the_fix_a_short_statement_timeout_cancels_a_long_lock_wait(database_url) -> None:
    """Le défaut : ``lock_timeout`` long, ``statement_timeout`` court, le second coupe l'attente (57014)."""
    sessions = ShortTimeoutSessions()
    connection = sessions(database_url)
    try:
        with held_elsewhere(database_url, source_traffic.SOURCE_TRAFFIC_LOCK_NAME, seconds=None):
            connection.execute("set lock_timeout = '10000ms'")
            started = time.monotonic()
            with pytest.raises(psycopg.errors.QueryCanceled) as raised:
                connection.execute(
                    "select pg_advisory_lock(hashtextextended(%s, 0))", (source_traffic.SOURCE_TRAFFIC_LOCK_NAME,)
                )
            assert raised.value.sqlstate == "57014"
            assert time.monotonic() - started < 5
    finally:
        connection.close()


# --- Tour des sources -----------------------------------------------------------------------------------------


def test_the_source_turn_waits_past_the_statement_timeout_and_gets_the_turn(database_url) -> None:
    sessions = ShortTimeoutSessions()
    with held_elsewhere(database_url, source_traffic.SOURCE_TRAFFIC_LOCK_NAME, seconds=HOLD_SECONDS):
        started = time.monotonic()
        with REAL_TURN(database_url, label="enrichment unit", wait_seconds=30, connect=sessions) as granted:
            waited = time.monotonic() - started
            assert granted is True
            # Pendant le tour, la session a retrouvé son garde-fou : seul l'appel du verrou en est dispensé.
            assert sessions.statement_timeout(sessions.opened[0]) == "1s"
    assert waited >= HOLD_SECONDS - 0.5


def test_the_source_turn_returns_false_at_its_lock_timeout_not_at_the_statement_timeout(database_url) -> None:
    sessions = ShortTimeoutSessions()
    with held_elsewhere(database_url, source_traffic.SOURCE_TRAFFIC_LOCK_NAME, seconds=None):
        started = time.monotonic()
        with REAL_TURN(database_url, label="pass", wait_seconds=2.0, connect=sessions) as granted:
            assert granted is False
        waited = time.monotonic() - started
    assert 1.8 <= waited < 6


# --- Verrou des écritures du catalogue --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["exclusive", "shared"])
def test_the_catalogue_lock_waits_past_the_statement_timeout_in_both_modes(database_url, mode) -> None:
    sessions = ShortTimeoutSessions()
    with held_elsewhere(database_url, CATALOGUE_WRITER_LOCK_NAME, seconds=HOLD_SECONDS):
        started = time.monotonic()
        # Une seule tranche d'attente (poll_seconds) plus longue que le statement_timeout.
        with catalogue_writer_lock(database_url, label=mode, wait_seconds=30, poll_seconds=10,
                                   heartbeat_seconds=0, connect=sessions, mode=mode):
            waited = time.monotonic() - started
            assert sessions.statement_timeout(sessions.opened[0]) == "1s"
    assert waited >= HOLD_SECONDS - 0.5


@pytest.mark.parametrize("mode", ["exclusive", "shared"])
def test_the_catalogue_lock_gives_up_at_its_wait_not_at_the_statement_timeout(database_url, mode) -> None:
    sessions = ShortTimeoutSessions()
    with held_elsewhere(database_url, CATALOGUE_WRITER_LOCK_NAME, seconds=None):
        started = time.monotonic()
        with pytest.raises(CatalogueLockTimeout):
            with catalogue_writer_lock(database_url, label=mode, wait_seconds=2.0, poll_seconds=10,
                                       heartbeat_seconds=0, connect=sessions, mode=mode):
                pytest.fail("the lock is held elsewhere")
        waited = time.monotonic() - started
    assert 1.8 <= waited < 6
    assert sessions.opened[0].closed


def test_a_waiting_exclusive_request_stays_queued_past_the_statement_timeout(database_url) -> None:
    """Une collecte qui attend reste en file au-delà du délai : aucune prise partagée ne la double entre-temps."""
    sessions = ShortTimeoutSessions()
    obtained: dict[str, float] = {}

    def collection() -> None:
        with catalogue_writer_lock(database_url, label="collection", wait_seconds=30, poll_seconds=20,
                                   heartbeat_seconds=0, connect=sessions):
            obtained["at"] = time.monotonic()

    with held_elsewhere(database_url, CATALOGUE_WRITER_LOCK_NAME, seconds=None, shared=True):
        waiter = threading.Thread(target=collection)
        waiter.start()
        time.sleep(SHORT_STATEMENT_TIMEOUT_MS / 1000 + 1.0)  # past the waiter's statement_timeout
        probe = psycopg.connect(database_url, autocommit=True)
        try:
            row = probe.execute(catalogue_lock.lock_sql("shared")[0], (CATALOGUE_WRITER_LOCK_NAME,)).fetchone()
            assert row == (False,)  # the queued exclusive request still blocks new shared ones
        finally:
            probe.close()
        assert "at" not in obtained
        released_at = time.monotonic()
    waiter.join(timeout=15)
    assert obtained["at"] >= released_at


# --- Tour par hôte ----------------------------------------------------------------------------------------------


def test_a_host_turn_wait_is_made_of_short_tries_that_the_statement_timeout_never_cuts(database_url) -> None:
    sessions = ShortTimeoutSessions()
    turns = HostTurns(database_url, connect=sessions, poll_seconds=0.1)
    try:
        with held_elsewhere(database_url, TURN_KEY_PREFIX + "licitor.com", seconds=HOLD_SECONDS):
            started = time.monotonic()
            turns.acquire("licitor.com", max_wait=30)
            waited = time.monotonic() - started
        assert waited >= HOLD_SECONDS - 0.5
        assert turns.held_hosts() == ["licitor.com"]
        assert sessions.statement_timeout(sessions.opened[0]) == "1s"  # never lifted on this session

        with held_elsewhere(database_url, TURN_KEY_PREFIX + "agorastore.fr", seconds=None):
            started = time.monotonic()
            with pytest.raises(HostTurnWaitExceeded):
                turns.acquire("agorastore.fr", max_wait=2.0)
            assert 1.8 <= time.monotonic() - started < 6
    finally:
        turns._drop_connection()
