from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

from src.outcome_evaluation.models import EvaluationInputError


def build_promotion_summary(report: Mapping[str, Any]) -> dict[str, Any]:
    """Map the public aggregate report to the closed SQL promotion contract."""

    status = report.get("status")
    if status not in ("invalid_input", "insufficient_data", "failed", "passed"):
        raise EvaluationInputError("evaluation report status is invalid")
    if report.get("schema_version") != "outcome_evaluation_report_v1":
        raise EvaluationInputError("evaluation report schema is invalid")
    classification = _mapping_at(report, "classification", "candidate")
    price = _mapping_at(report, "price", "candidate")
    threshold_version = report.get("threshold_version")
    evaluation_mode = report.get("evaluation_mode")
    if not isinstance(threshold_version, str) or not threshold_version:
        raise EvaluationInputError("evaluation threshold version is missing")
    if evaluation_mode not in ("historical_replay", "prospective_shadow"):
        raise EvaluationInputError("evaluation mode is invalid")
    ece = _finite_or_none(classification.get("top_label_ece_10"))
    mce = _finite_or_none(classification.get("top_label_mce_10"))
    raw_brier = _finite_or_none(classification.get("multiclass_brier"))
    if raw_brier is not None and not 0 <= raw_brier <= 2:
        raise EvaluationInputError("multiclass Brier score is outside its mathematical range")
    if ece is not None and not 0 <= ece <= 1:
        raise EvaluationInputError("expected calibration error is outside [0, 1]")
    if mce is not None and not 0 <= mce <= 1:
        raise EvaluationInputError("maximum calibration error is outside [0, 1]")
    log_loss = _finite_or_none(classification.get("log_loss"))
    mean_absolute_error = _finite_or_none(price.get("mean_absolute_error_eur"))
    interval_coverage = _finite_or_none(price.get("interval_80_coverage"))
    if log_loss is not None and log_loss < 0:
        raise EvaluationInputError("log loss cannot be negative")
    if mean_absolute_error is not None and mean_absolute_error < 0:
        raise EvaluationInputError("mean absolute error cannot be negative")
    if interval_coverage is not None and not 0 <= interval_coverage <= 1:
        raise EvaluationInputError("interval coverage is outside [0, 1]")
    metrics = {
        # The engine keeps the conventional unscaled multiclass Brier in [0, 2].
        # The closed SQL promotion contract uses a normalized scalar in [0, 1].
        "brierScore": raw_brier / 2 if raw_brier is not None else None,
        "logLoss": log_loss,
        "meanAbsoluteError": mean_absolute_error,
        "intervalCoverage80": interval_coverage,
    }
    if status in ("failed", "passed") and (
        any(value is None for value in metrics.values()) or ece is None or mce is None
    ):
        raise EvaluationInputError("complete evaluation reports require all promotion metrics")
    input_contract_passed = status != "invalid_input"
    temporal_leakage_check_passed = input_contract_passed and _temporal_contract_present(report)
    if status == "invalid_input":
        gate_results = _validated_gate_results(report.get("gates"), allow_invalid=True)
        if gate_results != {"input_contract": "invalid"}:
            raise EvaluationInputError("invalid-input report gates are incoherent")
        performance_passed = False
        calibration_passed = False
    else:
        if not temporal_leakage_check_passed:
            raise EvaluationInputError("evaluation temporal contract is missing")
        gate_results = _validated_gate_results(report.get("gates"), allow_invalid=False)
        derived_status = _status_from_gate_results(gate_results)
        if status != derived_status:
            raise EvaluationInputError("evaluation status contradicts its detailed gates")
        if "classification_ece" not in gate_results:
            raise EvaluationInputError("calibration gate is missing")
        if status == "insufficient_data":
            # The SQL contract deliberately treats every incomplete report as
            # non-promotable, including families which happened to pass.
            performance_passed = False
            calibration_passed = False
        else:
            performance_passed = all(
                result == "passed" for code, result in gate_results.items() if code != "classification_ece"
            )
            calibration_passed = gate_results["classification_ece"] == "passed"

    return {
        "schemaVersion": "outcome_model_evaluation_report_v1",
        "thresholdVersion": threshold_version,
        "evaluationMode": evaluation_mode,
        "aggregateOnly": True,
        "containsPersonalData": False,
        "metrics": metrics,
        "calibration": {
            "expectedCalibrationError": ece,
            "maximumCalibrationError": mce,
            "binCount": 10 if ece is not None and mce is not None else None,
        },
        "gates": {
            "inputContractPassed": input_contract_passed,
            "temporalLeakageCheckPassed": temporal_leakage_check_passed,
            "performanceThresholdPassed": performance_passed,
            "calibrationThresholdPassed": calibration_passed,
        },
    }


def _mapping_at(value: Mapping[str, Any], *path: str) -> Mapping[str, Any]:
    current: object = value
    for key in path:
        if not isinstance(current, Mapping):
            return {}
        current = current.get(key)
    return current if isinstance(current, Mapping) else {}


def _finite_or_none(value: object) -> float | None:
    if value is None:
        return None
    numeric = float(value)
    if not math.isfinite(numeric):
        raise EvaluationInputError("promotion summary metric is not finite")
    return numeric


def _temporal_contract_present(report: Mapping[str, Any]) -> bool:
    backtest = report.get("backtest")
    return isinstance(backtest, Mapping) and backtest.get("prediction_timing") == "pre_hearing_only"


def _validated_gate_results(value: object, *, allow_invalid: bool) -> dict[str, str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise EvaluationInputError("evaluation gates are missing")
    allowed_results = {"passed", "failed", "insufficient"}
    if allow_invalid:
        allowed_results.add("invalid")
    results: dict[str, str] = {}
    for gate in value:
        if not isinstance(gate, Mapping):
            raise EvaluationInputError("evaluation gate is invalid")
        code = gate.get("code")
        result = gate.get("result")
        if not isinstance(code, str) or not code or result not in allowed_results:
            raise EvaluationInputError("evaluation gate is invalid")
        if code in results:
            raise EvaluationInputError("evaluation gate codes must be unique")
        results[code] = str(result)
    if not results:
        raise EvaluationInputError("evaluation gates are empty")
    return results


def _status_from_gate_results(results: Mapping[str, str]) -> str:
    values = set(results.values())
    if "invalid" in values:
        raise EvaluationInputError("valid evaluation reports cannot contain invalid gates")
    if "insufficient" in values:
        return "insufficient_data"
    if "failed" in values:
        return "failed"
    if values == {"passed"}:
        return "passed"
    raise EvaluationInputError("evaluation gates do not determine a status")
