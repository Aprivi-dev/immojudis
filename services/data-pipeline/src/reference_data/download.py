"""Bounded, allow-listed HTTP downloads for the reference data import."""

from __future__ import annotations

import http.client
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DOWNLOAD_TIMEOUT_SECONDS = 120
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
RETRY_DELAYS_SECONDS = (2.0, 5.0, 15.0)
# A source that grows far beyond what it has ever been is a mistake or an attack, not a dataset: the
# read stops at these ceilings instead of filling the disk or the memory of the runner.
MAX_TEXT_BYTES = 32 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
ALLOWED_HOSTS = frozenset(
    {
        "geo.api.gouv.fr",
        "files.georisques.fr",
        "object.files.data.gouv.fr",
        # Rent map (ANIL) and rental-tension zoning: the dataset description comes from the
        # data.gouv.fr API (www), the CSV files from its static host.
        "www.data.gouv.fr",
        "static.data.gouv.fr",
        # Commune movements file of the COG (code changes), for the commune code history.
        "www.insee.fr",
    }
)


# Only a server-side or rate-limit answer is worth another attempt: a 404 or a 403 will not change.
RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})


class ReferenceDownloadError(RuntimeError):
    """Raised when a reference resource cannot be downloaded safely."""


class IncompleteDownloadError(ReferenceDownloadError):
    """The body is shorter than the ``Content-Length`` the server declared (a cut connection)."""


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
        except IncompleteDownloadError:
            # A truncated body is a transport accident: it deserves the same new attempts.
            if delay is None:
                raise
            sleep(delay)
        except ReferenceDownloadError:
            raise
        except urllib.error.HTTPError as exc:
            if exc.code not in RETRYABLE_HTTP_STATUSES or delay is None:
                raise
            sleep(delay)
        except (OSError, http.client.HTTPException):
            # ``http.client.IncompleteRead`` and its kin are not ``OSError``.
            if delay is None:
                raise
            sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover


def _declared_size(response) -> int | None:  # type: ignore[no-untyped-def]
    try:
        return int(response.headers.get("Content-Length"))
    except (AttributeError, TypeError, ValueError):
        return None


def _check_declared_size(response, limit: int, url: str) -> None:  # type: ignore[no-untyped-def]
    declared = _declared_size(response)
    if declared is not None and declared > limit:
        raise ReferenceDownloadError(f"{url!r} declares {declared} bytes, above the {limit}-byte limit")


def _check_complete(received: int, response, url: str) -> None:  # type: ignore[no-untyped-def]
    declared = _declared_size(response)
    if declared is not None and received != declared:
        raise IncompleteDownloadError(f"{url!r} declared {declared} bytes but {received} were received")


def fetch_text(
    url: str, *, timeout: float = DOWNLOAD_TIMEOUT_SECONDS, max_bytes: int = MAX_TEXT_BYTES
) -> str:
    def action() -> str:
        with _open(url, timeout=timeout) as response:
            _check_declared_size(response, max_bytes, url)
            # One byte more than the limit is enough to know the body is too large.
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise ReferenceDownloadError(f"{url!r} is larger than the {max_bytes}-byte limit")
            _check_complete(len(body), response, url)
            return body.decode("utf-8")

    return _with_retries(action)


def fetch_json(url: str, *, timeout: float = DOWNLOAD_TIMEOUT_SECONDS) -> Any:
    return json.loads(fetch_text(url, timeout=timeout))


def _copy_bounded(source, target, limit: int, url: str) -> int:  # type: ignore[no-untyped-def]
    copied = 0
    while True:
        chunk = source.read(DOWNLOAD_CHUNK_BYTES)
        if not chunk:
            return copied
        copied += len(chunk)
        if copied > limit:
            raise ReferenceDownloadError(f"{url!r} is larger than the {limit}-byte limit")
        target.write(chunk)


def download(
    url: str,
    target: Path,
    *,
    timeout: float = DOWNLOAD_TIMEOUT_SECONDS,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
) -> Path:
    """Stream ``url`` into ``target`` (at most ``max_bytes``); the target only appears once complete."""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")

    def action() -> Path:
        try:
            with _open(url, timeout=timeout) as response, partial.open("wb") as handle:
                _check_declared_size(response, max_bytes, url)
                copied = _copy_bounded(response, handle, max_bytes, url)
                _check_complete(copied, response, url)
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
        return target

    return _with_retries(action)
