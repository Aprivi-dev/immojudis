from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from src.outcome_evaluation.metrics import classification_metrics_from_probabilities, price_metrics
from src.outcome_evaluation.models import OUTCOME_CLASSES, EvaluationRecord, OutcomeClass, PriceQuantiles


def classification_baselines(
    training: Sequence[EvaluationRecord],
    test: Sequence[EvaluationRecord],
) -> dict[str, dict[str, Any]]:
    labelled_training = [record for record in training if record.outcome is not None]
    labelled_test = [record for record in test if record.outcome is not None]
    if not labelled_training or not labelled_test:
        return {}
    national = _class_distribution(labelled_training)
    definitions: tuple[tuple[str, Callable[[EvaluationRecord], str | None]], ...] = (
        ("national_frequency", lambda _record: None),
        ("judicial_region_frequency", lambda record: record.segments.get("judicial_region")),
        ("tribunal_frequency", lambda record: record.segments.get("tribunal")),
        ("property_type_frequency", lambda record: record.segments.get("property_type")),
    )
    results: dict[str, dict[str, Any]] = {}
    for name, group_key in definitions:
        group_distributions = _group_class_distributions(labelled_training, group_key) if name != "national_frequency" else {}
        probabilities = [group_distributions.get(group_key(record), national) for record in labelled_test]
        results[name] = classification_metrics_from_probabilities(labelled_test, probabilities)
    return results


def price_baselines(
    training: Sequence[EvaluationRecord],
    test: Sequence[EvaluationRecord],
) -> dict[str, dict[str, float | int | None]]:
    training_prices = [record for record in training if record.actual_price_eur is not None]
    test_prices = [record for record in test if record.actual_price_eur is not None]
    if not training_prices or not test_prices:
        return {}
    national_prices = [float(record.actual_price_eur) for record in training_prices if record.actual_price_eur is not None]
    national_quantiles = _price_quantiles(national_prices)
    results: dict[str, dict[str, float | int | None]] = {}

    actuals = [float(record.actual_price_eur) for record in test_prices if record.actual_price_eur is not None]
    results["national_price_distribution"] = price_metrics(
        actuals,
        [national_quantiles for _record in test_prices],
    )

    for dimension in ("judicial_region", "tribunal", "property_type"):
        grouped = _group_price_quantiles(training_prices, dimension)
        forecasts = [grouped.get(record.segments.get(dimension), national_quantiles) for record in test_prices]
        results[f"{dimension}_price_distribution"] = price_metrics(actuals, forecasts)

    composite_groups: dict[tuple[str | None, str | None], list[float]] = defaultdict(list)
    for record in training_prices:
        if record.actual_price_eur is not None:
            composite_groups[(record.segments.get("tribunal"), record.segments.get("property_type"))].append(
                float(record.actual_price_eur)
            )
    composite_quantiles = {
        group: _price_quantiles(values) for group, values in composite_groups.items() if None not in group and len(values) >= 10
    }
    results["tribunal_property_type_price_distribution"] = price_metrics(
        actuals,
        [
            composite_quantiles.get(
                (record.segments.get("tribunal"), record.segments.get("property_type")), national_quantiles
            )
            for record in test_prices
        ],
    )

    starting_test = [record for record in test_prices if record.starting_price_eur is not None]
    ratios = [
        float(record.actual_price_eur) / float(record.starting_price_eur)
        for record in training_prices
        if record.actual_price_eur is not None and record.starting_price_eur is not None
    ]
    if starting_test and len(starting_test) == len(test_prices):
        results["starting_price"] = price_metrics(
            [float(record.actual_price_eur) for record in starting_test if record.actual_price_eur is not None],
            [
                PriceQuantiles(
                    p10=float(record.starting_price_eur),
                    p50=float(record.starting_price_eur),
                    p90=float(record.starting_price_eur),
                )
                for record in starting_test
            ],
        )
    if ratios and starting_test and len(starting_test) == len(test_prices):
        ratio_quantiles = _price_quantiles(ratios)
        starting_actuals = [float(record.actual_price_eur) for record in starting_test if record.actual_price_eur is not None]
        starting_forecasts = [
            PriceQuantiles(
                p10=float(record.starting_price_eur) * ratio_quantiles.p10,
                p50=float(record.starting_price_eur) * ratio_quantiles.p50,
                p90=float(record.starting_price_eur) * ratio_quantiles.p90,
            )
            for record in starting_test
        ]
        results["starting_price_ratio"] = price_metrics(starting_actuals, starting_forecasts)
    return results


def _class_distribution(records: Sequence[EvaluationRecord]) -> Mapping[OutcomeClass, float]:
    counts = Counter(record.outcome for record in records)
    denominator = len(records) + len(OUTCOME_CLASSES)
    return {label: (counts[label] + 1) / denominator for label in OUTCOME_CLASSES}


def _group_class_distributions(
    records: Sequence[EvaluationRecord],
    key: Callable[[EvaluationRecord], str | None],
) -> dict[str | None, Mapping[OutcomeClass, float]]:
    groups: dict[str | None, list[EvaluationRecord]] = defaultdict(list)
    for record in records:
        groups[key(record)].append(record)
    return {group: _class_distribution(members) for group, members in groups.items() if group is not None and len(members) >= 10}


def _group_price_quantiles(records: Sequence[EvaluationRecord], dimension: str) -> dict[str | None, PriceQuantiles]:
    groups: dict[str | None, list[float]] = defaultdict(list)
    for record in records:
        if record.actual_price_eur is not None:
            groups[record.segments.get(dimension)].append(float(record.actual_price_eur))
    return {group: _price_quantiles(values) for group, values in groups.items() if group is not None and len(values) >= 10}


def _price_quantiles(values: Sequence[float]) -> PriceQuantiles:
    return PriceQuantiles(
        p10=_quantile(values, 0.10),
        p50=_quantile(values, 0.50),
        p90=_quantile(values, 0.90),
    )


def _quantile(values: Sequence[float], probability: float) -> float:
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
