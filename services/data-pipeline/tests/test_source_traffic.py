"""Un seul processus à la fois vers les sources (``src.source_traffic``, point M4 de la relecture du 17/11/2026)."""

from __future__ import annotations

import os
import threading
import time

import pytest

from src import collection_priority, source_traffic


def _url() -> str:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    return url


# Pris à l'import, avant la fixture automatique de conftest qui accorde le tour d'emblée.
REAL_TURN = source_traffic.source_traffic_turn
REAL_YIELD_TO_SOURCES = collection_priority.yield_to_sources


def _real_turn():
    return REAL_TURN


def test_without_a_base_the_turn_is_always_granted() -> None:
    turn = _real_turn()
    with turn("", label="local", wait_seconds=1) as granted:
        assert granted is True
    assert source_traffic.SourceTrafficTurns("").try_take() is True


def test_only_one_process_talks_to_the_sources_and_a_waiter_beats_the_worker() -> None:
    """Le travailleur reprend son tour lot par lot ; une collecte qui attend passe avant lui, puis il cède."""
    url = _url()
    turn = _real_turn()
    worker = source_traffic.SourceTrafficTurns(url)
    assert worker.try_take() is True  # batch 1

    with turn(url, label="other", wait_seconds=1) as granted:
        assert granted is False  # the worker holds the turn: nobody else talks to the sources

    obtained: dict[str, float] = {}

    def collection() -> None:
        with turn(url, label="collection", wait_seconds=10) as granted:
            obtained["at"] = time.monotonic()
            assert granted
            time.sleep(0.5)

    thread = threading.Thread(target=collection)
    thread.start()
    time.sleep(0.5)  # the collection now waits in the PostgreSQL lock queue
    released = time.monotonic()
    assert worker.try_take() is False  # batch 2: releases, the waiting collection gets the turn, the worker yields
    thread.join()
    assert obtained["at"] >= released
    assert worker.try_take() is True  # the collection is done: the worker resumes


def test_a_turn_that_never_comes_is_reported_without_the_lock() -> None:
    url = _url()
    turn = _real_turn()
    worker = source_traffic.SourceTrafficTurns(url)
    assert worker.try_take() is True
    started = time.monotonic()
    with turn(url, label="photos", wait_seconds=0.5) as granted:
        assert granted is False
    assert time.monotonic() - started < 5


def test_the_wrapper_runs_the_command_only_inside_the_turn(monkeypatch) -> None:
    from contextlib import contextmanager
    from types import SimpleNamespace

    events: list[str] = []

    @contextmanager
    def turn(_db_url, *, label, wait_seconds):
        events.append(f"take {wait_seconds:g}")
        yield True
        events.append("release")

    monkeypatch.setattr(source_traffic, "source_traffic_turn", turn)
    monkeypatch.setattr(source_traffic, "load_settings", lambda: {"supabase_db_url": "postgresql://db"})
    monkeypatch.setattr(
        source_traffic.subprocess, "run", lambda command, check: events.append(" ".join(command)) or SimpleNamespace(returncode=3)
    )

    assert source_traffic.main(["--wait-seconds", "240", "--", "python", "-m", "src.photo_mirror", "--automatic"]) == 3
    assert events == ["take 240", "python -m src.photo_mirror --automatic", "release"]


def test_the_wrapper_skips_the_command_when_the_turn_does_not_come(monkeypatch) -> None:
    from contextlib import contextmanager

    @contextmanager
    def turn(_db_url, **_kwargs):
        yield False

    monkeypatch.setattr(source_traffic, "source_traffic_turn", turn)
    monkeypatch.setattr(source_traffic.subprocess, "run", lambda *_a, **_k: pytest.fail("must not run"))
    assert source_traffic.main(["--wait-seconds", "1", "--", "true"]) == 0


def test_the_worker_yields_to_a_pending_collection_or_a_busy_source_turn(monkeypatch) -> None:
    priority = collection_priority
    monkeypatch.setattr(priority, "load_settings", lambda: {"supabase_db_url": "postgresql://db"})
    answers = {"pending": True, "turn": True}
    monkeypatch.setattr(priority, "collection_pending_now", lambda: answers["pending"])

    class Turns:
        def __init__(self, _url):
            pass

        def try_take(self):
            return answers["turn"]

    monkeypatch.setattr(source_traffic, "SourceTrafficTurns", Turns)
    monkeypatch.setattr(priority, "_WORKER_TURNS", {})
    assert REAL_YIELD_TO_SOURCES() is True
    answers["pending"] = False
    assert REAL_YIELD_TO_SOURCES() is False
    answers["turn"] = False
    assert REAL_YIELD_TO_SOURCES() is True
