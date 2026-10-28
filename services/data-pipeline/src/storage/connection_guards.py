"""Guards around a direct Postgres connection: kernel keepalives, a client-side deadline, a read-again loop.

``supabase_client`` re-exports these names, so this module must never import it back (cycle).
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager
from typing import Any

try:
    import psycopg
except ModuleNotFoundError:  # pragma: no cover - GitHub Actions installs psycopg on Python 3.11.
    psycopg = None

LOGGER = logging.getLogger(__name__)

# A connection whose peer vanished without a word (a restart of the database or of the pooler, a dropped NAT entry)
# blocks the client in ``recv`` for as long as the operating system allows, which is hours. These libpq options make
# the kernel probe an idle connection (20 s idle, then three probes 10 s apart) and drop one whose data stays
# unacknowledged for 60 s: the call then fails in about a minute instead of waiting for the watchdog.
POSTGRES_KEEPALIVE_OPTIONS: dict[str, int] = {
    "keepalives": 1,
    "keepalives_idle": 20,
    "keepalives_interval": 10,
    "keepalives_count": 3,
    "tcp_user_timeout": 60_000,
}


class DatabaseCallTimeout(TimeoutError):
    """A database call did not answer within its client-side deadline; the connection was cut."""


@contextmanager
def _client_deadline(connection: Any, seconds: float, what: str):
    """Cut ``connection`` from the client side when the call it runs does not answer within ``seconds``.

    ``statement_timeout`` is enforced by the server: it does nothing when the query never reached a backend (a
    pooler that cannot open one) or when the server is gone. A timer shuts the socket down (on a duplicate of the
    descriptor, so the connection object keeps owning its own); the blocked ``recv`` then fails at once and the
    caller sees ``DatabaseCallTimeout`` instead of waiting. The connection is unusable afterwards: open a new one.
    """
    fired = threading.Event()

    def cut() -> None:
        fired.set()
        try:
            duplicate = socket.socket(fileno=os.dup(connection.fileno()))
            try:
                duplicate.shutdown(socket.SHUT_RDWR)
            finally:
                duplicate.close()
        except Exception:  # noqa: BLE001 - the connection may already be closed; nothing more to cut
            pass

    timer = threading.Timer(seconds, cut)
    timer.daemon = True
    timer.start()
    try:
        yield
    except BaseException as exc:
        if fired.is_set() and isinstance(exc, Exception):
            raise DatabaseCallTimeout(f"{what} did not answer within {seconds:g}s; connection cut") from exc
        raise
    finally:
        timer.cancel()


def retry_on_disconnect[T](
    read: Callable[[], T],
    delays: tuple[float, ...],
    sleep: Callable[[float], None] = time.sleep,
    *,
    what: str = "Database read",
) -> T:
    """Run a pure read again, on a new connection, when the database dropped or stalled the previous one.

    A database restart (« terminating connection due to administrator command », « the database system is not
    accepting connections ») or a silent connection loss used to end the source, or to block it until the
    watchdog ended the whole run. ``read`` must open its own connection and be safe to repeat. Other errors
    are not retried; the last failure is raised once ``delays`` is exhausted.
    """
    retryable: tuple[type[BaseException], ...] = (DatabaseCallTimeout,)
    if psycopg is not None:
        retryable = (psycopg.OperationalError, psycopg.InterfaceError, DatabaseCallTimeout)
    for attempt, delay in enumerate((*delays, None), start=1):
        try:
            return read()
        except retryable as exc:
            if delay is None:
                raise
            LOGGER.warning(
                "%s interrupted; reading it again attempt=%s/%s in %ss: %s",
                what,
                attempt,
                len(delays) + 1,
                delay,
                type(exc).__name__,
            )
            sleep(delay)
    raise AssertionError("unreachable")
