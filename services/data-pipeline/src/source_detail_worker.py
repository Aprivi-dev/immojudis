"""Process recurring source-detail jobs from the bounded enrichment queue.

Source-detail verification deliberately has a smaller contract than the other
enrichment jobs: it reads one public provider page, reconciles it with the
existing catalogue row, and commits that revision together with its owned job.
It must not invoke PDF extraction, geocoding, or an LLM.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import httpx
from psycopg.types.json import Jsonb

from src.config import load_settings
from src.source_detail import (
    fetch_public_detail,
    prepare_source_revision,
    publish_source_revision,
)
from src.source_detail_reuse import complete_already_verified_detail_job
from src.source_task_deadline import (
    SourceTaskDeadlineExceeded,
    ensure_source_task_deadline,
    source_task_deadline_scope,
)
from src.sources.common import is_allowed_origin_url
from src.storage import supabase_client as storage
from src.storage.supabase_client import (
    fetch_sale_for_data_refresh,
    finish_auction_enrichment_job_in_supabase,
)

LOGGER = logging.getLogger(__name__)

# These are the failures for which a detail task should remain retryable while
# preserving the source's previous presence and freshness evidence.  The HTTP
# client itself owns the bounded retry loop; the worker only classifies the
# final exception and carries its retry deadline to the queue finish operation.
_ACCESS_STATUS_CODES = {401, 403}
_TRANSIENT_STATUS_CODES = {408, 425, 429, *range(500, 600)}
_TRANSIENT_MARKERS = (
    "timed out",
    "timeout",
    "connection reset",
    "connection refused",
    "network error",
    "remote protocol",
    "relay unavailable",
    "temporarily unavailable",
    "deferred until retry deadline",
)
_REVIEW_MARKERS = (
    "authentication rejected",
    "catalogue/search page",
    "identity unverified",
    "unsupported operator",
    "not found",
)
_MAX_TRANSIENT_RETRY_DELAY = timedelta(hours=6)


def run_source_detail_jobs(
    jobs: Iterable[dict[str, Any]],
    *,
    settings: dict[str, Any] | None = None,
    clients: dict[str, Any] | None = None,
    deadline: float | None = None,
    on_deferred: Callable[[list[str]], None] | None = None,
) -> int:
    """Run claimed source-detail jobs in claim order.

    A client map is shared for the whole bounded batch.  ``fetch_public_detail``
    keys that map by provider origin, so this also gives aliases of the same
    provider one polite request cadence.  Jobs are intentionally processed one
    at a time: each following job re-reads its sale after the preceding detail
    has been published.  ``deadline`` is an absolute monotonic cutoff for
    direct callers; the queue worker normally provides the same cutoff through
    the inherited task-local scope.  ``on_deferred`` receives each unique
    claimed job ID released because of that cutoff.
    """
    batch = [job for job in jobs if str(job.get("job_type") or "") == "source_detail"]
    if not batch:
        return 0
    active_settings = settings if settings is not None else load_settings()
    provider_clients = clients if clients is not None else {}
    reported_deferred_ids: set[str] = set()

    def report_deferred(job_ids: Iterable[str]) -> None:
        if on_deferred is None:
            return
        fresh_ids = [
            job_id
            for job_id in (str(value).strip() for value in job_ids)
            if job_id and job_id not in reported_deferred_ids
        ]
        if not fresh_ids:
            return
        reported_deferred_ids.update(fresh_ids)
        on_deferred(fresh_ids)

    deadline_scope = source_task_deadline_scope(deadline) if deadline is not None else nullcontext()
    with deadline_scope:
        for index, job in enumerate(batch):
            try:
                ensure_source_task_deadline("starting source-detail job")
                process_source_detail_job(
                    job,
                    settings=active_settings,
                    clients=provider_clients,
                    on_deferred=report_deferred,
                )
            except SourceTaskDeadlineExceeded as exc:
                released_ids = _release_deadline_claims(
                    batch[index:],
                    settings=active_settings,
                    operation=exc.operation,
                )
                report_deferred(released_ids)
                LOGGER.info(
                    "Source-detail worker deadline reached; released %s claimed job(s)",
                    len(batch) - index,
                )
                break
            except Exception:
                # A malformed queue row or an unexpected adapter failure must not
                # prevent the remaining providers in the claimed bounded batch
                # from being attempted.  The job itself is finished by the
                # per-job error path whenever possible.
                LOGGER.exception("Source-detail worker failed for job %s", job.get("id"))
    return len(batch)


def _release_deadline_claims(
    jobs: Iterable[dict[str, Any]],
    *,
    settings: dict[str, Any],
    operation: str,
) -> list[str]:
    """Return unstarted deadline claims without consuming an attempt.

    The guarded release is intentionally safe to repeat: a claim that was
    already released, completed, or reclaimed by another worker is a no-op.
    """

    reason = f"Source-detail task deadline reached during {operation}"
    released_ids: list[str] = []
    for job in jobs:
        release_source_detail_job_without_attempt(
            job,
            reason=reason,
            settings=settings,
        )
        job_id = str(job.get("id") or "").strip()
        if job_id:
            released_ids.append(job_id)
    return released_ids


def _release_deadline_claim(
    job: dict[str, Any],
    *,
    settings: dict[str, Any],
    exc: SourceTaskDeadlineExceeded,
    on_deferred: Callable[[list[str]], None] | None = None,
) -> None:
    """Release one claim after a cooperative source-task cutoff."""

    release_source_detail_job_without_attempt(
        job,
        reason=f"Source-detail task deadline reached during {exc.operation}",
        settings=settings,
    )
    job_id = str(job.get("id") or "").strip()
    if job_id and on_deferred is not None:
        on_deferred([job_id])


def process_source_detail_job(
    job: dict[str, Any],
    *,
    settings: dict[str, Any] | None = None,
    clients: dict[str, Any] | None = None,
    on_deferred: Callable[[list[str]], None] | None = None,
) -> bool:
    """Process one claimed detail job and return whether it was published.

    ``False`` includes a paused source, a retryable fetch failure, and an
    expired/reclaimed lease.  The latter is already handled atomically by
    :func:`publish_source_revision` and must not receive a second finish call.
    """
    active_settings = settings if settings is not None else load_settings()
    provider_clients = clients if clients is not None else {}
    try:
        ensure_source_task_deadline("starting source-detail job")
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    source_name = str(job.get("detail_source_name") or "").strip()
    canonical_url = str(job.get("source_url") or "").strip()
    detail_url = str(job.get("detail_source_url") or "").strip()
    if not source_name or not canonical_url or not detail_url:
        _finish_job(job, succeeded=False, error_message="source_detail job has incomplete identity")
        return False

    # The SQL claim checks these switches, but they can change while a worker
    # is fetching another row.  Check immediately before any client creation
    # or HTTP request so a pause never starts a new network call.
    try:
        source_enabled = source_detail_source_enabled(source_name, active_settings)
        ensure_source_task_deadline("finishing source-detail source gate")
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    if not source_enabled:
        release_source_detail_job_without_attempt(
            job, reason="Source-detail source is paused before fetch", settings=active_settings
        )
        return False

    # A shared provider client can already carry a future Retry-After from a
    # previous job. Releasing this claim before the adapter is called prevents
    # a second task from consuming an attempt without issuing HTTP.
    try:
        ensure_source_task_deadline("checking source-detail provider retry deadline")
        retry_not_before = _client_retry_not_before(source_name, detail_url, provider_clients)
        ensure_source_task_deadline("finishing source-detail provider retry check")
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    if retry_not_before is not None and retry_not_before > datetime.now(UTC):
        release_source_detail_job_without_attempt(
            job,
            reason=f"Source deferred until {retry_not_before.isoformat()}",
            settings=active_settings,
            retry_not_before=retry_not_before,
        )
        return False

    try:
        existing = fetch_sale_for_data_refresh(canonical_url)
        ensure_source_task_deadline("finishing source-detail sale lookup")
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    except Exception as exc:
        _finish_job(job, succeeded=False, error_message=str(exc))
        return False
    if existing is None:
        _finish_job(job, succeeded=False, error_message="sale not found")
        return False

    try:
        ensure_source_task_deadline("checking verified source-detail reuse")
        satisfied = complete_already_verified_detail_job(existing, job, active_settings)
        ensure_source_task_deadline("finishing verified source-detail reuse")
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    if satisfied is not None:
        return satisfied

    # The sale lookup can race an administrative pause.  Repeat the gate at
    # the actual network boundary, after all local work for this item.
    try:
        source_enabled = source_detail_source_enabled(source_name, active_settings)
        ensure_source_task_deadline("finishing source-detail source gate")
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    if not source_enabled:
        release_source_detail_job_without_attempt(
            job, reason="Source-detail source is paused before fetch", settings=active_settings
        )
        return False

    try:
        ensure_source_task_deadline("starting source-detail fetch")
        _endpoint, _body, raw = fetch_public_detail(
            source_name,
            detail_url,
            active_settings,
            provider_clients,
        )
        if not isinstance(raw, dict):
            raise ValueError("Source detail parser returned no mapping")
        if not raw:
            raise ValueError("Source detail parser returned no verified data")
        ensure_source_task_deadline("finishing source-detail fetch")
        # All existing adapters normally emit this identity themselves.  The
        # fallback is needed for a small provider alias parser that only emits
        # facts, and keeps freshness keyed to the URL that was actually read.
        raw.setdefault("source_url", detail_url)
        raw.setdefault("source_name", source_name)
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    except Exception as exc:
        metrics = _client_metrics(_client_for_job(source_name, detail_url, provider_clients))
        status_code = _http_status_code(exc)
        failure_kind = _classify_detail_failure(exc, status_code)
        retry_not_before = _retry_not_before_for_failure(job, metrics, failure_kind)
        if _is_access_refusal(exc, status_code):
            report_source_detail_refusal(
                source_name,
                error_message=str(exc),
                coverage=metrics,
                settings=active_settings,
            )
        error_message = f"{failure_kind}: {str(exc)}"
        # A transient provider/network failure remains retryable, with an
        # exponential deadline bounded at six hours and by the queue's own
        # max_attempts.  A deterministic identity/access failure is a review
        # item and is terminal for this claimed URL, so it cannot burn the
        # backlog one identical attempt at a time.
        _finish_job(
            job,
            succeeded=False,
            cancelled=failure_kind == "review_required",
            error_message=error_message,
            retry_not_before=retry_not_before if failure_kind == "transient" else None,
        )
        return False

    try:
        ensure_source_task_deadline("preparing source-detail publication")
        revision = prepare_source_revision(existing, raw)
        ensure_source_task_deadline("finishing source-detail publication preparation")
        ensure_source_task_deadline("publishing source-detail revision")
        # This operation owns the lease check, catalogue revision check, table
        # writes, and terminal job update in one transaction.  A false result
        # means another worker reclaimed the lease or a newer catalogue row
        # won the race; finishing it here would be unsafe.
        return bool(publish_source_revision(revision, job, active_settings))
    except SourceTaskDeadlineExceeded as exc:
        _release_deadline_claim(job, settings=active_settings, exc=exc, on_deferred=on_deferred)
        return False
    except Exception as exc:
        LOGGER.exception("Source-detail publication failed for %s", canonical_url)
        _finish_job(job, succeeded=False, error_message=str(exc))
        return False


def source_detail_source_enabled(source_name: str, settings: dict[str, Any]) -> bool:
    """Read the global and per-source gates immediately before HTTP.

    The worker reads the database directly at the network boundary.  A missing
    transactional database is fail-closed: it cannot prove that source-detail
    automation is enabled.
    """
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        return False
    try:
        with storage._shared_postgres_connection(db_url) as db:
            row = db.execute(
                """select c.enabled,c.source_details_enabled,s.enabled,s.suspended_until
                   from public.auction_pipeline_control c
                   join public.auction_source_state s on s.source_name=%s
                  where c.id""",
                (source_name,),
            ).fetchone()
    except Exception:
        LOGGER.exception("Could not read source-detail pause state for %s", source_name)
        return False
    if not row:
        return False
    global_enabled, details_enabled, source_enabled, suspended_until = row
    if not bool(global_enabled) or not bool(details_enabled) or not bool(source_enabled):
        return False
    if suspended_until is None:
        return True
    if isinstance(suspended_until, datetime):
        deadline = suspended_until
    else:
        try:
            deadline = datetime.fromisoformat(str(suspended_until).replace("Z", "+00:00"))
        except ValueError:
            return False
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=UTC)
    return deadline <= datetime.now(UTC)


def release_source_detail_job_without_attempt(
    job: dict[str, Any],
    *,
    reason: str,
    settings: dict[str, Any] | None = None,
    retry_not_before: datetime | str | None = None,
) -> None:
    """Return a raced paused claim to the queue without consuming its attempt."""
    db_url = str((settings or load_settings()).get("supabase_db_url") or "")
    if not db_url:
        LOGGER.error(
            "Cannot release paused source-detail job %s without transactional database: %s",
            job.get("id"),
            reason,
        )
        return
    attempt = job.get("attempt_count")
    retry_deadline = _aware_timestamp(retry_not_before)
    next_attempt_sql = ""
    params: list[Any] = [reason[:1000], str(job.get("id") or "")]
    if retry_deadline is not None and retry_deadline > datetime.now(UTC):
        next_attempt_sql = "next_attempt_at=greatest(next_attempt_at,%s),"
        params.insert(0, retry_deadline)
    where = "id=%s and status='running'"
    if attempt is not None:
        where += " and attempt_count=%s"
        params.append(int(attempt))
    if job.get("locked_at") is not None:
        where += " and locked_at=%s"
        params.append(job["locked_at"])
    try:
        with storage.connect(db_url) as db:
            db.execute(
                f"""update public.auction_enrichment_jobs
                       set status='queued',{next_attempt_sql}
                           attempt_count=greatest(attempt_count-1,0),
                           locked_at=null,last_error=%s,updated_at=now()
                     where {where}""",
                tuple(params),
            )
    except Exception:
        LOGGER.exception("Could not release paused source-detail job %s", job.get("id"))


def report_source_detail_refusal(
    source_name: str,
    *,
    error_message: str,
    coverage: dict[str, Any],
    settings: dict[str, Any],
) -> None:
    """Persist one access refusal and suspend a persistently refusing source.

    Refusal evidence is kept in the source-state coverage JSON because this
    worker has no extra counter column. One failed detail task counts as one
    task refusal; a Polite client reporting two observed HTTP refusals suspends
    immediately. The database decides the threshold under a row lock, and no
    catalogue row is deleted or marked absent.
    """
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        LOGGER.error(
            "Cannot persist source-detail refusal for %s without transactional database: %s (%s)",
            source_name,
            error_message,
            coverage,
        )
        return
    now = datetime.now(UTC)
    retry_not_before = _aware_timestamp(coverage.get("retry_not_before"))
    observed_http_refusals = _nonnegative_int(coverage.get("access_denials"))
    try:
        with storage.connect(db_url) as db:
            row = db.execute(
                """select coverage,suspended_until,next_inventory_at
                     from public.auction_source_state
                    where source_name=%s
                    for update""",
                (source_name,),
            ).fetchone()
            if not row:
                LOGGER.error("Cannot persist refusal: unknown source %s", source_name)
                return
            previous_coverage = row[0] if isinstance(row[0], dict) else {}
            previous_detail = previous_coverage.get("source_detail")
            previous_detail = previous_detail if isinstance(previous_detail, dict) else {}
            refusal_tasks = _nonnegative_int(previous_detail.get("refusal_tasks")) + 1
            previous_http_refusals = _nonnegative_int(previous_detail.get("http_refusals"))
            http_refusals = max(previous_http_refusals, observed_http_refusals)
            persistent = observed_http_refusals >= 2 or refusal_tasks >= 2

            existing_suspension = _aware_timestamp(row[1])
            existing_inventory_deadline = _aware_timestamp(row[2])
            retry_deadline = max(
                (candidate for candidate in (retry_not_before, existing_suspension) if candidate is not None),
                default=now,
            )
            suspension_deadline = max(
                retry_deadline,
                now + timedelta(hours=24) if persistent else now,
            )
            inventory_deadline = max(
                (
                    candidate
                    for candidate in (existing_inventory_deadline, retry_deadline, suspension_deadline)
                    if candidate is not None
                ),
                default=now,
            )
            detail_coverage = {
                **previous_detail,
                "refusal_tasks": refusal_tasks,
                "http_refusals": http_refusals,
                "last_refusal_at": now.isoformat(),
                "last_error": error_message[:1000],
            }
            if retry_not_before is not None:
                detail_coverage["retry_not_before"] = retry_not_before.isoformat()
            next_coverage = {
                **previous_coverage,
                "source_detail": detail_coverage,
            }
            db.execute(
                """update public.auction_source_state set
                    coverage=%s,
                    availability='access_denied',
                    last_error=%s,
                    suspension_reason=%s,
                    suspended_until=%s,
                    next_inventory_at=%s,
                    last_attempt_at=%s,
                    updated_at=%s
                  where source_name=%s""",
                (
                    Jsonb(next_coverage),
                    error_message[:1000],
                    "Persistent source-detail access refusal" if persistent else "Source-detail access refused",
                    suspension_deadline,
                    inventory_deadline,
                    now,
                    now,
                    source_name,
                ),
            )
    except Exception:
        LOGGER.exception("Could not persist source-detail refusal for %s", source_name)


def _finish_job(
    job: dict[str, Any],
    *,
    succeeded: bool,
    cancelled: bool = False,
    error_message: str | None = None,
    retry_not_before: str | None = None,
) -> None:
    """Finish only the claimed attempt, carrying Polite's retry deadline."""
    kwargs: dict[str, Any] = {
        "succeeded": succeeded,
        "cancelled": cancelled,
        "error_message": error_message,
    }
    if job.get("attempt_count") is not None:
        kwargs["attempt_count"] = int(job["attempt_count"])
    if job.get("locked_at") is not None:
        kwargs["locked_at"] = job["locked_at"]
    if retry_not_before:
        kwargs["retry_not_before"] = retry_not_before
    finish_auction_enrichment_job_in_supabase(str(job.get("id") or ""), **kwargs)


def _client_for_job(source_name: str, detail_url: str, clients: dict[str, Any]) -> Any | None:
    """Select the Polite client belonging to this job's provider origin."""
    if source_name == 'notaires':
        from src.sources.notaires import BASE_URL as NOTAIRES_BASE_URL

        return clients.get(NOTAIRES_BASE_URL)
    for origin, client in clients.items():
        if is_allowed_origin_url(detail_url, (str(origin),)):
            return client
    if source_name == "agrasc":
        from src.sources.agrasc_operators import IMMO_ORIGIN
        from src.sources.notaires import BASE_URL as NOTAIRES_BASE_URL

        if is_allowed_origin_url(detail_url, (IMMO_ORIGIN,)):
            return clients.get(NOTAIRES_BASE_URL)
    return None


def _client_retry_not_before(source_name: str, detail_url: str, clients: dict[str, Any]) -> datetime | None:
    """Return a shared client's future Retry-After deadline, if any."""
    client = _client_for_job(source_name, detail_url, clients)
    metrics = _client_metrics(client)
    return _aware_timestamp(metrics.get("retry_not_before"))


def _client_metrics(client: Any | None) -> dict[str, Any]:
    if client is None:
        return {}
    metrics = getattr(client, "coverage_metrics", None)
    if not callable(metrics):
        return {}
    try:
        result = metrics()
    except Exception:
        return {}
    return dict(result) if isinstance(result, dict) else {}


def _aware_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        candidate = value
    elif isinstance(value, str):
        try:
            candidate = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if candidate.tzinfo is None or candidate.utcoffset() is None:
        return None
    return candidate.astimezone(UTC)


def _nonnegative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _http_status_code(exc: BaseException) -> int | None:
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    return None


def _classify_detail_failure(
    exc: BaseException,
    status_code: int | None = None,
) -> Literal["transient", "review_required"]:
    """Classify the final adapter failure before it reaches the queue.

    The adapter already retries individual requests.  This second boundary
    only decides whether the claimed job should receive a bounded queue retry
    or be surfaced as a deterministic review item.
    """
    status_code = status_code if status_code is not None else _http_status_code(exc)
    if status_code in _TRANSIENT_STATUS_CODES:
        return "transient"
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, TimeoutError, ConnectionError)):
        return "transient"
    message = str(exc).casefold()
    if any(marker in message for marker in _TRANSIENT_MARKERS):
        return "transient"
    if status_code in _ACCESS_STATUS_CODES or any(marker in message for marker in _REVIEW_MARKERS):
        return "review_required"
    return "review_required"


def _retry_not_before_for_failure(
    job: dict[str, Any],
    metrics: dict[str, Any],
    failure_kind: Literal["transient", "review_required"],
) -> str | None:
    """Return a bounded retry deadline for transient detail failures."""
    if failure_kind != "transient":
        return None
    now = datetime.now(UTC)
    retry_deadline = _aware_timestamp(metrics.get("retry_not_before"))
    # Preserve an already-recorded provider deadline when it is in the past;
    # the queue finish function still applies its normal thirty-minute floor.
    if retry_deadline is not None and retry_deadline <= now:
        return retry_deadline.isoformat()
    try:
        attempt = max(1, int(job.get("attempt_count") or 1))
    except (TypeError, ValueError, OverflowError):
        attempt = 1
    delay = min(_MAX_TRANSIENT_RETRY_DELAY, timedelta(minutes=30 * (2 ** min(attempt - 1, 4))))
    candidate = now + delay
    if retry_deadline is not None:
        candidate = max(candidate, retry_deadline)
    return candidate.isoformat()


def _is_access_refusal(exc: BaseException, status_code: int | None) -> bool:
    if status_code in _ACCESS_STATUS_CODES:
        return True
    message = str(exc).lower()
    return any(
        marker in message
        for marker in (
            "robots access refused",
            "access denied",
            "access refusal",
            "robots.txt does not allow",
            "suspended after repeated access refusals",
        )
    )


__all__ = [
    "process_source_detail_job",
    "release_source_detail_job_without_attempt",
    "report_source_detail_refusal",
    "run_source_detail_jobs",
    "source_detail_source_enabled",
]
