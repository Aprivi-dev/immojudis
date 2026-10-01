"""Read-only backlog and coverage reporting for scheduled pipeline runs."""
from __future__ import annotations

import argparse
import json
import os
from collections.abc import Iterable, Mapping
from pathlib import Path

from src.config import load_settings
from src.storage.supabase_client import _postgres_connect


def main(*, report_only: bool = False) -> int:
    settings = load_settings()
    if not settings.get("supabase_db_url"):
        raise RuntimeError("Pipeline health requires SUPABASE_DB_URL")
    with _postgres_connect(str(settings["supabase_db_url"])) as connection:
        connection.execute("set transaction read only")
        rows = connection.execute("""
            select job_type, status, count(*) as row_count,
                   count(*) filter (where attempt_count >= max_attempts and status in ('queued', 'running', 'failed')) as exhausted,
                   count(*) filter (where status in ('queued', 'running', 'failed') and created_at < now() - interval '48 hours') as overdue,
                   count(*) filter (where created_at >= now() - interval '24 hours') as created_24h,
                   count(*) filter (where status = 'completed' and completed_at >= now() - interval '24 hours') as completed_24h,
                   count(*) filter (where status = 'failed' and updated_at >= now() - interval '24 hours') as failed_24h,
                   count(*) filter (where status = 'cancelled' and updated_at >= now() - interval '24 hours') as cancelled_24h,
                   min(created_at) filter (where status in ('queued', 'running', 'failed')) as oldest_pending_created_at
            from public.auction_enrichment_jobs
            group by job_type, status order by job_type, status
        """).fetchall()
        queue_rows = [
            dict(
                zip(
                    (
                        "type",
                        "status",
                        "count",
                        "exhausted",
                        "overdue",
                        "created_24h",
                        "completed_24h",
                        "failed_24h",
                        "cancelled_24h",
                        "oldest_pending_created_at",
                    ),
                    row,
                    strict=True,
                )
            )
            for row in rows
        ]
        report = {
            "queue": [
                {field: row[field] for field in ("type", "status", "count", "exhausted", "overdue")}
                for row in queue_rows
            ],
            "queue_activity_24h": summarize_queue_activity(queue_rows),
        }
        claimability = connection.execute("""
            select observed_at, metrics,
                   greatest(extract(epoch from (statement_timestamp() - observed_at)), 0)::bigint
            from public.auction_pipeline_observations
            where source_name = 'enrichment-queue'
            order by observed_at desc limit 1
        """).fetchone()
        if claimability:
            observed_at, metrics, age_seconds = claimability
            counts = compact_queue_claimability(metrics)
            if counts is not None:
                report["queue_claimability"] = {
                    "observed_at": observed_at,
                    "age_seconds": age_seconds,
                    **counts,
                }
        latest = connection.execute("""
            select status, summary->'scrape_coverage', summary->'stage_status'
            from public.auction_runs where source <> 'llm-description-backfill'
            order by created_at desc limit 1
        """).fetchone()
        if latest:
            status, coverage, stages = latest
            report["latest_collection"] = {
                "status": status,
                "coverage": compact_coverage(coverage),
                "stages": stages,
            }
        report["stalled_runs"] = connection.execute("""
            select count(*) from public.auction_runs where status = 'running'
            and coalesce(started_at, created_at) < now() - interval '100 minutes'
        """).fetchone()[0]
        sources = connection.execute("""
            select source_name, count(*),
                count(*) filter (where sale_date >= now()),
                count(*) filter (where sale_date >= now() and nullif(btrim(raw_payload->>'llm_display_description'), '') is null),
                count(*) filter (where sale_date >= now() and last_seen_at < now() - interval '7 days'),
                max(last_seen_at)
            from public.auction_sales group by source_name order by source_name
        """).fetchall()
        report["sources"] = [dict(zip(("source", "total", "future", "missing_synthesis", "stale", "last_seen"), row, strict=True)) for row in sources]
    failed = health_failed(report)
    report["global_health_status"] = "degraded" if failed else "healthy"
    output = json.dumps(report, ensure_ascii=False, indent=2, default=str)
    print(output)
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as handle:
            handle.write("\n### Pipeline coverage and backlog\n```json\n" + output + "\n```\n")
    if failed and report_only:
        print("::warning::Global pipeline health is degraded; see the backlog report and operational incidents. Collection status is reported separately.")
    return int(failed and not report_only)


def compact_queue_claimability(metrics: object) -> dict[str, int] | None:
    """Expose the latest observer snapshot separately from the raw backlog.

    Older SQL observers do not emit this split. Missing or malformed evidence
    must remain absent rather than being reported as zero admissible work.
    """
    if not isinstance(metrics, dict):
        return None
    fields = ("claimable_due", "excluded_due")
    if any(type(metrics.get(field)) is not int or metrics[field] < 0 for field in fields):
        return None
    return {field: metrics[field] for field in fields}


def compact_coverage(coverage: object) -> dict:
    """Keep the health report small; full URL evidence stays in auction_runs."""
    if not isinstance(coverage, dict):
        return {}
    fields = (
        "coverage_complete", "errors", "stop_reason", "listings_emitted",
        "requests_attempted", "requests_succeeded", "access_denials",
    )
    return {
        source: {field: details[field] for field in fields if field in details}
        for source, details in coverage.items()
        if isinstance(details, dict)
    }


def summarize_queue_activity(rows: Iterable[Mapping[str, object]]) -> dict:
    """Aggregate read-only queue counters without inventing a throughput rate.

    ``auction_enrichment_jobs`` stores one row per input revision and its
    current status. It does not store enqueue/upsert attempts or a status
    transition history. ``created_24h`` therefore counts rows whose
    ``created_at`` is recent, while the completed/failed/cancelled counters are
    snapshots of rows currently in that status with a recent terminal
    timestamp. The report deliberately leaves net throughput undefined.
    """
    families: dict[str, dict[str, object]] = {}
    for row in rows:
        family = str(row.get("type") or "unknown")
        status = str(row.get("status") or "unknown")
        summary = families.setdefault(
            family,
            {
                "type": family,
                "status_counts": {},
                "rows_created_24h": 0,
                "rows_completed_24h": 0,
                "rows_failed_24h": 0,
                "rows_cancelled_24h": 0,
                "pending_rows": 0,
                "overdue_rows_48h": 0,
                "exhausted_rows": 0,
                "oldest_pending_created_at": None,
            },
        )
        status_counts = summary["status_counts"]
        assert isinstance(status_counts, dict)
        status_counts[status] = int(status_counts.get(status, 0)) + _count(row.get("count"))
        summary["rows_created_24h"] = int(summary["rows_created_24h"]) + _count(row.get("created_24h"))
        summary["rows_completed_24h"] = int(summary["rows_completed_24h"]) + _count(row.get("completed_24h"))
        summary["rows_failed_24h"] = int(summary["rows_failed_24h"]) + _count(row.get("failed_24h"))
        summary["rows_cancelled_24h"] = int(summary["rows_cancelled_24h"]) + _count(row.get("cancelled_24h"))
        if status in {"queued", "running", "failed"}:
            summary["pending_rows"] = int(summary["pending_rows"]) + _count(row.get("count"))
            summary["overdue_rows_48h"] = int(summary["overdue_rows_48h"]) + _count(row.get("overdue"))
            summary["exhausted_rows"] = int(summary["exhausted_rows"]) + _count(row.get("exhausted"))
            candidate = row.get("oldest_pending_created_at")
            current = summary["oldest_pending_created_at"]
            if candidate is not None and (current is None or _timestamp_key(candidate) < _timestamp_key(current)):
                summary["oldest_pending_created_at"] = candidate

    return {
        "window_hours": 24,
        "families": [families[key] for key in sorted(families)],
        "throughput": {
            "calculable": False,
            "reason": (
                "auction_enrichment_jobs does not record enqueue/upsert attempts "
                "or status transitions; these counters cannot establish net ingress, "
                "drain, or jobs per hour"
            ),
        },
    }


def _count(value: object) -> int:
    """Convert nullable database counts to stable JSON integers."""
    return int(value or 0)


def _timestamp_key(value: object) -> tuple[int, object]:
    """Keep database timestamps comparable in tests and production reports."""
    if hasattr(value, "timestamp"):
        return (0, value.timestamp())
    return (1, str(value))


def health_failed(report: dict) -> bool:
    latest = report.get("latest_collection") or {}
    return bool(
        report.get("stalled_runs")
        or any(row["exhausted"] or row["overdue"] for row in report["queue"])
        or any(row["stale"] for row in report.get("sources", []))
        or latest.get("status") == "failed"
        or (latest.get("stages") or {}).get("collection") in {"failed", "partial"}
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-only", action="store_true", help="Report global incidents without changing this collection run result")
    raise SystemExit(main(report_only=parser.parse_args().report_only))
