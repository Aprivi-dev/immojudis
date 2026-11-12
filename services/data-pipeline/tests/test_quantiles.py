"""Quantile à interpolation linéaire partagé (``src/quantiles.py``).

Les deux copies d'origine sont recopiées ici telles quelles : la fonction commune doit rendre
exactement leurs valeurs, pour ``outcome_evaluation`` (qui triait) comme pour ``outcome_statistics``
(qui recevait des valeurs déjà triées).
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence

import pytest

from src.outcome_evaluation import baselines
from src.outcome_statistics import engine
from src.quantiles import linear_quantile


def _baselines_quantile_before(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("cannot calculate a quantile of an empty sequence")
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return float(ordered[lower] * (1 - fraction) + ordered[upper] * fraction)


def _engine_linear_quantile_before(values: Sequence[float], probability: float) -> float:
    position = (len(values) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return values[lower]
    fraction = position - lower
    return values[lower] * (1 - fraction) + values[upper] * fraction


def _samples() -> list[list[float]]:
    generator = random.Random(20261112)
    samples: list[list[float]] = [[5.0], [1.0, 2.0], [3, 1, 2], [7.0] * 11, list(range(31)), list(range(101))]
    for size in (2, 3, 9, 10, 11, 29, 30, 31, 99, 100, 101, 257):
        samples.append([generator.uniform(0.01, 3.0) for _ in range(size)])
        samples.append([math.log(generator.uniform(10_000, 900_000)) for _ in range(size)])
    return samples


@pytest.mark.parametrize("probability", [0.0, 0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975, 1.0])
def test_linear_quantile_equals_both_former_copies(probability: float) -> None:
    for values in _samples():
        shuffled = list(values)
        random.Random(len(values)).shuffle(shuffled)
        expected = _baselines_quantile_before(shuffled, probability)
        assert linear_quantile(shuffled, probability) == expected
        assert type(linear_quantile(shuffled, probability)) is float
        assert linear_quantile(values, probability) == _engine_linear_quantile_before(sorted(values), probability)


def test_linear_quantile_refuses_an_empty_sequence() -> None:
    with pytest.raises(ValueError, match="empty"):
        linear_quantile([], 0.5)


def test_callers_use_the_shared_quantile() -> None:
    values = [9.0, 1.0, 4.0, 16.0, 25.0, 0.5, 2.0, 3.0, 8.0, 7.0, 6.0]

    quantiles = baselines._price_quantiles(values)
    assert (quantiles.p10, quantiles.p50, quantiles.p90) == tuple(
        _baselines_quantile_before(values, probability) for probability in (0.10, 0.50, 0.90)
    )
    assert engine._quantiles(sorted(values)) == {
        key: _engine_linear_quantile_before(sorted(values), probability)
        for key, probability in (("p10", 0.10), ("p50", 0.50), ("p90", 0.90))
    }
    with pytest.raises(ValueError, match="empty"):
        engine._quantiles([])
