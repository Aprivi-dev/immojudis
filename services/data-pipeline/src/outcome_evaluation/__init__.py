"""Fail-closed aggregate evaluation for Outcome Graph models."""

from src.outcome_evaluation.engine import evaluate, temporal_lot_split, validate_public_report
from src.outcome_evaluation.models import (
    COMMERCIAL_THRESHOLDS_V1,
    EvaluationConfig,
    EvaluationInputError,
    EvaluationRecord,
    EvaluationThresholds,
    PriceQuantiles,
)
from src.outcome_evaluation.reporting import build_promotion_summary

__all__ = [
    "COMMERCIAL_THRESHOLDS_V1",
    "EvaluationConfig",
    "EvaluationInputError",
    "EvaluationRecord",
    "EvaluationThresholds",
    "PriceQuantiles",
    "build_promotion_summary",
    "evaluate",
    "temporal_lot_split",
    "validate_public_report",
]
