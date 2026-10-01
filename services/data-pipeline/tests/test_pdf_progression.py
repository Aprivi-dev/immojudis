"""Bounded PDF document progression and cold-checkpoint regression tests."""

from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path

import pytest

from src import pdf_enrichment, pdf_fact_extraction
from src.freshness import document_fingerprint, documents_are_current, timestamp_is_fresh
from src.models import AuctionSale
from src.pdf_progress import (
    PDF_TEXT_CACHE_VERSION,
    merge_modern_payloads,
    read_modern_cache,
    stale_complete_document_urls,
)
from src.storage import supabase_client as storage

selection = importlib.import_module("src.pdf_document_selection")


def _sale_with_documents(count: int = 16) -> AuctionSale:
    documents = []
    for index in range(count):
        url = f"https://example.test/progression/document-{index:02d}.pdf"
        documents.append(
            {
                "label": f"Document {index:02d}",
                "url": url,
                "type": "pdf",
                "document_type": "pdf",
                "sha256": hashlib.sha256(f"bytes-{index}".encode()).hexdigest(),
            }
        )
    return AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/progression-sale",
        documents=documents,
    )


def _payload(document: dict[str, str], *, complete: bool = True) -> dict[str, object]:
    url = document["url"]
    text = f"Texte officiel pour {url}."
    return {
        **document,
        "file_path": f"/worker-only/{Path(url).stem}.pdf",
        "text": text,
        "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "text_chars": len(text),
        "page_text_chars": len(text),
        "pages": [{"page": 1, "text": text, "status": "extracted" if complete else "failed"}],
        "page_count": 1,
        "ocr_pages": 0,
        "empty_pages": 0,
        "blank_pages": [],
        "visual_blank_pages": [],
        "extraction_method": "pymupdf_pages",
        "confidence": 0.9,
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "complete": complete,
        "failed_pages": [] if complete else [1],
        "extraction_status": "extracted" if complete else "incomplete",
    }


def _isolate_pdf_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(selection, "load_settings", lambda: {"pdf_max_documents_per_sale": 6})
    monkeypatch.setattr(pdf_enrichment, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    # freshness imports this path from config at call time, whereas the two
    # writers above retain their module-level aliases.
    import src.config as config

    monkeypatch.setattr(config, "PDF_TEXTS_DIR", tmp_path)


def _record_pass(
    sale: AuctionSale,
    selected: list[dict[str, str]],
    payloads: list[dict[str, object]],
) -> list[dict[str, object]]:
    cache_path = Path(pdf_enrichment.PDF_TEXTS_DIR) / f"{pdf_enrichment.sale_storage_id(sale)}.json"
    previous_cache = read_modern_cache(cache_path) if cache_path.exists() else []
    merged = merge_modern_payloads(previous_cache, payloads, documents=sale.documents)
    pdf_enrichment._write_pdf_text_cache(sale, merged)
    selection._store_document_analysis_status(
        sale,
        selected,
        payloads,
        merged_pdf_texts=merged,
    )
    return merged


def test_writer_progresses_sixteen_documents_in_bounded_passes(monkeypatch, tmp_path: Path) -> None:
    _isolate_pdf_cache(monkeypatch, tmp_path)
    sale = _sale_with_documents()
    selected_urls: list[str] = []
    pass_sizes: list[int] = []

    for _ in range(3):
        selected = selection._select_documents_for_extraction(sale.documents, sale=sale)
        current = [_payload(document) for document in selected]
        pass_sizes.append(len(selected))
        selected_urls.extend(document["url"] for document in selected)
        _record_pass(sale, selected, current)

    assert pass_sizes == [6, 6, 4]
    assert len(selected_urls) == len(set(selected_urls)) == 16
    assert sale.raw_payload["document_analysis"]["manifest_complete"] is True
    assert sale.raw_payload["document_analysis"]["pending_document_urls"] == []
    assert sale.raw_payload["document_analysis"]["last_successful_check_at"]
    assert documents_are_current(sale)
    cache = json.loads((tmp_path / f"{pdf_enrichment.sale_storage_id(sale)}.json").read_text())
    assert len(cache) == 16
    assert {item["url"] for item in cache} == set(selected_urls)


def test_legacy_progress_and_legacy_cache_do_not_advance_cursor(monkeypatch, tmp_path: Path) -> None:
    _isolate_pdf_cache(monkeypatch, tmp_path)
    sale = _sale_with_documents(2)
    first = sale.documents[0]
    sale.raw_payload["document_analysis"] = {
        "progress_schema_version": 1,
        "input_fingerprint": document_fingerprint(sale.documents),
        "document_progress": [
            {
                "url": first["url"],
                "complete": True,
                "extraction_status": "extracted",
                "sha256": "legacy-sha",
            }
        ],
    }

    selected = selection._select_documents_for_extraction(sale.documents, sale=sale)
    assert [document["url"] for document in selected] == [document["url"] for document in sale.documents]

    legacy = {
        "url": first["url"],
        "text": "legacy text",
        "sha256": "legacy-sha",
        "complete": True,
        "extraction_status": "extracted",
    }
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps([legacy]), encoding="utf-8")
    assert read_modern_cache(path) == []
    assert merge_modern_payloads([legacy], []) == []

    corrupted = _payload(first)
    corrupted["text_chars"] = 1
    path.write_text(json.dumps([corrupted]), encoding="utf-8")
    assert read_modern_cache(path) == []


def test_sha_change_reopens_a_complete_document(monkeypatch, tmp_path: Path) -> None:
    _isolate_pdf_cache(monkeypatch, tmp_path)
    sale = _sale_with_documents(2)
    first, second = sale.documents
    first_payload = _payload(first)
    second_payload = _payload(second)
    analysis = {
        "progress_schema_version": 1,
        "input_fingerprint": document_fingerprint(sale.documents),
        "document_progress": [
            {key: value for key, value in first_payload.items() if key in {
                "url", "cache_version", "sha256", "complete", "extraction_status", "failed_pages",
            }},
            {key: value for key, value in second_payload.items() if key in {
                "url", "cache_version", "sha256", "complete", "extraction_status", "failed_pages",
            }},
        ],
    }
    sale.raw_payload["document_analysis"] = analysis
    first["sha256"] = hashlib.sha256(b"new-bytes").hexdigest()
    selected = selection._select_documents_for_extraction(sale.documents, sale=sale)
    assert first["url"] in {document["url"] for document in selected}


def test_recovered_terminal_marker_is_cleared_by_new_success(monkeypatch, tmp_path: Path) -> None:
    _isolate_pdf_cache(monkeypatch, tmp_path)
    sale = _sale_with_documents(1)
    document = sale.documents[0]
    sale.raw_payload["document_analysis"] = {
        "terminal_document_urls": [document["url"]],
        "permanent_document_failures": [{"url": document["url"], "reason": "old failure"}],
        "blocked_document_urls": [document["url"]],
    }
    payload = _payload(document)
    selection._store_document_analysis_status(
        sale,
        [document],
        [payload],
        merged_pdf_texts=[payload],
    )
    analysis = sale.raw_payload["document_analysis"]
    assert analysis["terminal_document_urls"] == []
    assert analysis["permanent_document_failures"] == []
    assert analysis["blocked_document_urls"] == []
    assert analysis["manifest_complete"] is True


def test_terminal_http_exclusions_revalidate_by_url_but_social_skips_stay_skipped(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _isolate_pdf_cache(monkeypatch, tmp_path)
    blocked_url = "https://www.licitor.com/data/pub/media/auction/blocked.pdf"
    permanent_url = "https://documents.example/missing.pdf"
    empty_url = "https://documents.example/empty.pdf"
    social_url = "https://www.facebook.com/auction/123"
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://example.test/terminal-ttl-sale",
        documents=[
            {"label": "Bloqué", "url": blocked_url, "document_type": "pdf"},
            {"label": "Absent", "url": permanent_url, "document_type": "pdf"},
            {"label": "Vide", "url": empty_url, "document_type": "pdf"},
            {"label": "Facebook", "url": social_url, "document_type": "pdf"},
        ],
    )
    old_checked_at = "2020-01-01T00:00:00+00:00"
    sale.raw_payload["document_analysis"] = {
        "progress_schema_version": 1,
        "input_fingerprint": document_fingerprint(sale.documents),
        "manifest_complete": True,
        "failed_documents": 0,
        "blocked_document_urls": [blocked_url],
        "permanent_document_failures": [{"url": permanent_url, "reason": "not_found"}],
        "terminal_document_urls": [permanent_url, empty_url],
        "skipped_document_urls": [social_url],
        "skipped_document_reasons": [{"url": social_url, "reason": "social_url"}],
        "http_checked_at_by_url": {
            blocked_url: old_checked_at,
            permanent_url: old_checked_at,
            empty_url: old_checked_at,
            social_url: old_checked_at,
        },
        "http_revalidation_pending_urls": [],
    }

    stale = stale_complete_document_urls(
        sale.raw_payload["document_analysis"],
        sale.documents,
        tmp_path,
        lambda document: Path(document["url"]).name,
    )
    assert stale == {blocked_url, permanent_url, empty_url}
    selected = selection._select_documents_for_extraction(
        sale.documents,
        sale=sale,
        revalidate_urls=stale,
    )
    assert {document["url"] for document in selected} == {blocked_url, permanent_url, empty_url}

    # A fresh recheck updates only the attempted terminal URLs. The social
    # candidate remains a deterministic skip and is never put back in scope.
    _store = selection._store_document_analysis_status
    _store(
        sale,
        [],
        [],
        blocked_document_urls=[blocked_url],
        permanent_document_failures=[{"url": permanent_url, "reason": "not_found"}],
    )
    analysis = sale.raw_payload["document_analysis"]
    assert timestamp_is_fresh(analysis["http_checked_at_by_url"][blocked_url])
    assert timestamp_is_fresh(analysis["http_checked_at_by_url"][permanent_url])
    assert analysis["http_checked_at_by_url"][empty_url] == old_checked_at
    assert stale_complete_document_urls(
        analysis,
        sale.documents,
        tmp_path,
        lambda document: Path(document["url"]).name,
    ) == {empty_url}
    assert social_url not in analysis["http_revalidation_pending_urls"]


def test_cold_partial_restore_materializes_modern_checkpoint_without_promoting_manifest(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _isolate_pdf_cache(monkeypatch, tmp_path)
    sale = _sale_with_documents()
    selected = selection._select_documents_for_extraction(sale.documents, sale=sale)
    payloads = [_payload(document) for document in selected]
    _record_pass(sale, selected, payloads)
    cache_path = tmp_path / f"{pdf_enrichment.sale_storage_id(sale)}.json"
    cache_path.unlink()

    row = {
        "source_url": sale.source_url,
        "provider": storage.PDF_EXTRACTION_PROVIDER,
        "model": storage.PDF_EXTRACTION_MODEL,
        "schema_version": storage.PDF_EXTRACTION_SCHEMA_VERSION,
        "result": payloads,
        "updated_at": "2026-09-30T00:00:00+00:00",
    }
    monkeypatch.setattr(
        storage,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(storage, "_read_persisted_pdf_rows_rest", lambda *_args: [row])

    restored = storage.restore_persisted_pdf_progress_for_sale(sale)
    assert len(restored) == 6
    assert all(item["_persisted_pdf_proof"] is True for item in restored)
    assert cache_path.exists()
    assert not documents_are_current(sale)
    assert sale.raw_payload["document_analysis"]["manifest_complete"] is False
