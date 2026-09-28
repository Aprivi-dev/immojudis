from __future__ import annotations

import hashlib
import json
import stat
from pathlib import Path

import pytest

from src.real_extraction_review import (
    ai_review_output_sha256,
    evaluate_real_review,
    prepare_manifest,
    write_private_json,
)


def _sample(tmp_path: Path) -> Path:
    path = tmp_path / "sample.json"
    path.write_text(
        json.dumps(
            [
                {"id": "one", "source_name": "source-a", "source_url": "https://example.test/private-name"},
                {"id": "two", "source_name": "source-a", "source_url": "https://example.test/two"},
                {"id": "three", "source_name": "source-b", "source_url": "https://example.test/three"},
            ]
        ),
        encoding="utf-8",
    )
    return path


def _label(state: str, capture_sha256: str, value: object = None) -> dict:
    label = {
        "state": state,
        "evidence": {
            "capture_sha256": capture_sha256,
            "locator": "page 1, paragraphe 2",
            "excerpt": "extrait de contrôle privé",
        },
    }
    if state == "present":
        label["value"] = value
    return label


def _capture(case: dict, tmp_path: Path, content: bytes) -> str:
    path = tmp_path / f"capture-{case['id']}.bin"
    content += "\nextrait de contrôle privé".encode()
    path.write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    case["access"] = {"state": "captured", "checked_at": "2026-09-28T10:00:00Z", "reason": None}
    case["capture"] = {
        "sha256": digest,
        "captured_at": "2026-09-28T10:00:00Z",
        "private_ref": str(path),
    }
    case["prediction"] = {
        "capture_sha256": digest,
        "extracted_at": "2026-09-28T10:01:00Z",
        "pipeline_revision": "test-revision",
        "values": {
            "source_url": case["source_url"],
            "external_id": "lot-1",
            "starting_price_eur": 100000,
            "rooms_count": 2,
            "occupancy_status": "unknown",
            "parking_count": 1,
        },
    }
    return digest


def _ai_review(
    labels: dict,
    capture_sha256: str,
    *,
    reviewer: str = "codex-pass-a",
    reviewed_at: str = "2026-09-28T11:00:00Z",
    expected_fields: list[str] | None = None,
) -> dict:
    return {
        "reviewer_type": "ai",
        "reviewer": reviewer,
        "provider": "codex",
        "model": "test-model",
        "prompt_version": "real-source-ai-review-v1",
        "prompt_sha256": "a" * 64,
        "reviewed_at": reviewed_at,
        "capture_sha256": capture_sha256,
        "output_sha256": ai_review_output_sha256(labels),
        "blind_to_prediction": True,
        "blind_to_other_reviews": True,
        "expected_fields": expected_fields or sorted(labels),
        "labels": labels,
    }


def _human_review(reviewer: str, reviewed_at: str, labels: dict) -> dict:
    return {
        "reviewer_type": "human",
        "reviewer": reviewer,
        "reviewed_at": reviewed_at,
        "labels": labels,
    }


def test_real_review_separates_coverage_from_accuracy_and_returns_aggregates_only(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first, second, third = manifest["cases"]
    digest = _capture(first, tmp_path, b"private-name capture")
    labels = {
        "source_url": _label("present", digest, first["source_url"]),
        "external_id": _label("present", digest, "lot-1"),
        "starting_price_eur": _label("present", digest, 100000),
        "rooms_count": _label("present", digest, 3),
        "occupancy_status": _label("unknown", digest),
        "parking_count": _label("absent", digest),
    }
    first["reviews"] = [
        _human_review("a", "2026-09-28T11:00:00Z", labels),
        _human_review("b", "2026-09-28T12:00:00Z", labels),
    ]
    first["adjudication"] = {
        "reviewer_type": "human",
        "reviewer": "arbiter",
        "reviewed_at": "2026-09-28T13:00:00Z",
        "labels": labels,
    }
    second["access"] = {
        "state": "inaccessible",
        "checked_at": "2026-09-28T10:00:00Z",
        "reason": "HTTP 403",
    }
    _capture(third, tmp_path, b"third capture")

    report = evaluate_real_review(manifest, sample)

    assert report["frame_cases"] == 3
    assert report["coverage"]["evaluated"] == 1
    assert report["coverage"]["inaccessible"] == 1
    assert report["coverage"]["awaiting_review"] == 1
    assert report["by_source"]["source-a"]["frame_cases"] == 2
    assert report["quality"]["present"] == 4
    assert report["quality"]["present_correct"] == 3
    assert report["quality"]["present_wrong"] == 1
    assert report["quality"]["absent_populated"] == 1
    assert report["quality"]["unknown_preserved"] == 1
    assert report["source_identity_cases_annotated"] == 1
    assert report["source_identity_cases_verified"] == 1
    assert report["source_identity_error_cases"] == 0
    assert report["readiness"] == {
        "captured_cases": 2,
        "reviewed_cases": 1,
        "double_reviewed_cases": 1,
        "adjudicated_cases": 1,
        "field_annotations": 6,
        "fields": {
            "external_id": 1,
            "occupancy_status": 1,
            "parking_count": 1,
            "rooms_count": 1,
            "source_url": 1,
            "starting_price_eur": 1,
        },
    }
    assert report["by_source"]["source-a"]["readiness"] == {
        "captured_cases": 1,
        "reviewed_cases": 1,
        "double_reviewed_cases": 1,
        "adjudicated_cases": 1,
        "field_annotations": 6,
        "fields": {
            "external_id": 1,
            "occupancy_status": 1,
            "parking_count": 1,
            "rooms_count": 1,
            "source_url": 1,
            "starting_price_eur": 1,
        },
    }
    encoded = json.dumps(report)
    assert "private-name" not in encoded
    assert "lot-1" not in encoded
    assert "extrait de contrôle" not in encoded
    assert "cases" not in report


def test_real_review_rejects_stale_sample_and_non_independent_reviewers(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    changed = json.loads(sample.read_text(encoding="utf-8"))
    changed[0]["source_url"] = "https://example.test/changed"
    sample.write_text(json.dumps(changed), encoding="utf-8")
    with pytest.raises(ValueError, match="digest mismatch"):
        evaluate_real_review(manifest, sample)

    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"another private capture")
    label = {"starting_price_eur": _label("present", digest, 100000)}
    first["reviews"] = [
        _human_review("same", "2026-09-28T11:00:00Z", label),
        _human_review("same", "2026-09-28T12:00:00Z", label),
    ]
    with pytest.raises(ValueError, match="distinct"):
        evaluate_real_review(manifest, sample)


def test_real_review_requires_evidence_bound_to_capture(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    _capture(first, tmp_path, b"document proof")
    bad_label = {"starting_price_eur": _label("present", "e" * 64, 100000)}
    first["reviews"] = [_human_review("a", "2026-09-28T11:00:00Z", bad_label)]
    with pytest.raises(ValueError, match="frozen capture"):
        evaluate_real_review(manifest, sample)


def test_real_review_rechecks_capture_bytes_and_reviewer_sequence(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"document proof")
    label = {"starting_price_eur": _label("present", digest, 100000)}
    first["reviews"] = [
        _human_review("a", "2026-09-28T09:00:00Z", label),
        _human_review("b", "2026-09-28T12:00:00Z", label),
    ]
    first["adjudication"] = {
        "reviewer_type": "human",
        "reviewer": "arbiter",
        "reviewed_at": "2026-09-28T13:00:00Z",
        "labels": label,
    }
    with pytest.raises(ValueError, match="cannot precede"):
        evaluate_real_review(manifest, sample)

    first["reviews"][0]["reviewed_at"] = "2026-09-28T11:00:00Z"
    first["adjudication"]["reviewer"] = "a"
    with pytest.raises(ValueError, match="distinct"):
        evaluate_real_review(manifest, sample)

    first["adjudication"]["reviewer"] = "arbiter"
    Path(first["capture"]["private_ref"]).write_bytes(b"tampered")
    with pytest.raises(ValueError, match="SHA-256 differs"):
        evaluate_real_review(manifest, sample)


def test_unknown_identity_labels_do_not_count_as_verified(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"identity capture")
    labels = {
        "source_url": _label("unknown", digest),
        "external_id": _label("unknown", digest),
    }
    first["reviews"] = [
        _human_review("a", "2026-09-28T11:00:00Z", labels),
        _human_review("b", "2026-09-28T12:00:00Z", labels),
    ]
    first["adjudication"] = {
        "reviewer_type": "human",
        "reviewer": "arbiter",
        "reviewed_at": "2026-09-28T13:00:00Z",
        "labels": labels,
    }

    report = evaluate_real_review(manifest, sample)

    assert report["source_identity_cases_annotated"] == 1
    assert report["source_identity_cases_verified"] == 0
    assert report["source_identity_error_cases"] == 1


def test_real_review_rejects_duplicate_urls_and_sensitive_source_names(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    rows = json.loads(sample.read_text(encoding="utf-8"))
    rows[1]["source_url"] = rows[0]["source_url"]
    sample.write_text(json.dumps(rows), encoding="utf-8")
    with pytest.raises(ValueError, match="URLs must be unique"):
        prepare_manifest(sample)

    rows[1]["source_url"] = "https://example.test/unique"
    rows[1]["source_name"] = "person@example.com"
    sample.write_text(json.dumps(rows), encoding="utf-8")
    with pytest.raises(ValueError, match="source identifier"):
        prepare_manifest(sample)


def test_review_manifest_is_private_and_cannot_be_overwritten(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    target = tmp_path / "private" / "review.json"
    write_private_json(target, prepare_manifest(sample))

    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert json.loads(target.read_text(encoding="utf-8"))["cases"][0]["access"]["state"] == "not_attempted"
    with pytest.raises(FileExistsError):
        write_private_json(target, {"other": "content"})


def test_ai_reviews_are_separate_from_human_accuracy_and_return_private_aggregates(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"AI review capture")
    pass_a = {
        "source_url": _label("present", digest, first["source_url"]),
        "external_id": _label("present", digest, "lot-1"),
        "rooms_count": _label("present", digest, 2),
    }
    pass_b = {
        "source_url": _label("present", digest, first["source_url"]),
        "external_id": _label("present", digest, "lot-1"),
        "rooms_count": _label("present", digest, 3),
    }
    first["ai_reviews"] = [
        _ai_review(pass_a, digest),
        _ai_review(pass_b, digest, reviewer="codex-pass-b", reviewed_at="2026-09-28T12:00:00Z"),
    ]

    report = evaluate_real_review(manifest, sample)

    assert report["human_accuracy_claim"] is None
    assert report["readiness"]["reviewed_cases"] == 0
    assert report["readiness"]["double_reviewed_cases"] == 0
    assert report["readiness"]["adjudicated_cases"] == 0
    assert report["quality"]["present"] == 0
    ai = report["ai_review"]["aggregate"]
    assert report["ai_review"]["policy"] == "ai_consensus_only"
    assert report["ai_review"]["accuracy_claim"] == "not_estimated"
    assert ai["reviewed_cases"] == 1
    assert ai["double_reviewed_cases"] == 1
    assert ai["cases_with_agreement"] == 0
    assert ai["cases_with_disagreement"] == 1
    assert ai["fields_compared"] == 3
    assert ai["fields_agree"] == 2
    assert ai["fields_disagree"] == 1
    assert ai["evidence_coverage"] == {
        "annotations": 6,
        "with_locator": 6,
        "with_excerpt": 6,
        "locator_rate": 1.0,
        "excerpt_rate": 1.0,
        "verbatim_required": 6,
        "verbatim_found": 6,
        "verbatim_rate": 1.0,
    }
    assert ai["needs_review_cases"] == 1
    assert ai["needs_review_reasons"] == {"pass_disagreement": 1}
    encoded = json.dumps(report)
    assert "private-name" not in encoded
    assert "lot-1" not in encoded
    assert "extrait de contrôle" not in encoded
    assert "cases" not in report["ai_review"]


def test_ai_review_compares_french_source_labels_with_catalogue_enums(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"French catalogue labels")
    first["prediction"]["values"].update(
        {"property_type": "apartment", "occupancy_status": "rented"}
    )
    pass_a = {
        "property_type": _label("present", digest, "Appartement"),
        "occupancy_status": _label("present", digest, "loué depuis septembre"),
    }
    pass_b = {
        "property_type": _label("present", digest, "apartment"),
        "occupancy_status": _label("present", digest, "rented"),
    }
    first["ai_reviews"] = [
        _ai_review(pass_a, digest),
        _ai_review(pass_b, digest, reviewer="codex-pass-b"),
    ]

    ai = evaluate_real_review(manifest, sample)["ai_review"]["aggregate"]
    assert ai["fields_agree"] == 2
    assert ai["fields_disagree"] == 0
    assert ai["pipeline_comparison"]["fields_match"] == 2


def test_blind_ai_review_may_precede_replay_prediction_on_same_capture(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"frozen source before parser replay")
    first["prediction"]["extracted_at"] = "2026-09-28T13:00:00Z"
    labels = {"starting_price_eur": _label("present", digest, 100000)}
    first["ai_reviews"] = [_ai_review(labels, digest, reviewed_at="2026-09-28T11:00:00Z")]

    report = evaluate_real_review(manifest, sample)
    assert report["ai_review"]["aggregate"]["reviewed_cases"] == 1

    first["ai_reviews"][0]["reviewed_at"] = "2026-09-28T09:00:00Z"
    with pytest.raises(ValueError, match="cannot precede the frozen capture"):
        evaluate_real_review(manifest, sample)


def test_ai_review_flags_a_paraphrase_as_unverified_evidence(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"mise a prix 100000 euros")
    labels = {"starting_price_eur": _label("present", digest, 100000)}
    labels["starting_price_eur"]["evidence"]["excerpt"] = "prix de départ 100000 euros"
    first["ai_reviews"] = [
        _ai_review(labels, digest),
        _ai_review(labels, digest, reviewer="codex-pass-b"),
    ]

    ai = evaluate_real_review(manifest, sample)["ai_review"]["aggregate"]
    assert ai["evidence_coverage"]["verbatim_required"] == 2
    assert ai["evidence_coverage"]["verbatim_found"] == 0
    assert ai["needs_review_reasons"] == {"unverified_excerpt": 1}


def test_ai_review_requires_capture_bound_metadata_and_valid_output_digest(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"metadata capture")
    labels = {"starting_price_eur": _label("present", digest, 100000)}
    review = _ai_review(labels, digest)
    review["capture_sha256"] = "e" * 64
    first["ai_reviews"] = [review]
    with pytest.raises(ValueError, match="capture_sha256"):
        evaluate_real_review(manifest, sample)

    review = _ai_review(labels, digest)
    review["output_sha256"] = "e" * 64
    first["ai_reviews"] = [review]
    with pytest.raises(ValueError, match="output_sha256 does not match"):
        evaluate_real_review(manifest, sample)

    review = _ai_review(labels, digest)
    review["blind_to_prediction"] = False
    first["ai_reviews"] = [review]
    with pytest.raises(ValueError, match="blind_to_prediction"):
        evaluate_real_review(manifest, sample)

    review = _ai_review(labels, digest)
    review["prompt_sha256"] = "not-a-sha"
    first["ai_reviews"] = [review]
    with pytest.raises(ValueError, match="prompt_sha256"):
        evaluate_real_review(manifest, sample)


def test_ai_reviews_cannot_be_inserted_into_human_review_lane(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"lane separation capture")
    labels = {"starting_price_eur": _label("present", digest, 100000)}
    human_lane_payload = _ai_review(labels, digest)
    first["reviews"] = [human_lane_payload]
    with pytest.raises(ValueError, match="AI passes belong in ai_reviews"):
        evaluate_real_review(manifest, sample)


def test_v2_human_review_requires_explicit_reviewer_type(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"explicit human lane")
    labels = {"starting_price_eur": _label("present", digest, 100000)}
    first["reviews"] = [{"reviewer": "human-a", "reviewed_at": "2026-09-28T11:00:00Z", "labels": labels}]

    with pytest.raises(ValueError, match="must be a human review"):
        evaluate_real_review(manifest, sample)


def test_v1_human_review_without_reviewer_type_remains_compatible(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    manifest["schema_version"] = "immojudis.real-extraction-review.v1"
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"legacy human lane")
    labels = {"starting_price_eur": _label("present", digest, 100000)}
    first["reviews"] = [{"reviewer": "human-a", "reviewed_at": "2026-09-28T11:00:00Z", "labels": labels}]
    first["reviews"].append(
        {"reviewer": "human-b", "reviewed_at": "2026-09-28T12:00:00Z", "labels": labels}
    )
    first["adjudication"] = {"reviewer": "arbiter", "reviewed_at": "2026-09-28T13:00:00Z", "labels": labels}

    report = evaluate_real_review(manifest, sample)

    assert report["readiness"]["adjudicated_cases"] == 1
    assert report["human_accuracy_claim"] == "human_double_reviewed_fields_only"


def test_ai_review_reports_unreviewed_captured_case_as_needing_review(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    _capture(first, tmp_path, b"not yet AI reviewed")

    report = evaluate_real_review(manifest, sample)

    ai = report["ai_review"]["aggregate"]
    assert ai["reviewed_cases"] == 0
    assert ai["needs_review_cases"] == 1
    assert ai["needs_review_reasons"] == {"missing_passes": 1}
    assert report["readiness"]["reviewed_cases"] == 0


def test_ai_review_reports_omitted_expected_fields_as_incomplete_coverage(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"partial AI review")
    labels = {"starting_price_eur": _label("present", digest, 100000)}
    first["ai_reviews"] = [
        _ai_review(
            labels,
            digest,
            expected_fields=["starting_price_eur", "rooms_count"],
        )
    ]

    report = evaluate_real_review(manifest, sample)

    ai = report["ai_review"]["aggregate"]
    assert ai["field_coverage"] == {
        "fields_expected": 2,
        "fields_annotated": 1,
        "fields_omitted": 1,
        "complete": False,
        "coverage_rate": 0.5,
    }
    assert ai["needs_review_cases"] == 1
    assert ai["needs_review_reasons"] == {
        "incomplete_field_coverage": 1,
        "missing_second_pass": 1,
    }
