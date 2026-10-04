#!/usr/bin/env python3
"""Run a bounded, read-only Supabase PostgreSQL connectivity diagnostic.

The database URL is consumed only by psycopg. This program deliberately does
not print the URL, SQL text, row payloads, usernames, or user data. It emits
only bounded backend metadata (PID, age, wait, blockers, hash, and category)
when that metadata is available to the database role.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import psycopg
from psycopg.rows import dict_row


QUERIES: dict[str, str] = {
    "probe": "select 1 as ok",
    "capacity": """
        select
            current_setting('max_connections')::int as max_connections,
            current_setting('superuser_reserved_connections')::int as superuser_reserved_connections,
            nullif(current_setting('reserved_connections', true), '')::int as reserved_connections,
            (select count(*)::int from pg_catalog.pg_stat_activity) as current_connections
    """,
    "database_size": """
        select pg_catalog.pg_database_size(current_database())::bigint as database_size_bytes
    """,
    "activity": """
        select
            count(*)::int as total_backends,
            count(*) filter (where state = 'active')::int as active_backends,
            count(*) filter (where state = 'idle in transaction')::int as idle_in_transaction,
            count(*) filter (where wait_event is not null)::int as waiting_backends,
            count(*) filter (
                where state = 'active'
                  and query_start < clock_timestamp() - interval '60 seconds'
            )::int as long_active_backends
        from pg_catalog.pg_stat_activity
        where datname = current_database()
    """,
    "waits": """
        select
            coalesce(wait_event_type, 'none') as wait_event_type,
            coalesce(wait_event, 'none') as wait_event,
            count(*)::int as backend_count
        from pg_catalog.pg_stat_activity
        where datname = current_database()
        group by 1, 2
        order by 1, 2
    """,
    "locks": """
        select mode, granted, count(*)::int as lock_count
        from pg_catalog.pg_locks
        group by mode, granted
        order by mode, granted
    """,
    "blocking": """
        select
            count(*) filter (
                where cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
            )::int as blocked_backends,
            count(*) filter (
                where cardinality(pg_catalog.pg_blocking_pids(pid)) = 0
            )::int as non_blocked_backends
        from pg_catalog.pg_stat_activity
        where datname = current_database()
          and backend_type = 'client backend'
    """,
    "backends": """
        select
            pid::int,
            greatest(
                extract(epoch from (
                    clock_timestamp() - coalesce(query_start, xact_start, backend_start)
                )),
                0
            )::bigint as age_seconds,
            state,
            coalesce(wait_event_type, 'none') as wait_event_type,
            coalesce(wait_event, 'none') as wait_event,
            pg_catalog.pg_blocking_pids(pid) as blocking_pids,
            md5(coalesce(query, '')) as query_hash,
            case
                when query ~* 'auction_sales|raw_payload' then 'catalogue'
                when query ~* 'cron|pg_cron' then 'cron'
                when query ~* 'autonomous|auction_runs' then 'pipeline'
                when query ~* 'information_agent' then 'information_agent'
                else 'other'
            end as sql_category
        from pg_catalog.pg_stat_activity
        where datname = current_database()
          and backend_type = 'client backend'
          and state in ('active', 'idle in transaction')
        order by age_seconds desc, pid
        limit 20
    """,
}


def _query(cursor: Any, statement: str) -> Any:
    cursor.execute(statement)
    if cursor.description is None:
        return None
    rows = cursor.fetchall()
    if len(rows) == 1:
        return rows[0]
    return rows


def _error_details(exc: Exception, *, phase: str, elapsed_ms: int, query: str | None = None) -> dict[str, Any]:
    details: dict[str, Any] = {
        "ok": False,
        "error": "database_diagnostic_failed",
        "error_type": type(exc).__name__,
        "phase": phase,
        "elapsed_ms": elapsed_ms,
    }
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(sqlstate, str) and sqlstate:
        details["sqlstate"] = sqlstate
    if query is not None:
        details["query"] = query
    return details


def run() -> tuple[int, dict[str, Any]]:
    database_url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not database_url:
        return 2, {
            "ok": False,
            "error": "missing_required_env",
            "required": ["SUPABASE_DB_URL"],
        }

    connect_started = time.perf_counter()
    try:
        with psycopg.connect(
            database_url,
            connect_timeout=8,
            prepare_threshold=None,
            application_name="immojudis-readonly-diagnostic",
        ) as connection:
            connect_elapsed_ms = round((time.perf_counter() - connect_started) * 1000)
            # SET TRANSACTION READ ONLY prevents accidental writes in this
            # diagnostic.  The final rollback also leaves no transaction state.
            connection.execute("set transaction read only")
            connection.execute("set local statement_timeout = '8000ms'")
            with connection.cursor(row_factory=dict_row) as cursor:
                result: dict[str, Any] = {}
                query_timings: dict[str, int] = {}
                query_started = time.perf_counter()
                for name, statement in QUERIES.items():
                    query_started = time.perf_counter()
                    try:
                        result[name] = _query(cursor, statement)
                    except Exception as exc:
                        return_code, failure = 1, _error_details(
                            exc,
                            phase="query",
                            elapsed_ms=round((time.perf_counter() - query_started) * 1000),
                            query=name,
                        )
                        failure["connect_elapsed_ms"] = connect_elapsed_ms
                        failure["query_timings_ms"] = query_timings
                        return return_code, failure
                    query_timings[name] = round((time.perf_counter() - query_started) * 1000)
            connection.rollback()
        return 0, {
            "ok": True,
            "connect_elapsed_ms": connect_elapsed_ms,
            "query_timings_ms": query_timings,
            **result,
        }
    except Exception as exc:  # Deliberately omit exception text; it can echo DSN data.
        return 1, _error_details(
            exc,
            phase="connect",
            elapsed_ms=round((time.perf_counter() - connect_started) * 1000),
        )


if __name__ == "__main__":
    exit_code, payload = run()
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))
    raise SystemExit(exit_code)
