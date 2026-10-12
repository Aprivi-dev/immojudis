"""Application-level lock shared by every job that writes the sale catalogue.

GitHub concurrency groups only order runs of the same group, and a pending run
is cancelled when a newer one joins its group. The scheduled pipeline and the
manual recompute therefore use separate groups and serialise on this
PostgreSQL advisory lock instead: the second one waits for the first.

The lock is session-scoped (``pg_try_advisory_lock``), so it is held by one
dedicated connection for the whole run and released when it closes. It needs a
direct or session-pooled connection; behind a transaction pooler the session
is not stable and the lock would not hold.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from src.config import load_settings

LOGGER = logging.getLogger(__name__)

CATALOGUE_WRITER_LOCK_NAME = "immojudis:catalogue-writer:v1"
DEFAULT_LOCK_WAIT_SECONDS = 3300
LOCK_POLL_SECONDS = 15.0
LOCK_HEARTBEAT_SECONDS = 60.0
LOCK_WAIT_ENV = "PIPELINE_LOCK_WAIT_SECONDS"

_TRY_LOCK_SQL = "select pg_try_advisory_lock(hashtextextended(%s, 0))"
_UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended(%s, 0))"


class CatalogueLockTimeout(RuntimeError):
    """Another job kept writing the catalogue for the whole waiting time."""


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
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Iterator[None]:
    """Hold the catalogue writer lock for the duration of the ``with`` block.

    Waits up to ``wait_seconds`` (``PIPELINE_LOCK_WAIT_SECONDS``, 55 minutes by
    default) for another job to finish, polling every ``poll_seconds``. Without
    a database URL the lock cannot be taken: that is an error in GitHub Actions
    and a logged no-op elsewhere (local development, unit tests).
    """
    url = db_url if db_url is not None else str(load_settings().get("supabase_db_url") or "")
    if not url:
        if os.getenv("GITHUB_ACTIONS") == "true":
            raise RuntimeError("SUPABASE_DB_URL is required to take the catalogue writer lock")
        LOGGER.warning("No database URL: %s runs without the catalogue writer lock", label)
        yield
        return

    if connect is None:
        from src.storage.supabase_client import connect as connect_postgres

        def connect(target: str) -> Any:
            return connect_postgres(target)

    wait = _lock_wait_seconds() if wait_seconds is None else float(wait_seconds)
    connection = connect(url)
    connection.autocommit = True
    deadline = clock() + wait
    waited = False
    try:
        while True:
            row = connection.execute(_TRY_LOCK_SQL, (CATALOGUE_WRITER_LOCK_NAME,)).fetchone()
            if row and row[0]:
                break
            if clock() >= deadline:
                raise CatalogueLockTimeout(
                    f"Another job has been writing the catalogue for more than {wait:g} s; "
                    f"{label} did not start"
                )
            if not waited:
                print(f"Catalogue is being written by another job; {label} waits for the lock.", flush=True)
                waited = True
            sleep(min(poll_seconds, max(0.0, deadline - clock())))
        if waited:
            print(f"Catalogue writer lock acquired by {label}.", flush=True)

        stop = threading.Event()
        beat = threading.Thread(
            target=_heartbeat,
            args=(connection, stop, heartbeat_seconds),
            name="catalogue-lock-heartbeat",
            daemon=True,
        )
        if heartbeat_seconds > 0:
            beat.start()
        try:
            yield
        finally:
            stop.set()
            if beat.is_alive():
                beat.join(timeout=5)
            try:
                connection.execute(_UNLOCK_SQL, (CATALOGUE_WRITER_LOCK_NAME,))
            except Exception:
                # Closing the session releases the lock anyway.
                LOGGER.warning("Could not unlock the catalogue writer lock explicitly", exc_info=True)
    finally:
        try:
            connection.close()
        except Exception:
            pass


def _heartbeat(connection: Any, stop: threading.Event, interval: float) -> None:
    """Keep the idle lock session from being closed by the server or a proxy."""
    while not stop.wait(interval):
        try:
            connection.execute("select 1")
        except Exception:
            LOGGER.warning("Catalogue lock heartbeat failed; the lock may have been lost", exc_info=True)
            return
