"""Application-level lock shared by every job that writes the sale catalogue.

GitHub concurrency groups only order runs of the same group, and a pending run
is cancelled when a newer one joins its group. The scheduled pipeline and the
manual recompute therefore use separate groups and serialise on this
PostgreSQL advisory lock instead: the second one waits for the first.

The lock is session-scoped (``pg_try_advisory_lock``), so it is held by one
dedicated connection for the whole run and released when it closes. It needs a
direct or session-pooled connection; behind a transaction pooler the session
is not stable and the lock would not hold. ``session_lock_url`` therefore moves
a Supabase pooler URL (``*.pooler.supabase.com``) to its session port 5432 and
refuses the transaction port 6543 on any other host.

A heartbeat keeps the idle lock session alive. If it fails, the lock may be
gone: the handle yielded by ``catalogue_writer_lock`` is marked lost. These
checks then stop the writer with ``CatalogueLockLost``:

* ``src.main``: before the early and the final publication
  (``ensure_catalogue_lock_held``); a progressive publication is skipped
  (``catalogue_lock_lost``);
* ``src.document_backlog``: ``drain_sale`` before each pass and each projection
  rewrite, and the run after each sale (``ensure_held``);
* ``src.queued_runner``: ``run_enrichment_queue_batch`` before each claimed
  batch (``ensure_catalogue_lock_held``, since 14/11/2026); the queue worker
  (``python -m src.queued_runner``) then exits with ``LOCK_LOST_EXIT_CODE``.

In the document backlog, a pass it runs can still write its checkpoint or its
sale after a heartbeat failure that happens during that pass; the drain stops
right after. Likewise, a batch the queue worker already claimed runs to its end.

Modes (17/11/2026, parallel enrichment lane): the lock is ``exclusive`` by
default. The queue workers of the lane take it ``shared``
(``PIPELINE_WORKER_LOCK_MODE``, ``src.enrichment_lane_settings``), so that
several of them write side by side (each sale write is still serialised by the
publication transaction lock and its version guard), while every other writer
(collections, recompute, document backlog, anonymisation, positions...) keeps
it exclusive and waits for all of them. A waiting request is queued by
PostgreSQL (``pg_advisory_lock`` bounded by ``lock_timeout``), and a new shared
request conflicts with a queued exclusive one: the workers can never starve a
collection.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from src.config import DirectDatabaseMissing, in_github_actions, load_settings, supabase_configured

LOGGER = logging.getLogger(__name__)

CATALOGUE_WRITER_LOCK_NAME = "immojudis:catalogue-writer:v1"
DEFAULT_LOCK_WAIT_SECONDS = 3300
LOCK_POLL_SECONDS = 15.0
LOCK_HEARTBEAT_SECONDS = 60.0
LOCK_WAIT_ENV = "PIPELINE_LOCK_WAIT_SECONDS"

#: Supavisor, the Supabase pooler: port 5432 is session mode, port 6543 transaction mode.
SUPABASE_POOLER_HOST_SUFFIX = ".pooler.supabase.com"
SESSION_POOLER_PORT = "5432"
TRANSACTION_POOLER_PORT = "6543"
#: Exit code of a writer that stopped because its lock was lost (any non-zero code fails the job).
LOCK_LOST_EXIT_CODE = 1

EXCLUSIVE = "exclusive"
SHARED = "shared"
#: (first non-blocking attempt, queued wait, release) per mode.
_LOCK_SQL = {
    EXCLUSIVE: (
        "select pg_try_advisory_lock(hashtextextended(%s, 0))",
        "select pg_advisory_lock(hashtextextended(%s, 0))",
        "select pg_advisory_unlock(hashtextextended(%s, 0))",
    ),
    SHARED: (
        "select pg_try_advisory_lock_shared(hashtextextended(%s, 0))",
        "select pg_advisory_lock_shared(hashtextextended(%s, 0))",
        "select pg_advisory_unlock_shared(hashtextextended(%s, 0))",
    ),
}
_TRY_LOCK_SQL, _WAIT_LOCK_SQL, _UNLOCK_SQL = _LOCK_SQL[EXCLUSIVE]
LOCK_NOT_AVAILABLE_SQLSTATE = "55P03"


def lock_sql(mode: str) -> tuple[str, str, str]:
    """The statements of an advisory lock in ``mode`` (``exclusive`` or ``shared``), shared with ``src.source_traffic``."""
    if mode not in _LOCK_SQL:
        raise ValueError(f"Unknown lock mode: {mode!r}")
    return _LOCK_SQL[mode]


def queued_wait(connection: Any, sql: str, key: str, seconds: float) -> bool:
    """Wait in PostgreSQL's queue for ``seconds`` at most (``lock_timeout``); False when the lock did not come.

    While it waits, the request is queued: a later request that conflicts with it (a shared request behind an
    exclusive one) queues behind it instead of passing it.
    """
    connection.execute(f"set lock_timeout = '{max(1, int(seconds * 1000))}ms'")
    try:
        connection.execute(sql, (key,))
    except Exception as exc:
        if getattr(exc, "sqlstate", None) != LOCK_NOT_AVAILABLE_SQLSTATE:
            raise
        return False
    finally:
        connection.execute("set lock_timeout = 0")
    return True


class CatalogueLockTimeout(RuntimeError):
    """Another job kept writing the catalogue for the whole waiting time."""


class CatalogueLockLost(RuntimeError):
    """The session holding the catalogue writer lock stopped answering: the lock may be gone."""


class CatalogueLockHandle:
    """What ``catalogue_writer_lock`` yields: tells whether the lock may have been lost since it was taken."""

    def __init__(self, label: str) -> None:
        self.label = label
        self._lost = threading.Event()

    @property
    def lost(self) -> bool:
        return self._lost.is_set()

    def mark_lost(self) -> None:
        self._lost.set()

    def ensure_held(self) -> None:
        """Raise ``CatalogueLockLost`` when the heartbeat failed: nothing must be written after that."""
        if self.lost:
            raise CatalogueLockLost(
                f"The catalogue writer lock of {self.label} may have been lost (its heartbeat failed); "
                "stopping before the next write so that two jobs never write the catalogue at once."
            )


_HELD: set[CatalogueLockHandle] = set()
_HELD_GUARD = threading.Lock()


def catalogue_lock_lost() -> bool:
    """True when a catalogue writer lock held by this process may have been lost."""
    with _HELD_GUARD:
        return any(handle.lost for handle in _HELD)


def ensure_catalogue_lock_held() -> None:
    """Raise ``CatalogueLockLost`` when a lock held by this process may have been lost (no-op without a lock)."""
    with _HELD_GUARD:
        handles = list(_HELD)
    for handle in handles:
        handle.ensure_held()


def session_lock_url(db_url: str) -> str:
    """Connection string for the lock session, which must stay the same server session for the whole run.

    A Supabase pooler host is moved to its session port 5432 (the documented URL uses the transaction port
    6543, where each transaction may land on another server session). Port 6543 on any other host is refused.
    Same rule as ``scripts/apply-supabase-concurrent-index-operations.mjs``. The connection string is never
    put in the error message (it carries the password).
    """
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    params = conninfo_to_dict(db_url)
    hosts = [host.strip().lower() for host in str(params.get("host") or "").split(",") if host.strip()]
    ports = [port.strip() for port in str(params.get("port") or "").split(",") if port.strip()]
    if hosts and all(host.endswith(SUPABASE_POOLER_HOST_SUFFIX) for host in hosts):
        if ports and all(port == SESSION_POOLER_PORT for port in ports):
            return db_url
        return make_conninfo(db_url, port=SESSION_POOLER_PORT)
    if TRANSACTION_POOLER_PORT in ports:
        raise ValueError(
            f"The catalogue writer lock needs a session connection: port {TRANSACTION_POOLER_PORT} "
            "(transaction pooler) is refused; use a direct connection or a session pooler on port 5432."
        )
    return db_url


def _lock_wait_seconds() -> float:
    raw = (os.getenv(LOCK_WAIT_ENV) or "").strip()
    if not raw:
        return float(DEFAULT_LOCK_WAIT_SECONDS)
    try:
        return max(0.0, float(raw))
    except ValueError as exc:
        raise ValueError(f"{LOCK_WAIT_ENV} must be a number of seconds, got {raw!r}") from exc


@contextmanager
def catalogue_writer_lock(
    db_url: str | None = None,
    *,
    label: str = "catalogue writer",
    wait_seconds: float | None = None,
    poll_seconds: float = LOCK_POLL_SECONDS,
    heartbeat_seconds: float = LOCK_HEARTBEAT_SECONDS,
    connect: Callable[[str], Any] | None = None,
    clock: Callable[[], float] = time.monotonic,
    mode: str = EXCLUSIVE,
) -> Iterator[CatalogueLockHandle]:
    """Hold the catalogue writer lock for the duration of the ``with`` block.

    ``mode``: ``exclusive`` (default, every writer but the lane's queue workers) or
    ``shared`` (queue workers of the parallel lane, ``src.queued_runner``).
    Waits up to ``wait_seconds`` (``PIPELINE_LOCK_WAIT_SECONDS``, 55 minutes by
    default) for another job to finish, queued in PostgreSQL, and says so every
    ``poll_seconds``. Without
    a database URL the lock cannot be taken: that is an error in GitHub Actions
    and whenever Supabase is configured (the catalogue has no write path
    without the direct connection), and a logged no-op otherwise (local
    file-only runs, unit tests).

    The yielded handle is marked lost when the heartbeat fails; the body must
    call ``ensure_held()`` (or ``ensure_catalogue_lock_held()``) before each write.
    """
    url = db_url if db_url is not None else str(load_settings().get("supabase_db_url") or "")
    if not url:
        if in_github_actions() or supabase_configured(load_settings()):
            raise DirectDatabaseMissing("SUPABASE_DB_URL is required to take the catalogue writer lock")
        LOGGER.warning("No database URL: %s runs without the catalogue writer lock", label)
        yield CatalogueLockHandle(label)
        return

    if connect is None:
        from src.storage.supabase_client import connect as connect_postgres

        def connect(target: str) -> Any:
            return connect_postgres(target)

    try_sql, wait_sql, unlock_sql = lock_sql(mode)
    wait = _lock_wait_seconds() if wait_seconds is None else float(wait_seconds)
    connection = connect(session_lock_url(url))
    connection.autocommit = True
    deadline = clock() + wait
    waited = False
    try:
        row = connection.execute(try_sql, (CATALOGUE_WRITER_LOCK_NAME,)).fetchone()
        acquired = bool(row and row[0])
        while not acquired:
            if clock() >= deadline:
                raise CatalogueLockTimeout(
                    f"Another job has been writing the catalogue for more than {wait:g} s; "
                    f"{label} did not start"
                )
            if not waited:
                print(f"Catalogue is being written by another job; {label} waits for the lock.", flush=True)
                waited = True
            acquired = queued_wait(
                connection, wait_sql, CATALOGUE_WRITER_LOCK_NAME, min(poll_seconds, max(0.001, deadline - clock()))
            )
        if waited:
            print(f"Catalogue writer lock acquired by {label} ({mode}).", flush=True)

        handle = CatalogueLockHandle(label)
        stop = threading.Event()
        beat = threading.Thread(
            target=_heartbeat,
            args=(connection, stop, heartbeat_seconds, handle),
            name="catalogue-lock-heartbeat",
            daemon=True,
        )
        if heartbeat_seconds > 0:
            beat.start()
        with _HELD_GUARD:
            _HELD.add(handle)
        try:
            yield handle
        finally:
            with _HELD_GUARD:
                _HELD.discard(handle)
            stop.set()
            if beat.is_alive():
                beat.join(timeout=5)
            try:
                connection.execute(unlock_sql, (CATALOGUE_WRITER_LOCK_NAME,))
            except Exception:
                # Closing the session releases the lock anyway.
                LOGGER.warning("Could not unlock the catalogue writer lock explicitly", exc_info=True)
    finally:
        try:
            connection.close()
        except Exception:  # a lost session cannot be closed cleanly; its end releases the lock on the server
            pass


def _heartbeat(connection: Any, stop: threading.Event, interval: float, handle: CatalogueLockHandle) -> None:
    """Keep the idle lock session from being closed by the server or a proxy; flag the handle if it fails."""
    while not stop.wait(interval):
        try:
            connection.execute("select 1")
        except Exception:
            handle.mark_lost()
            LOGGER.error(
                "Catalogue lock heartbeat failed; the lock may have been lost: %s stops before its next write",
                handle.label,
                exc_info=True,
            )
            return
