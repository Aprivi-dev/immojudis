"""Priorité des collectes sur la voie d'enrichissement (``src.collection_priority``)."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from src import collection_priority


def _connect(rows, statements):
    @contextmanager
    def connect(_url, **_options):
        def execute(statement, params=None):
            statements.append((statement, params))
            return SimpleNamespace(fetchone=lambda: rows)

        yield SimpleNamespace(execute=execute)

    return connect


@pytest.mark.parametrize("row,expected", [((True,), True), ((False,), False), (None, False)])
def test_collection_pending_reads_the_runs_read_only(row, expected) -> None:
    statements: list = []
    assert collection_priority.collection_pending("postgresql://db", connect=_connect(row, statements)) is expected
    assert statements[0][0] == "set transaction read only"
    assert statements[-1] == (collection_priority.COLLECTION_PENDING_SQL, ("enrichment-queue",))


def test_an_unreadable_base_never_stops_the_worker() -> None:
    @contextmanager
    def broken(_url, **_options):
        raise OSError("down")
        yield

    assert collection_priority.collection_pending("postgresql://db", connect=broken) is False


def test_no_base_means_no_pending_collection() -> None:
    assert collection_priority.collection_pending("", connect=lambda *_a, **_k: pytest.fail("no connection")) is False


def test_the_unit_waits_until_the_collection_ends_but_never_past_its_deadline() -> None:
    clock = [0.0]
    answers = iter([True, True, False])

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    waited = collection_priority.wait_while_collection_pending(
        deadline=1000.0, pending=lambda: next(answers), poll_seconds=30.0, sleep=sleep, clock=lambda: clock[0]
    )
    assert waited == 60.0

    clock[0] = 0.0
    waited = collection_priority.wait_while_collection_pending(
        deadline=45.0, pending=lambda: True, poll_seconds=30.0, sleep=sleep, clock=lambda: clock[0]
    )
    assert waited == 45.0


def test_pending_collections_against_postgres() -> None:
    """Matrice du prédicat sur une vraie base (rejouée par la CI quand PIPELINE_TEST_DB_URL est posée)."""
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    from src.storage.supabase_client import _postgres_connect

    cases = [
        ("running", "licitor", None, True),
        ("queued", "licitor", "accepted", True),
        ("queued", "licitor", "in_flight", True),
        ("queued", "all", None, True),  # exécution manuelle en file
        ("queued", "licitor", "retry_wait", False),
        ("queued", "licitor", "terminal", False),
        ("running", "enrichment-queue", None, False),
        ("succeeded", "licitor", None, False),
    ]
    with _postgres_connect(url) as db:
        try:
            db.execute("create temporary table auction_runs(status text, source text, summary jsonb)")
            for status, source, state, expected in cases:
                db.execute("delete from auction_runs")
                summary = {"github_dispatch": {"state": state}} if state else {}
                db.execute(
                    "insert into auction_runs values (%s, %s, %s::jsonb)",
                    (status, source, json.dumps(summary)),
                )
                sql = collection_priority.COLLECTION_PENDING_SQL.replace("public.auction_runs", "pg_temp.auction_runs")
                assert db.execute(sql, ("enrichment-queue",)).fetchone()[0] is expected, (status, source, state)
        finally:
            db.rollback()
