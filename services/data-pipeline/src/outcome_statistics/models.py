from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

ClaimType = Literal[
    "outcome_status",
    "initial_starting_price_eur",
    "effective_starting_price_eur",
    "initial_hammer_price_eur",
    "final_hammer_price_eur",
    "finality_status",
    "surenchere_status",
    "result_observed_at",
]

RoundKind = Literal["initial", "postponed", "surenchere", "reiteration"]
OutcomeStatus = Literal[
    "unknown",
    "cancelled",
    "not_requested",
    "postponed",
    "held_no_bid",
    "held_adjudicated",
]
SurenchereStatus = Literal[
    "unknown",
    "window_open",
    "filed",
    "not_filed",
    "deadline_expired",
]
FinalityStatus = Literal["unknown", "provisional", "procedurally_definitive"]
ReliabilityLevel = Literal[
    "insufficient_data",
    "smoothed",
    "descriptive",
    "robust",
]
AdjustmentMethod = Literal[
    "suppressed",
    "raw",
    "beta_binomial",
    "national_fallback",
    "log_shrinkage",
]


@dataclass(frozen=True, slots=True)
class OutcomeVersion:
    """One immutable canonical outcome version and its reviewed claim gates.

    ``eligible_claims`` is deliberately claim-specific. The repository may only add a
    claim after ``app_private.outcome_claim_is_eligible_at`` has confirmed A/B
    evidence, lot/round matching and an unconflicted human review at the requested
    knowledge cutoff.
    """

    outcome_id: str
    version: int
    valid_from: datetime
    valid_to: datetime | None
    created_at: datetime
    supersedes_outcome_id: str | None
    outcome_status: OutcomeStatus
    initial_hammer_price_eur: Decimal | None = None
    final_hammer_price_eur: Decimal | None = None
    finality_status: FinalityStatus = "unknown"
    surenchere_status: SurenchereStatus = "unknown"
    result_observed_at: datetime | None = None
    eligible_claims: frozenset[ClaimType] = frozenset()
    status_independently_double_reviewed: bool = False
    eligibility_evaluated_at: datetime | None = None
    recorded_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class RoundObservation:
    """The complete as-of input for one auction round.

    The statistical unit is always this round, never an evidence row or an outcome
    version. Multiple outcome versions are kept so that the engine itself can select
    the unique terminal version known at the cutoff.
    """

    round_id: str
    lot_id: str
    court_id: str
    court_code: str
    court_name: str
    judicial_region: str | None
    round_kind: RoundKind
    scheduled_at: datetime
    local_timezone: str
    feature_snapshot_id: str | None
    initial_starting_price_eur: Decimal | None = None
    effective_starting_price_eur: Decimal | None = None
    outcomes: tuple[OutcomeVersion, ...] = ()


@dataclass(frozen=True, slots=True)
class Period:
    start: date
    end: date
    window_months: Literal[12, 24, 36]
    knowledge_cutoff_at: datetime
    maturity_days: int


@dataclass(frozen=True, slots=True)
class SnapshotMember:
    round_id: str
    feature_snapshot_id: str
    outcome_id: str | None
    court_id: str
    status_claim_eligible: bool
    initial_starting_price_claim_eligible: bool
    effective_starting_price_claim_eligible: bool
    initial_hammer_price_claim_eligible: bool
    final_hammer_price_claim_eligible: bool
    finality_status_claim_eligible: bool
    market_price_claim_eligible: bool
    surenchere_claim_eligible: bool
    result_observed_at_claim_eligible: bool
    postponement_delay_eligible: bool
    double_reviewed: bool
    exclusion_reasons: tuple[str, ...]
    member_hash: str


@dataclass(frozen=True, slots=True)
class UnfrozenRoundManifestEntry:
    """Private identity of a mature round excluded for lack of a frozen snapshot.

    The public aggregate only exposes the count. This deterministic private
    payload is nevertheless committed into the source hash so replacing or
    mutating an excluded round cannot leave an apparently identical snapshot.
    """

    round_id: str
    lot_id: str
    court_id: str
    court_code: str
    court_name: str
    judicial_region: str | None
    round_kind: RoundKind
    scheduled_at: datetime
    local_timezone: str

    def manifest_payload(self) -> dict[str, object]:
        if self.scheduled_at.tzinfo is None or self.scheduled_at.utcoffset() is None:
            raise ValueError("unfrozen round scheduled_at must be timezone-aware")
        scheduled_at = self.scheduled_at.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
        return {
            "roundId": self.round_id,
            "lotId": self.lot_id,
            "courtId": self.court_id,
            "courtCode": self.court_code,
            "courtName": self.court_name,
            "judicialRegion": self.judicial_region,
            "roundKind": self.round_kind,
            "scheduledAt": scheduled_at,
            "localTimezone": self.local_timezone,
        }


@dataclass(frozen=True, slots=True)
class StatisticsSnapshot:
    scope_type: Literal["national", "tribunal"]
    court_id: str | None
    court_code: str | None
    court_name: str | None
    judicial_region: str | None
    round_kind: RoundKind
    period: Period
    builder_version: str
    eligibility_rule_version: str
    smoothing_rule_version: str
    reliability_status: ReliabilityLevel
    quality_gate_passed: bool
    eligible_round_count: int
    unfrozen_round_count: int
    freeze_coverage: float
    status_sample_size: int
    initial_price_sample_size: int
    effective_price_sample_size: int
    market_price_sample_size: int
    surenchere_sample_size: int
    result_delay_sample_size: int
    postponement_delay_sample_size: int
    double_reviewed_count: int
    outcome_coverage: float
    statistics: dict[str, object]
    source_manifest_hash: str
    statistics_hash: str
    computed_at: datetime
    members: tuple[SnapshotMember, ...]
    unfrozen_rounds: tuple[UnfrozenRoundManifestEntry, ...]
    parent_statistics_hash: str | None = None


@dataclass(frozen=True, slots=True)
class StatisticsBundle:
    national: StatisticsSnapshot
    tribunals: tuple[StatisticsSnapshot, ...]


@dataclass(frozen=True, slots=True)
class PersistSummary:
    inserted_snapshots: int
    reused_snapshots: int
    inserted_members: int
