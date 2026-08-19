from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from pathlib import Path

from dotenv import load_dotenv

from src.config import ROOT_DIR
from src.outcome_evaluation.engine import evaluate, invalid_input_report
from src.outcome_evaluation.models import (
    COMMERCIAL_THRESHOLDS_V1,
    OUTCOME_CLASSES,
    EvaluationConfig,
    EvaluationInputError,
    EvaluationRecord,
    PriceQuantiles,
)
from src.outcome_evaluation.repository import (
    EvaluationUniverse,
    OutcomeEvaluationRepository,
    OutcomeEvaluationRepositoryError,
)

_RECORD_KEYS = frozenset(
    {
        "lot_key",
        "scheduled_at",
        "label_available_at",
        "price_label_available_at",
        "label_grade",
        "outcome",
        "actual_price_eur",
        "starting_price_eur",
        "snapshot_available",
        "snapshot_cutoff_at",
        "leakage_check_passed",
        "prediction_status",
        "prediction_generated_at",
        "prediction_recorded_at",
        "probabilities",
        "price_quantiles",
        "segments",
    }
)


class _PersistenceRejected(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run an aggregate, fail-closed Outcome evaluation. Dry-run is the default; persistence requires the "
            "server-only kill switch and a database-backed universe."
        )
    )
    parser.add_argument("--mode", choices=("historical_replay", "prospective_shadow"), required=True)
    parser.add_argument("--train-start", type=_iso_date, required=True)
    parser.add_argument("--train-end", type=_iso_date, required=True)
    parser.add_argument("--validation-end", type=_iso_date, required=True)
    parser.add_argument("--test-end", type=_iso_date, required=True)
    parser.add_argument("--label-cutoff-at", type=_iso_datetime, required=True)
    parser.add_argument("--computed-at", type=_iso_datetime, default=None)
    parser.add_argument("--maturity-days", type=_maturity_days, default=30)
    parser.add_argument("--max-records", type=_positive_int, required=True)
    parser.add_argument("--input-json", type=Path, help="Read aggregate non-PII records from JSON instead of the database.")
    parser.add_argument("--model-key", default="outcome_graph")
    parser.add_argument("--model-version", default="current")
    parser.add_argument("--horizon", choices=("T-30", "T-14", "T-7", "T-1", "T-2h"), default="T-7")
    parser.add_argument("--prediction-kind", choices=("shadow", "outcome_graph"), default="shadow")
    parser.add_argument(
        "--persist",
        action="store_true",
        help=(
            "Append a prospective compact aggregate report. Requires OUTCOME_EVALUATION_ENABLED=true and database "
            "input; historical persistence remains locked until an audited artifact executor exists."
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_dotenv(ROOT_DIR / ".env")
    computed_at = args.computed_at or datetime.now(UTC)
    repository: OutcomeEvaluationRepository | None = None
    universe: EvaluationUniverse | None = None
    try:
        config = EvaluationConfig(
            mode=args.mode,
            train_start=args.train_start,
            train_end=args.train_end,
            validation_end=args.validation_end,
            test_end=args.test_end,
            label_cutoff_at=args.label_cutoff_at,
            maturity_days=args.maturity_days,
        )
        if args.persist and args.input_json is not None:
            raise EvaluationInputError("JSON evaluations cannot be persisted")
        if args.persist and os.getenv("OUTCOME_EVALUATION_ENABLED") != "true":
            raise EvaluationInputError("evaluation persistence is disabled")
        if args.persist and args.mode == "historical_replay":
            raise _PersistenceRejected("historical_artifact_executor_unavailable")
        if args.persist and args.prediction_kind != "shadow":
            raise _PersistenceRejected("prospective_persistence_requires_shadow_predictions")
        if args.input_json is not None:
            records = _load_json_records(args.input_json, args.max_records)
        else:
            db_url = (os.getenv("SUPABASE_DB_URL") or "").strip()
            if not db_url:
                raise EvaluationInputError("database configuration is missing")
            repository = OutcomeEvaluationRepository(db_url)
            universe = repository.load_universe(
                config,
                model_key=args.model_key,
                model_version=args.model_version,
                horizon=args.horizon,
                prediction_kind=args.prediction_kind,
                max_records=args.max_records,
            )
            records = universe.records
        report = evaluate(records, config, computed_at=computed_at)
        if args.persist:
            if repository is None or universe is None:
                raise EvaluationInputError("persistence requires a database-backed universe")
            coverage = report.get("coverage")
            mature_count = coverage.get("mature_test_records") if isinstance(coverage, Mapping) else None
            if mature_count == 0:
                raise _PersistenceRejected("empty_evaluation_universe")
            if universe.feature_cutoff_at is None:
                raise _PersistenceRejected("feature_cutoff_unavailable")
            persisted = repository.persist_evaluation(universe, config, report, computed_at=computed_at)
            report = {**report, "writes": persisted.inserted_evaluations}
    except _PersistenceRejected as exc:
        _print_persistence_rejection(exc.code)
        return 2
    except OutcomeEvaluationRepositoryError:
        _print_error()
        return 2
    except (EvaluationInputError, OSError, TypeError, ValueError):
        report = invalid_input_report(
            mode=args.mode,
            threshold_version=COMMERCIAL_THRESHOLDS_V1.version,
            computed_at=computed_at,
        )
        _print_json(report)
        return 2
    _print_json(report)
    return 0 if report["status"] == "passed" else 1


def _load_json_records(path: Path, max_records: int) -> tuple[EvaluationRecord, ...]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, Mapping):
        if set(payload) != {"records"}:
            raise EvaluationInputError("JSON root fields are invalid")
        payload = payload["records"]
    if not isinstance(payload, list):
        raise EvaluationInputError("JSON payload must contain a record array")
    if len(payload) > max_records:
        raise EvaluationInputError("JSON payload exceeds the explicit record bound")
    return tuple(_record_from_json(item) for item in payload)


def _record_from_json(value: object) -> EvaluationRecord:
    if not isinstance(value, Mapping) or set(value) != _RECORD_KEYS:
        raise EvaluationInputError("record fields are invalid")
    probabilities_value = value.get("probabilities")
    probabilities: dict[str, float] | None = None
    if probabilities_value is not None:
        if not isinstance(probabilities_value, Mapping) or set(probabilities_value) != set(OUTCOME_CLASSES):
            raise EvaluationInputError("probability fields are invalid")
        probabilities = {label: float(probabilities_value[label]) for label in OUTCOME_CLASSES}
    quantiles_value = value.get("price_quantiles")
    quantiles: PriceQuantiles | None = None
    if quantiles_value is not None:
        if not isinstance(quantiles_value, Mapping) or set(quantiles_value) != {"p10", "p50", "p90"}:
            raise EvaluationInputError("price quantile fields are invalid")
        quantiles = PriceQuantiles(
            p10=float(quantiles_value["p10"]),
            p50=float(quantiles_value["p50"]),
            p90=float(quantiles_value["p90"]),
        )
    segments_value = value.get("segments", {})
    if not isinstance(segments_value, Mapping):
        raise EvaluationInputError("segments must be an object")
    return EvaluationRecord(
        lot_key=str(value["lot_key"]),
        scheduled_at=_json_datetime(value["scheduled_at"]),
        label_available_at=_json_optional_datetime(value.get("label_available_at")),
        price_label_available_at=_json_optional_datetime(value.get("price_label_available_at")),
        label_grade=value.get("label_grade"),
        outcome=value.get("outcome"),
        actual_price_eur=_optional_float(value.get("actual_price_eur")),
        starting_price_eur=_optional_float(value.get("starting_price_eur")),
        snapshot_available=bool(value.get("snapshot_available", False)),
        snapshot_cutoff_at=_json_optional_datetime(value.get("snapshot_cutoff_at")),
        leakage_check_passed=bool(value.get("leakage_check_passed", False)),
        prediction_status=value.get("prediction_status", "missing"),
        prediction_generated_at=_json_optional_datetime(value.get("prediction_generated_at")),
        prediction_recorded_at=_json_optional_datetime(value.get("prediction_recorded_at")),
        probabilities=probabilities,
        price_quantiles=quantiles,
        segments={str(key): str(item) for key, item in segments_value.items()},
    )


def _iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("value must be an ISO-8601 date") from exc


def _iso_datetime(value: str) -> datetime:
    try:
        return _json_datetime(value)
    except EvaluationInputError as exc:
        raise argparse.ArgumentTypeError("value must be a timezone-aware ISO-8601 datetime") from exc


def _json_datetime(value: object) -> datetime:
    if not isinstance(value, str):
        raise EvaluationInputError("timestamp must be an ISO-8601 string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise EvaluationInputError("timestamp is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise EvaluationInputError("timestamp must be timezone-aware")
    return parsed.astimezone(UTC)


def _json_optional_datetime(value: object) -> datetime | None:
    return None if value is None else _json_datetime(value)


def _optional_float(value: object) -> float | None:
    return None if value is None else float(value)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _maturity_days(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 365:
        raise argparse.ArgumentTypeError("value must be between 1 and 365")
    return parsed


def _print_json(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False))


def _print_error() -> None:
    print(json.dumps({"error": "outcome evaluation failed"}, ensure_ascii=False), file=sys.stderr)


def _print_persistence_rejection(code: str) -> None:
    print(
        json.dumps(
            {"error": "outcome evaluation was not persisted", "reason": code},
            ensure_ascii=False,
            sort_keys=True,
        ),
        file=sys.stderr,
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
