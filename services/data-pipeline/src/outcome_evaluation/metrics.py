from __future__ import annotations

import math
import statistics
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from src.outcome_evaluation.models import OUTCOME_CLASSES, EvaluationRecord, OutcomeClass, PriceQuantiles

_EPSILON = 1e-12


def classification_metrics(records: Sequence[EvaluationRecord]) -> dict[str, Any]:
    evaluated = [
        record
        for record in records
        if record.outcome is not None and record.prediction_status == "ready" and record.probabilities is not None
    ]
    return _classification_metrics(
        [record.outcome for record in evaluated if record.outcome is not None],
        [record.probabilities for record in evaluated if record.probabilities is not None],
    )


def _classification_metrics(
    outcomes: Sequence[OutcomeClass],
    probability_rows: Sequence[Mapping[OutcomeClass, float]],
) -> dict[str, Any]:
    if not outcomes:
        return _empty_classification_metrics()
    if len(outcomes) != len(probability_rows):
        raise ValueError("outcomes and probability rows must have equal lengths")
    confusion = {actual: {predicted: 0 for predicted in OUTCOME_CLASSES} for actual in OUTCOME_CLASSES}
    log_losses: list[float] = []
    brier_scores: list[float] = []
    confidences: list[float] = []
    correct: list[int] = []
    for outcome, probability_row in zip(outcomes, probability_rows, strict=True):
        probabilities = {label: float(probability_row[label]) for label in OUTCOME_CLASSES}
        predicted = max(OUTCOME_CLASSES, key=lambda label: (probabilities[label], -OUTCOME_CLASSES.index(label)))
        confusion[outcome][predicted] += 1
        log_losses.append(-math.log(max(probabilities[outcome], _EPSILON)))
        brier_scores.append(
            sum((probabilities[label] - (1.0 if label == outcome else 0.0)) ** 2 for label in OUTCOME_CLASSES)
        )
        confidences.append(probabilities[predicted])
        correct.append(int(predicted == outcome))

    per_class: dict[str, dict[str, float | int | None]] = {}
    for label in OUTCOME_CLASSES:
        true_positive = confusion[label][label]
        false_positive = sum(confusion[other][label] for other in OUTCOME_CLASSES if other != label)
        false_negative = sum(confusion[label][other] for other in OUTCOME_CLASSES if other != label)
        support = sum(confusion[label].values())
        precision = _optional_ratio(true_positive, true_positive + false_positive)
        recall = _optional_ratio(true_positive, true_positive + false_negative)
        f1 = (
            _optional_ratio(2 * precision * recall, precision + recall)
            if precision is not None and recall is not None
            else None
        )
        per_class[label] = {
            "support": support,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }

    ece, mce = calibration_error_summary(confidences, correct)
    return {
        "sample_size": len(outcomes),
        "multiclass_brier": statistics.fmean(brier_scores),
        "log_loss": statistics.fmean(log_losses),
        "top_label_ece_10": ece,
        "top_label_mce_10": mce,
        "accuracy": _safe_ratio(sum(correct), len(correct)),
        "macro_precision": _optional_mean(per_class[label]["precision"] for label in OUTCOME_CLASSES),
        "macro_recall": _optional_mean(per_class[label]["recall"] for label in OUTCOME_CLASSES),
        "macro_f1": _optional_mean(per_class[label]["f1"] for label in OUTCOME_CLASSES),
        "per_class": per_class,
        "confusion": confusion,
    }


def classification_metrics_from_probabilities(
    records: Sequence[EvaluationRecord],
    probabilities: Sequence[Mapping[OutcomeClass, float]],
) -> dict[str, Any]:
    if len(records) != len(probabilities):
        raise ValueError("records and probabilities must have equal lengths")
    outcomes = [record.outcome for record in records]
    if any(outcome is None for outcome in outcomes):
        raise ValueError("baseline records must be labelled")
    return _classification_metrics(
        [outcome for outcome in outcomes if outcome is not None],
        probabilities,
    )


def price_metrics(
    actuals: Sequence[float],
    quantiles: Sequence[PriceQuantiles],
) -> dict[str, float | int | None]:
    if len(actuals) != len(quantiles):
        raise ValueError("actual prices and quantiles must have equal lengths")
    if not actuals:
        return {
            "sample_size": 0,
            "pinball_p10_eur": None,
            "pinball_p50_eur": None,
            "pinball_p90_eur": None,
            "mean_pinball_eur": None,
            "mean_absolute_error_eur": None,
            "median_absolute_error_eur": None,
            "median_absolute_log_error": None,
            "signed_log_bias": None,
            "interval_80_coverage": None,
            "mean_interval_width_eur": None,
            "mean_normalized_interval_width": None,
        }

    p10_losses: list[float] = []
    p50_losses: list[float] = []
    p90_losses: list[float] = []
    absolute_errors: list[float] = []
    absolute_log_errors: list[float] = []
    signed_log_errors: list[float] = []
    covered: list[int] = []
    widths: list[float] = []
    normalized_widths: list[float] = []
    for actual, forecast in zip(actuals, quantiles, strict=True):
        p10_losses.append(pinball_loss(actual, forecast.p10, 0.10))
        p50_losses.append(pinball_loss(actual, forecast.p50, 0.50))
        p90_losses.append(pinball_loss(actual, forecast.p90, 0.90))
        absolute_errors.append(abs(actual - forecast.p50))
        log_error = math.log(forecast.p50 / actual)
        absolute_log_errors.append(abs(log_error))
        signed_log_errors.append(log_error)
        covered.append(int(forecast.p10 <= actual <= forecast.p90))
        width = forecast.p90 - forecast.p10
        widths.append(width)
        normalized_widths.append(width / actual)

    pinball_p10 = statistics.fmean(p10_losses)
    pinball_p50 = statistics.fmean(p50_losses)
    pinball_p90 = statistics.fmean(p90_losses)
    return {
        "sample_size": len(actuals),
        "pinball_p10_eur": pinball_p10,
        "pinball_p50_eur": pinball_p50,
        "pinball_p90_eur": pinball_p90,
        "mean_pinball_eur": statistics.fmean((pinball_p10, pinball_p50, pinball_p90)),
        "mean_absolute_error_eur": statistics.fmean(absolute_errors),
        "median_absolute_error_eur": statistics.median(absolute_errors),
        "median_absolute_log_error": statistics.median(absolute_log_errors),
        "signed_log_bias": statistics.fmean(signed_log_errors),
        "interval_80_coverage": _safe_ratio(sum(covered), len(covered)),
        "mean_interval_width_eur": statistics.fmean(widths),
        "mean_normalized_interval_width": statistics.fmean(normalized_widths),
    }


def pinball_loss(actual: float, predicted: float, quantile: float) -> float:
    residual = actual - predicted
    return max(quantile * residual, (quantile - 1.0) * residual)


def expected_calibration_error(confidences: Sequence[float], correct: Sequence[int], bins: int = 10) -> float:
    return calibration_error_summary(confidences, correct, bins)[0]


def calibration_error_summary(
    confidences: Sequence[float], correct: Sequence[int], bins: int = 10
) -> tuple[float, float]:
    if len(confidences) != len(correct):
        raise ValueError("confidence and correctness arrays must have equal lengths")
    if not confidences:
        return 0.0, 0.0
    total = len(confidences)
    error = 0.0
    maximum_error = 0.0
    for index in range(bins):
        lower = index / bins
        upper = (index + 1) / bins
        members = [
            position
            for position, confidence in enumerate(confidences)
            if lower <= confidence < upper or (index == bins - 1 and confidence == 1.0)
        ]
        if not members:
            continue
        mean_confidence = statistics.fmean(confidences[position] for position in members)
        accuracy = statistics.fmean(correct[position] for position in members)
        bin_error = abs(accuracy - mean_confidence)
        error += len(members) / total * bin_error
        maximum_error = max(maximum_error, bin_error)
    return error, maximum_error


def population_stability_index(reference: Sequence[float], current: Sequence[float], bins: int = 10) -> float | None:
    if not reference or not current:
        return None
    reference_counts = Counter(min(int(max(value, 0.0) * bins), bins - 1) for value in reference)
    current_counts = Counter(min(int(max(value, 0.0) * bins), bins - 1) for value in current)
    reference_total = len(reference) + _EPSILON * bins
    current_total = len(current) + _EPSILON * bins
    score = 0.0
    for index in range(bins):
        reference_share = (reference_counts[index] + _EPSILON) / reference_total
        current_share = (current_counts[index] + _EPSILON) / current_total
        score += (current_share - reference_share) * math.log(current_share / reference_share)
    return score


def _empty_classification_metrics() -> dict[str, Any]:
    return {
        "sample_size": 0,
        "multiclass_brier": None,
        "log_loss": None,
        "top_label_ece_10": None,
        "top_label_mce_10": None,
        "accuracy": None,
        "macro_precision": None,
        "macro_recall": None,
        "macro_f1": None,
        "per_class": {},
        "confusion": {},
    }


def _safe_ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def _optional_ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def _optional_mean(values: Iterable[object]) -> float | None:
    materialized = [float(value) for value in values if value is not None]
    return statistics.fmean(materialized) if materialized else None
