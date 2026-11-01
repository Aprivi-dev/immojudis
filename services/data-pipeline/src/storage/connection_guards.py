"""Guards around a direct Postgres connection: kernel keepalives, a client-side deadline, a read-again loop.

``supabase_client`` re-exports these names, so this module must never import it back (cycle).
"""

from __future__ import annotations

import logging
import os
import re
import socket
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager
from typing import Any
from urllib.parse import parse_qs, urlsplit

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


# Chiffrement de la connexion directe au Postgres (n° 44). Une URL sans ``sslmode`` partait en clair si le serveur
# acceptait aussi le non chiffré (le défaut de libpq est ``prefer``). Elle est désormais en ``sslmode=require``.
#   * une URL qui porte son propre ``sslmode`` (ou ``PGSSLMODE`` dans l'environnement) garde la main ;
#   * ``POSTGRES_SSL`` choisit le mode : ``require`` (défaut), ``verify-ca``, ``verify-full`` ou ``disable`` ;
#   * ``disable`` n'est admis que pour une base locale (localhost, 127.0.0.1, ::1, socket Unix) : le Postgres de la CI ;
#   * une base locale n'est pas forcée en ``require`` (le service Postgres de la CI n'a pas de TLS).
POSTGRES_SSL_ENV = "POSTGRES_SSL"
POSTGRES_SSL_MODES = frozenset({"require", "verify-ca", "verify-full", "disable"})
_LOCAL_DATABASE_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_DSN_SSLMODE = re.compile(r"(?:^|\s)sslmode\s*=", re.IGNORECASE)
_DSN_HOST = re.compile(r"(?:^|\s)host\s*=\s*(?:'([^']*)'|(\S+))", re.IGNORECASE)


def _database_host_and_sslmode(db_url: str) -> tuple[str, bool]:
    """Hôte désigné par l'URL (ou le DSN) et présence d'un ``sslmode`` explicite."""
    text = str(db_url or "").strip()
    if re.match(r"^postgres(?:ql)?://", text, re.IGNORECASE):
        parts = urlsplit(text)
        query = parse_qs(parts.query)
        host = (query.get("host") or [parts.hostname or ""])[0]
        return host.lower(), "sslmode" in {key.lower() for key in query}
    match = _DSN_HOST.search(text)
    host = (match.group(1) or match.group(2) or "") if match else ""
    return host.lower(), _DSN_SSLMODE.search(text) is not None


def _is_local_database_host(host: str) -> bool:
    return not host or host in _LOCAL_DATABASE_HOSTS or host.endswith(".localhost") or host.startswith("/")


def postgres_ssl_options(db_url: str) -> dict[str, str]:
    """Paramètres de connexion à ajouter pour chiffrer la connexion (``{}`` quand rien n'est à imposer).

    Lève ``ValueError`` pour un ``POSTGRES_SSL`` inconnu ou pour ``disable`` sur une base qui n'est pas locale.
    """
    host, has_sslmode = _database_host_and_sslmode(db_url)
    configured = os.getenv(POSTGRES_SSL_ENV, "").strip().lower()
    if configured and configured not in POSTGRES_SSL_MODES:
        raise ValueError(f"{POSTGRES_SSL_ENV} must be unset, require, verify-ca, verify-full or disable.")
    if has_sslmode:
        return {}
    if configured == "disable":
        if not _is_local_database_host(host):
            raise ValueError(f"{POSTGRES_SSL_ENV}=disable is allowed only for a local database connection.")
        return {"sslmode": "disable"}
    if configured:
        return {"sslmode": configured}
    if os.getenv("PGSSLMODE", "").strip() or _is_local_database_host(host):
        return {}
    return {"sslmode": "require"}


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
