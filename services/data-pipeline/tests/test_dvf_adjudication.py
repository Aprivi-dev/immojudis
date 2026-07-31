from __future__ import annotations

import hashlib
import zipfile
from dataclasses import replace
from datetime import date
from decimal import Decimal

from src.outcome_ingestion.dvf_adjudication import (
    AuctionLotMatchContext,
    iter_dvf_adjudication_candidates,
    match_dvf_adjudication,
)


def test_streams_one_review_only_candidate_from_contiguous_dvf_rows(tmp_path) -> None:
    path = tmp_path / "dvf.txt"
    path.write_text(
        "Date mutation|Nature mutation|Valeur fonciere|No disposition|No voie|Voie|Code postal|Commune|"
        "Code departement|Code commune|Prefixe de section|Section|No plan|Code type local|Type local|"
        "Surface reelle bati|Surface terrain\n"
        "14/05/2025|Adjudication|185000,00|000001|12|RUE DU TEST|33000|BORDEAUX|33|063||AB|42|2|"
        "Appartement|61|\n"
        "14/05/2025|Adjudication|185000,00|000001||||BORDEAUX|33|063||AB|43||||120\n"
        "15/05/2025|Vente|250000,00|000001|8|RUE AUTRE|33000|BORDEAUX|33|063||AC|1|1|Maison|90|\n",
        encoding="utf-8",
    )

    candidates = list(iter_dvf_adjudication_candidates(path))

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.total_price_eur == Decimal("185000.00")
    assert candidate.parcel_ids == ("33063000AB0042", "33063000AB0043")
    assert candidate.raw_row_count == 2
    assert candidate.training_eligible is False
    assert candidate.evidence_grade == "C"
    assert candidate.record_kind == "auction_result_candidate"
    assert candidate.normalized_data()["total_price_eur"] == "185000.00"
    assert "price" not in candidate.external_record_id


def test_official_zip_candidate_has_reproducible_artifact_provenance_and_deduplication(tmp_path) -> None:
    archive_path = tmp_path / "valeursfoncieres-2025.txt.zip"
    source = (
        "Date mutation|Nature mutation|Valeur fonciere|No disposition|No voie|Type de voie|Voie|Code postal|"
        "Commune|Code departement|Code commune|Section|No plan|Code type local|Type local|Surface reelle bati\n"
        "14/05/2025|Adjudication|185000|000001|12|RUE|DU TEST|33000|BORDEAUX|33|063|AB|42|2|Appartement|61\n"
        "14/05/2025|Adjudication|185000|000001|12|RUE|DU TEST|33000|BORDEAUX|33|063|AB|42|2|Appartement|61\n"
        "15/05/2025|Vente|250000|000001|8|RUE|AUTRE|33000|BORDEAUX|33|063|AC|1|1|Maison|90\n"
        "14/05/2025|Adjudication|185000|000001|12|RUE|DU TEST|33000|BORDEAUX|33|063|AB|42|2|Appartement|61\n"
    )
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("ValeursFoncieres-2025.txt", source)

    first = list(iter_dvf_adjudication_candidates(archive_path))
    second = list(iter_dvf_adjudication_candidates(archive_path))
    candidates_before_semantic_deduplication = list(
        iter_dvf_adjudication_candidates(archive_path, deduplicate=False)
    )

    assert len(first) == 1
    assert len(candidates_before_semantic_deduplication) == 2
    assert first[0].external_record_id == second[0].external_record_id
    assert first[0].content_hash == second[0].content_hash
    assert first[0].deduplication_key == second[0].deduplication_key
    assert first[0].raw_row_count == 2
    assert first[0].property_count == 1
    assert first[0].source_artifact_sha256 == hashlib.sha256(archive_path.read_bytes()).hexdigest()
    assert first[0].source_artifact_file_name == archive_path.name
    assert first[0].source_member_name == "ValeursFoncieres-2025.txt"
    assert first[0].source_record_start == 1
    assert first[0].source_record_end == 2
    assert first[0].training_eligible is False
    assert first[0].normalized_data()["source_provenance"] == {
        "artifact_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        "artifact_file_name": archive_path.name,
        "member_name": "ValeursFoncieres-2025.txt",
        "record_start": 1,
        "record_end": 2,
    }


def test_corrected_price_versions_content_without_changing_price_free_identity(tmp_path) -> None:
    header = (
        "Date mutation|Nature mutation|Valeur fonciere|No disposition|No voie|Type de voie|Voie|Code postal|"
        "Commune|Code departement|Code commune|Section|No plan|Code type local|Type local|Surface reelle bati\n"
    )
    first_path = tmp_path / "first.txt"
    corrected_path = tmp_path / "corrected.txt"
    first_path.write_text(
        header
        + "14/05/2025|Adjudication|185000|000001|12|RUE|DU TEST|33000|BORDEAUX|33|063|AB|42|2|"
        "Appartement|61\n",
        encoding="utf-8",
    )
    corrected_path.write_text(
        header
        + "14/05/2025|Adjudication|190000|000001|12|RUE|DU TEST|33000|BORDEAUX|33|063|AB|42|2|"
        "Appartement|61\n",
        encoding="utf-8",
    )

    original = next(iter_dvf_adjudication_candidates(first_path))
    corrected = next(iter_dvf_adjudication_candidates(corrected_path))

    assert original.external_record_id == corrected.external_record_id
    assert original.content_hash != corrected.content_hash
    assert original.deduplication_key != corrected.deduplication_key
    assert original.training_eligible is False
    assert corrected.training_eligible is False


def test_semantic_dedup_keeps_distinct_lots_at_same_parcel_date_and_price(tmp_path) -> None:
    path = tmp_path / "dvf.txt"
    path.write_text(
        "Date mutation|Nature mutation|Valeur fonciere|No disposition|No voie|Type de voie|Voie|Code postal|"
        "Commune|Code departement|Code commune|Section|No plan|1er lot|Code type local|Type local|"
        "Surface reelle bati|Nombre pieces principales\n"
        "14/05/2025|Adjudication|25000|1|4|AV|DES SABLONS|91350|GRIGNY|91|286|AL|106|249|2|"
        "Appartement|69|4\n"
        "15/05/2025|Vente|30000|1|4|AV|DES SABLONS|91350|GRIGNY|91|286|AL|106|300|2|Appartement|50|2\n"
        "14/05/2025|Adjudication|25000|1|4|AV|DES SABLONS|91350|GRIGNY|91|286|AL|106|336|2|"
        "Appartement|42|2\n",
        encoding="utf-8",
    )

    candidates = list(iter_dvf_adjudication_candidates(path))

    assert len(candidates) == 2
    assert candidates[0].deduplication_key != candidates[1].deduplication_key


def test_parcel_and_date_make_a_strong_but_never_automatic_match(tmp_path) -> None:
    path = tmp_path / "dvf.txt"
    path.write_text(
        "Date mutation|Nature mutation|Valeur fonciere|No disposition|No voie|Voie|Code postal|Commune|"
        "Code departement|Code commune|Section|No plan|Code type local|Type local|Surface reelle bati\n"
        "14/05/2025|Adjudication|185000|1|12|RUE DU TEST|33000|BORDEAUX|33|063|AB|42|2|Appartement|61\n",
        encoding="utf-8",
    )
    candidate = next(iter_dvf_adjudication_candidates(path))

    match = match_dvf_adjudication(
        candidate,
        AuctionLotMatchContext(
            lot_id="lot-1",
            scheduled_at=date(2025, 5, 14),
            parcel_ids=("33 063 000 AB 0042",),
            address="12 rue du Test",
            city="Bordeaux",
            postal_code="33000",
            insee_code="33063",
        ),
    )

    assert match.match_status == "strong_candidate"
    assert match.match_method == "parcel_and_date"
    assert match.match_score >= Decimal("0.85")
    assert match.automatic_link_allowed is False
    assert match.training_eligible is False
    assert match.signals["price_used_for_matching"] is False


def test_match_score_and_signals_are_independent_from_dvf_price(tmp_path) -> None:
    path = tmp_path / "dvf.txt"
    path.write_text(
        "Date mutation|Nature mutation|Valeur fonciere|No disposition|No voie|Type de voie|Voie|Code postal|"
        "Commune|Code departement|Code commune|Section|No plan|Code type local|Type local|Surface reelle bati\n"
        "14/05/2025|Adjudication|185000|1|12|RUE|DU TEST|33000|BORDEAUX|33|063|AB|42|2|Appartement|61\n",
        encoding="utf-8",
    )
    candidate = next(iter_dvf_adjudication_candidates(path))
    corrected_price = replace(candidate, total_price_eur=Decimal("999999"))
    lot = AuctionLotMatchContext(
        lot_id="lot-price-free",
        scheduled_at=date(2025, 5, 14),
        parcel_ids=("33063000AB0042",),
        address="12 rue du Test",
        city="Bordeaux",
        postal_code="33000",
        insee_code="33063",
    )

    original_match = match_dvf_adjudication(candidate, lot)
    corrected_match = match_dvf_adjudication(corrected_price, lot)

    assert original_match.match_score == corrected_match.match_score
    assert original_match.match_method == corrected_match.match_method
    assert original_match.match_status == corrected_match.match_status
    assert original_match.signals == corrected_match.signals
    assert original_match.training_eligible is False
    assert corrected_match.training_eligible is False


def test_address_alone_is_capped_and_cannot_be_a_strong_match(tmp_path) -> None:
    path = tmp_path / "dvf.txt"
    path.write_text(
        "Date mutation|Nature mutation|Valeur fonciere|No disposition|No voie|Voie|Code postal|Commune|"
        "Code departement|Code commune|Code type local|Type local|Surface reelle bati\n"
        "14/05/2025|Adjudication|185000|1|12|RUE DU TEST|33000|BORDEAUX|33|063|2|Appartement|61\n",
        encoding="utf-8",
    )
    candidate = next(iter_dvf_adjudication_candidates(path))

    match = match_dvf_adjudication(
        candidate,
        AuctionLotMatchContext(
            lot_id="lot-2",
            scheduled_at=date(2025, 5, 14),
            address="12 rue du Test",
            city="Bordeaux",
            postal_code="33000",
            insee_code="33063",
        ),
    )

    assert match.match_status == "review_required"
    assert match.match_method == "address_and_date"
    assert match.match_score <= Decimal("0.49")
    assert match.automatic_link_allowed is False
