"""Served model + comparables blend replayed on the validation sales (D19)."""

from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np
import pytest

from src import valuation_served_blend as vsb
from src.valuation_activation_gate import served_blend_reasons

HYBRID_TS = Path(__file__).resolve().parents[3] / "src" / "lib" / "hybrid-market-valuation.ts"


def _compact(source: str) -> str:
    """TypeScript without whitespace nor Prettier's trailing commas, so formatting never matters."""
    return re.sub(r"\s+", "", source).replace(",)", ")")


def _function_body(source: str, name: str) -> str:
    start = source.index(f"function {name}(")
    end = source.index("\n}\n", start)
    return _compact(source[start:end])


# --- parity with hybrid-market-valuation.ts --------------------------------------------------


def test_the_blend_weights_are_those_of_the_typescript_serving_code() -> None:
    source = HYBRID_TS.read_text(encoding="utf-8")
    body = _function_body(source, "resolveModelWeight")

    quality = " : ".join(f"qualityScore >= {minimum} ? {weight}" for _, minimum, weight in vsb.QUALITY_WEIGHT_TIERS)
    caps = " : ".join(f"testMape >= {minimum} ? {cap}" for minimum, cap in vsb.PERFORMANCE_WEIGHT_CAPS)
    expected = [
        "const testMape = finiteNumber(metricMap.test_mape_pct);",
        f"const qualityWeight = {quality} : {vsb.WEAK_QUALITY_MODEL_WEIGHT};",
        "if (testMape == null) return qualityWeight;",
        (
            f"const performanceAdjustment = Math.max({vsb.PERFORMANCE_ADJUSTMENT_MIN}, "
            f"Math.min({vsb.PERFORMANCE_ADJUSTMENT_MAX}, ({vsb.PERFORMANCE_PIVOT_MAPE_PCT} - testMape) / 100));"
        ),
        f"const performanceCap = {caps} : {vsb.PERFORMANCE_DEFAULT_CAP};",
        (
            f"return Math.max({vsb.MODEL_WEIGHT_FLOOR}, "
            "Math.min(performanceCap, qualityWeight + performanceAdjustment));"
        ),
    ]
    for line in expected:
        assert _compact(line) in body, f"hybrid-market-valuation.ts no longer contains: {line}"
    # Every number of the TypeScript function is one of ours: a new threshold would go unnoticed otherwise.
    ours = {
        *(str(value) for _, minimum, weight in vsb.QUALITY_WEIGHT_TIERS for value in (minimum, weight)),
        *(str(value) for pair in vsb.PERFORMANCE_WEIGHT_CAPS for value in pair),
        str(vsb.WEAK_QUALITY_MODEL_WEIGHT),
        str(vsb.PERFORMANCE_PIVOT_MAPE_PCT),
        str(abs(vsb.PERFORMANCE_ADJUSTMENT_MIN)),
        str(vsb.PERFORMANCE_ADJUSTMENT_MAX),
        str(vsb.PERFORMANCE_DEFAULT_CAP),
        str(vsb.MODEL_WEIGHT_FLOOR),
        "100",
    }
    assert set(re.findall(r"\d+(?:\.\d+)?", body)) == ours


def test_the_blend_formula_is_that_of_the_typescript_serving_code() -> None:
    source = HYBRID_TS.read_text(encoding="utf-8")

    blend = _function_body(source, "geometricBlend")
    assert _compact("const comparableWeight = 1 - modelWeight;") in blend
    assert (
        _compact("return Math.exp(Math.log(comparable) * comparableWeight + Math.log(model) * modelWeight);")
        in blend
    )
    serving = _compact(source)
    for statement in (
        "const p50 = geometricBlend(input.comparableMedianPricePerM2, prediction.p50PricePerM2, modelWeight);",
        "const p10 = Math.min(p50, geometricBlend(input.comparableP10PricePerM2, prediction.p10PricePerM2, modelWeight));",
        "const p90 = Math.max(p50, geometricBlend(input.comparableP90PricePerM2, prediction.p90PricePerM2, modelWeight));",
        "const modelWeight = resolveModelWeight(input.comparableQualityScore, model.training_metrics);",
    ):
        assert _compact(statement) in serving, f"hybrid-market-valuation.ts no longer contains: {statement}"


@pytest.mark.parametrize(
    ("quality", "mape", "expected"),
    [
        (90, None, 0.35),
        (78, None, 0.35),
        (77.9, None, 0.45),
        (58, None, 0.45),
        (10, None, 0.6),
        (90, float("nan"), 0.35),  # finiteNumber() turns NaN into null
        (90, 10.0, 0.41),  # +0.06
        (10, 4.0, 0.68),  # adjustment capped at +0.08
        (10, 10.0, 0.66),
        (10, 30.0, 0.45),  # 0.6 - 0.12 = 0.48, capped at 0.45 from 25 % MAPE
        (90, 40.0, 0.23),  # 0.35 - 0.12, cap 0.3 from 35 %
        (10, 40.0, 0.3),
    ],
)
def test_model_weight_matches_resolve_model_weight(quality: float, mape: float | None, expected: float) -> None:
    assert vsb.resolve_model_weight(quality, mape) == pytest.approx(expected)


def test_the_weight_never_leaves_the_floor_and_the_default_cap() -> None:
    weights = [
        vsb.resolve_model_weight(quality, mape)
        for quality in range(0, 101, 5)
        for mape in (None, *np.linspace(0, 80, 33))
    ]
    assert min(weights) >= vsb.MODEL_WEIGHT_FLOOR
    assert max(weights) <= vsb.PERFORMANCE_DEFAULT_CAP


# --- blend ---------------------------------------------------------------------------------


def test_geometric_blend_weights_the_logs() -> None:
    comparable, model = np.array([2000.0]), np.array([8000.0])

    assert vsb.geometric_blend(comparable, model, 0.0)[0] == pytest.approx(2000.0)
    assert vsb.geometric_blend(comparable, model, 1.0)[0] == pytest.approx(8000.0)
    assert vsb.geometric_blend(comparable, model, 0.5)[0] == pytest.approx(4000.0)


def test_blended_bounds_are_clamped_around_the_blended_median() -> None:
    comparables = (np.array([3000.0]), np.array([3000.0]), np.array([3000.0]))
    model = (np.array([6000.0]), np.array([1000.0]), np.array([500.0]))  # inverted model quantiles

    p10, p50, p90 = vsb.blend_quantiles(comparables, model, 0.5)

    assert p10[0] <= p50[0] <= p90[0]
    assert p10[0] == pytest.approx(p50[0])
    assert p90[0] == pytest.approx(p50[0])


def test_cell_statistics_stand_in_for_the_comparables_p10_median_p90() -> None:
    sigma = 0.3
    spread = sigma * 2.563  # LOCAL_SPREAD_MULTIPLIER: p10-p90 width of a normal in standard deviations

    p10, p50, p90 = vsb.comparables_from_cell_statistics(np.array([8.0]), np.array([spread]))

    assert p50[0] == pytest.approx(math.exp(8.0))
    z90 = 1.2816  # standard normal 90th percentile
    assert math.log(p10[0]) == pytest.approx(8.0 - z90 * sigma, abs=1e-3)
    assert math.log(p90[0]) == pytest.approx(8.0 + z90 * sigma, abs=1e-3)


def _synthetic_sales(rows: int = 600, seed: int = 5):
    """Sales scattered log-normally (sigma 0.25) around their cell's geometric mean."""
    rng = np.random.default_rng(seed)
    cell_mean = rng.choice(np.log([2500.0, 3500.0, 5000.0]), size=rows)
    actual = np.exp(cell_mean + rng.normal(0, 0.25, rows))
    return actual, cell_mean, np.full(rows, 0.25 * 2.563), np.full(rows, math.log1p(20))


def _evaluate(actual, cell_mean, spread, sample_size_log, model_p50, *, mape: float = 12.0) -> dict:
    model = (model_p50 * 0.8, model_p50, model_p50 * 1.25)
    return vsb.evaluate_served_blend(
        actual=actual,
        model_quantiles=model,
        local_median_log=cell_mean,
        local_spread_log=spread,
        local_sample_size_log=sample_size_log,
        model_test_mape_pct=mape,
    )


def test_a_model_that_knows_more_than_the_cell_improves_the_blend_and_passes() -> None:
    actual, cell_mean, spread, size = _synthetic_sales()
    rng = np.random.default_rng(1)
    sharp = actual * np.exp(rng.normal(0, 0.05, len(actual)))

    blend = _evaluate(actual, cell_mean, spread, size, sharp)

    assert blend["status"] == "evaluated"
    assert blend["rows"] == blend["test_rows"] == len(actual)
    comparables = blend["comparables_only"]["median_ape_pct"]
    assert blend["model_only"]["median_ape_pct"] < comparables
    for tier in blend["served_blend"].values():
        assert tier["median_ape_pct"] < comparables
    assert served_blend_reasons(blend) == []
    # The cell's p10-p90 band holds about 80 % of sales scattered like the cell.
    assert 74.0 <= blend["comparables_only"]["interval_coverage_pct"] <= 86.0


def test_a_biased_model_makes_the_blend_worse_than_the_comparables_and_is_refused() -> None:
    actual, cell_mean, spread, size = _synthetic_sales()
    biased = np.exp(cell_mean) * 1.6

    blend = _evaluate(actual, cell_mean, spread, size, biased)

    comparables = blend["comparables_only"]["median_ape_pct"]
    assert all(tier["median_ape_pct"] > comparables for tier in blend["served_blend"].values())
    reasons = served_blend_reasons(blend)
    assert len(reasons) == 3
    assert "worse than the comparables alone" in reasons[0]


def test_tiers_carry_the_weights_production_would_use_for_this_model() -> None:
    actual, cell_mean, spread, size = _synthetic_sales(rows=50)

    blend = _evaluate(actual, cell_mean, spread, size, actual, mape=30.0)

    assert blend["model_test_mape_pct"] == 30.0
    assert {label: tier["model_weight"] for label, tier in blend["served_blend"].items()} == {
        "forte": round(vsb.resolve_model_weight(78, 30.0), 2),
        "correcte": round(vsb.resolve_model_weight(58, 30.0), 2),
        "fragile": round(vsb.resolve_model_weight(0, 30.0), 2),
    }
    assert [tier["quality_score_min"] for tier in blend["served_blend"].values()] == [78, 58, 0]


def test_only_sales_with_comparables_are_scored() -> None:
    actual, cell_mean, spread, size = _synthetic_sales(rows=40)
    size[:30] = 0.0  # no cell with enough earlier sales: global fallback, nothing to blend with in production
    model = actual.copy()
    model[:30] = actual[:30] * 10  # absurd where it does not matter

    blend = _evaluate(actual, cell_mean, spread, size, model)

    assert blend["rows"] == 10 and blend["test_rows"] == 40
    assert blend["model_only"]["median_ape_pct"] == 0.0


def test_no_sale_with_comparables_means_the_blend_is_not_evaluated_and_refused() -> None:
    actual, cell_mean, spread, size = _synthetic_sales(rows=20)

    blend = _evaluate(actual, cell_mean, spread, np.zeros_like(size), actual)

    assert blend["status"] == "not_evaluated" and blend["rows"] == 0
    assert "model_only" not in blend
    assert "not evaluated" in served_blend_reasons(blend)[0]
