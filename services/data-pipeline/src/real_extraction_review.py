"""Private evaluation of the frozen real-listing sample.

The review manifest can contain personal data and stays outside Git. Only
aggregate counts and rates leave this module; neither evidence nor case-level
values are included in the aggregate report. Human reviews and AI passes use
separate lanes. An AI consensus is never a human accuracy claim.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

from src.extraction_corpus import CORPUS_SCHEMA_VERSION, classify_outcome, evaluate_corpus, values_equal
from src.normalize import normalize_occupancy_status, normalize_property_type

SAMPLE_PATH = Path(__file__).resolve().parents[1] / "config" / "qualification-sample-20260912.json"
LEGACY_REVIEW_SCHEMA_VERSION = "immojudis.real-extraction-review.v1"
REVIEW_SCHEMA_VERSION = "immojudis.real-extraction-review.v2"
SUPPORTED_REVIEW_SCHEMA_VERSIONS = frozenset({LEGACY_REVIEW_SCHEMA_VERSION, REVIEW_SCHEMA_VERSION})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SOURCE_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,39}$")
REVIEW_FIELDS = frozenset(
    {
        "source_url",
        "external_id",
        "property_type",
        "address",
        "city",
        "postal_code",
        "sale_date_date",
        "starting_price_eur",
        "visit_dates_count",
        "habitable_surface_m2",
        "carrez_surface_m2",
        "land_surface_m2",
        "occupancy_status",
        "rooms_count",
        "bedrooms_count",
        "parking_count",
        "source_energy_dpe_class",
        "source_energy_ges_class",
    }
)
ACCESS_STATES = frozenset({"not_attempted", "inaccessible", "capture_failed", "captured"})
ANNOTATION_STATES = frozenset({"present", "unknown", "absent"})
REPORT_STATES = (
    "not_attempted",
    "inaccessible",
    "capture_failed",
    "awaiting_review",
    "awaiting_second_review",
    "awaiting_adjudication",
    "evaluated",
)


def _require_text(value: Any, description: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{description} must be non-empty text")
    return value


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ai_review_output_sha256(labels: Mapping[str, Any]) -> str:
    """Return the canonical digest required for a private AI review output.

    The digest covers only the structured field labels. The raw model response,
    if retained by an operator, must remain in the private review workspace.
    """

    try:
        canonical = json.dumps(labels, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("AI review labels must be JSON serializable") from exc
    return _sha256(canonical.encode("utf-8"))


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _timestamp(value: Any, description: str) -> datetime:
    text = _require_text(value, description)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{description} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{description} must include a timezone")
    return parsed


def load_sample(path: Path = SAMPLE_PATH) -> tuple[list[dict[str, str]], str]:
    """Return the frozen sample and the digest of its exact bytes."""

    data = path.read_bytes()
    rows = json.loads(data)
    if not isinstance(rows, list) or not rows:
        raise ValueError("sample must be a non-empty array")
    seen: set[str] = set()
    seen_urls: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("sample rows must be objects")
        case_id = _require_text(row.get("id"), "sample id")
        source_name = _require_text(row.get("source_name"), "sample source_name")
        source_url = _require_text(row.get("source_url"), "sample source_url")
        if not SOURCE_NAME_RE.fullmatch(source_name):
            raise ValueError("sample source_name must be a bounded source identifier")
        if case_id in seen:
            raise ValueError("sample ids must be unique")
        if source_url in seen_urls:
            raise ValueError("sample URLs must be unique")
        seen.add(case_id)
        seen_urls.add(source_url)
    return rows, _sha256(data)


def prepare_manifest(sample_path: Path = SAMPLE_PATH) -> dict[str, Any]:
    """Create a full review frame with no implied verification or truth labels."""

    rows, sample_sha256 = load_sample(sample_path)
    return {
        "schema_version": REVIEW_SCHEMA_VERSION,
        "sample_sha256": sample_sha256,
        "cases": [
            {
                "id": row["id"],
                "source": row["source_name"],
                "source_url": row["source_url"],
                "access": {"state": "not_attempted", "checked_at": None, "reason": None},
                "capture": None,
                "prediction": None,
                "reviews": [],
                "adjudication": None,
                "ai_reviews": [],
            }
            for row in rows
        ],
    }


def write_private_json(path: Path, payload: Mapping[str, Any]) -> None:
    """Create a private file once, without following an existing symlink."""

    project_root = Path(__file__).resolve().parents[3]
    if path.resolve().is_relative_to(project_root):
        raise ValueError("private review files must be written outside the Git checkout")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2, sort_keys=True)
            file.write("\n")
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _validate_labels(labels: Any, capture_sha256: str, description: str) -> dict[str, dict[str, Any]]:
    if not isinstance(labels, Mapping) or not labels:
        raise ValueError(f"{description} needs at least one field label")
    checked: dict[str, dict[str, Any]] = {}
    for field, label in labels.items():
        if field not in REVIEW_FIELDS or not isinstance(label, Mapping):
            raise ValueError(f"{description} has an unsupported field label")
        state = label.get("state")
        if state not in ANNOTATION_STATES:
            raise ValueError(f"{description} has an unsupported annotation state")
        if state == "present" and ("value" not in label or label["value"] is None):
            raise ValueError(f"{description} present label needs a value")
        if state != "present" and "value" in label:
            raise ValueError(f"{description} non-present label must not have a value")
        evidence = label.get("evidence")
        if not isinstance(evidence, Mapping) or evidence.get("capture_sha256") != capture_sha256:
            raise ValueError(f"{description} evidence must identify the frozen capture")
        _require_text(evidence.get("locator"), f"{description} evidence locator")
        if state in {"present", "unknown"}:
            _require_text(evidence.get("excerpt"), f"{description} evidence excerpt")
        checked[field] = dict(label)
    return checked


def _validate_reviewer(
    review: Any,
    capture_sha256: str,
    description: str,
    *,
    schema_version: str,
) -> dict[str, dict[str, Any]]:
    if not isinstance(review, Mapping):
        raise ValueError(f"{description} must be an object")
    reviewer_type = review.get("reviewer_type")
    if schema_version == LEGACY_REVIEW_SCHEMA_VERSION:
        reviewer_type = reviewer_type or "human"
    if reviewer_type != "human":
        raise ValueError(f"{description} must be a human review; AI passes belong in ai_reviews")
    _require_text(review.get("reviewer"), f"{description} reviewer")
    _timestamp(review.get("reviewed_at"), f"{description} reviewed_at")
    return _validate_labels(review.get("labels"), capture_sha256, description)


def _validate_ai_review(review: Any, capture_sha256: str, description: str) -> dict[str, Any]:
    """Validate one private, capture-bound AI pass without treating it as human review."""

    if not isinstance(review, Mapping):
        raise ValueError(f"{description} must be an object")
    if review.get("reviewer_type") != "ai":
        raise ValueError(f"{description} must declare reviewer_type=ai")
    _require_text(review.get("reviewer"), f"{description} reviewer")
    _require_text(review.get("provider"), f"{description} provider")
    _require_text(review.get("model"), f"{description} model")
    _require_text(review.get("prompt_version"), f"{description} prompt_version")
    prompt_sha256 = review.get("prompt_sha256")
    if not isinstance(prompt_sha256, str) or not SHA256_RE.fullmatch(prompt_sha256):
        raise ValueError(f"{description} prompt_sha256 must be a lowercase SHA-256 digest")
    reviewed_at = _timestamp(review.get("reviewed_at"), f"{description} reviewed_at")
    if review.get("capture_sha256") != capture_sha256:
        raise ValueError(f"{description} capture_sha256 must identify the frozen capture")
    output_sha256 = review.get("output_sha256")
    if not isinstance(output_sha256, str) or not SHA256_RE.fullmatch(output_sha256):
        raise ValueError(f"{description} output_sha256 must be a lowercase SHA-256 digest")
    if review.get("blind_to_prediction") is not True:
        raise ValueError(f"{description} must be blind_to_prediction")
    if review.get("blind_to_other_reviews") is not True:
        raise ValueError(f"{description} must be blind_to_other_reviews")
    expected_fields = review.get("expected_fields")
    if not isinstance(expected_fields, list) or not expected_fields:
        raise ValueError(f"{description} expected_fields must be a non-empty list")
    if (
        any(not isinstance(field, str) or field not in REVIEW_FIELDS for field in expected_fields)
        or len(set(expected_fields)) != len(expected_fields)
    ):
        raise ValueError(f"{description} expected_fields contains an unsupported or duplicate field")
    labels = _validate_labels(review.get("labels"), capture_sha256, description)
    if not set(labels) <= set(expected_fields):
        raise ValueError(f"{description} labels contain a field outside expected_fields")
    if output_sha256 != ai_review_output_sha256(labels):
        raise ValueError(f"{description} output_sha256 does not match canonical labels")
    return {
        "reviewer": str(review["reviewer"]),
        "provider": str(review["provider"]),
        "model": str(review["model"]),
        "prompt_version": str(review["prompt_version"]),
        "prompt_sha256": prompt_sha256,
        "reviewed_at": reviewed_at,
        "capture_sha256": capture_sha256,
        "output_sha256": output_sha256,
        "expected_fields": tuple(expected_fields),
        "labels": labels,
    }


def _captured_case(case: Mapping[str, Any]) -> tuple[dict[str, Any], str, datetime, Path]:
    capture = case.get("capture")
    prediction = case.get("prediction")
    if not isinstance(capture, Mapping) or not isinstance(prediction, Mapping):
        raise ValueError("captured case needs capture and prediction snapshots")
    capture_sha256 = capture.get("sha256")
    if not isinstance(capture_sha256, str) or not SHA256_RE.fullmatch(capture_sha256):
        raise ValueError("capture needs a lowercase SHA-256 digest")
    private_ref = _require_text(capture.get("private_ref"), "capture private_ref")
    capture_path = Path(private_ref)
    project_root = Path(__file__).resolve().parents[3]
    if not capture_path.is_absolute() or capture_path.resolve().is_relative_to(project_root):
        raise ValueError("capture private_ref must be an absolute file path outside Git")
    if not capture_path.is_file() or _file_sha256(capture_path) != capture_sha256:
        raise ValueError("frozen capture file is missing or its SHA-256 differs")
    captured_at = _timestamp(capture.get("captured_at"), "capture captured_at")
    if prediction.get("capture_sha256") != capture_sha256:
        raise ValueError("prediction must refer to the same frozen capture")
    extracted_at = _timestamp(prediction.get("extracted_at"), "prediction extracted_at")
    if extracted_at < captured_at:
        raise ValueError("prediction extraction cannot precede its frozen capture")
    _require_text(prediction.get("pipeline_revision"), "prediction pipeline_revision")
    values = prediction.get("values")
    if not isinstance(values, Mapping):
        raise ValueError("prediction values must be an object")
    return dict(values), capture_sha256, extracted_at, capture_path


def _evidence_text(value: str) -> str:
    text = html.unescape(value)
    text = re.sub(r"<[^>]*>", " ", text)
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip().casefold()


def _compact_stats(stats: Mapping[str, Any]) -> dict[str, Any]:
    present = int(stats["present"])
    return {
        "reviewed_fields": int(stats["annotations"]),
        "present": present,
        "present_correct": int(stats["match"]),
        "present_wrong": int(stats["wrong_value"]),
        "present_missing": int(stats["missing"]),
        "present_exact_rate": round(stats["match"] / present, 6) if present else None,
        "unknown": int(stats["unknown"]),
        "unknown_preserved": int(stats["unknown_preserved"]),
        "unknown_filled": int(stats["unknown_filled"]),
        "absent": int(stats["absent"]),
        "absent_empty": int(stats["absent_empty"]),
        "absent_unknown": int(stats["absent_unknown"]),
        "absent_populated": int(stats["absent_populated"]),
    }


def _new_ai_stats() -> dict[str, Any]:
    return {
        "reviewed_cases": 0,
        "double_reviewed_cases": 0,
        "cases_with_agreement": 0,
        "cases_with_disagreement": 0,
        "field_annotations": 0,
        "fields_expected": 0,
        "fields_omitted": 0,
        "fields_compared": 0,
        "fields_agree": 0,
        "fields_disagree": 0,
        "locator_annotations": 0,
        "excerpt_annotations": 0,
        "verbatim_excerpts_required": 0,
        "verbatim_excerpts_found": 0,
        "pipeline_fields_compared": 0,
        "pipeline_fields_match": 0,
        "pipeline_fields_disagree": 0,
        "needs_review_cases": 0,
        "needs_review_reasons": {
            "incomplete_field_coverage": 0,
            "missing_passes": 0,
            "missing_second_pass": 0,
            "pass_disagreement": 0,
            "pipeline_disagreement": 0,
            "unverified_excerpt": 0,
        },
    }


def _ai_values_equal(field: str, first: Any, second: Any) -> bool:
    """Compare the two declared labels using the catalogue's bounded enums."""

    if field == "property_type":
        left = normalize_property_type(first)
        right = normalize_property_type(second)
        if left not in {"other", "unknown"} and right not in {"other", "unknown"}:
            return left == right
    elif field == "occupancy_status":
        left = normalize_occupancy_status(first)
        right = normalize_occupancy_status(second)
        if left not in {None, "unknown"} and right not in {None, "unknown"}:
            return left == right
    return values_equal(first, second)


def _merge_ai_stats(target: dict[str, Any], source: Mapping[str, Any]) -> None:
    for key in (
        "reviewed_cases",
        "double_reviewed_cases",
        "cases_with_agreement",
        "cases_with_disagreement",
        "field_annotations",
        "fields_expected",
        "fields_omitted",
        "fields_compared",
        "fields_agree",
        "fields_disagree",
        "locator_annotations",
        "excerpt_annotations",
        "verbatim_excerpts_required",
        "verbatim_excerpts_found",
        "pipeline_fields_compared",
        "pipeline_fields_match",
        "pipeline_fields_disagree",
        "needs_review_cases",
    ):
        target[key] += int(source[key])
    for key, value in source["needs_review_reasons"].items():
        target["needs_review_reasons"][key] += int(value)


def _compact_ai_stats(stats: Mapping[str, Any]) -> dict[str, Any]:
    compared_cases = int(stats["cases_with_agreement"]) + int(stats["cases_with_disagreement"])
    fields_compared = int(stats["fields_compared"])
    annotations = int(stats["field_annotations"])
    fields_expected = int(stats["fields_expected"])
    fields_omitted = int(stats["fields_omitted"])
    locator_annotations = int(stats["locator_annotations"])
    excerpt_annotations = int(stats["excerpt_annotations"])
    pipeline_fields_compared = int(stats["pipeline_fields_compared"])
    return {
        "reviewed_cases": int(stats["reviewed_cases"]),
        "double_reviewed_cases": int(stats["double_reviewed_cases"]),
        "cases_with_agreement": int(stats["cases_with_agreement"]),
        "cases_with_disagreement": int(stats["cases_with_disagreement"]),
        "case_agreement_rate": round(stats["cases_with_agreement"] / compared_cases, 6)
        if compared_cases
        else None,
        "field_annotations": annotations,
        "field_coverage": {
            "fields_expected": fields_expected,
            "fields_annotated": annotations,
            "fields_omitted": fields_omitted,
            "complete": fields_omitted == 0,
            "coverage_rate": round(annotations / fields_expected, 6) if fields_expected else None,
        },
        "fields_compared": fields_compared,
        "fields_agree": int(stats["fields_agree"]),
        "fields_disagree": int(stats["fields_disagree"]),
        "field_agreement_rate": round(stats["fields_agree"] / fields_compared, 6)
        if fields_compared
        else None,
        "evidence_coverage": {
            "annotations": annotations,
            "with_locator": locator_annotations,
            "with_excerpt": excerpt_annotations,
            "locator_rate": round(locator_annotations / annotations, 6) if annotations else None,
            "excerpt_rate": round(excerpt_annotations / annotations, 6) if annotations else None,
            "verbatim_required": int(stats["verbatim_excerpts_required"]),
            "verbatim_found": int(stats["verbatim_excerpts_found"]),
            "verbatim_rate": round(
                stats["verbatim_excerpts_found"] / stats["verbatim_excerpts_required"], 6
            ) if stats["verbatim_excerpts_required"] else None,
        },
        "pipeline_comparison": {
            "fields_compared": pipeline_fields_compared,
            "fields_match": int(stats["pipeline_fields_match"]),
            "fields_disagree": int(stats["pipeline_fields_disagree"]),
            "agreement_rate": round(stats["pipeline_fields_match"] / pipeline_fields_compared, 6)
            if pipeline_fields_compared
            else None,
        },
        "needs_review_cases": int(stats["needs_review_cases"]),
        "needs_review_reasons": {
            key: int(value) for key, value in sorted(stats["needs_review_reasons"].items()) if value
        },
    }


def _ai_case_stats(
    ai_reviews: list[dict[str, Any]], values: Mapping[str, Any], capture_path: Path
) -> dict[str, Any]:
    """Compare AI passes privately and return counters without case-level data."""

    stats = _new_ai_stats()
    stats["reviewed_cases"] = int(bool(ai_reviews))
    stats["double_reviewed_cases"] = int(len(ai_reviews) == 2)
    capture_text = _evidence_text(capture_path.read_text(encoding="utf-8", errors="replace")) if ai_reviews else ""
    unverified_excerpt = False
    for review in ai_reviews:
        labels = review["labels"]
        stats["field_annotations"] += len(labels)
        expected_fields = set(review["expected_fields"])
        stats["fields_expected"] += len(expected_fields)
        stats["fields_omitted"] += len(expected_fields - set(labels))
        stats["locator_annotations"] += sum(
            isinstance(label.get("evidence"), Mapping) and bool(label["evidence"].get("locator"))
            for label in labels.values()
        )
        stats["excerpt_annotations"] += sum(
            isinstance(label.get("evidence"), Mapping) and bool(label["evidence"].get("excerpt"))
            for label in labels.values()
        )
        for label in labels.values():
            if label["state"] not in {"present", "unknown"}:
                continue
            stats["verbatim_excerpts_required"] += 1
            excerpt = _evidence_text(str(label["evidence"]["excerpt"]))
            if len(excerpt) >= 2 and excerpt in capture_text:
                stats["verbatim_excerpts_found"] += 1
            else:
                unverified_excerpt = True

    reasons: set[str] = set()
    if not ai_reviews:
        reasons.add("missing_passes")
    elif len(ai_reviews) == 1:
        reasons.add("missing_second_pass")
    if stats["fields_omitted"]:
        reasons.add("incomplete_field_coverage")
    if unverified_excerpt:
        reasons.add("unverified_excerpt")

    if len(ai_reviews) == 2:
        first_labels = ai_reviews[0]["labels"]
        second_labels = ai_reviews[1]["labels"]
        fields = set(first_labels) | set(second_labels)
        stats["fields_compared"] = len(fields)
        for field in fields:
            first = first_labels.get(field)
            second = second_labels.get(field)
            equal = (
                first is not None
                and second is not None
                and first.get("state") == second.get("state")
                and (
                    first.get("state") != "present"
                    or _ai_values_equal(field, first.get("value"), second.get("value"))
                )
            )
            stats["fields_agree" if equal else "fields_disagree"] += 1
        if stats["fields_disagree"]:
            stats["cases_with_disagreement"] = 1
            reasons.add("pass_disagreement")
        else:
            stats["cases_with_agreement"] = 1

        # Only fields on which both blind passes agree are compared with the
        # pipeline prediction. This keeps a disagreement from becoming an
        # implicit adjudication.
        for field in set(first_labels) & set(second_labels):
            first = first_labels[field]
            second = second_labels[field]
            if first.get("state") != second.get("state"):
                continue
            if first.get("state") == "present" and not _ai_values_equal(field, first.get("value"), second.get("value")):
                continue
            outcome = classify_outcome(first["state"], first.get("value"), values.get(field))
            if outcome == "wrong_value" and _ai_values_equal(field, first.get("value"), values.get(field)):
                outcome = "match"
            stats["pipeline_fields_compared"] += 1
            if outcome in {"match", "preserved", "empty", "unknown_state", "unannotated"}:
                stats["pipeline_fields_match"] += 1
            else:
                stats["pipeline_fields_disagree"] += 1
        if stats["pipeline_fields_disagree"]:
            reasons.add("pipeline_disagreement")

    if reasons:
        stats["needs_review_cases"] = 1
        for reason in reasons:
            stats["needs_review_reasons"][reason] += 1
    return stats


def evaluate_real_review(manifest: Mapping[str, Any], sample_path: Path = SAMPLE_PATH) -> dict[str, Any]:
    """Validate the complete frame and return only aggregate, source-backed counts."""

    sample, sample_sha256 = load_sample(sample_path)
    if (
        manifest.get("schema_version") not in SUPPORTED_REVIEW_SCHEMA_VERSIONS
        or manifest.get("sample_sha256") != sample_sha256
    ):
        raise ValueError("review manifest schema or frozen sample digest mismatch")
    manifest_schema_version = str(manifest["schema_version"])
    cases = manifest.get("cases")
    if not isinstance(cases, list) or len(cases) != len(sample):
        raise ValueError("review manifest must contain every frozen sample case exactly once")
    expected = {row["id"]: row for row in sample}
    seen: set[str] = set()
    coverage: Counter[str] = Counter()
    source_coverage: dict[str, Counter[str]] = defaultdict(Counter)
    ready: list[dict[str, Any]] = []
    source_identity_annotated = 0
    field_coverage: Counter[str] = Counter()
    source_field_coverage: dict[str, Counter[str]] = defaultdict(Counter)
    captured_cases = 0
    reviewed_cases = 0
    double_reviewed_cases = 0
    ai_stats = _new_ai_stats()
    source_ai_stats: dict[str, dict[str, Any]] = defaultdict(_new_ai_stats)
    for row in sample:
        source_ai_stats[row["source_name"]]

    for case in cases:
        if not isinstance(case, Mapping):
            raise ValueError("review cases must be objects")
        case_id = case.get("id")
        if not isinstance(case_id, str) or case_id not in expected or case_id in seen:
            raise ValueError("review case id is duplicated or outside the frozen sample")
        seen.add(case_id)
        row = expected[case_id]
        if case.get("source") != row["source_name"] or case.get("source_url") != row["source_url"]:
            raise ValueError("review case source differs from the frozen sample")
        source = row["source_name"]
        access = case.get("access")
        if not isinstance(access, Mapping) or access.get("state") not in ACCESS_STATES:
            raise ValueError("review case has an unsupported access state")
        state = access["state"]
        if state == "not_attempted":
            if (
                case.get("capture") is not None
                or case.get("prediction") is not None
                or case.get("reviews")
                or case.get("adjudication")
                or case.get("ai_reviews")
            ):
                raise ValueError("not_attempted case contains review data")
            report_state = state
        elif state in {"inaccessible", "capture_failed"}:
            _timestamp(access.get("checked_at"), "failed access checked_at")
            _require_text(access.get("reason"), "failed access reason")
            if (
                case.get("capture") is not None
                or case.get("prediction") is not None
                or case.get("reviews")
                or case.get("adjudication")
                or case.get("ai_reviews")
            ):
                raise ValueError("failed access case contains review data")
            report_state = state
        else:
            _timestamp(access.get("checked_at"), "captured access checked_at")
            values, capture_sha256, extracted_at, capture_path = _captured_case(case)
            captured_cases += 1
            reviews = case.get("reviews")
            if not isinstance(reviews, list) or len(reviews) > 2:
                raise ValueError("captured case accepts up to two independent reviews")
            review_labels = [
                _validate_reviewer(
                    review,
                    capture_sha256,
                    "independent review",
                    schema_version=manifest_schema_version,
                )
                for review in reviews
            ]
            review_times = [
                _timestamp(review["reviewed_at"], "independent review reviewed_at")
                for review in reviews
            ]
            if any(reviewed_at < extracted_at for reviewed_at in review_times):
                raise ValueError("independent review cannot precede the frozen prediction")
            if len(reviews) == 2 and reviews[0]["reviewer"] == reviews[1]["reviewer"]:
                raise ValueError("independent reviewers must be distinct")
            if reviews:
                reviewed_cases += 1
            if len(reviews) == 2:
                double_reviewed_cases += 1
            adjudication = case.get("adjudication")
            if len(reviews) < 2 and adjudication is not None:
                raise ValueError("adjudication requires two independent reviews")
            if len(reviews) == 0:
                report_state = "awaiting_review"
            elif len(reviews) == 1:
                report_state = "awaiting_second_review"
            elif adjudication is None:
                report_state = "awaiting_adjudication"
            else:
                final_labels = _validate_reviewer(
                    adjudication,
                    capture_sha256,
                    "adjudication",
                    schema_version=manifest_schema_version,
                )
                if adjudication["reviewer"] in {review["reviewer"] for review in reviews}:
                    raise ValueError("adjudicator must be distinct from both independent reviewers")
                if _timestamp(adjudication["reviewed_at"], "adjudication reviewed_at") < max(review_times):
                    raise ValueError("adjudication cannot precede independent reviews")
                if any(set(labels) != set(final_labels) for labels in review_labels):
                    raise ValueError("both reviewers and adjudication must cover identical fields")
                if {"source_url", "external_id"} <= set(final_labels):
                    source_identity_annotated += 1
                for field in final_labels:
                    field_coverage[field] += 1
                    source_field_coverage[source][field] += 1
                ready.append(
                    {
                        "id": case_id,
                        "source": source,
                        "labels": {
                            field: {key: label[key] for key in ("state", "value") if key in label}
                            for field, label in final_labels.items()
                        },
                        "prediction_values": values,
                    }
                )
                report_state = "evaluated"
            ai_reviews_payload = case.get("ai_reviews", [])
            if not isinstance(ai_reviews_payload, list) or len(ai_reviews_payload) > 2:
                raise ValueError("captured case accepts up to two independent AI reviews")
            ai_reviews = [
                _validate_ai_review(review, capture_sha256, "AI review") for review in ai_reviews_payload
            ]
            ai_review_times = [review["reviewed_at"] for review in ai_reviews]
            captured_at = _timestamp(case["capture"]["captured_at"], "capture captured_at")
            if any(reviewed_at < captured_at for reviewed_at in ai_review_times):
                raise ValueError("AI review cannot precede the frozen capture")
            if len(ai_reviews) == 2 and ai_reviews[0]["reviewer"] == ai_reviews[1]["reviewer"]:
                raise ValueError("independent AI reviewers must be distinct")
            case_ai_stats = _ai_case_stats(ai_reviews, values, capture_path)
            _merge_ai_stats(ai_stats, case_ai_stats)
            _merge_ai_stats(source_ai_stats[source], case_ai_stats)
        coverage[report_state] += 1
        source_coverage[source][report_state] += 1

    if seen != set(expected):
        raise ValueError("review manifest is missing frozen sample cases")
    evaluated = None
    if ready:
        corpus = {
            "schema_version": CORPUS_SCHEMA_VERSION,
            "evidence_scope": "locally_verified_captures_with_declared_human_double_review",
            "critical_lot_fields": ["source_url", "external_id"],
            "cases": ready,
        }
        evaluated = evaluate_corpus(corpus, lambda case: case["prediction_values"])
    human_evidence_scope = (
        "locally_verified_captures_with_declared_human_double_review"
        if ready
        else "locally_verified_captures_without_human_adjudication"
    )
    empty_stats = {
        "annotations": 0,
        "present": 0,
        "match": 0,
        "wrong_value": 0,
        "missing": 0,
        "unknown": 0,
        "unknown_preserved": 0,
        "unknown_filled": 0,
        "absent": 0,
        "absent_empty": 0,
        "absent_unknown": 0,
        "absent_populated": 0,
    }
    return {
        "schema_version": "immojudis.real-extraction-aggregate.v2",
        "evidence_scope": human_evidence_scope,
        "human_accuracy_claim": None if not ready else "human_double_reviewed_fields_only",
        "sample_sha256": sample_sha256,
        "frame_cases": len(sample),
        "coverage": {state: coverage[state] for state in REPORT_STATES},
        "by_source": {
            source: {
                "frame_cases": sum(source_coverage[source].values()),
                "coverage": {state: source_coverage[source][state] for state in REPORT_STATES},
                "readiness": {
                    "captured_cases": sum(
                        source_coverage[source][state] for state in
                        ("awaiting_review", "awaiting_second_review", "awaiting_adjudication", "evaluated")
                    ),
                    "reviewed_cases": source_coverage[source]["awaiting_second_review"]
                    + source_coverage[source]["awaiting_adjudication"]
                    + source_coverage[source]["evaluated"],
                    "double_reviewed_cases": source_coverage[source]["awaiting_adjudication"]
                    + source_coverage[source]["evaluated"],
                    "adjudicated_cases": source_coverage[source]["evaluated"],
                    "field_annotations": sum(source_field_coverage[source].values()),
                    "fields": {
                        field: source_field_coverage[source][field]
                        for field in sorted(source_field_coverage[source])
                    },
                },
                "quality": _compact_stats((evaluated or {}).get("by_source", {}).get(source, empty_stats)),
            }
            for source in sorted(source_coverage)
        },
        "quality": _compact_stats(evaluated["summary"] if evaluated else empty_stats),
        "by_field": {
            field: _compact_stats(stats) for field, stats in (evaluated or {}).get("by_field", {}).items()
        },
        "readiness": {
            "captured_cases": captured_cases,
            "reviewed_cases": reviewed_cases,
            "double_reviewed_cases": double_reviewed_cases,
            "adjudicated_cases": len(ready),
            "field_annotations": sum(field_coverage.values()),
            "fields": {field: field_coverage[field] for field in sorted(field_coverage)},
        },
        "ai_review": {
            "policy": "ai_consensus_only",
            "accuracy_claim": "not_estimated",
            "aggregate": _compact_ai_stats(ai_stats),
            "by_source": {
                source: _compact_ai_stats(source_ai_stats[source]) for source in sorted(source_ai_stats)
            },
        },
        "source_identity_cases_annotated": source_identity_annotated,
        "source_identity_cases_verified": sum(
            all(case["fields"][field]["outcome"] == "match" for field in ("source_url", "external_id"))
            for case in evaluated["cases"]
            if {"source_url", "external_id"} <= set(case["fields"])
        ) if evaluated else 0,
        "source_identity_error_cases": sum(case["critical_lot_error"] for case in evaluated["cases"]) if evaluated else 0,
    }


__all__ = [
    "REVIEW_FIELDS",
    "REVIEW_SCHEMA_VERSION",
    "SAMPLE_PATH",
    "ai_review_output_sha256",
    "evaluate_real_review",
    "prepare_manifest",
    "write_private_json",
]
