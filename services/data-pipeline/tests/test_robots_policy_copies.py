"""Copie de robots.txt réutilisée pendant une panne passagère (RFC 9309 §2.4), 24 heures au plus.

Enchères Immobilières, 16/11/2026 : 7 passages sur 14 arrêtés en 50 s, avant toute requête, sur un robots.txt
momentanément injoignable. La dernière politique vérifiée sert maintenant pendant une panne passagère ; un refus
et une copie trop vieille gardent l'arrêt.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from src.sources import common, robots_policy_copies
from tests.test_sources_common import _freeze_source_clock, _patch_http_client, _Response

USER_AGENT = "immojudis-test"
ORIGIN = "https://source.example:443"


@pytest.fixture(autouse=True)
def _no_installed_copy():
    robots_policy_copies.install([])
    yield
    robots_policy_copies.install([])


def _stored_copy(age: timedelta, *, rules=(("disallow", "/private"),), crawl_delay=7.0, user_agent=USER_AGENT):
    return robots_policy_copies.RobotsPolicyCopy(
        rules=tuple(rules),
        crawl_delay=crawl_delay,
        verified_at=datetime.now(UTC) - age,
        user_agent_digest=robots_policy_copies.user_agent_digest(user_agent),
    ).to_json()


def _install(age: timedelta, **kwargs) -> dict:
    stored = _stored_copy(age, **kwargs)
    robots_policy_copies.install([{ORIGIN: stored}])
    return stored


def _client(**kwargs) -> common.PoliteHttpClient:
    return common.PoliteHttpClient(
        base_url="https://source.example",
        user_agent=USER_AGENT,
        delay_seconds=kwargs.pop("delay_seconds", 0),
        timeout_seconds=1,
        **kwargs,
    )


ROBOTS_TIMEOUTS = [httpx.ReadTimeout("robots timeout")] * 4


@pytest.mark.parametrize("robots_failure", [ROBOTS_TIMEOUTS, [httpx.ConnectError("refused")] * 4, [_Response(503)]])
def test_a_copy_younger_than_24_hours_is_reused_during_a_passing_outage(monkeypatch, robots_failure) -> None:
    _freeze_source_clock(monkeypatch)
    _install(timedelta(hours=13))
    clients = _patch_http_client(monkeypatch, [[*robots_failure, _Response(200, text="catalogue")]])

    client = _client()

    assert client.get("https://source.example/catalogue") == "catalogue"
    assert clients[0].calls[-1] == ("GET", "https://source.example/catalogue")
    metrics = client.coverage_metrics()
    assert metrics["robots_policy"]["state"] == "reused_copy"
    assert 12.9 < metrics["robots_policy"]["copy_age_hours"] < 13.1
    # La copie réutilisée est republiée telle quelle (même date de lecture) : elle n'est pas rajeunie.
    assert metrics["robots_policy_copies"][ORIGIN]["verified_at"] == (
        robots_policy_copies.installed_json()[ORIGIN]["verified_at"]
    )


def test_the_reused_copy_logs_its_age(monkeypatch, caplog) -> None:
    _freeze_source_clock(monkeypatch)
    _install(timedelta(hours=5))
    _patch_http_client(monkeypatch, [list(ROBOTS_TIMEOUTS)])

    with caplog.at_level("WARNING"):
        _client()

    assert any("reusing the policy verified 5.0 h ago" in record.getMessage() for record in caplog.records)


def test_the_disallow_rules_of_the_reused_copy_apply(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    _install(timedelta(hours=2), rules=(("disallow", "/private"),))
    clients = _patch_http_client(monkeypatch, [list(ROBOTS_TIMEOUTS)])
    client = _client()

    with pytest.raises(RuntimeError, match="robots.txt does not allow"):
        client.get("https://source.example/private/page")
    assert ("GET", "https://source.example/private/page") not in clients[0].calls


def test_the_crawl_delay_of_the_reused_copy_is_respected(monkeypatch) -> None:
    clock = _freeze_source_clock(monkeypatch)
    _install(timedelta(hours=2), crawl_delay=7.0)
    _patch_http_client(monkeypatch, [[*ROBOTS_TIMEOUTS, _Response(200, text="one"), _Response(200, text="two")]])
    client = _client(delay_seconds=1)
    monkeypatch.setattr(common.time, "monotonic", lambda: clock["now"])

    client.get("https://source.example/one")
    before = clock["now"]
    client.get("https://source.example/two")

    assert client._request_delay("https://source.example/two") == 7.0
    assert clock["now"] - before == pytest.approx(7.0)


def test_a_copy_older_than_24_hours_keeps_the_source_closed(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    _install(timedelta(hours=24, minutes=1))
    clients = _patch_http_client(monkeypatch, [list(ROBOTS_TIMEOUTS)])
    client = _client()

    with pytest.raises(common.RobotsUnavailableError, match="could not be verified"):
        client.get("https://source.example/catalogue")
    assert clients[0].calls == [("GET", "https://source.example/robots.txt")] * 4
    assert client.coverage_metrics()["robots_policy"]["state"] == "unavailable"
    assert client.coverage_metrics()["robots_policy_copies"] == {}


@pytest.mark.parametrize(
    "robots_response",
    [
        _Response(403, text="forbidden"),
        _Response(401, text="unauthorized"),
        _Response(200, text="<!doctype html><html><body>Just a moment...</body></html>"),
    ],
)
def test_a_refusal_never_falls_back_on_the_copy(monkeypatch, robots_response) -> None:
    _install(timedelta(hours=1))
    clients = _patch_http_client(monkeypatch, [[robots_response]])
    client = _client()

    with pytest.raises(common.RobotsAccessRefusedError):
        client.get("https://source.example/catalogue")
    assert clients[0].calls == [("GET", "https://source.example/robots.txt")]
    assert client.coverage_metrics()["robots_policy"]["state"] == "refused"


@pytest.mark.parametrize("status_code", [400, 429])
def test_another_client_error_does_not_fall_back_on_the_copy(monkeypatch, status_code) -> None:
    _install(timedelta(hours=1))
    _patch_http_client(monkeypatch, [[_Response(status_code)]])
    client = _client()

    with pytest.raises(common.RobotsUnavailableError):
        client.get("https://source.example/catalogue")
    assert client.coverage_metrics()["robots_policy"]["transient"] is False


def test_a_copy_made_for_another_user_agent_is_not_reused(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    _install(timedelta(hours=1), user_agent="another-bot")
    _patch_http_client(monkeypatch, [list(ROBOTS_TIMEOUTS)])
    client = _client()

    with pytest.raises(common.RobotsUnavailableError):
        client.get("https://source.example/catalogue")


def test_without_a_stored_copy_the_source_stays_closed(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    _patch_http_client(monkeypatch, [list(ROBOTS_TIMEOUTS)])
    client = _client()

    with pytest.raises(common.RobotsUnavailableError):
        client.get("https://source.example/catalogue")
    status = client.coverage_metrics()["robots_policy"]
    assert status["state"] == "unavailable"
    assert status["error_type"] == "ReadTimeout"
    assert status["transient"] is True
    assert "robots.txt could not be verified" in status["error"]


def test_a_redirect_origin_reuses_its_own_copy(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    robots_policy_copies.install([{"https://cdn.example:443": _stored_copy(timedelta(hours=3), rules=())}])
    clients = _patch_http_client(
        monkeypatch,
        [[
            _Response(200, text="User-agent: *\nAllow: /"),
            _Response(302, location="https://cdn.example/landing"),
            *ROBOTS_TIMEOUTS,
            _Response(200, text="landing"),
        ]],
    )
    client = common.PoliteHttpClient(
        base_url="https://source.example",
        allowed_redirect_origins=("https://cdn.example",),
        user_agent=USER_AGENT,
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert client.get("https://source.example/catalogue") == "landing"
    assert clients[0].calls[-1] == ("GET", "https://cdn.example/landing")
    assert client.coverage_metrics()["robots_policy"] == {"state": "verified"}


def test_a_verified_policy_is_published_for_the_next_run(monkeypatch) -> None:
    _patch_http_client(monkeypatch, [[_Response(200, text="User-agent: *\nDisallow: /private\nCrawl-delay: 3")]])
    before = datetime.now(UTC)

    client = _client()

    metrics = client.coverage_metrics()
    assert metrics["robots_policy"] == {"state": "verified"}
    stored = metrics["robots_policy_copies"][ORIGIN]
    assert stored["rules"] == [["disallow", "/private"]]
    assert stored["crawl_delay"] == 3.0
    assert datetime.fromisoformat(stored["verified_at"]) >= before
    # Ce qui est publié se relit tel quel au passage suivant.
    robots_policy_copies.install([metrics["robots_policy_copies"]])
    assert robots_policy_copies.recall(ORIGIN, USER_AGENT) is not None


def test_robots_txt_gets_more_patience_than_a_page_of_the_source(monkeypatch) -> None:
    # Enchères Immobilières n'a que 2 essais pour ses pages : robots.txt en a 4, espacés de 5, 10 puis 20 s.
    clock = _freeze_source_clock(monkeypatch)
    clients = _patch_http_client(
        monkeypatch,
        [[*[httpx.ReadTimeout("robots timeout")] * 3, _Response(200, text="User-agent: *\nAllow: /")]],
    )

    client = _client(max_attempts=2)

    assert client.coverage_metrics()["robots_policy"] == {"state": "verified"}
    assert clients[0].calls == [("GET", "https://source.example/robots.txt")] * 4
    assert clock["now"] - 100.0 == pytest.approx(5 + 10 + 20)


def test_a_page_keeps_its_own_retry_budget(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    clients = _patch_http_client(
        monkeypatch,
        [[_Response(200, text="User-agent: *\nAllow: /"), *[httpx.ReadTimeout("page timeout")] * 2]],
    )
    client = _client(max_attempts=2)

    with pytest.raises(httpx.ReadTimeout):
        client.get("https://source.example/catalogue")
    assert clients[0].calls.count(("GET", "https://source.example/catalogue")) == 2


def test_stored_copies_keep_the_most_recent_one_and_drop_those_older_than_24_hours() -> None:
    now = datetime.now(UTC)
    old = _stored_copy(timedelta(hours=20))
    recent = _stored_copy(timedelta(hours=1), rules=(("disallow", "/new"),))
    stale = _stored_copy(timedelta(hours=30))

    merged = robots_policy_copies.merge_copies(
        {ORIGIN: old, "https://other.example:443": stale}, {ORIGIN: recent}, None, {"bad": {"rules": "x"}}, now=now
    )

    assert merged == {ORIGIN: recent}


@pytest.mark.parametrize(
    "stored",
    [
        {"verified_at": "2026-11-16T10:00:00", "rules": [], "crawl_delay": None, "user_agent_digest": "x"},
        {"verified_at": "2026-11-16T10:00:00+00:00", "rules": [["noindex", "/"]], "crawl_delay": None,
         "user_agent_digest": "x"},
        {"verified_at": "2026-11-16T10:00:00+00:00", "rules": [], "crawl_delay": -1, "user_agent_digest": "x"},
        {"verified_at": "2026-11-16T10:00:00+00:00", "rules": [], "crawl_delay": None},
        "not a copy",
    ],
)
def test_a_malformed_stored_copy_is_ignored(stored) -> None:
    assert robots_policy_copies.RobotsPolicyCopy.from_json(stored) is None


def test_an_isolated_collector_receives_the_stored_copies(monkeypatch) -> None:
    import io
    import json

    from src import scrape_worker, source_process
    from src.sources.common import ScrapeResult

    stored = _install(timedelta(hours=2))
    sent: dict[str, str] = {}

    def communicate(command, *, input_text, **kwargs):
        sent["payload"] = input_text
        return json.dumps({"ok": True, "result": {"sales": [], "errors": [], "coverage": {}}}), "", 0, 0.1

    monkeypatch.setattr(source_process, "_communicate_with_timeout", communicate)
    source_process.run_source_in_subprocess("avoventes", timeout_seconds=10)
    payload = json.loads(sent["payload"])
    assert payload["robots_policy_copies"] == {ORIGIN: stored}

    # Côté enfant : la copie reçue est installée avant la collecte.
    robots_policy_copies.install([])
    seen: dict[str, object] = {}

    def collect(source, received):
        seen["copy"] = robots_policy_copies.recall(ORIGIN, USER_AGENT)
        return ScrapeResult([], [], {})

    monkeypatch.setattr(scrape_worker, "collect_source", collect)
    monkeypatch.setattr("sys.stdin", io.StringIO(sent["payload"]))
    assert scrape_worker.main(["avoventes"]) == 0
    assert seen["copy"] is not None


def test_a_scheduled_run_installs_the_copies_kept_by_the_previous_runs(monkeypatch) -> None:
    from contextlib import nullcontext

    from src import main

    stored = _stored_copy(timedelta(hours=4))

    class Db:
        def execute(self, sql, params=None):
            assert "from public.auction_source_state" in sql
            assert params == ("robots_policy_copies",)
            return self

        def fetchall(self):
            return [({ORIGIN: stored},), (None,)]

    monkeypatch.setattr(main, "postgres_connect", lambda url, **kwargs: nullcontext(Db()))
    main._install_stored_robots_policies({"supabase_db_url": "postgresql://db"})
    assert robots_policy_copies.installed_json() == {ORIGIN: stored}

    def unreachable(url, **kwargs):
        raise OSError("database unreachable")

    monkeypatch.setattr(main, "postgres_connect", unreachable)
    main._install_stored_robots_policies({"supabase_db_url": "postgresql://db"})
    assert robots_policy_copies.installed_json() == {}
