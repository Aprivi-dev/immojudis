"""Keep only listing images a browser on another origin can actually display.

Some sources serve a placeholder, a JSON endpoint or an image that carries
``Cross-Origin-Resource-Policy: same-origin``. The catalogue then requested
images that every browser blocks. The importer now checks each candidate once
with a short HEAD request and only writes a usable URL to ``raw_image_url``.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlparse

import httpx

from src.config import load_settings

LOGGER = logging.getLogger(__name__)

IMAGE_CHECK_TIMEOUT_SECONDS = 4.0
IMAGE_CHECK_CONNECT_TIMEOUT_SECONDS = 3.0
IMAGE_CHECK_WORKERS = 8
IMAGE_CHECK_CACHE_MAX_ENTRIES = 20_000
# After this many transport failures a host is treated as unreachable for the
# rest of the process instead of costing a timeout per listing.
IMAGE_HOST_FAILURE_LIMIT = 3
# Browsers refuse these when the page lives on another site (immojudis.com).
BLOCKING_CORP_VALUES = frozenset({"same-origin", "same-site"})
HEAD_UNSUPPORTED_STATUSES = frozenset({405, 501})

EXCLUDED_IMAGE_URL_PATTERNS = (
    # JSON endpoint that is not an image.
    re.compile(r"^https?://annonces-legales\.petites-affiches\.fr/vae/json/vignette/", re.IGNORECASE),
    # Generic "no photo" placeholder served by Petites Affiches.
    re.compile(
        r"^https?://(?:[a-z0-9-]+\.)*petites-?affiches\.fr/(?:[^?#]*/)?template-vlimmo\.png(?:[?#].*)?$",
        re.IGNORECASE,
    ),
)


def image_validation_enabled() -> bool:
    return os.getenv("IMAGE_VALIDATION_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}


def is_excluded_image_url(url: object) -> bool:
    text = str(url or "").strip()
    return any(pattern.search(text) for pattern in EXCLUDED_IMAGE_URL_PATTERNS)


def _is_fetchable_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def response_is_displayable(status_code: int, headers: Any) -> bool:
    """200, ``image/*`` and no cross-origin policy that blocks other sites."""
    if status_code != 200:
        return False
    content_type = str(headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if not content_type.startswith("image/"):
        return False
    policy = str(headers.get("cross-origin-resource-policy") or "").strip().lower()
    return policy not in BLOCKING_CORP_VALUES


class ImageValidator:
    def __init__(self, *, user_agent: str | None = None, client: httpx.Client | None = None) -> None:
        self._user_agent = user_agent
        self._client = client
        self._cache: dict[str, bool] = {}
        self._host_failures: dict[str, int] = {}
        self._lock = threading.Lock()

    def _http(self) -> httpx.Client:
        if self._client is None:
            user_agent = self._user_agent or str(load_settings().get("user_agent") or "")
            self._client = httpx.Client(
                timeout=httpx.Timeout(
                    IMAGE_CHECK_TIMEOUT_SECONDS, connect=IMAGE_CHECK_CONNECT_TIMEOUT_SECONDS
                ),
                follow_redirects=True,
                headers={"User-Agent": user_agent, "Accept": "image/*"} if user_agent else {"Accept": "image/*"},
            )
        return self._client

    def is_displayable(self, url: object) -> bool:
        text = str(url or "").strip()
        if not text or is_excluded_image_url(text) or not _is_fetchable_url(text):
            return False
        with self._lock:
            cached = self._cache.get(text)
        if cached is not None:
            return cached
        host = (urlparse(text).hostname or "").lower()
        with self._lock:
            if self._host_failures.get(host, 0) >= IMAGE_HOST_FAILURE_LIMIT:
                return False
        result = self._probe(text, host)
        with self._lock:
            if len(self._cache) >= IMAGE_CHECK_CACHE_MAX_ENTRIES:
                self._cache.clear()
            self._cache[text] = result
        return result

    def _probe(self, url: str, host: str) -> bool:
        client = self._http()
        try:
            response = client.head(url)
            if response.status_code in HEAD_UNSUPPORTED_STATUSES:
                # Some servers do not implement HEAD; read one byte instead.
                with client.stream("GET", url, headers={"Range": "bytes=0-0"}) as ranged:
                    return response_is_displayable(
                        200 if ranged.status_code in {200, 206} else ranged.status_code,
                        ranged.headers,
                    )
            return response_is_displayable(response.status_code, response.headers)
        except (httpx.HTTPError, ValueError) as exc:
            with self._lock:
                self._host_failures[host] = self._host_failures.get(host, 0) + 1
            LOGGER.info("Image check failed for %s: %s", url, exc)
            return False

    def warm(self, urls: Iterable[object]) -> None:
        """Check several images concurrently so later per-sale lookups hit the cache."""
        pending = list(dict.fromkeys(str(url).strip() for url in urls if url))
        if len(pending) < 2:
            return
        with ThreadPoolExecutor(max_workers=IMAGE_CHECK_WORKERS) as pool:
            list(pool.map(self.is_displayable, pending))


_VALIDATOR: ImageValidator | None = None
_VALIDATOR_LOCK = threading.Lock()


def get_image_validator() -> ImageValidator:
    global _VALIDATOR
    with _VALIDATOR_LOCK:
        if _VALIDATOR is None:
            _VALIDATOR = ImageValidator()
        return _VALIDATOR


def reset_image_validator() -> None:
    global _VALIDATOR
    with _VALIDATOR_LOCK:
        _VALIDATOR = None


def _candidate_urls(payload: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    primary = payload.get("raw_image_url")
    if isinstance(primary, str) and primary.strip():
        candidates.append(primary.strip())
    images = payload.get("source_images")
    if isinstance(images, list):
        candidates.extend(item.strip() for item in images if isinstance(item, str) and item.strip())
    return list(dict.fromkeys(candidates))


def filter_raw_image_url(payload: dict[str, Any], validator: ImageValidator | None = None) -> bool:
    """Make ``raw_image_url`` a displayable image, or remove it.

    The first candidate among ``raw_image_url`` and ``source_images`` that is
    not excluded and passes the HEAD check wins. ``source_images`` is left as
    captured. Returns True when ``raw_image_url`` changed.
    """
    before = payload.get("raw_image_url")
    candidates = _candidate_urls(payload)
    if not candidates:
        return False
    usable = [url for url in candidates if not is_excluded_image_url(url)]
    if image_validation_enabled():
        active = validator or get_image_validator()
        chosen = next((url for url in usable if active.is_displayable(url)), None)
    elif isinstance(before, str) and before.strip() and not is_excluded_image_url(before):
        # Network checks are off (offline development, unit tests): only the
        # deterministic exclusions apply.
        return False
    else:
        chosen = usable[0] if usable else None
    if chosen:
        payload["raw_image_url"] = chosen
    else:
        payload.pop("raw_image_url", None)
    return payload.get("raw_image_url") != before


def warm_image_validations(sales: Iterable[Any]) -> None:
    if not image_validation_enabled():
        return
    urls: list[str] = []
    for sale in sales:
        payload = getattr(sale, "raw_payload", None)
        if isinstance(payload, dict):
            usable = [url for url in _candidate_urls(payload) if not is_excluded_image_url(url)]
            urls.extend(usable[:1])
    get_image_validator().warm(urls)
