from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import fitz
import httpx
import pytest

import src.information_agent_evidence as evidence
from src.information_agent_evidence import (
    EvidenceFact,
    analyze_evidence_bytes,
    detect_mime_type,
    extract_evidence_facts,
)
from src.information_agent_semantic import PhotoSemanticAnalysis, SemanticAnalysis, SemanticFact


def _pdf_bytes(text: str) -> bytes:
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), text)
    content = document.tobytes()
    document.close()
    return content


def _png_header(width: int, height: int) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\rIHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
    )


def _heic_dimension_fixture(width: int = 100, height: int = 80) -> bytes:
    content = bytearray(96)
    content[4:8] = b"ftyp"
    content[8:12] = b"heic"
    content[48:52] = b"ispe"
    content[56:60] = width.to_bytes(4, "big")
    content[60:64] = height.to_bytes(4, "big")
    return bytes(content)


def _pixmap_png(width: int = 64, height: int = 48) -> bytes:
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), False)
    pixmap.clear_with(0xD0D0D0)
    return pixmap.tobytes("png")


def test_detects_real_file_signature_instead_of_trusting_extension() -> None:
    assert detect_mime_type(b"%PDF-1.7\n") == "application/pdf"
    assert detect_mime_type(b"\x89PNG\r\n\x1a\nrest") == "image/png"
    assert detect_mime_type(b"plain UTF-8 text") == "text/plain"


def test_does_not_classify_arbitrary_latin1_bytes_as_plain_text() -> None:
    assert detect_mime_type(b"\xff\xfe\xfd\xfa\xf9\xf8") is None


def test_extracts_date_type_and_address_candidates_with_page_provenance() -> None:
    facts = extract_evidence_facts(
        [
            {
                "page": 2,
                "text": (
                    "Appartement T3, adresse : 12 rue des Lilas, Bordeaux. "
                    "Date de la vente : 07/11/2026."
                ),
            }
        ]
    )
    by_key = {fact.fact_key: fact for fact in facts}
    assert by_key["property_type"].value == "apartment"
    assert by_key["address"].value == "12 rue des Lilas, Bordeaux"
    assert by_key["sale_date"].value == "2026-11-07"
    assert all(fact.source_page == 2 for fact in facts)


def test_rejects_declared_mime_mismatch() -> None:
    analysis = analyze_evidence_bytes(
        b"%PDF-1.7\n",
        filename="photo.jpg",
        declared_mime_type="image/jpeg",
        ocr_enabled=False,
    )
    assert analysis.status == "unsupported"
    assert analysis.error_code == "MIME_MISMATCH"


def test_heic_is_marked_unsupported_when_no_safe_decoder_can_open_it() -> None:
    analysis = analyze_evidence_bytes(
        _heic_dimension_fixture(),
        filename="iphone.heic",
        declared_mime_type="image/heic",
        ocr_enabled=False,
    )

    assert analysis.status == "unsupported"
    assert analysis.error_code == "IMAGE_FORMAT_UNSUPPORTED"


def test_photo_is_normalized_for_vision_without_exif_or_large_dimensions() -> None:
    normalized = evidence._prepare_image_for_vision(_pixmap_png(2_400, 1_800), "image/png")

    assert normalized is not None
    content, mime_type = normalized
    assert mime_type == "image/jpeg"
    assert len(content) <= 2 * 1024 * 1024
    assert evidence._read_image_dimensions(content, mime_type)[0] <= 1_600
    assert evidence._read_image_dimensions(content, mime_type)[1] <= 1_600


def test_photo_description_is_visible_in_summary_but_stays_review_only() -> None:
    analysis = analyze_evidence_bytes(
        _pixmap_png(),
        filename="photo.png",
        declared_mime_type="image/png",
        ocr_enabled=False,
    )
    described = evidence._append_photo_summary(
        analysis,
        PhotoSemanticAnalysis(
            "completed",
            description="Une fenêtre et un mur clair sont visibles.",
            model="qwen/qwen3-7-plus",
        ),
    )

    assert "Observation visuelle à revoir" in (described.summary or "")
    assert "Une fenêtre et un mur clair" in (described.summary or "")
    assert described.facts == analysis.facts


def test_photo_failure_is_visible_as_manual_review_required() -> None:
    analysis = analyze_evidence_bytes(
        _pixmap_png(),
        filename="photo.png",
        declared_mime_type="image/png",
        ocr_enabled=False,
    )
    unavailable = evidence._append_photo_summary(
        analysis,
        PhotoSemanticAnalysis("unavailable", error_code="VISION_PROVIDER_ERROR"),
    )

    assert "Analyse visuelle indisponible" in (unavailable.summary or "")
    assert "vérification manuelle" in (unavailable.summary or "")
    assert "VISION_PROVIDER_ERROR" not in (unavailable.summary or "")


def test_rejects_image_dimensions_before_decoder_allocation() -> None:
    analysis = analyze_evidence_bytes(
        _png_header(100_000, 100_000),
        filename="photo.png",
        declared_mime_type="image/png",
        ocr_enabled=False,
    )

    assert analysis.status == "unsupported"
    assert analysis.error_code == "IMAGE_DIMENSIONS_EXCEEDED"


def test_rejects_image_when_dimensions_cannot_be_verified() -> None:
    analysis = analyze_evidence_bytes(
        b"\xff\xd8\xff\xe0\x00\x02",
        filename="photo.jpg",
        declared_mime_type="image/jpeg",
        ocr_enabled=False,
    )

    assert analysis.status == "unsupported"
    assert analysis.error_code == "IMAGE_DIMENSIONS_UNREADABLE"


def test_rejects_image_with_valid_header_but_invalid_encoded_body() -> None:
    analysis = analyze_evidence_bytes(
        _png_header(100, 80),
        filename="corrupted.png",
        declared_mime_type="image/png",
        ocr_enabled=False,
    )

    assert analysis.status == "unsupported"
    assert analysis.error_code == "INVALID_IMAGE"


def test_rejects_compressed_image_that_would_exceed_decoded_memory_limit() -> None:
    analysis = analyze_evidence_bytes(
        _png_header(5_000, 4_000),
        filename="photo.png",
        declared_mime_type="image/png",
        ocr_enabled=False,
    )

    assert analysis.status == "unsupported"
    assert analysis.error_code == "IMAGE_DECOMPRESSION_LIMIT"


def test_skips_ocr_for_an_oversized_pdf_page_without_decoding_it(monkeypatch) -> None:
    document = fitz.open()
    document.new_page(width=6_000, height=6_000)
    content = document.tobytes()
    document.close()
    monkeypatch.setattr(
        evidence,
        "_ocr_pdf_page",
        lambda *args, **kwargs: pytest.fail("oversized page must not reach OCR"),
    )

    analysis = analyze_evidence_bytes(
        content,
        filename="plan-grand-format.pdf",
        declared_mime_type="application/pdf",
        ocr_enabled=True,
    )

    assert analysis.status == "completed"
    assert analysis.pages[0]["method"] == "ocr_skipped_dimensions"


def test_pdf_ocr_timeout_kills_the_isolated_process(monkeypatch, tmp_path) -> None:
    class HangingProcess:
        pid = 1234
        returncode = None

        def __init__(self) -> None:
            self.killed = False

        def poll(self):
            return None if not self.killed else -9

        def communicate(self, timeout=None):
            if not self.killed:
                raise subprocess.TimeoutExpired("ocr", timeout)
            return "", ""

        def kill(self):
            self.killed = True

    process = HangingProcess()
    killed_groups: list[tuple[int, int]] = []
    monkeypatch.setattr(evidence.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(evidence.os, "killpg", lambda pid, signum: killed_groups.append((pid, signum)))

    text, method, confidence = evidence._ocr_pdf_page(
        SimpleNamespace(number=0),
        "Fallback text",
        source_path=tmp_path / "evidence.pdf",
        timeout_seconds=0.01,
    )

    assert (text, method, confidence) == ("Fallback text", "ocr_timeout", 0.45)
    assert killed_groups == [(1234, evidence.signal.SIGKILL)]


def test_image_ocr_timeout_kills_the_isolated_process(monkeypatch) -> None:
    class HangingProcess:
        pid = 5678
        returncode = None

        def __init__(self) -> None:
            self.killed = False

        def poll(self):
            return None if not self.killed else -9

        def communicate(self, timeout=None):
            if not self.killed:
                raise subprocess.TimeoutExpired("tesseract", timeout)
            return "", ""

        def kill(self):
            self.killed = True

    process = HangingProcess()
    killed_groups: list[tuple[int, int]] = []
    monkeypatch.setattr(evidence.shutil, "which", lambda name: "/usr/bin/tesseract")
    monkeypatch.setattr(evidence.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(evidence.os, "killpg", lambda pid, signum: killed_groups.append((pid, signum)))

    assert evidence._ocr_image_bytes(b"fixture", "image/jpeg") == ""
    assert killed_groups == [(5678, evidence.signal.SIGKILL)]


def test_attachment_ocr_is_independent_from_catalogue_pdf_ocr_setting(monkeypatch) -> None:
    monkeypatch.delenv("INFORMATION_AGENT_EVIDENCE_OCR_ENABLED", raising=False)
    assert evidence._evidence_ocr_enabled({"pdf_ocr_enabled": False}) is True
    assert evidence._evidence_ocr_enabled({"information_agent_evidence_ocr_enabled": False}) is False
    assert evidence._evidence_ocr_enabled({"information_agent_evidence_ocr_enabled": "false"}) is False


def test_pdf_ocr_child_can_import_the_module_from_the_service_root(tmp_path) -> None:
    source_path = tmp_path / "evidence.pdf"
    source_path.write_bytes(_pdf_bytes("Texte de contrôle"))
    service_root = Path(evidence.__file__).resolve().parents[1]

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "src.information_agent_evidence",
            "--ocr-pdf-page",
            str(source_path),
            "0",
        ],
        cwd=service_root,
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert isinstance(payload, dict)
    assert "text" in payload or "error" in payload


def test_password_protected_pdf_remains_unpublished() -> None:
    document = fitz.open()
    document.new_page()
    content = document.tobytes(
        encryption=fitz.PDF_ENCRYPT_AES_256,
        owner_pw="owner-fixture",
        user_pw="secret-fixture",
    )
    document.close()

    analysis = analyze_evidence_bytes(
        content,
        filename="diagnostic-protege.pdf",
        declared_mime_type="application/pdf",
        ocr_enabled=False,
    )

    assert analysis.status == "needs_password"
    assert analysis.facts == []
    assert analysis.error_code == "PDF_PASSWORD_REQUIRED"


def test_scanned_pdf_requires_ocr_to_extract_facts(monkeypatch) -> None:
    document = fitz.open()
    document.new_page()
    content = document.tobytes()
    document.close()

    without_ocr = analyze_evidence_bytes(
        content,
        filename="pv-scanne.pdf",
        declared_mime_type="application/pdf",
        ocr_enabled=False,
    )
    monkeypatch.setattr(
        evidence,
        "_ocr_pdf_page",
        lambda page, fallback, **kwargs: ("Surface habitable : 82 m2", "ocr_fixture", 0.74),
    )
    with_ocr = analyze_evidence_bytes(
        content,
        filename="pv-scanne.pdf",
        declared_mime_type="application/pdf",
        ocr_enabled=True,
    )

    assert without_ocr.facts == []
    assert next(fact for fact in with_ocr.facts if fact.fact_key == "surface_m2").value == 82


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


def test_conflicting_values_are_kept_for_audit_but_not_inserted_as_candidates() -> None:
    facts = extract_evidence_facts(
        [
            {
                "page": 1,
                "text": "Surface habitable : 82 m2. Surface habitable : 91 m2.",
            }
        ]
    )
    assert {fact.value for fact in facts if fact.fact_key == "surface_m2"} == {82.0, 91.0}

    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json=[])

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._insert_fact_candidates(
            client,
            "https://local.example.test",
            "fixture-key",
            {
                "asset_id": "asset-a",
                "case_id": "case-a",
                "message_id": "message-a",
                "sale_id": "sale-a",
            },
            facts,
            {},
        )

    assert requests == []


def test_placeholder_and_low_confidence_values_are_not_candidate_rows() -> None:
    facts = [
        EvidenceFact(
            "visit_information",
            "Visite : non communiquée",
            "Visite : non communiquée",
            "Visite : non communiquée",
            0.72,
            1,
        ),
        EvidenceFact("rooms_count", 4, "4 pièce(s)", "4 pièces", 0.49, 1),
    ]
    assert evidence._candidate_facts_for_insertion(facts) == []


def test_sale_conflicts_cover_new_scalar_fields() -> None:
    assert evidence._conflicts_with_sale(
        EvidenceFact("sale_date", "2026-11-07", "2026-11-07", "date", 0.9, 1),
        {"sale_date": "2026-11-08"},
    )
    assert evidence._conflicts_with_sale(
        EvidenceFact("property_type", "house", "house", "maison", 0.9, 1),
        {"property_type": "apartment"},
    )
    assert evidence._conflicts_with_sale(
        EvidenceFact("address", "12 rue des Lilas", "12 rue des Lilas", "adresse", 0.9, 1),
        {"address": "14 rue des Lilas"},
    )


def test_worker_keeps_document_facts_on_the_case_sale(monkeypatch) -> None:
    content = _pdf_bytes("Surface habitable : 87 m2 - 4 pieces")
    job = {
        "id": "extraction-a",
        "asset_id": "asset-a",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "attempts": 1,
    }
    asset = {
        "id": "asset-a",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "storage_bucket": "information-agent-evidence",
        "storage_path": "case-a/message-a/document.pdf",
        "original_filename": "document.pdf",
        "mime_type": "application/pdf",
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith("/information_agent_evidence_assets"):
            return httpx.Response(200, json=[asset])
        if path.endswith("/information-agent-evidence/case-a/message-a/document.pdf"):
            return httpx.Response(200, content=content)
        if path.endswith("/auction_sales"):
            assert request.url.params["id"] == "eq.sale-a"
            return httpx.Response(200, json=[{"surface_m2": 70, "rooms_count": None}])
        if path.endswith("/information_agent_fact_candidates"):
            return httpx.Response(201, json=[])
        if path.endswith("/information_agent_evidence_extractions"):
            return httpx.Response(204)
        if path.endswith("/information_agent_cases") and request.method == "GET":
            return httpx.Response(200, json=[{"status": "replied"}])
        if path.endswith("/information_agent_cases"):
            return httpx.Response(204)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    monkeypatch.setattr(evidence, "load_settings", lambda: {"pdf_ocr_enabled": False})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._process_job(client, "https://local.example.test", "fixture-key", job)

    candidate_request = next(
        request for request in requests if request.url.path.endswith("/information_agent_fact_candidates")
    )
    candidates = json.loads(candidate_request.content)
    assert candidate_request.url.params["on_conflict"] == (
        "message_id,fact_key,evidence_asset_id,source_page,display_value"
    )
    assert {row["fact_key"] for row in candidates} == {"surface_m2", "rooms_count"}
    assert all(
        row["case_id"] == "case-a"
        and row["message_id"] == "message-a"
        and row["sale_id"] == "sale-a"
        and row["evidence_asset_id"] == "asset-a"
        and row["source_page"] == 1
        for row in candidates
    )
    assert next(row for row in candidates if row["fact_key"] == "surface_m2")["status"] == "conflict"
    assert any(request.url.path.endswith("/information_agent_cases") for request in requests)
    finish_payload = json.loads(
        next(
            request.content
            for request in requests
            if request.method == "PATCH"
            and request.url.path.endswith("/information_agent_evidence_extractions")
        )
    )
    assert finish_payload["metadata"]["content_trust"] == "untrusted_external_evidence"
    assert finish_payload["metadata"]["prompt_instructions_ignored"] is True


def test_worker_does_not_duplicate_body_fact_already_persisted_by_inbound(monkeypatch) -> None:
    content = b"Surface habitable : 87 m2"
    job = {
        "id": "extraction-body",
        "asset_id": "asset-body",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "attempts": 1,
    }
    asset = {
        "id": "asset-body",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "storage_bucket": "information-agent-evidence",
        "storage_path": "case-a/message-a/email-body.txt",
        "original_filename": "email-body.txt",
        "mime_type": "text/plain",
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "metadata": {"evidence_kind": "email_body"},
    }
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith("/information_agent_evidence_assets"):
            return httpx.Response(200, json=[asset])
        if path.endswith("/information-agent-evidence/case-a/message-a/email-body.txt"):
            return httpx.Response(200, content=content)
        if path.endswith("/information_agent_cases") and request.method == "GET":
            return httpx.Response(200, json=[{"status": "replied"}])
        if path.endswith("/auction_sales"):
            return httpx.Response(200, json=[{}])
        if path.endswith("/information_agent_fact_candidates") and request.method == "GET":
            assert request.url.params["evidence_asset_id"] == "is.null"
            return httpx.Response(
                200,
                json=[
                    {
                        "fact_key": "surface_m2",
                        "proposed_value": {"value": 87},
                        "evidence_asset_id": None,
                    }
                ],
            )
        if path.endswith("/information_agent_evidence_extractions"):
            return httpx.Response(204)
        if path.endswith("/information_agent_cases"):
            return httpx.Response(204)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    monkeypatch.setattr(evidence, "load_settings", lambda: {"information_agent_evidence_ocr_enabled": False})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._process_job(client, "https://local.example.test", "fixture-key", job)

    assert not any(
        request.method == "POST" and request.url.path.endswith("/information_agent_fact_candidates")
        for request in requests
    )
    finish_payload = json.loads(
        next(
            request.content
            for request in requests
            if request.method == "PATCH"
            and request.url.path.endswith("/information_agent_evidence_extractions")
        )
    )
    assert finish_payload["extracted_facts"][0]["fact_key"] == "surface_m2"


def test_worker_persists_optional_semantic_facts_as_pending_with_provenance(monkeypatch) -> None:
    content = _pdf_bytes("Le bien est situé au 12 rue des Lilas")
    job = {
        "id": "extraction-a",
        "asset_id": "asset-a",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "attempts": 1,
    }
    asset = {
        "id": "asset-a",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "storage_bucket": "information-agent-evidence",
        "storage_path": "case-a/message-a/document.pdf",
        "original_filename": "document.pdf",
        "mime_type": "application/pdf",
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    semantic_fact = SemanticFact(
        fact_key="address",
        value="12 rue des Lilas",
        display_value="12 rue des Lilas",
        evidence_excerpt="12 rue des Lilas",
        confidence=0.87,
        source_page=1,
    )
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith("/information_agent_evidence_assets"):
            return httpx.Response(200, json=[asset])
        if path.endswith("/information-agent-evidence/case-a/message-a/document.pdf"):
            return httpx.Response(200, content=content)
        if path.endswith("/information_agent_cases") and request.method == "GET":
            return httpx.Response(200, json=[{"status": "replied"}])
        if path.endswith("/auction_sales"):
            return httpx.Response(200, json=[{}])
        if path.endswith("/information_agent_fact_candidates"):
            return httpx.Response(201, json=[])
        if path.endswith("/information_agent_evidence_extractions"):
            return httpx.Response(204)
        if path.endswith("/information_agent_cases"):
            return httpx.Response(204)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    monkeypatch.setattr(evidence, "load_settings", lambda: {"information_agent_evidence_ocr_enabled": False})
    monkeypatch.setattr(
        evidence,
        "run_configured_semantic_analysis",
        lambda pages, settings: SemanticAnalysis("completed", [semantic_fact], model="fixture-model"),
    )
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._process_job(client, "https://local.example.test", "fixture-key", job)

    candidate_request = next(
        request for request in requests if request.url.path.endswith("/information_agent_fact_candidates")
    )
    candidates = json.loads(candidate_request.content)
    address = next(row for row in candidates if row["fact_key"] == "address")
    assert address["extraction_method"] == "semantic_evidence_v1"
    assert address["status"] == "pending"
    assert address["source_page"] == 1
    finish_payload = json.loads(
        next(
            request.content
            for request in requests
            if request.method == "PATCH"
            and request.url.path.endswith("/information_agent_evidence_extractions")
        )
    )
    assert finish_payload["metadata"]["semantic"]["status"] == "completed"
    assert finish_payload["metadata"]["semantic"]["review_required"] is True


def test_worker_does_not_create_candidates_for_closed_case(monkeypatch) -> None:
    content = _pdf_bytes("Surface habitable : 87 m2")
    job = {
        "id": "extraction-a",
        "asset_id": "asset-a",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "attempts": 1,
    }
    asset = {
        "id": "asset-a",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "storage_bucket": "information-agent-evidence",
        "storage_path": "case-a/message-a/document.pdf",
        "original_filename": "document.pdf",
        "mime_type": "application/pdf",
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith("/information_agent_evidence_assets"):
            return httpx.Response(200, json=[asset])
        if path.endswith("/information-agent-evidence/case-a/message-a/document.pdf"):
            return httpx.Response(200, content=content)
        if path.endswith("/information_agent_cases") and request.method == "GET":
            return httpx.Response(200, json=[{"status": "completed"}])
        if path.endswith("/information_agent_evidence_extractions"):
            return httpx.Response(204)
        if path.endswith("/information_agent_cases"):
            return httpx.Response(204)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    monkeypatch.setattr(evidence, "load_settings", lambda: {"pdf_ocr_enabled": False})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._process_job(client, "https://local.example.test", "fixture-key", job)

    assert not any(request.url.path.endswith("/information_agent_fact_candidates") for request in requests)


def test_worker_rejects_an_asset_attached_to_another_sale() -> None:
    job = {
        "id": "extraction-a",
        "asset_id": "asset-a",
        "case_id": "case-a",
        "message_id": "message-a",
        "sale_id": "sale-a",
        "attempts": 1,
    }
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/information_agent_evidence_assets"):
            return httpx.Response(200, json=[{
                "id": "asset-a", "case_id": "case-a", "message_id": "message-a", "sale_id": "sale-b"
            }])
        if request.url.path.endswith("/information_agent_evidence_extractions"):
            return httpx.Response(204)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._process_job(client, "https://local.example.test", "fixture-key", job)

    assert len(requests) == 2
    failure = json.loads(requests[-1].content)
    assert failure["status"] == "failed"
    assert "association mismatch" in failure["error_message"]


def test_worker_rejects_changed_attachment_bytes() -> None:
    asset = {
        "storage_bucket": "information-agent-evidence",
        "storage_path": "case-a/message-a/document.pdf",
        "size_bytes": 7,
        "sha256": hashlib.sha256(b"trusted").hexdigest(),
    }

    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"changed")
    )) as client:
        with pytest.raises(RuntimeError, match="checksum mismatch"):
            evidence._download_asset(client, "https://local.example.test", "fixture-key", asset)


def test_failure_update_is_bound_to_the_current_processing_lease() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(204)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._fail_job(
            client,
            "https://local.example.test",
            "fixture-key",
            "extraction-a",
            2,
            "fixture failure",
            locked_at="2026-09-28T08:00:00+00:00",
        )

    assert requests[0].url.params["id"] == "eq.extraction-a"
    assert requests[0].url.params["status"] == "eq.processing"
    assert requests[0].url.params["attempts"] == "eq.2"
    assert requests[0].url.params["locked_at"] == "eq.2026-09-28T08:00:00+00:00"


def test_same_fact_from_two_assets_keeps_asset_provenance() -> None:
    requests: list[httpx.Request] = []
    fact = EvidenceFact(
        "surface_m2",
        87,
        "87 m2",
        "Surface habitable : 87 m2",
        0.9,
        1,
    )

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json=[])

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        for asset_id in ("asset-a", "asset-b"):
            evidence._insert_fact_candidates(
                client,
                "https://local.example.test",
                "fixture-key",
                {
                    "asset_id": asset_id,
                    "case_id": "case-a",
                    "message_id": "message-a",
                    "sale_id": "sale-a",
                },
                [fact],
                {},
            )

    assert len(requests) == 2
    assert {
        json.loads(request.content)[0]["evidence_asset_id"]
        for request in requests
    } == {"asset-a", "asset-b"}
    assert all(
        request.url.params["on_conflict"]
        == "message_id,fact_key,evidence_asset_id,source_page,display_value"
        for request in requests
    )
