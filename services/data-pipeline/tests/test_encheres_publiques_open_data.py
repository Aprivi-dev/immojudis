from __future__ import annotations

import csv
from datetime import UTC
from pathlib import Path

import pytest

from src.official_sources.encheres_publiques_open_data import (
    ENCHERES_PUBLIQUES_COURT_SCHEMA,
    ENCHERES_PUBLIQUES_DATASET_URL,
    ENCHERES_PUBLIQUES_SCHEMA,
    EncheresPubliquesSchemaError,
    enrich_hearing_candidates_with_court_references,
    parse_encheres_publiques_courts_csv,
    parse_encheres_publiques_csv,
)

RAW_FILE = (
    Path(__file__).parents[1]
    / "data"
    / "raw"
    / "outcome_sources"
    / "encheres_publiques"
    / "resultats-vente-2006-2024.csv"
)
RAW_COURTS_FILE = RAW_FILE.with_name("tribunaux-judiciaires.csv")


def _write_csv(
    path: Path,
    rows: list[dict[str, str]],
    *,
    headers: tuple[str, ...] = ENCHERES_PUBLIQUES_SCHEMA,
    delimiter: str = ",",
) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, delimiter=delimiter)
        writer.writeheader()
        writer.writerows(rows)


def _candidate_row(**overrides: str) -> dict[str, str]:
    row = {
        "Date de vente": "2024-05-03T16:00:00+02:00",
        "Organisateur_id": "5355",
        "Organisateur_nom": "Tribunal Judiciaire de FOIX",
        "Categorie": "maisons",
        "Adresse": "38, rue de l'Hôtel de Ville, 09270 Mazères, France",
        "Url": (
            "https://www.encheres-publiques.com/encheres/immobilier/maisons/"
            "mazeres-09/maison-mazeres_1?preuve=originale"
        ),
    }
    row.update(overrides)
    return row


def _court_row(**overrides: str) -> dict[str, str]:
    row = {
        "ID": "5355",
        "Nom": "Tribunal judiciaire de Foix",
        "Adresse": "14 Boulevard du Sud, 09000 Foix, France",
        "Lien vers le Profil": (
            "https://www.encheres-publiques.com/profils/tribunal/foix-09/"
            "tribunal-judiciaire-foix_5355"
        ),
    }
    row.update(overrides)
    return row


def test_records_are_only_grade_c_hearing_candidates_without_outcome_or_price(tmp_path: Path) -> None:
    path = tmp_path / "candidates.csv"
    _write_csv(path, [_candidate_row()], delimiter=";")

    result = parse_encheres_publiques_csv(path)

    assert result.quality.dataset_kind == "auction_hearing_candidate"
    assert result.quality.detected_delimiter == ";"
    assert result.quality.source_url == ENCHERES_PUBLIQUES_DATASET_URL
    record = result.records[0]
    assert record["record_type"] == "auction_hearing_candidate"
    assert record["event_type"] == "auction_hearing_candidate"
    assert record["candidate_only"] is True
    assert record["candidate_grade"] == "C"
    assert record["evidence_grade"] == "C"
    assert record["training_eligible"] is False
    assert record["source_is_official"] is False
    assert record["hearing_at"].tzinfo is UTC
    assert record["hearing_at"].isoformat() == "2024-05-03T14:00:00+00:00"
    assert record["source_url"] == _candidate_row()["Url"]
    assert len(record["stable_id"].rsplit(":", 1)[-1]) == 64
    assert len(record["canonical_hash"]) == 64

    forbidden_tokens = ("price", "prix", "outcome", "adjudication_amount", "sale_amount")
    assert not any(token in key.lower() for key in record for token in forbidden_tokens)


def test_early_dates_and_missing_descriptors_are_kept_but_flagged(tmp_path: Path) -> None:
    path = tmp_path / "anomalies.csv"
    _write_csv(
        path,
        [
            _candidate_row(
                **{
                    "Date de vente": "1968-05-03T14:00:00.000Z",
                    "Categorie": "",
                    "Adresse": "",
                }
            )
        ],
    )

    result = parse_encheres_publiques_csv(path)

    assert result.quality.valid_rows == 1
    assert result.quality.rejected_rows == 0
    assert result.quality.anomaly_counts == {
        "event_before_declared_coverage": 1,
        "missing_address": 1,
        "missing_category": 1,
    }
    assert result.quality.null_counts["Adresse"] == 1
    assert result.records[0]["quality_flags"] == [
        "event_before_declared_coverage",
        "missing_address",
        "missing_category",
    ]
    assert result.records[0]["training_eligible"] is False


def test_invalid_dates_urls_and_organizers_are_rejected_with_quality_stats(tmp_path: Path) -> None:
    path = tmp_path / "invalid.csv"
    _write_csv(
        path,
        [
            _candidate_row(**{"Date de vente": "not-a-date"}),
            _candidate_row(**{"Date de vente": "2024-05-03T14:00:00"}),
            _candidate_row(Url="http://www.encheres-publiques.com/encheres/immobilier/maisons/test_1"),
            _candidate_row(Organisateur_id="TJ-5355"),
            _candidate_row(),
        ],
    )

    result = parse_encheres_publiques_csv(path)

    assert result.quality.total_rows == 5
    assert result.quality.valid_rows == 1
    assert result.quality.rejected_rows == 4
    assert result.quality.anomaly_counts["invalid_hearing_date"] == 1
    assert result.quality.anomaly_counts["hearing_date_missing_timezone"] == 1
    assert result.quality.anomaly_counts["invalid_source_url"] == 1
    assert result.quality.anomaly_counts["invalid_organizer_id"] == 1


def test_duplicates_are_deduplicated_and_conflicts_are_counted(tmp_path: Path) -> None:
    path = tmp_path / "duplicates.csv"
    first = _candidate_row()
    _write_csv(path, [first, first, _candidate_row(Adresse="Adresse contradictoire")])

    result = parse_encheres_publiques_csv(path)

    assert result.quality.total_rows == 3
    assert result.quality.valid_rows == 1
    assert result.quality.duplicate_rows == 2
    assert result.quality.rejected_rows == 0
    assert result.quality.anomaly_counts["conflicting_stable_id"] == 1


def test_stable_id_is_url_based_and_hash_changes_with_candidate_content(tmp_path: Path) -> None:
    first_path = tmp_path / "first.csv"
    second_path = tmp_path / "second.csv"
    _write_csv(first_path, [_candidate_row()])
    _write_csv(second_path, [_candidate_row(Adresse="Adresse mise à jour")])

    first = parse_encheres_publiques_csv(first_path).records[0]
    second = parse_encheres_publiques_csv(second_path).records[0]

    assert first["stable_id"] == second["stable_id"]
    assert first["canonical_hash"] != second["canonical_hash"]


def test_court_reference_is_private_grade_c_and_never_canonical(tmp_path: Path) -> None:
    path = tmp_path / "tribunaux.csv"
    _write_csv(path, [_court_row()], headers=ENCHERES_PUBLIQUES_COURT_SCHEMA)

    result = parse_encheres_publiques_courts_csv(path)

    assert result.quality.dataset_kind == "court_reference_candidate"
    assert result.quality.valid_rows == 1
    reference = result.records[0]
    assert reference["stable_id"] == "encheres_publiques:court:5355"
    assert reference["organizer_source_id"] == "5355"
    assert reference["source_url"] == _court_row()["Lien vers le Profil"]
    assert reference["source_is_official"] is False
    assert reference["reference_role"] == "match_candidate_only"
    assert reference["requires_official_match_review"] is True
    assert reference["candidate_grade"] == reference["evidence_grade"] == "C"
    assert reference["training_eligible"] is False
    assert "outcome_court_id" not in reference
    assert "official_court_id" not in reference


def test_court_reference_parser_requires_unique_organizer_ids(tmp_path: Path) -> None:
    path = tmp_path / "duplicate-courts.csv"
    _write_csv(
        path,
        [_court_row(), _court_row(**{"Lien vers le Profil": _court_row()["Lien vers le Profil"] + "-bis"})],
        headers=ENCHERES_PUBLIQUES_COURT_SCHEMA,
    )

    with pytest.raises(EncheresPubliquesSchemaError, match="duplicate organizer ID 5355"):
        parse_encheres_publiques_courts_csv(path)


def test_court_reference_parser_rejects_non_https_or_non_profile_url(tmp_path: Path) -> None:
    path = tmp_path / "invalid-court.csv"
    _write_csv(
        path,
        [
            _court_row(
                **{
                    "Lien vers le Profil": (
                        "http://www.encheres-publiques.com/profils/tribunal/foix-09/"
                        "tribunal-judiciaire-foix_5355"
                    )
                }
            )
        ],
        headers=ENCHERES_PUBLIQUES_COURT_SCHEMA,
    )

    result = parse_encheres_publiques_courts_csv(path)

    assert result.records == []
    assert result.quality.rejected_rows == 1
    assert result.quality.anomaly_counts["invalid_court_profile_url"] == 1


def test_join_enriches_by_organizer_id_without_promoting_official_court(tmp_path: Path) -> None:
    hearings_path = tmp_path / "hearings.csv"
    courts_path = tmp_path / "courts.csv"
    unmatched = _candidate_row(
        Organisateur_id="9999",
        Url=(
            "https://www.encheres-publiques.com/encheres/immobilier/maisons/"
            "pamiers-09/maison-pamiers_9999"
        ),
    )
    _write_csv(hearings_path, [_candidate_row(), unmatched])
    _write_csv(courts_path, [_court_row()], headers=ENCHERES_PUBLIQUES_COURT_SCHEMA)
    hearings = parse_encheres_publiques_csv(hearings_path).records
    references = parse_encheres_publiques_courts_csv(courts_path).records
    original_hash = hearings[0]["canonical_hash"]

    joined = enrich_hearing_candidates_with_court_references(hearings, references)

    assert joined.matched_rows == 1
    assert joined.unmatched_rows == 1
    candidate = joined.records[0]["court_reference_candidate"]
    assert candidate["stable_id"] == "encheres_publiques:court:5355"
    assert candidate["official_match_status"] == "review_required"
    assert "court_reference_candidate" not in hearings[0]
    assert joined.records[0]["canonical_hash"] != original_hash
    assert "court_reference_candidate" not in joined.records[1]
    assert "outcome_court_id" not in joined.records[0]


@pytest.mark.parametrize(
    "payload",
    [
        "<!doctype html><html><body>resource unavailable</body></html>",
        (
            "Date de vente,Organisateur_id,Organisateur_nom,Categorie,Adresse,Url,Prix de vente\n"
            "2024-01-01T10:00:00Z,1,TJ,maisons,Paris,https://example.test/1,100000\n"
        ),
        "Date,Tribunal,Resultat\n2024-01-01,TJ,adjuge\n",
    ],
)
def test_deceptive_or_changed_schema_is_rejected(tmp_path: Path, payload: str) -> None:
    path = tmp_path / "resultats.csv"
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(EncheresPubliquesSchemaError):
        parse_encheres_publiques_csv(path)


def test_observed_14550_rows_remain_candidate_only_when_download_is_available() -> None:
    if not RAW_FILE.exists():
        pytest.skip("local raw Encheres Publiques download is not present")

    result = parse_encheres_publiques_csv(RAW_FILE)

    assert result.quality.total_rows == 14_550
    assert result.quality.valid_rows == 14_550
    assert result.quality.rejected_rows == 0
    assert result.quality.duplicate_rows == 0
    assert result.quality.null_counts["Adresse"] == 245
    assert result.quality.null_counts["Categorie"] == 3
    assert result.quality.anomaly_counts["event_before_declared_coverage"] == 2
    assert all(record["record_type"] == "auction_hearing_candidate" for record in result.records)
    assert all(record["training_eligible"] is False for record in result.records)
    assert all(record["candidate_grade"] == "C" for record in result.records)


def test_observed_court_references_join_when_download_is_available() -> None:
    if not RAW_FILE.exists() or not RAW_COURTS_FILE.exists():
        pytest.skip("local raw Encheres Publiques downloads are not present")

    hearings = parse_encheres_publiques_csv(RAW_FILE)
    courts = parse_encheres_publiques_courts_csv(RAW_COURTS_FILE)
    joined = enrich_hearing_candidates_with_court_references(hearings.records, courts.records)

    assert courts.quality.total_rows == 167
    assert courts.quality.valid_rows == 167
    assert courts.quality.duplicate_rows == 0
    assert joined.matched_rows == 14_473
    assert joined.unmatched_rows == 77
