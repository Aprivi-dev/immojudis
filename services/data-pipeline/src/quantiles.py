"""Quantile empirique par interpolation linéaire, commun aux évaluations et aux statistiques publiées."""

from __future__ import annotations

import math
from collections.abc import Sequence


def linear_quantile(values: Sequence[float], probability: float) -> float:
    """Quantile ``probability`` (entre 0 et 1) des valeurs, dans n'importe quel ordre.

    Interpolation linéaire entre les deux valeurs triées qui encadrent la position ``(n - 1) × probability``.
    """
    ordered = sorted(values)
    if not ordered:
        raise ValueError("cannot calculate a quantile of an empty sequence")
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    fraction = position - lower
    if fraction == 0:
        return float(ordered[lower])
    return float(ordered[lower] * (1 - fraction) + ordered[upper] * fraction)
