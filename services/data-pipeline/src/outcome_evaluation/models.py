from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Literal

EvaluationMode = Literal["historical_replay", "prospective_shadow"]
PredictionStatus = Literal["ready", "abstained", "missing"]
OutcomeClass = Literal[
    "cancelled_or_not_requested",
    "postponed",
    "held_no_bid",
    "held_adjudicated",
]

OUTCOME_CLASSES: tuple[OutcomeClass, ...] = (
    "cancelled_or_not_requested",
    "postponed",
    "held_no_bid",
    "held_adjudicated",
)
SEGMENT_DIMENSIONS = frozenset(
    {
        "judicial_region",
        "tribunal",
        "procedure_type",
        "property_type",
        "occupation_status",
        "source_family",
        "horizon",
    }
)
_SAFE_SEGMENT_VALUE = re.compile(r"^[\w .()'\-/]{1,80}$", re.UNICODE)
_UUID_LIKE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class EvaluationInputError(ValueError):
    """Raised when an evaluation payload violates the fail-closed contract."""


@dataclass(frozen=True, slots=True)
class PriceQuantiles:
    p10: float
    p50: float
    p90: float

    def __post_init__(self) -> None:
        values = (self.p10, self.p50, self.p90)
        if not all(math.isfinite(value) and value > 0 for value in values):
            raise EvaluationInputError("price quantiles must be finite and strictly positive")
        if not self.p10 <= self.p50 <= self.p90:
            raise EvaluationInputError("price quantiles must be monotone")


@dataclass(frozen=True, slots=True)
class EvaluationRecord:
    """One internal evaluation unit.

    ``lot_key`` is used only to prevent temporal leakage across repeated rounds. It
    is deliberately never copied into the aggregate report.
    """

    lot_key: str
    scheduled_at: datetime
    label_available_at: datetime | None
    price_label_available_at: datetime | None
    label_grade: Literal["A", "B", "C"] | None
    outcome: OutcomeClass | None
    actual_price_eur: float | None
    starting_price_eur: float | None
    snapshot_available: bool
    snapshot_cutoff_at: datetime | None
    leakage_check_passed: bool
    prediction_status: PredictionStatus
    prediction_generated_at: datetime | None
    prediction_recorded_at: datetime | None
    probabilities: Mapping[OutcomeClass, float] | None
    price_quantiles: PriceQuantiles | None
    segments: Mapping[str, str]

    def __post_init__(self) -> None:
        if not self.lot_key.strip() or len(self.lot_key) > 200:
            raise EvaluationInputError("lot_key must be a non-empty bounded internal key")
        _require_aware(self.scheduled_at, "scheduled_at")
        if self.label_available_at is not None:
            _require_aware(self.label_available_at, "label_available_at")
            if self.label_available_at < self.scheduled_at:
                raise EvaluationInputError("label_available_at cannot predate the hearing")
        if self.price_label_available_at is not None:
            _require_aware(self.price_label_available_at, "price_label_available_at")
            if self.price_label_available_at < self.scheduled_at:
                raise EvaluationInputError("price_label_available_at cannot predate the hearing")
        if self.snapshot_cutoff_at is not None:
            _require_aware(self.snapshot_cutoff_at, "snapshot_cutoff_at")
            if self.snapshot_cutoff_at >= self.scheduled_at:
                raise EvaluationInputError("snapshot cutoff must precede the hearing")
        if self.prediction_generated_at is not None:
            _require_aware(self.prediction_generated_at, "prediction_generated_at")
            if self.prediction_generated_at >= self.scheduled_at:
                raise EvaluationInputError("prediction must precede the hearing")
        if self.prediction_recorded_at is not None:
            _require_aware(self.prediction_recorded_at, "prediction_recorded_at")
            if self.prediction_recorded_at >= self.scheduled_at:
                raise EvaluationInputError("prediction recording must precede the hearing")
        if self.snapshot_available != (self.snapshot_cutoff_at is not None):
            raise EvaluationInputError("snapshot availability and cutoff are inconsistent")
        if self.label_grade not in (None, "A", "B", "C"):
            raise EvaluationInputError("unsupported evidence grade")
        if self.prediction_status not in ("ready", "abstained", "missing"):
            raise EvaluationInputError("unsupported prediction status")
        if self.outcome is not None and self.outcome not in OUTCOME_CLASSES:
            raise EvaluationInputError("unsupported outcome class")
        if self.label_grade in ("A", "B") and (self.outcome is None or self.label_available_at is None):
            raise EvaluationInputError("an A/B label requires an outcome and availability timestamp")
        for name, value in (
            ("actual_price_eur", self.actual_price_eur),
            ("starting_price_eur", self.starting_price_eur),
        ):
            if value is not None and (not math.isfinite(value) or value <= 0):
                raise EvaluationInputError(f"{name} must be finite and strictly positive")
        if self.actual_price_eur is not None and self.outcome != "held_adjudicated":
            raise EvaluationInputError("a realized price requires an adjudicated outcome")
        if self.actual_price_eur is not None and self.price_label_available_at is None:
            raise EvaluationInputError("a realized price requires an effective availability timestamp")
        _validate_segments(self.segments)
        self._validate_prediction()

    def _validate_prediction(self) -> None:
        if self.prediction_status != "ready":
            if self.probabilities is not None or self.price_quantiles is not None:
                raise EvaluationInputError("non-ready predictions cannot carry forecast values")
            return
        if not self.snapshot_available or not self.leakage_check_passed:
            raise EvaluationInputError("ready predictions require a leakage-safe snapshot")
        if self.prediction_generated_at is None or self.prediction_recorded_at is None or self.snapshot_cutoff_at is None:
            raise EvaluationInputError("ready predictions require cutoff, generation and recording timestamps")
        if self.prediction_generated_at < self.snapshot_cutoff_at:
            raise EvaluationInputError("prediction cannot predate its feature cutoff")
        if self.probabilities is None or set(self.probabilities) != set(OUTCOME_CLASSES):
            raise EvaluationInputError("ready predictions require the four exclusive outcome probabilities")
        values = tuple(float(self.probabilities[label]) for label in OUTCOME_CLASSES)
        if not all(math.isfinite(value) and 0 <= value <= 1 for value in values):
            raise EvaluationInputError("probabilities must be finite and within [0, 1]")
        if not math.isclose(sum(values), 1.0, abs_tol=1e-4):
            raise EvaluationInputError("exclusive outcome probabilities must sum to one")

    @property
    def scheduled_date(self) -> date:
        return self.scheduled_at.astimezone(UTC).date()

    def has_eligible_label_at(self, cutoff: datetime) -> bool:
        return (
            self.label_grade in ("A", "B")
            and self.outcome is not None
            and self.label_available_at is not None
            and self.label_available_at <= cutoff
        )

    def has_eligible_price_at(self, cutoff: datetime) -> bool:
        return (
            self.has_eligible_label_at(cutoff)
            and self.actual_price_eur is not None
            and self.price_label_available_at is not None
            and self.price_label_available_at <= cutoff
        )


@dataclass(frozen=True, slots=True)
class EvaluationConfig:
    mode: EvaluationMode
    train_start: date
    train_end: date
    validation_end: date
    test_end: date
    label_cutoff_at: datetime
    maturity_days: int = 30

    def __post_init__(self) -> None:
        if self.mode not in ("historical_replay", "prospective_shadow"):
            raise EvaluationInputError("unsupported evaluation mode")
        if not self.train_start < self.train_end < self.validation_end < self.test_end:
            raise EvaluationInputError("temporal split boundaries must be strictly increasing")
        _require_aware(self.label_cutoff_at, "label_cutoff_at")
        if not 1 <= self.maturity_days <= 365:
            raise EvaluationInputError("maturity_days must be between 1 and 365")
        if self.label_cutoff_at.astimezone(UTC).date() < self.test_end:
            raise EvaluationInputError("label cutoff cannot predate the end of the test period")


@dataclass(frozen=True, slots=True)
class EvaluationThresholds:
    version: str
    minimum_total_ab_labels: int
    minimum_test_labels: int
    minimum_price_labels: int
    minimum_class_labels: int
    minimum_segment_size: int
    minimum_stability_quarters: int
    minimum_quarter_labels: int
    minimum_snapshot_coverage: float
    minimum_prediction_coverage: float
    maximum_ece: float
    minimum_interval_coverage: float
    maximum_interval_coverage: float
    maximum_confidence_psi: float
    maximum_coverage_shift: float
    maximum_brier_shift: float
    maximum_segment_brier_gap: float
    maximum_segment_coverage_gap: float

    def __post_init__(self) -> None:
        if not self.version.strip():
            raise EvaluationInputError("threshold version is required")
        for value in (
            self.minimum_total_ab_labels,
            self.minimum_test_labels,
            self.minimum_price_labels,
            self.minimum_class_labels,
            self.minimum_segment_size,
            self.minimum_stability_quarters,
            self.minimum_quarter_labels,
        ):
            if value < 1:
                raise EvaluationInputError("threshold sample sizes must be positive")
        for value in (
            self.minimum_snapshot_coverage,
            self.minimum_prediction_coverage,
            self.maximum_ece,
            self.minimum_interval_coverage,
            self.maximum_interval_coverage,
            self.maximum_coverage_shift,
            self.maximum_brier_shift,
            self.maximum_segment_brier_gap,
            self.maximum_segment_coverage_gap,
        ):
            if not 0 <= value <= 1:
                raise EvaluationInputError("rate thresholds must be within [0, 1]")
        if self.minimum_interval_coverage > self.maximum_interval_coverage:
            raise EvaluationInputError("interval coverage bounds are reversed")
        if self.maximum_confidence_psi <= 0:
            raise EvaluationInputError("PSI threshold must be positive")


COMMERCIAL_THRESHOLDS_V1 = EvaluationThresholds(
    version="outcome-commercial-v1",
    minimum_total_ab_labels=1_000,
    minimum_test_labels=300,
    minimum_price_labels=100,
    minimum_class_labels=30,
    minimum_segment_size=30,
    minimum_stability_quarters=2,
    minimum_quarter_labels=30,
    minimum_snapshot_coverage=0.80,
    minimum_prediction_coverage=0.80,
    maximum_ece=0.05,
    minimum_interval_coverage=0.75,
    maximum_interval_coverage=0.85,
    maximum_confidence_psi=0.20,
    maximum_coverage_shift=0.10,
    maximum_brier_shift=0.02,
    maximum_segment_brier_gap=0.02,
    maximum_segment_coverage_gap=0.10,
)


def _require_aware(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise EvaluationInputError(f"{field} must be timezone-aware")


def _validate_segments(segments: Mapping[str, str]) -> None:
    unexpected = set(segments) - SEGMENT_DIMENSIONS
    if unexpected:
        raise EvaluationInputError("segment dimensions are not allowlisted")
    for value in segments.values():
        if not isinstance(value, str) or not _SAFE_SEGMENT_VALUE.fullmatch(value):
            raise EvaluationInputError("segment values must be bounded categorical labels")
        lowered = value.casefold()
        if "@" in value or "://" in value or "www." in lowered or _UUID_LIKE.fullmatch(value):
            raise EvaluationInputError("segment values cannot contain personal or row identifiers")
