from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from src.ai_review_import import (
    APPROVED_MANIFEST_SHA256S,
    EXPECTED_MANIFEST_SHA256,
    EXPECTED_SAMPLE_SHA256,
    V42_APPROVED_MANIFEST_SHA256,
    V46_APPROVED_MANIFEST_SHA256,
    AiReviewImportConflict,
    build_ai_review_export_payload,
    build_ai_review_import_plan,
    load_manifest_file,
    validate_ai_review_manifest,
)
from src.ai_review_projection import AI_REVIEW_FIELD_KEYS
from src.real_extraction_review import ai_review_output_sha256

FIELDS = list(AI_REVIEW_FIELD_KEYS)


def _capture(tmp_path: Path, name: str = "capture.html") -> tuple[str, str]:
    path = tmp_path / name
    content = b"<html><body>Appartement</body></html>"
    path.write_bytes(content)
    return str(path), hashlib.sha256(content).hexdigest()


def _labels(capture_sha256: str) -> dict[str, dict[str, object]]:
    labels: dict[str, dict[str, object]] = {}
    for field in FIELDS:
        labels[field] = {"state": "absent"}
    labels["property_type"] = {
        "state": "present",
        "value": "apartment",
        "evidence": {
            "capture_sha256": capture_sha256,
            "locator": "visible property type",
            "excerpt": "Appartement",
        },
    }
    return labels


def _case(tmp_path: Path, case_id: str, source_url: str, *, access_state: str = "captured") -> dict:
    case: dict[str, object] = {
        "id": case_id,
        "source": "source_a",
        "source_url": source_url,
        "access": {"state": access_state, "checked_at": "2026-09-29T10:00:00Z", "reason": "not captured"},
        "capture": None,
        "ai_reviews": [],
        "ai_adjudication": None,
    }
    if access_state != "captured":
        return case
    capture_path, capture_sha256 = _capture(tmp_path, f"{case_id}.html")
    labels_a = _labels(capture_sha256)
    labels_b = _labels(capture_sha256)
    review_base = {
        "reviewer_type": "ai",
        "blind_to_other_reviews": True,
        "blind_to_prediction": True,
        "expected_fields": FIELDS,
        "capture_sha256": capture_sha256,
    }
    case["access"] = {"state": "captured", "checked_at": "2026-09-29T10:00:00Z", "reason": None}
    case["capture"] = {
        "captured_at": "2026-09-29T09:00:00Z",
        "sha256": capture_sha256,
        "private_ref": capture_path,
        "endpoint": source_url,
    }
    case["ai_reviews"] = [
        {
            **review_base,
            "reviewer": "ai-pass-a",
            "provider": "test-provider",
            "model": "test-model-a",
            "prompt_version": "test-prompt-v1",
            "prompt_record_status": "not_retained",
            "reviewed_at": "2026-09-29T09:30:00Z",
            "labels": labels_a,
            "output_sha256": ai_review_output_sha256(labels_a),
        },
        {
            **review_base,
            "reviewer": "ai-pass-b",
            "provider": "test-provider",
            "model": "test-model-b",
            "prompt_version": "test-prompt-v1",
            "prompt_record_status": "not_retained",
            "reviewed_at": "2026-09-29T09:31:00Z",
            "labels": labels_b,
            "output_sha256": ai_review_output_sha256(labels_b),
        },
    ]
    return case


def _manifest(cases: list[dict]) -> dict:
    return {
        "schema_version": "immojudis.real-extraction-review.v2",
        "sample_sha256": EXPECTED_SAMPLE_SHA256,
        "ai_review_expected_fields": FIELDS,
        "cases": cases,
    }


def _set_json_capture(case: dict, listing_id: int) -> None:
    capture = case["capture"]
    path = Path(capture["private_ref"])
    raw = json.dumps({"id": listing_id, "description": "Appartement"}).encode()
    path.write_bytes(raw)
    digest = hashlib.sha256(raw).hexdigest()
    capture["sha256"] = digest
    for review in case["ai_reviews"]:
        review["capture_sha256"] = digest
        for label in review["labels"].values():
            evidence = label.get("evidence")
            if isinstance(evidence, dict):
                evidence["capture_sha256"] = digest
        review["output_sha256"] = ai_review_output_sha256(review["labels"])


def test_plan_records_non_captured_cases_without_inventing_capture_evidence(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-captured", "https://source.example/captured")
    failed = _case(tmp_path, "case-failed", "https://source.example/failed", access_state="capture_failed")
    sales = [
        {
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": captured["source_url"],
            "content_hash": "a" * 64,
        },
        {"id": "00000000-0000-4000-8000-000000000002", "source_name": "source_a", "source_url": failed["source_url"]},
    ]

    plan = build_ai_review_import_plan(_manifest([captured, failed]), sales)

    assert plan.summary["captured_cases"] == 1
    assert plan.summary["noncaptured_cases"] == 1
    assert plan.summary["case_status_rows"] == 2
    failed_row = next(row for row in plan.case_rows if row["case_id"] == "case-failed")
    assert failed_row["access_state"] == "capture_failed"
    assert failed_row["capture_sha256"] is None
    assert failed_row["auction_sale_id"] == "00000000-0000-4000-8000-000000000002"
    assert failed_row["mapping_status"] == "exact"
    captured_row = next(row for row in plan.case_rows if row["case_id"] == "case-captured")
    assert captured_row["canonical_content_hash_at_import"] == "a" * 64
    assert plan.rows[0]["canonical_content_hash_at_import"] == "a" * 64
    assert "publishable_rows" not in plan.summary
    assert plan.summary["passes_local_gate_rows"] == 1


def test_unmapped_case_and_projection_fail_closed(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-unmapped", "https://source.example/missing")

    plan = build_ai_review_import_plan(_manifest([captured]), [])

    assert plan.summary["unmapped_cases"] == 1
    assert all(row["mapping_status"] == "unmapped" for row in plan.rows)
    assert all(row["auction_sale_id"] is None for row in plan.rows)
    assert all(row["value_jsonb"] is None for row in plan.rows)
    assert plan.case_rows[0]["auction_sale_id"] is None


def test_replanning_the_same_rows_is_idempotent(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-idempotent", "https://source.example/idempotent")
    sales = [{"id": "00000000-0000-4000-8000-000000000001", "source_name": "source_a", "source_url": captured["source_url"]}]
    manifest = _manifest([captured])
    first = build_ai_review_import_plan(manifest, sales)
    second = build_ai_review_import_plan(
        manifest,
        sales,
        existing_rows=first.rows,
        existing_case_rows=first.case_rows,
    )

    assert second.new_rows == ()
    assert second.new_case_rows == ()
    assert second.unchanged_rows == len(first.rows)
    assert second.unchanged_case_rows == 1


def test_existing_projection_conflict_aborts_before_write(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-conflict", "https://source.example/conflict")
    sales = [{"id": "00000000-0000-4000-8000-000000000001", "source_name": "source_a", "source_url": captured["source_url"]}]
    manifest = _manifest([captured])
    first = build_ai_review_import_plan(manifest, sales)
    existing = [dict(row) for row in first.rows]
    existing[0]["block_reason"] = "operator changed this row"

    with pytest.raises(AiReviewImportConflict, match="differs"):
        build_ai_review_import_plan(manifest, sales, existing_rows=existing, existing_case_rows=first.case_rows)


def test_non_ai_review_is_rejected(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-human", "https://source.example/human")
    captured["ai_reviews"][0]["reviewer_type"] = "human"  # type: ignore[index]

    with pytest.raises(ValueError, match="non-AI review"):
        build_ai_review_import_plan(_manifest([captured]), [])


def test_ai_review_reuses_shared_execution_metadata_validation(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-metadata", "https://source.example/metadata")
    del captured["ai_reviews"][0]["provider"]  # type: ignore[index]

    with pytest.raises(ValueError, match="provider"):
        build_ai_review_import_plan(_manifest([captured]), [])


def test_identical_ai_execution_metadata_is_not_independent(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-same-execution", "https://source.example/same-execution")
    first, second = captured["ai_reviews"]  # type: ignore[assignment]
    for key in ("provider", "model", "prompt_version", "prompt_record_status", "reviewed_at"):
        second[key] = first[key]
    second["output_sha256"] = first["output_sha256"]

    with pytest.raises(ValueError, match="distinct execution metadata"):
        build_ai_review_import_plan(_manifest([captured]), [])


def test_ai_review_cannot_precede_frozen_capture(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-before-capture", "https://source.example/before-capture")
    captured["ai_reviews"][0]["reviewed_at"] = "2026-09-29T08:59:59Z"  # type: ignore[index]

    with pytest.raises(ValueError, match="cannot precede the frozen capture"):
        build_ai_review_import_plan(_manifest([captured]), [])


def test_capture_endpoint_requires_a_proven_redirect_chain(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-redirect", "https://source.example/redirect")
    source_url = captured["source_url"]
    endpoint = "https://api.source.example/listing/redirect"
    captured["capture"]["endpoint"] = endpoint  # type: ignore[index]

    quarantined = build_ai_review_import_plan(_manifest([captured]), [])
    assert quarantined.summary["capture_provenance_blocked_cases"] == 1
    assert all(row["review_state"] == "unverified" for row in quarantined.rows)
    assert all(row["value_jsonb"] is None for row in quarantined.rows)
    assert all("redirect_chain proof is required" in row["block_reason"] for row in quarantined.rows)

    captured["capture"]["redirect_chain"] = [  # type: ignore[index]
        {"from": source_url, "to": "https://source.example/redirected", "status": 302},
        {"from": "https://source.example/redirected", "to": endpoint, "status": 307},
    ]
    plan = build_ai_review_import_plan(
        _manifest([captured]),
        [{
            "id": "00000000-0000-4000-8000-000000000001",
            "source_name": "source_a",
            "source_url": source_url,
            "content_hash": "a" * 64,
        }],
    )
    assert plan.summary["captured_cases"] == 1


def test_capture_redirect_chain_must_be_contiguous_and_end_at_endpoint(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-bad-redirect", "https://source.example/bad-redirect")
    source_url = captured["source_url"]
    endpoint = "https://api.source.example/listing/bad-redirect"
    captured["capture"]["endpoint"] = endpoint  # type: ignore[index]
    captured["capture"]["redirect_chain"] = [  # type: ignore[index]
        {"from": source_url, "to": "https://source.example/other", "status": 200},
    ]

    quarantined = build_ai_review_import_plan(_manifest([captured]), [])
    assert all("invalid status" in row["block_reason"] for row in quarantined.rows)

    captured["capture"]["redirect_chain"] = [  # type: ignore[index]
        {"from": source_url, "to": "https://source.example/other", "status": 302},
    ]
    quarantined = build_ai_review_import_plan(_manifest([captured]), [])
    assert all("does not terminate at endpoint" in row["block_reason"] for row in quarantined.rows)


def test_notaires_api_identity_contract_accepts_both_public_host_pairs(tmp_path: Path) -> None:
    cases = (
        ("case-immo-interactif-api", "https://www.immo-interactif.fr/encheres-en-ligne/maison/test/2075541"),
        ("case-notaires-api", "https://www.immobilier.notaires.fr/fr/annonce-immo/adjudication/maison/test/2069112"),
    )
    for case_id, source_url in cases:
        captured = _case(tmp_path, case_id, source_url)
        captured["source"] = "notaires"
        captured["capture"]["endpoint"] = (
            f"https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/"
            f"{source_url.rstrip('/').rsplit('/', 1)[-1]}"
        )
        _set_json_capture(captured, int(source_url.rstrip("/").rsplit("/", 1)[-1]))
        plan = build_ai_review_import_plan(
            _manifest([captured]),
            [
                {
                    "id": "00000000-0000-4000-8000-000000000001",
                    "source_name": "notaires",
                    "source_url": source_url,
                    "content_hash": "a" * 64,
                }
            ],
        )
        assert plan.summary["exact_mapping_cases"] == 1


def test_notaires_api_identity_requires_matching_stable_json_id(tmp_path: Path) -> None:
    captured = _case(
        tmp_path,
        "case-notaires-wrong-id",
        "https://www.immo-interactif.fr/encheres-en-ligne/maison/test/2075541",
    )
    captured["source"] = "notaires"
    captured["capture"]["endpoint"] = (
        "https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/2075541"
    )
    _set_json_capture(captured, 9999999)

    plan = build_ai_review_import_plan(_manifest([captured]), [])
    assert plan.summary["capture_provenance_blocked_cases"] == 1
    assert all("stable listing id differs" in row["block_reason"] for row in plan.rows)
    assert all(row["value_jsonb"] is None for row in plan.rows)


def test_notaires_api_identity_requires_matching_endpoint_id(tmp_path: Path) -> None:
    captured = _case(
        tmp_path,
        "case-notaires-endpoint-id",
        "https://www.immo-interactif.fr/encheres-en-ligne/maison/test/2075541",
    )
    captured["source"] = "notaires"
    captured["capture"]["endpoint"] = (
        "https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/2075542"
    )
    _set_json_capture(captured, 2075541)

    plan = build_ai_review_import_plan(_manifest([captured]), [])
    assert plan.summary["capture_provenance_blocked_cases"] == 1
    assert all("identity id differs" in row["block_reason"] for row in plan.rows)
    assert all(row["value_jsonb"] is None for row in plan.rows)


def test_agrasc_cannot_use_notaires_api_identity_contract(tmp_path: Path) -> None:
    captured = _case(
        tmp_path,
        "case-agrasc-notaires-api",
        "https://www.immo-interactif.fr/encheres-en-ligne/maison/test/2075541",
    )
    captured["source"] = "agrasc"
    captured["capture"]["endpoint"] = (
        "https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/2075541"
    )
    _set_json_capture(captured, 2075541)

    plan = build_ai_review_import_plan(_manifest([captured]), [])
    assert plan.summary["unmapped_cases"] == 1
    assert plan.summary["capture_provenance_blocked_cases"] == 1
    assert all(row["mapping_status"] == "unmapped" for row in plan.rows)
    assert all(row["review_state"] == "unverified" for row in plan.rows)
    assert all("redirect_chain proof is required" in row["block_reason"] for row in plan.rows)
    assert "capture endpoint provenance" in plan.case_rows[0]["access_reason"]


def test_notaires_api_identity_rejects_non_listing_public_path(tmp_path: Path) -> None:
    captured = _case(
        tmp_path,
        "case-notaires-non-listing-path",
        "https://www.immo-interactif.fr/other/2075541",
    )
    captured["source"] = "notaires"
    captured["capture"]["endpoint"] = (
        "https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/2075541"
    )
    _set_json_capture(captured, 2075541)

    plan = build_ai_review_import_plan(_manifest([captured]), [])
    assert plan.summary["capture_provenance_blocked_cases"] == 1
    assert all("redirect_chain proof is required" in row["block_reason"] for row in plan.rows)


def test_notaires_api_identity_rejects_non_default_ports(tmp_path: Path) -> None:
    captured = _case(
        tmp_path,
        "case-notaires-port",
        "https://www.immo-interactif.fr:443/encheres-en-ligne/maison/test/2075541",
    )
    captured["source"] = "notaires"
    captured["capture"]["endpoint"] = (
        "https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/2075541"
    )
    _set_json_capture(captured, 2075541)

    plan = build_ai_review_import_plan(_manifest([captured]), [])
    assert plan.summary["capture_provenance_blocked_cases"] == 1
    assert all("redirect_chain proof is required" in row["block_reason"] for row in plan.rows)


def test_offline_export_is_bounded_and_contains_no_private_capture_paths(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-export", "https://source.example/export")
    failed = _case(tmp_path, "case-failed-export", "https://source.example/failed-export", access_state="capture_failed")
    failed["access"]["reason"] = "/private/tmp/private-capture.txt"  # type: ignore[index]

    payload = build_ai_review_export_payload(
        _manifest([captured, failed]),
        manifest_sha256=EXPECTED_MANIFEST_SHA256,
        batch_size=2,
    )

    assert payload["format"] == "immojudis.ai-review-import-batches.v1"
    assert len(payload["batches"]) == 7
    assert payload["summary"]["projection_batches"] == 6
    assert payload["summary"]["batch_count"] == 7
    assert payload["batches"][0]["projections"] == []
    assert all(len(batch["projections"]) <= 2 for batch in payload["batches"][1:])
    assert len(payload["batches"][0]["case_statuses"]) == 2
    assert all(not batch["case_statuses"] for batch in payload["batches"][1:])
    projections = [row for batch in payload["batches"] for row in batch["projections"]]
    encoded = str(payload)
    assert "/private" not in encoded
    assert "private_ref" not in encoded
    assert all(row["mapping_status"] == "server_exact_required" for row in projections)
    assert all("auction_sale_id" not in row for row in projections)


def test_offline_rpc_export_quarantines_unsupported_occupancy_and_keeps_shape(
    tmp_path: Path,
) -> None:
    raw_value = "partiellement occupé"
    captured = _case(tmp_path, "case-export-occupancy", "https://source.example/export-occupancy")
    capture = captured["capture"]
    assert isinstance(capture, dict)
    capture_path = Path(capture["private_ref"])
    capture_bytes = f"<html><body>Appartement {raw_value}</body></html>".encode()
    capture_path.write_bytes(capture_bytes)
    capture_sha256 = hashlib.sha256(capture_bytes).hexdigest()
    capture["sha256"] = capture_sha256
    for review in captured["ai_reviews"]:
        assert isinstance(review, dict)
        review["capture_sha256"] = capture_sha256
        for existing_label in review["labels"].values():
            if isinstance(existing_label, dict) and isinstance(existing_label.get("evidence"), dict):
                existing_label["evidence"]["capture_sha256"] = capture_sha256
        label = review["labels"]["occupancy_status"]
        label.update(
            {
                "state": "present",
                "value": raw_value,
                "evidence": {
                    "capture_sha256": capture_sha256,
                    "locator": "visible occupancy field",
                    "excerpt": raw_value,
                },
            }
        )
        review["output_sha256"] = ai_review_output_sha256(review["labels"])

    payload = build_ai_review_export_payload(
        _manifest([captured]),
        manifest_sha256=EXPECTED_MANIFEST_SHA256,
    )

    projections = [row for batch in payload["batches"] for row in batch["projections"]]
    occupancy = next(row for row in projections if row["field_key"] == "property.occupancy_status")
    assert occupancy["mapping_status"] == "server_exact_required"
    assert occupancy["review_state"] == "unresolved"
    assert occupancy["citation_status"] == "not_required"
    assert occupancy["value_jsonb"] is None
    assert "not a recognized canonical value" in occupancy["block_reason"]
    assert set(occupancy) == {
        "schema_version",
        "sample_sha256",
        "case_id",
        "source_name",
        "source_url",
        "capture_sha256",
        "mapping_status",
        "field_key",
        "review_state",
        "citation_status",
        "value_jsonb",
        "evidence_locator",
        "block_reason",
    }
    assert "private_ref" not in json.dumps(payload)


def test_offline_export_retains_endpoint_quarantine(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-export-quarantine", "https://source.example/export-quarantine")
    captured["capture"]["endpoint"] = "https://api.source.example/export-quarantine"  # type: ignore[index]

    payload = build_ai_review_export_payload(
        _manifest([captured]),
        manifest_sha256=EXPECTED_MANIFEST_SHA256,
        batch_size=100,
    )

    projections = [row for batch in payload["batches"] for row in batch["projections"]]
    assert payload["summary"]["capture_provenance_blocked_cases"] == 1
    assert payload["summary"]["capture_provenance_blocked_rows"] == len(FIELDS)
    assert len(projections) == len(FIELDS)
    assert all(row["review_state"] == "unverified" for row in projections)
    assert all(row["citation_status"] == "unverified" for row in projections)
    assert all(row["value_jsonb"] is None for row in projections)
    assert all("redirect_chain proof is required" in row["block_reason"] for row in projections)
    assert "capture endpoint provenance" in payload["batches"][0]["case_statuses"][0]["access_reason"]


def test_manifest_loader_rejects_an_unapproved_artifact(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text("{}", encoding="utf-8")

    with pytest.raises(ValueError, match="approved frozen artifact"):
        load_manifest_file(path)


def test_only_the_three_frozen_manifest_hashes_are_authorized(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-allowlist", "https://source.example/allowlist")
    assert APPROVED_MANIFEST_SHA256S == frozenset(
        {
            EXPECTED_MANIFEST_SHA256,
            V42_APPROVED_MANIFEST_SHA256,
            V46_APPROVED_MANIFEST_SHA256,
        }
    )

    old_plan = build_ai_review_import_plan(
        _manifest([captured]), [], manifest_sha256=EXPECTED_MANIFEST_SHA256
    )
    v42_plan = build_ai_review_import_plan(
        _manifest([captured]), [], manifest_sha256=V42_APPROVED_MANIFEST_SHA256
    )
    v46_plan = build_ai_review_import_plan(
        _manifest([captured]), [], manifest_sha256=V46_APPROVED_MANIFEST_SHA256
    )
    assert old_plan.summary["projected_rows"] == len(FIELDS)
    assert v42_plan.summary["projected_rows"] == len(FIELDS)
    assert v46_plan.summary["projected_rows"] == len(FIELDS)

    for rejected_sha256 in (
        "24085f1160cfb514a62b75182d93cd8569254b2faf9347ffb19060f7b3c98a4a",
        "945fd0634077f5ee7adf1a79183de3912cb649165ab1e827f30ee96a5c61c271",
        "1c25823b5d79ce1a97100e8329501dd44394712c31fe3147e746c1e4643c8ae3",
        "f" * 64,
        "7b3173e09f3a3989700022cb5bea0a79c2af12e0a75c0ddee8d9f26365b2cbb8",
    ):
        with pytest.raises(ValueError, match="approved frozen artifact"):
            build_ai_review_import_plan(
                _manifest([captured]), [], manifest_sha256=rejected_sha256
            )


def test_offline_export_accepts_v42_allowlisted_manifest_hash(tmp_path: Path) -> None:
    captured = _case(tmp_path, "case-v42-export", "https://source.example/v42-export")

    payload = build_ai_review_export_payload(
        _manifest([captured]),
        manifest_sha256=V42_APPROVED_MANIFEST_SHA256,
    )

    assert payload["summary"]["manifest_sha256"] == V42_APPROVED_MANIFEST_SHA256
    assert payload["summary"]["projection_rows"] == len(FIELDS)


def test_manifest_sample_digest_is_pinned() -> None:
    manifest = _manifest([])
    manifest["sample_sha256"] = "a" * 64

    with pytest.raises(ValueError, match="approved frozen sample"):
        # The case is intentionally not validated because the sample gate must
        # fail before any private capture is touched.
        validate_ai_review_manifest(manifest)
