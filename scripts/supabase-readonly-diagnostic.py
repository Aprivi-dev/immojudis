#!/usr/bin/env python3
"""Run a bounded, read-only Supabase PostgreSQL connectivity diagnostic.

The database URL is consumed only by psycopg. This program deliberately does
not print the URL, SQL text, row payloads, host addresses, usernames, or user
data. It emits only bounded backend metadata (PID, age, wait, blockers, hash,
and category) when that metadata is available to the database role. Connection
failures are classified without printing exception text, and each permitted
route is attempted at most once.
"""

from __future__ import annotations

import json
import os
import socket
import time
from typing import Any
from urllib.parse import urlsplit

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


def _endpoint(database_url: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    try:
        parsed = urlsplit(database_url)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
            return None, {"error": "database_diagnostic_failed", "category": "dsn_invalid", "phase": "parse"}
        port = parsed.port or 5432
    except ValueError as exc:
        return None, {
            "error": "database_diagnostic_failed",
            "category": "dsn_invalid",
            "error_type": type(exc).__name__,
            "phase": "parse",
        }
    host = parsed.hostname.lower()
    kind = "pooler" if ("pooler" in host or host.endswith(".pooler.supabase.com")) else "direct"
    return {"host": parsed.hostname, "kind": kind, "configured_port": port}, None


def _resolve_host(host: str, port: int) -> tuple[dict[str, Any], list[str], list[str]]:
    started = time.perf_counter()
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        return {
            "ok": False,
            "error": "database_diagnostic_failed",
            "category": "dns_resolution_error",
            "error_type": type(exc).__name__,
            "phase": "dns",
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            "dns_ipv4_count": 0,
            "dns_ipv6_count": 0,
        }, [], []

    ipv4: list[str] = []
    ipv6: list[str] = []
    for family, _, _, _, sockaddr in addresses:
        address = sockaddr[0]
        if family == socket.AF_INET and address not in ipv4:
            ipv4.append(address)
        elif family == socket.AF_INET6 and address not in ipv6:
            ipv6.append(address)
    if not ipv4 and not ipv6:
        return {
            "ok": False,
            "error": "database_diagnostic_failed",
            "category": "dns_no_a_or_aaaa",
            "phase": "dns",
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            "dns_ipv4_count": 0,
            "dns_ipv6_count": 0,
        }, [], []
    return {
        "ok": True,
        "phase": "dns",
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
        "dns_ipv4_count": len(ipv4),
        "dns_ipv6_count": len(ipv6),
    }, ipv4, ipv6


def _error_category(exc: Exception) -> str:
    sqlstate = getattr(exc, "sqlstate", None)
    message = str(exc).lower()
    if sqlstate in {"28P01", "28000"} or "password authentication failed" in message:
        return "auth_failed"
    if sqlstate == "53300" or "too many connections" in message:
        return "connection_limit"
    if sqlstate in {"57P01", "57P02", "57P03"}:
        return "database_unavailable"
    if isinstance(exc, (TimeoutError, socket.timeout)) or any(
        marker in message for marker in ("timeout", "timed out", "time-out")
    ):
        return "connect_timeout"
    if "certificate" in message or "ssl" in message or "tls" in message:
        return "tls_error"
    if "connection refused" in message or "refused" in message:
        return "connection_refused"
    if "network is unreachable" in message or "no route to host" in message:
        return "network_unreachable"
    if isinstance(sqlstate, str) and sqlstate.startswith("08"):
        return "network_error"
    return "other"


def _query(cursor: Any, statement: str) -> Any:
    cursor.execute(statement)
    if cursor.description is None:
        return None
    rows = cursor.fetchall()
    if len(rows) == 1:
        return rows[0]
    return rows


def _error_details(
    exc: Exception,
    *,
    phase: str,
    elapsed_ms: int,
    query: str | None = None,
    route: str | None = None,
    port: int | None = None,
    family: str | None = None,
) -> dict[str, Any]:
    details: dict[str, Any] = {
        "ok": False,
        "error": "database_diagnostic_failed",
        "category": _error_category(exc),
        "error_type": type(exc).__name__,
        "phase": phase,
        "elapsed_ms": elapsed_ms,
    }
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(sqlstate, str) and sqlstate:
        details["sqlstate"] = sqlstate
    if query is not None:
        details["query"] = query
    if route is not None:
        details["route"] = route
    if port is not None:
        details["port"] = port
    if family is not None:
        details["family"] = family
    return details


def _read_only_queries(connection: Any) -> tuple[int, dict[str, Any]]:
    """Run the bounded probes in one transaction and roll it back."""

    try:
        connection.execute("set transaction read only")
        connection.execute("set local statement_timeout = '8000ms'")
    except Exception as exc:
        try:
            connection.rollback()
        except Exception:
            pass
        return 1, _error_details(exc, phase="query", elapsed_ms=0, query="read_only_setup")

    result: dict[str, Any] = {}
    query_timings: dict[str, int] = {}
    with connection.cursor(row_factory=dict_row) as cursor:
        for name, statement in QUERIES.items():
            query_started = time.perf_counter()
            try:
                result[name] = _query(cursor, statement)
            except Exception as exc:
                failure = _error_details(
                    exc,
                    phase="query",
                    elapsed_ms=round((time.perf_counter() - query_started) * 1000),
                    query=name,
                )
                failure["query_timings_ms"] = query_timings
                try:
                    connection.rollback()
                except Exception:
                    pass
                return 1, failure
            query_timings[name] = round((time.perf_counter() - query_started) * 1000)

    try:
        connection.rollback()
    except Exception:
        pass
    return 0, {"query_timings_ms": query_timings, **result}


def _routes(endpoint: dict[str, Any], ipv4: list[str], ipv6: list[str]) -> list[dict[str, Any]]:
    if endpoint["kind"] == "pooler":
        return [
            {"name": "pooler_session", "port": 5432, "family": "any", "hostaddr": None},
            {"name": "pooler_transaction", "port": 6543, "family": "any", "hostaddr": None},
        ]

    routes: list[dict[str, Any]] = []
    if ipv4:
        routes.append(
            {
                "name": "direct_ipv4",
                "port": endpoint["configured_port"],
                "family": "ipv4",
                "hostaddr": ipv4[0],
            }
        )
    if ipv6:
        routes.append(
            {
                "name": "direct_ipv6",
                "port": endpoint["configured_port"],
                "family": "ipv6",
                "hostaddr": ipv6[0],
            }
        )
    return routes


def run() -> tuple[int, dict[str, Any]]:
    database_url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not database_url:
        return 2, {
            "ok": False,
            "error": "missing_required_env",
            "category": "missing_config",
            "required": ["SUPABASE_DB_URL"],
        }

    endpoint, endpoint_error = _endpoint(database_url)
    if endpoint_error is not None or endpoint is None:
        return 2, {
            "ok": False,
            "endpoint_kind": "unknown",
            **(endpoint_error or {"error": "database_diagnostic_failed", "category": "dsn_invalid"}),
        }

    endpoint_meta = {
        "endpoint_kind": endpoint["kind"],
        "configured_port": endpoint["configured_port"],
    }
    dns_result, ipv4, ipv6 = _resolve_host(endpoint["host"], endpoint["configured_port"])
    endpoint_meta.update(
        {
            "dns_ipv4_count": dns_result.get("dns_ipv4_count", 0),
            "dns_ipv6_count": dns_result.get("dns_ipv6_count", 0),
            "dns_elapsed_ms": dns_result.get("elapsed_ms", 0),
        }
    )
    if not dns_result.get("ok"):
        return 1, {**endpoint_meta, **dns_result}

    routes = _routes(endpoint, ipv4, ipv6)
    attempts: list[dict[str, Any]] = []
    for route in routes:
        connect_started = time.perf_counter()
        connect_kwargs: dict[str, Any] = {
            "port": route["port"],
            "connect_timeout": 8,
            "prepare_threshold": None,
            "application_name": "immojudis-readonly-diagnostic-v2",
        }
        if route["hostaddr"] is not None:
            # Keep the hostname in the DSN for TLS verification while forcing
            # the already-resolved address for this one family-specific try.
            connect_kwargs["hostaddr"] = route["hostaddr"]

        try:
            connection = psycopg.connect(database_url, **connect_kwargs)
        except Exception as exc:
            attempts.append(
                _error_details(
                    exc,
                    phase="connect",
                    elapsed_ms=round((time.perf_counter() - connect_started) * 1000),
                    route=route["name"],
                    port=route["port"],
                    family=route["family"],
                )
            )
            continue

        connect_elapsed_ms = round((time.perf_counter() - connect_started) * 1000)
        query_started = time.perf_counter()
        try:
            with connection:
                return_code, result = _read_only_queries(connection)
        except Exception as exc:
            return_code = 1
            result = _error_details(
                exc,
                phase="query",
                elapsed_ms=round((time.perf_counter() - query_started) * 1000),
            )
        if return_code == 0:
            attempts.append(
                {
                    "ok": True,
                    "route": route["name"],
                    "port": route["port"],
                    "family": route["family"],
                    "elapsed_ms": connect_elapsed_ms,
                }
            )
            return 0, {
                **endpoint_meta,
                "ok": True,
                "route": route["name"],
                "route_port": route["port"],
                "route_family": route["family"],
                "connect_elapsed_ms": connect_elapsed_ms,
                "attempts": attempts,
                **result,
            }

        result["connect_elapsed_ms"] = connect_elapsed_ms
        result["route"] = route["name"]
        result["port"] = route["port"]
        result["family"] = route["family"]
        attempts.append(result)

    categories = sorted({attempt["category"] for attempt in attempts if attempt.get("category")})
    return 1, {
        **endpoint_meta,
        "ok": False,
        "error": "database_diagnostic_failed",
        "phase": "routes",
        "categories": categories,
        "attempts": attempts,
    }


if __name__ == "__main__":
    exit_code, payload = run()
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))
    raise SystemExit(exit_code)
