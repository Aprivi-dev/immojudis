"""Types d'arguments partagés par les commandes des résultats de ventes (sources, évaluation, statistiques)."""

from __future__ import annotations

import argparse


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def maturity_days(value: str) -> int:
    """Délai de maturité d'un résultat, en jours : de 1 à 365."""
    parsed = int(value)
    if not 1 <= parsed <= 365:
        raise argparse.ArgumentTypeError("value must be between 1 and 365")
    return parsed
