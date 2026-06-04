from __future__ import annotations

from dataclasses import dataclass
import logging
import re
import time
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx


LOGGER = logging.getLogger(__name__)


@dataclass
class ScrapeResult:
    sales: list[dict[str, Any]]
    errors: list[str]


@dataclass
class RobotsRules:
    rules: tuple[tuple[str, str], ...] = ()

    @classmethod
    def parse(cls, text: str, user_agent: str) -> "RobotsRules":
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

    def __post_init__(self) -> None:
        self._last_request_at = 0.0
        self._client = httpx.Client(
            headers={"User-Agent": self.user_agent, "Accept": "text/html,application/xhtml+xml"},
            timeout=self.timeout_seconds,
            follow_redirects=True,
        )
        self._robots = RobotsRules()
        try:
            response = self._client.get(urljoin(self.base_url, "/robots.txt"))
            response.raise_for_status()
            self._robots = RobotsRules.parse(response.text, self.user_agent)
        except Exception as exc:  # pragma: no cover - depends on network state
            LOGGER.warning("Could not read robots.txt for %s: %s", self.base_url, exc)

    def get(self, url: str) -> str:
        self._guard(url)
        response = self._request("GET", url)
        return response.text

    def post_form(self, url: str, data: dict[str, Any]) -> str:
        self._guard(url)
        response = self._request("POST", url, data=data)
        return response.text

    def _guard(self, url: str) -> None:
        if not self._robots.can_fetch(url):
            raise RuntimeError(f"robots.txt does not allow fetching {url}")

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.delay_seconds:
            time.sleep(self.delay_seconds - elapsed)
        LOGGER.info("Fetching %s", url)
        try:
            response = self._client.request(method, url, **kwargs)
        finally:
            self._last_request_at = time.monotonic()
        response.raise_for_status()
        return response


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
