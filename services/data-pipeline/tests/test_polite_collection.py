"""Identifiable, respectful collection: user agent, Crawl-delay, document robots (P2-13)."""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from src import document_politeness, pdf_enrichment, source_task_deadline
from src.config import DEFAULT_USER_AGENT, load_settings
from src.document_politeness import (
    DocumentPoliteness,
    DocumentRobotsDisallowed,
    DocumentRobotsUnavailable,
)
from src.sources import common
from src.sources.common import RobotsRules

BOT = "ImmojudisBot/1.0 (+https://immojudis.com/contact)"


# --- user agent ---------------------------------------------------------------


def test_default_user_agent_identifies_the_bot(monkeypatch) -> None:
    monkeypatch.delenv("AUCTION_USER_AGENT", raising=False)

    assert DEFAULT_USER_AGENT == BOT
    assert load_settings()["user_agent"] == BOT


def test_blank_variable_falls_back_to_the_bot_identity(monkeypatch) -> None:
    # An unset GitHub variable reaches the process as an empty string.
    monkeypatch.setenv("AUCTION_USER_AGENT", "   ")

    assert load_settings()["user_agent"] == BOT


def test_user_agent_can_be_overridden(monkeypatch) -> None:
    monkeypatch.setenv("AUCTION_USER_AGENT", "ImmojudisBot/2.0 (+https://immojudis.com/contact)")

    assert load_settings()["user_agent"].startswith("ImmojudisBot/2.0")


def test_no_browser_user_agent_setting_remains() -> None:
    assert "browser_user_agent" not in load_settings()


def test_no_browser_user_agent_string_in_services() -> None:
    services = Path(__file__).resolve().parents[2]
    offenders = []
    for path in services.rglob("*"):
        if not path.is_file() or path.suffix not in {".py", ".md", ".example", ".txt", ".yml", ".json"}:
            continue
        if any(part in {"__pycache__", "node_modules", ".venv", "data"} for part in path.parts):
            continue
        if path == Path(__file__):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if re.search(r"Mozilla/\d|Chrome/\d|Safari/\d|AUCTION_BROWSER_USER_AGENT", text):
            offenders.append(str(path.relative_to(services)))
    assert offenders == []


def test_workflows_define_the_user_agent_variable() -> None:
    workflows = Path(__file__).resolve().parents[3] / ".github" / "workflows"
    for name in ("data-pipeline.yml", "recompute-existing-sales.yml", "source-coverage-audit.yml"):
        text = (workflows / name).read_text(encoding="utf-8")
        assert (
            "AUCTION_USER_AGENT: ${{ vars.AUCTION_USER_AGENT || 'ImmojudisBot/1.0 (+https://immojudis.com/contact)' }}"
            in text
        ), name


# --- Crawl-delay --------------------------------------------------------------


def test_crawl_delay_is_read_from_the_matching_group() -> None:
    robots = (
        "User-agent: *\nCrawl-delay: 2\nDisallow: /admin\n\n"
        "User-agent: ImmojudisBot\nCrawl-delay: 7.5\nDisallow: /private\n"
    )

    assert RobotsRules.parse(robots, BOT).crawl_delay == 7.5
    assert RobotsRules.parse(robots, "OtherBot/1.0").crawl_delay == 2.0


def test_crawl_delay_is_absent_or_ignored_when_invalid() -> None:
    assert RobotsRules.parse("User-agent: *\nDisallow: /x\n", BOT).crawl_delay is None
    for bad in ("soon", "-3", "nan", "inf", ""):
        assert RobotsRules.parse(f"User-agent: *\nCrawl-delay: {bad}\n", BOT).crawl_delay is None


def test_crawl_delay_does_not_change_allow_and_disallow_rules() -> None:
    rules = RobotsRules.parse("User-agent: *\nCrawl-delay: 4\nDisallow: /admin\nAllow: /admin/public\n", BOT)

    assert rules.crawl_delay == 4.0
    assert rules.can_fetch("https://example.test/page")
    assert not rules.can_fetch("https://example.test/admin/x")
    assert rules.can_fetch("https://example.test/admin/public/x")


def test_crawl_delay_only_group_is_still_selected() -> None:
    robots = "User-agent: ImmojudisBot\nCrawl-delay: 9\n\nUser-agent: *\nDisallow: /a\n"

    parsed = RobotsRules.parse(robots, BOT)
    assert parsed.crawl_delay == 9.0
    assert parsed.can_fetch("https://example.test/a")


class _Response:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text
        self.headers: dict[str, str] = {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def close(self) -> None:
        return None


def _frozen_client(monkeypatch, robots_text: str, *, delay_seconds: float):
    clock = {"now": 100.0}
    slept: list[float] = []
    monkeypatch.setattr(source_task_deadline.time, "monotonic", lambda: clock["now"])

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        clock["now"] += seconds

    monkeypatch.setattr(common.time, "sleep", sleep)

    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def get(self, url: str, **kwargs: object) -> _Response:
            del kwargs
            return _Response(200, robots_text if url.endswith("/robots.txt") else "page")

        def request(self, method: str, url: str, **kwargs: object) -> _Response:
            del method
            return self.get(url, **kwargs)

    monkeypatch.setattr(common.httpx, "Client", Client)
    client = common.PoliteHttpClient(
        base_url="https://source.example.test",
        user_agent=BOT,
        delay_seconds=delay_seconds,
        timeout_seconds=1,
    )
    return client, slept


def test_polite_client_waits_for_the_published_crawl_delay(monkeypatch) -> None:
    client, slept = _frozen_client(monkeypatch, "User-agent: *\nCrawl-delay: 6\n", delay_seconds=1.5)

    client.get("https://source.example.test/a")
    client.get("https://source.example.test/b")

    assert slept == [6.0]


def test_polite_client_keeps_its_own_delay_when_it_is_longer(monkeypatch) -> None:
    client, slept = _frozen_client(monkeypatch, "User-agent: *\nCrawl-delay: 1\n", delay_seconds=3.0)

    client.get("https://source.example.test/a")
    client.get("https://source.example.test/b")

    assert slept == [3.0]


def test_polite_client_without_crawl_delay_uses_the_configured_delay(monkeypatch) -> None:
    client, slept = _frozen_client(monkeypatch, "User-agent: *\nDisallow: /x\n", delay_seconds=1.5)

    client.get("https://source.example.test/a")
    client.get("https://source.example.test/b")

    assert slept == [1.5]


# --- document downloads -------------------------------------------------------


@pytest.fixture
def politeness_on(monkeypatch):
    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(round(seconds, 6))
        self.now += seconds


def _politeness(robots: dict[str, httpx.Response | Exception], clock: FakeClock, fetched: list[str]):
    def fetch(robots_url: str) -> httpx.Response:
        fetched.append(robots_url)
        result = robots[robots_url]
        if isinstance(result, Exception):
            raise result
        return result

    return DocumentPoliteness(user_agent=lambda: BOT, fetch_robots=fetch, sleep=clock.sleep, clock=clock)


def _text(status: int, body: str = "") -> httpx.Response:
    return httpx.Response(status, text=body, headers={"content-type": "text/plain"})


def test_robots_disallow_blocks_the_document(politeness_on) -> None:
    clock, fetched = FakeClock(), []
    politeness = _politeness(
        {"https://docs.example.test/robots.txt": _text(200, "User-agent: *\nDisallow: /private/")}, clock, fetched
    )

    politeness.wait_turn("https://docs.example.test/public/a.pdf")
    with pytest.raises(DocumentRobotsDisallowed):
        politeness.wait_turn("https://docs.example.test/private/b.pdf")

    assert fetched == ["https://docs.example.test/robots.txt"]


def test_same_host_requests_are_spaced_by_at_least_one_and_a_half_seconds(politeness_on) -> None:
    clock, fetched = FakeClock(), []
    politeness = _politeness({"https://docs.example.test/robots.txt": _text(404)}, clock, fetched)

    for name in ("a", "b", "c"):
        politeness.wait_turn(f"https://docs.example.test/{name}.pdf")

    # The robots request itself counts, so even the first document waits.
    assert clock.slept == [1.5, 1.5, 1.5]


def test_other_hosts_do_not_wait_for_each_other(politeness_on) -> None:
    clock, fetched = FakeClock(), []
    politeness = _politeness(
        {
            "https://one.example.test/robots.txt": _text(404),
            "https://two.example.test/robots.txt": _text(404),
        },
        clock,
        fetched,
    )

    politeness.wait_turn("https://one.example.test/a.pdf")
    clock.slept.clear()
    politeness.wait_turn("https://two.example.test/a.pdf")

    assert clock.slept == [1.5]  # only the host's own robots fetch delays its first document


def test_crawl_delay_raises_the_document_delay(politeness_on) -> None:
    clock, fetched = FakeClock(), []
    politeness = _politeness(
        {"https://docs.example.test/robots.txt": _text(200, "User-agent: *\nCrawl-delay: 8\n")}, clock, fetched
    )

    politeness.wait_turn("https://docs.example.test/a.pdf")
    politeness.wait_turn("https://docs.example.test/b.pdf")

    assert clock.slept == [8.0, 8.0]


def test_elapsed_time_counts_toward_the_delay(politeness_on) -> None:
    clock, fetched = FakeClock(), []
    politeness = _politeness({"https://docs.example.test/robots.txt": _text(404)}, clock, fetched)
    politeness.wait_turn("https://docs.example.test/a.pdf")
    clock.slept.clear()

    clock.now += 1.0  # a slow download already took 1 s
    politeness.wait_turn("https://docs.example.test/b.pdf")

    assert clock.slept == [0.5]


@pytest.mark.parametrize(
    "response",
    [
        httpx.ConnectTimeout("robots timeout"),
        _text(503, "down"),
        _text(403, "denied"),
        _text(200, "<!doctype html><html><body>Just a moment...</body></html>"),
    ],
)
def test_unverifiable_robots_blocks_the_download_and_is_remembered(politeness_on, response) -> None:
    clock, fetched = FakeClock(), []
    politeness = _politeness({"https://docs.example.test/robots.txt": response}, clock, fetched)

    for _ in range(2):
        with pytest.raises(DocumentRobotsUnavailable):
            politeness.wait_turn("https://docs.example.test/a.pdf")

    assert fetched == ["https://docs.example.test/robots.txt"]


def test_disabled_politeness_never_fetches_or_waits(monkeypatch) -> None:
    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", False)
    clock, fetched = FakeClock(), []
    politeness = _politeness({}, clock, fetched)

    politeness.wait_turn("https://docs.example.test/a.pdf")

    assert fetched == [] and clock.slept == []


def test_document_downloads_check_robots_before_every_hop(politeness_on, monkeypatch) -> None:
    sent: list[str] = []
    turns: list[str] = []

    class Redirect:
        status_code = 302
        headers = {"location": "https://cdn.example.test/file.pdf"}

    class Ok:
        status_code = 200
        headers: dict[str, str] = {}

    def send(url: str, **kwargs):
        sent.append(url)
        return Redirect() if url.startswith("https://docs.") else Ok()

    class Recorder:
        def wait_turn(self, url: str) -> None:
            turns.append(url)

    monkeypatch.setattr(pdf_enrichment, "_send_pinned_document_request", send)
    monkeypatch.setattr(pdf_enrichment, "_DOCUMENT_POLITENESS", Recorder())

    pdf_enrichment._download_document_response(
        "https://docs.example.test/file.pdf", headers={}, timeout_seconds=5
    )

    assert turns == sent == ["https://docs.example.test/file.pdf", "https://cdn.example.test/file.pdf"]


def test_robots_disallowed_document_is_a_permanent_failure_without_a_request(politeness_on, monkeypatch) -> None:
    sent: list[str] = []
    monkeypatch.setattr(pdf_enrichment, "_send_pinned_document_request", lambda url, **kw: sent.append(url))

    class Refuse:
        def wait_turn(self, url: str) -> None:
            raise DocumentRobotsDisallowed(f"robots.txt does not allow fetching {url}")

    monkeypatch.setattr(pdf_enrichment, "_DOCUMENT_POLITENESS", Refuse())

    with pytest.raises(pdf_enrichment.PermanentDocumentFailure) as error:
        pdf_enrichment._download_document_response(
            "https://docs.example.test/private/a.pdf", headers={}, timeout_seconds=5
        )

    assert error.value.reason == "robots_disallowed"
    assert sent == []


def test_robots_fetch_uses_the_same_pinned_transport_and_identity(monkeypatch) -> None:
    seen: dict[str, object] = {}

    def send(url: str, *, headers: dict[str, str], timeout_seconds: float):
        seen.update(url=url, headers=headers, timeout=timeout_seconds)
        return _text(404)

    monkeypatch.setattr(pdf_enrichment, "_send_pinned_document_request", send)
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: {"user_agent": BOT, "request_timeout_seconds": 7})

    pdf_enrichment._fetch_document_robots("https://docs.example.test/robots.txt")

    assert seen["url"] == "https://docs.example.test/robots.txt"
    assert seen["headers"]["User-Agent"] == BOT
    assert seen["timeout"] == 7.0
