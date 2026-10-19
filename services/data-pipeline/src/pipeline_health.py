"""Read-only backlog and coverage reporting for scheduled pipeline runs."""
from __future__ import annotations

import argparse
import json
import logging
import os
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path

from src.config import load_settings
from src.enrichment.display_fallback import ABSENCE_SENTENCE_PATTERN
from src.storage.supabase_client import connect

LOGGER = logging.getLogger(__name__)

# Projection de la visibilité du catalogue (docs/runbooks/catalogue-visibility-projection.md).
QUARANTINE_RULE_FUNCTION = "app_private.catalogue_quarantine_from_payload(jsonb)"
QUARANTINE_RULE = "app_private.catalogue_quarantine_from_payload(raw_payload)"
# Avant la migration 20261028110200, la colonne ne lisait que publication_quarantine.
LEGACY_QUARANTINE_RULE = "(coalesce(raw_payload ->> 'publication_quarantine', '') <> '')"
#: Une fiche de l'État sort du catalogue 14 jours après son observation (sale_catalogue_projection_is_live).
STATE_LISTING_LIFETIME_DAYS = 14
STATE_LISTING_WARNING_DAYS = 7
FULL_DRIFT_WEEKDAY = 0  # lundi (UTC) : la version complète de la requête de dérive, une fois par semaine


def main(*, report_only: bool = False) -> int:
    settings = load_settings()
    if not settings.get("supabase_db_url"):
        raise RuntimeError("Pipeline health requires SUPABASE_DB_URL")
    with connect(str(settings["supabase_db_url"])) as connection:
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
                max(last_seen_at),
                count(*) filter (where sale_date >= now() and raw_payload->>'llm_display_status' = 'stale'),
                count(*) filter (where sale_date >= now() and raw_payload->>'llm_display_status' = 'fallback'
                                 and nullif(btrim(raw_payload->>'llm_display_description'), '') is not null),
                count(*) filter (where sale_date >= now() and raw_payload->>'llm_display_description' ~* %s)
            from public.auction_sales group by source_name order by source_name
        """, (ABSENCE_SENTENCE_PATTERN,)).fetchall()
        source_fields = (
            "source", "total", "future", "missing_synthesis", "stale", "last_seen",
            "stale_synthesis", "fallback_synthesis", "absence_synthesis",
        )
        report["sources"] = [dict(zip(source_fields, row, strict=True)) for row in sources]
        report["synthesis_quality"] = summarize_synthesis_quality(report["sources"])
        # Daily counters written by record_source_checks on each source check.
        invalidations = connection.execute("""
            select coalesce(sum(case when jsonb_typeof(c.value->'display_invalidations'->'count') = 'number'
                                     then (c.value->'display_invalidations'->>'count')::numeric end), 0)
            from public.auction_sales s
            cross join lateral jsonb_each(case when jsonb_typeof(s.raw_payload->'source_checks') = 'object'
                                               then s.raw_payload->'source_checks' else '{}'::jsonb end) c
            where c.value->'display_invalidations'->>'day' = to_char(timezone('utc', now()), 'YYYY-MM-DD')
            group by s.id
        """).fetchall()
        report["display_invalidations_today"] = summarize_display_invalidations(row[0] for row in invalidations)
        report["catalogue_projection"] = catalogue_projection_report(
            connection, full_scan=full_drift_due(datetime.now(UTC))
        )
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


def full_drift_due(now: datetime) -> bool:
    """La requête de dérive complète (toutes les lignes) tourne le lundi (UTC) ; ``PIPELINE_HEALTH_FULL_DRIFT``
    la force (``true``) ou l'empêche (``false``)."""
    forced = (os.getenv("PIPELINE_HEALTH_FULL_DRIFT") or "").strip().lower()
    if forced in {"1", "true", "yes", "on"}:
        return True
    if forced in {"0", "false", "no", "off"}:
        return False
    return now.astimezone(UTC).weekday() == FULL_DRIFT_WEEKDAY


def catalogue_projection_report(connection: object, *, full_scan: bool) -> dict[str, object]:
    """Contrôles en lecture seule de la visibilité matérialisée du catalogue (des comptes, rien d'autre).

    * ``quarantine_drift_48h`` : lignes modifiées depuis 48 h dont ``catalogue_quarantined`` diffère de la
      quarantaine de ``raw_payload`` (requête du runbook, limitée aux lignes récentes) ;
    * ``quarantine_drift_full`` : la même sur toutes les lignes, une fois par semaine (``None`` sinon) ;
    * ``status_quarantined_without_flag`` : ventes ``status = 'quarantined'`` dont la colonne vaut faux
      (masquées par leur statut seul) ;
    * ``state_listings_leaving_7d`` : fiches de l'État visibles qui sortiront du catalogue sous 7 jours
      (observées il y a plus de 7 jours et moins de 14).

    Une base où les colonnes n'existent pas encore (migrations 20261027100000 et suivantes non appliquées)
    ne fait pas échouer le rapport : ``available`` vaut faux.
    """
    try:
        with connection.transaction():  # type: ignore[attr-defined]  # point de reprise : une erreur ne casse pas la suite
            has_rule = bool(
                connection.execute(  # type: ignore[attr-defined]
                    "select to_regprocedure(%s) is not null", (QUARANTINE_RULE_FUNCTION,)
                ).fetchone()[0]
            )
            rule = QUARANTINE_RULE if has_rule else LEGACY_QUARANTINE_RULE

            def count(sql: str) -> int:
                return _count(connection.execute(sql).fetchone()[0])  # type: ignore[attr-defined]

            return {
                "available": True,
                "quarantine_rule": "payload_keys" if has_rule else "publication_quarantine_only",
                "quarantine_drift_48h": count(
                    f"""select count(*) from public.auction_sales
                        where updated_at >= now() - interval '48 hours'
                          and catalogue_quarantined is distinct from {rule}"""
                ),
                "quarantine_drift_full": (
                    count(
                        f"""select count(*) from public.auction_sales
                            where catalogue_quarantined is distinct from {rule}"""
                    )
                    if full_scan
                    else None
                ),
                "status_quarantined_without_flag": count(
                    """select count(*) from public.auction_sales
                       where status = 'quarantined' and not catalogue_quarantined"""
                ),
                "state_listings_leaving_7d": count(
                    f"""select count(*) from public.auction_sales
                        where catalogue_state_observed_at is not null
                          and catalogue_state_observed_at > now() - interval '{STATE_LISTING_LIFETIME_DAYS} days'
                          and catalogue_state_observed_at <= now() - interval '{STATE_LISTING_WARNING_DAYS} days'
                          and coalesce(status, 'unknown') in ('upcoming', 'unknown', 'postponed')
                          and not catalogue_quarantined"""
                ),
            }
    except Exception as exc:  # colonne ou fonction absente : migration non appliquée
        LOGGER.warning("Catalogue projection report unavailable: %s", type(exc).__name__)
        return {"available": False, "error": type(exc).__name__}


def summarize_display_invalidations(per_sale_counts: Iterable[object]) -> dict[str, object]:
    """Source invalidations of the AI synthesis per sale, for the current UTC day.

    A sale invalidated several times a day is the regenerate-then-erase loop.
    """
    counts = [_count(value) for value in per_sale_counts if _count(value) > 0]
    total = sum(counts)
    return {
        "sales": len(counts),
        "invalidations": total,
        "per_sale_avg": round(total / len(counts), 2) if counts else 0,
        "per_sale_max": max(counts, default=0),
        "sales_with_3_or_more": sum(count >= 3 for count in counts),
    }


def summarize_synthesis_quality(sources: Iterable[Mapping[str, object]]) -> dict:
    """Share of upcoming syntheses that are the template, or state an absence.

    Rates are over upcoming sales that have a synthesis. ``None`` means there
    is nothing to measure, never a perfect score.
    """
    rows = list(sources)

    def rates(row: Mapping[str, object]) -> dict[str, object]:
        with_synthesis = _count(row.get("future")) - _count(row.get("missing_synthesis"))
        fallback = _count(row.get("fallback_synthesis"))
        absence = _count(row.get("absence_synthesis"))
        return {
            "with_synthesis": with_synthesis,
            "fallback_template": fallback,
            "absence_sentences": absence,
            "fallback_rate": round(fallback / with_synthesis, 4) if with_synthesis > 0 else None,
            "absence_sentence_rate": round(absence / with_synthesis, 4) if with_synthesis > 0 else None,
        }

    totals = {
        field: sum(_count(row.get(field)) for row in rows)
        for field in ("future", "missing_synthesis", "fallback_synthesis", "absence_synthesis")
    }
    return {**rates(totals), "by_source": {str(row.get("source")): rates(row) for row in rows}}


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
    projection = report.get("catalogue_projection") or {}
    return bool(
        report.get("stalled_runs")
        # Une annonce en quarantaine peut être publique, ou l'inverse : à corriger tout de suite.
        or _count(projection.get("quarantine_drift_48h"))
        or _count(projection.get("quarantine_drift_full"))
        or any(row["exhausted"] or row["overdue"] for row in report["queue"])
        or any(row["stale"] for row in report.get("sources", []))
        or latest.get("status") == "failed"
        or (latest.get("stages") or {}).get("collection") in {"failed", "partial"}
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-only", action="store_true", help="Report global incidents without changing this collection run result")
    raise SystemExit(main(report_only=parser.parse_args().report_only))
