from __future__ import annotations

import json
from pathlib import Path

from src.extraction_corpus import DEFAULT_CORPUS_PATH, evaluate_corpus, load_corpus, values_equal
from tests.extraction_corpus_runtime import run_fixture


def test_corpus_is_versioned_and_all_cases_are_explicitly_synthetic() -> None:
    corpus = load_corpus()

    assert corpus["evidence_scope"] == "synthetic_fixtures_only"
    assert len(corpus["cases"]) == 11
    assert all(case["annotation"]["status"] == "synthetic" for case in corpus["cases"])
    assert {label["state"] for case in corpus["cases"] for label in case["labels"].values()} >= {
        "present",
        "unknown",
        "absent",
    }


def test_evaluation_is_machine_readable_and_separates_unknown_from_absent() -> None:
    report = evaluate_corpus(DEFAULT_CORPUS_PATH, run_fixture)

    assert report["fixture_errors"] == []
    assert report["summary"]["present"] > 0
    assert report["summary"]["unknown"] == 2
    assert report["summary"]["unknown_preserved"] == 2
    assert report["summary"]["unknown_filled"] == 0
    assert report["summary"]["absent"] > 0
    assert report["summary"]["absent_empty"] > 0
    assert report["by_field"]["parking_count"]["unknown_preserved"] == 1
    assert report["by_source"]["notaires"]["unknown_preserved"] == 1
    assert all(case["annotation"]["status"] == "synthetic" for case in report["cases"])

    encoded = json.dumps(report, ensure_ascii=False, sort_keys=True)
    decoded = json.loads(encoded)
    assert decoded["corpus_sha256"] == report["corpus_sha256"]


def test_lot_identity_fields_have_no_critical_errors_in_controlled_matrix() -> None:
    report = evaluate_corpus(DEFAULT_CORPUS_PATH, run_fixture)

    assert report["summary"]["false_negative"] == 0
    assert report["summary"]["false_positive"] == 0
    assert [case for case in report["cases"] if case["critical_lot_error"]] == []
    assert report["by_field"]["source_url"]["precision"] == 1.0
    assert report["by_field"]["source_url"]["recall"] == 1.0


def test_numeric_annotations_compare_to_decimal_without_float_rounding() -> None:
    from decimal import Decimal

    assert values_equal("103.16", Decimal("103.160"))
    assert values_equal("0.0000001", Decimal("0.00000010"))
    assert not values_equal("103.16", Decimal("103.17"))


def test_fixture_manifest_points_to_existing_source_tests() -> None:
    corpus = load_corpus()
    for case in corpus["cases"]:
        fixture_path = Path(__file__).parents[0].parent / case["fixture"]["path"]
        assert fixture_path.exists(), case["id"]
