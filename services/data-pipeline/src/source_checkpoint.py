"""Short-lived, source-scoped detail checkpoints for interrupted collection runs."""
from __future__ import annotations

import atexit
import copy
import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

from psycopg.types.json import Jsonb

from src.config import load_settings

# Checkpoint retention is deliberately independent from source freshness.  A
# detail captured by an interrupted run may be reusable after the source's
# normal freshness window, while ``_checkpoint_checked_at`` must continue to
# describe when that detail was actually fetched.  The existing cleanup jobs
# retain these rows for 24 hours, so keep the reader aligned with that policy.
CHECKPOINT_RETENTION = "24 hours"
MAX_CHECKPOINT_REUSE_AGE = timedelta(hours=24)
CURSOR_PREFIX = "__source_cursor__:"


@lru_cache(maxsize=1)
def _context():
    run_id = os.getenv('PIPELINE_AUTONOMOUS_RUN_ID')
    db_url = load_settings().get('supabase_db_url') if run_id else None
    if not run_id or not db_url:
        return None
    from src.storage.supabase_client import _postgres_connect
    with _postgres_connect(str(db_url)) as db:
        rows = db.execute("""select distinct on(c.source_url) c.source_url,c.signature,c.payload,c.observed_at
          from public.auction_collection_checkpoints c join public.auction_runs r on r.id=c.run_id
          where r.status='failed' and c.observed_at>now()-interval '24 hours'
            and r.source=(select source from public.auction_runs where id=%s)
          order by c.source_url,c.observed_at desc""", (run_id,)).fetchall()
    details = {}
    cursors = {}
    for url, signature, payload, observed in rows:
        if str(url).startswith(CURSOR_PREFIX):
            cursors[str(url)[len(CURSOR_PREFIX):]] = payload if isinstance(payload, dict) else {}
        else:
            details[url] = (signature, payload, observed)
    return str(db_url), run_id, details, cursors


def load_source_cursor(partition: str) -> dict[str, Any] | None:
    """Return the newest durable cursor for a source partition, if any.

    Cursors are stored beside detail checkpoints so this change works with
    the deployed checkpoint table and survives a process kill between pages.
    The current run id remains the write target; ``_context`` reads only a
    previous failed run, preventing a partially written cursor from being
    treated as a completed scan in the same run.
    """
    context = _context()
    if not context:
        return None
    cursor = context[3].get(str(partition))
    return copy.deepcopy(cursor) if isinstance(cursor, dict) else None


def save_source_cursor(partition: str, payload: dict[str, Any]) -> bool:
    """Persist a page/departure cursor with independent retention time."""
    context = _context()
    if not context:
        return False
    retained_at = datetime.now(UTC)
    cursor = json.loads(json.dumps(payload, default=str))
    cursor.setdefault("schema_version", "petites_affiches_cursor_v1")
    cursor["cursor_retained_at"] = retained_at.isoformat()
    source_url = f"{CURSOR_PREFIX}{partition}"
    from src.storage.supabase_client import _postgres_connect

    with _postgres_connect(context[0]) as db:
        with db.transaction():
            db.execute("""insert into public.auction_collection_checkpoints
                (run_id,source_url,signature,payload,observed_at)
                values(%s,%s,%s,%s,%s) on conflict(run_id,source_url) do update set
                  signature=excluded.signature,payload=excluded.payload,observed_at=excluded.observed_at""",
                (context[1], source_url, "source_cursor_v1", Jsonb(cursor), retained_at))
    return True


def _stored_checked_at(payload: object, fallback: datetime) -> datetime:
    if isinstance(payload, dict):
        value = payload.get("_checkpoint_checked_at")
        if isinstance(value, datetime) and value.tzinfo:
            return value.astimezone(UTC)
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                parsed = None
            if parsed is not None and parsed.tzinfo:
                return parsed.astimezone(UTC)
    return fallback.astimezone(UTC) if fallback.tzinfo else fallback.replace(tzinfo=UTC)


def restore_detail(sale: dict) -> bool:
    context = _context()
    if not context:
        sale.setdefault('_discovered_at', datetime.now(UTC).isoformat())
        return False
    # Compare the whole new public list card, not just a price/date pair.
    signature = hashlib.sha256(json.dumps({key:value for key,value in sale.items() if not key.startswith('_')}, sort_keys=True, default=str).encode()).hexdigest()
    sale.setdefault('_discovered_at', datetime.now(UTC).isoformat())
    sale['_checkpoint_signature'] = signature
    cached = context[2].get(str(sale.get('source_url') or ''))
    if cached is None or cached[0] != signature:
        return False
    # ``observed_at`` is retention metadata.  Reusing it as a freshness check
    # would make an old checkpoint look newly fetched, so prefer the dated
    # marker stored in the payload and only fall back for legacy rows.
    if not isinstance(cached[1], dict):
        return False
    checked_at = _stored_checked_at(cached[1], cached[2])
    age = datetime.now(UTC) - checked_at
    if age < timedelta(0) or age > MAX_CHECKPOINT_REUSE_AGE:
        return False
    sale.update(cached[1])
    sale['_checkpoint_checked_at'] = checked_at.isoformat()
    sale['_checkpoint_restored'] = True
    return True


_publisher = None
_pending = []
_connections = []


def configure_publisher(callback=None):
    global _publisher
    _publisher = callback
    _pending.clear()


def flush_publications():
    if _publisher and _pending:
        batch = list(_pending)
        _pending.clear()
        _publisher(batch)


def close_checkpoint_connections():
    while _connections:
        context = _connections.pop()
        context.__exit__(None, None, None)


atexit.register(close_checkpoint_connections)


class CheckpointSales(list):
    def __init__(self):
        super().__init__()
        self._db = None

    def append(self, sale):
        context = _context()
        if (context and sale.get('_checkpoint_signature') and not sale.get('_checkpoint_restored')
                and not (sale.get('_detail_fetch_failed') or sale.get('_known_unchanged')
                         or sale.get('operator_detail_status') == 'failed')):
            from src.storage.supabase_client import _postgres_connect
            sale.setdefault('_checkpoint_checked_at', datetime.now(UTC).isoformat())
            # Retention is refreshed when a checkpoint is committed, but the
            # source-check timestamp above is intentionally left untouched.
            observed = datetime.now(UTC)
            payload = json.loads(json.dumps(sale, default=str))
            if self._db is None:
                connection_context = _postgres_connect(context[0])
                self._db = connection_context.__enter__()
                _connections.append(connection_context)
            with self._db.transaction():
                db = self._db
                db.execute("""insert into public.auction_collection_checkpoints(run_id,source_url,signature,payload,observed_at)
                  values(%s,%s,%s,%s,%s) on conflict(run_id,source_url) do update set
                    signature=excluded.signature,payload=excluded.payload,observed_at=excluded.observed_at""",
                  (context[1],sale['source_url'],sale['_checkpoint_signature'],Jsonb(payload),observed))
                from src.collection_evidence import record_items
                record_items(context[1], [sale], connection=db)
        super().append(sale)
        if _publisher:
            _pending.append(copy.deepcopy(sale))
            if len(_pending) >= 25:
                flush_publications()
