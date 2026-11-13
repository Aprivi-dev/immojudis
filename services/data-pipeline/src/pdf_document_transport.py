from __future__ import annotations

import ipaddress
import socket
import ssl
from dataclasses import dataclass
from urllib.parse import urlparse

import httpcore
import httpx


@dataclass(frozen=True)
class PublicDocumentTarget:
    """A public document origin with its resolved addresses pinned."""

    url: str
    hostname: str
    port: int
    addresses: tuple[str, ...]


class _PinnedNetworkBackend(httpcore.NetworkBackend):
    """Dial only addresses approved for one document hostname."""

    def __init__(
        self,
        target: PublicDocumentTarget,
        backend: httpcore.NetworkBackend | None = None,
    ) -> None:
        self._target = target
        self._backend = backend or httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: object = None,
    ) -> httpcore.NetworkStream:
        requested_host = host.decode("ascii") if isinstance(host, bytes) else host
        if requested_host.rstrip(".").lower() != self._target.hostname or port != self._target.port:
            raise ValueError("pinned document transport received an unexpected destination")

        last_error: Exception | None = None
        for address in self._target.addresses:
            try:
                return self._backend.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except Exception as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise ValueError("pinned document transport has no approved address")

    def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: object = None,
    ) -> httpcore.NetworkStream:
        raise ValueError("document downloads cannot use Unix sockets")

    def sleep(self, seconds: float) -> None:
        self._backend.sleep(seconds)


class _PinnedHTTPTransport(httpx.HTTPTransport):
    def __init__(self, target: PublicDocumentTarget) -> None:
        super().__init__(verify=True, trust_env=False, retries=0)
        self._pool.close()
        self._pool = httpcore.ConnectionPool(
            ssl_context=_document_ssl_context(target),
            max_connections=1,
            max_keepalive_connections=0,
            http1=True,
            http2=False,
            retries=0,
            network_backend=_PinnedNetworkBackend(target),
        )


def _document_ssl_context(target: PublicDocumentTarget) -> ssl.SSLContext:
    """Build a verified TLS context for one pinned document origin.

    The Cessions État origin omits its public Sectigo intermediate from the
    server chain. Its source collector already carries the reviewed
    intermediate workaround, so reuse that context only for this exact host.
    Other document origins retain Python's normal trust store.
    """

    if target.hostname == "cessions.immobilier-etat.gouv.fr":
        from src.sources.cessions_etat import cessions_tls_context

        return cessions_tls_context()
    return ssl.create_default_context()


def resolve_public_document_target(
    url: str,
    *,
    resolver: object = socket.getaddrinfo,
) -> PublicDocumentTarget:
    """Validate a document URL and pin it to globally routable addresses."""

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"unsafe document URL: {url}")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"unsafe document URL authority: {url}")

    hostname = parsed.hostname.rstrip(".").lower()
    if not hostname or "%" in hostname:
        raise ValueError(f"unsafe document hostname: {url}")
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise ValueError(f"unsafe document hostname: {url}")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError(f"invalid document URL port: {url}") from exc

    try:
        answers = resolver(hostname, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise ValueError(f"document hostname cannot be resolved: {hostname}") from exc

    addresses: set[str] = set()
    for answer in answers:
        raw_address = str(answer[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as exc:
            raise ValueError(f"resolver returned an invalid document address: {raw_address}") from exc
        if not address.is_global:
            raise ValueError(f"document hostname resolves outside the public network: {hostname}")
        addresses.add(address.compressed)

    if not addresses:
        raise ValueError(f"document hostname has no usable address: {hostname}")
    return PublicDocumentTarget(
        url=url,
        hostname=hostname,
        port=port,
        addresses=tuple(sorted(addresses)),
    )


def is_safe_public_document_url(url: str) -> bool:
    try:
        resolve_public_document_target(url)
    except ValueError:
        return False
    return True
