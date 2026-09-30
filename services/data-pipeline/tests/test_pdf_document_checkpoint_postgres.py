"""PostgreSQL proof for documentary PDF checkpoints after extraction errors."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import Error as PsycopgError
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.pq import TransactionStatus
from psycopg.types.json import Jsonb
from test_autonomy_postgres import migration, setup

from src import pdf_enrichment, pdf_fact_extraction
from src.freshness import documents_are_current
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.pdf_document_selection import _store_document_analysis_status
from src.pdf_enrichment import PDF_TEXT_CACHE_VERSION
from src.storage import supabase_client as storage
from src.storage.supabase_client import _postgres_connect


def _modern_payload(document: dict[str, str], index: int) -> dict[str, object]:
    text = f"Texte documentaire moderne {index} avec preuve durable."
    return {
        **document,
        "type": "pdf",
        "document_type": document.get("document_type") or "other",
        "file_path": f"/worker-only/checkpoint-{index}.pdf",
        "text": text,
        "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "sha256": hashlib.sha256(f"pdf-bytes-{index}".encode()).hexdigest(),
        "pages": [{"page": 1, "text": text, "chars": len(text), "status": "extracted"}],
        "page_count": 1,
        "page_text_chars": len(text),
        "text_chars": len(text),
        "ocr_pages": 0,
        "empty_pages": 0,
        "extraction_method": "pymupdf_pages",
        "confidence": 0.91,
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "complete": True,
        "failed_pages": [],
        "extraction_status": "extracted",
    }


def _checkpoint_fixture(tmp_path: Path, source_url: str) -> tuple[AuctionSale, datetime]:
    documents = [
        {
            "label": "PV descriptif",
            "url": f"{source_url}/pv.pdf",
            "document_type": "pv_huissier",
        },
        {
            "label": "Cahier des conditions",
            "url": f"{source_url}/conditions.pdf",
            "document_type": "cahier_conditions_vente",
        },
    ]
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "status": "upcoming",
            "documents": documents,
        }
    )
    payload = _modern_payload(documents[0], 0)
    _store_document_analysis_status(sale, [documents[0]], [payload])
    pdf_fact_extraction._write_pdf_text_cache(sale, [payload])
    checked_at = datetime(2026, 9, 30, 10, 0, tzinfo=UTC)
    sale.updated_at = checked_at
    return sale, checked_at


def _create_extraction_table(db) -> None:
    db.execute(
        """
        create table public.auction_extractions (
            id uuid primary key default gen_random_uuid(),
            source_url text not null,
            provider text not null,
            model text,
            input_hash text not null,
            schema_version text not null,
            confidence jsonb not null default '{}'::jsonb,
            result jsonb not null default '{}'::jsonb,
            created_at timestamptz default now(),
            updated_at timestamptz default now(),
            unique (source_url, provider, input_hash)
        )
        """
    )


def _insert_sale(db, sale, updated_at: datetime, raw_payload: dict[str, object]) -> None:
    db.execute(
        """
        insert into public.auction_sales(
            source_url, source_name, status, updated_at, raw_payload
        ) values (%s, %s, %s, %s, %s)
        """,
        (sale.source_url, sale.source_name, sale.status, updated_at, Jsonb(raw_payload)),
    )


def _prepare_test_db(monkeypatch, db_url: str, db) -> None:
    setup(db)
    _create_extraction_table(db)
    monkeypatch.setattr(storage, "load_settings", lambda: {"supabase_db_url": db_url})


@pytest.fixture
def disposable_checkpoint_database() -> str:
    """Give the cold path a real, separate connection and an isolated database."""

    root_dsn = os.getenv("PIPELINE_TEST_DB_URL")
    if not root_dsn:
        pytest.skip("Requires disposable PostgreSQL")
    host = str(conninfo_to_dict(root_dsn).get("host") or "")
    if host not in {"127.0.0.1", "localhost"}:
        pytest.fail(f"Refusing non-local checkpoint database host: {host}")

    database_name = f"immojudis_pdf_checkpoint_{os.getpid()}_{uuid4().hex[:10]}"
    database_dsn = make_conninfo(root_dsn, dbname=database_name)
    created = False
    try:
        with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
            root_db.execute(sql.SQL("create database {}").format(sql.Identifier(database_name)))
        created = True
        yield database_dsn
    finally:
        if created:
            with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
                root_db.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(database_name)))


def test_checkpoint_preparation_rejects_legacy_cache(monkeypatch, tmp_path: Path) -> None:
    source_url = "https://example.test/pdf-documentary-checkpoint/unit"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    sale, _ = _checkpoint_fixture(tmp_path, source_url)

    prepared = storage._prepare_pdf_document_checkpoint(sale)
    assert prepared is not None
    analysis, result = prepared
    assert analysis["manifest_complete"] is False
    assert result[0]["file_path"] is None
    assert result[0]["cache_version"] == PDF_TEXT_CACHE_VERSION

    cache_path = tmp_path / f"{storage.sale_storage_id(sale)}.json"
    cache_path.write_text(
        json.dumps([{**result[0], "cache_version": "legacy"}]),
        encoding="utf-8",
    )
    assert storage._prepare_pdf_document_checkpoint(sale) is None


def test_progress_checkpoint_requires_modern_page_evidence(monkeypatch, tmp_path: Path) -> None:
    source_url = "https://example.test/pdf-documentary-checkpoint/strict"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    sale, _ = _checkpoint_fixture(tmp_path, source_url)
    analysis = sale.raw_payload["document_analysis"]
    payload = json.loads(
        (tmp_path / f"{storage.sale_storage_id(sale)}.json").read_text(encoding="utf-8")
    )
    payload[0].pop("pages")

    assert storage._validate_pdf_document_checkpoint_payload(sale, analysis, payload) is None

    payload = json.loads(
        (tmp_path / f"{storage.sale_storage_id(sale)}.json").read_text(encoding="utf-8")
    )
    payload[0]["text_sha256"] = hashlib.sha256(b"tampered").hexdigest()
    assert storage._validate_pdf_document_checkpoint_payload(sale, analysis, payload) is None

    payload[0]["text_sha256"] = hashlib.sha256(payload[0]["text"].encode()).hexdigest()
    payload[0]["pages"][0]["status"] = "failed"
    payload[0]["pages"][0]["retryable"] = True
    assert storage._validate_pdf_document_checkpoint_payload(sale, analysis, payload) is None

    payload = json.loads(
        (tmp_path / f"{storage.sale_storage_id(sale)}.json").read_text(encoding="utf-8")
    )
    payload[0]["pages"][0]["page"] = 2
    assert storage._validate_pdf_document_checkpoint_payload(sale, analysis, payload) is None

    payload[0]["pages"][0]["page"] = 1
    payload[0]["pages"][0]["chars"] -= 1
    assert storage._validate_pdf_document_checkpoint_payload(sale, analysis, payload) is None

    payload[0]["pages"][0]["chars"] = len(payload[0]["pages"][0]["text"])
    payload[0]["pages"][0]["text"] = "different page text"
    assert storage._validate_pdf_document_checkpoint_payload(sale, analysis, payload) is None

    failed_payload = _modern_payload(sale.documents[0], 0)
    failed_payload.update({"complete": False, "extraction_status": "incomplete", "failed_pages": [1]})
    failed_payload["pages"][0].update({"status": "failed", "retryable": True})
    assert storage._checkpoint_pages_match_payload(failed_payload, require_chars=True) is True


def test_progress_checkpoint_keeps_success_pages_with_retryable_diagnostics(
    monkeypatch,
    tmp_path: Path,
) -> None:
    source_url = "https://example.test/pdf-documentary-checkpoint/mixed-pages"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    sale, _ = _checkpoint_fixture(tmp_path, source_url)
    document = sale.documents[0]
    payload = _modern_payload(document, 0)
    successful_text = str(payload["text"])
    payload.update(
        {
            "page_count": 2,
            "complete": False,
            "extraction_status": "incomplete",
            "failed_pages": [2],
        }
    )
    payload["pages"] = [
        {"page": 1, "text": successful_text, "chars": len(successful_text), "status": "extracted"},
        {"page": 2, "text": "", "chars": 0, "status": "failed", "retryable": True},
    ]
    _store_document_analysis_status(
        sale,
        [document],
        [payload],
        merged_pdf_texts=[payload],
    )
    prepared = storage._validate_pdf_document_checkpoint_payload(
        sale,
        sale.raw_payload["document_analysis"],
        [payload],
    )
    assert prepared is not None
    assert storage._reusable_pdf_checkpoint_pages(payload["pages"]) == [payload["pages"][0]]

    payload["extraction_method"] = "docling"
    payload["text"] = f"{successful_text} Docling aggregate has additional structure."
    payload["text_chars"] = len(payload["text"])
    payload["text_sha256"] = hashlib.sha256(str(payload["text"]).encode()).hexdigest()
    _store_document_analysis_status(
        sale,
        [document],
        [payload],
        merged_pdf_texts=[payload],
    )
    assert storage._validate_pdf_document_checkpoint_payload(
        sale,
        sale.raw_payload["document_analysis"],
        [payload],
    ) is not None


def test_partial_restore_rejects_complete_manifest_and_legacy_local_cache(
    monkeypatch,
    tmp_path: Path,
) -> None:
    source_url = "https://example.test/pdf-documentary-checkpoint/cache-integrity"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    sale, _ = _checkpoint_fixture(tmp_path, source_url)
    cache_path = tmp_path / f"{storage.sale_storage_id(sale)}.json"
    assert storage._has_usable_local_pdf_cache(sale) is True

    legacy_payload = json.loads(cache_path.read_text(encoding="utf-8"))
    legacy_payload[0].pop("pages")
    cache_path.write_text(json.dumps(legacy_payload), encoding="utf-8")
    assert storage._has_usable_local_pdf_cache(sale) is False

    partial = _modern_payload(sale.documents[0], 0)
    partial.update({"complete": False, "extraction_status": "incomplete", "failed_pages": []})
    downloaded = [dict(sale.documents[0], sha256=partial["sha256"])]
    _store_document_analysis_status(
        sale,
        downloaded,
        [partial],
        merged_pdf_texts=[partial],
    )
    analysis = sale.raw_payload["document_analysis"]
    analysis["manifest_complete"] = True
    row = {
        "source_url": sale.source_url,
        "provider": storage.PDF_EXTRACTION_PROVIDER,
        "model": storage.PDF_EXTRACTION_MODEL,
        "schema_version": storage.PDF_EXTRACTION_SCHEMA_VERSION,
        "result": [partial],
        "updated_at": "2026-09-30T00:00:00+00:00",
    }
    assert storage._validated_persisted_pdf_progress(sale, row) is None


def test_partial_progress_checkpoint_restores_pages_after_cache_loss(monkeypatch, tmp_path: Path) -> None:
    """A deferred modern prefix survives aggregate-cache loss without becoming current."""

    db_url = os.getenv("PIPELINE_TEST_DB_URL")
    if not db_url:
        pytest.skip("Requires disposable PostgreSQL")

    source_url = "https://example.test/pdf-documentary-checkpoint/partial"
    pdf_texts_dir = tmp_path / "pdf-texts"
    page_cache_dir = pdf_texts_dir / "documents"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", pdf_texts_dir)
    monkeypatch.setattr(storage, "PDF_DOCUMENT_TEXTS_DIR", page_cache_dir)
    monkeypatch.setattr(pdf_enrichment, "PDF_DOCUMENT_TEXTS_DIR", page_cache_dir)

    documents = [
        {
            "label": "PV descriptif",
            "url": f"{source_url}/pv.pdf",
            "document_type": "pv_huissier",
        }
    ]
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "status": "upcoming",
            "documents": documents,
        }
    )
    local_pdf = tmp_path / "pv.pdf"
    local_bytes = b"%PDF-1.4 durable partial checkpoint"
    local_pdf.write_bytes(local_bytes)
    file_sha = hashlib.sha256(local_bytes).hexdigest()
    documents[0]["sha256"] = file_sha
    partial = _modern_payload(documents[0], 0)
    partial.update(
        {
            "file_path": str(local_pdf),
            "sha256": file_sha,
            "complete": False,
            "extraction_status": "incomplete",
            "failed_pages": [],
            "pages": [
                {
                    "page": 1,
                    "text": partial["text"],
                    "chars": partial["text_chars"],
                    "status": "extracted",
                }
            ],
        }
    )
    _store_document_analysis_status(
        sale,
        documents,
        [partial],
        merged_pdf_texts=[partial],
    )
    checked_at = datetime(2026, 9, 30, 10, 0, tzinfo=UTC)
    sale.updated_at = checked_at
    downloaded = [{**documents[0], "file_path": str(local_pdf), "sha256": file_sha}]
    # The in-memory checkpoint helper deliberately does not write the local
    # aggregate cache. Materialize the cache explicitly to model the normal
    # deferred-extraction path, then remove it after the SQL checkpoint.
    pdf_fact_extraction._write_pdf_text_cache(sale, [partial])
    aggregate_cache = pdf_texts_dir / f"{storage.sale_storage_id(sale)}.json"
    assert aggregate_cache.exists()

    settings = {
        "supabase_db_url": db_url,
        "supabase_url": "https://supabase.test",
        "supabase_service_role_key": "test-only",
        "pdf_ocr_enabled": True,
        "pdf_ocr_language": "fra",
    }
    monkeypatch.setattr(storage, "load_settings", lambda: settings)

    with _postgres_connect(db_url) as db:
        try:
            _prepare_test_db(monkeypatch, db_url, db)
            monkeypatch.setattr(storage, "load_settings", lambda: settings)
            _insert_sale(db, sale, checked_at, {"document_analysis": sale.raw_payload["document_analysis"]})
            token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                assert storage.persist_pdf_progress_checkpoint_to_supabase(
                    sale,
                    analysis=sale.raw_payload["document_analysis"],
                    pdf_texts=[partial],
                ) is True
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)

            stored_analysis = db.execute(
                "select raw_payload->'document_analysis' from public.auction_sales where source_url=%s",
                (source_url,),
            ).fetchone()[0]
            assert stored_analysis["manifest_complete"] is False
            assert stored_analysis["last_successful_check_at"] is None
            extraction = db.execute(
                "select result from public.auction_extractions where source_url=%s",
                (source_url,),
            ).fetchone()[0]
            assert extraction[0]["complete"] is False
            assert extraction[0]["pages"][0]["text"] == partial["pages"][0]["text"]

            aggregate_cache.unlink()
            page_cache_dir.mkdir(parents=True, exist_ok=True)
            restored_token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                restored = storage.restore_persisted_pdf_progress_for_sale(
                    sale,
                    downloaded_documents=downloaded,
                )
            finally:
                storage._PUBLICATION_CONNECTION.reset(restored_token)
            assert len(restored) == 1
            assert restored[0]["complete"] is False
            assert restored[0]["pages"] == partial["pages"]
            assert aggregate_cache.exists()
            assert not documents_are_current(sale)
            cache_key = hashlib.sha256(
                local_bytes + str((True, "fra", PDF_TEXT_CACHE_VERSION)).encode()
            ).hexdigest()
            restored_page = page_cache_dir / "pages" / cache_key / "1.json"
            assert restored_page.exists()
            assert json.loads(restored_page.read_text(encoding="utf-8"))["text"] == partial["pages"][0]["text"]
        finally:
            db.rollback()


def test_dedicated_checkpoint_owns_queue_and_bounds_session(
    monkeypatch,
    tmp_path: Path,
    disposable_checkpoint_database: str,
) -> None:
    """A cold checkpoint cannot enqueue work or inherit an unbounded session."""

    db_url = disposable_checkpoint_database
    source_url = "https://example.test/pdf-documentary-checkpoint/dedicated"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    sale, expected_updated_at = _checkpoint_fixture(tmp_path, source_url)

    with _postgres_connect(db_url) as db:
        try:
            _prepare_test_db(monkeypatch, db_url, db)
            # The production queue trigger watches these columns. The
            # checkpoint itself only changes raw_payload, while this test
            # trigger simulates a guard that recomputes content_hash first.
            db.execute("alter table public.auction_sales add column content_hash text")
            db.execute("alter table public.auction_sales add column documents jsonb default '[]'::jsonb")
            db.execute(migration("20260911091913_reliable_enrichment_queue.sql"))
            db.execute(
                """
                create function public.assert_pdf_checkpoint_session() returns trigger
                language plpgsql as $$
                begin
                    if current_setting('app.pipeline_queue_owner', true) <> 'python'
                       or current_setting('lock_timeout') <> '5s'
                       or current_setting('statement_timeout') <> '15s' then
                        raise exception 'checkpoint session was not bounded and owned';
                    end if;
                    new.content_hash := coalesce(old.content_hash, '') || ':guard';
                    return new;
                end;
                $$
                """
            )
            db.execute(
                """
                create trigger aaa_pdf_checkpoint_session
                before update on public.auction_sales
                for each row execute function public.assert_pdf_checkpoint_session()
                """
            )
            db.execute(
                """
                create trigger zzz_pdf_checkpoint_queue
                after update on public.auction_sales
                for each row execute function app_private.enqueue_auction_surface_enrichment()
                """
            )
            db.execute(
                """
                insert into public.auction_sales(
                    source_url, source_name, status, sale_date, updated_at,
                    documents, content_hash, raw_payload
                ) values (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    sale.source_url,
                    sale.source_name,
                    "upcoming",
                    datetime(2026, 10, 30, 12, 0, tzinfo=UTC),
                    expected_updated_at,
                    Jsonb(sale.documents),
                    "original-content-hash",
                    Jsonb({"preserve": "catalogue", "document_analysis": {"old": True}}),
                ),
            )

            # Commit setup before the real dedicated connection opens. The
            # outer connection remains open only for assertions and cleanup.
            db.commit()
            settings_before = db.execute(
                """
                select current_setting('app.pipeline_queue_owner', true),
                       current_setting('lock_timeout'),
                       current_setting('statement_timeout')
                """
            ).fetchone()
            db.rollback()

            captured: dict[str, object] = {}
            original_connect = storage._postgres_connect

            @contextmanager
            def dedicated_connect(url: str, **kwargs: object):
                captured["url"] = url
                captured.update(kwargs)
                dedicated_db = original_connect(url, **kwargs)
                captured["backend_pid"] = dedicated_db.info.backend_pid
                try:
                    assert dedicated_db.info.backend_pid != db.info.backend_pid
                    assert dedicated_db.info.transaction_status is TransactionStatus.IDLE
                    yield dedicated_db
                finally:
                    try:
                        captured["transaction_status"] = dedicated_db.info.transaction_status
                        captured["settings_after"] = dedicated_db.execute(
                            """
                            select current_setting('app.pipeline_queue_owner', true),
                                   current_setting('lock_timeout'),
                                   current_setting('statement_timeout')
                            """
                        ).fetchone()
                    finally:
                        try:
                            if not dedicated_db.closed:
                                dedicated_db.rollback()
                        finally:
                            dedicated_db.close()
                            captured["closed"] = dedicated_db.closed

            monkeypatch.setattr(storage, "_postgres_connect", dedicated_connect)

            assert storage.persist_pdf_document_checkpoint_to_supabase(sale) is True

            settings_after = db.execute(
                """
                select current_setting('app.pipeline_queue_owner', true),
                       current_setting('lock_timeout'),
                       current_setting('statement_timeout')
                """
            ).fetchone()
            assert settings_after == settings_before
            assert captured["transaction_status"] is TransactionStatus.IDLE
            assert captured["settings_after"][0] in (None, "")
            assert captured["settings_after"][1:] == ("0", "0")
            assert captured["closed"] is True
            assert captured["url"] == db_url
            assert captured["connect_timeout"] == storage.PDF_CHECKPOINT_CONNECT_TIMEOUT
            assert captured["retry_delays"] == ()
            # The reliable production trigger was deliberately made to see a
            # changed content_hash. The transaction-local owner guard must
            # still prevent both its PDF and display jobs.
            assert db.execute(
                "select count(*) from public.auction_enrichment_jobs where source_url=%s",
                (source_url,),
            ).fetchone()[0] == 0
        finally:
            db.rollback()


@pytest.mark.parametrize("collision", [False, True])
def test_checkpoint_rekeys_running_pdf_job_without_reset_or_duplicate(
    monkeypatch,
    tmp_path: Path,
    collision: bool,
) -> None:
    """A claimed PDF keeps its lease budget, or is superseded on collision."""

    db_url = os.getenv("PIPELINE_TEST_DB_URL")
    if not db_url:
        pytest.skip("Requires disposable PostgreSQL")

    source_url = f"https://example.test/pdf-documentary-checkpoint/rekey-{collision}"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    sale, expected_updated_at = _checkpoint_fixture(tmp_path, source_url)

    with _postgres_connect(db_url) as db:
        try:
            _prepare_test_db(monkeypatch, db_url, db)
            _insert_sale(db, sale, expected_updated_at, {"preserve": "catalogue"})
            old_hash = "pdf-old-generation"
            new_hash = storage.pdf_enrichment_input_hash_for_sale(sale)
            lease = datetime(2026, 9, 30, 10, 15, tzinfo=UTC)
            claimed = db.execute(
                """
                insert into public.auction_enrichment_jobs(
                    source_url, job_type, input_hash, status, attempt_count,
                    locked_at, created_at, updated_at
                ) values (%s, 'pdf', %s, 'running', %s, %s,
                          now()-interval '2 days', now()-interval '2 days')
                returning id, attempt_count, locked_at
                """,
                (source_url, old_hash, 2, lease),
            ).fetchone()
            if collision:
                db.execute(
                    """
                    insert into public.auction_enrichment_jobs(
                        source_url, job_type, input_hash, status, attempt_count,
                        created_at, updated_at
                    ) values (%s, 'pdf', %s, 'queued', 0,
                              now(), now())
                    """,
                    (source_url, new_hash),
                )

            pdf_job = {
                "id": str(claimed[0]),
                "job_type": "pdf",
                "source_url": source_url,
                "input_hash": old_hash,
                "attempt_count": claimed[1],
                "locked_at": claimed[2],
            }
            token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                assert storage.persist_pdf_document_checkpoint_to_supabase(
                    sale,
                    pdf_job=pdf_job,
                ) is True
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)

            old_row = db.execute(
                """
                select status, input_hash, attempt_count, locked_at, last_error
                  from public.auction_enrichment_jobs where id=%s
                """,
                (claimed[0],),
            ).fetchone()
            if collision:
                assert old_row == (
                    "cancelled",
                    old_hash,
                    2,
                    None,
                    "superseded after durable PDF checkpoint",
                )
                new_row = db.execute(
                    """
                    select status, input_hash, attempt_count, locked_at
                      from public.auction_enrichment_jobs
                     where source_url=%s and job_type='pdf' and input_hash=%s
                    """,
                    (source_url, new_hash),
                ).fetchone()
                assert new_row == ("queued", new_hash, 0, None)
            else:
                assert old_row == ("running", new_hash, 2, lease, None)
        finally:
            db.rollback()


@pytest.mark.parametrize("scenario", ["success", "stale", "rollback"])
def test_documentary_checkpoint_is_guarded_and_atomic(monkeypatch, tmp_path: Path, scenario: str) -> None:
    db_url = os.getenv("PIPELINE_TEST_DB_URL")
    if not db_url:
        pytest.skip("Requires disposable PostgreSQL")

    source_url = f"https://example.test/pdf-documentary-checkpoint/{scenario}"
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)
    sale, expected_updated_at = _checkpoint_fixture(tmp_path, source_url)

    with _postgres_connect(db_url) as db:
        try:
            _prepare_test_db(monkeypatch, db_url, db)
            old_payload = {"preserve": "catalogue", "document_analysis": {"old": True}}
            current_updated_at = expected_updated_at
            if scenario == "stale":
                current_updated_at = datetime(2026, 9, 30, 11, 0, tzinfo=UTC)
            _insert_sale(db, sale, current_updated_at, old_payload)

            if scenario == "rollback":
                db.execute(
                    """
                    create function public.fail_pdf_checkpoint() returns trigger
                    language plpgsql as $$
                    begin
                        raise exception 'checkpoint extraction write failed';
                    end;
                    $$
                    """
                )
                db.execute(
                    """
                    create trigger fail_pdf_checkpoint
                    before insert on public.auction_extractions
                    for each row execute function public.fail_pdf_checkpoint()
                    """
                )

            token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                if scenario == "rollback":
                    with pytest.raises(PsycopgError, match="checkpoint extraction write failed"):
                        storage.persist_pdf_document_checkpoint_to_supabase(sale)
                else:
                    persisted = storage.persist_pdf_document_checkpoint_to_supabase(sale)
                    assert persisted is (scenario == "success")
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)

            stored_payload = db.execute(
                "select raw_payload, updated_at from public.auction_sales where source_url=%s",
                (source_url,),
            ).fetchone()
            extraction_count = db.execute(
                "select count(*) from public.auction_extractions where source_url=%s",
                (source_url,),
            ).fetchone()[0]
            if scenario == "success":
                assert stored_payload[1] == expected_updated_at
                assert stored_payload[0]["preserve"] == "catalogue"
                assert stored_payload[0]["document_analysis"] == sale.raw_payload["document_analysis"]
                assert extraction_count == 1
                extraction = db.execute(
                    """
                    select provider, model, schema_version, confidence, result
                    from public.auction_extractions where source_url=%s
                    """,
                    (source_url,),
                ).fetchone()
                assert extraction[:3] == (
                    storage.PDF_EXTRACTION_PROVIDER,
                    storage.PDF_EXTRACTION_MODEL,
                    storage.PDF_EXTRACTION_SCHEMA_VERSION,
                )
                assert extraction[3]["document_count"] == 1
                assert extraction[4][0]["file_path"] is None
                assert extraction[4][0]["complete"] is True
                assert extraction[4][0]["cache_version"] == PDF_TEXT_CACHE_VERSION
                cache_path = tmp_path / f"{storage.sale_storage_id(sale)}.json"
                cache_path.unlink()
                monkeypatch.setattr(
                    storage,
                    "load_settings",
                    lambda: {
                        "supabase_db_url": db_url,
                        "supabase_url": "https://supabase.test",
                        "supabase_service_role_key": "test-only",
                    },
                )
                restore_token = storage._PUBLICATION_CONNECTION.set(db)
                try:
                    restored = storage.restore_persisted_pdf_progress_for_sale(sale)
                finally:
                    storage._PUBLICATION_CONNECTION.reset(restore_token)
                assert len(restored) == 1
                assert restored[0]["_persisted_pdf_proof"] is True
                assert restored[0]["file_path"] is None
                assert cache_path.exists()
            elif scenario == "stale":
                assert stored_payload[0] == old_payload
                assert stored_payload[1] == current_updated_at
                assert extraction_count == 0
            else:
                assert stored_payload[0] == old_payload
                assert stored_payload[1] == expected_updated_at
                assert extraction_count == 0
        finally:
            db.rollback()
