from __future__ import annotations

import fitz

from src.information_agent_evidence import (
    analyze_evidence_bytes,
    detect_mime_type,
    extract_evidence_facts,
)


def _pdf_bytes(text: str) -> bytes:
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), text)
    content = document.tobytes()
    document.close()
    return content


def test_detects_real_file_signature_instead_of_trusting_extension() -> None:
    assert detect_mime_type(b"%PDF-1.7\n") == "application/pdf"
    assert detect_mime_type(b"\x89PNG\r\n\x1a\nrest") == "image/png"
    assert detect_mime_type(b"plain UTF-8 text") == "text/plain"


def test_rejects_declared_mime_mismatch() -> None:
    analysis = analyze_evidence_bytes(
        b"%PDF-1.7\n",
        filename="photo.jpg",
        declared_mime_type="image/jpeg",
        ocr_enabled=False,
    )
    assert analysis.status == "unsupported"
    assert analysis.error_code == "MIME_MISMATCH"


def test_extracts_page_sourced_candidates_from_pdf() -> None:
    analysis = analyze_evidence_bytes(
        _pdf_bytes("Surface habitable : 87 m2 - 4 pieces - mise a prix 80 000 euros"),
        filename="proces-verbal-descriptif.pdf",
        declared_mime_type="application/pdf",
        ocr_enabled=False,
    )
    by_key = {fact.fact_key: fact for fact in analysis.facts}
    assert analysis.status == "completed"
    assert analysis.page_count == 1
    assert by_key["surface_m2"].value == 87
    assert by_key["surface_m2"].source_page == 1
    assert by_key["rooms_count"].value == 4
    assert by_key["starting_price_eur"].value == 80_000


def test_extracts_deterministic_text_facts_without_auto_approval() -> None:
    facts = extract_evidence_facts(
        [
            {
                "page": 3,
                "text": "Le bien est libre de toute occupation. DPE : D. Surface habitable 102,5 m2.",
            }
        ]
    )
    by_key = {fact.fact_key: fact for fact in facts}
    assert by_key["occupancy_status"].value == "vacant"
    assert by_key["energy_diagnostics"].value == "D"
    assert by_key["surface_m2"].value == 102.5
    assert all(fact.source_page == 3 for fact in facts)
