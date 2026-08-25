"""Deterministic, evidence-gated tribunal statistics.

The package deliberately separates pure computation from database I/O. Importing it
never opens a connection and never enables persistence.
"""

from src.outcome_statistics.engine import (
    BUILDER_VERSION,
    ELIGIBILITY_RULE_VERSION,
    SMOOTHING_RULE_VERSION,
    build_statistics_bundle,
    calculate_period,
)
from src.outcome_statistics.models import (
    OutcomeVersion,
    Period,
    RoundObservation,
    StatisticsBundle,
    StatisticsSnapshot,
)

__all__ = [
    "BUILDER_VERSION",
    "ELIGIBILITY_RULE_VERSION",
    "SMOOTHING_RULE_VERSION",
    "OutcomeVersion",
    "Period",
    "RoundObservation",
    "StatisticsBundle",
    "StatisticsSnapshot",
    "build_statistics_bundle",
    "calculate_period",
]
