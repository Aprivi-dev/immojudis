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
