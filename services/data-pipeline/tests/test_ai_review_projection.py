from __future__ import annotations

import hashlib
from pathlib import Path

from src.ai_review_projection import build_ai_review_projection_rows


def _capture(tmp_path: Path, text: str) -> tuple[str, str]:
    path = tmp_path / "capture.html"
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode()).hexdigest()
    return str(path), digest


def _review(capture_sha256: str, reviewer: str, excerpt: str, *, field: str = "property_type") -> dict:
    labels = {
        field: {
            "state": "present",
            "value": "apartment",
            "evidence": {
                "capture_sha256": capture_sha256,
                "locator": "visible field",
                "excerpt": excerpt,
            },
        }
    }
    return {
        "reviewer": reviewer,
        "labels": labels,
    }


def _manifest(capture_path: str, capture_sha256: str, reviews: list[dict], *, field: str = "property_type") -> dict:
    return {
        "schema_version": "immojudis.real-extraction-review.v2",
        "sample_sha256": "a" * 64,
        "ai_review_expected_fields": [field],
        "cases": [
            {
                "id": "case-1",
                "source": "source_a",
                "source_url": "https://source.example/listing-1",
                "access": {"state": "captured"},
                "capture": {"sha256": capture_sha256, "private_ref": capture_path},
                "ai_reviews": reviews,
            }
        ],
    }


def test_unverified_citation_is_quarantined_even_with_two_pass_consensus(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "not present"), _review(digest, "pass-b", "Appartement")],
    )

    rows = build_ai_review_projection_rows(
        manifest,
        [{"id": "00000000-0000-4000-8000-000000000001", "source_name": "source_a", "source_url": manifest["cases"][0]["source_url"]}],
    )

    row = rows[0]
    assert row["mapping_status"] == "exact"
    assert row["review_state"] == "unverified"
    assert row["citation_status"] == "unverified"
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False


def test_unresolved_adjudication_is_audit_metadata_when_passes_consensus(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Immeuble</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "Immeuble"), _review(digest, "pass-b", "Immeuble")],
    )
    labels = {
        "property_type": {
            "state": "unresolved",
            "reason": "Les deux lectures ne permettent pas de trancher.",
        }
    }
    manifest["cases"][0]["ai_adjudication"] = {"labels": labels}

    row = build_ai_review_projection_rows(
        manifest,
        [{"id": "00000000-0000-4000-8000-000000000001", "source_name": "source_a", "source_url": manifest["cases"][0]["source_url"]}],
    )[0]

    assert row["review_state"] == "resolved"
    assert row["citation_status"] == "verified"
    assert row["value_jsonb"] == "apartment"
    assert row["passes_local_gate"] is True


def test_adjudicator_cannot_override_disagreement(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement maison</body></html>")
    reviews = [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "maison")]
    reviews[1]["labels"]["property_type"]["value"] = "house"
    manifest = _manifest(capture_path, digest, reviews)
    manifest["cases"][0]["ai_adjudication"] = {
        "labels": {
            "property_type": {
                "state": "present",
                "value": "apartment",
                "evidence": {
                    "capture_sha256": digest,
                    "locator": "adjudicator field",
                    "excerpt": "Appartement",
                },
            }
        }
    }

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "unresolved"
    assert row["citation_status"] == "not_required"
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False
    assert "cannot override" in row["block_reason"]


def test_consensus_uses_existing_property_type_normalization(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    reviews = [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "Appartement")]
    reviews[0]["labels"]["property_type"]["value"] = "appartement"
    reviews[1]["labels"]["property_type"]["value"] = "apartment"
    manifest = _manifest(capture_path, digest, reviews)

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "resolved"
    assert row["citation_status"] == "verified"
    assert row["value_jsonb"] == "appartement"
    assert row["passes_local_gate"] is True


def test_adjudicator_disagreement_cannot_change_consensus_value(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement maison</body></html>")
    reviews = [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "Appartement")]
    manifest = _manifest(capture_path, digest, reviews)
    manifest["cases"][0]["ai_adjudication"] = {
        "labels": {
            "property_type": {
                "state": "present",
                "value": "house",
                "evidence": {
                    "capture_sha256": digest,
                    "locator": "adjudicator field",
                    "excerpt": "maison",
                },
            }
        }
    }

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "resolved"
    assert row["citation_status"] == "verified"
    assert row["value_jsonb"] == "apartment"
    assert row["passes_local_gate"] is True


def test_duplicate_reviewer_is_not_independent_consensus(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    reviews = [_review(digest, "same-pass", "Appartement"), _review(digest, "same-pass", "Appartement")]
    manifest = _manifest(capture_path, digest, reviews)

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "unresolved"
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False
    assert "distinct independent" in row["block_reason"]


def test_adjudicator_citation_is_checked_before_projection(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "Appartement")],
    )
    manifest["cases"][0]["ai_adjudication"] = {
        "labels": {
            "property_type": {
                "state": "present",
                "value": "apartment",
                "evidence": {
                    "capture_sha256": "b" * 64,
                    "locator": "adjudicator field",
                    "excerpt": "Appartement",
                },
            }
        }
    }

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "unverified"
    assert row["citation_status"] == "unverified"
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False


def test_unknown_label_does_not_claim_verified_citation(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Le type est illisible</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "Le type est illisible"), _review(digest, "pass-b", "Le type est illisible")],
    )
    for review in manifest["cases"][0]["ai_reviews"]:
        review["labels"]["property_type"] = {
            "state": "unknown",
            "value": None,
            "evidence": {
                "capture_sha256": digest,
                "locator": "visible field",
                "excerpt": "Le type est illisible",
            },
        }

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "unknown"
    assert row["citation_status"] == "not_required"
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False


def test_present_label_without_value_is_quarantined_with_valid_sql_state(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "Appartement")],
    )
    for review in manifest["cases"][0]["ai_reviews"]:
        review["labels"]["property_type"]["value"] = None

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "unresolved"
    assert row["citation_status"] == "not_required"
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False


def test_capture_digest_mismatch_is_unverified(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "Appartement")],
    )
    manifest["cases"][0]["capture"]["sha256"] = "b" * 64

    row = build_ai_review_projection_rows(
        manifest,
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": manifest["cases"][0]["source_url"],
        }],
    )[0]

    assert row["review_state"] == "unverified"
    assert row["citation_status"] == "unverified"
    assert "digest mismatch" in row["block_reason"]
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False


def test_missing_exact_sale_mapping_fails_closed(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "Appartement")],
    )

    row = build_ai_review_projection_rows(manifest, [])[0]

    assert row["mapping_status"] == "unmapped"
    assert row["review_state"] == "unresolved"
    assert row["citation_status"] == "not_required"
    assert row["auction_sale_id"] is None
    assert row["value_jsonb"] is None
    assert row["passes_local_gate"] is False
    assert "unmapped" in row["block_reason"]


def test_duplicate_exact_mapping_is_ambiguous(tmp_path: Path) -> None:
    capture_path, digest = _capture(tmp_path, "<html><body>Appartement</body></html>")
    manifest = _manifest(
        capture_path,
        digest,
        [_review(digest, "pass-a", "Appartement"), _review(digest, "pass-b", "Appartement")],
    )
    url = manifest["cases"][0]["source_url"]
    sales = [
        {"id": "00000000-0000-4000-8000-000000000001", "source_name": "source_a", "source_url": url},
        {"id": "00000000-0000-4000-8000-000000000002", "source_name": "source_a", "source_url": url},
    ]

    row = build_ai_review_projection_rows(manifest, sales)[0]

    assert row["mapping_status"] == "ambiguous"
    assert row["auction_sale_id"] is None
    assert row["passes_local_gate"] is False
