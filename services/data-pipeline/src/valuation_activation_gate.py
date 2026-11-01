"""Statistics behind the model activation gate (n° 22), split out of valuation_training.

Constants, bootstrap statistics and ``decide_activation``: no database, no model artifact.
``valuation_training`` re-exports every name defined here, so its callers keep their imports.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

CONFIDENCE_LEVEL = 0.8
# Promotion floor on the out-of-sample coverage of the interval the application serves, whose
# nominal level is CONFIDENCE_LEVEL (80 %). Why 70 %: the interval is calibrated on the previous
# window and evaluated on the newest sales, so a few points of drift are expected (the absolute
# reject threshold in validate_promotion is 72 % on the MAPIE interval); below 70 % the displayed
# range misses more than three sales in ten instead of two, and the public band built on it
# ("sous / dans / au-dessus de la fourchette") would not mean what the method page says. The floor
# applies to --activate whatever --force says, like the other relative checks of decide_activation.
MIN_PROMOTION_COVERAGE_PCT = 70.0
# Activation gate (n° 22). A median APE measured on a few dozen sales is noise: with 75 test sales a
# model that is 10 % worse than the active one was activated about one time in four in simulation.
# So (1) at least MIN_ACTIVATION_TEST_ROWS chronological test sales are needed to activate (a model
# below that is still published as a draft), and (2) the candidate must beat the active model and the
# naive reference with a paired bootstrap interval of the median-APE gap lying entirely below zero.
# scripts/lib/valuation-promotion-gate.mjs applies the same rule to the report before publication
# (a test reads both files and fails if the numbers differ).
MIN_ACTIVATION_TEST_ROWS = 300
GAP_BOOTSTRAP_RESAMPLES = 1000
GAP_BOOTSTRAP_CONFIDENCE = 0.95
GAP_BOOTSTRAP_SEED = 42


def gap_interval_reason(gap: Any, reference: str) -> str | None:
    """Why the paired bootstrap interval does not prove the candidate better than ``reference``."""
    if not isinstance(gap, dict) or gap.get("ci_high_pp") is None:
        return f"the paired bootstrap interval of the error gap with {reference} was not computed"
    if not float(gap["ci_high_pp"]) < 0:
        return (
            f"the {gap.get('confidence_pct', _rounded(GAP_BOOTSTRAP_CONFIDENCE * 100))}% bootstrap interval of the "
            f"median APE gap with {reference} is [{gap.get('ci_low_pp')}, {gap['ci_high_pp']}] points, "
            "which does not lie entirely below zero"
        )
    return None


def ape_errors(predicted: np.ndarray, actual: np.ndarray) -> np.ndarray:
    """Absolute percentage error of each sale."""
    predicted = np.asarray(predicted, dtype=float)
    actual = np.asarray(actual, dtype=float)
    return np.abs(predicted - actual) / actual * 100


def paired_bootstrap_error_gap(
    candidate_errors: np.ndarray,
    reference_errors: np.ndarray,
    *,
    resamples: int = GAP_BOOTSTRAP_RESAMPLES,
    confidence: float = GAP_BOOTSTRAP_CONFIDENCE,
    seed: int = GAP_BOOTSTRAP_SEED,
) -> dict[str, Any]:
    """Paired bootstrap interval of ``median(candidate error) - median(reference error)`` (points of APE).

    The same resampled sales are used for both models, so the interval measures the gap on identical
    sales rather than two independent noisy medians. Negative = the candidate is more accurate.
    """
    candidate = np.asarray(candidate_errors, dtype=float)
    reference = np.asarray(reference_errors, dtype=float)
    if candidate.shape != reference.shape or candidate.ndim != 1 or len(candidate) == 0:
        raise ValueError("The paired bootstrap needs two non-empty error vectors of the same length.")
    if not (np.isfinite(candidate).all() and np.isfinite(reference).all()):
        raise ValueError("The paired bootstrap needs finite errors.")
    rows = len(candidate)
    rng = np.random.default_rng(seed)
    gaps = np.empty(resamples)
    for index in range(resamples):
        picked = rng.integers(0, rows, rows)
        gaps[index] = np.median(candidate[picked]) - np.median(reference[picked])
    tail = (1 - confidence) / 2
    low, high = np.quantile(gaps, [tail, 1 - tail])
    return {
        "metric": "median_ape_pct",
        "gap_pp": _rounded(np.median(candidate) - np.median(reference)),
        "ci_low_pp": _rounded(low),
        "ci_high_pp": _rounded(high),
        "confidence_pct": _rounded(confidence * 100),
        "resamples": resamples,
        "rows": rows,
    }


def _rounded(value: float) -> float:
    return round(float(value), 2)


def build_error_gap(
    candidate_predicted: np.ndarray,
    actual: np.ndarray,
    *,
    local_predicted: np.ndarray,
    cell_predicted: np.ndarray,
    local_median_ape_pct: float,
    cell_median_ape_pct: float,
    active_predicted: np.ndarray | None,
) -> dict[str, Any]:
    """Paired bootstrap gaps of the candidate against the strictest naive reference and the active model."""
    candidate_errors = ape_errors(candidate_predicted, actual)
    # The strictest naive reference: the one with the lowest median error.
    naive_predicted = local_predicted if local_median_ape_pct <= cell_median_ape_pct else cell_predicted
    return {
        "metric": "median_ape_pct",
        "vs_naive": paired_bootstrap_error_gap(candidate_errors, ape_errors(naive_predicted, actual)),
        "vs_active": (
            paired_bootstrap_error_gap(candidate_errors, ape_errors(active_predicted, actual))
            if active_predicted is not None
            else None
        ),
    }


@dataclass(frozen=True)
class PromotionDecision:
    activate: bool
    reasons: tuple[str, ...] = ()


def decide_activation(report: dict[str, Any], *, requested: bool) -> PromotionDecision:
    """Activate only a model that beats the active model and the naive reference and whose interval holds.

    Sample: at least ``MIN_ACTIVATION_TEST_ROWS`` chronological test sales; below that the model can
    only be published as a draft.
    Accuracy: the median APE must beat both the active model and the naive local reference, and the
    paired bootstrap interval of each gap (``report["error_gap"]``) must lie entirely below zero.
    Interval: at least ``MIN_PROMOTION_COVERAGE_PCT`` of the newest validation sales must fall
    inside the served interval (nominal 80 %). ``--force`` bypasses none of this.
    """
    if not requested:
        return PromotionDecision(False, ("activation not requested",))
    reasons: list[str] = []
    test_rows = (report.get("split") or {}).get("test_rows")
    if not isinstance(test_rows, (int, float)) or test_rows < MIN_ACTIVATION_TEST_ROWS:
        reasons.append(
            f"only {test_rows if isinstance(test_rows, (int, float)) else 'an unknown number of'} chronological "
            f"test sales, fewer than the {MIN_ACTIVATION_TEST_ROWS} needed to activate a model"
        )
    candidate = float(report["candidate"]["median_ape_pct"])
    naive = float(report["naive"]["gate_median_ape_pct"])
    error_gap = report.get("error_gap") or {}
    if not candidate < naive:
        reasons.append(f"median APE {candidate}% does not beat the naive local reference ({naive}%)")
    else:
        reason = gap_interval_reason(error_gap.get("vs_naive"), "the naive local reference")
        if reason:
            reasons.append(reason)
    active = report.get("active", {})
    if active.get("status") == "evaluated":
        active_ape = float(active["median_ape_pct"])
        if not candidate < active_ape:
            reasons.append(
                f"median APE {candidate}% does not beat the active model {active.get('version')} ({active_ape}%)"
            )
        else:
            reason = gap_interval_reason(error_gap.get("vs_active"), f"the active model {active.get('version')}")
            if reason:
                reasons.append(reason)
    elif active.get("status") != "none":
        reasons.append(
            f"the active model {active.get('version')} could not be evaluated "
            f"({active.get('reason', 'unknown reason')}); a regression cannot be ruled out"
        )
    coverage = (report.get("coverage") or {}).get("served_interval_pct")
    if coverage is None:
        reasons.append("the interval coverage on the validation sales was not measured")
    elif float(coverage) < MIN_PROMOTION_COVERAGE_PCT:
        reasons.append(
            f"the served interval covers {coverage}% of the validation sales, below the "
            f"{MIN_PROMOTION_COVERAGE_PCT}% floor (nominal {_rounded(CONFIDENCE_LEVEL * 100)}%)"
        )
    return PromotionDecision(not reasons, tuple(reasons))
