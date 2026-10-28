"""The checkpoint connection of a scrape is kept for its whole duration: a dropped one is replaced once."""

from __future__ import annotations

import psycopg
import pytest

from src import source_checkpoint


class _Context:
    def __init__(self, name: str, fail_writes: int = 0) -> None:
        self.name = name
        self.fail_writes = fail_writes
        self.closed = False
        self.writes = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True
        return False


def _sale(url: str) -> dict:
    return {"source_url": url, "_checkpoint_signature": "sig"}


@pytest.fixture
def connections(monkeypatch):
    opened: list[_Context] = []
    plan = {"failures": [1]}  # the first connection fails its first write

    def connect(db_url):
        failures = plan["failures"].pop(0) if plan["failures"] else 0
        context = _Context(f"c{len(opened) + 1}", fail_writes=failures)
        opened.append(context)
        return context

    def write(self, context, sale, payload, observed):
        db = self._db
        db.writes += 1
        if db.fail_writes:
            db.fail_writes -= 1
            raise psycopg.OperationalError("terminating connection due to administrator command")

    monkeypatch.setattr(source_checkpoint, "_context", lambda: ("postgresql://x", "run-1", {}, {}))
    monkeypatch.setattr(source_checkpoint, "_checkpoint_connect", connect)
    monkeypatch.setattr(source_checkpoint.CheckpointSales, "_write_checkpoint", write)
    monkeypatch.setattr(source_checkpoint, "_connections", [])
    monkeypatch.setattr(source_checkpoint, "_publisher", None)
    return opened, plan


def test_a_dropped_connection_is_replaced_once_and_the_write_goes_through(connections) -> None:
    opened, _ = connections
    sales = source_checkpoint.CheckpointSales()

    sales.append(_sale("https://example.test/a"))
    sales.append(_sale("https://example.test/b"))

    assert len(sales) == 2
    assert [context.name for context in opened] == ["c1", "c2"]
    assert opened[0].closed and not opened[1].closed
    assert opened[1].writes == 2  # the replaced connection serves the following writes too


def test_a_second_failure_in_a_row_is_raised(connections) -> None:
    opened, plan = connections
    plan["failures"] = [1, 1]
    sales = source_checkpoint.CheckpointSales()

    with pytest.raises(psycopg.OperationalError):
        sales.append(_sale("https://example.test/a"))

    assert len(opened) == 2 and all(context.closed for context in opened)
    assert len(sales) == 0


def test_replacing_a_connection_leaves_the_other_sources_connections_open(connections) -> None:
    opened, plan = connections
    plan["failures"] = [0, 1]
    healthy = source_checkpoint.CheckpointSales()
    healthy.append(_sale("https://example.test/healthy"))
    broken = source_checkpoint.CheckpointSales()

    broken.append(_sale("https://example.test/broken"))

    assert [context.name for context in opened] == ["c1", "c2", "c3"]
    assert not opened[0].closed  # the healthy source keeps its connection
    assert opened[1].closed and not opened[2].closed
