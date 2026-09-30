import hashlib
import json
import shutil
import time
from datetime import UTC, datetime
from types import SimpleNamespace

import fitz
import pytest

from src import main, pdf_enrichment, pipeline_health, queued_runner
from src.enrichment import extract_structured as extraction
from src.models import AuctionSale


def test_backfill_commits_before_next_result_even_if_interrupted(monkeypatch):
    monkeypatch.delenv("GITHUB_ENV", raising=False)
    sales = [AuctionSale(source_name="avoventes", source_url=f'https://example.test/{i}', description='Maison à Bordeaux.', starting_price_eur=10000, last_seen_at=datetime(2026, 1, 1, tzinfo=UTC)) for i in range(2)]
    stored = []
    monkeypatch.setattr(main, 'fetch_sales_needing_llm_descriptions', lambda **kw: sales)
    monkeypatch.setattr(main, 'create_run_in_supabase', lambda *a, **kw: 'run')
    monkeypatch.setattr(main, 'update_run_progress_in_supabase', lambda *a: None)
    monkeypatch.setattr(main, 'create_llm_client', lambda: object())
    monkeypatch.setattr(main, '_finalize_sale_for_app', lambda *a, **kw: None)
    monkeypatch.setattr(main, 'upsert_sales_to_supabase', lambda rows, **kw: stored.append((rows[0].source_url, kw, rows[0].last_seen_at)) or 1)
    def enrich(sale, **kw):
        sale.raw_payload.update(llm_display_description='Maison à Bordeaux.', llm_prompt_version=main.load_settings()['llm_prompt_version'])
        return main.LLMEnrichmentStats(analyzed=1, valid_json=1)
    monkeypatch.setattr(main, 'enrich_sale_with_llm', enrich)
    def interrupted(futures):
        yield next(iter(futures))
        raise KeyboardInterrupt()
    monkeypatch.setattr(main, 'as_completed', interrupted)
    with pytest.raises(KeyboardInterrupt):
        main.run_llm_description_backfill(main.PipelineOptions(llm_backfill=True))
    assert stored == [(sales[0].source_url, {'refresh_last_seen': False}, datetime(2026, 1, 1, tzinfo=UTC))]


@pytest.mark.parametrize('error_count,coverage,description', [(1, True, 'Résumé'), (0, False, 'Résumé'), (0, True, '')])
def test_worker_never_completes_partial_fact_job(monkeypatch, error_count, coverage, description):
    sale = AuctionSale(source_name="avoventes", source_url='https://example.test/a', description='Maison')
    finished = []
    monkeypatch.setattr(queued_runner, 'claim_auction_enrichment_jobs_from_supabase', lambda **kw: [{'id': 'job', 'source_url': sale.source_url, 'job_type': 'fact_extraction'}])
    monkeypatch.setattr(queued_runner, 'fetch_sale_for_data_refresh', lambda _: sale)
    monkeypatch.setattr(queued_runner, 'create_llm_client', lambda: object())
    def enrich(*a, **kw):
        sale.raw_payload.update(llm_display_description=description, llm_prompt_version=queued_runner.load_settings()['llm_prompt_version'], llm_fact_coverage={'complete': coverage})
        return SimpleNamespace(valid_json=1, errors=error_count, unavailable=False, error_messages=['partial'] if error_count else [])
    monkeypatch.setattr(queued_runner, 'enrich_sale_with_llm', enrich)
    monkeypatch.setattr(queued_runner, 'upsert_sales_to_supabase', lambda *a, **kw: pytest.fail('Partial data must not complete publication'))
    monkeypatch.setattr(queued_runner, 'finish_auction_enrichment_job_in_supabase', lambda job, **kw: finished.append(kw))
    queued_runner.run_enrichment_queue_batch(limit=1)
    assert finished[0]['succeeded'] is False


def test_failed_chunk_is_retried_without_paying_for_successful_chunk(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_ENABLED', 'true')
    monkeypatch.setenv('INCREMENTAL_ENRICHMENT', 'true')
    monkeypatch.setattr(extraction, 'load_llm_fact_context_chunks_for_sale', lambda *a, **kw: ['chunk-A', 'chunk-B'])
    monkeypatch.setattr(extraction, 'load_llm_context_for_sale', lambda *a, **kw: 'Maison')
    calls = []
    class Client:
        model = 'test'
        failing = True
        def is_available(self):
            return True
        def generate_json(self, system, prompt):
            calls.append(prompt)
            if 'chunk-B' in prompt and self.failing:
                raise ValueError('transient')
            return {'display_description': 'Maison décrite par les pièces.'}
    client = Client()
    sale = AuctionSale(source_name="avoventes", source_url='https://example.test/chunks', description='Maison')
    first = extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode='structured_then_display')
    assert first.errors == 1
    assert sale.raw_payload['llm_fact_coverage']['complete'] is False
    assert not list(tmp_path.glob('*.json'))
    client.failing = False
    second = extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode='structured_then_display')
    assert second.errors == 0
    assert sale.raw_payload['llm_fact_coverage']['complete'] is True
    assert sum('chunk-A' in prompt for prompt in calls) == 1
    assert sum('chunk-B' in prompt for prompt in calls) == 2


def test_long_digital_pdf_and_resumable_ocr(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf_enrichment, 'PDF_DOCUMENT_TEXTS_DIR', tmp_path / 'cache')
    monkeypatch.setenv('PDF_MAX_EXTRACT_PAGES', '2')
    monkeypatch.setenv('PDF_OCR_ENABLED', 'true')
    path = tmp_path / 'large.pdf'
    with fitz.open() as document:
        for _ in range(5):
            page = document.new_page()
            # Keep these pages scan-like rather than objectively blank: the
            # test exercises resumable OCR checkpoints and not blank-page
            # exclusion.
            page.draw_rect(fitz.Rect(72, 72, 200, 200), color=(0, 0, 0), fill=(0, 0, 0))
        document.save(path)
    processed = []
    monkeypatch.setattr(pdf_enrichment, '_extract_page_text_with_ocr_result', lambda page, **kw: processed.append(page.number) or {'text': 'Texte OCR', 'method': 'ocr_test', 'confidence': .8})
    for _ in range(2):
        with pytest.raises(ValueError, match='retry resumes'):
            pdf_enrichment.extract_pdf_pages(path)
    pages = pdf_enrichment.extract_pdf_pages(path)
    assert len(pages) == 5
    assert processed == list(range(5))
    monkeypatch.setenv('PDF_OCR_ENABLED', 'false')
    assert len(pdf_enrichment.extract_pdf_pages(path)) == 5


def test_ocr_budget_checkpoint_is_distinct_and_continues_from_page_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf_enrichment, 'PDF_DOCUMENT_TEXTS_DIR', tmp_path / 'cache')
    monkeypatch.setenv('PDF_MAX_EXTRACT_PAGES', '1')
    monkeypatch.setenv('PDF_OCR_ENABLED', 'true')
    path = tmp_path / 'checkpointed.pdf'
    with fitz.open() as document:
        for _ in range(3):
            page = document.new_page()
            page.draw_rect(fitz.Rect(72, 72, 200, 200), color=(0, 0, 0), fill=(0, 0, 0))
        document.save(path)

    calls = []
    monkeypatch.setattr(
        pdf_enrichment,
        '_extract_page_text_with_ocr_result',
        lambda page, **kwargs: calls.append(page.number) or {
            'text': f'OCR page {page.number + 1}',
            'method': 'ocr_test',
            'confidence': .8,
        },
    )

    with pytest.raises(pdf_enrichment.PdfExtractionDeferred) as first_error:
        pdf_enrichment.extract_pdf_pages(path)
    assert first_error.value.progress_made is True
    assert first_error.value.checkpointed_pages == 1
    assert first_error.value.total_pages == 3
    assert calls == [0]

    with pytest.raises(pdf_enrichment.PdfExtractionDeferred) as second_error:
        pdf_enrichment.extract_pdf_pages(path)
    assert second_error.value.progress_made is True
    assert second_error.value.checkpointed_pages == 2
    assert calls == [0, 1]

    pages = pdf_enrichment.extract_pdf_pages(path)
    assert calls == [0, 1, 2]
    assert len(pages) == 3
    assert all(page['status'] == 'extracted' for page in pages)


def test_ocr_budget_without_new_page_progress_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf_enrichment, 'PDF_DOCUMENT_TEXTS_DIR', tmp_path / 'cache')
    monkeypatch.setenv('PDF_MAX_EXTRACT_PAGES', '1')
    monkeypatch.setenv('PDF_OCR_ENABLED', 'true')
    path = tmp_path / 'stalled-checkpoint.pdf'
    with fitz.open() as document:
        for _ in range(2):
            page = document.new_page()
            page.draw_rect(fitz.Rect(72, 72, 200, 200), color=(0, 0, 0), fill=(0, 0, 0))
        document.save(path)

    monkeypatch.setattr(
        pdf_enrichment,
        '_extract_page_text_with_ocr_result',
        lambda page, **kwargs: {'text': '', 'method': 'fallback_text', 'confidence': 0.0},
    )

    with pytest.raises(pdf_enrichment.PdfExtractionDeferred) as error:
        pdf_enrichment.extract_pdf_pages(path)
    assert error.value.progress_made is False
    assert error.value.new_progress_pages == 0
    assert error.value.checkpointed_pages == 1


def test_deadline_checkpoint_is_reused_on_next_pdf_pass(tmp_path, monkeypatch):
    monkeypatch.setattr(pdf_enrichment, 'PDF_DOCUMENT_TEXTS_DIR', tmp_path / 'cache')
    monkeypatch.setenv('PDF_MAX_EXTRACT_PAGES', '2')
    monkeypatch.setenv('PDF_OCR_ENABLED', 'true')
    path = tmp_path / 'deadline-checkpoint.pdf'
    with fitz.open() as document:
        for _ in range(2):
            page = document.new_page()
            page.draw_rect(fitz.Rect(72, 72, 200, 200), color=(0, 0, 0), fill=(0, 0, 0))
        document.save(path)

    calls = []

    def checkpoint_then_expire(page, **_kwargs):
        calls.append(page.number)
        if len(calls) == 1:
            # The page is returned and atomically checkpointed before the
            # extraction loop notices that its bounded pass has expired.
            pdf_enrichment._PDF_DEADLINE.set(time.monotonic() - 1)
        return {'text': f'OCR page {page.number + 1}', 'method': 'ocr_test', 'confidence': .8}

    monkeypatch.setattr(pdf_enrichment, '_extract_page_text_with_ocr_result', checkpoint_then_expire)

    with pytest.raises(pdf_enrichment.PdfDeadlineExceeded) as error:
        with pdf_enrichment.pdf_deadline_scope(time.monotonic() + 5):
            pdf_enrichment.extract_pdf_pages(path)
    assert error.value.checkpointed_pages == 1
    assert calls == [0]
    assert pdf_enrichment.pdf_deadline_remaining() is None

    pages = pdf_enrichment.extract_pdf_pages(path)
    assert calls == [0, 1]
    assert len(pages) == 2
    assert all(page['status'] == 'extracted' for page in pages)


def test_enrich_sale_materializes_partial_manifest_before_deferred_ocr_and_cold_restores_pages(
    tmp_path,
    monkeypatch,
):
    from src import pdf_document_selection, pdf_fact_extraction

    pdf_texts_dir = tmp_path / "pdf-texts"
    page_cache_dir = tmp_path / "page-cache"
    documents_dir = tmp_path / "documents"
    for directory in (pdf_texts_dir, page_cache_dir, documents_dir):
        directory.mkdir()
    pdf_path = documents_dir / "long.pdf"
    with fitz.open() as document:
        for _ in range(3):
            page = document.new_page()
            page.draw_rect(fitz.Rect(72, 72, 200, 200), color=(0, 0, 0), fill=(0, 0, 0))
        document.save(pdf_path)
    url = "https://example.test/partial-checkpoint.pdf"
    document = {
        "label": "PV",
        "url": url,
        "type": "pdf",
        "file_format": "pdf",
        "document_type": "pv_huissier",
        "file_path": str(pdf_path),
        "sha256": hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
        "http_checked_at": "2026-09-30T12:00:00+00:00",
    }
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/partial-sale",
        documents=[{key: value for key, value in document.items() if key not in {"file_path", "sha256", "http_checked_at"}}],
    )
    settings = {
        "user_agent": "immojudis-test",
        "request_timeout_seconds": 5,
        "incremental_enrichment": True,
        "pdf_ocr_enabled": True,
        "pdf_ocr_language": "fra",
        "pdf_ocr_tessdata": None,
        "pdf_max_download_mb": 25,
        "pdf_max_extract_pages": 1,
        "pdf_max_total_pages": 10,
        "pdf_max_documents_per_sale": 6,
        "pdf_extractor": "pymupdf",
        "pdf_docling_enabled": False,
        "pdf_docling_threshold_chars": 1000,
        "pdf_docling_timeout_seconds": 5,
        "pdf_docling_ocr_max_pages": 0,
        "pdf_docling_ocr_max_size_mb": 0,
        "pdf_docling_ocr_mode": "disabled",
        "pdf_docling_chunk_pages": 10,
        "pdf_docling_ocr_chunk_pages": 10,
    }
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: settings)
    monkeypatch.setattr(pdf_document_selection, "load_settings", lambda: settings)
    monkeypatch.setattr(pdf_enrichment, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", page_cache_dir)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(
        pdf_enrichment,
        "download_documents",
        lambda _sale, *, stats=None: [dict(document)],
    )
    ocr_pages = []
    monkeypatch.setattr(
        pdf_enrichment,
        "_extract_page_text_with_ocr_result",
        lambda page, **_kwargs: ocr_pages.append(page.number) or {
            "text": f"OCR page {page.number + 1}",
            "method": "ocr_test",
            "confidence": 0.8,
        },
    )

    with pytest.raises(pdf_enrichment.PdfExtractionDeferred) as first_error:
        pdf_enrichment.enrich_sale_from_pdfs(sale)

    aggregate_path = pdf_texts_dir / f"{pdf_enrichment.sale_storage_id(sale)}.json"
    aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))
    assert len(aggregate) == 1
    assert aggregate[0]["complete"] is False
    assert aggregate[0]["extraction_status"] == "incomplete"
    assert aggregate[0]["failed_pages"] == [2, 3]
    assert (aggregate[0].get("text_sha256") or hashlib.sha256(
        aggregate[0]["text"].encode()
    ).hexdigest()) == hashlib.sha256(aggregate[0]["text"].encode()).hexdigest()
    analysis = sale.raw_payload["document_analysis"]
    assert analysis["manifest_complete"] is False
    assert analysis["document_progress"][0]["complete"] is False
    assert analysis["last_successful_check_at"] is None
    assert ocr_pages == [0]
    assert first_error.value.partial_payload["sha256"] == document["sha256"]
    assert first_error.value.partial_payload["text_sha256"] == hashlib.sha256(
        first_error.value.partial_payload["text"].encode()
    ).hexdigest()

    aggregate[0]["_persisted_pdf_proof"] = True
    aggregate_path.write_text(json.dumps(aggregate), encoding="utf-8")
    shutil.rmtree(page_cache_dir / "pages")
    with pytest.raises(pdf_enrichment.PdfExtractionDeferred):
        pdf_enrichment.enrich_sale_from_pdfs(sale)

    assert ocr_pages == [0, 1]
    aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))
    assert aggregate[0]["failed_pages"] == [3]
    assert aggregate[0]["complete"] is False


def test_blank_page_checkpoint_survives_modern_proof_recovery_without_completion(
    tmp_path,
    monkeypatch,
):
    from src import pdf_document_selection, pdf_fact_extraction
    from src.storage import supabase_client as storage

    pdf_texts_dir = tmp_path / "pdf-texts"
    page_cache_dir = tmp_path / "page-cache"
    documents_dir = tmp_path / "documents"
    for directory in (pdf_texts_dir, page_cache_dir, documents_dir):
        directory.mkdir()
    pdf_path = documents_dir / "blank-prefix.pdf"
    with fitz.open() as document:
        document.new_page()
        page = document.new_page()
        page.draw_rect(fitz.Rect(72, 72, 200, 200), color=(0, 0, 0), fill=(0, 0, 0))
        document.save(pdf_path)

    with fitz.open(pdf_path) as document:
        assert pdf_enrichment._is_objectively_blank_page(document[0], "") is True
        assert pdf_enrichment._is_objectively_blank_page(document[1], "") is False
        assert document[1].get_text("text") == ""
        assert document[1].get_drawings()

    url = "https://example.test/blank-prefix.pdf"
    document = {
        "label": "PV",
        "url": url,
        "type": "pdf",
        "file_format": "pdf",
        "document_type": "pv_huissier",
        "file_path": str(pdf_path),
        "sha256": hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
        "http_checked_at": "2026-09-30T12:00:00+00:00",
    }
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/blank-prefix-sale",
        documents=[
            {
                key: value
                for key, value in document.items()
                if key not in {"file_path", "sha256", "http_checked_at"}
            }
        ],
    )
    settings = {
        "user_agent": "immojudis-test",
        "request_timeout_seconds": 5,
        "incremental_enrichment": True,
        "pdf_ocr_enabled": True,
        "pdf_ocr_language": "fra",
        "pdf_ocr_tessdata": None,
        "pdf_max_download_mb": 25,
        "pdf_max_extract_pages": 1,
        "pdf_max_total_pages": 10,
        "pdf_max_documents_per_sale": 6,
        "pdf_extractor": "pymupdf",
        "pdf_docling_enabled": False,
        "pdf_docling_threshold_chars": 1000,
        "pdf_docling_timeout_seconds": 5,
        "pdf_docling_ocr_max_pages": 0,
        "pdf_docling_ocr_max_size_mb": 0,
        "pdf_docling_ocr_mode": "disabled",
        "pdf_docling_chunk_pages": 10,
        "pdf_docling_ocr_chunk_pages": 10,
    }
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: settings)
    monkeypatch.setattr(pdf_document_selection, "load_settings", lambda: settings)
    assert pdf_enrichment._should_try_ocr("") is True
    monkeypatch.setattr(pdf_enrichment, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", page_cache_dir)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(
        pdf_enrichment,
        "download_documents",
        lambda _sale, *, stats=None: [dict(document)],
    )
    ocr_pages = []
    monkeypatch.setattr(
        pdf_enrichment,
        "_extract_page_text_with_ocr_result",
        lambda page, **_kwargs: ocr_pages.append(page.number + 1)
        or {"text": "OCR page 2", "method": "ocr_test", "confidence": 0.8},
    )
    original_ensure_deadline = pdf_enrichment._ensure_pdf_deadline

    def expire_before_second_page(*, operation, **kwargs):
        if operation == "starting PDF page 2":
            pdf_enrichment._PDF_DEADLINE.set(time.monotonic() - 1)
        return original_ensure_deadline(operation=operation, **kwargs)

    monkeypatch.setattr(pdf_enrichment, "_ensure_pdf_deadline", expire_before_second_page)

    with pdf_enrichment.pdf_deadline_scope(time.monotonic() + 30):
        with pytest.raises(pdf_enrichment.PdfDeadlineExceeded) as first_error:
            pdf_enrichment.enrich_sale_from_pdfs(sale)

    file_sha = document["sha256"]
    partial_payload = first_error.value.partial_payload
    assert partial_payload["text"] == ""
    assert partial_payload["text_sha256"] == ""
    assert partial_payload["sha256"] == file_sha
    assert partial_payload["complete"] is False
    assert partial_payload["failed_pages"] == [2]
    assert partial_payload["pages"] == [
        {
            "page": 1,
            "text": "",
            "chars": 0,
            "raw_text_chars": 0,
            "method": "blank_page",
            "confidence": 1.0,
            "status": "blank_excluded",
            "retryable": False,
        }
    ]
    assert first_error.value.partial_analysis["manifest_complete"] is False
    assert first_error.value.partial_analysis["last_successful_check_at"] is None
    assert first_error.value.partial_pdf_texts == [partial_payload]
    assert ocr_pages == []

    aggregate_path = pdf_texts_dir / f"{pdf_enrichment.sale_storage_id(sale)}.json"
    aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))
    assert aggregate[0]["sha256"] == file_sha
    assert aggregate[0]["text"] == ""
    assert aggregate[0]["complete"] is False
    assert aggregate[0]["failed_pages"] == [2]
    assert aggregate[0]["pages"][0]["status"] == "blank_excluded"
    assert sale.raw_payload["document_analysis"]["manifest_complete"] is False
    assert sale.raw_payload["document_analysis"]["last_successful_check_at"] is None

    persisted_row = {
        "source_url": sale.source_url,
        "provider": storage.PDF_EXTRACTION_PROVIDER,
        "model": storage.PDF_EXTRACTION_MODEL,
        "schema_version": storage.PDF_EXTRACTION_SCHEMA_VERSION,
        "result": [partial_payload],
        "updated_at": "2026-09-30T12:00:00+00:00",
    }
    restored = storage._validated_persisted_pdf_progress(sale, persisted_row)
    assert restored is not None
    assert restored[0]["text"] == ""
    assert restored[0].get("text_sha256", "") == ""
    assert restored[0]["_persisted_pdf_proof"] is True
    aggregate_path.write_text(json.dumps(restored), encoding="utf-8")
    shutil.rmtree(page_cache_dir / "pages")

    with pdf_enrichment.pdf_deadline_scope(time.monotonic() + 30):
        with pytest.raises(pdf_enrichment.PdfDeadlineExceeded) as recovered_error:
            pdf_enrichment.enrich_sale_from_pdfs(sale)

    assert recovered_error.value.partial_payload["pages"][0]["status"] == "blank_excluded"
    assert recovered_error.value.partial_payload["text"] == ""
    assert recovered_error.value.partial_payload["text_sha256"] == ""
    assert recovered_error.value.partial_payload["failed_pages"] == [2]
    assert recovered_error.value.partial_analysis["manifest_complete"] is False
    assert recovered_error.value.partial_analysis["last_successful_check_at"] is None
    assert recovered_error.value.partial_pdf_texts[0]["complete"] is False
    assert ocr_pages == []

    aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))
    assert aggregate[0]["complete"] is False
    assert aggregate[0]["failed_pages"] == [2]


def test_partial_checkpoint_keeps_memory_evidence_when_local_cache_write_fails(
    tmp_path,
    monkeypatch,
):
    from src import pdf_progress

    url = "https://example.test/memory-checkpoint.pdf"
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/memory-checkpoint-sale",
        documents=[{"label": "PV", "url": url, "document_type": "pv_huissier"}],
    )
    error = pdf_enrichment.PdfExtractionDeferred(
        "OCR pass budget reached; retry resumes",
        checkpointed_pages=1,
        total_pages=2,
        new_progress_pages=1,
    )
    payload = {
        "cache_version": pdf_progress.PDF_TEXT_CACHE_VERSION,
        "label": "PV",
        "url": url,
        "type": "pdf",
        "document_type": "pv_huissier",
        "file_path": str(tmp_path / "pv.pdf"),
        "text": "Page 1",
        "pages": [{"page": 1, "text": "Page 1", "status": "extracted"}],
        "sha256": "a" * 64,
        "page_count": 2,
        "text_chars": 6,
        "failed_pages": [2],
        "complete": False,
        "extraction_status": "incomplete",
        "text_sha256": "b" * 64,
    }
    merged = [dict(payload)]
    status_payloads = []

    monkeypatch.setattr(
        pdf_progress,
        "partial_pdf_payload_from_page_cache",
        lambda *_args, **_kwargs: dict(payload),
    )

    def write_cache(*_args, **_kwargs):
        raise OSError("local cache is read-only")

    def store_status(current_sale, *_args, **kwargs):
        current_sale.raw_payload["document_analysis"] = {"checkpoint": "memory"}
        status_payloads.append(kwargs["merged_pdf_texts"])

    assert pdf_progress.checkpoint_partial_pdf_progress(
        tmp_path / "pv.pdf",
        sale.documents[0],
        error=error,
        total_pages=2,
        cache_root=tmp_path / "pages",
        manifest_path=tmp_path / "manifest.json",
        current_texts=[],
        sale=sale,
        analysis={},
        documents=sale.documents,
        downloaded_documents=sale.documents,
        ocr_enabled=True,
        ocr_language="fra",
        merge_cache=lambda *_args, **_kwargs: merged,
        write_cache=write_cache,
        store_status=store_status,
    )
    assert error.partial_payload == payload
    assert error.partial_pdf_texts == merged
    assert error.partial_analysis == {"checkpoint": "memory"}
    assert isinstance(error.partial_cache_error, OSError)
    assert status_payloads == [merged]

    persisted = {}
    monkeypatch.setattr(
        queued_runner,
        "read_modern_cache",
        lambda *_args: pytest.fail("the queue must use the in-memory checkpoint"),
    )
    monkeypatch.setattr(
        queued_runner,
        "persist_pdf_progress_checkpoint_to_supabase",
        lambda current_sale, **kwargs: persisted.update(kwargs) or True,
    )
    job = {"id": "pdf-memory", "job_type": "pdf", "attempt_count": 2, "locked_at": "lease"}
    assert queued_runner._persist_pdf_checkpoint_for_sale(sale, error=error, pdf_job=job)
    assert persisted["analysis"] == {"checkpoint": "memory"}
    assert persisted["pdf_texts"] == merged
    assert persisted["pdf_job"] is job
    status_failed = SimpleNamespace(partial_status_error=RuntimeError("status write failed"))
    assert not queued_runner._persist_pdf_checkpoint_for_sale(
        sale,
        error=status_failed,
        pdf_job=job,
    )


def test_health_fails_for_old_queue_stalled_runs_and_stale_sources():
    base = {'queue': [], 'sources': [], 'latest_collection': {}}
    assert not pipeline_health.health_failed(base)
    assert pipeline_health.health_failed({**base, 'queue': [{'exhausted': 0, 'overdue': 1790}]})
    assert pipeline_health.health_failed({**base, 'stalled_runs': 1})
    assert pipeline_health.health_failed({**base, 'sources': [{'stale': 1}]})


def test_health_report_omits_large_coverage_url_evidence():
    coverage = {
        "licitor": {
            "coverage_complete": True,
            "listings_emitted": 580,
            "certificate": {"public_parsed_urls": [f"https://example.test/{i}" for i in range(1000)]},
        },
    }

    assert pipeline_health.compact_coverage(coverage) == {
        "licitor": {"coverage_complete": True, "listings_emitted": 580},
    }


def test_stream_download_stops_at_limit():
    import httpx
    class Stream(httpx.SyncByteStream):
        consumed = 0
        def __iter__(self):
            for _ in range(100):
                self.consumed += 1
                yield b'x' * 65536
    stream = Stream()
    response = httpx.Response(200, stream=stream)
    with pytest.raises(ValueError, match='download limit'):
        pdf_enrichment._read_document_stream(response, 65536)
    assert stream.consumed == 2


def test_cessions_tls_retains_root_and_hostname_validation():
    import hashlib
    import ssl
    from pathlib import Path

    from src.sources import cessions_etat
    ctx = cessions_etat.cessions_tls_context()
    assert ctx.check_hostname
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert not ctx.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN
    pem = (Path(cessions_etat.__file__).with_name('certificates') / 'sectigo-public-ov-r36.pem').read_text()
    assert hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest() == '6542d176bed50f193c0ce297ae44ecd8a0a86bec2ede682769344059b4e78530'


def test_source_retries_transient_errors_but_not_forbidden(monkeypatch):
    import httpx

    from src.sources.common import PoliteHttpClient
    client = object.__new__(PoliteHttpClient)
    client.delay_seconds = 0
    responses = [503, 200]
    calls = []
    def request(*a, **kw):
        calls.append(a)
        return httpx.Response(responses.pop(0))
    client._client = SimpleNamespace(request=request)
    monkeypatch.setattr('src.sources.common.time.sleep', lambda _: None)
    assert client._request_with_retries('GET', 'https://example.test').status_code == 200
    assert len(calls) == 2
    responses[:] = [403, 200]
    assert client._request_with_retries('GET', 'https://example.test').status_code == 403
    assert responses == [200]


def test_truncated_fact_context_cannot_be_cached_as_complete(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_ENABLED', 'true')
    sale = AuctionSale(source_name='avoventes', source_url='https://example.test/truncated', description='Maison')
    def contexts(*a, **kw):
        sale.raw_payload['llm_fact_context_coverage'] = {'complete': False}
        return ['Only the first page']
    monkeypatch.setattr(extraction, 'load_llm_fact_context_chunks_for_sale', contexts)
    monkeypatch.setattr(extraction, 'load_llm_context_for_sale', lambda *a, **kw: 'Maison')
    client = SimpleNamespace(model='test', is_available=lambda: True, generate_json=lambda *a: {'display_description': 'Maison décrite.'})
    stats = extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode='structured_then_display')
    assert stats.errors > 0
    assert not sale.raw_payload['llm_fact_coverage']['complete']
    assert not list(tmp_path.glob('*.json'))


def test_expired_attempt_cannot_finish_new_claim(monkeypatch):
    from src.storage import supabase_client as storage
    captured = []
    monkeypatch.setattr(storage, 'load_settings', lambda: {'supabase_url': 'https://example.test', 'supabase_service_role_key': 'test'})
    monkeypatch.setattr(storage.httpx, 'patch', lambda *a, **kw: captured.append(kw) or SimpleNamespace(is_error=False))
    storage.finish_auction_enrichment_job_in_supabase('job', succeeded=True, attempt_count=2)
    assert captured[0]['params'] == {'id': 'eq.job', 'status': 'eq.running', 'attempt_count': 'eq.2'}


def test_register_run_exports_only_valid_uuid(tmp_path, monkeypatch):
    from src.run_finalizer import register_run
    target = tmp_path / "github-env"
    monkeypatch.setenv("GITHUB_ENV", str(target))
    register_run("11111111-1111-4111-8111-111111111111")
    assert target.read_text() == "PIPELINE_CURRENT_RUN_ID=11111111-1111-4111-8111-111111111111\n"
    with pytest.raises(ValueError):
        register_run("bad\nINJECTED=value")


@pytest.mark.parametrize('mode,fail_at', [('display_description', 1), ('structured_then_display', 1), ('structured_then_display', 2)])
def test_budget_exhaustion_reaches_queue_without_becoming_extraction_failure(tmp_path, monkeypatch, mode, fail_at):
    from src.pipeline_usage import PipelineBudgetExhausted

    monkeypatch.setenv('LLM_ENABLED', 'true')
    monkeypatch.setattr(extraction, 'load_llm_fact_context_chunks_for_sale', lambda *a, **kw: ['chunk-A'])
    monkeypatch.setattr(extraction, 'load_llm_context_for_sale', lambda *a, **kw: 'Maison')

    class Client:
        model = 'budget-test'
        calls = 0

        def is_available(self):
            return True

        def generate_json(self, *args):
            self.calls += 1
            if self.calls == fail_at:
                raise PipelineBudgetExhausted('Daily AI budget exhausted')
            return {'display_description': 'Maison décrite par les pièces.'}

    sale = AuctionSale(source_name='licitor', source_url='https://example.test/budget', description='Maison')
    client = Client()
    with pytest.raises(PipelineBudgetExhausted):
        extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode=mode)
    assert client.calls == fail_at
    assert not list(tmp_path.glob('*.json'))
