"""PostgreSQL proof for documentary PDF checkpoints after extraction errors."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path

import pytest
from psycopg import Error as PsycopgError
from psycopg.types.json import Jsonb
from test_autonomy_postgres import migration, setup

from src import pdf_fact_extraction
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
        "pages": [{"page": 1, "text": text, "status": "extracted"}],
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


def test_dedicated_checkpoint_owns_queue_and_bounds_session(monkeypatch, tmp_path: Path) -> None:
    """A cold checkpoint cannot enqueue work or inherit an unbounded session."""

    db_url = os.getenv("PIPELINE_TEST_DB_URL")
    if not db_url:
        pytest.skip("Requires disposable PostgreSQL")

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

            captured: dict[str, object] = {}

            def dedicated_connect(url: str, **kwargs: object):
                captured["url"] = url
                captured.update(kwargs)
                return nullcontext(db)

            monkeypatch.setattr(storage, "_postgres_connect", dedicated_connect)
            settings_before = db.execute(
                """
                select current_setting('app.pipeline_queue_owner', true),
                       current_setting('lock_timeout'),
                       current_setting('statement_timeout')
                """
            ).fetchone()

            assert storage.persist_pdf_document_checkpoint_to_supabase(sale) is True

            settings_after = db.execute(
                """
                select current_setting('app.pipeline_queue_owner', true),
                       current_setting('lock_timeout'),
                       current_setting('statement_timeout')
                """
            ).fetchone()
            assert settings_after == settings_before
            assert captured == {
                "url": db_url,
                "connect_timeout": storage.PDF_CHECKPOINT_CONNECT_TIMEOUT,
                "retry_delays": (),
            }
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
                    select provider, model, schema_version, result
                    from public.auction_extractions where source_url=%s
                    """,
                    (source_url,),
                ).fetchone()
                assert extraction[:3] == (
                    storage.PDF_EXTRACTION_PROVIDER,
                    storage.PDF_EXTRACTION_MODEL,
                    storage.PDF_EXTRACTION_SCHEMA_VERSION,
                )
                assert extraction[3][0]["file_path"] is None
                assert extraction[3][0]["complete"] is True
                assert extraction[3][0]["cache_version"] == PDF_TEXT_CACHE_VERSION
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
