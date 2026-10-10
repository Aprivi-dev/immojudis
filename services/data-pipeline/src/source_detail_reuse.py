"""Close recurring checks already satisfied by a newer verified detail capture."""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from src.freshness import SOURCE_EXTRACTION_VERSION
from src.storage import supabase_client as storage

LOGGER = logging.getLogger(__name__)


def _timestamp(value: Any) -> datetime | None:
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def verified_detail_satisfies_job(
    payload: Any, sale_date: Any, status: Any, job: dict[str, Any], *, now: datetime
) -> bool:
    """Require an explicit detail proof for this alias, newer than this job."""
    if not isinstance(payload, dict) or status == "quarantined" or payload.get("source_identity_mismatch") or payload.get("publication_identity_conflict"):
        return False
    checks = payload.get("source_checks")
    check = checks.get(job.get("detail_source_url")) if isinstance(checks, dict) else None
    if not isinstance(check, dict) or check.get("detail_status") not in {"complete", "restricted"}:
        return False
    if check.get("source_name") != job.get("detail_source_name") or check.get("extractor_version") != SOURCE_EXTRACTION_VERSION or not check.get("fingerprint"):
        return False
    checked, created = _timestamp(check.get("checked_at")), _timestamp(job.get("created_at"))
    if checked is None or created is None or not created < checked <= now:
        return False
    date = _timestamp(sale_date)
    cadence = timedelta(hours=5 if date is not None and now <= date <= now + timedelta(days=7) else 23)
    return now - checked < cadence


def complete_already_verified_detail_job(
    sale: Any, job: dict[str, Any], settings: dict[str, Any]
) -> bool | None:
    """Return None to fetch, True when satisfied, False when the lease was lost.

    The preliminary check avoids an extra connection for old captures. The
    transaction repeats the proof against the locked catalogue and job rows;
    neither a replaced lease nor a changed catalogue can be certified here.
    """
    db_url = settings.get("supabase_db_url")
    if not db_url or not job.get("locked_at") or not verified_detail_satisfies_job(
        sale.raw_payload, sale.sale_date, sale.status, job, now=datetime.now(UTC)
    ):
        return None
    try:
        with storage.connect(str(db_url), connect_timeout=3, retry_delays=()) as db:
            db.execute("set local lock_timeout='2s'")
            db.execute("set local statement_timeout='3s'")
            db.execute("select pg_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1',0))")
            owned = db.execute(
                """select created_at,now() from public.auction_enrichment_jobs
                   where id=%s and source_url=%s and job_type='source_detail'
                     and detail_source_name=%s and detail_source_url=%s
                     and status='running' and attempt_count=%s and locked_at=%s
                     and locked_at>=now()-interval '30 minutes' for update""",
                (job['id'], job['source_url'], job['detail_source_name'], job['detail_source_url'], job['attempt_count'], job['locked_at']),
            ).fetchone()
            if not owned:
                return False
            row = db.execute(
                "select raw_payload,sale_date,status from public.auction_sales where source_url=%s for share",
                (job['source_url'],),
            ).fetchone()
            if row is None or not verified_detail_satisfies_job(
                *row, {**job, "created_at": owned[0]}, now=owned[1]
            ):
                return None
            db.execute(
                """update public.auction_enrichment_jobs set status='completed',locked_at=null,
                   attempt_count=greatest(attempt_count-1,0),last_error=null,
                   completed_at=now(),updated_at=now() where id=%s""", (job['id'],)
            )
        LOGGER.info("Source-detail job %s satisfied by a newer verified alias capture", job['id'])
        return True
    except Exception:
        # An optimization timeout leaves the claim intact for the normal
        # guarded fetch/publication path.
        LOGGER.warning("Could not reuse verified detail for job %s", job.get('id'), exc_info=True)
        return None
