"""Bounded, allow-listed downloads for the DVF import workflow.

The workflow used to call ``urllib.request.urlretrieve`` on any URL given as the
``resource_url`` input, with no timeout. This module keeps the download logic
out of the workflow YAML so it can be unit tested without network access.
"""

from __future__ import annotations

import json
import os
import shutil
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DVF_DOWNLOAD_TIMEOUT_SECONDS = 120
DVF_API_TIMEOUT_SECONDS = 60
ALLOWED_DVF_HOSTS = frozenset(
    {
        "data.gouv.fr",
        "www.data.gouv.fr",
        "files.data.gouv.fr",
        "static.data.gouv.fr",
    }
)
DVF_DOWNLOAD_CHUNK_BYTES = 1024 * 1024


class DvfDownloadError(RuntimeError):
    """Raised when a DVF resource cannot be downloaded safely."""


def validate_dvf_resource_url(url: str) -> str:
    """Return ``url`` when it is an https data.gouv.fr URL, raise otherwise."""
    value = (url or "").strip()
    parsed = urlparse(value)
    if parsed.scheme != "https":
        raise DvfDownloadError(f"DVF resource URL must use https: {value!r}")
    if parsed.username or parsed.password:
        raise DvfDownloadError(f"DVF resource URL must not embed credentials: {value!r}")
    host = (parsed.hostname or "").lower().rstrip(".")
    if host not in ALLOWED_DVF_HOSTS:
        raise DvfDownloadError(
            f"DVF resource host {host or '(none)'!r} is not allowed; "
            f"expected one of {', '.join(sorted(ALLOWED_DVF_HOSTS))}"
        )
    return value


class _AllowListedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Apply the same host allow-list to every redirect hop."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        validate_dvf_resource_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, *, timeout: float):  # type: ignore[no-untyped-def]
    validate_dvf_resource_url(url)
    opener = urllib.request.build_opener(_AllowListedRedirectHandler())
    headers = {}
    user_agent = (os.environ.get("AUCTION_USER_AGENT") or "").strip()
    if user_agent:
        headers["User-Agent"] = user_agent
    return opener.open(urllib.request.Request(url, headers=headers), timeout=timeout)


def fetch_json(url: str, *, timeout: float = DVF_API_TIMEOUT_SECONDS) -> dict[str, Any]:
    with _open(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def download_dvf_resource(
    url: str,
    target: Path,
    *,
    timeout: float = DVF_DOWNLOAD_TIMEOUT_SECONDS,
) -> Path:
    """Stream ``url`` into ``target`` through a ``.part`` file.

    ``timeout`` applies to each socket operation, so a stalled connection fails
    after ``timeout`` seconds instead of hanging the workflow until its limit.
    The target only appears once the whole body has been written.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    try:
        with _open(url, timeout=timeout) as response, partial.open("wb") as handle:
            shutil.copyfileobj(response, handle, DVF_DOWNLOAD_CHUNK_BYTES)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target
