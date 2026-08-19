from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from src.outcome_evaluation import (
    EvaluationConfig,
    EvaluationInputError,
    EvaluationRecord,
    EvaluationThresholds,
    PriceQuantiles,
    build_promotion_summary,
    evaluate,
    temporal_lot_split,
    validate_public_report,
)
from src.outcome_evaluation.cli import main
from src.outcome_evaluation.metrics import classification_metrics, population_stability_index, price_metrics
from src.outcome_evaluation.repository import (
    _FIND_EXISTING_EVALUATION_SQL,
    _INSERT_EVALUATION_SQL,
    _LOAD_MODEL_SQL,
    _LOAD_RECORDS_SQL,
    EvaluationPersistSummary,
    EvaluationUniverse,
    OutcomeEvaluationRepository,
    OutcomeEvaluationRepositoryError,
    _exclusive_probabilities,
    _manifest_hash,
)

_CLASSES = (
    "cancelled_or_not_requested",
    "postponed",
    "held_no_bid",
    "held_adjudicated",
)


def _config(mode: str = "historical_replay") -> EvaluationConfig:
    return EvaluationConfig(
        mode=mode,
        train_start=date(2024, 1, 1),
        train_end=date(2025, 1, 1),
        validation_end=date(2025, 4, 1),
        test_end=date(2025, 10, 1),
        label_cutoff_at=datetime(2025, 12, 1, tzinfo=UTC),
        maturity_days=30,
    )


def _thresholds(*, segment_size: int = 2) -> EvaluationThresholds:
    return EvaluationThresholds(
        version="test-gates-v1",
        minimum_total_ab_labels=1,
        minimum_test_labels=1,
        minimum_price_labels=1,
        minimum_class_labels=1,
        minimum_segment_size=segment_size,
        minimum_stability_quarters=2,
        minimum_quarter_labels=1,
        minimum_snapshot_coverage=0.8,
        minimum_prediction_coverage=0.8,
        maximum_ece=0.05,
        minimum_interval_coverage=0.0,
        maximum_interval_coverage=1.0,
        maximum_confidence_psi=0.2,
        maximum_coverage_shift=0.1,
        maximum_brier_shift=0.02,
        maximum_segment_brier_gap=0.02,
        maximum_segment_coverage_gap=0.10,
    )


def _cli_args(mode: str = "prospective_shadow") -> list[str]:
    return [
        "--mode",
        mode,
        "--train-start",
        "2024-01-01",
        "--train-end",
        "2025-01-01",
        "--validation-end",
        "2025-04-01",
        "--test-end",
        "2025-10-01",
        "--label-cutoff-at",
        "2025-12-01T00:00:00Z",
        "--computed-at",
        "2025-12-02T00:00:00Z",
        "--max-records",
        "100",
    ]


def _record(
    key: str,
    scheduled_at: datetime,
    *,
    outcome: str | None = "held_adjudicated",
    ready: bool = True,
    actual_price: float | None = 100_000,
    predicted_price: float | None = 100_000,
    probabilities: dict[str, float] | None = None,
    tribunal: str = "TJ-A",
    price_label_delay_days: int = 1,
) -> EvaluationRecord:
    if outcome != "held_adjudicated":
        actual_price = None
    if probabilities is None and outcome is not None:
        probabilities = {label: float(label == outcome) for label in _CLASSES}
    cutoff = scheduled_at - timedelta(days=7) if ready else None
    generated = scheduled_at - timedelta(days=6) if ready else None
    recorded = scheduled_at - timedelta(days=5) if ready else None
    return EvaluationRecord(
        lot_key=key,
        scheduled_at=scheduled_at,
        label_available_at=scheduled_at + timedelta(days=1) if outcome is not None else None,
        price_label_available_at=(
            scheduled_at + timedelta(days=price_label_delay_days) if actual_price is not None else None
        ),
        label_grade="A" if outcome is not None else None,
        outcome=outcome,
        actual_price_eur=actual_price,
        starting_price_eur=60_000,
        snapshot_available=ready,
        snapshot_cutoff_at=cutoff,
        leakage_check_passed=ready,
        prediction_status="ready" if ready else "missing",
        prediction_generated_at=generated,
        prediction_recorded_at=recorded,
        probabilities=probabilities if ready else None,
        price_quantiles=(
            PriceQuantiles(p10=predicted_price, p50=predicted_price, p90=predicted_price)
            if ready and predicted_price is not None
            else None
        ),
        segments={
            "tribunal": tribunal,
            "judicial_region": "region-a",
            "procedure_type": "saisie",
            "property_type": "apartment",
            "occupation_status": "vacant",
            "horizon": "T-7",
        },
    )


def _passing_records() -> tuple[EvaluationRecord, ...]:
    rows: list[EvaluationRecord] = []
    outcomes = list(_CLASSES)
    for index in range(12):
        when = datetime(2024, 2, 1, tzinfo=UTC) + timedelta(days=index * 20)
        outcome = outcomes[index % 4]
        rows.append(_record(f"train-{index}", when, outcome=outcome, ready=False, actual_price=80_000 + index * 2_000))
    for index in range(8):
        when = datetime(2025, 1, 5, tzinfo=UTC) + timedelta(days=index * 10)
        outcome = outcomes[index % 4]
        rows.append(_record(f"validation-{index}", when, outcome=outcome, ready=False, actual_price=110_000 + index * 3_000))
    test_dates = (
        datetime(2025, 4, 5, tzinfo=UTC),
        datetime(2025, 4, 20, tzinfo=UTC),
        datetime(2025, 5, 5, tzinfo=UTC),
        datetime(2025, 5, 20, tzinfo=UTC),
        datetime(2025, 7, 5, tzinfo=UTC),
        datetime(2025, 7, 20, tzinfo=UTC),
        datetime(2025, 8, 5, tzinfo=UTC),
        datetime(2025, 8, 20, tzinfo=UTC),
    )
    for index, when in enumerate(test_dates):
        outcome = outcomes[index % 4]
        actual = 150_000 + index * 7_000
        rows.append(_record(f"test-{index}", when, outcome=outcome, actual_price=actual, predicted_price=actual))
    return tuple(rows)


def test_config_and_record_reject_temporal_or_probability_leakage() -> None:
    with pytest.raises(EvaluationInputError):
        EvaluationConfig(
            mode="historical_replay",
            train_start=date(2025, 1, 1),
            train_end=date(2024, 1, 1),
            validation_end=date(2025, 4, 1),
            test_end=date(2025, 7, 1),
            label_cutoff_at=datetime(2025, 8, 1, tzinfo=UTC),
        )
    with pytest.raises(EvaluationInputError):
        _record(
            "bad-probability",
            datetime(2025, 5, 1, tzinfo=UTC),
            probabilities={label: 0.1 for label in _CLASSES},
        )
    with pytest.raises(EvaluationInputError):
        _record("bad-segment", datetime(2025, 5, 1, tzinfo=UTC), tribunal="https://private.example")


def test_temporal_split_moves_all_rounds_of_a_lot_to_latest_block() -> None:
    records = (
        _record("same-lot", datetime(2024, 12, 1, tzinfo=UTC), ready=False),
        _record("same-lot", datetime(2025, 5, 1, tzinfo=UTC), ready=False),
        _record("training-only", datetime(2024, 5, 1, tzinfo=UTC), ready=False),
    )
    split, summary = temporal_lot_split(records, _config())
    assert not any(record.lot_key == "same-lot" for record in split["training"])
    assert sum(record.lot_key == "same-lot" for record in split["test"]) == 2
    assert summary["lot_groups_moved_to_later_block"] == 1


def test_duplicate_unit_is_invalid_input() -> None:
    record = _record("duplicate", datetime(2025, 5, 1, tzinfo=UTC), ready=False)
    with pytest.raises(EvaluationInputError):
        temporal_lot_split((record, record), _config())


def test_classification_metrics_match_manual_fixture() -> None:
    probabilities = (
        (0.1, 0.1, 0.1, 0.7),
        (0.1, 0.1, 0.6, 0.2),
        (0.1, 0.6, 0.2, 0.1),
        (0.6, 0.2, 0.1, 0.1),
    )
    records = tuple(
        _record(
            f"metric-{index}",
            datetime(2025, 5, index + 1, tzinfo=UTC),
            outcome=outcome,
            probabilities=dict(zip(_CLASSES, row, strict=True)),
        )
        for index, (outcome, row) in enumerate(zip(reversed(_CLASSES), probabilities, strict=True))
    )
    metrics = classification_metrics(records)
    assert metrics["log_loss"] == pytest.approx(0.47228795380917615)
    assert metrics["multiclass_brier"] == pytest.approx(0.195)
    assert metrics["top_label_ece_10"] == pytest.approx(0.375)
    assert metrics["top_label_mce_10"] == pytest.approx(0.4)
    assert metrics["accuracy"] == 1
    assert metrics["macro_f1"] == 1


def test_price_metrics_match_manual_fixture() -> None:
    actuals = [100, 200, 300, 400]
    forecasts = [
        PriceQuantiles(80, 100, 120),
        PriceQuantiles(180, 220, 260),
        PriceQuantiles(280, 330, 360),
        PriceQuantiles(420, 500, 550),
    ]
    metrics = price_metrics(actuals, forecasts)
    assert metrics["pinball_p10_eur"] == pytest.approx(6.0)
    assert metrics["pinball_p50_eur"] == pytest.approx(18.75)
    assert metrics["pinball_p90_eur"] == pytest.approx(7.25)
    assert metrics["mean_absolute_error_eur"] == 37.5
    assert metrics["median_absolute_error_eur"] == 25
    assert metrics["median_absolute_log_error"] == pytest.approx(0.09531017980432493)
    assert metrics["signed_log_bias"] == pytest.approx(0.10344097773071491)
    assert metrics["interval_80_coverage"] == 0.75
    assert metrics["mean_interval_width_eur"] == 82.5
    assert metrics["mean_normalized_interval_width"] == pytest.approx(0.34791666666666665)


def test_population_stability_index_is_zero_for_identical_distributions() -> None:
    assert population_stability_index([0.1, 0.2, 0.8], [0.1, 0.2, 0.8]) == pytest.approx(0)
    assert population_stability_index([], [0.1]) is None


def test_non_adjudicated_outcome_never_carries_a_realized_price() -> None:
    record = _record("no-bid", datetime(2025, 5, 1, tzinfo=UTC), outcome="held_no_bid", actual_price=99_000)
    assert record.actual_price_eur is None
    with pytest.raises(EvaluationInputError):
        replace(record, actual_price_eur=99_000)


def test_repository_sql_uses_definitive_final_price_latest_availability_and_safe_snapshot() -> None:
    normalized = " ".join(_LOAD_RECORDS_SQL.split())
    assert "outcome_row.finality_status = 'procedurally_definitive'" in normalized
    assert "'final_hammer_price_eur'" in normalized
    assert "'finality_status'" in normalized
    assert "initial_hammer_price_eur" not in normalized
    assert "outcome_row.result_observed_at" in normalized
    assert "outcome_row.created_at" in normalized
    assert "outcome_row.recorded_at" in normalized
    assert "prediction_snapshot.built_at" in normalized
    assert "prediction_snapshot.created_at" in normalized
    assert "prediction_snapshot.recorded_at" in normalized
    assert "outcome_claim_eligibility_decisions" in normalized
    assert "max(decision_row.decided_at) filter" in normalized
    assert "max(review_row.recorded_at) filter" in normalized
    assert "price_label_available_at" in normalized
    assert _LOAD_RECORDS_SQL.count("%s") == 10


def test_conditional_probability_conversion_is_strict_and_never_normalizes() -> None:
    payload = {
        "held_probability": 0.60005,
        "postponed_probability": 0.2,
        "cancelled_or_not_requested_probability": 0.2,
        "adjudicated_if_held_probability": 0.7,
        "no_bid_if_held_probability": 0.3,
    }
    converted = _exclusive_probabilities(payload)
    assert sum(converted.values()) == pytest.approx(1.00005)
    with pytest.raises(EvaluationInputError):
        _exclusive_probabilities({**payload, "held_probability": 0.601})
    with pytest.raises(EvaluationInputError):
        _exclusive_probabilities({**payload, "held_probability": float("nan")})
    with pytest.raises(EvaluationInputError):
        _exclusive_probabilities({**payload, "adjudicated_if_held_probability": 0.8})


def test_training_baselines_exclude_labels_only_available_after_train_end() -> None:
    rows = [
        replace(record, label_available_at=datetime(2025, 2, 1, tzinfo=UTC))
        if record.lot_key.startswith("train-")
        else record
        for record in _passing_records()
    ]
    report = evaluate(rows, _config(), thresholds=_thresholds(), computed_at=datetime(2025, 12, 2, tzinfo=UTC))
    assert report["classification"]["baselines"] == {}
    assert report["classification"]["selected_baseline"] is None
    assert report["status"] == "insufficient_data"


def test_price_baselines_exclude_prices_approved_after_the_split_boundary() -> None:
    rows = [
        replace(record, price_label_available_at=datetime(2025, 2, 1, tzinfo=UTC))
        if record.lot_key.startswith("train-") and record.actual_price_eur is not None
        else record
        for record in _passing_records()
    ]
    report = evaluate(rows, _config(), thresholds=_thresholds(), computed_at=datetime(2025, 12, 2, tzinfo=UTC))
    assert report["classification"]["baselines"]
    assert report["price"]["baselines"] == {}
    assert report["price"]["selected_baseline"] is None
    assert report["status"] == "insufficient_data"


def test_empty_dataset_is_fail_closed_and_contains_no_rows() -> None:
    report = evaluate((), _config(), thresholds=_thresholds(), computed_at=datetime(2025, 12, 2, tzinfo=UTC))
    assert report["status"] == "insufficient_data"
    assert report["coverage"]["mature_test_records"] == 0
    assert report["writes"] == 0
    serialized = json.dumps(report)
    assert "lot_key" not in serialized
    assert "round_id" not in serialized
    assert "source_url" not in serialized


def test_complete_historical_and_prospective_backtests_can_pass() -> None:
    for mode in ("historical_replay", "prospective_shadow"):
        report = evaluate(
            _passing_records(),
            _config(mode),
            thresholds=_thresholds(),
            computed_at=datetime(2025, 12, 2, tzinfo=UTC),
        )
        assert report["status"] == "passed"
        assert report["evaluation_mode"] == mode
        assert report["backtest"]["baseline_selection_block"] == "validation"
        assert report["classification"]["selected_baseline"] is not None
        assert report["price"]["selected_baseline"] is not None
        assert report["stability"]["qualified_quarter_count"] == 2


def test_promotion_summary_matches_closed_sql_contract() -> None:
    report = evaluate(
        _passing_records(),
        _config(),
        thresholds=_thresholds(),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    summary = build_promotion_summary(report)
    assert set(summary) == {
        "schemaVersion",
        "thresholdVersion",
        "evaluationMode",
        "aggregateOnly",
        "containsPersonalData",
        "metrics",
        "calibration",
        "gates",
    }
    assert summary["schemaVersion"] == "outcome_model_evaluation_report_v1"
    assert summary["thresholdVersion"] == "test-gates-v1"
    assert summary["evaluationMode"] == "historical_replay"
    assert summary["aggregateOnly"] is True
    assert summary["containsPersonalData"] is False
    assert summary["metrics"] == {
        "brierScore": 0.0,
        "logLoss": 0.0,
        "meanAbsoluteError": 0.0,
        "intervalCoverage80": 1.0,
    }
    assert summary["calibration"] == {
        "expectedCalibrationError": 0.0,
        "maximumCalibrationError": 0.0,
        "binCount": 10,
    }
    assert all(summary["gates"].values())


def test_insufficient_promotion_summary_keeps_promotion_booleans_false() -> None:
    report = evaluate((), _config(), thresholds=_thresholds(), computed_at=datetime(2025, 12, 2, tzinfo=UTC))
    summary = build_promotion_summary(report)
    assert summary["calibration"]["binCount"] is None
    assert summary["gates"] == {
        "inputContractPassed": True,
        "temporalLeakageCheckPassed": True,
        "performanceThresholdPassed": False,
        "calibrationThresholdPassed": False,
    }


def test_promotion_summary_rejects_a_passed_status_with_a_failed_detailed_gate() -> None:
    report = evaluate(
        _passing_records(),
        _config(),
        thresholds=_thresholds(),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    contradictory_gates = [
        {**gate, "result": "failed"} if gate["code"] == "prediction_coverage" else gate
        for gate in report["gates"]
    ]
    with pytest.raises(EvaluationInputError):
        build_promotion_summary({**report, "gates": contradictory_gates})


def test_missing_class_support_is_insufficient_data() -> None:
    rows = [record for record in _passing_records() if not record.lot_key.startswith("test-")]
    for class_index, outcome in enumerate(_CLASSES):
        count = 29 if class_index == 0 else 30
        for index in range(count):
            quarter_month = 4 if index % 2 == 0 else 7
            rows.append(
                _record(
                    f"class-{class_index}-{index}",
                    datetime(2025, quarter_month, 1, tzinfo=UTC) + timedelta(hours=index),
                    outcome=outcome,
                    actual_price=200_000 + index,
                    predicted_price=200_000 + index,
                )
            )
    report = evaluate(
        rows,
        _config(),
        thresholds=replace(_thresholds(), minimum_class_labels=30),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    assert report["status"] == "insufficient_data"
    assert any(
        gate["code"] == "test_class_support_cancelled_or_not_requested" and gate["result"] == "insufficient"
        for gate in report["gates"]
    )


def test_published_segment_with_fewer_than_30_predictions_is_insufficient() -> None:
    rows = [record for record in _passing_records() if not record.lot_key.startswith("test-")]
    for index in range(30):
        month = 4 if index % 2 == 0 else 7
        outcome = _CLASSES[index % 4]
        actual = 200_000 + index if outcome == "held_adjudicated" else None
        rows.append(
            _record(
                f"segment-support-{index}",
                datetime(2025, month, 1, tzinfo=UTC) + timedelta(hours=index),
                outcome=outcome,
                ready=index < 29,
                actual_price=actual,
                predicted_price=actual,
            )
        )
    report = evaluate(
        rows,
        _config(),
        thresholds=_thresholds(segment_size=30),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    assert any(
        gate["code"] == "published_segment_prediction_support" and gate["result"] == "insufficient"
        for gate in report["gates"]
    )


def test_published_segment_brier_degradation_over_threshold_fails() -> None:
    rows = [record for record in _passing_records() if not record.lot_key.startswith("test-")]
    for group_index, tribunal in enumerate(("TJ-GOOD", "TJ-BAD")):
        for index in range(30):
            month = 4 if index % 2 == 0 else 7
            outcome = _CLASSES[index % 4]
            predicted_outcome = outcome if group_index == 0 else _CLASSES[(_CLASSES.index(outcome) + 1) % 4]
            probabilities = {label: float(label == predicted_outcome) for label in _CLASSES}
            actual = 200_000 + index if outcome == "held_adjudicated" else None
            rows.append(
                _record(
                    f"segment-brier-{group_index}-{index}",
                    datetime(2025, month, 1, tzinfo=UTC) + timedelta(hours=index),
                    outcome=outcome,
                    probabilities=probabilities,
                    actual_price=actual,
                    predicted_price=actual,
                    tribunal=tribunal,
                )
            )
    report = evaluate(
        rows,
        _config(),
        thresholds=_thresholds(segment_size=30),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    assert any(
        gate["code"] == "published_segment_brier_degradation" and gate["result"] == "failed"
        for gate in report["gates"]
    )


def test_published_segment_coverage_gap_over_threshold_fails() -> None:
    rows = [record for record in _passing_records() if not record.lot_key.startswith("test-")]
    for group_index, tribunal in enumerate(("TJ-FULL", "TJ-PARTIAL")):
        for index in range(30):
            month = 4 if index % 2 == 0 else 7
            outcome = _CLASSES[index % 4]
            ready = group_index == 0 or index < 20
            actual = 200_000 + index if outcome == "held_adjudicated" else None
            rows.append(
                _record(
                    f"segment-coverage-{group_index}-{index}",
                    datetime(2025, month, 1, tzinfo=UTC) + timedelta(hours=index),
                    outcome=outcome,
                    ready=ready,
                    actual_price=actual,
                    predicted_price=actual,
                    tribunal=tribunal,
                )
            )
    report = evaluate(
        rows,
        _config(),
        thresholds=_thresholds(segment_size=30),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    assert any(
        gate["code"] == "published_segment_coverage_gap" and gate["result"] == "failed"
        for gate in report["gates"]
    )


def test_low_prediction_coverage_fails_without_dropping_abstentions() -> None:
    rows = list(_passing_records())
    for index, record in enumerate(rows):
        if record.lot_key.startswith("test-") and record.lot_key != "test-0":
            rows[index] = _record(
                record.lot_key,
                record.scheduled_at,
                outcome=record.outcome,
                ready=False,
                actual_price=record.actual_price_eur,
            )
    report = evaluate(rows, _config(), thresholds=_thresholds(), computed_at=datetime(2025, 12, 2, tzinfo=UTC))
    assert report["coverage"]["mature_test_records"] == 8
    assert report["coverage"]["prediction_coverage"] == pytest.approx(1 / 8)
    assert report["coverage"]["missing_prediction_count"] == 7
    assert any(gate["code"] == "prediction_coverage" and gate["result"] == "failed" for gate in report["gates"])


def test_scored_prediction_minimum_is_an_explicit_insufficient_gate() -> None:
    rows = list(_passing_records())
    for index, record in enumerate(rows):
        if record.lot_key == "test-0":
            rows[index] = _record(
                record.lot_key,
                record.scheduled_at,
                outcome=record.outcome,
                ready=False,
                actual_price=record.actual_price_eur,
            )
    report = evaluate(
        rows,
        _config(),
        thresholds=replace(_thresholds(), minimum_test_labels=8, minimum_prediction_coverage=0),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    assert report["status"] == "insufficient_data"
    assert any(
        gate["code"] == "test_scored_predictions"
        and gate["observed"] == 7
        and gate["minimum"] == 8
        and gate["result"] == "insufficient"
        for gate in report["gates"]
    )


@pytest.mark.parametrize(("size", "published", "suppressed"), [(29, 0, 6), (30, 6, 0)])
def test_segment_boundary_suppresses_groups_below_30(size: int, published: int, suppressed: int) -> None:
    rows = [record for record in _passing_records() if not record.lot_key.startswith("test-")]
    rows.extend(
        _record(
            f"segment-{index}",
            datetime(2025, 6, 1, tzinfo=UTC) + timedelta(hours=index),
            outcome=_CLASSES[index % 4],
            actual_price=200_000 + index,
            predicted_price=200_000 + index,
        )
        for index in range(size)
    )
    report = evaluate(
        rows,
        _config(),
        thresholds=_thresholds(segment_size=30),
        computed_at=datetime(2025, 12, 2, tzinfo=UTC),
    )
    assert report["segments"]["published_group_count"] == published
    assert report["segments"]["suppressed_group_count"] == suppressed
    if size == 29:
        assert report["segments"]["groups"] == []


def test_privacy_validator_rejects_identifiers_urls_and_non_finite_values() -> None:
    for payload in ({"round_id": "secret"}, {"safe": "https://example.test"}, {"safe": float("nan")}):
        with pytest.raises(EvaluationInputError):
            validate_public_report(payload)


class _EmptyCursor:
    description: list[Any] = []

    def __init__(self, statements: list[str]) -> None:
        self._statements = statements

    def __enter__(self) -> _EmptyCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, _parameters: object = None) -> None:
        self._statements.append(statement)

    def fetchall(self) -> list[object]:
        return []

    def fetchone(self) -> None:
        return None


class _EmptyConnection:
    def __init__(self, statements: list[str]) -> None:
        self._statements = statements
        self.rolled_back = False

    def __enter__(self) -> _EmptyConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> _EmptyCursor:
        return _EmptyCursor(self._statements)

    def rollback(self) -> None:
        self.rolled_back = True


def _universe(
    *,
    mode: str = "prospective_shadow",
    records: tuple[EvaluationRecord, ...] = (),
    feature_cutoff_at: datetime | None = None,
) -> EvaluationUniverse:
    return EvaluationUniverse(
        model_version_id="11111111-1111-4111-8111-111111111111",
        model_status="validated" if mode == "historical_replay" else "shadow",
        records=records,
        feature_cutoff_at=feature_cutoff_at,
        source_manifest_hash="a" * 64,
        prediction_manifest_hash="b" * 64,
        outcome_manifest_hash="c" * 64,
    )


def test_repository_empty_database_uses_read_only_repeatable_read() -> None:
    statements: list[str] = []
    connection = _EmptyConnection(statements)
    repository = OutcomeEvaluationRepository("postgresql://configured", connect=lambda _url: connection)
    records = repository.load_records(
        _config(),
        model_key="outcome_graph",
        model_version="v1",
        horizon="T-7",
        prediction_kind="shadow",
        max_records=100,
    )
    assert records == ()
    assert statements[0].casefold() == "set transaction isolation level repeatable read read only"
    assert connection.rolled_back


def test_repository_requires_an_existing_model_before_loading_records() -> None:
    statements: list[str] = []
    repository = OutcomeEvaluationRepository(
        "postgresql://configured",
        connect=lambda _url: _EmptyConnection(statements),
    )
    with pytest.raises(OutcomeEvaluationRepositoryError):
        repository.load_universe(
            _config(),
            model_key="outcome_graph",
            model_version="missing",
            horizon="T-7",
            prediction_kind="shadow",
            max_records=100,
        )
    assert statements[0].casefold() == "set transaction isolation level repeatable read read only"
    assert statements[1] == _LOAD_MODEL_SQL
    assert _LOAD_RECORDS_SQL not in statements


def test_cli_database_empty_returns_insufficient_data_without_write(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://configured")
    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.load_universe",
        lambda *_args, **_kwargs: _universe(),
    )
    persisted = False

    def fail_if_persisted(*_args: object, **_kwargs: object) -> EvaluationPersistSummary:
        nonlocal persisted
        persisted = True
        raise AssertionError("dry-run must not persist")

    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.persist_evaluation",
        fail_if_persisted,
    )
    code = main(
        [
            "--mode",
            "prospective_shadow",
            "--train-start",
            "2024-01-01",
            "--train-end",
            "2025-01-01",
            "--validation-end",
            "2025-04-01",
            "--test-end",
            "2025-10-01",
            "--label-cutoff-at",
            "2025-12-01T00:00:00Z",
            "--computed-at",
            "2025-12-02T00:00:00Z",
            "--max-records",
            "100",
        ]
    )
    payload = json.loads(capsys.readouterr().out)
    assert code == 1
    assert payload["status"] == "insufficient_data"
    assert payload["writes"] == 0
    assert persisted is False


@pytest.mark.parametrize("disabled_value", ["TRUE", "1", "yes", "false", " true"])
def test_cli_persist_requires_exact_server_kill_switch(
    disabled_value: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://configured")
    monkeypatch.setenv("OUTCOME_EVALUATION_ENABLED", disabled_value)
    loaded = False

    def fail_if_loaded(*_args: object, **_kwargs: object) -> EvaluationUniverse:
        nonlocal loaded
        loaded = True
        raise AssertionError("the database must not be read while the persistence gate is closed")

    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.load_universe",
        fail_if_loaded,
    )
    code = main([*_cli_args(), "--persist"])
    captured = capsys.readouterr()
    assert code == 2
    assert json.loads(captured.out)["status"] == "invalid_input"
    assert captured.err == ""
    assert loaded is False


def test_cli_rejects_json_persistence_before_reading_the_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("OUTCOME_EVALUATION_ENABLED", "true")
    missing_path = tmp_path / "must-not-be-read.json"
    code = main([*_cli_args(), "--input-json", str(missing_path), "--persist"])
    captured = capsys.readouterr()
    assert code == 2
    assert json.loads(captured.out)["status"] == "invalid_input"
    assert captured.err == ""


def test_cli_locks_historical_persistence_until_an_artifact_executor_exists(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://configured")
    monkeypatch.setenv("OUTCOME_EVALUATION_ENABLED", "true")
    loaded = False

    def fail_if_loaded(*_args: object, **_kwargs: object) -> EvaluationUniverse:
        nonlocal loaded
        loaded = True
        raise AssertionError("historical persistence must fail before the database replay path")

    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.load_universe",
        fail_if_loaded,
    )
    code = main([*_cli_args("historical_replay"), "--persist"])
    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "error": "outcome evaluation was not persisted",
        "reason": "historical_artifact_executor_unavailable",
    }
    assert loaded is False


def test_cli_does_not_persist_an_empty_insufficient_evaluation(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://configured")
    monkeypatch.setenv("OUTCOME_EVALUATION_ENABLED", "true")
    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.load_universe",
        lambda *_args, **_kwargs: _universe(),
    )
    persisted = False

    def fail_if_persisted(*_args: object, **_kwargs: object) -> EvaluationPersistSummary:
        nonlocal persisted
        persisted = True
        raise AssertionError("empty insufficient evaluations must not be persisted")

    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.persist_evaluation",
        fail_if_persisted,
    )
    code = main([*_cli_args(), "--persist"])
    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "error": "outcome evaluation was not persisted",
        "reason": "empty_evaluation_universe",
    }
    assert persisted is False


class _WriteCursor:
    def __init__(self) -> None:
        self.statement: str | None = None
        self.parameters: tuple[object, ...] | None = None

    def __enter__(self) -> _WriteCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: tuple[object, ...]) -> None:
        self.statement = statement
        self.parameters = parameters

    def fetchone(self) -> tuple[str]:
        return ("d" * 64,)


class _WriteConnection:
    def __init__(self) -> None:
        self.write_cursor = _WriteCursor()
        self.committed = False
        self.rolled_back = False

    def __enter__(self) -> _WriteConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> _WriteCursor:
        return self.write_cursor

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True


def test_repository_persists_only_the_parameterized_compact_aggregate() -> None:
    config = _config("prospective_shadow")
    computed_at = datetime(2025, 12, 2, tzinfo=UTC)
    report = evaluate(_passing_records(), config, computed_at=computed_at)
    assert report["status"] == "insufficient_data"
    feature_cutoff = datetime(2025, 8, 13, tzinfo=UTC)
    connection = _WriteConnection()
    repository = OutcomeEvaluationRepository("postgresql://configured", connect=lambda _url: connection)

    result = repository.persist_evaluation(
        _universe(records=_passing_records(), feature_cutoff_at=feature_cutoff),
        config,
        report,
        computed_at=computed_at,
    )

    assert result.inserted_evaluations == 1
    assert connection.committed is True
    assert connection.rolled_back is False
    assert connection.write_cursor.statement == _INSERT_EVALUATION_SQL
    parameters = connection.write_cursor.parameters
    assert parameters is not None
    assert parameters[:3] == (
        "11111111-1111-4111-8111-111111111111",
        "prospective_shadow",
        "insufficient_data",
    )
    assert parameters[6] == config.label_cutoff_at
    assert parameters[7] == config.label_cutoff_at
    assert parameters[8:15] == (300, 8, 8, 8, 8, 0, 0)
    assert parameters[15:18] == ("a" * 64, "b" * 64, "c" * 64)
    compact_report = json.loads(str(parameters[18]))
    assert compact_report["thresholdVersion"] == "outcome-commercial-v1"
    assert compact_report["evaluationMode"] == "prospective_shadow"
    assert set(compact_report) == {
        "schemaVersion",
        "thresholdVersion",
        "evaluationMode",
        "aggregateOnly",
        "containsPersonalData",
        "metrics",
        "calibration",
        "gates",
    }


class _RetryCursor:
    def __init__(self, *, fail_insert: bool = False) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self._results: list[tuple[str] | None] = [None, ("e" * 64,)]
        self._fail_insert = fail_insert

    def __enter__(self) -> _RetryCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: tuple[object, ...]) -> None:
        self.calls.append((statement, parameters))
        if self._fail_insert:
            raise RuntimeError("database detail that must stay private")

    def fetchone(self) -> tuple[str] | None:
        return self._results.pop(0)


class _RetryConnection:
    def __init__(self, *, fail_insert: bool = False) -> None:
        self.retry_cursor = _RetryCursor(fail_insert=fail_insert)
        self.committed = False
        self.rolled_back = False

    def __enter__(self) -> _RetryConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> _RetryCursor:
        return self.retry_cursor

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True


def test_repository_persistence_retry_is_idempotent() -> None:
    config = _config("prospective_shadow")
    computed_at = datetime(2025, 12, 2, tzinfo=UTC)
    report = evaluate(_passing_records(), config, computed_at=computed_at)
    connection = _RetryConnection()
    repository = OutcomeEvaluationRepository("postgresql://configured", connect=lambda _url: connection)
    result = repository.persist_evaluation(
        _universe(
            records=_passing_records(),
            feature_cutoff_at=datetime(2025, 8, 13, tzinfo=UTC),
        ),
        config,
        report,
        computed_at=computed_at,
    )
    assert result.inserted_evaluations == 0
    assert connection.committed is True
    assert connection.rolled_back is False
    assert [statement for statement, _parameters in connection.retry_cursor.calls] == [
        _INSERT_EVALUATION_SQL,
        _FIND_EXISTING_EVALUATION_SQL,
    ]
    assert connection.retry_cursor.calls[0][1] == connection.retry_cursor.calls[1][1]


def test_repository_recomputes_the_report_before_any_insert() -> None:
    config = _config("prospective_shadow")
    computed_at = datetime(2025, 12, 2, tzinfo=UTC)
    report = evaluate(_passing_records(), config, computed_at=computed_at)
    candidate = dict(report["classification"]["candidate"])
    candidate["log_loss"] = 0.123456
    contradictory_report = {
        **report,
        "classification": {**report["classification"], "candidate": candidate},
    }
    connected = False

    def fail_if_connected(_url: str) -> _WriteConnection:
        nonlocal connected
        connected = True
        raise AssertionError("a non-reproducible report must be rejected before opening the write transaction")

    repository = OutcomeEvaluationRepository("postgresql://configured", connect=fail_if_connected)
    with pytest.raises(OutcomeEvaluationRepositoryError) as caught:
        repository.persist_evaluation(
            _universe(
                records=_passing_records(),
                feature_cutoff_at=datetime(2025, 8, 13, tzinfo=UTC),
            ),
            config,
            contradictory_report,
            computed_at=computed_at,
        )
    assert str(caught.value) == "evaluation report does not match the bounded database universe"
    assert connected is False


def test_repository_rolls_back_and_wraps_insert_failures() -> None:
    config = _config("prospective_shadow")
    computed_at = datetime(2025, 12, 2, tzinfo=UTC)
    report = evaluate(_passing_records(), config, computed_at=computed_at)
    connection = _RetryConnection(fail_insert=True)
    repository = OutcomeEvaluationRepository("postgresql://configured", connect=lambda _url: connection)
    with pytest.raises(OutcomeEvaluationRepositoryError) as caught:
        repository.persist_evaluation(
            _universe(
                records=_passing_records(),
                feature_cutoff_at=datetime(2025, 8, 13, tzinfo=UTC),
            ),
            config,
            report,
            computed_at=computed_at,
        )
    assert str(caught.value) == "failed to persist the aggregate evaluation"
    assert "database detail" not in str(caught.value)
    assert connection.committed is False
    assert connection.rolled_back is True


def test_evaluation_manifest_hashes_are_deterministic_and_content_bound() -> None:
    fields = ("round_key", "scheduled_at", "starting_price_eur", "tribunal", "horizon", "prediction_hash")
    rows = (
        {
            "round_key": "internal-round-b",
            "scheduled_at": datetime(2025, 5, 2, tzinfo=UTC),
            "starting_price_eur": 100_000,
            "tribunal": "TJ-B",
            "horizon": "T-7",
            "prediction_hash": "b" * 64,
        },
        {
            "round_key": "internal-round-a",
            "scheduled_at": datetime(2025, 5, 1, tzinfo=UTC),
            "starting_price_eur": 80_000,
            "tribunal": "TJ-A",
            "horizon": "T-7",
            "prediction_hash": "a" * 64,
        },
    )
    digest = _manifest_hash(rows, fields)
    assert digest == _manifest_hash(tuple(reversed(rows)), fields)
    assert len(digest) == 64
    assert all(character in "0123456789abcdef" for character in digest)
    changed = ({**rows[0], "starting_price_eur": 100_001}, rows[1])
    assert _manifest_hash(changed, fields) != digest


def test_cli_repository_failure_is_generic_and_never_echoes_details(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    records = _passing_records()
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://configured")
    monkeypatch.setenv("OUTCOME_EVALUATION_ENABLED", "true")
    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.load_universe",
        lambda *_args, **_kwargs: _universe(
            records=records,
            feature_cutoff_at=max(
                record.snapshot_cutoff_at for record in records if record.snapshot_cutoff_at is not None
            ),
        ),
    )

    def fail_persistence(*_args: object, **_kwargs: object) -> EvaluationPersistSummary:
        raise OutcomeEvaluationRepositoryError("private-database-marker@example.test")

    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.persist_evaluation",
        fail_persistence,
    )
    code = main([*_cli_args(), "--persist"])
    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {"error": "outcome evaluation failed"}
    assert "private-database-marker" not in captured.err


def test_cli_successful_append_reports_one_write(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    records = _passing_records()
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://configured")
    monkeypatch.setenv("OUTCOME_EVALUATION_ENABLED", "true")
    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.load_universe",
        lambda *_args, **_kwargs: _universe(
            records=records,
            feature_cutoff_at=max(
                record.snapshot_cutoff_at for record in records if record.snapshot_cutoff_at is not None
            ),
        ),
    )
    monkeypatch.setattr(
        "src.outcome_evaluation.cli.OutcomeEvaluationRepository.persist_evaluation",
        lambda *_args, **_kwargs: EvaluationPersistSummary(inserted_evaluations=1),
    )
    code = main([*_cli_args(), "--persist"])
    captured = capsys.readouterr()
    assert code == 1
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert payload["status"] == "insufficient_data"
    assert payload["writes"] == 1


def test_cli_invalid_json_returns_generic_invalid_report(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = tmp_path / "records.json"
    path.write_text(json.dumps({"unexpected": "private-marker@example.test"}), encoding="utf-8")
    code = main(
        [
            "--mode",
            "historical_replay",
            "--train-start",
            "2024-01-01",
            "--train-end",
            "2025-01-01",
            "--validation-end",
            "2025-04-01",
            "--test-end",
            "2025-10-01",
            "--label-cutoff-at",
            "2025-12-01T00:00:00Z",
            "--computed-at",
            "2025-12-02T00:00:00Z",
            "--max-records",
            "100",
            "--input-json",
            str(path),
        ]
    )
    output = capsys.readouterr().out
    assert code == 2
    assert json.loads(output)["status"] == "invalid_input"
    assert "private-marker" not in output
