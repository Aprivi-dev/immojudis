"""robots.txt and per-host cadence for attached-document downloads.

Listing pages already go through ``PoliteHttpClient``. Attached PDFs are
downloaded by a separate pinned transport, which used to ignore robots.txt and
fetch several documents from one host back to back. ``DocumentPoliteness``
applies the same ``RobotsRules`` and a minimum delay per host (raised to the
host's ``Crawl-delay`` when it publishes one).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from urllib.parse import urlparse

import httpx

from src.sources.common import RobotsRules, _looks_like_html_challenge

MIN_HOST_DELAY_SECONDS = 1.5

# The test suite switches this off so unit tests never wait or fetch robots.txt.
POLITENESS_ENABLED = True


class DocumentRobotsDisallowed(Exception):
    """robots.txt forbids fetching this document for our user agent."""


class DocumentRobotsUnavailable(Exception):
    """robots.txt could not be verified; the download is retried later."""


def _origin(url: str) -> str | None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    return f"{parsed.scheme}://{parsed.netloc.lower()}"


class DocumentPoliteness:
    def __init__(
        self,
        *,
        user_agent: Callable[[], str],
        fetch_robots: Callable[[str], httpx.Response],
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        min_delay_seconds: float = MIN_HOST_DELAY_SECONDS,
    ) -> None:
        self._user_agent = user_agent
        self._fetch_robots = fetch_robots
        self._sleep = sleep
        self._clock = clock
        self._min_delay = min_delay_seconds
        self._rules: dict[str, RobotsRules | DocumentRobotsUnavailable] = {}
        self._next_slot: dict[str, float] = {}
        self._lock = threading.Lock()

    def _rules_for(self, origin: str) -> RobotsRules:
        with self._lock:
            known = self._rules.get(origin)
        if known is None:
            known = self._load_rules(origin)
            with self._lock:
                self._rules[origin] = known
        if isinstance(known, DocumentRobotsUnavailable):
            raise known
        return known

    def _load_rules(self, origin: str) -> RobotsRules | DocumentRobotsUnavailable:
        robots_url = f"{origin}/robots.txt"
        try:
            response = self._fetch_robots(robots_url)
        except (httpx.HTTPError, OSError, ValueError) as exc:
            return DocumentRobotsUnavailable(f"robots.txt could not be verified for {origin}: {exc}")
        finally:
            # The robots request is a request to the host like any other.
            with self._lock:
                self._next_slot[urlparse(origin).netloc.lower()] = self._clock()
        status = int(response.status_code)
        if status in {404, 410}:
            return RobotsRules()
        if status >= 400:
            return DocumentRobotsUnavailable(f"robots.txt could not be verified for {origin}: HTTP {status}")
        if _looks_like_html_challenge(response):
            return DocumentRobotsUnavailable(f"robots.txt for {origin} returned an HTML challenge")
        return RobotsRules.parse(response.text, self._user_agent())

    def wait_turn(self, url: str) -> None:
        """Raise if robots.txt forbids ``url``; otherwise wait for this host's next slot."""
        if not POLITENESS_ENABLED:
            return
        origin = _origin(url)
        if origin is None:
            return
        rules = self._rules_for(origin)
        if not rules.can_fetch(url):
            raise DocumentRobotsDisallowed(f"robots.txt does not allow fetching {url}")
        host = urlparse(origin).netloc.lower()
        delay = max(self._min_delay, rules.crawl_delay or 0.0)
        with self._lock:
            now = self._clock()
            slot = max(now, self._next_slot.get(host, float("-inf")) + delay)
            self._next_slot[host] = slot
        pause = slot - now
        if pause > 0:
            self._sleep(pause)


def fetch_robots_document(
    robots_url: str,
    *,
    send: Callable[..., httpx.Response],
    settings: dict[str, object],
) -> httpx.Response:
    """Fetch robots.txt through the same pinned transport and identity as documents."""
    return send(
        robots_url,
        headers={"User-Agent": str(settings["user_agent"]), "Accept": "text/plain,*/*;q=0.5"},
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )


def pause_within_deadline(seconds: float, ensure_deadline: Callable[[], float | None]) -> None:
    """Sleep between requests to one host without outliving the worker deadline."""
    end = time.monotonic() + seconds
    while True:
        pause = end - time.monotonic()
        if pause <= 0:
            return
        remaining = ensure_deadline()
        time.sleep(min(pause, remaining) if remaining is not None else pause)
