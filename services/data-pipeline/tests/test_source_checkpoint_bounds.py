from __future__ import annotations

import time
from contextlib import nullcontext
from types import SimpleNamespace

import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_autonomy_postgres import setup
from test_pdf_document_checkpoint_postgres import (
    disposable_checkpoint_database as disposable_checkpoint_database,
)

from src import source_checkpoint
from src.storage.supabase_client import _postgres_connect


class _FakeTransaction:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class _FakeDb:
    def __init__(self, calls: list[tuple[str, object | None]], *, fail_on_insert: bool = False):
        self.calls = calls
        self.fail_on_insert = fail_on_insert

    def transaction(self):
        return _FakeTransaction()

    def execute(self, statement, params=None):
        self.calls.append((statement.strip().lower(), params))
        if self.fail_on_insert and statement.lstrip().lower().startswith("insert into"):
            raise TimeoutError("checkpoint statement timeout")
        return SimpleNamespace(fetchall=lambda: [])


def test_checkpoint_connection_uses_short_libpq_connect_without_retries(monkeypatch):
    captured = {}

    def connect(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return nullcontext(object())

    from src.storage import supabase_client

    monkeypatch.setattr(supabase_client, "_postgres_connect", connect)

    with source_checkpoint._checkpoint_connect("postgresql://local"):
        pass

    assert captured == {
        "url": "postgresql://local",
        "connect_timeout": 5,
        "retry_delays": (),
    }


def test_checkpoint_transactions_set_local_lock_and_statement_bounds(monkeypatch):
    calls: list[tuple[str, object | None]] = []
    db = _FakeDb(calls)
    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "run-1")
    monkeypatch.setattr(source_checkpoint, "load_settings", lambda: {"supabase_db_url": "postgresql://local"})
    monkeypatch.setattr(source_checkpoint, "_checkpoint_connect", lambda *_: nullcontext(db))
    monkeypatch.setattr("src.collection_evidence.record_items", lambda *args, **kwargs: None)
    source_checkpoint._context.cache_clear()
    source_checkpoint._connections.clear()

    try:
        source_checkpoint._context()
        source_checkpoint.save_source_cursor("department:33", {"scan_complete": False})
        rows = source_checkpoint.CheckpointSales()
        rows.append({
            "source_url": "https://example.test/1",
            "source_name": "test",
            "_checkpoint_signature": "sig",
        })
    finally:
        source_checkpoint._context.cache_clear()
        source_checkpoint._connections.clear()

    lock_commands = [statement for statement, _ in calls if statement.startswith("set local")]
    assert lock_commands.count("set local lock_timeout = '5s'") == 3
    assert lock_commands.count("set local statement_timeout = '15s'") == 3


def test_checkpoint_append_propagates_persistence_timeout_without_appending_sale(monkeypatch):
    calls: list[tuple[str, object | None]] = []
    db = _FakeDb(calls, fail_on_insert=True)
    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "run-1")
    monkeypatch.setattr(source_checkpoint, "load_settings", lambda: {"supabase_db_url": "postgresql://local"})
    monkeypatch.setattr(source_checkpoint, "_checkpoint_connect", lambda *_: nullcontext(db))
    source_checkpoint._context.cache_clear()
    source_checkpoint._connections.clear()

    try:
        rows = source_checkpoint.CheckpointSales()
        with pytest.raises(TimeoutError, match="checkpoint statement timeout"):
            rows.append({
                "source_url": "https://example.test/timeout",
                "source_name": "test",
                "_checkpoint_signature": "sig",
            })
        assert rows == []
    finally:
        source_checkpoint._context.cache_clear()
        source_checkpoint._connections.clear()


def test_save_source_cursor_real_lock_timeout_preserves_existing_checkpoints(
    monkeypatch,
    disposable_checkpoint_database: str,
):
    """A locked cursor fails within the local bound and leaves both rows intact."""
    db_url = disposable_checkpoint_database
    old_payload = {"schema_version": "petites_affiches_cursor_v1", "scan_complete": False, "marker": "old"}
    current_payload = {"schema_version": "petites_affiches_cursor_v1", "scan_complete": False, "marker": "current"}
    cursor_url = "__source_cursor__:department:33"

    with _postgres_connect(db_url) as db:
        setup(db)
        old_run_id = str(
            db.execute(
                "insert into auction_runs(source,status) values('petites_affiches','failed') returning id"
            ).fetchone()[0]
        )
        current_run_id = str(
            db.execute(
                "insert into auction_runs(source,status) values('petites_affiches','running') returning id"
            ).fetchone()[0]
        )
        db.execute(
            """insert into auction_collection_checkpoints
                (run_id,source_url,signature,payload)
                values(%s,%s,%s,%s),(%s,%s,%s,%s)""",
            (
                old_run_id,
                cursor_url,
                "old-signature",
                Jsonb(old_payload),
                current_run_id,
                cursor_url,
                "current-signature",
                Jsonb(current_payload),
            ),
        )
        db.execute(
            """
            create function public.assert_source_checkpoint_bounds() returns trigger
            language plpgsql as $$
            begin
                if current_setting('lock_timeout') <> '5s'
                   or current_setting('statement_timeout') <> '15s' then
                    raise exception 'source checkpoint transaction was not bounded';
                end if;
                return new;
            end;
            $$
            """
        )
        db.execute(
            """
            create trigger source_checkpoint_bounds_guard
            before insert or update on public.auction_collection_checkpoints
            for each row execute function public.assert_source_checkpoint_bounds()
            """
        )
        db.commit()

    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", current_run_id)
    monkeypatch.setattr(source_checkpoint, "load_settings", lambda: {"supabase_db_url": db_url})
    source_checkpoint._context.cache_clear()
    source_checkpoint._connections.clear()

    try:
        assert source_checkpoint.load_source_cursor("department:33") == old_payload
        assert source_checkpoint.save_source_cursor("department:34", {"scan_complete": False}) is True

        with _postgres_connect(db_url) as locker:
            locker.execute(
                "select 1 from auction_collection_checkpoints where run_id=%s and source_url=%s for update",
                (current_run_id, cursor_url),
            )
            started = time.monotonic()
            with pytest.raises(psycopg.errors.LockNotAvailable):
                source_checkpoint.save_source_cursor(
                    "department:33",
                    {"scan_complete": False, "marker": "replacement"},
                )
            elapsed = time.monotonic() - started
            assert 4.0 <= elapsed < 8.0
            locker.rollback()

        with _postgres_connect(db_url) as verify:
            old_row = verify.execute(
                "select payload from auction_collection_checkpoints where run_id=%s and source_url=%s",
                (old_run_id, cursor_url),
            ).fetchone()
            current_row = verify.execute(
                "select payload from auction_collection_checkpoints where run_id=%s and source_url=%s",
                (current_run_id, cursor_url),
            ).fetchone()
        assert old_row[0] == old_payload
        assert current_row[0] == current_payload
    finally:
        source_checkpoint._context.cache_clear()
        source_checkpoint._connections.clear()
