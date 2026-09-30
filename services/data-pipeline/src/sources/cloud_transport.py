"""Opt-in, source-scoped transport. Parsing and pagination remain in the collector."""
from __future__ import annotations

import os
from collections.abc import Mapping

import httpx

from src.source_task_deadline import (
    ensure_source_task_deadline,
    source_task_bounded_timeout,
    source_task_deadline_remaining,
)

SOURCE_HOSTS = {"www.petitesaffiches.fr", "cessions.immobilier-etat.gouv.fr"}
_RELAY_DEFAULT_TIMEOUT_SECONDS = 40.0
_TIMEOUT_PHASES = ("connect", "read", "write", "pool")


def configured_transport(base_url: str) -> httpx.BaseTransport | None:
    if httpx.URL(base_url).host not in SOURCE_HOSTS:
        return None
    endpoint = os.environ.get("SOURCE_FETCH_RELAY_URL", "").strip()
    token = os.environ.get("SOURCE_FETCH_RELAY_TOKEN", "").strip()
    if not endpoint and not token:
        return None
    if not endpoint or not token or httpx.URL(endpoint).scheme != "https":
        raise ValueError("Source relay requires an HTTPS endpoint and a dedicated token")
    return SourceRelayTransport(endpoint, token)


class SourceRelayTransport(httpx.BaseTransport):
    def __init__(self, endpoint: str, token: str) -> None:
        self.endpoint = endpoint
        self.token = token
        self.client = httpx.Client(timeout=40, follow_redirects=False)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.scheme != "https" or request.url.host not in SOURCE_HOSTS or request.url.port not in (None, 443):
            raise ValueError("Source relay refuses an unconfigured origin")
        # Never transmit database credentials, authorization or arbitrary headers upstream.
        headers = {k: v for k, v in request.headers.items()
                   if k in {"user-agent", "accept", "accept-language", "content-type"}}
        ensure_source_task_deadline("reading source relay request body")
        body = request.read()
        ensure_source_task_deadline("preparing source relay POST")
        payload = {
            "url": str(request.url),
            "method": request.method,
            "headers": headers,
            "body": body.decode("utf-8"),
        }
        ensure_source_task_deadline("preparing source relay POST")
        timeout = _relay_timeout(request)
        ensure_source_task_deadline("admitting source relay POST")
        timeout = _bound_relay_timeout(timeout, "admitting source relay POST")
        response = self.client.post(
            self.endpoint,
            # Pin the proven Paris region. Automatic placement otherwise follows
            # the GitHub runner to a different egress network.
            headers={"Authorization": f"Bearer {self.token}", "x-region": "eu-west-3"},
            json=payload,
            timeout=timeout,
        )
        ensure_source_task_deadline("receiving source relay response")
        if response.headers.get("x-immojudis-source-relay") != "1":
            if response.status_code == 400:
                # Keep the relay body and target URL out of the exception.  A
                # malformed or stale source path is actionable without
                # exposing query tokens or upstream response text.
                raise httpx.TransportError("Source relay target not allowed (HTTP 400)")
            if response.status_code in {401, 403}:
                raise httpx.TransportError(
                    f"Source relay authentication rejected (HTTP {response.status_code})"
                )
            raise httpx.TransportError(f"Source relay unavailable (HTTP {response.status_code})")
        # httpx has already decompressed the relay response. Do not ask the
        # outer client to decompress those bytes a second time.
        content = response.content
        ensure_source_task_deadline("reading source relay response body")
        headers = {k: v for k, v in response.headers.items()
                   if k not in {"content-encoding", "content-length", "transfer-encoding", "connection"}}
        return httpx.Response(response.status_code, headers=headers, content=content)

    def close(self) -> None:
        self.client.close()


def _relay_timeout(request: httpx.Request) -> float | httpx.Timeout:
    """Use propagated phases for scoped work, with the relay's 40s default."""

    # The relay historically owns a 40s timeout. The outer request timeout is
    # only a source-detail budget signal, so it must not change direct callers.
    if source_task_deadline_remaining() is None:
        return _RELAY_DEFAULT_TIMEOUT_SECONDS
    extension = request.extensions.get("timeout")
    if isinstance(extension, Mapping):
        phases = {phase: extension.get(phase) for phase in _TIMEOUT_PHASES}
        if any(value is not None for value in phases.values()):
            try:
                return httpx.Timeout(**phases)
            except (TypeError, ValueError):
                # A transport extension is caller supplied. Keep the relay's
                # established timeout when it is malformed instead of failing
                # before the source-specific request can be attempted.
                pass
    return _RELAY_DEFAULT_TIMEOUT_SECONDS


def _bound_relay_timeout(
    timeout: float | httpx.Timeout,
    operation: str,
) -> float | httpx.Timeout:
    """Apply the active source-detail deadline to every relay timeout phase."""

    if source_task_deadline_remaining() is None:
        return timeout
    if isinstance(timeout, httpx.Timeout):
        def bound(value: float | None) -> float:
            remaining = source_task_deadline_remaining()
            requested = remaining if value is None else value
            return source_task_bounded_timeout(requested, operation)

        return httpx.Timeout(
            connect=bound(timeout.connect),
            read=bound(timeout.read),
            write=bound(timeout.write),
            pool=bound(timeout.pool),
        )
    return source_task_bounded_timeout(timeout, operation)
