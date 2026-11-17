"""Voie d'enrichissement parallèle (décision du 17/11/2026) : réglages, familles, verrous, tours par hôte, robots.txt
commun, publication sous ``lock_timeout`` et source injoignable."""

from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from src import (
    autonomous_runner,
    host_turn,
    pdf_enrichment,
    pipeline_usage,
    queued_runner,
    source_detail_worker,
    source_suspension,
    source_traffic,
)
from src.catalogue_lock import CatalogueLockTimeout, catalogue_writer_lock
from src.enrichment_lane_settings import LaneSettingsError, lane_settings
from src.host_turn import HostTurns, HostTurnWaitExceeded
from src.pdf_deadline import PdfDeadlineExceeded, pdf_deadline_scope
from src.pipeline_usage import QueueJobDeferred
from src.source_task_deadline import SourceTaskDeadlineExceeded, source_task_deadline_scope
from src.sources import common, robots_policy_copies, robots_policy_store
from src.sources.cloud_transport import SOURCE_HOSTS
from src.sources.robots_policy_copies import RobotsFailure, RobotsPolicyCopy, SharedPolicy
from tests.test_sources_common import _freeze_source_clock, _patch_http_client, _Response

ROOT = Path(__file__).resolve().parents[3]
USER_AGENT = "immojudis-test"


# --- Réglages ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "env,expected",
    [
        ({}, (0, "exclusive", False)),
        ({"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "0"}, (0, "exclusive", False)),
        ({"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "2"}, (2, "shared", True)),
        ({"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "3", "PIPELINE_HOST_TURNS": "on"}, (3, "shared", True)),
        ({"PIPELINE_WORKER_LOCK_MODE": "shared"}, (0, "shared", False)),
    ],
)
def test_lane_settings_follow_the_number_of_general_workers(monkeypatch, env, expected) -> None:
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    settings = lane_settings()
    assert (settings.general_workers, settings.lock_mode, settings.host_turns) == expected


@pytest.mark.parametrize(
    "env,message",
    [
        ({"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "2", "PIPELINE_WORKER_LOCK_MODE": "exclusive"}, "needs PIPELINE_WORKER_LOCK_MODE=shared"),
        ({"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "1", "PIPELINE_HOST_TURNS": "off"}, "needs PIPELINE_HOST_TURNS=on"),
        ({"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "-1"}, "from 0 to 3"),
        ({"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "deux"}, "integer"),
        ({"PIPELINE_WORKER_LOCK_MODE": "partagé"}, "exclusive or shared"),
        ({"PIPELINE_HOST_TURNS": "peut-être"}, "on or off"),
    ],
)
def test_incoherent_or_invalid_lane_settings_are_refused_with_a_clear_message(monkeypatch, env, message) -> None:
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(LaneSettingsError, match=message):
        lane_settings()


def test_the_workflow_passes_the_lane_settings_from_repository_variables() -> None:
    text = (ROOT / ".github" / "workflows" / "data-pipeline.yml").read_text(encoding="utf-8")
    assert "PIPELINE_ENRICHMENT_GENERAL_WORKERS: ${{ vars.PIPELINE_ENRICHMENT_GENERAL_WORKERS || '2' }}" in text
    assert "PIPELINE_WORKER_LOCK_MODE: ${{ vars.PIPELINE_WORKER_LOCK_MODE }}" in text
    assert "PIPELINE_HOST_TURNS: ${{ vars.PIPELINE_HOST_TURNS }}" in text


# --- Familles des travailleurs ------------------------------------------------------------------------------------


@pytest.mark.parametrize("family", [queued_runner.SOURCE_DETAIL_FAMILY, queued_runner.ENRICHMENT_FAMILY])
def test_a_lane_worker_claims_its_own_family_only(monkeypatch, family) -> None:
    claims: list[str] = []
    monkeypatch.setattr(queued_runner, "_read_due_enrichment_family_counts", lambda: pytest.fail("no ratio read"))

    def batch(*, limit, family, provider_clients=None):
        claims.append(family)
        return 1 if len(claims) < 6 else 0

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", batch)

    queued_runner.run_enrichment_queue_worker(max_jobs=50, budget_seconds=600, family=family)

    assert claims and set(claims) == {family}


def test_the_mixed_worker_still_alternates_both_families(monkeypatch) -> None:
    claims: list[str] = []
    monkeypatch.setattr(queued_runner, "_read_due_enrichment_family_counts", lambda: {})

    def batch(*, limit, family, provider_clients=None):
        claims.append(family)
        return 1 if len(claims) < 6 else 0

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", batch)
    queued_runner.run_enrichment_queue_worker(max_jobs=50, budget_seconds=600)
    assert set(claims) == {queued_runner.SOURCE_DETAIL_FAMILY, queued_runner.ENRICHMENT_FAMILY}


def test_the_general_worker_stops_after_the_first_ai_budget_refusal(monkeypatch, tmp_path) -> None:
    from src.enrichment_queue_limits import ENRICHMENT_WORKER_REPORT_ENV, read_worker_report

    report = tmp_path / "report.json"
    monkeypatch.setenv(ENRICHMENT_WORKER_REPORT_ENV, str(report))
    claims: list[str] = []

    def batch(*, limit, family, provider_clients=None):
        claims.append(family)
        queued_runner._WORKER_LLM_BUDGET_EXHAUSTED.set(True)
        return 1

    monkeypatch.setattr(queued_runner, "run_enrichment_queue_batch", batch)
    queued_runner.run_enrichment_queue_worker(max_jobs=50, budget_seconds=600, family="enrichment")

    assert claims == ["enrichment"]
    written = read_worker_report(str(report))
    assert written["stop_reason"] == "llm_budget_exhausted"
    assert written["family"] == "enrichment"


def test_a_family_worker_is_refused_outside_the_parallel_lane(monkeypatch, capsys) -> None:
    import sys

    monkeypatch.setattr(sys, "argv", ["src.queued_runner", "--enrichment-only", "--family", "enrichment"])
    monkeypatch.setattr(queued_runner, "catalogue_writer_lock", lambda **_k: pytest.fail("no lock without settings"))
    assert queued_runner.run_with_catalogue_lock() == queued_runner.LANE_SETTINGS_EXIT_CODE
    assert "PIPELINE_ENRICHMENT_GENERAL_WORKERS" in capsys.readouterr().out


# --- Publication sous lock_timeout ------------------------------------------------------------------------------


class _LockTimeout(Exception):
    sqlstate = "55P03"


def test_a_publication_lock_timeout_is_a_deferral_without_attempt() -> None:
    wrapped = RuntimeError("publication failed")
    wrapped.__cause__ = _LockTimeout("canceling statement due to lock timeout")
    deferral = pipeline_usage.publication_lock_deferral(wrapped)
    assert isinstance(deferral, QueueJobDeferred)
    assert deferral.next_attempt_at > datetime.now(UTC) + timedelta(minutes=4)
    assert pipeline_usage.publication_lock_deferral(RuntimeError("boom")) is None


def test_a_general_publication_stopped_by_lock_timeout_keeps_its_attempt(monkeypatch) -> None:
    sale = SimpleNamespace(
        source_name="vench", source_url="https://example.test/sale", source_urls=[], documents=[], status="upcoming",
        raw_payload={}, sale_date=None,
    )
    job = {"id": "job-1", "job_type": "fact_claims_none", "source_url": sale.source_url, "attempt_count": 1}
    deferred, finished = [], []
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"supabase_db_url": "", "llm_enabled": True})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _url: sale)
    monkeypatch.setattr(queued_runner, "require_encheres_publiques_sale_access", lambda **_k: None)
    monkeypatch.setattr(queued_runner, "require_sale_not_withdrawn", lambda *_a: None)
    monkeypatch.setattr(queued_runner, "is_expired", lambda _sale: False)
    monkeypatch.setattr(queued_runner, "sale_needs_position", lambda _sale: False)
    monkeypatch.setattr(queued_runner, "derive_sale_facts", lambda _sale: None)

    def upsert(*_a, **_k):
        raise _LockTimeout("canceling statement due to lock timeout")

    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", upsert)
    monkeypatch.setattr(queued_runner, "defer_budget_jobs", lambda jobs, error: deferred.append((jobs, error)))
    monkeypatch.setattr(queued_runner, "_finish_job", lambda job, **kwargs: finished.append(kwargs) or True)

    queued_runner.run_enrichment_queue_batch(limit=1, family="enrichment", claimed_jobs=[job])

    assert finished == []
    assert len(deferred) == 1 and "lock_timeout" in str(deferred[0][1])


def test_a_source_detail_publication_stopped_by_lock_timeout_releases_its_claim(monkeypatch) -> None:
    released = []
    job = {"id": "job-1", "job_type": "source_detail", "source_url": "https://example.test/a",
           "detail_source_name": "vench", "detail_source_url": "https://example.test/a", "attempt_count": 1}
    monkeypatch.setattr(source_detail_worker, "source_detail_source_enabled", lambda *_a: True)
    monkeypatch.setattr(source_detail_worker, "fetch_sale_for_data_refresh", lambda _url: SimpleNamespace())
    monkeypatch.setattr(source_detail_worker, "complete_already_verified_detail_job", lambda *_a: None)
    monkeypatch.setattr(source_detail_worker, "fetch_public_detail", lambda *_a: ("u", "b", {"title": "x"}))
    monkeypatch.setattr(source_detail_worker, "prepare_source_revision", lambda *_a: SimpleNamespace())

    def publish(*_a):
        raise _LockTimeout("canceling statement due to lock timeout")

    monkeypatch.setattr(source_detail_worker, "publish_source_revision", publish)
    monkeypatch.setattr(source_detail_worker, "_finish_job", lambda *_a, **_k: pytest.fail("no attempt spent"))
    monkeypatch.setattr(
        source_detail_worker, "release_source_detail_job_without_attempt",
        lambda job, **kwargs: released.append(kwargs),
    )

    assert source_detail_worker.process_source_detail_job(job, settings={"supabase_db_url": "x"}, clients={}) is False
    assert len(released) == 1 and "lock_timeout" in released[0]["reason"]


# --- Bases jetables -----------------------------------------------------------------------------------------------


@pytest.fixture
def database_url() -> str:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    host = str(conninfo_to_dict(url).get("host") or "").split(",", 1)[0]
    if host not in {"127.0.0.1", "localhost"}:
        pytest.fail(f"Refusing non-local lock test database: {host}")
    return url


def _connect(url: str):
    connection = psycopg.connect(url, autocommit=True)
    return connection


# --- Modes du verrou du catalogue et du tour des sources -------------------------------------------------------


def test_shared_catalogue_locks_coexist_and_an_exclusive_one_waits_for_all_of_them(database_url) -> None:
    release = threading.Event()
    held = threading.Barrier(3)

    def worker() -> None:
        with catalogue_writer_lock(database_url, label="lane worker", wait_seconds=5, mode="shared",
                                   heartbeat_seconds=0):
            held.wait(timeout=10)
            release.wait(timeout=10)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    held.wait(timeout=10)  # both shared holders at once

    with pytest.raises(CatalogueLockTimeout):
        with catalogue_writer_lock(database_url, label="collection", wait_seconds=0.3, poll_seconds=0.1,
                                   heartbeat_seconds=0):
            pytest.fail("an exclusive writer must wait for the shared workers")

    obtained: dict[str, float] = {}

    def collection() -> None:
        with catalogue_writer_lock(database_url, label="collection", wait_seconds=10, poll_seconds=0.2,
                                   heartbeat_seconds=0):
            obtained["at"] = time.monotonic()

    waiter = threading.Thread(target=collection)
    waiter.start()
    time.sleep(0.5)
    assert "at" not in obtained
    released_at = time.monotonic()
    release.set()
    for thread in threads:
        thread.join(timeout=10)
    waiter.join(timeout=10)
    assert obtained["at"] >= released_at


def test_a_shared_request_fails_while_an_exclusive_one_waits(database_url) -> None:
    """Une collecte qui attend le verrou n'est jamais doublée par un travailleur de la voie : pas de famine."""
    release = threading.Event()
    started = threading.Event()

    def worker() -> None:
        with catalogue_writer_lock(database_url, label="lane worker", wait_seconds=5, mode="shared",
                                   heartbeat_seconds=0):
            started.set()
            release.wait(timeout=10)

    first = threading.Thread(target=worker)
    first.start()
    assert started.wait(timeout=10)
    def waiting_collection() -> None:
        with catalogue_writer_lock(database_url, label="collection", wait_seconds=10, poll_seconds=5,
                                   heartbeat_seconds=0):
            pass

    collection = threading.Thread(target=waiting_collection)
    collection.start()
    time.sleep(0.5)  # the collection now waits in PostgreSQL's queue
    try:
        with pytest.raises(CatalogueLockTimeout):
            with catalogue_writer_lock(database_url, label="another lane worker", wait_seconds=0, mode="shared",
                                       heartbeat_seconds=0):
                pytest.fail("a new shared worker must not pass the waiting collection")
        turns = source_traffic.SourceTrafficTurns(database_url, mode="shared")
        assert turns.try_take() is True  # the source turn is another key: free
    finally:
        release.set()
        first.join(timeout=10)
        collection.join(timeout=10)


def test_shared_source_turns_coexist_and_yield_to_a_waiting_collection(database_url) -> None:
    first = source_traffic.SourceTrafficTurns(database_url, mode="shared")
    second = source_traffic.SourceTrafficTurns(database_url, mode="shared")
    assert first.try_take() is True and second.try_take() is True

    waiting = threading.Event()

    def collection() -> None:
        with psycopg.connect(database_url, autocommit=True) as db:
            db.execute("set lock_timeout = '10s'")
            waiting.set()
            db.execute("select pg_advisory_lock(hashtextextended(%s, 0))", (source_traffic.SOURCE_TRAFFIC_LOCK_NAME,))
            db.execute("select pg_advisory_unlock(hashtextextended(%s, 0))", (source_traffic.SOURCE_TRAFFIC_LOCK_NAME,))

    thread = threading.Thread(target=collection)
    thread.start()
    waiting.wait(timeout=10)
    time.sleep(0.3)
    # Both workers release at their next batch: the waiting collection blocks any new shared turn.
    assert first.try_take() is False
    assert second.try_take() is False
    thread.join(timeout=10)
    assert first.try_take() is True


# --- Tours par hôte -------------------------------------------------------------------------------------------


@pytest.fixture
def turns_factory(database_url):
    created: list[HostTurns] = []

    def make(**kwargs) -> HostTurns:
        turns = HostTurns(database_url, connect=_connect, poll_seconds=0.05, **kwargs)
        created.append(turns)
        return turns

    yield make
    for turns in created:
        turns._drop_connection()


def test_the_host_key_ignores_www_case_and_the_port() -> None:
    assert host_turn.host_of("https://WWW.Licitor.com/data/pub/a.pdf") == "licitor.com"
    assert host_turn.host_of("https://licitor.com:443/x") == "licitor.com"
    assert host_turn.host_of("cdn.agorastore.fr") == "cdn.agorastore.fr"
    assert host_turn.host_of("") is None


def test_two_processes_never_overlap_on_a_host_and_keep_its_delay(turns_factory) -> None:
    """Deux sessions (deux processus) : jamais deux requêtes en même temps sur le même hôte, et l'écart du site."""
    delay = 0.4
    intervals: list[tuple[float, float]] = []
    lock = threading.Lock()

    def process() -> None:
        turns = turns_factory()
        for _ in range(3):
            with host_turn.host_turn("https://www.licitor.com/a.pdf", delay_seconds=delay, turns=turns):
                start = time.monotonic()
                time.sleep(0.1)  # the request
                end = time.monotonic()
            with lock:
                intervals.append((start, end))
            time.sleep(0.05)  # other work (OCR, another host)

    threads = [threading.Thread(target=process) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    intervals.sort()
    assert len(intervals) == 6
    gaps = []
    for (_, previous_end), (next_start, _) in zip(intervals, intervals[1:], strict=False):
        assert next_start >= previous_end, "two requests overlapped on the host"
        gaps.append(next_start - previous_end)
    # Every hand-over between the two processes waited the site delay (the same process keeps its own cadence).
    assert sum(gap >= delay - 0.05 for gap in gaps) >= 2


def test_the_turn_is_kept_for_the_crawl_delay_after_the_request(turns_factory) -> None:
    first, second = turns_factory(), turns_factory()
    crawl_delay = 0.8
    with host_turn.host_turn("https://docs.example.test/a.pdf", delay_seconds=crawl_delay, turns=first):
        pass
    ended = time.monotonic()
    with host_turn.host_turn("https://docs.example.test/b.pdf", delay_seconds=0, turns=second):
        obtained = time.monotonic()
    assert obtained - ended >= crawl_delay - 0.05


def test_a_turn_that_does_not_come_in_time_raises_and_is_never_taken(turns_factory) -> None:
    holder, waiter = turns_factory(), turns_factory()
    with host_turn.host_turn("https://slow.example.test/a", delay_seconds=0, turns=holder):
        with pytest.raises(HostTurnWaitExceeded) as raised:
            with host_turn.host_turn("https://slow.example.test/b", delay_seconds=0, turns=waiter,
                                     deadline_remaining=lambda: 0.3):
                pytest.fail("the body must not run without the turn")
    assert raised.value.deadline_reached is True
    assert waiter.held_hosts() == []
    assert waiter.stats.timeouts == 1


def test_a_lost_session_hands_the_turn_back(turns_factory, database_url) -> None:
    holder, waiter = turns_factory(), turns_factory()
    with host_turn.host_turn("https://dead.example.test/a", delay_seconds=60, turns=holder):
        pid = holder._connection.info.backend_pid
    with _connect(database_url) as admin:
        admin.execute("select pg_terminate_backend(%s)", (pid,))
    with host_turn.host_turn("https://dead.example.test/b", delay_seconds=0, turns=waiter,
                             deadline_remaining=lambda: 5):
        pass


def test_a_waiting_process_passes_before_the_holder_takes_the_host_again(turns_factory) -> None:
    holder, waiter = turns_factory(), turns_factory()
    order: list[str] = []
    with host_turn.host_turn("https://fair.example.test/a", delay_seconds=0.2, turns=holder):
        order.append("holder-1")

    def wait() -> None:
        with host_turn.host_turn("https://fair.example.test/b", delay_seconds=0.2, turns=waiter,
                                 deadline_remaining=lambda: 10):
            order.append("waiter")

    thread = threading.Thread(target=wait)
    thread.start()
    time.sleep(0.1)  # the waiter announces itself while the holder still holds the turn
    with host_turn.host_turn("https://fair.example.test/c", delay_seconds=0.2, turns=holder,
                             deadline_remaining=lambda: 10):
        order.append("holder-2")
    thread.join(timeout=10)
    assert order == ["holder-1", "waiter", "holder-2"]


def test_only_an_activated_lane_worker_takes_host_turns(monkeypatch) -> None:
    """Une collecte tient le tour des sources en exclusif : elle ne prend pas de tour par hôte, même réglage allumé."""
    monkeypatch.setattr(host_turn, "_ACTIVE", threading.Event())
    monkeypatch.setattr(host_turn, "_TURNS", {})
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "2")
    monkeypatch.setattr("src.config.load_settings", lambda: {"supabase_db_url": "postgresql://example/db"})
    assert host_turn._process_turns() is None
    assert host_turn.activate() is True
    assert isinstance(host_turn._process_turns(), HostTurns)
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "0")
    assert host_turn._process_turns() is None


def test_without_the_setting_no_turn_is_taken(monkeypatch) -> None:
    monkeypatch.setattr(host_turn, "_process_turns", lambda: None)
    with host_turn.host_turn("https://example.test/a", delay_seconds=1):
        pass


def test_a_page_request_waiting_too_long_for_its_turn_releases_the_detail_task(monkeypatch) -> None:
    """Dans une tâche de fiche, un tour qui ne vient pas devient l'échéance de la tâche : rendue sans essai."""
    _freeze_source_clock(monkeypatch)
    _patch_http_client(monkeypatch, [[_Response(200, text="User-agent: *\nAllow: /")]])
    client = common.PoliteHttpClient(base_url="https://source.example", user_agent=USER_AGENT, delay_seconds=0,
                                     timeout_seconds=1)

    @contextmanager
    def busy(url, **_kwargs):
        raise HostTurnWaitExceeded("source.example", 120.0, deadline_reached=False)
        yield

    monkeypatch.setattr(common, "host_turn", busy)
    with source_task_deadline_scope(time.monotonic() + 600):
        with pytest.raises(SourceTaskDeadlineExceeded, match="host turn"):
            client.get("https://source.example/annonce")


def test_a_document_waiting_too_long_for_its_turn_is_deferred_without_attempt(monkeypatch) -> None:
    class Busy:
        @contextmanager
        def turn(self, url):
            raise HostTurnWaitExceeded("docs.example.test", 180.0, deadline_reached=False)
            yield

    monkeypatch.setattr(pdf_enrichment, "_DOCUMENT_POLITENESS", Busy())
    monkeypatch.setattr(pdf_enrichment, "_send_pinned_document_request", lambda *a, **k: pytest.fail("no request"))
    with pdf_deadline_scope(time.monotonic() + 600):
        with pytest.raises(PdfDeadlineExceeded):
            pdf_enrichment._download_document_response("https://docs.example.test/a.pdf", headers={},
                                                       timeout_seconds=5)


# --- Copie commune de robots.txt ------------------------------------------------------------------------------


def _copy(age: timedelta, *, rules=(("disallow", "/private"),), crawl_delay=None) -> RobotsPolicyCopy:
    return RobotsPolicyCopy(tuple(rules), crawl_delay, datetime.now(UTC) - age,
                            robots_policy_copies.user_agent_digest(USER_AGENT))


@pytest.mark.parametrize(
    "shared,action,probe",
    [
        (None, "fetch", False),
        (SharedPolicy(_copy(timedelta(minutes=10)), None), "reuse", False),
        (SharedPolicy(_copy(timedelta(minutes=40)), None), "fetch", False),
        (SharedPolicy(None, RobotsFailure("no_tcp_response", datetime.now(UTC) - timedelta(minutes=10))), "not_due", False),
        (SharedPolicy(None, RobotsFailure("server_error", datetime.now(UTC) - timedelta(minutes=61))), "fetch", True),
        (SharedPolicy(_copy(timedelta(minutes=20)), RobotsFailure("access_refused", datetime.now(UTC) - timedelta(minutes=5))), "refused", False),
        (SharedPolicy(_copy(timedelta(minutes=5)), RobotsFailure("access_refused", datetime.now(UTC) - timedelta(minutes=20))), "reuse", False),
        (SharedPolicy(None, RobotsFailure("http_error", datetime.now(UTC) - timedelta(minutes=5))), "fetch", False),
    ],
)
def test_one_freshness_rule_before_any_robots_read(shared, action, probe) -> None:
    decision = robots_policy_copies.before_fetch(shared, USER_AGENT)
    assert (decision.action, decision.probe) == (action, probe)


def test_a_refusal_is_never_kept_as_an_allowing_policy() -> None:
    """Un 401/403 plus récent que la copie : la copie ne tient plus lieu de lecture, le refus est rendu."""
    shared = SharedPolicy(_copy(timedelta(minutes=2), rules=()), RobotsFailure("access_refused", datetime.now(UTC)))
    assert robots_policy_copies.before_fetch(shared, USER_AGENT).action == "refused"


class _Store:
    def __init__(self, shared: SharedPolicy | None = None) -> None:
        self.shared = shared
        self.verified: list[RobotsPolicyCopy] = []
        self.failures: list[RobotsFailure] = []

    def install(self, monkeypatch) -> None:
        monkeypatch.setattr(robots_policy_store, "load", lambda key: self.shared)
        monkeypatch.setattr(robots_policy_store, "save_verified", lambda key, copy: self.verified.append(copy))
        monkeypatch.setattr(robots_policy_store, "save_failure", lambda key, failure: self.failures.append(failure))


def _client() -> common.PoliteHttpClient:
    return common.PoliteHttpClient(base_url="https://source.example", user_agent=USER_AGENT, delay_seconds=0,
                                   timeout_seconds=1)


def test_a_fresh_shared_copy_replaces_the_robots_read(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    store = _Store(SharedPolicy(_copy(timedelta(minutes=5), crawl_delay=9.0), None))
    store.install(monkeypatch)
    clients = _patch_http_client(monkeypatch, [[]])

    client = _client()

    assert clients[0].calls == []
    assert store.verified == []  # a reused copy keeps its own reading time
    assert client._request_delay("https://source.example/a") == 9.0
    with pytest.raises(RuntimeError, match="robots.txt does not allow"):
        client.get("https://source.example/private/a")
    assert client.coverage_metrics()["robots_policy"]["state"] == "verified"


def test_a_read_policy_becomes_the_shared_copy(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    store = _Store()
    store.install(monkeypatch)
    _patch_http_client(monkeypatch, [[_Response(200, text="User-agent: *\nDisallow: /x\nCrawl-delay: 3")]])
    _client()
    assert [(copy.rules, copy.crawl_delay) for copy in store.verified] == [((("disallow", "/x"),), 3.0)]


def test_after_a_passing_outage_no_process_reads_robots_before_the_probe(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    failed_at = datetime.now(UTC) - timedelta(minutes=10)
    store = _Store(SharedPolicy(None, RobotsFailure("no_tcp_response", failed_at)))
    store.install(monkeypatch)
    clients = _patch_http_client(monkeypatch, [[]])

    client = _client()

    assert clients[0].calls == []
    status = client.coverage_metrics()["robots_policy"]
    assert status["state"] == "unavailable" and status["failure_class"] == "no_tcp_response"
    assert status["probe_not_before"] == (failed_at + timedelta(minutes=60)).isoformat()
    with pytest.raises(common.RobotsUnavailableError) as raised:
        client.get("https://source.example/annonce")
    assert raised.value.probe_not_before == failed_at + timedelta(minutes=60)


def test_the_probe_is_one_request_without_retry_and_a_short_connection(monkeypatch) -> None:
    _freeze_source_clock(monkeypatch)
    store = _Store(SharedPolicy(None, RobotsFailure("no_tcp_response", datetime.now(UTC) - timedelta(minutes=61))))
    store.install(monkeypatch)
    clients = _patch_http_client(monkeypatch, [[httpx.ConnectTimeout("no answer")] * 4])

    client = common.PoliteHttpClient(base_url="https://source.example", user_agent=USER_AGENT, delay_seconds=0,
                                     timeout_seconds=30)

    assert clients[0].calls == [("GET", "https://source.example/robots.txt")]
    assert isinstance(clients[0].timeouts[0], httpx.Timeout)
    assert clients[0].timeouts[0].connect == common.ROBOTS_PROBE_CONNECT_TIMEOUT_SECONDS
    assert clients[0].timeouts[0].read == 30
    assert [failure.failure_class for failure in store.failures] == ["no_tcp_response"]
    assert client.coverage_metrics()["robots_policy"]["failure_class"] == "no_tcp_response"


@pytest.mark.parametrize(
    "response,failure_class",
    [(_Response(403), "access_refused"), (_Response(503), "server_error")],
)
def test_a_failed_read_records_its_class(monkeypatch, response, failure_class) -> None:
    _freeze_source_clock(monkeypatch)
    store = _Store()
    store.install(monkeypatch)
    _patch_http_client(monkeypatch, [[response]])
    client = _client()
    assert [failure.failure_class for failure in store.failures] == [failure_class]
    assert client.coverage_metrics()["robots_policy"]["failure_class"] == failure_class


def test_a_detail_task_waiting_for_the_probe_spends_no_attempt(monkeypatch) -> None:
    released = []
    job = {"id": "job-1", "job_type": "source_detail", "source_url": "https://example.test/a",
           "detail_source_name": "encheres_immobilieres", "detail_source_url": "https://example.test/a",
           "attempt_count": 1}
    probe_at = datetime.now(UTC) + timedelta(minutes=50)
    monkeypatch.setattr(source_detail_worker, "source_detail_source_enabled", lambda *_a: True)
    monkeypatch.setattr(source_detail_worker, "fetch_sale_for_data_refresh", lambda _url: SimpleNamespace())
    monkeypatch.setattr(source_detail_worker, "complete_already_verified_detail_job", lambda *_a: None)

    def fetch(*_a):
        raise common.RobotsUnavailableError("probe not due", transient=True, probe_not_before=probe_at)

    monkeypatch.setattr(source_detail_worker, "fetch_public_detail", fetch)
    monkeypatch.setattr(source_detail_worker, "_finish_job", lambda *_a, **_k: pytest.fail("no attempt spent"))
    monkeypatch.setattr(
        source_detail_worker, "release_source_detail_job_without_attempt",
        lambda job, **kwargs: released.append(kwargs),
    )
    source_detail_worker.process_source_detail_job(job, settings={"supabase_db_url": "x"}, clients={})
    assert released[0]["retry_not_before"] == probe_at


def test_documents_follow_the_shared_copy_too(monkeypatch) -> None:
    from src import document_politeness

    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)
    store = _Store(SharedPolicy(_copy(timedelta(minutes=5)), None))
    store.install(monkeypatch)
    politeness = document_politeness.DocumentPoliteness(
        user_agent=lambda: USER_AGENT, fetch_robots=lambda url: pytest.fail("no robots read"),
        sleep=lambda _s: None, min_delay_seconds=0,
    )
    assert politeness.is_disallowed("https://docs.example.test/private/a.pdf") is True
    store.shared = SharedPolicy(None, RobotsFailure("timeout", datetime.now(UTC)))
    other = document_politeness.DocumentPoliteness(
        user_agent=lambda: USER_AGENT, fetch_robots=lambda url: pytest.fail("no robots read before the probe"),
        sleep=lambda _s: None, min_delay_seconds=0,
    )
    assert other.is_disallowed("https://docs.example.test/a.pdf") is None


def test_the_store_tolerates_a_database_without_the_migration(monkeypatch, database_url) -> None:
    monkeypatch.setattr(robots_policy_store, "_db_url", lambda: database_url)
    monkeypatch.setitem(robots_policy_store._state, "disabled", False)
    with psycopg.connect(database_url, autocommit=True) as db:
        exists = db.execute("select to_regclass('app_private.robots_policies')").fetchone()[0]
    if exists:
        pytest.skip("the disposable database already has the table")
    assert robots_policy_store.load("https://example.test:443") is None
    assert robots_policy_store._state["disabled"] is True
    robots_policy_store.save_failure("https://example.test:443", RobotsFailure("timeout", datetime.now(UTC)))


# --- Source injoignable (lot 5) -------------------------------------------------------------------------------


def _coverage(failure_class: str | None, *, state: str = "unavailable") -> dict:
    robots = {"state": state, "transient": True, "failure_class": failure_class} if failure_class else {"state": "verified"}
    return {"robots_policy": robots}


def test_a_passing_robots_outage_is_probed_hourly_once_the_shared_copy_exists() -> None:
    now = datetime.now(UTC)
    decision = source_suspension.decide({}, _coverage("no_tcp_response"), now=now, probe_available=True)
    assert decision.probe_at == now + timedelta(minutes=60)
    assert decision.unreachable_since == now and decision.suspend_until is None
    assert decision.coverage() == {"failure_class": "no_tcp_response", "unreachable_since": now.isoformat()}
    without = source_suspension.decide({}, _coverage("no_tcp_response"), now=now, probe_available=False)
    assert without.probe_at is None  # before the migration: the backoff of before, never more requests
    pages = {**_coverage("no_tcp_response", state="reused_copy"), "requests_attempted": 3, "requests_succeeded": 0}
    with_pages = source_suspension.decide({}, pages, now=now, probe_available=True)
    # A run that tried its pages on the 24-hour copy is not a probe: spacing of before, but the silence is counted.
    assert with_pages.probe_at is None and with_pages.unreachable_since == now


def test_seventy_two_hours_without_an_answer_suspend_the_source_for_seven_days() -> None:
    now = datetime.now(UTC)
    since = now - timedelta(hours=72, minutes=1)
    decision = source_suspension.decide(
        {"unreachable_since": since.isoformat()}, _coverage("timeout"), now=now, probe_available=True
    )
    assert decision.unreachable_since == since
    assert decision.suspend_until == now + timedelta(days=7)
    assert decision.suspension_reason.startswith("source_unreachable: no answer since")


@pytest.mark.parametrize(
    "coverage",
    [_coverage(None), _coverage("server_error"), _coverage("access_refused", state="refused")],
)
def test_only_connection_failures_count_towards_the_suspension(coverage) -> None:
    now = datetime.now(UTC)
    decision = source_suspension.decide(
        {"unreachable_since": (now - timedelta(days=4)).isoformat()}, coverage, now=now, probe_available=True
    )
    assert decision.unreachable_since is None and decision.suspend_until is None


def test_documents_of_a_suspended_site_wait_without_a_request(monkeypatch) -> None:
    until = datetime.now(UTC) + timedelta(days=6)
    source_suspension.reset_cache()
    monkeypatch.setattr(source_suspension, "_suspended_sources", lambda _db: {"encheres_immobilieres": until})
    assert source_suspension.suspended_host_until("https://www.encheresimmobilieres.fr/doc/a.pdf", "db") == until
    assert source_suspension.suspended_host_until("https://www.licitor.com/a.pdf", "db") is None


def test_the_relay_never_carries_the_unreachable_source() -> None:
    from src.sources.encheres_immobilieres import BASE_URL

    assert httpx.URL(BASE_URL).host not in SOURCE_HOSTS
    assert all("encheresimmobilieres" not in host for host in SOURCE_HOSTS)


class _FinishDb:
    def __init__(self, coverage: dict, previous: dict, *, store: bool = True, alerts: bool = True) -> None:
        self.row = ("encheres_immobilieres", "failed", {"scrape_coverage": {"encheres_immobilieres": coverage}},
                    {"encheres_immobilieres": ["robots.txt could not be verified"]}, datetime.now(UTC))
        self.previous = previous
        self.store, self.alerts = store, alerts
        self.update: tuple | None = None
        self.synced = False

    def transaction(self):
        return nullcontext()

    def execute(self, sql, params=None):
        if "select source,status,summary,errors,started_at" in sql:
            return SimpleNamespace(fetchone=lambda: self.row)
        if "select consecutive_failures" in sql:
            return SimpleNamespace(fetchone=lambda: (3, None, self.previous))
        if "to_regclass('app_private.robots_policies')" in sql:
            return SimpleNamespace(fetchone=lambda: (self.store,))
        if "to_regprocedure" in sql:
            return SimpleNamespace(fetchone=lambda: ("fn" if self.alerts else None,))
        if "sync_source_suspension_alerts" in sql:
            self.synced = True
        if "select decision,count(*)" in sql:
            return SimpleNamespace(fetchall=lambda: [])
        if "update public.auction_source_state set" in sql:
            self.update = params
        return SimpleNamespace(fetchone=lambda: None, fetchall=lambda: [])


def _finish(monkeypatch, db: _FinishDb) -> None:
    monkeypatch.setattr(autonomous_runner, "record_source_presence", lambda *a: None)
    monkeypatch.setattr(autonomous_runner, "mark_unseen_undated_sales_of_disabled_sources", lambda *a, **k: None)
    autonomous_runner.finish_source("db", "run-1", connect=lambda _url: nullcontext(db))


def test_a_failed_collection_on_a_passing_robots_outage_is_probed_in_an_hour(monkeypatch) -> None:
    db = _FinishDb(_coverage("no_tcp_response"), {})
    _finish(monkeypatch, db)
    next_inventory, suspended = db.update[4], db.update[5]
    assert timedelta(minutes=59) < next_inventory - datetime.now(UTC) <= timedelta(minutes=60)
    assert suspended is None
    assert db.update[1].obj["failure_class"] == "no_tcp_response"
    assert db.synced


def test_without_the_migration_the_backoff_of_before_stays(monkeypatch) -> None:
    db = _FinishDb(_coverage("no_tcp_response"), {}, store=False, alerts=False)
    _finish(monkeypatch, db)
    # Fourth consecutive failure: 15 * 2**4 = 240 minutes, as before.
    assert db.update[4] - datetime.now(UTC) > timedelta(minutes=239)
    assert not db.synced


def test_a_source_silent_for_72_hours_is_suspended_without_withdrawing_anything(monkeypatch) -> None:
    since = datetime.now(UTC) - timedelta(hours=73)
    db = _FinishDb(_coverage("no_tcp_response"), {"unreachable_since": since.isoformat()})
    withdrawals = []
    monkeypatch.setattr(autonomous_runner, "_withdraw_missing_sales", lambda *a, **k: withdrawals.append(a))
    _finish(monkeypatch, db)
    next_inventory, suspended = db.update[4], db.update[5]
    assert suspended == next_inventory
    assert timedelta(days=6, hours=23) < suspended - datetime.now(UTC) <= timedelta(days=7)
    assert db.update[6].startswith("source_unreachable:")
    assert withdrawals == []
    assert db.synced
