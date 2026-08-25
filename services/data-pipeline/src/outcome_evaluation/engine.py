from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, time, timedelta
from typing import Any, Literal

from src.outcome_evaluation.baselines import classification_baselines, price_baselines
from src.outcome_evaluation.metrics import classification_metrics, population_stability_index, price_metrics
from src.outcome_evaluation.models import (
    COMMERCIAL_THRESHOLDS_V1,
    SEGMENT_DIMENSIONS,
    EvaluationConfig,
    EvaluationInputError,
    EvaluationRecord,
    EvaluationThresholds,
)

SplitName = Literal["training", "validation", "test"]
_FORBIDDEN_REPORT_KEYS = frozenset(
    {
        "id",
        "address",
        "case_number",
        "document_uri",
        "lawyer",
        "lot_key",
        "magistrate",
        "prediction_id",
        "reviewer_id",
        "round_id",
        "sale_id",
        "snapshot_id",
        "source_url",
        "user_id",
    }
)


def evaluate(
    records: Sequence[EvaluationRecord],
    config: EvaluationConfig,
    *,
    thresholds: EvaluationThresholds = COMMERCIAL_THRESHOLDS_V1,
    computed_at: datetime,
) -> dict[str, Any]:
    """Evaluate a historical replay or prospective shadow run without side effects."""

    _require_computed_at(computed_at, config)
    split, split_summary = temporal_lot_split(records, config)
    all_in_scope = (*split["training"], *split["validation"], *split["test"])
    maturity_limit = config.label_cutoff_at - timedelta(days=config.maturity_days)
    mature_test = tuple(record for record in split["test"] if record.scheduled_at <= maturity_limit)
    labelled_all = tuple(record for record in all_in_scope if record.has_eligible_label_at(config.label_cutoff_at))
    training_label_cutoff = datetime.combine(config.train_end, time.min, tzinfo=UTC)
    validation_label_cutoff = datetime.combine(config.validation_end, time.min, tzinfo=UTC)
    labelled_training = tuple(record for record in split["training"] if _label_available_before(record, training_label_cutoff))
    labelled_validation = tuple(
        record for record in split["validation"] if _label_available_before(record, validation_label_cutoff)
    )
    priced_training = tuple(
        record for record in split["training"] if _price_label_available_before(record, training_label_cutoff)
    )
    priced_validation = tuple(
        record for record in split["validation"] if _price_label_available_before(record, validation_label_cutoff)
    )
    labelled_test = tuple(record for record in mature_test if record.has_eligible_label_at(config.label_cutoff_at))
    evaluated_classification = tuple(record for record in labelled_test if record.prediction_status == "ready")
    labelled_prices = tuple(record for record in labelled_test if record.has_eligible_price_at(config.label_cutoff_at))
    evaluated_prices = tuple(
        record
        for record in labelled_prices
        if record.prediction_status == "ready" and record.price_quantiles is not None
    )

    coverage = {
        **_coverage_metrics(mature_test, labelled_test, labelled_prices, evaluated_prices),
        "total_label_count": len(labelled_all),
    }
    candidate_classification = classification_metrics(evaluated_classification)
    candidate_price = price_metrics(
        [float(record.actual_price_eur) for record in evaluated_prices if record.actual_price_eur is not None],
        [record.price_quantiles for record in evaluated_prices if record.price_quantiles is not None],
    )

    classification_baseline_report, selected_classification = _locked_classification_baselines(
        labelled_training,
        labelled_validation,
        evaluated_classification,
    )
    price_baseline_report, selected_price = _locked_price_baselines(
        priced_training,
        priced_validation,
        evaluated_prices,
    )
    segments = _segment_metrics(mature_test, config, thresholds.minimum_segment_size)
    stability = _stability_metrics(mature_test, config, thresholds)
    gates = _evaluate_gates(
        thresholds=thresholds,
        total_labels=len(labelled_all),
        test_labels=len(labelled_test),
        price_labels=len(labelled_prices),
        class_label_counts={
            label: sum(record.outcome == label for record in labelled_test)
            for label in ("cancelled_or_not_requested", "postponed", "held_no_bid", "held_adjudicated")
        },
        coverage=coverage,
        classification=candidate_classification,
        selected_classification_baseline=selected_classification,
        price=candidate_price,
        selected_price_baseline=selected_price,
        segments=segments,
        stability=stability,
    )
    status = _overall_status(gates)
    report: dict[str, Any] = {
        "schema_version": "outcome_evaluation_report_v1",
        "status": status,
        "evaluation_mode": config.mode,
        "threshold_version": thresholds.version,
        "computed_at": _utc_iso(computed_at),
        "backtest": {
            "strategy": "explicit_date_split_grouped_by_lot",
            "prediction_timing": "pre_hearing_only",
            "label_policy": "A_or_B_known_at_cutoff",
            "unknown_labels_are_negative": False,
            "baseline_selection_block": "validation",
        },
        "split": split_summary,
        "coverage": coverage,
        "classification": {
            "candidate": candidate_classification,
            "baselines": classification_baseline_report,
            "selected_baseline": selected_classification,
        },
        "price": {
            "candidate": candidate_price,
            "baselines": price_baseline_report,
            "selected_baseline": selected_price,
        },
        "segments": segments,
        "stability": stability,
        "gates": gates,
        "privacy": {
            "aggregate_only": True,
            "minimum_published_segment_size": thresholds.minimum_segment_size,
            "row_level_values_included": False,
        },
        "writes": 0,
    }
    validate_public_report(report)
    return report


def temporal_lot_split(
    records: Sequence[EvaluationRecord],
    config: EvaluationConfig,
) -> tuple[dict[SplitName, tuple[EvaluationRecord, ...]], dict[str, Any]]:
    seen: set[tuple[str, datetime]] = set()
    grouped: dict[str, list[EvaluationRecord]] = defaultdict(list)
    outside_count = 0
    for record in records:
        key = (record.lot_key, record.scheduled_at)
        if key in seen:
            raise EvaluationInputError("duplicate evaluation unit")
        seen.add(key)
        if not config.train_start <= record.scheduled_date < config.test_end:
            outside_count += 1
            continue
        grouped[record.lot_key].append(record)

    split_lists: dict[SplitName, list[EvaluationRecord]] = {"training": [], "validation": [], "test": []}
    moved_to_later = 0
    for members in grouped.values():
        latest_date = max(member.scheduled_date for member in members)
        destination = _split_for_date(latest_date, config)
        natural_destinations = {_split_for_date(member.scheduled_date, config) for member in members}
        if len(natural_destinations) > 1:
            moved_to_later += 1
        split_lists[destination].extend(members)

    result: dict[SplitName, tuple[EvaluationRecord, ...]] = {
        name: tuple(sorted(members, key=lambda record: (record.scheduled_at, record.lot_key)))
        for name, members in split_lists.items()
    }
    summary = {
        "train_start": config.train_start.isoformat(),
        "train_end": config.train_end.isoformat(),
        "validation_end": config.validation_end.isoformat(),
        "test_end": config.test_end.isoformat(),
        "label_cutoff_at": _utc_iso(config.label_cutoff_at),
        "maturity_days": config.maturity_days,
        "training_records": len(result["training"]),
        "validation_records": len(result["validation"]),
        "test_records": len(result["test"]),
        "outside_window_records": outside_count,
        "lot_groups_moved_to_later_block": moved_to_later,
    }
    return result, summary


def invalid_input_report(*, mode: str, threshold_version: str, computed_at: datetime) -> dict[str, Any]:
    report = {
        "schema_version": "outcome_evaluation_report_v1",
        "status": "invalid_input",
        "evaluation_mode": mode if mode in ("historical_replay", "prospective_shadow") else "invalid",
        "threshold_version": threshold_version,
        "computed_at": _utc_iso(computed_at),
        "gates": [{"code": "input_contract", "result": "invalid"}],
        "privacy": {"aggregate_only": True, "row_level_values_included": False},
        "writes": 0,
    }
    validate_public_report(report)
    return report


def validate_public_report(payload: object) -> None:
    def visit(value: object) -> None:
        if isinstance(value, Mapping):
            for key, child in value.items():
                normalized = str(key).casefold()
                if normalized in _FORBIDDEN_REPORT_KEYS or normalized.endswith("_id"):
                    raise EvaluationInputError("public report contains a forbidden field")
                visit(child)
        elif isinstance(value, (list, tuple)):
            for child in value:
                visit(child)
        elif isinstance(value, float) and not math.isfinite(value):
            raise EvaluationInputError("public report contains a non-finite number")
        elif isinstance(value, str):
            lowered = value.casefold()
            if "://" in value or "www." in lowered or "@" in value:
                raise EvaluationInputError("public report contains a forbidden value")

    visit(payload)


def _coverage_metrics(
    mature_test: Sequence[EvaluationRecord],
    labelled_test: Sequence[EvaluationRecord],
    labelled_prices: Sequence[EvaluationRecord],
    evaluated_prices: Sequence[EvaluationRecord],
) -> dict[str, float | int | None]:
    mature_count = len(mature_test)
    label_count = len(labelled_test)
    ready_count = sum(record.prediction_status == "ready" for record in mature_test)
    ready_label_count = sum(record.prediction_status == "ready" for record in labelled_test)
    explicit_abstentions = sum(record.prediction_status == "abstained" for record in labelled_test)
    missing_predictions = sum(record.prediction_status == "missing" for record in labelled_test)
    return {
        "mature_test_records": mature_count,
        "snapshot_count": sum(record.snapshot_available and record.leakage_check_passed for record in mature_test),
        "label_count": label_count,
        "scored_label_count": ready_label_count,
        "ready_prediction_count": ready_count,
        "explicit_abstention_count": explicit_abstentions,
        "missing_prediction_count": missing_predictions,
        "snapshot_coverage": _optional_ratio(
            sum(record.snapshot_available and record.leakage_check_passed for record in mature_test), mature_count
        ),
        "label_coverage": _optional_ratio(label_count, mature_count),
        "prediction_coverage": _optional_ratio(ready_count, mature_count),
        "evaluable_prediction_coverage": _optional_ratio(ready_label_count, label_count),
        "end_to_end_scored_coverage": _optional_ratio(ready_label_count, mature_count),
        "abstention_rate_among_labels": _optional_ratio(explicit_abstentions, label_count),
        "missing_rate_among_labels": _optional_ratio(missing_predictions, label_count),
        "price_label_count": len(labelled_prices),
        "price_prediction_count": len(evaluated_prices),
        "price_prediction_coverage": _optional_ratio(len(evaluated_prices), len(labelled_prices)),
    }


def _locked_classification_baselines(
    training: Sequence[EvaluationRecord],
    validation: Sequence[EvaluationRecord],
    test: Sequence[EvaluationRecord],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    validation_metrics = classification_baselines(training, validation)
    test_metrics = classification_baselines(training, test)
    selected_name = _lowest_metric_name(validation_metrics, "log_loss")
    report = {
        name: {"validation": validation_metrics.get(name), "test": test_metrics.get(name)}
        for name in sorted(set(validation_metrics) | set(test_metrics))
    }
    if selected_name is None or selected_name not in test_metrics:
        return report, None
    return report, {"name": selected_name, "test_metrics": test_metrics[selected_name]}


def _locked_price_baselines(
    training: Sequence[EvaluationRecord],
    validation: Sequence[EvaluationRecord],
    test: Sequence[EvaluationRecord],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    validation_metrics = price_baselines(training, validation)
    test_metrics = price_baselines(training, test)
    selected_name = _lowest_metric_name(validation_metrics, "mean_pinball_eur")
    report = {
        name: {"validation": validation_metrics.get(name), "test": test_metrics.get(name)}
        for name in sorted(set(validation_metrics) | set(test_metrics))
    }
    if selected_name is None or selected_name not in test_metrics:
        return report, None
    selected = test_metrics[selected_name]
    candidate_size = len(test)
    if selected.get("sample_size") != candidate_size:
        return report, None
    return report, {"name": selected_name, "test_metrics": selected}


def _segment_metrics(
    mature_test: Sequence[EvaluationRecord],
    config: EvaluationConfig,
    minimum_size: int,
) -> dict[str, Any]:
    published: list[dict[str, Any]] = []
    suppressed_count = 0
    global_labelled = [record for record in mature_test if record.has_eligible_label_at(config.label_cutoff_at)]
    global_evaluated = [record for record in global_labelled if record.prediction_status == "ready"]
    global_classification = classification_metrics(global_evaluated)
    global_coverage = _optional_ratio(len(global_evaluated), len(global_labelled))
    global_price_records = [
        record
        for record in global_evaluated
        if record.has_eligible_price_at(config.label_cutoff_at) and record.price_quantiles is not None
    ]
    global_price = price_metrics(
        [float(record.actual_price_eur) for record in global_price_records if record.actual_price_eur is not None],
        [record.price_quantiles for record in global_price_records if record.price_quantiles is not None],
    )
    for dimension in sorted(SEGMENT_DIMENSIONS):
        groups: dict[str, list[EvaluationRecord]] = defaultdict(list)
        for record in mature_test:
            value = record.segments.get(dimension)
            if value is not None:
                groups[value].append(record)
        for value in sorted(groups):
            members = groups[value]
            labelled = [record for record in members if record.has_eligible_label_at(config.label_cutoff_at)]
            if len(labelled) < minimum_size:
                suppressed_count += 1
                continue
            evaluated = [record for record in labelled if record.prediction_status == "ready"]
            price_records = [
                record
                for record in evaluated
                if record.has_eligible_price_at(config.label_cutoff_at) and record.price_quantiles is not None
            ]
            segment_classification = classification_metrics(evaluated) if len(evaluated) >= minimum_size else None
            segment_price = (
                price_metrics(
                    [float(record.actual_price_eur) for record in price_records if record.actual_price_eur is not None],
                    [record.price_quantiles for record in price_records if record.price_quantiles is not None],
                )
                if len(price_records) >= minimum_size
                else None
            )
            segment_coverage = _optional_ratio(len(evaluated), len(labelled))
            published.append(
                {
                    "dimension": dimension,
                    "value": value,
                    "mature_count": len(members),
                    "label_count": len(labelled),
                    "prediction_coverage": segment_coverage,
                    "classification": segment_classification,
                    "price": segment_price,
                    "bias": {
                        "prediction_coverage_gap": _difference(segment_coverage, global_coverage),
                        "multiclass_brier_gap": _difference(
                            segment_classification.get("multiclass_brier") if segment_classification else None,
                            global_classification.get("multiclass_brier"),
                        ),
                        "signed_log_bias": segment_price.get("signed_log_bias") if segment_price else None,
                        "signed_log_bias_gap": _difference(
                            segment_price.get("signed_log_bias") if segment_price else None,
                            global_price.get("signed_log_bias"),
                        ),
                    },
                }
            )
    return {
        "minimum_sample_size": minimum_size,
        "published_group_count": len(published),
        "suppressed_group_count": suppressed_count,
        "groups": published,
    }


def _stability_metrics(
    mature_test: Sequence[EvaluationRecord],
    config: EvaluationConfig,
    thresholds: EvaluationThresholds,
) -> dict[str, Any]:
    quarters: dict[str, list[EvaluationRecord]] = defaultdict(list)
    for record in mature_test:
        quarters[_quarter(record.scheduled_date.year, record.scheduled_date.month)].append(record)
    series: list[dict[str, Any]] = []
    prior_confidences: list[float] | None = None
    prior_coverage: float | None = None
    prior_brier: float | None = None
    qualified_count = 0
    for period in sorted(quarters):
        members = quarters[period]
        labelled = [record for record in members if record.has_eligible_label_at(config.label_cutoff_at)]
        evaluated = [record for record in labelled if record.prediction_status == "ready"]
        classification = classification_metrics(evaluated)
        coverage = _optional_ratio(len(evaluated), len(labelled))
        confidences = [
            max(float(value) for value in record.probabilities.values())
            for record in evaluated
            if record.probabilities is not None
        ]
        brier = classification["multiclass_brier"]
        qualified = len(labelled) >= thresholds.minimum_quarter_labels
        qualified_count += int(qualified)
        psi = population_stability_index(prior_confidences or [], confidences) if prior_confidences is not None else None
        series.append(
            {
                "period": period,
                "label_count": len(labelled),
                "prediction_coverage": coverage,
                "multiclass_brier": brier,
                "confidence_psi_vs_previous": psi,
                "coverage_shift_vs_previous": (
                    coverage - prior_coverage if coverage is not None and prior_coverage is not None else None
                ),
                "brier_shift_vs_previous": (
                    float(brier) - prior_brier if brier is not None and prior_brier is not None else None
                ),
                "qualified": qualified,
            }
        )
        if qualified:
            prior_confidences = confidences
            prior_coverage = coverage
            prior_brier = float(brier) if brier is not None else None
    return {
        "method": "quarterly_consecutive_prediction_confidence_psi",
        "minimum_quarter_labels": thresholds.minimum_quarter_labels,
        "qualified_quarter_count": qualified_count,
        "quarters": series,
    }


def _evaluate_gates(
    *,
    thresholds: EvaluationThresholds,
    total_labels: int,
    test_labels: int,
    price_labels: int,
    class_label_counts: Mapping[str, int],
    coverage: Mapping[str, float | int | None],
    classification: Mapping[str, Any],
    selected_classification_baseline: Mapping[str, Any] | None,
    price: Mapping[str, float | int | None],
    selected_price_baseline: Mapping[str, Any] | None,
    segments: Mapping[str, Any],
    stability: Mapping[str, Any],
) -> list[dict[str, Any]]:
    gates: list[dict[str, Any]] = []
    _sample_gate(gates, "total_A_or_B_labels", total_labels, thresholds.minimum_total_ab_labels)
    _sample_gate(gates, "test_A_or_B_labels", test_labels, thresholds.minimum_test_labels)
    _sample_gate(
        gates,
        "test_scored_predictions",
        int(coverage.get("scored_label_count") or 0),
        thresholds.minimum_test_labels,
    )
    _sample_gate(gates, "test_price_labels", price_labels, thresholds.minimum_price_labels)
    for label in ("cancelled_or_not_requested", "postponed", "held_no_bid", "held_adjudicated"):
        _sample_gate(
            gates,
            f"test_class_support_{label}",
            int(class_label_counts.get(label, 0)),
            thresholds.minimum_class_labels,
        )
    _sample_gate(
        gates,
        "qualified_stability_quarters",
        int(stability["qualified_quarter_count"]),
        thresholds.minimum_stability_quarters,
    )
    _minimum_gate(
        gates,
        "snapshot_coverage",
        coverage.get("snapshot_coverage"),
        thresholds.minimum_snapshot_coverage,
    )
    _minimum_gate(
        gates,
        "prediction_coverage",
        coverage.get("prediction_coverage"),
        thresholds.minimum_prediction_coverage,
    )
    _maximum_gate(gates, "classification_ece", classification.get("top_label_ece_10"), thresholds.maximum_ece)

    baseline_log_loss = _nested_metric(selected_classification_baseline, "test_metrics", "log_loss")
    _strict_improvement_gate(
        gates,
        "classification_beats_locked_baseline",
        classification.get("log_loss"),
        baseline_log_loss,
    )
    interval_coverage = price.get("interval_80_coverage")
    _range_gate(
        gates,
        "price_interval_80_coverage",
        interval_coverage,
        thresholds.minimum_interval_coverage,
        thresholds.maximum_interval_coverage,
    )
    baseline_pinball = _nested_metric(selected_price_baseline, "test_metrics", "mean_pinball_eur")
    _strict_improvement_gate(
        gates,
        "price_beats_locked_baseline",
        price.get("mean_pinball_eur"),
        baseline_pinball,
    )

    published_groups = segments.get("groups")
    if isinstance(published_groups, Sequence) and published_groups:
        groups = [group for group in published_groups if isinstance(group, Mapping)]
        groups_with_performance = sum(isinstance(group.get("classification"), Mapping) for group in groups)
        _sample_gate(gates, "published_segment_prediction_support", groups_with_performance, len(groups))
        brier_gaps = [
            float(bias["multiclass_brier_gap"])
            for group in groups
            if isinstance((bias := group.get("bias")), Mapping) and bias.get("multiclass_brier_gap") is not None
        ]
        coverage_gaps = [
            abs(float(bias["prediction_coverage_gap"]))
            for group in groups
            if isinstance((bias := group.get("bias")), Mapping) and bias.get("prediction_coverage_gap") is not None
        ]
        _maximum_gate(
            gates,
            "published_segment_brier_degradation",
            max(brier_gaps, default=None),
            thresholds.maximum_segment_brier_gap,
        )
        _maximum_gate(
            gates,
            "published_segment_coverage_gap",
            max(coverage_gaps, default=None),
            thresholds.maximum_segment_coverage_gap,
        )

    qualified_quarters = [quarter for quarter in stability["quarters"] if quarter["qualified"]]
    psi_values = [quarter["confidence_psi_vs_previous"] for quarter in qualified_quarters[1:]]
    coverage_shifts = [quarter["coverage_shift_vs_previous"] for quarter in qualified_quarters[1:]]
    brier_shifts = [quarter["brier_shift_vs_previous"] for quarter in qualified_quarters[1:]]
    _maximum_gate(
        gates,
        "quarterly_confidence_psi",
        max((float(value) for value in psi_values if value is not None), default=None),
        thresholds.maximum_confidence_psi,
        strict=True,
    )
    _maximum_gate(
        gates,
        "quarterly_coverage_shift",
        max((abs(float(value)) for value in coverage_shifts if value is not None), default=None),
        thresholds.maximum_coverage_shift,
    )
    _maximum_gate(
        gates,
        "quarterly_brier_degradation",
        max((float(value) for value in brier_shifts if value is not None), default=None),
        thresholds.maximum_brier_shift,
    )
    return gates


def _sample_gate(gates: list[dict[str, Any]], code: str, observed: int, minimum: int) -> None:
    gates.append(
        {
            "code": code,
            "result": "passed" if observed >= minimum else "insufficient",
            "observed": observed,
            "minimum": minimum,
        }
    )


def _minimum_gate(gates: list[dict[str, Any]], code: str, observed: object, minimum: float) -> None:
    result = "insufficient" if observed is None else ("passed" if float(observed) >= minimum else "failed")
    gates.append({"code": code, "result": result, "observed": observed, "minimum": minimum})


def _maximum_gate(
    gates: list[dict[str, Any]],
    code: str,
    observed: object,
    maximum: float,
    *,
    strict: bool = False,
) -> None:
    if observed is None:
        result = "insufficient"
    else:
        result = "passed" if (float(observed) < maximum if strict else float(observed) <= maximum) else "failed"
    gates.append({"code": code, "result": result, "observed": observed, "maximum": maximum, "strict": strict})


def _range_gate(gates: list[dict[str, Any]], code: str, observed: object, minimum: float, maximum: float) -> None:
    result = "insufficient" if observed is None else ("passed" if minimum <= float(observed) <= maximum else "failed")
    gates.append({"code": code, "result": result, "observed": observed, "minimum": minimum, "maximum": maximum})


def _strict_improvement_gate(
    gates: list[dict[str, Any]],
    code: str,
    candidate: object,
    baseline: object,
) -> None:
    if candidate is None or baseline is None:
        result = "insufficient"
    else:
        result = "passed" if float(candidate) < float(baseline) else "failed"
    gates.append({"code": code, "result": result, "candidate": candidate, "baseline": baseline, "strict": True})


def _overall_status(gates: Sequence[Mapping[str, Any]]) -> str:
    results = {gate["result"] for gate in gates}
    if "insufficient" in results:
        return "insufficient_data"
    if "failed" in results:
        return "failed"
    return "passed"


def _split_for_date(value: Any, config: EvaluationConfig) -> SplitName:
    if value < config.train_end:
        return "training"
    if value < config.validation_end:
        return "validation"
    return "test"


def _lowest_metric_name(metrics: Mapping[str, Mapping[str, Any]], key: str) -> str | None:
    candidates = [(float(values[key]), name) for name, values in metrics.items() if values.get(key) is not None]
    return min(candidates)[1] if candidates else None


def _nested_metric(value: Mapping[str, Any] | None, first: str, second: str) -> object:
    if value is None or not isinstance(value.get(first), Mapping):
        return None
    return value[first].get(second)


def _optional_ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _label_available_before(record: EvaluationRecord, cutoff: datetime) -> bool:
    return (
        record.label_grade in ("A", "B")
        and record.outcome is not None
        and record.label_available_at is not None
        and record.label_available_at < cutoff
    )


def _price_label_available_before(record: EvaluationRecord, cutoff: datetime) -> bool:
    return (
        _label_available_before(record, cutoff)
        and record.actual_price_eur is not None
        and record.price_label_available_at is not None
        and record.price_label_available_at < cutoff
    )


def _difference(left: object, right: object) -> float | None:
    if left is None or right is None:
        return None
    return float(left) - float(right)


def _quarter(year: int, month: int) -> str:
    return f"{year:04d}-Q{(month - 1) // 3 + 1}"


def _require_computed_at(computed_at: datetime, config: EvaluationConfig) -> None:
    if computed_at.tzinfo is None or computed_at.utcoffset() is None:
        raise EvaluationInputError("computed_at must be timezone-aware")
    if computed_at < config.label_cutoff_at:
        raise EvaluationInputError("computed_at cannot predate label cutoff")


def _utc_iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
