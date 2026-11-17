"""robots.txt and per-host cadence for attached-document downloads.

Listing pages already go through ``PoliteHttpClient``. Attached PDFs are
downloaded by a separate pinned transport, which used to ignore robots.txt and
fetch several documents from one host back to back. ``DocumentPoliteness``
applies the same ``RobotsRules`` and a minimum delay per host (raised to the
host's ``Crawl-delay`` when it publishes one).

Since the parallel enrichment lane, ``turn`` also holds the cross-process turn of
the host for the request (``src.host_turn``, the rule ``PoliteHttpClient`` uses),
and robots.txt follows the shared copy (``robots_policy_copies.before_fetch``):
no process reads it more often than a single one did.
"""

from __future__ import annotations

import math
import os
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx

from src.host_turn import HostTurnWaitExceeded, host_turn
from src.pdf_deadline import ensure_pdf_deadline, pdf_deadline_remaining
from src.sources import robots_policy_copies, robots_policy_store
from src.sources.common import RobotsRules, _looks_like_html_challenge, robots_origin_key

MIN_HOST_DELAY_SECONDS = 2.0
# Never go below one request per second and per host, whatever the setting.
MIN_HOST_DELAY_FLOOR_SECONDS = 1.0
HOST_DELAY_ENV = "PDF_HOST_MIN_DELAY_SECONDS"


def configured_host_delay_seconds() -> float:
    """Per-host delay between document requests, from ``PDF_HOST_MIN_DELAY_SECONDS``."""
    raw = (os.getenv(HOST_DELAY_ENV) or "").strip()
    try:
        value = float(raw) if raw else MIN_HOST_DELAY_SECONDS
    except ValueError:
        value = MIN_HOST_DELAY_SECONDS
    if not math.isfinite(value):
        value = MIN_HOST_DELAY_SECONDS
    return max(MIN_HOST_DELAY_FLOOR_SECONDS, value)

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
        min_delay_seconds: float | None = None,
    ) -> None:
        self._user_agent = user_agent
        self._fetch_robots = fetch_robots
        self._sleep = sleep
        self._clock = clock
        self._min_delay = configured_host_delay_seconds() if min_delay_seconds is None else min_delay_seconds
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
        key = robots_origin_key(robots_url)
        user_agent = self._user_agent()
        decision = robots_policy_copies.before_fetch(robots_policy_store.load(key) if key else None, user_agent)
        if decision.action == "reuse" and decision.copy is not None:
            return RobotsRules(decision.copy.rules, decision.copy.crawl_delay)
        if decision.action in {"not_due", "refused"} and decision.failure is not None:
            return DocumentRobotsUnavailable(
                f"robots.txt could not be verified for {origin}: last read failed "
                f"({decision.failure.failure_class}); next read after {decision.failure.probe_not_before().isoformat()}"
            )
        try:
            # The robots request is a request to the host like any other: same turn, same delay.
            with host_turn(robots_url, delay_seconds=self._min_delay, deadline_remaining=pdf_deadline_remaining):
                response = self._fetch_robots(robots_url)
        except (httpx.HTTPError, OSError, ValueError) as exc:
            self._record_failure(key, robots_policy_copies.failure_class(error=exc))
            return DocumentRobotsUnavailable(f"robots.txt could not be verified for {origin}: {exc}")
        finally:
            with self._lock:
                self._next_slot[urlparse(origin).netloc.lower()] = self._clock()
        status = int(response.status_code)
        if status in {404, 410}:
            rules = RobotsRules()
        elif status >= 400:
            self._record_failure(key, robots_policy_copies.failure_class(status_code=status))
            return DocumentRobotsUnavailable(f"robots.txt could not be verified for {origin}: HTTP {status}")
        elif _looks_like_html_challenge(response):
            self._record_failure(key, robots_policy_copies.ACCESS_REFUSED)
            return DocumentRobotsUnavailable(f"robots.txt for {origin} returned an HTML challenge")
        else:
            rules = RobotsRules.parse(response.text, user_agent)
        if key and len(rules.rules) <= robots_policy_copies.MAX_RULES:
            robots_policy_store.save_verified(key, robots_policy_copies.RobotsPolicyCopy(
                rules=rules.rules, crawl_delay=rules.crawl_delay, verified_at=datetime.now(UTC),
                user_agent_digest=robots_policy_copies.user_agent_digest(user_agent),
            ))
        return rules

    @staticmethod
    def _record_failure(key: str | None, failure_class: str) -> None:
        if key:
            robots_policy_store.save_failure(key, robots_policy_copies.RobotsFailure(failure_class, datetime.now(UTC)))

    def is_disallowed(self, url: str) -> bool | None:
        """Live robots.txt verdict for ``url`` without waiting; None when unknown.

        None means politeness is off, the URL has no HTTP origin, or robots.txt
        could not be verified (the download path then retries later).
        """
        if not POLITENESS_ENABLED:
            return None
        origin = _origin(url)
        if origin is None:
            return None
        try:
            rules = self._rules_for(origin)
        except (DocumentRobotsUnavailable, HostTurnWaitExceeded):
            return None
        return not rules.can_fetch(url)

    def wait_turn(self, url: str) -> float:
        """Raise if robots.txt forbids ``url``; otherwise wait for this host's next slot. Returns the host delay."""
        if not POLITENESS_ENABLED:
            return 0.0
        origin = _origin(url)
        if origin is None:
            return 0.0
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
        return delay

    @contextmanager
    def turn(self, url: str) -> Iterator[None]:
        """``wait_turn``, then hold the cross-process turn of the host for the request (``src.host_turn``).

        The turn is handed back once the host delay has passed after the request. A turn that does not come before
        the worker cutoff raises ``host_turn.HostTurnWaitExceeded`` (the caller releases the task).
        """
        delay = self.wait_turn(url)
        if not POLITENESS_ENABLED or _origin(url) is None:
            yield
            return
        with host_turn(url, delay_seconds=delay, deadline_remaining=pdf_deadline_remaining):
            yield


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


def pause_within_deadline(seconds: float) -> None:
    """Sleep between requests to one host without outliving the PDF worker deadline (``src.pdf_deadline``)."""
    end = time.monotonic() + seconds
    while True:
        pause = end - time.monotonic()
        if pause <= 0:
            return
        remaining = ensure_pdf_deadline(operation="waiting between document requests")
        time.sleep(min(pause, remaining) if remaining is not None else pause)
