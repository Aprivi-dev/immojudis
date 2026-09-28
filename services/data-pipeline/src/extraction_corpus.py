"""Evaluate the small, versioned extraction corpus used by source audits.

The corpus deliberately separates three labels that are often collapsed into
one null value:

* ``present``: the fixture contains a value and an exact normalized value is
  annotated;
* ``unknown``: the fixture explicitly says the value cannot be supplied;
* ``absent``: the fixture was reviewed and does not provide the field.

Fields that have not been reviewed are simply omitted from a case. This keeps
the benchmark honest while a human reviewed sample is being assembled.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Callable, Mapping
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

DEFAULT_CORPUS_PATH = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "extraction_corpus.json"
CORPUS_SCHEMA_VERSION = "immojudis.extraction-corpus.v1"
EVALUATOR_VERSION = "1.0"
ANNOTATION_STATES = frozenset({"present", "unknown", "absent", "unannotated"})
UNKNOWN_MARKERS = frozenset(
    {
        "unknown",
        "inconnu",
        "inconnue",
        "non renseigne",
        "non renseigné",
        "non disponible",
        "a confirmer",
        "à confirmer",
        "n/a",
    }
)
NUMBER_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$")


def load_corpus(path: Path = DEFAULT_CORPUS_PATH) -> dict[str, Any]:
    """Load and validate a corpus manifest without executing any fixture."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"extraction corpus not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid extraction corpus JSON {path}: {exc}") from exc
    validate_corpus(payload)
    return payload


def validate_corpus(payload: Mapping[str, Any]) -> None:
    """Validate the stable machine-readable corpus contract."""

    if payload.get("schema_version") != CORPUS_SCHEMA_VERSION:
        raise ValueError("unsupported extraction corpus schema_version")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("extraction corpus must contain at least one case")
    ids: set[str] = set()
    for case in cases:
        if not isinstance(case, Mapping):
            raise ValueError("extraction corpus cases must be objects")
        case_id = case.get("id")
        source = case.get("source")
        labels = case.get("labels")
        if not isinstance(case_id, str) or not case_id:
            raise ValueError("each extraction corpus case needs a non-empty id")
        if case_id in ids:
            raise ValueError(f"duplicate extraction corpus case id: {case_id}")
        ids.add(case_id)
        if not isinstance(source, str) or not source:
            raise ValueError(f"case {case_id} needs a source")
        if not isinstance(labels, Mapping) or not labels:
            raise ValueError(f"case {case_id} needs labels")
        for field, label in labels.items():
            if not isinstance(field, str) or not field:
                raise ValueError(f"case {case_id} has an invalid field name")
            if not isinstance(label, Mapping):
                raise ValueError(f"case {case_id} field {field} label must be an object")
            state = label.get("state")
            if state not in ANNOTATION_STATES:
                raise ValueError(f"case {case_id} field {field} has unsupported state {state!r}")
            if state == "present" and "value" not in label:
                raise ValueError(f"case {case_id} field {field} present label needs value")
            if state in {"unknown", "absent", "unannotated"} and "value" in label:
                raise ValueError(f"case {case_id} field {field} {state} label must not contain value")


def evaluate_corpus(
    corpus: Mapping[str, Any] | Path = DEFAULT_CORPUS_PATH,
    fixture_runner: Callable[[Mapping[str, Any]], Any] | None = None,
) -> dict[str, Any]:
    """Run each fixture and return a deterministic, JSON-safe report.

    ``fixture_runner`` receives the complete case manifest and returns an
    ``AuctionSale``-like object. Keeping fixture loading outside this module
    means the benchmark can later be pointed at captured human-reviewed
    documents without importing the test suite into production parsing code.
    """

    if isinstance(corpus, Path):
        payload = load_corpus(corpus)
        corpus_bytes = corpus.read_bytes()
    else:
        payload = dict(corpus)
        validate_corpus(payload)
        corpus_bytes = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    if fixture_runner is None:
        raise ValueError("fixture_runner is required for extraction corpus evaluation")

    summary_stats = _new_stats()
    source_stats: dict[str, dict[str, Any]] = defaultdict(_new_stats)
    field_stats: dict[str, dict[str, Any]] = defaultdict(_new_stats)
    case_reports: list[dict[str, Any]] = []
    fixture_errors: list[dict[str, str]] = []

    for case in payload["cases"]:
        case_id = str(case["id"])
        source = str(case["source"])
        labels: Mapping[str, Mapping[str, Any]] = case["labels"]
        try:
            sale = fixture_runner(case)
        except Exception as exc:  # pragma: no cover - exercised by integration users
            error = {"case_id": case_id, "error": f"{type(exc).__name__}: {exc}"[:1000]}
            fixture_errors.append(error)
            case_reports.append(
                {
                    "case_id": case_id,
                    "source": source,
                    "status": "fixture_error",
                    "fixture": case.get("fixture"),
                    "error": error["error"],
                }
            )
            continue

        field_reports: dict[str, Any] = {}
        critical_errors: list[dict[str, Any]] = []
        for field, label in labels.items():
            state = str(label["state"])
            actual = project_field(sale, field)
            outcome = classify_outcome(state, label.get("value"), actual)
            result = {
                "state": state,
                "outcome": outcome,
                "expected": label.get("value") if state == "present" else None,
                "actual": json_safe(actual),
            }
            field_reports[field] = result
            _record_outcome(summary_stats, state, outcome)
            _record_outcome(source_stats[source], state, outcome)
            _record_outcome(field_stats[field], state, outcome)
            if field in payload.get("critical_lot_fields", ()) and outcome not in _ACCEPTABLE_OUTCOMES:
                critical_errors.append({"field": field, **result})

        case_reports.append(
            {
                "case_id": case_id,
                "source": source,
                "status": "evaluated",
                "fixture": case.get("fixture"),
                "annotation": case.get("annotation"),
                "critical_lot_error": bool(critical_errors),
                "critical_lot_errors": critical_errors,
                "fields": field_reports,
            }
        )

    report = {
        "evaluator_version": EVALUATOR_VERSION,
        "schema_version": payload["schema_version"],
        "corpus_id": payload.get("corpus_id"),
        "corpus_sha256": hashlib.sha256(corpus_bytes).hexdigest(),
        "evidence_scope": payload.get("evidence_scope", "unspecified"),
        "summary": _finalize_stats(summary_stats),
        "by_source": {key: _finalize_stats(source_stats[key]) for key in sorted(source_stats)},
        "by_field": {key: _finalize_stats(field_stats[key]) for key in sorted(field_stats)},
        "fixture_errors": fixture_errors,
        "cases": case_reports,
    }
    return report


def project_field(sale: Any, field: str) -> Any:
    """Project normal model fields and the small derived fields used by fixtures."""

    # A frozen prediction snapshot already contains projected field values.
    if isinstance(sale, Mapping) and field in sale:
        return sale[field]
    if field == "documents_count":
        return len(getattr(sale, "documents", ()) or ())
    if field == "document_types":
        return [str(document.get("type") or "") for document in (getattr(sale, "documents", ()) or ())]
    if field == "visit_dates_count":
        return len(getattr(sale, "visit_dates", ()) or ())
    if field == "sale_date_date":
        value = getattr(sale, "sale_date", None)
        return value.date().isoformat() if isinstance(value, datetime) else None
    if field == "source_images_count":
        images = _raw_payload(sale).get("source_images")
        return len(images) if isinstance(images, list) else 0
    if field == "source_energy_dpe_class":
        diagnostics = _raw_payload(sale).get("source_energy_diagnostics")
        return diagnostics.get("dpe_class") if isinstance(diagnostics, Mapping) else None
    if field == "source_energy_ges_class":
        diagnostics = _raw_payload(sale).get("source_energy_diagnostics")
        return diagnostics.get("ges_class") if isinstance(diagnostics, Mapping) else None
    if field == "has_source_blocks":
        return bool(_raw_payload(sale).get("source_blocks"))
    if isinstance(sale, Mapping):
        return sale.get(field)
    return getattr(sale, field, None)


def classify_outcome(state: str, expected: Any, actual: Any) -> str:
    """Return a stable state-aware outcome for one field assertion."""

    if state == "present":
        if _is_missing(actual) or _is_unknown(actual):
            return "missing"
        return "match" if values_equal(expected, actual) else "wrong_value"
    if state == "unknown":
        return "preserved" if _is_missing(actual) or _is_unknown(actual) else "filled"
    if state == "absent":
        if _is_missing(actual):
            return "empty"
        if _is_unknown(actual):
            return "unknown_state"
        return "populated"
    return "unannotated"


def values_equal(expected: Any, actual: Any) -> bool:
    """Compare JSON annotations with Decimal/date values without losing precision."""

    if isinstance(expected, (list, tuple)) or isinstance(actual, (list, tuple)):
        if not isinstance(expected, (list, tuple)) or not isinstance(actual, (list, tuple)):
            return False
        return len(expected) == len(actual) and all(values_equal(a, b) for a, b in zip(expected, actual, strict=True))
    if isinstance(expected, bool) or isinstance(actual, bool):
        return expected is actual
    expected_number = _as_decimal(expected)
    actual_number = _as_decimal(actual)
    if expected_number is not None and actual_number is not None:
        return expected_number == actual_number
    if isinstance(expected, (date, datetime)) and isinstance(actual, (date, datetime)):
        return expected.isoformat() == actual.isoformat()
    if expected is None or actual is None:
        return expected is actual
    return str(expected) == str(actual)


def json_safe(value: Any) -> Any:
    """Convert model values to deterministic JSON primitives."""

    if isinstance(value, Decimal):
        return _decimal_text(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def _raw_payload(sale: Any) -> Mapping[str, Any]:
    payload = sale.get("raw_payload", {}) if isinstance(sale, Mapping) else getattr(sale, "raw_payload", {})
    return payload if isinstance(payload, Mapping) else {}


def _is_missing(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == ()


def _is_unknown(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    normalized = " ".join(value.strip().casefold().replace("’", "'").split())
    return normalized in UNKNOWN_MARKERS


def _as_decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        try:
            return Decimal(str(value))
        except InvalidOperation:
            return None
    if isinstance(value, str) and NUMBER_RE.fullmatch(value.strip()):
        try:
            return Decimal(value.strip())
        except InvalidOperation:
            return None
    return None


def _decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _new_stats() -> dict[str, Any]:
    return {
        "annotations": 0,
        "present": 0,
        "unknown": 0,
        "absent": 0,
        "unannotated": 0,
        "match": 0,
        "wrong_value": 0,
        "missing": 0,
        "unknown_preserved": 0,
        "unknown_filled": 0,
        "absent_empty": 0,
        "absent_unknown": 0,
        "absent_populated": 0,
        "true_positive": 0,
        "false_positive": 0,
        "false_negative": 0,
    }


_ACCEPTABLE_OUTCOMES = frozenset({"match", "preserved", "empty", "unknown_state", "unannotated"})


def _record_outcome(stats: dict[str, Any], state: str, outcome: str) -> None:
    stats["annotations"] += state != "unannotated"
    stats[state] += 1
    stats[outcome] = stats.get(outcome, 0) + 1
    if state == "present":
        if outcome == "match":
            stats["true_positive"] += 1
        else:
            stats["false_negative"] += 1
            if outcome == "wrong_value":
                stats["false_positive"] += 1
    elif state == "unknown":
        if outcome == "preserved":
            stats["unknown_preserved"] += 1
        else:
            stats["unknown_filled"] += 1
            stats["false_positive"] += 1
    elif state == "absent":
        if outcome == "empty":
            stats["absent_empty"] += 1
        elif outcome == "unknown_state":
            stats["absent_unknown"] += 1
        else:
            stats["absent_populated"] += 1
            stats["false_positive"] += 1


def _finalize_stats(stats: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(stats)
    positive_denominator = result["true_positive"] + result["false_positive"]
    recall_denominator = result["true_positive"] + result["false_negative"]
    result["precision"] = _ratio(result["true_positive"], positive_denominator)
    result["recall"] = _ratio(result["true_positive"], recall_denominator)
    result["f1"] = _ratio(
        2 * result["precision"] * result["recall"],
        result["precision"] + result["recall"],
    ) if result["precision"] is not None and result["recall"] is not None else None
    return result


def _ratio(numerator: int | float, denominator: int | float) -> float | None:
    if not denominator:
        return None
    return round(float(numerator) / float(denominator), 6)


__all__ = [
    "DEFAULT_CORPUS_PATH",
    "evaluate_corpus",
    "load_corpus",
    "project_field",
    "validate_corpus",
    "values_equal",
]
