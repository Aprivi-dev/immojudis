"""The model + comparables blend the application serves, replayed on the validation sales (D19).

``src/lib/hybrid-market-valuation.ts`` never serves the LightGBM quantiles alone: it blends them
geometrically with the comparables' p10 / median / p90, with a model weight set by hand from the
comparables' quality score and the model's test MAPE (``resolveModelWeight``). The activation gate
used to score the model alone. This module replays that blend on the newest (test) sales, the
comparables being replaced by the past-only H3 cell statistics the training already computed for
each sale, and reports median APE, p75 APE and interval coverage for the model alone, the
comparables alone and the served blend.

The weights below are those of ``resolveModelWeight`` in ``hybrid-market-valuation.ts``. Both sides must
reproduce the numbers of ``tests/fixtures/served_blend_parity.json``, produced by this module.

Pure numpy: no database, no model artifact.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from src.valuation_activation_gate import ape_errors

# Base model weight from the comparables' quality score (``assessEngineQuality`` in market.server.ts):
# (label shown on the sale page, minimum score, model weight), best tier first. Below the last
# threshold the weight is WEAK_QUALITY_MODEL_WEIGHT.
QUALITY_WEIGHT_TIERS: tuple[tuple[str, int, float], ...] = (
    ("forte", 78, 0.35),
    ("correcte", 58, 0.45),
)
WEAK_QUALITY_LABEL = "fragile"
WEAK_QUALITY_MODEL_WEIGHT = 0.6
# Performance adjustment: (PIVOT - test MAPE) / 100, clamped to [ADJUSTMENT_MIN, ADJUSTMENT_MAX].
PERFORMANCE_PIVOT_MAPE_PCT = 16
PERFORMANCE_ADJUSTMENT_MIN = -0.12
PERFORMANCE_ADJUSTMENT_MAX = 0.08
# Cap on the model weight from the test MAPE: (MAPE at or above, cap), strictest first, else DEFAULT.
PERFORMANCE_WEIGHT_CAPS: tuple[tuple[int, float], ...] = ((35, 0.3), (25, 0.45))
PERFORMANCE_DEFAULT_CAP = 0.7
MODEL_WEIGHT_FLOOR = 0.2


def resolve_model_weight(quality_score: float, test_mape_pct: float | None) -> float:
    """Model weight of the served blend, exactly as ``resolveModelWeight`` computes it."""
    quality_weight = WEAK_QUALITY_MODEL_WEIGHT
    for _label, minimum, weight in QUALITY_WEIGHT_TIERS:
        if quality_score >= minimum:
            quality_weight = weight
            break
    if test_mape_pct is None or not np.isfinite(test_mape_pct):
        return quality_weight
    adjustment = max(
        PERFORMANCE_ADJUSTMENT_MIN,
        min(PERFORMANCE_ADJUSTMENT_MAX, (PERFORMANCE_PIVOT_MAPE_PCT - test_mape_pct) / 100),
    )
    cap = PERFORMANCE_DEFAULT_CAP
    for minimum_mape, tier_cap in PERFORMANCE_WEIGHT_CAPS:
        if test_mape_pct >= minimum_mape:
            cap = tier_cap
            break
    return max(MODEL_WEIGHT_FLOOR, min(cap, quality_weight + adjustment))


def geometric_blend(comparable: np.ndarray, model: np.ndarray, model_weight: float) -> np.ndarray:
    """``geometricBlend``: exp((1 - w) log(comparable) + w log(model))."""
    comparable = np.asarray(comparable, dtype=float)
    model = np.asarray(model, dtype=float)
    return np.exp(np.log(comparable) * (1 - model_weight) + np.log(model) * model_weight)


def blend_quantiles(
    comparables: tuple[np.ndarray, np.ndarray, np.ndarray],
    model: tuple[np.ndarray, np.ndarray, np.ndarray],
    model_weight: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """p10 / p50 / p90 served by ``applyActiveHybridModel``: quantile by quantile, clamped around p50."""
    p50 = geometric_blend(comparables[1], model[1], model_weight)
    p10 = np.minimum(p50, geometric_blend(comparables[0], model[0], model_weight))
    p90 = np.maximum(p50, geometric_blend(comparables[2], model[2], model_weight))
    return p10, p50, p90


def comparables_from_cell_statistics(
    local_median_log: np.ndarray, local_spread_log: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Stand-in for the engine's comparables: the past-only cell statistics of each sale.

    Median = geometric mean of the earlier sales of the cell (``local_median_log``). The spread is the
    width of a p10-p90 band in log (standard deviation x 2.563 = 2 x z(0.9)), so p10 and p90 sit half
    of it below and above.
    """
    mean = np.asarray(local_median_log, dtype=float)
    half = np.asarray(local_spread_log, dtype=float) / 2
    return np.exp(mean - half), np.exp(mean), np.exp(mean + half)


def _rounded(value: float) -> float:
    return round(float(value), 2)


def _scores(p10: np.ndarray, p50: np.ndarray, p90: np.ndarray, actual: np.ndarray) -> dict[str, float]:
    errors = ape_errors(p50, actual)
    return {
        "median_ape_pct": _rounded(np.median(errors)),
        "p75_ape_pct": _rounded(np.quantile(errors, 0.75)),
        "interval_coverage_pct": _rounded(np.mean((actual >= p10) & (actual <= p90)) * 100),
        "below_pct": _rounded(np.mean(actual < p10) * 100),
        "above_pct": _rounded(np.mean(actual > p90) * 100),
    }


def quality_tiers() -> tuple[tuple[str, int], ...]:
    """(label, representative score) of each quality tier: its minimum score, 0 for the weakest."""
    return (*((label, minimum) for label, minimum, _ in QUALITY_WEIGHT_TIERS), (WEAK_QUALITY_LABEL, 0))


def evaluate_served_blend(
    *,
    actual: np.ndarray,
    model_quantiles: tuple[np.ndarray, np.ndarray, np.ndarray],
    local_median_log: np.ndarray,
    local_spread_log: np.ndarray,
    local_sample_size_log: np.ndarray,
    model_test_mape_pct: float | None,
) -> dict[str, Any]:
    """Model alone, comparables alone and served blend, on the same test sales.

    Only sales whose cell had enough earlier sales (``local_sample_size_log > 0``) are scored: the
    application blends only when the engine found comparables; a sale on the global fallback has no
    comparables to blend with. The served weight depends on the engine's quality score, which the
    backtest does not have: the blend is therefore scored at each quality tier (the weight of each
    tier, adjusted by ``model_test_mape_pct`` like in production), which covers every weight the
    application can serve for this model.
    """
    actual = np.asarray(actual, dtype=float)
    eligible = np.asarray(local_sample_size_log, dtype=float) > 0
    base: dict[str, Any] = {
        "describes": (
            "validation model on the newest sales, blended like src/lib/hybrid-market-valuation.ts; "
            "comparables replaced by the past-only H3 cell statistics of each sale"
        ),
        "comparables_proxy": (
            "median = exp(local_median_log), p10 / p90 = exp(local_median_log -/+ local_spread_log / 2), "
            "on sales whose cell has at least 5 earlier sales"
        ),
        "test_rows": int(len(actual)),
        "rows": int(eligible.sum()),
        "model_test_mape_pct": None if model_test_mape_pct is None else _rounded(model_test_mape_pct),
    }
    if not eligible.any():
        return {
            **base,
            "status": "not_evaluated",
            "reason": "no test sale has a cell with enough earlier sales to stand in for the comparables",
        }
    observed = actual[eligible]
    model = tuple(np.asarray(values, dtype=float)[eligible] for values in model_quantiles)
    comparables = comparables_from_cell_statistics(
        np.asarray(local_median_log, dtype=float)[eligible],
        np.asarray(local_spread_log, dtype=float)[eligible],
    )
    served: dict[str, dict[str, Any]] = {}
    for label, score in quality_tiers():
        weight = resolve_model_weight(score, model_test_mape_pct)
        served[label] = {
            "quality_score_min": score,
            "model_weight": _rounded(weight),
            **_scores(*blend_quantiles(comparables, model, weight), observed),
        }
    return {
        **base,
        "status": "evaluated",
        "model_only": _scores(*model, observed),
        "comparables_only": _scores(*comparables, observed),
        "served_blend": served,
    }
