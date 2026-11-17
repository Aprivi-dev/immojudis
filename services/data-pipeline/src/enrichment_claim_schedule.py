"""Which queue family the enrichment worker claims next, and how many jobs per claim.

Moved out of ``src.queued_runner`` on 17/11/2026 with the parallel lane (its size ceiling,
``tests/test_source_file_sizes.py``): the mixed worker alternates the two families with these rules
(``_enrichment_family_cycle``), while a worker of the parallel lane claims its own family only (``--family``), with
the same claim sizes (``_enrichment_claim_limit``). The code moved is unchanged.

``GeneralClaimPlan`` (17/11/2026, first unit of the parallel lane in production): after a refusal of the AI budget,
the general claims are document readings only for a while, and one general worker of the lane claims them first.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from src import general_lane_claims
from src.config import load_settings
from src.storage.supabase_client import connect

# The worker's log channel, as before the move: its journal lines keep their logger name.
LOGGER = logging.getLogger("src.queued_runner")

SOURCE_DETAIL_FAMILY = "source_detail"
ENRICHMENT_FAMILY = general_lane_claims.ENRICHMENT_FAMILY
# Keep a bounded general-enrichment lane even while source-detail is larger.
# Four slots preserve source-detail priority while reserving 25% of worker
# claims for display/fact/PDF jobs instead of allowing a persistent detail
# backlog to reduce the general lane to one claim in six.
ENRICHMENT_FAMILY_CYCLE = (SOURCE_DETAIL_FAMILY,) * 3 + (ENRICHMENT_FAMILY,)
ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE = 2
ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_MAX = 5
GENERAL_BACKLOG_RELIEF_CYCLE = (
    SOURCE_DETAIL_FAMILY,
    ENRICHMENT_FAMILY,
)
# After a refusal of the AI budget (hourly request cap, daily budget, cap of the execution), the general claims are
# document readings only (no AI call) for this long, then a fact pass is tried again. The hourly cap counts the calls
# of the last 60 minutes (reserve_llm_request): its slots come back as the oldest calls age out, so a fixed wait would
# leave them unused; one refused reservation per worker every 5 minutes at most, the deferred jobs keep their attempt.
FACT_PASSES_RETRY_AFTER_BUDGET_SECONDS = 5 * 60
#: One claim of the worker: (family, document readings only).
Claim = tuple[str, bool]


@dataclass
class GeneralClaimPlan:
    """The claims of one worker run, in the order to try them, slot after slot.

    Incident of 17/11/2026 (first unit of the parallel lane): the general workers stopped at the first refusal of the
    hourly AI cap and 189 document readings, which call no AI, waited in the queue. After a refusal
    (``budget_refused``), the general claims are document readings only (``enrichment_pdf``) for
    ``FACT_PASSES_RETRY_AFTER_BUDGET_SECONDS``; the fact passes stay queued without spending an attempt. ``pdf_first``
    (one general worker of the parallel lane): document readings first, the other general jobs when none is left. A
    database without the document-reading family (``general_lane_claims.pdf_family_available``) keeps the rule of
    before: no general claim after a refusal.
    """

    family: str | None
    pdf_first: bool
    family_cycle: tuple[str, ...]
    facts_resume_at: float | None = None
    llm_budget_refusals: int = 0

    def __post_init__(self) -> None:
        if self.pdf_first and self.family != ENRICHMENT_FAMILY:
            raise ValueError(f"Document readings first is a general worker, not {self.family!r}")

    def budget_refused(self, now: float) -> None:
        self.llm_budget_refusals += 1
        self.facts_resume_at = now + FACT_PASSES_RETRY_AFTER_BUDGET_SECONDS
        LOGGER.info("AI budget refused: document readings only for the next %ss", FACT_PASSES_RETRY_AFTER_BUDGET_SECONDS)

    def facts_paused(self, now: float) -> bool:
        return self.facts_resume_at is not None and now < self.facts_resume_at

    def claims(self, slot: int, now: float) -> list[Claim]:
        """The claims of this slot: the next one is tried only when the previous one was empty. None at all: a
        general worker whose database refuses the document-reading family while the AI budget refuses."""
        paused = self.facts_paused(now)
        pdf_claims = general_lane_claims.pdf_family_available()
        general: list[Claim] = [(ENRICHMENT_FAMILY, paused)] if pdf_claims or not paused else []
        if self.family == ENRICHMENT_FAMILY:
            if self.pdf_first and pdf_claims and not paused:
                return [(ENRICHMENT_FAMILY, True), (ENRICHMENT_FAMILY, False)]
            return general
        if self.family is not None:
            # A worker of the parallel lane claims its own family only: no ratio, no alternate.
            return [(self.family, False)]
        detail: list[Claim] = [(SOURCE_DETAIL_FAMILY, False)]
        if self.family_cycle[slot % len(self.family_cycle)] == SOURCE_DETAIL_FAMILY:
            return detail + general
        return general + detail


def _read_due_enrichment_family_counts() -> dict[str, int]:
    """Read a cheap due-backlog estimate without changing queue state.

    The worker is already required to have a transactional database connection
    for autonomous execution.  Keeping this small read-only query here avoids
    adding another RPC or making the SQL claim function decide the worker's
    lane ratio.  This estimate intentionally does not duplicate every claim
    eligibility join (retention, source state, and superseded revisions).  It
    is only a lane-ratio hint: every claim still applies the authoritative SQL
    eligibility checks, and an empty preferred lane immediately falls back to
    the other family.  An unavailable read is handled by the caller with a
    neutral cycle so a transient telemetry failure cannot starve one family.
    """
    settings = load_settings()
    db_url = str(settings.get("supabase_db_url") or "")
    if not db_url:
        return {}
    try:
        # This count only changes the lane ratio. Never spend the worker budget
        # on the regular write-connection retry sequence for optional telemetry.
        with connect(db_url, connect_timeout=3, retry_delays=()) as connection:
            connection.execute("set transaction read only")
            connection.execute("set local lock_timeout = '1000ms'")
            connection.execute("set local statement_timeout = '3000ms'")
            rows = connection.execute(
                """
                select case when job_type = 'source_detail'
                            then 'source_detail' else 'enrichment' end as family,
                       count(*)
                  from public.auction_enrichment_jobs
                 where (
                         status in ('queued', 'failed')
                         or (
                              status = 'running'
                              and coalesce(locked_at, updated_at)
                                  < statement_timestamp() - interval '30 minutes'
                            )
                       )
                   and next_attempt_at <= statement_timestamp()
                   and attempt_count < max_attempts
                 group by 1
                """
            ).fetchall()
    except Exception as exc:
        LOGGER.warning("Could not read enrichment queue lane counts: %s", exc)
        return {}
    return {str(family): int(count or 0) for family, count in rows}


def _enrichment_family_cycle(due_counts: dict[str, int]) -> tuple[str, ...]:
    """Choose a bounded lane ratio from one due-backlog estimate.

    The two lanes alternate when the estimated due general backlog is larger.
    If the optional read is unavailable, use the neutral 1:1 cycle instead of
    silently falling back to source-detail priority.  A degraded database
    connection must not turn a transient telemetry failure into starvation of
    display, fact, or PDF jobs.  The estimate is advisory and cannot make a
    family unclaimable: every preferred-lane miss immediately tries the
    alternate family.  When the estimate is available and source-detail is
    larger, source-detail remains guaranteed at least every fourth slot.
    The SQL claim still applies its per-source round-robin ordering inside the
    detail lane.
    """
    if not due_counts:
        return GENERAL_BACKLOG_RELIEF_CYCLE
    source_detail = max(0, int(due_counts.get(SOURCE_DETAIL_FAMILY, 0)))
    enrichment = max(0, int(due_counts.get(ENRICHMENT_FAMILY, 0)))
    if enrichment > source_detail:
        return GENERAL_BACKLOG_RELIEF_CYCLE
    return ENRICHMENT_FAMILY_CYCLE


def _enrichment_claim_batch_size(family: str) -> int:
    """Return a bounded claim size for one queue family.

    Only source-detail jobs are grouped. General jobs stay one per claim so a
    long PDF/LLM task cannot reserve an unnecessarily large batch. Invalid or
    out-of-range environment values fall back to the conservative default.
    """
    if family != SOURCE_DETAIL_FAMILY:
        return 1
    raw_value = os.getenv(
        "PIPELINE_ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE",
        str(ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE),
    )
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        value = ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_SIZE
    return max(1, min(ENRICHMENT_SOURCE_DETAIL_CLAIM_BATCH_MAX, value))


def _enrichment_claim_limit(
    family: str,
    *,
    slot: int,
    remaining: int,
    family_cycle: tuple[str, ...] = ENRICHMENT_FAMILY_CYCLE,
) -> int:
    """Bound one claim by both its batch size and its fair-cycle positions."""
    if family != SOURCE_DETAIL_FAMILY:
        return min(1, remaining)
    cycle_position = slot % len(family_cycle)
    detail_positions = 0
    while (
        detail_positions < len(family_cycle)
        and family_cycle[(cycle_position + detail_positions) % len(family_cycle)]
        == SOURCE_DETAIL_FAMILY
    ):
        detail_positions += 1
    # A preferred general claim can be empty.  The alternate detail lane still
    # needs one legal claim position even when the schedule points at general
    # enrichment for this slot.
    if detail_positions == 0:
        detail_positions = 1
    return min(_enrichment_claim_batch_size(family), detail_positions, remaining)
