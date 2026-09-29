from __future__ import annotations

import logging
import math
import re
import signal
import ssl
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from src.sources.cloud_transport import configured_transport

LOGGER = logging.getLogger(__name__)
REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}
MAX_SAFE_REDIRECTS = 5
MAX_SOURCE_HTML_CHARS = 4_000_000
SOURCE_PARSE_TIMEOUT_SECONDS = 10.0


class SourceParseTimeout(RuntimeError):
    """Raised when a source page parser exceeds its CPU time budget."""


class SourceParseLimitExceeded(RuntimeError):
    """Raised when a source returns a page too large to parse safely."""


@contextmanager
def _source_parse_deadline(timeout_seconds: float):
    """Bound BeautifulSoup CPU time when parsing on the process main thread.

    ``SIGALRM`` cannot be installed by worker threads.  Those callers still
    get the input-size bound below; the regular pipeline parses source pages
    in its main thread, where the hard wall-clock guard applies.
    """
    if (
        timeout_seconds <= 0
        or threading.current_thread() is not threading.main_thread()
        or not hasattr(signal, "SIGALRM")
    ):
        yield
        return

    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, 0)
    started = time.monotonic()

    def _raise_timeout(_signum: int, _frame: object) -> None:
        raise SourceParseTimeout(
            f"source HTML parsing exceeded {timeout_seconds:g}s CPU/wall-clock budget"
        )

    signal.signal(signal.SIGALRM, _raise_timeout)
    signal.setitimer(signal.ITIMER_REAL, timeout_seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0] > 0:
            elapsed = time.monotonic() - started
            remaining = max(0.001, previous_timer[0] - elapsed)
            signal.setitimer(signal.ITIMER_REAL, remaining, previous_timer[1])


def parse_html(
    html: str | bytes,
    parser: str = "html.parser",
    *,
    timeout_seconds: float = SOURCE_PARSE_TIMEOUT_SECONDS,
) -> BeautifulSoup:
    """Parse bounded source HTML without allowing malformed pages to hang.

    Source adapters should call this wrapper instead of constructing
    ``BeautifulSoup`` directly.  Rejecting an oversized body is intentional:
    truncating a legal notice could silently produce incomplete facts.
    """
    size = len(html)
    if size > MAX_SOURCE_HTML_CHARS:
        raise SourceParseLimitExceeded(
            f"source HTML body has {size} units; limit is {MAX_SOURCE_HTML_CHARS}"
        )
    with _source_parse_deadline(float(timeout_seconds)):
        return BeautifulSoup(html, parser)


def retry_after_seconds(value: str | None, *, now: datetime | None = None) -> float:
    """HTTP delta-seconds and HTTP-date share the same minimum retry deadline."""
    if not value:
        return 0
    try:
        seconds = float(value)
    except ValueError:
        try:
            deadline = parsedate_to_datetime(value)
            if deadline.tzinfo is None:
                return 0
            seconds = (deadline - (now or datetime.now(UTC))).total_seconds()
        except (TypeError, ValueError, OverflowError):
            return 0
    return max(0, seconds) if math.isfinite(seconds) else 0


def is_allowed_origin_url(url: str, allowed_origins: tuple[str, ...]) -> bool:
    """Return whether an absolute HTTP(S) URL belongs to an exact trusted origin."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    target_origin = _origin(parsed)
    return any(target_origin == _origin(urlparse(origin)) for origin in allowed_origins)


def _origin(parsed: Any) -> tuple[str, str, int] | None:
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    default_port = 443 if parsed.scheme == "https" else 80
    try:
        port = parsed.port or default_port
    except ValueError:
        return None
    return parsed.scheme.lower(), parsed.hostname.rstrip(".").lower(), port


@dataclass
class PaginationCoverage:
    pages_fetched: int = 0
    exhausted: bool = False
    repeated: bool = False
    seen: set[str] = field(default_factory=set)
    expected_total: int | None = None
    total_changed: bool = False
    empty_unverified: bool = False

    def accept(self, sales: list[dict[str, Any]], *, terminal: bool = False,
               expected_total: int | None = None) -> bool:
        self.pages_fetched += 1
        if type(expected_total) is int and expected_total >= 0:
            if self.expected_total is not None and expected_total != self.expected_total:
                self.total_changed = True
            self.expected_total = expected_total
        urls = {str(sale.get("source_url")) for sale in sales if sale.get("source_url")}
        if not urls:
            self.empty_unverified = not terminal
            self.exhausted = bool(terminal and not self.total_changed and
                                  (self.expected_total is None or len(self.seen) == self.expected_total))
            return False
        if urls <= self.seen:
            self.repeated = True
            return False
        self.seen.update(urls)
        self.exhausted = bool(terminal and not self.total_changed and
                              (self.expected_total is None or len(self.seen) == self.expected_total))
        return True

    def metrics(self) -> dict[str, Any]:
        return {"pages_fetched": self.pages_fetched, "coverage_complete": self.exhausted,
                "unique_listings_seen": len(self.seen), "advertised_total": self.expected_total,
                "total_changed_during_scan": self.total_changed,
                "stop_reason": "exhausted" if self.exhausted else "repeated_page" if self.repeated
                else "empty_page_unverified" if self.empty_unverified else "page_limit_or_count_mismatch"}


@dataclass
class ScrapeResult:
    sales: list[dict[str, Any]]
    errors: list[str]
    coverage: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.coverage.setdefault("listings_emitted", len(self.sales))
        self.coverage.setdefault("errors", len(self.errors))
        self.coverage.setdefault("coverage_complete", None)
        self.coverage.setdefault("stop_reason", "source_finished")
        if self.errors:
            self.coverage["coverage_complete"] = False
            self.coverage["stop_reason"] = "source_errors"


@dataclass
class RobotsRules:
    rules: tuple[tuple[str, str], ...] = ()

    @classmethod
    def parse(cls, text: str, user_agent: str) -> RobotsRules:
        groups: list[tuple[list[str], list[tuple[str, str]]]] = []
        agents: list[str] = []
        rules: list[tuple[str, str]] = []
        for raw_line in text.splitlines():
            line = raw_line.split("#", 1)[0].strip()
            if not line:
                if agents or rules:
                    groups.append((agents, rules))
                    agents, rules = [], []
                continue
            if ":" not in line:
                continue
            key, value = [part.strip() for part in line.split(":", 1)]
            key = key.lower()
            if key == "user-agent":
                if rules:
                    groups.append((agents, rules))
                    agents, rules = [], []
                agents.append(value.lower())
            elif key in {"allow", "disallow"} and agents:
                rules.append((key, value))
        if agents or rules:
            groups.append((agents, rules))

        ua = user_agent.lower()
        selected: list[tuple[str, str]] = []
        for group_agents, group_rules in groups:
            if any(agent != "*" and agent in ua for agent in group_agents):
                selected = group_rules
                break
            if not selected and "*" in group_agents:
                selected = group_rules
        return cls(tuple(selected))

    def can_fetch(self, url: str) -> bool:
        parsed = urlparse(url)
        target = parsed.path or "/"
        if parsed.query:
            target = f"{target}?{parsed.query}"

        matched_allow = ""
        matched_disallow = ""
        for key, pattern in self.rules:
            if not pattern:
                continue
            if not _robots_match(pattern, target):
                continue
            if key == "allow" and len(pattern) > len(matched_allow):
                matched_allow = pattern
            elif key == "disallow" and len(pattern) > len(matched_disallow):
                matched_disallow = pattern
        return len(matched_allow) >= len(matched_disallow)


@dataclass
class PoliteHttpClient:
    base_url: str
    user_agent: str
    delay_seconds: float
    timeout_seconds: float
    allowed_redirect_origins: tuple[str, ...] = ()
    accept: str = "text/html,application/xhtml+xml"
    extra_headers: dict[str, str] | None = None
    tls_context: ssl.SSLContext | None = None

    def __post_init__(self) -> None:
        self._last_request_at = 0.0
        self._requests_attempted = 0
        self._requests_succeeded = 0
        self._requests_failed = 0
        self._visited_urls: list[str] = []
        self._retry_not_before: str | None = None
        self._access_denials = 0
        self._robots_by_origin: dict[tuple[str, str, int], RobotsRules] = {}
        self._robots_unavailable: set[tuple[str, str, int]] = set()
        self._last_robots_origin: tuple[str, str, int] | None = None
        headers = {
            "User-Agent": self.user_agent,
            "Accept": self.accept,
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        }
        if self.extra_headers:
            headers.update(self.extra_headers)
        transport = configured_transport(self.base_url)
        self._fetch_transport = "supabase" if transport is not None else "direct"
        transport_options = {"transport": transport} if transport is not None else {}
        self._client = httpx.Client(
            headers=headers,
            timeout=self.timeout_seconds,
            follow_redirects=False,
            verify=self.tls_context if self.tls_context is not None else True,
            **transport_options,
        )
        self._robots = RobotsRules()
        try:
            response = self._fetch_robots(urljoin(self.base_url, "/robots.txt"))
            self._robots = RobotsRules.parse(response.text, self.user_agent)
            base_origin = _origin(urlparse(self.base_url))
            if base_origin is not None:
                self._robots_by_origin[base_origin] = self._robots
            if self._last_robots_origin is not None:
                self._robots_by_origin[self._last_robots_origin] = self._robots
        except Exception as exc:  # pragma: no cover - depends on network state
            LOGGER.warning("Could not read robots.txt for %s: %s", self.base_url, exc)

    def _fetch_robots(self, url: str) -> httpx.Response:
        current_url = url
        self._last_robots_origin = None
        allowed_origins = (self.base_url, *self.allowed_redirect_origins)
        for redirect_count in range(MAX_SAFE_REDIRECTS + 1):
            if not is_allowed_origin_url(current_url, allowed_origins):
                raise RuntimeError(f"refusing robots.txt redirect outside configured source origin: {current_url}")
            response = self._client.get(current_url)
            if response.status_code not in REDIRECT_STATUS_CODES:
                response.raise_for_status()
                self._last_robots_origin = _origin(urlparse(current_url))
                return response
            if redirect_count >= MAX_SAFE_REDIRECTS:
                raise RuntimeError(f"too many redirects while fetching {url}")
            location = response.headers.get("location")
            if not location:
                response.raise_for_status()
                return response
            current_url = urljoin(current_url, location)
        raise RuntimeError(f"too many redirects while fetching {url}")

    def _robots_for_url(self, url: str) -> RobotsRules:
        """Return robots policy for the exact origin that will be requested.

        Redirect targets are separate trust boundaries.  Load their robots.txt
        lazily before the first request and fail closed if that policy cannot be
        verified.  The base origin keeps the historical startup behavior.
        """
        origin = _origin(urlparse(url))
        if origin is None:
            raise RuntimeError(f"cannot determine source origin for {url}")
        base_origin = _origin(urlparse(self.base_url))
        if origin == base_origin:
            return self._robots
        rules = self._robots_by_origin.get(origin)
        if rules is not None:
            return rules
        if origin in self._robots_unavailable:
            raise RuntimeError(f"robots.txt could not be verified for redirect origin: {url}")

        parsed = urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        try:
            response = self._fetch_robots(robots_url)
            rules = RobotsRules.parse(response.text, self.user_agent)
        except Exception as exc:
            self._robots_unavailable.add(origin)
            raise RuntimeError(f"robots.txt could not be verified for redirect origin: {url}") from exc
        self._robots_by_origin[origin] = rules
        if self._last_robots_origin is not None:
            self._robots_by_origin[self._last_robots_origin] = rules
        return rules

    def get(self, url: str) -> str:
        self._guard(url)
        response = self._request("GET", url)
        return response.text

    def post_form(self, url: str, data: dict[str, Any]) -> str:
        self._guard(url)
        response = self._request("POST", url, data=data)
        return response.text

    def _guard(self, url: str) -> None:
        allowed_origins = (self.base_url, *self.allowed_redirect_origins)
        if not is_allowed_origin_url(url, allowed_origins):
            raise RuntimeError(f"refusing URL outside configured source origin: {url}")
        if not self._robots_for_url(url).can_fetch(url):
            raise RuntimeError(f"robots.txt does not allow fetching {url}")

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        if self._retry_not_before:
            raise RuntimeError(f"Source deferred until {self._retry_not_before}")
        if self._access_denials >= 2:
            raise RuntimeError("Source suspended after repeated access refusals")
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.delay_seconds:
            time.sleep(self.delay_seconds - elapsed)
        LOGGER.info("Fetching %s", url)
        current_url = url
        current_method = method
        self._requests_attempted += 1
        try:
            for redirect_count in range(MAX_SAFE_REDIRECTS + 1):
                self._guard(current_url)
                response = self._request_with_retries(current_method, current_url, **kwargs)
                if response.status_code not in REDIRECT_STATUS_CODES:
                    response.raise_for_status()
                    self._requests_succeeded += 1
                    self._visited_urls.append(current_url)
                    return response
                if redirect_count >= MAX_SAFE_REDIRECTS:
                    raise RuntimeError(f"too many redirects while fetching {url}")
                location = response.headers.get("location")
                if not location:
                    response.raise_for_status()
                    return response
                current_url = urljoin(current_url, location)
                if response.status_code == 303 or (
                    response.status_code in {301, 302} and current_method.upper() == "POST"
                ):
                    current_method = "GET"
                    kwargs.pop("data", None)
            raise RuntimeError(f"too many redirects while fetching {url}")
        except Exception:
            self._requests_failed += 1
            raise
        finally:
            self._last_request_at = time.monotonic()

    def _request_with_retries(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        # Retry only transient reads. Access refusals and invalid TLS chains
        # need an operator/source fix, not repeated traffic.
        for attempt in range(4):
            self._http_attempts = getattr(self, '_http_attempts', 0) + 1
            try:
                response = self._client.request(method, url, **kwargs)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt == 3 or "CERTIFICATE_VERIFY_FAILED" in str(exc):
                    raise
            else:
                if response.status_code in {401, 403}:
                    self._access_denials = getattr(self, "_access_denials", 0) + 1
                if response.status_code not in {408, 429, 500, 502, 503, 504}:
                    return response
                requested_delay = retry_after_seconds(response.headers.get("retry-after"))
                if requested_delay > 60 or (attempt == 3 and requested_delay):
                    try:
                        self._retry_not_before = (datetime.now(UTC) + timedelta(seconds=requested_delay)).isoformat()
                    except OverflowError:
                        self._retry_not_before = datetime.max.replace(tzinfo=UTC).isoformat()
                    return response
                if attempt == 3:
                    return response
                response.close()
                time.sleep(max(self.delay_seconds, 2 ** attempt, requested_delay))
                continue
            time.sleep(max(self.delay_seconds, 2 ** attempt))
        raise RuntimeError("Source retry budget exhausted")

    def coverage_metrics(self) -> dict[str, Any]:
        return {
            "fetch_transport": self._fetch_transport,
            "http_attempts_including_retries": getattr(self, '_http_attempts', 0),
            "requests_attempted": self._requests_attempted,
            "requests_succeeded": self._requests_succeeded,
            "requests_failed": self._requests_failed,
            "unique_urls_visited": len(set(self._visited_urls)),
            "retry_not_before": self._retry_not_before,
            "access_denials": self._access_denials,
        }


def listing_signature(sale: dict[str, Any]) -> str | None:
    """Change-signature of a scraped list item (date + price).

    Both values must be present on the current list card before a known detail
    page can be skipped.  A partial signature can match a database row whose
    other value is also absent, even though the list page did not provide
    enough evidence to establish that the listing is unchanged.
    """
    from src.normalize import extract_starting_price, make_sale_signature, parse_french_datetime, source_sale_timezone

    sale_date = parse_french_datetime(sale.get("sale_date"), local_timezone=source_sale_timezone(sale))
    price = extract_starting_price(sale)
    if sale_date is None or price is None:
        return None
    date_part = sale_date.date().isoformat() if sale_date else None
    return make_sale_signature(date_part, price)


def should_fetch_detail(sale: dict[str, Any], known: dict[str, str] | None) -> bool:
    """Incremental scraping: skip the detail page of a listing already enriched
    in DB whose list-page price/date are unchanged. Marks the sale so the
    pipeline can drop it before normalization/enrichment. Sources that only
    expose price/date on the detail page (no list signature) always fetch."""
    from src.source_checkpoint import restore_detail
    if restore_detail(sale):
        return False
    if not known:
        return True
    source_url = str(sale.get("source_url") or "")
    if not source_url or source_url not in known:
        return True
    signature = listing_signature(sale)
    if signature is not None and signature == known[source_url]:
        sale["_known_unchanged"] = True
        return False
    return True


def unique_dicts(items: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for item in items:
        marker = str(item.get(key) or "")
        if not marker or marker in seen:
            continue
        seen.add(marker)
        unique.append(item)
    return unique


def _robots_match(pattern: str, target: str) -> bool:
    end_anchor = pattern.endswith("$")
    raw = pattern[:-1] if end_anchor else pattern
    expression = re.escape(raw).replace(r"\*", ".*")
    if end_anchor:
        expression = f"^{expression}$"
    else:
        expression = f"^{expression}"
    return re.match(expression, target) is not None
