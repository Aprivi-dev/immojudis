"""Bounded, allow-listed HTTP downloads for the reference data import."""

from __future__ import annotations

import json
import os
import shutil
import time
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DOWNLOAD_TIMEOUT_SECONDS = 120
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
RETRY_DELAYS_SECONDS = (2.0, 5.0, 15.0)
ALLOWED_HOSTS = frozenset(
    {
        "geo.api.gouv.fr",
        "files.georisques.fr",
        "object.files.data.gouv.fr",
    }
)


class ReferenceDownloadError(RuntimeError):
    """Raised when a reference resource cannot be downloaded safely."""


def validate_reference_url(url: str) -> str:
    value = (url or "").strip()
    parsed = urlparse(value)
    if parsed.scheme != "https":
        raise ReferenceDownloadError(f"Reference URL must use https: {value!r}")
    if parsed.username or parsed.password:
        raise ReferenceDownloadError(f"Reference URL must not embed credentials: {value!r}")
    host = (parsed.hostname or "").lower().rstrip(".")
    if host not in ALLOWED_HOSTS:
        raise ReferenceDownloadError(f"Reference host {host or '(none)'!r} is not allowed")
    return value


class _AllowListedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        validate_reference_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, *, timeout: float):  # type: ignore[no-untyped-def]
    validate_reference_url(url)
    opener = urllib.request.build_opener(_AllowListedRedirectHandler())
    headers = {"Accept-Encoding": "identity"}
    user_agent = (os.environ.get("AUCTION_USER_AGENT") or "").strip()
    if user_agent:
        headers["User-Agent"] = user_agent
    return opener.open(urllib.request.Request(url, headers=headers), timeout=timeout)


def _with_retries(action, *, retry_delays=RETRY_DELAYS_SECONDS, sleep=time.sleep):  # type: ignore[no-untyped-def]
    for delay in (*retry_delays, None):
        try:
            return action()
        except ReferenceDownloadError:
            raise
        except OSError:
            if delay is None:
                raise
            sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover


def fetch_text(url: str, *, timeout: float = DOWNLOAD_TIMEOUT_SECONDS) -> str:
    def action() -> str:
        with _open(url, timeout=timeout) as response:
            return response.read().decode("utf-8")

    return _with_retries(action)


def fetch_json(url: str, *, timeout: float = DOWNLOAD_TIMEOUT_SECONDS) -> Any:
    return json.loads(fetch_text(url, timeout=timeout))


def download(url: str, target: Path, *, timeout: float = DOWNLOAD_TIMEOUT_SECONDS) -> Path:
    """Stream ``url`` into ``target``; the target only appears once complete."""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")

    def action() -> Path:
        try:
            with _open(url, timeout=timeout) as response, partial.open("wb") as handle:
                shutil.copyfileobj(response, handle, DOWNLOAD_CHUNK_BYTES)
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
        return target

    return _with_retries(action)
