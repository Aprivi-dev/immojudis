from __future__ import annotations

import calendar
import hashlib
import json
import math
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from src.outcome_statistics.models import (
    AdjustmentMethod,
    OutcomeVersion,
    Period,
    ReliabilityLevel,
    RoundKind,
    RoundObservation,
    SnapshotMember,
    StatisticsBundle,
    StatisticsSnapshot,
    UnfrozenRoundManifestEntry,
)

BUILDER_VERSION = "tribunal_statistics_builder_v1"
ELIGIBILITY_RULE_VERSION = "claim_ab_reviewed_frozen_round_as_of_v1"
SMOOTHING_RULE_VERSION = "jeffreys_beta_log_shrinkage_v1"

_WINDOWS = {12, 24, 36}
_KNOWN_STATUSES = {
    "cancelled",
    "not_requested",
    "postponed",
    "held_no_bid",
    "held_adjudicated",
}
_HELD_STATUSES = {"held_no_bid", "held_adjudicated"}
_KNOWN_SURENCHERE_STATUSES = {"filed", "not_filed", "deadline_expired"}


@dataclass(frozen=True, slots=True)
class _ResolvedRound:
    source: RoundObservation
    hearing_date: date
    outcome: OutcomeVersion | None
    terminal_reason: str | None
    eligible_claims: frozenset[str]
    member: SnapshotMember


def calculate_period(
    knowledge_cutoff_at: datetime,
    window_months: int,
    maturity_days: int = 30,
) -> Period:
    """Return a closed historical window, excluding the maturity lag.

    A 12-month period ending 2026-06-30 starts on 2025-07-01. The calculation
    uses calendar months, not an approximation in days.
    """

    cutoff = _aware_utc(knowledge_cutoff_at, "knowledge cutoff")
    if window_months not in _WINDOWS:
        raise ValueError("window_months must be one of 12, 24 or 36")
    if not 1 <= maturity_days <= 365:
        raise ValueError("maturity_days must be between 1 and 365")
    period_end = cutoff.date() - timedelta(days=maturity_days)
    period_start = _subtract_calendar_months(period_end + timedelta(days=1), window_months)
    return Period(
        start=period_start,
        end=period_end,
        window_months=cast("int", window_months),
        knowledge_cutoff_at=cutoff,
        maturity_days=maturity_days,
    )


def build_statistics_bundle(
    rounds: Iterable[RoundObservation],
    *,
    knowledge_cutoff_at: datetime,
    window_months: int,
    maturity_days: int = 30,
    round_kind: RoundKind = "initial",
    computed_at: datetime | None = None,
) -> StatisticsBundle:
    """Build one national parent and one child snapshot per court.

    The function is pure: it performs no I/O, uses no wall clock unless
    ``computed_at`` is omitted, and hashes canonical JSON so identical inputs yield
    identical manifests regardless of input order.
    """

    period = calculate_period(knowledge_cutoff_at, window_months, maturity_days)
    built_at = _aware_utc(computed_at or datetime.now(UTC), "computed_at")
    if built_at < period.knowledge_cutoff_at:
        raise ValueError("computed_at must not precede the knowledge cutoff")
    if round_kind != "initial":
        raise ValueError("statistics v1 supports initial rounds only")

    selected: list[_ResolvedRound] = []
    unfrozen_rounds: list[UnfrozenRoundManifestEntry] = []
    unfrozen_rounds_by_court: dict[str, list[UnfrozenRoundManifestEntry]] = defaultdict(list)
    seen_round_ids: set[str] = set()
    court_metadata: dict[str, tuple[str, str, str | None]] = {}
    for observation in rounds:
        if observation.round_id in seen_round_ids:
            raise ValueError("duplicate auction round in statistics input")
        seen_round_ids.add(observation.round_id)
        if observation.round_kind != round_kind:
            continue
        hearing_date = _local_hearing_date(observation)
        if not period.start <= hearing_date <= period.end:
            continue
        metadata = (
            observation.court_code.strip(),
            observation.court_name.strip(),
            observation.judicial_region.strip() if observation.judicial_region else None,
        )
        if not metadata[0] or not metadata[1]:
            raise ValueError("court code and name are required")
        previous = court_metadata.setdefault(observation.court_id, metadata)
        if previous != metadata:
            raise ValueError("inconsistent court metadata in statistics input")
        if observation.feature_snapshot_id is None:
            manifest_entry = UnfrozenRoundManifestEntry(
                round_id=observation.round_id,
                lot_id=observation.lot_id,
                court_id=observation.court_id,
                court_code=metadata[0],
                court_name=metadata[1],
                judicial_region=metadata[2],
                round_kind=observation.round_kind,
                scheduled_at=_aware_utc(observation.scheduled_at, "scheduled at"),
                local_timezone=observation.local_timezone,
            )
            unfrozen_rounds.append(manifest_entry)
            unfrozen_rounds_by_court[observation.court_id].append(manifest_entry)
            continue
        selected.append(_resolve_round(observation, hearing_date, period.knowledge_cutoff_at))

    selected.sort(key=lambda row: (row.source.scheduled_at, row.source.round_id))
    unfrozen_rounds.sort(key=lambda row: row.round_id)
    national = _build_snapshot(
        selected,
        period=period,
        round_kind=round_kind,
        computed_at=built_at,
        scope_type="national",
        court=None,
        parent=None,
        unfrozen_round_count=len(unfrozen_rounds),
        unfrozen_rounds=unfrozen_rounds,
    )
    grouped: dict[str, list[_ResolvedRound]] = defaultdict(list)
    for row in selected:
        grouped[row.source.court_id].append(row)
    tribunals = tuple(
        _build_snapshot(
            grouped.get(court_id, ()),
            period=period,
            round_kind=round_kind,
            computed_at=built_at,
            scope_type="tribunal",
            court=(court_id, *court_metadata[court_id]),
            parent=national,
            unfrozen_round_count=len(unfrozen_rounds_by_court[court_id]),
            unfrozen_rounds=unfrozen_rounds_by_court[court_id],
        )
        for court_id in sorted(
            court_metadata,
            key=lambda identifier: (
                court_metadata[identifier][0],
                identifier,
            ),
        )
    )
    return StatisticsBundle(national=national, tribunals=tribunals)


def terminal_outcome_at(
    outcomes: Sequence[OutcomeVersion],
    knowledge_cutoff_at: datetime,
) -> tuple[OutcomeVersion | None, str | None]:
    """Select the unique non-expired terminal outcome known at the cutoff.

    Future-created successors do not invalidate the outcome that was terminal at the
    historical cutoff. Ambiguous or broken lineages fail closed.
    """

    cutoff = _aware_utc(knowledge_cutoff_at, "knowledge cutoff")
    known = tuple(
        outcome
        for outcome in outcomes
        if _aware_utc(outcome.valid_from, "outcome valid_from") <= cutoff
        and _aware_utc(outcome.created_at, "outcome created_at") <= cutoff
        and _aware_utc(outcome.recorded_at or outcome.created_at, "outcome recorded_at") <= cutoff
    )
    candidates = tuple(
        outcome
        for outcome in known
        if outcome.valid_to is None or _aware_utc(outcome.valid_to, "outcome valid_to") > cutoff
    )
    if not candidates:
        return None, "no_terminal_outcome_at_cutoff"
    candidate_ids = {outcome.outcome_id for outcome in candidates}
    if len(candidate_ids) != len(candidates):
        return None, "ambiguous_terminal_outcome"
    superseded_ids = {
        outcome.supersedes_outcome_id for outcome in known if outcome.supersedes_outcome_id in candidate_ids
    }
    terminal = [outcome for outcome in candidates if outcome.outcome_id not in superseded_ids]
    if len(terminal) != 1:
        return None, "ambiguous_terminal_outcome"
    return terminal[0], None


def _build_snapshot(
    rows: Sequence[_ResolvedRound],
    *,
    period: Period,
    round_kind: RoundKind,
    computed_at: datetime,
    scope_type: str,
    court: tuple[str, str, str, str | None] | None,
    parent: StatisticsSnapshot | None,
    unfrozen_round_count: int,
    unfrozen_rounds: Sequence[UnfrozenRoundManifestEntry],
) -> StatisticsSnapshot:
    canonical_unfrozen_rounds = tuple(sorted(unfrozen_rounds, key=lambda row: row.round_id))
    if unfrozen_round_count != len(canonical_unfrozen_rounds):
        raise ValueError("unfrozen round count does not match its private manifest")
    status_known: list[_ResolvedRound] = []
    status_unknown = 0
    status_excluded: Counter[str] = Counter()
    for row in rows:
        if row.outcome is None:
            status_excluded[row.terminal_reason or "no_terminal_outcome_at_cutoff"] += 1
        elif "outcome_status" not in row.eligible_claims:
            status_excluded["outcome_status_claim_ineligible"] += 1
        elif row.outcome.outcome_status == "unknown":
            status_unknown += 1
        elif row.outcome.outcome_status in _KNOWN_STATUSES:
            status_known.append(row)
        else:  # pragma: no cover - constrained by both dataclass typing and Postgres.
            status_excluded["unsupported_outcome_status"] += 1

    status_sample_size = len(status_known)
    double_reviewed_count = sum(
        bool(row.outcome and row.outcome.status_independently_double_reviewed) for row in status_known
    )
    qa_cohort = status_known[: min(status_sample_size, 500)]
    qa_double_reviewed = sum(
        bool(row.outcome and row.outcome.status_independently_double_reviewed) for row in qa_cohort
    )
    qa_required = math.ceil(len(qa_cohort) * 0.20)
    review_coverage_gate_passed = qa_double_reviewed >= qa_required
    eligible_round_count = len(rows)
    mature_round_count = eligible_round_count + unfrozen_round_count
    freeze_coverage = _round_fraction(eligible_round_count, mature_round_count, 6) if mature_round_count else 1.0
    freeze_gate_passed = mature_round_count == 0 or _meets_four_fifths(
        eligible_round_count,
        mature_round_count,
    )
    review_gate_passed = status_sample_size >= 10 and review_coverage_gate_passed
    parent_gate_passed = parent is None or parent.quality_gate_passed
    quality_gate_passed = review_gate_passed and freeze_gate_passed and parent_gate_passed
    coverage = _round_fraction(status_sample_size, eligible_round_count, 6) if eligible_round_count else 0.0
    outcome_coverage_gate_passed = eligible_round_count == 0 or _meets_four_fifths(
        status_sample_size, eligible_round_count
    )
    reliability = _reliability(
        status_sample_size,
        quality_gate_passed,
        outcome_coverage_gate_passed,
    )

    parent_statistics = parent.statistics if parent else None
    parent_flow = cast("Mapping[str, dict[str, object]]", parent_statistics["flow"]) if parent_statistics else {}
    parent_surenchere = (
        cast("Mapping[str, dict[str, object]]", parent_statistics["surenchere"]) if parent_statistics else {}
    )
    held_count = sum(bool(row.outcome and row.outcome.outcome_status in _HELD_STATUSES) for row in status_known)
    adjudicated_rows = [row for row in status_known if row.outcome and row.outcome.outcome_status == "held_adjudicated"]

    flow_exclusions = dict(sorted(status_excluded.items()))
    flow = {
        "held": _rate_metric(
            numerator=held_count,
            known_denominator=status_sample_size,
            eligible_universe=eligible_round_count,
            unknown_count=status_unknown,
            exclusion_reasons=flow_exclusions,
            quality_gate_passed=quality_gate_passed,
            parent_metric=parent_flow.get("held"),
            national=parent is None,
        ),
        "postponed": _rate_metric(
            numerator=_status_count(status_known, "postponed"),
            known_denominator=status_sample_size,
            eligible_universe=eligible_round_count,
            unknown_count=status_unknown,
            exclusion_reasons=flow_exclusions,
            quality_gate_passed=quality_gate_passed,
            parent_metric=parent_flow.get("postponed"),
            national=parent is None,
        ),
        "cancelled": _rate_metric(
            numerator=_status_count(status_known, "cancelled"),
            known_denominator=status_sample_size,
            eligible_universe=eligible_round_count,
            unknown_count=status_unknown,
            exclusion_reasons=flow_exclusions,
            quality_gate_passed=quality_gate_passed,
            parent_metric=parent_flow.get("cancelled"),
            national=parent is None,
        ),
        "notRequested": _rate_metric(
            numerator=_status_count(status_known, "not_requested"),
            known_denominator=status_sample_size,
            eligible_universe=eligible_round_count,
            unknown_count=status_unknown,
            exclusion_reasons=flow_exclusions,
            quality_gate_passed=quality_gate_passed,
            parent_metric=parent_flow.get("notRequested"),
            national=parent is None,
        ),
    }
    flow["noBidIfHeld"] = _rate_metric(
        numerator=_status_count(status_known, "held_no_bid"),
        known_denominator=held_count,
        eligible_universe=held_count,
        unknown_count=0,
        exclusion_reasons={},
        quality_gate_passed=quality_gate_passed,
        parent_metric=parent_flow.get("noBidIfHeld"),
        national=parent is None,
    )
    flow["adjudicatedIfHeld"] = _rate_metric(
        numerator=len(adjudicated_rows),
        known_denominator=held_count,
        eligible_universe=held_count,
        unknown_count=0,
        exclusion_reasons={},
        quality_gate_passed=quality_gate_passed,
        parent_metric=parent_flow.get("adjudicatedIfHeld"),
        national=parent is None,
    )

    surenchere_numerator = 0
    surenchere_known = 0
    surenchere_unknown = 0
    surenchere_excluded: Counter[str] = Counter()
    for row in adjudicated_rows:
        assert row.outcome is not None
        if "surenchere_status" not in row.eligible_claims:
            surenchere_excluded["surenchere_status_claim_ineligible"] += 1
        elif row.outcome.surenchere_status in _KNOWN_SURENCHERE_STATUSES:
            surenchere_known += 1
            surenchere_numerator += row.outcome.surenchere_status == "filed"
        else:
            # window_open and unknown are explicitly unknown, never negative.
            surenchere_unknown += 1
    surenchere_metric = _rate_metric(
        numerator=surenchere_numerator,
        known_denominator=surenchere_known,
        eligible_universe=len(adjudicated_rows),
        unknown_count=surenchere_unknown,
        exclusion_reasons=dict(sorted(surenchere_excluded.items())),
        quality_gate_passed=quality_gate_passed,
        parent_metric=parent_surenchere.get("filed"),
        national=parent is None,
    )

    initial_values, initial_unknown, initial_exclusions = _price_ratio_values(
        adjudicated_rows,
        starting_claim="initial_starting_price_eur",
        starting_price=lambda row: row.source.initial_starting_price_eur,
    )
    effective_values, effective_unknown, effective_exclusions = _price_ratio_values(
        adjudicated_rows,
        starting_claim="effective_starting_price_eur",
        starting_price=lambda row: row.source.effective_starting_price_eur,
    )
    parent_price = (
        cast("Mapping[str, dict[str, object]]", parent_statistics["priceRatios"]) if parent_statistics else {}
    )
    final_to_initial = _distribution(
        values=initial_values,
        eligible_universe=len(adjudicated_rows),
        unknown_count=initial_unknown,
        exclusion_reasons=initial_exclusions,
        quality_gate_passed=quality_gate_passed,
        parent_distribution=parent_price.get("finalToInitial"),
        national=parent is None,
        transform=math.log,
        inverse=math.exp,
    )
    final_to_effective = _distribution(
        values=effective_values,
        eligible_universe=len(adjudicated_rows),
        unknown_count=effective_unknown,
        exclusion_reasons=effective_exclusions,
        quality_gate_passed=quality_gate_passed,
        parent_distribution=parent_price.get("finalToEffective"),
        national=parent is None,
        transform=math.log,
        inverse=math.exp,
    )
    final_to_market = _suppressed_distribution(
        eligible_universe=len(adjudicated_rows),
        reason="verified_market_estimate_unavailable",
        parent_sample_size=_parent_sample_size(parent_price.get("finalToMarket")),
    )

    delay_values: list[float] = []
    delay_unknown = 0
    delay_exclusions: Counter[str] = Counter()
    for row in status_known:
        assert row.outcome is not None
        if "result_observed_at" not in row.eligible_claims:
            delay_exclusions["result_observed_at_claim_ineligible"] += 1
        elif row.outcome.result_observed_at is None:
            delay_unknown += 1
        else:
            observed_at = _aware_utc(row.outcome.result_observed_at, "result observed at")
            if observed_at > period.knowledge_cutoff_at:
                delay_exclusions["result_observed_after_cutoff"] += 1
                continue
            delay_days = (observed_at - _aware_utc(row.source.scheduled_at, "scheduled at")).total_seconds() / 86_400
            if delay_days < 0:
                delay_exclusions["result_observed_before_hearing"] += 1
            else:
                delay_values.append(delay_days)
    parent_delays = cast("Mapping[str, dict[str, object]]", parent_statistics["delays"]) if parent_statistics else {}
    hearing_to_result = _distribution(
        values=delay_values,
        eligible_universe=status_sample_size,
        unknown_count=delay_unknown,
        exclusion_reasons=dict(sorted(delay_exclusions.items())),
        quality_gate_passed=quality_gate_passed,
        parent_distribution=parent_delays.get("hearingToKnownResult"),
        national=parent is None,
        transform=math.log1p,
        inverse=math.expm1,
    )
    postponed_count = _status_count(status_known, "postponed")
    postponement_to_next = _suppressed_distribution(
        eligible_universe=postponed_count,
        reason="verified_next_hearing_unavailable",
        parent_sample_size=_parent_sample_size(parent_delays.get("postponementToNextHearing")),
    )

    warnings = _warnings(
        status_sample_size=status_sample_size,
        review_gate_passed=review_coverage_gate_passed,
        outcome_coverage_gate_passed=outcome_coverage_gate_passed,
        tribunal=parent is not None,
        unfrozen_round_count=unfrozen_round_count,
        freeze_gate_passed=freeze_gate_passed,
        parent_gate_passed=parent_gate_passed,
    )
    fallback = (
        {"scope": "none", "parentLabel": None, "localWeight": 1.0}
        if parent is None
        else {
            "scope": "national",
            "parentLabel": "France entière",
            "localWeight": (_local_weight(status_sample_size) if flow["held"]["method"] != "suppressed" else 0.0),
        }
    )
    statistics: dict[str, object] = {
        "flow": flow,
        "surenchere": {"filed": surenchere_metric},
        "priceRatios": {
            "finalToInitial": final_to_initial,
            "finalToEffective": final_to_effective,
            "finalToMarket": final_to_market,
        },
        "delays": {
            "hearingToKnownResult": hearing_to_result,
            "postponementToNextHearing": postponement_to_next,
        },
        "fallback": fallback,
        "warnings": warnings,
    }

    members = tuple(row.member for row in rows)
    source_manifest_hash = _sha256(
        {
            "schema": "tribunal_statistics_source_manifest_v1",
            "members": sorted(member.member_hash for member in members),
            "unfrozenRoundCount": unfrozen_round_count,
            "unfrozenRounds": [round_entry.manifest_payload() for round_entry in canonical_unfrozen_rounds],
            "period": _period_payload(period),
            "roundKind": round_kind,
            "eligibilityRuleVersion": ELIGIBILITY_RULE_VERSION,
        }
    )
    court_id, court_code, court_name, judicial_region = court or (None, None, None, None)
    statistics_hash = _sha256(
        {
            "schema": "tribunal_statistics_snapshot_v1",
            "scope": scope_type,
            "courtId": court_id,
            "courtCode": court_code,
            "courtName": court_name,
            "judicialRegion": judicial_region,
            "period": _period_payload(period),
            "roundKind": round_kind,
            "builderVersion": BUILDER_VERSION,
            "eligibilityRuleVersion": ELIGIBILITY_RULE_VERSION,
            "smoothingRuleVersion": SMOOTHING_RULE_VERSION,
            "sourceManifestHash": source_manifest_hash,
            "parentStatisticsHash": parent.statistics_hash if parent else None,
            "samples": {
                "eligibleRounds": eligible_round_count,
                "unfrozenRounds": unfrozen_round_count,
                "freezeCoverage": freeze_coverage,
                "status": status_sample_size,
                "initialPrice": len(initial_values),
                "effectivePrice": len(effective_values),
                "marketPrice": 0,
                "surenchere": surenchere_known,
                "resultDelay": len(delay_values),
                "postponementDelay": 0,
                "doubleReviewed": double_reviewed_count,
            },
            "qualityGatePassed": quality_gate_passed,
            "reliability": reliability,
            "coverage": coverage,
            "statistics": statistics,
        }
    )
    return StatisticsSnapshot(
        scope_type=cast("str", scope_type),
        court_id=court_id,
        court_code=court_code,
        court_name=court_name,
        judicial_region=judicial_region,
        round_kind=round_kind,
        period=period,
        builder_version=BUILDER_VERSION,
        eligibility_rule_version=ELIGIBILITY_RULE_VERSION,
        smoothing_rule_version=SMOOTHING_RULE_VERSION,
        reliability_status=reliability,
        quality_gate_passed=quality_gate_passed,
        eligible_round_count=eligible_round_count,
        unfrozen_round_count=unfrozen_round_count,
        freeze_coverage=freeze_coverage,
        status_sample_size=status_sample_size,
        initial_price_sample_size=len(initial_values),
        effective_price_sample_size=len(effective_values),
        market_price_sample_size=0,
        surenchere_sample_size=surenchere_known,
        result_delay_sample_size=len(delay_values),
        postponement_delay_sample_size=0,
        double_reviewed_count=double_reviewed_count,
        outcome_coverage=coverage,
        statistics=statistics,
        source_manifest_hash=source_manifest_hash,
        statistics_hash=statistics_hash,
        computed_at=computed_at,
        members=members,
        unfrozen_rounds=canonical_unfrozen_rounds,
        parent_statistics_hash=parent.statistics_hash if parent else None,
    )


def _resolve_round(
    observation: RoundObservation,
    hearing_date: date,
    knowledge_cutoff_at: datetime,
) -> _ResolvedRound:
    outcome, terminal_reason = terminal_outcome_at(observation.outcomes, knowledge_cutoff_at)
    eligibility_is_as_of = bool(
        outcome
        and outcome.eligibility_evaluated_at is not None
        and _aware_utc(outcome.eligibility_evaluated_at, "eligibility cutoff") == knowledge_cutoff_at
    )
    eligible_claims = outcome.eligible_claims if outcome and eligibility_is_as_of else frozenset()
    reasons: list[str] = []
    if terminal_reason:
        reasons.append(terminal_reason)
    elif not eligibility_is_as_of:
        reasons.append("eligibility_not_evaluated_at_cutoff")
    assert outcome is not None or terminal_reason is not None
    status_claim_eligible = "outcome_status" in eligible_claims
    status_eligible = bool(outcome and status_claim_eligible and outcome.outcome_status in _KNOWN_STATUSES)
    if outcome and eligibility_is_as_of and not status_eligible:
        reasons.append(
            "unknown_outcome_status"
            if status_claim_eligible and outcome.outcome_status == "unknown"
            else "outcome_status_claim_ineligible"
        )
    finality_eligible = bool(
        status_eligible
        and outcome
        and outcome.outcome_status == "held_adjudicated"
        and "finality_status" in eligible_claims
        and outcome.finality_status == "procedurally_definitive"
    )
    initial_price_eligible = bool(
        status_eligible
        and "initial_starting_price_eur" in eligible_claims
        and observation.initial_starting_price_eur is not None
        and observation.initial_starting_price_eur > 0
    )
    effective_price_eligible = bool(
        status_eligible
        and "effective_starting_price_eur" in eligible_claims
        and observation.effective_starting_price_eur is not None
        and observation.effective_starting_price_eur > 0
    )
    initial_hammer_eligible = bool(
        status_eligible
        and outcome
        and outcome.outcome_status == "held_adjudicated"
        and "initial_hammer_price_eur" in eligible_claims
        and outcome.initial_hammer_price_eur is not None
        and outcome.initial_hammer_price_eur > 0
    )
    final_hammer_eligible = bool(
        finality_eligible
        and outcome
        and "final_hammer_price_eur" in eligible_claims
        and outcome.final_hammer_price_eur is not None
        and outcome.final_hammer_price_eur > 0
    )
    surenchere_eligible = bool(
        status_eligible
        and outcome
        and outcome.outcome_status == "held_adjudicated"
        and "surenchere_status" in eligible_claims
        and outcome.surenchere_status in _KNOWN_SURENCHERE_STATUSES
    )
    result_observed_eligible = bool(
        status_eligible
        and outcome
        and "result_observed_at" in eligible_claims
        and outcome.result_observed_at is not None
        and _aware_utc(outcome.result_observed_at, "result observed at")
        >= _aware_utc(observation.scheduled_at, "scheduled at")
        and _aware_utc(outcome.result_observed_at, "result observed at") <= knowledge_cutoff_at
    )
    flags = {
        "status_claim_eligible": status_eligible,
        "initial_starting_price_claim_eligible": initial_price_eligible,
        "effective_starting_price_claim_eligible": effective_price_eligible,
        "initial_hammer_price_claim_eligible": initial_hammer_eligible,
        "final_hammer_price_claim_eligible": final_hammer_eligible,
        "finality_status_claim_eligible": finality_eligible,
        "market_price_claim_eligible": False,
        "surenchere_claim_eligible": surenchere_eligible,
        "result_observed_at_claim_eligible": result_observed_eligible,
        "postponement_delay_eligible": False,
    }
    double_reviewed = bool(outcome and flags["status_claim_eligible"] and outcome.status_independently_double_reviewed)
    member_payload = {
        "schema": "tribunal_statistics_member_v1",
        "roundId": observation.round_id,
        "featureSnapshotId": observation.feature_snapshot_id,
        "lotId": observation.lot_id,
        "courtId": observation.court_id,
        "roundKind": observation.round_kind,
        "scheduledAt": _aware_utc(observation.scheduled_at, "scheduled at").isoformat(),
        "outcomeId": outcome.outcome_id if outcome else None,
        "outcome": _outcome_manifest(outcome),
        "initialStartingPriceEur": _decimal_string(observation.initial_starting_price_eur),
        "effectiveStartingPriceEur": _decimal_string(observation.effective_starting_price_eur),
        "eligibility": flags,
        "doubleReviewed": double_reviewed,
        "exclusionReasons": reasons,
    }
    member = SnapshotMember(
        round_id=observation.round_id,
        feature_snapshot_id=cast("str", observation.feature_snapshot_id),
        outcome_id=outcome.outcome_id if outcome else None,
        court_id=observation.court_id,
        double_reviewed=double_reviewed,
        exclusion_reasons=tuple(reasons),
        member_hash=_sha256(member_payload),
        **flags,
    )
    return _ResolvedRound(
        source=observation,
        hearing_date=hearing_date,
        outcome=outcome,
        terminal_reason=terminal_reason,
        eligible_claims=eligible_claims,
        member=member,
    )


def _rate_metric(
    *,
    numerator: int,
    known_denominator: int,
    eligible_universe: int,
    unknown_count: int,
    exclusion_reasons: Mapping[str, int],
    quality_gate_passed: bool,
    parent_metric: Mapping[str, object] | None,
    national: bool,
) -> dict[str, object]:
    excluded_count = sum(exclusion_reasons.values())
    if known_denominator + unknown_count + excluded_count != eligible_universe:
        raise ValueError("rate metric does not partition its eligible universe")
    if not 0 <= numerator <= known_denominator:
        raise ValueError("invalid metric numerator")
    if known_denominator < 10 or not quality_gate_passed:
        return _suppressed_metric()

    raw_value = numerator / known_denominator
    method: AdjustmentMethod = "beta_binomial"
    adjusted: float | None = None
    interval: dict[str, float] | None = None
    if national:
        alpha = numerator + 0.5
        beta = known_denominator - numerator + 0.5
    else:
        parent_value = _metric_parent_value(parent_metric)
        if parent_value is None:
            return _suppressed_metric()
        else:
            prior_strength = _prior_strength(known_denominator)
            alpha = numerator + 0.5 + parent_value * prior_strength
            beta = known_denominator - numerator + 0.5 + (1 - parent_value) * prior_strength
    if alpha > 0 and beta > 0:
        adjusted = alpha / (alpha + beta)
        interval = {
            "low": _round_probability(_beta_quantile(0.025, alpha, beta)),
            "high": _round_probability(_beta_quantile(0.975, alpha, beta)),
        }
    return {
        "rawValue": _round_probability(raw_value),
        "adjustedValue": _round_probability(adjusted) if adjusted is not None else None,
        "numerator": numerator,
        "knownDenominator": known_denominator,
        "eligibleUniverse": eligible_universe,
        "unknownCount": unknown_count,
        "excludedCount": excluded_count,
        "exclusionReasons": dict(sorted(exclusion_reasons.items())),
        "confidenceInterval": interval,
        "method": method,
    }


def _distribution(
    *,
    values: Sequence[float],
    eligible_universe: int,
    unknown_count: int,
    exclusion_reasons: Mapping[str, int],
    quality_gate_passed: bool,
    parent_distribution: Mapping[str, object] | None,
    national: bool,
    transform: Callable[[float], float],
    inverse: Callable[[float], float],
) -> dict[str, object]:
    sample_size = len(values)
    excluded_count = sum(exclusion_reasons.values())
    if sample_size + unknown_count + excluded_count != eligible_universe:
        raise ValueError("distribution does not partition its eligible universe")
    parent_sample_size = _parent_sample_size(parent_distribution)
    base = {
        "sampleSize": sample_size,
        "eligibleUniverse": eligible_universe,
        "unknownCount": unknown_count,
        "parentSampleSize": parent_sample_size,
        "excludedCount": excluded_count,
        "exclusionReasons": dict(sorted(exclusion_reasons.items())),
    }
    if sample_size < 10 or not quality_gate_passed:
        return _redacted_distribution()

    if national and sample_size < 30:
        return _redacted_distribution()
    if not national and (parent_sample_size < 10 or _parent_quantiles(parent_distribution) is None):
        return _redacted_distribution()

    transformed = sorted(transform(value) for value in values)
    raw_transformed = _quantiles(transformed)
    raw = _inverse_quantiles(raw_transformed, inverse)
    method: AdjustmentMethod = "raw" if national and sample_size >= 100 else "log_shrinkage"
    adjusted: dict[str, float] | None = None
    if national:
        if sample_size >= 100:
            adjusted = raw
        else:
            # The national reference has no parent. For small/medium national
            # samples, shrink tail log-quantiles toward the national median. This
            # is an explicit finite-sample regularizer, not a hidden court model.
            strength = _prior_strength(sample_size)
            weight = sample_size / (sample_size + strength)
            median = raw_transformed["p50"]
            adjusted = _inverse_quantiles(
                {
                    "p10": weight * raw_transformed["p10"] + (1 - weight) * median,
                    "p50": median,
                    "p90": weight * raw_transformed["p90"] + (1 - weight) * median,
                },
                inverse,
            )
    else:
        parent_adjusted = _parent_quantiles(parent_distribution)
        assert parent_adjusted is not None
        strength = _prior_strength(sample_size)
        weight = sample_size / (sample_size + strength)
        parent_transformed = {key: transform(value) for key, value in parent_adjusted.items()}
        blended = {
            key: weight * raw_transformed[key] + (1 - weight) * parent_transformed[key] for key in ("p10", "p50", "p90")
        }
        adjusted = _inverse_quantiles(blended, inverse)
    return {
        **base,
        "raw": raw,
        "adjusted": adjusted,
        "method": method,
    }


def _suppressed_distribution(
    *,
    eligible_universe: int,
    reason: str,
    parent_sample_size: int,
) -> dict[str, object]:
    del eligible_universe, reason, parent_sample_size
    return _redacted_distribution()


def _suppressed_metric() -> dict[str, object]:
    return {
        "rawValue": None,
        "adjustedValue": None,
        "numerator": None,
        "knownDenominator": None,
        "eligibleUniverse": None,
        "unknownCount": None,
        "excludedCount": None,
        "exclusionReasons": {},
        "confidenceInterval": None,
        "method": "suppressed",
    }


def _redacted_distribution() -> dict[str, object]:
    return {
        "sampleSize": None,
        "eligibleUniverse": None,
        "unknownCount": None,
        "raw": None,
        "adjusted": None,
        "method": "suppressed",
        "parentSampleSize": None,
        "excludedCount": None,
        "exclusionReasons": {},
    }


def _price_ratio_values(
    rows: Sequence[_ResolvedRound],
    *,
    starting_claim: str,
    starting_price: Callable[[_ResolvedRound], Decimal | None],
) -> tuple[list[float], int, dict[str, int]]:
    values: list[float] = []
    unknown = 0
    excluded: Counter[str] = Counter()
    for row in rows:
        assert row.outcome is not None
        if starting_claim not in row.eligible_claims:
            excluded[f"{starting_claim}_claim_ineligible"] += 1
        elif "final_hammer_price_eur" not in row.eligible_claims:
            excluded["final_hammer_price_claim_ineligible"] += 1
        elif "finality_status" not in row.eligible_claims:
            excluded["finality_status_claim_ineligible"] += 1
        elif row.outcome.finality_status != "procedurally_definitive":
            unknown += 1
        elif starting_price(row) is None or row.outcome.final_hammer_price_eur is None:
            unknown += 1
        elif starting_price(row) <= 0 or row.outcome.final_hammer_price_eur <= 0:
            excluded["non_positive_price"] += 1
        else:
            values.append(float(row.outcome.final_hammer_price_eur / starting_price(row)))
    return values, unknown, dict(sorted(excluded.items()))


def _reliability(
    sample_size: int,
    quality_gate_passed: bool,
    outcome_coverage_gate_passed: bool,
) -> ReliabilityLevel:
    if sample_size < 10 or not quality_gate_passed:
        return "insufficient_data"
    if sample_size < 30:
        return "smoothed"
    if sample_size < 100 or not outcome_coverage_gate_passed:
        return "descriptive"
    return "robust"


def _warnings(
    *,
    status_sample_size: int,
    review_gate_passed: bool,
    outcome_coverage_gate_passed: bool,
    tribunal: bool,
    unfrozen_round_count: int,
    freeze_gate_passed: bool,
    parent_gate_passed: bool,
) -> list[str]:
    warnings = [
        "Statistiques descriptives historiques, pas une prédiction individuelle.",
        "Seules les preuves A/B validées pour chaque champ sont comptées.",
        "Le ratio de prix exige un prix final procéduralement définitif; le prix initial d’adjudication ne le remplace jamais.",
        "Ratio au marché et délai vers la prochaine audience masqués faute de preuve canonique dédiée.",
    ]
    if status_sample_size < 10:
        warnings.append("Échantillon inférieur à 10: toutes les valeurs de la cellule sont masquées.")
    if not review_gate_passed:
        warnings.append(
            "Contrôle qualité non atteint: 20 % des 500 premiers résultats vérifiés doivent être relus indépendamment."
        )
    if not outcome_coverage_gate_passed:
        warnings.append("Couverture des résultats inférieure à 80 %: niveau robuste interdit.")
    if unfrozen_round_count:
        warnings.append("round_not_frozen_at_cutoff")
    # The caller suppresses publication when this selection gate is below 80 %.
    # Its exact numerator and denominator stay in private snapshot columns.
    if not freeze_gate_passed:
        warnings.append("Couverture du gel antérieur au cutoff inférieure à 80 %: publication supprimée.")
    if tribunal and not parent_gate_passed:
        warnings.append("Référence nationale non publiable: toutes les valeurs locales sont masquées.")
    if tribunal:
        warnings.append(
            "Le poids local affiché concerne l’échantillon de statuts; chaque cellule conserve son propre dénominateur."
        )
    return warnings


def _status_count(rows: Sequence[_ResolvedRound], status: str) -> int:
    return sum(bool(row.outcome and row.outcome.outcome_status == status) for row in rows)


def _metric_parent_value(metric: Mapping[str, object] | None) -> float | None:
    if not metric:
        return None
    value = metric.get("adjustedValue")
    if not isinstance(value, (float, int)):
        value = metric.get("rawValue")
    if isinstance(value, (float, int)) and 0 <= float(value) <= 1:
        return float(value)
    return None


def _parent_sample_size(distribution: Mapping[str, object] | None) -> int:
    if not distribution:
        return 0
    value = distribution.get("sampleSize")
    return int(value) if isinstance(value, int) and value >= 0 else 0


def _parent_quantiles(distribution: Mapping[str, object] | None) -> dict[str, float] | None:
    if not distribution:
        return None
    value = distribution.get("adjusted") or distribution.get("raw")
    if not isinstance(value, Mapping):
        return None
    quantiles: dict[str, float] = {}
    for key in ("p10", "p50", "p90"):
        item = value.get(key)
        if not isinstance(item, (float, int)) or float(item) < 0:
            return None
        quantiles[key] = float(item)
    return quantiles


def _prior_strength(sample_size: int) -> float:
    if sample_size < 30:
        return 30.0
    if sample_size < 100:
        return 15.0
    return 5.0


def _local_weight(sample_size: int) -> float:
    if sample_size < 10:
        return 0.0
    strength = _prior_strength(sample_size)
    return _round_probability(sample_size / (sample_size + strength + 1))


def _quantiles(values: Sequence[float]) -> dict[str, float]:
    if not values:
        raise ValueError("quantiles require values")
    return {
        "p10": _linear_quantile(values, 0.10),
        "p50": _linear_quantile(values, 0.50),
        "p90": _linear_quantile(values, 0.90),
    }


def _linear_quantile(values: Sequence[float], probability: float) -> float:
    position = (len(values) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return values[lower]
    fraction = position - lower
    return values[lower] * (1 - fraction) + values[upper] * fraction


def _inverse_quantiles(
    quantiles: Mapping[str, float],
    inverse: Callable[[float], float],
) -> dict[str, float]:
    return {key: _round_half_up(max(0.0, inverse(quantiles[key])), 6) for key in ("p10", "p50", "p90")}


def _beta_quantile(probability: float, alpha: float, beta: float) -> float:
    low = 0.0
    high = 1.0
    for _ in range(80):
        middle = (low + high) / 2
        if _regularized_beta(middle, alpha, beta) < probability:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def _regularized_beta(x: float, alpha: float, beta: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    logarithm = (
        math.lgamma(alpha + beta) - math.lgamma(alpha) - math.lgamma(beta) + alpha * math.log(x) + beta * math.log1p(-x)
    )
    factor = math.exp(logarithm)
    if x < (alpha + 1) / (alpha + beta + 2):
        return factor * _beta_continued_fraction(alpha, beta, x) / alpha
    return 1 - factor * _beta_continued_fraction(beta, alpha, 1 - x) / beta


def _beta_continued_fraction(alpha: float, beta: float, x: float) -> float:
    maximum_iterations = 10_000
    epsilon = 3e-14
    floor = 1e-300
    qab = alpha + beta
    qap = alpha + 1
    qam = alpha - 1
    c = 1.0
    d = 1 - qab * x / qap
    d = floor if abs(d) < floor else d
    d = 1 / d
    result = d
    for iteration in range(1, maximum_iterations + 1):
        doubled = 2 * iteration
        coefficient = iteration * (beta - iteration) * x / ((qam + doubled) * (alpha + doubled))
        d = 1 + coefficient * d
        d = floor if abs(d) < floor else d
        c = 1 + coefficient / c
        c = floor if abs(c) < floor else c
        d = 1 / d
        result *= d * c
        coefficient = -((alpha + iteration) * (qab + iteration) * x / ((alpha + doubled) * (qap + doubled)))
        d = 1 + coefficient * d
        d = floor if abs(d) < floor else d
        c = 1 + coefficient / c
        c = floor if abs(c) < floor else c
        d = 1 / d
        delta = d * c
        result *= delta
        if abs(delta - 1) < epsilon:
            return result
    raise ArithmeticError("beta continued fraction did not converge")


def _local_hearing_date(observation: RoundObservation) -> date:
    scheduled_at = _aware_utc(observation.scheduled_at, "scheduled at")
    try:
        timezone = ZoneInfo(observation.local_timezone)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("unknown local timezone in statistics input") from exc
    return scheduled_at.astimezone(timezone).date()


def _subtract_calendar_months(value: date, months: int) -> date:
    zero_based = value.year * 12 + value.month - 1 - months
    year, zero_based_month = divmod(zero_based, 12)
    month = zero_based_month + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _aware_utc(value: datetime, label: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{label} must be timezone-aware")
    return value.astimezone(UTC)


def _round_probability(value: float | None) -> float:
    if value is None:
        raise ValueError("probability is required")
    return _round_half_up(min(1.0, max(0.0, value)), 9)


def _round_fraction(numerator: int, denominator: int, digits: int) -> float:
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    quantum = Decimal(1).scaleb(-digits)
    value = (Decimal(numerator) / Decimal(denominator)).quantize(
        quantum,
        rounding=ROUND_HALF_UP,
    )
    return float(value)


def _meets_four_fifths(numerator: int, denominator: int) -> bool:
    if numerator < 0 or denominator <= 0 or numerator > denominator:
        raise ValueError("ratio counts are invalid")
    return numerator * 5 >= denominator * 4


def _round_half_up(value: float, digits: int) -> float:
    """Match PostgreSQL numeric round for non-negative published values.

    Python's built-in round uses ties-to-even while PostgreSQL numeric uses
    half-away-from-zero. Published statistics are non-negative, so
    ROUND_HALF_UP gives the same deterministic boundary behaviour.
    """

    quantum = Decimal(1).scaleb(-digits)
    return float(Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_UP))


def _decimal_string(value: Decimal | None) -> str | None:
    return format(value, "f") if value is not None else None


def _outcome_manifest(outcome: OutcomeVersion | None) -> dict[str, object] | None:
    if outcome is None:
        return None
    return {
        "id": outcome.outcome_id,
        "version": outcome.version,
        "validFrom": _aware_utc(outcome.valid_from, "outcome valid_from").isoformat(),
        "validTo": (_aware_utc(outcome.valid_to, "outcome valid_to").isoformat() if outcome.valid_to else None),
        "createdAt": _aware_utc(outcome.created_at, "outcome created_at").isoformat(),
        "recordedAt": _aware_utc(outcome.recorded_at or outcome.created_at, "outcome recorded_at").isoformat(),
        "supersedes": outcome.supersedes_outcome_id,
        "status": outcome.outcome_status,
        "initialHammerPriceEur": _decimal_string(outcome.initial_hammer_price_eur),
        "finalHammerPriceEur": _decimal_string(outcome.final_hammer_price_eur),
        "finalityStatus": outcome.finality_status,
        "surenchereStatus": outcome.surenchere_status,
        "resultObservedAt": (
            _aware_utc(outcome.result_observed_at, "result observed at").isoformat()
            if outcome.result_observed_at
            else None
        ),
        "eligibleClaims": sorted(outcome.eligible_claims),
        "statusIndependentlyDoubleReviewed": outcome.status_independently_double_reviewed,
        "eligibilityEvaluatedAt": (
            _aware_utc(outcome.eligibility_evaluated_at, "eligibility cutoff").isoformat()
            if outcome.eligibility_evaluated_at
            else None
        ),
    }


def _period_payload(period: Period) -> dict[str, object]:
    return {
        "start": period.start.isoformat(),
        "end": period.end.isoformat(),
        "windowMonths": period.window_months,
        "knowledgeCutoffAt": period.knowledge_cutoff_at.isoformat(),
        "maturityDays": period.maturity_days,
    }


def _sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
