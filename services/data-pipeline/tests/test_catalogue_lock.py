"""One catalogue writer at a time, without GitHub concurrency cancellations (P3-08)."""

from __future__ import annotations

import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from src import catalogue_lock, recompute_scoring
from src.catalogue_lock import (
    CATALOGUE_WRITER_LOCK_NAME,
    CatalogueLockTimeout,
    catalogue_writer_lock,
)

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


class FakeConnection:
    def __init__(self, results: list[bool]) -> None:
        self.results = list(results)
        self.statements: list[tuple[str, tuple]] = []
        self.autocommit = False
        self.closed = False

    def execute(self, statement, parameters=()):
        self.statements.append((" ".join(statement.split()), tuple(parameters)))
        row = (self.results.pop(0),) if "pg_try_advisory_lock" in statement else (True,)
        return type("Cursor", (), {"fetchone": lambda self_, row=row: row})()

    def close(self) -> None:
        self.closed = True


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def _hold(connection: FakeConnection, clock: Clock, **kwargs):
    return catalogue_writer_lock(
        "postgresql://example/db",
        connect=lambda url: connection,
        sleep=clock.sleep,
        clock=clock,
        heartbeat_seconds=0,
        **kwargs,
    )


def test_lock_is_taken_with_a_stable_key_and_released_on_exit() -> None:
    connection, clock = FakeConnection([True]), Clock()

    with _hold(connection, clock, wait_seconds=60):
        assert connection.autocommit is True
        assert not connection.closed

    statements = [sql for sql, _ in connection.statements]
    assert statements == [
        "select pg_try_advisory_lock(hashtextextended(%s, 0))",
        "select pg_advisory_unlock(hashtextextended(%s, 0))",
    ]
    assert all(parameters == (CATALOGUE_WRITER_LOCK_NAME,) for _, parameters in connection.statements)
    assert connection.closed
    assert clock.sleeps == []


def test_the_second_job_waits_for_the_first(capsys) -> None:
    connection, clock = FakeConnection([False, False, True]), Clock()

    with _hold(connection, clock, wait_seconds=600, poll_seconds=15):
        pass

    assert clock.sleeps == [15, 15]
    out = capsys.readouterr().out
    assert "waits for the lock" in out and "lock acquired" in out


def test_waiting_gives_up_after_the_configured_time_and_closes_the_connection() -> None:
    connection, clock = FakeConnection([False] * 100), Clock()

    with pytest.raises(CatalogueLockTimeout, match="did not start"):
        with _hold(connection, clock, wait_seconds=40, poll_seconds=15):
            pytest.fail("the body must not run without the lock")

    assert clock.now == 40
    assert connection.closed
    assert not any("pg_advisory_unlock" in sql for sql, _ in connection.statements)


def test_the_body_error_still_releases_the_lock() -> None:
    connection, clock = FakeConnection([True]), Clock()

    with pytest.raises(RuntimeError, match="boom"):
        with _hold(connection, clock, wait_seconds=1):
            raise RuntimeError("boom")

    assert any("pg_advisory_unlock" in sql for sql, _ in connection.statements)
    assert connection.closed


def test_wait_time_comes_from_the_environment(monkeypatch) -> None:
    monkeypatch.delenv(catalogue_lock.LOCK_WAIT_ENV, raising=False)
    assert catalogue_lock._lock_wait_seconds() == catalogue_lock.DEFAULT_LOCK_WAIT_SECONDS
    monkeypatch.setenv(catalogue_lock.LOCK_WAIT_ENV, "300")
    assert catalogue_lock._lock_wait_seconds() == 300
    monkeypatch.setenv(catalogue_lock.LOCK_WAIT_ENV, "soon")
    with pytest.raises(ValueError, match=catalogue_lock.LOCK_WAIT_ENV):
        catalogue_lock._lock_wait_seconds()


def test_missing_database_url_is_an_error_in_github_actions_only(monkeypatch) -> None:
    monkeypatch.setattr(catalogue_lock, "load_settings", lambda: {"supabase_db_url": None})
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    with catalogue_writer_lock():
        pass  # local development: no-op

    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    with pytest.raises(RuntimeError, match="SUPABASE_DB_URL"):
        with catalogue_writer_lock():
            pytest.fail("must not run unlocked in CI")


def test_heartbeat_keeps_the_idle_session_alive() -> None:
    connection = FakeConnection([True])
    beats = threading.Event()
    original = connection.execute

    def execute(statement, parameters=()):
        if statement == "select 1":
            beats.set()
        return original(statement, parameters)

    connection.execute = execute  # type: ignore[method-assign]

    with catalogue_writer_lock(
        "postgresql://example/db", connect=lambda url: connection, wait_seconds=1, heartbeat_seconds=0.01
    ):
        assert beats.wait(timeout=2)


# --- real PostgreSQL ----------------------------------------------------------


@pytest.fixture
def database_url() -> str:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    host = str(conninfo_to_dict(url).get("host") or "").split(",", 1)[0]
    if host not in {"127.0.0.1", "localhost"}:
        pytest.fail(f"Refusing non-local lock test database: {host}")
    return url


def _lock_holders(url: str) -> int:
    with psycopg.connect(url, autocommit=True) as db:
        return db.execute(
            "select count(*) from pg_locks where locktype = 'advisory' and granted"
        ).fetchone()[0]


def test_two_real_sessions_exclude_each_other_and_the_second_gets_the_lock_after_release(database_url) -> None:
    order: list[str] = []
    first_has_lock = threading.Event()
    release_first = threading.Event()

    def first() -> None:
        with catalogue_writer_lock(database_url, label="pipeline", wait_seconds=5):
            order.append("first-start")
            first_has_lock.set()
            release_first.wait(timeout=10)
            order.append("first-end")

    holder = threading.Thread(target=first)
    holder.start()
    assert first_has_lock.wait(timeout=10)
    assert _lock_holders(database_url) >= 1

    with pytest.raises(CatalogueLockTimeout):
        with catalogue_writer_lock(database_url, label="recompute", wait_seconds=0):
            pytest.fail("the lock is held by the first session")

    def second() -> None:
        with catalogue_writer_lock(database_url, label="recompute", wait_seconds=10, poll_seconds=0.05):
            order.append("second-start")

    waiter = threading.Thread(target=second)
    waiter.start()
    time.sleep(0.4)
    assert "second-start" not in order  # it waits instead of running or cancelling the first
    release_first.set()
    holder.join(timeout=10)
    waiter.join(timeout=10)

    assert order == ["first-start", "first-end", "second-start"]
    assert _lock_holders(database_url) == 0


def test_the_lock_is_released_when_the_holder_dies(database_url) -> None:
    @contextmanager
    def crashed_holder():
        with psycopg.connect(database_url, autocommit=True) as db:
            assert db.execute(
                "select pg_try_advisory_lock(hashtextextended(%s, 0))", (CATALOGUE_WRITER_LOCK_NAME,)
            ).fetchone()[0]
            yield

    with crashed_holder():
        with pytest.raises(CatalogueLockTimeout):
            with catalogue_writer_lock(database_url, wait_seconds=0):
                pass
    with catalogue_writer_lock(database_url, wait_seconds=0):
        pass


# --- entry points and workflows ----------------------------------------------


class RecordingLock:
    def __init__(self) -> None:
        self.labels: list[str] = []

    def __call__(self, db_url=None, *, label="catalogue writer", **kwargs):
        self.labels.append(label)
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return None


@pytest.mark.parametrize(
    ("argv", "locked"),
    [
        ([], True),
        (["--source", "licitor", "--limit", "5"], True),
        (["--dry-run"], False),
        (["--verify-only"], False),
        (["--readiness-unassessed-only"], True),
        (["--readiness-unassessed-only", "--dry-run"], False),
        (["--repair-invalid-procedures"], True),
        (["--refresh-unknown-procedures"], True),
    ],
)
def test_recompute_takes_the_lock_only_when_it_writes(monkeypatch, argv, locked) -> None:
    lock = RecordingLock()
    monkeypatch.setattr(catalogue_lock, "catalogue_writer_lock", lock)
    monkeypatch.setattr("sys.argv", ["recompute_scoring", *argv])
    for name in (
        "recompute_scoring",
        "backfill_catalogue_readiness",
        "verify_persisted_sale_procedures",
        "repair_invalid_sale_procedures",
        "refresh_unknown_sale_procedures",
    ):
        monkeypatch.setattr(recompute_scoring, name, lambda *a, **k: 0)

    assert recompute_scoring.main() == 0

    assert lock.labels == (["recompute"] if locked else [])


def _run_scripts(text: str) -> list[str]:
    scripts: list[str] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)run:\s*(.*)$", lines[index])
        index += 1
        # ``defaults: run:`` is a mapping key with no value, not a script.
        if not match or not match.group(2).strip():
            continue
        indent = len(match.group(1))
        body = [match.group(2)]
        while index < len(lines) and (not lines[index].strip() or len(lines[index]) - len(lines[index].lstrip()) > indent):
            body.append(lines[index])
            index += 1
        scripts.append("\n".join(body))
    return scripts


def test_recompute_has_its_own_concurrency_group_and_never_cancels() -> None:
    text = (WORKFLOWS / "recompute-existing-sales.yml").read_text(encoding="utf-8")

    group = re.search(r"^concurrency:\n(?:\s+#.*\n)*\s+group: (\S+)\n\s+cancel-in-progress: (\S+)", text, re.M)
    assert group is not None
    assert group.group(1) == "immojudis-recompute"
    assert group.group(2) == "false"
    assert "group: immojudis-data-pipeline" not in text


def test_pipeline_group_is_not_shared_with_the_recompute() -> None:
    pipeline = (WORKFLOWS / "data-pipeline.yml").read_text(encoding="utf-8")

    assert "'immojudis-data-pipeline'" in pipeline
    assert "immojudis-recompute" not in pipeline


@pytest.mark.parametrize("name", sorted(path.name for path in WORKFLOWS.glob("*.yml")))
def test_no_workflow_interpolates_inputs_or_event_data_in_shell_scripts(name) -> None:
    text = (WORKFLOWS / name).read_text(encoding="utf-8")

    offenders = [
        script.splitlines()[0][:60]
        for script in _run_scripts(text)
        if re.search(r"\$\{\{\s*(inputs\.|github\.event\.|github\.head_ref)", script)
    ]
    assert offenders == []


def test_recompute_write_steps_receive_the_database_url_for_the_lock() -> None:
    text = (WORKFLOWS / "recompute-existing-sales.yml").read_text(encoding="utf-8")

    for step in (
        "Publish recomputed sales",
        "Publish catalogue readiness",
        "Refresh unresolved procedure source pages",
        "Repair and verify persisted sale procedures",
    ):
        block = text.split(f"- name: {step}\n", 1)[1].split("\n      - name:", 1)[0]
        assert "SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}" in block, step
