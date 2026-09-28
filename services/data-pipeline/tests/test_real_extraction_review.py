from __future__ import annotations

import hashlib
import json
import stat
from pathlib import Path

import pytest

from src.real_extraction_review import evaluate_real_review, prepare_manifest, write_private_json


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
        {"reviewer": "a", "reviewed_at": "2026-09-28T11:00:00Z", "labels": labels},
        {"reviewer": "b", "reviewed_at": "2026-09-28T12:00:00Z", "labels": labels},
    ]
    first["adjudication"] = {
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
        {"reviewer": "same", "reviewed_at": "2026-09-28T11:00:00Z", "labels": label},
        {"reviewer": "same", "reviewed_at": "2026-09-28T12:00:00Z", "labels": label},
    ]
    with pytest.raises(ValueError, match="distinct"):
        evaluate_real_review(manifest, sample)


def test_real_review_requires_evidence_bound_to_capture(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    _capture(first, tmp_path, b"document proof")
    bad_label = {"starting_price_eur": _label("present", "e" * 64, 100000)}
    first["reviews"] = [{"reviewer": "a", "reviewed_at": "2026-09-28T11:00:00Z", "labels": bad_label}]
    with pytest.raises(ValueError, match="frozen capture"):
        evaluate_real_review(manifest, sample)


def test_real_review_rechecks_capture_bytes_and_reviewer_sequence(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    manifest = prepare_manifest(sample)
    first = manifest["cases"][0]
    digest = _capture(first, tmp_path, b"document proof")
    label = {"starting_price_eur": _label("present", digest, 100000)}
    first["reviews"] = [
        {"reviewer": "a", "reviewed_at": "2026-09-28T09:00:00Z", "labels": label},
        {"reviewer": "b", "reviewed_at": "2026-09-28T12:00:00Z", "labels": label},
    ]
    first["adjudication"] = {
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
        {"reviewer": "a", "reviewed_at": "2026-09-28T11:00:00Z", "labels": labels},
        {"reviewer": "b", "reviewed_at": "2026-09-28T12:00:00Z", "labels": labels},
    ]
    first["adjudication"] = {
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
