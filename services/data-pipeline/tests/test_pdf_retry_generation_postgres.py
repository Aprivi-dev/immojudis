"""PostgreSQL proof for one bounded PDF writer-marker replay."""

import hashlib
import os
from datetime import UTC, datetime, timedelta

import pytest
from psycopg.types.json import Jsonb
from test_autonomy_postgres import setup

from src.normalize import normalize_sale
from src.pdf_document_selection import _store_document_analysis_status
from src.pdf_enrichment import PDF_TEXT_CACHE_VERSION
from src.pdf_fact_extraction import _write_pdf_text_cache
from src.storage import supabase_client as storage
from src.storage.supabase_client import _postgres_connect


def test_complete_pdf_proof_rotates_failed_dependents_once(monkeypatch):
    rows = []
    monkeypatch.setattr(
        storage,
        "_postgrest_upsert",
        lambda url, key, table, payload, conflict: rows.extend(payload),
    )
    settings = {
        "llm_prompt_version": "test-prompt",
        "llm_fact_prompt_version": "test-fact-prompt",
        "llm_display_prompt_version": "test-display-prompt",
        "replicate_model": "test-model",
    }
    monkeypatch.setattr(storage, "load_settings", lambda: settings)
    monkeypatch.setattr(
        "src.enrichment.extract_structured.needs_fact_extraction",
        lambda sale: True,
    )
    current = {"value": False}
    monkeypatch.setattr(storage, "documents_are_current", lambda sale: current["value"])

    source_url = "https://example.test/pdf-success-dependent-replay"
    document_url = f"{source_url}/pv.pdf"
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "status": "upcoming",
            "sale_date": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            "documents": [{"label": "PV descriptif", "url": document_url}],
        }
    )
    sale.status = "upcoming"
    fingerprint = storage.document_fingerprint(sale.documents)
    file_sha = hashlib.sha256(b"same file").hexdigest()
    text_sha = hashlib.sha256(b"same text").hexdigest()
    sale.raw_payload["document_analysis"] = {
        "failed_documents": 1,
        "documents_extracted": 1,
        "input_fingerprint": fingerprint,
        "profiles": [{
            "url": document_url,
            "sha256": file_sha,
            "extraction_status": "incomplete",
            "complete": False,
            "failed_pages": [2],
        }],
    }
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    old_hashes = {
        row["job_type"]: row["input_hash"]
        for row in rows
        if row["job_type"] in {"fact_extraction", "display_description"}
    }
    assert set(old_hashes) == {"fact_extraction", "display_description"}

    checked_at = datetime.now(UTC).isoformat()
    sale.raw_payload["document_analysis"] = {
        "checked_at": checked_at,
        "last_successful_check_at": checked_at,
        "failed_documents": 0,
        "documents_extracted": 1,
        "input_fingerprint": fingerprint,
        "profiles": [{
            "url": document_url,
            "sha256": file_sha,
            "extraction_status": "extracted",
            "complete": True,
            "failed_pages": [],
        }],
        "cache_proof": {
            "version": 1,
            "verified_at": checked_at,
            "input_fingerprint": fingerprint,
            "documents": [{
                "url": document_url,
                "sha256": file_sha,
                "text_sha256": text_sha,
                "text_chars": 12,
                "text_present": True,
                "extraction_status": "extracted",
                "complete": True,
                "failed_pages": [],
            }],
        },
    }
    current["value"] = True
    rows.clear()
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    fresh_hashes = {
        row["job_type"]: row["input_hash"]
        for row in rows
        if row["job_type"] in old_hashes
    }
    assert set(fresh_hashes) == set(old_hashes)
    assert all(fresh_hashes[k] != old_hashes[k] for k in old_hashes)

    # A later scan may refresh operational timestamps, but the proof content
    # and therefore both dependent input hashes remain unchanged.
    refreshed_at = datetime.now(UTC).isoformat()
    sale.raw_payload["document_analysis"]["checked_at"] = refreshed_at
    sale.raw_payload["document_analysis"]["last_successful_check_at"] = refreshed_at
    sale.raw_payload["document_analysis"]["cache_proof"]["verified_at"] = refreshed_at
    rows.clear()
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    assert {
        row["job_type"]: row["input_hash"]
        for row in rows
        if row["job_type"] in old_hashes
    } == fresh_hashes

    sale.raw_payload["document_analysis"]["documents_extracted"] = 0
    assert storage._fresh_complete_pdf_fingerprint(sale, documents_current=True) is None


def test_mixed_pdf_writer_proof_rotates_dependents_once(monkeypatch, tmp_path):
    """A complete text plus a terminal empty PDF is a stable usable proof."""

    settings = {
        "llm_prompt_version": "test-prompt",
        "llm_fact_prompt_version": "test-fact-prompt",
        "llm_display_prompt_version": "test-display-prompt",
        "replicate_model": "test-model",
    }
    monkeypatch.setattr(storage, "load_settings", lambda: settings)
    monkeypatch.setattr(
        "src.enrichment.extract_structured.needs_fact_extraction",
        lambda sale: True,
    )
    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr("src.pdf_fact_extraction.PDF_TEXTS_DIR", tmp_path)
    rows: list[dict[str, object]] = []
    monkeypatch.setattr(
        storage,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, _conflict: rows.extend(payload),
    )

    source_url = "https://example.test/mixed-pdf-proof"
    extracted_url = f"{source_url}/pv.pdf"
    empty_url = f"{source_url}/annexe-vide.pdf"
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "status": "upcoming",
            "sale_date": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            "documents": [
                {
                    "label": "PV descriptif",
                    "url": extracted_url,
                    "type": "pdf",
                    "document_type": "pv_huissier",
                },
                {
                    "label": "Annexe vide",
                    "url": empty_url,
                    "type": "pdf",
                    "document_type": "pdf",
                },
            ],
        }
    )
    sale.status = "upcoming"
    fingerprint = storage.document_fingerprint(sale.documents)
    file_sha = hashlib.sha256(b"same mixed proof file").hexdigest()
    empty_sha = hashlib.sha256(b"empty terminal pdf").hexdigest()
    sale.raw_payload["document_analysis"] = {
        "failed_documents": 1,
        "documents_extracted": 1,
        "input_fingerprint": fingerprint,
        "profiles": [
            {
                "url": extracted_url,
                "sha256": file_sha,
                "extraction_status": "incomplete",
                "complete": False,
                "failed_pages": [1],
            },
            {
                "url": empty_url,
                "sha256": empty_sha,
                "extraction_status": "pending",
                "complete": False,
                "failed_pages": [],
            },
        ],
    }
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    old_hashes = {
        row["job_type"]: row["input_hash"]
        for row in rows
        if row["job_type"] in {"fact_extraction", "display_description"}
    }
    assert set(old_hashes) == {"fact_extraction", "display_description"}

    documents = [
        {**sale.documents[0], "file_path": str(tmp_path / "pv.pdf")},
        {**sale.documents[1], "file_path": str(tmp_path / "annexe-vide.pdf")},
    ]
    text = "Surface habitable : 80 m2."
    extracted_payload = {
        **documents[0],
        "text": text,
        "pages": [{"page": 1, "text": text, "status": "extracted"}],
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "sha256": file_sha,
        "page_count": 1,
        "text_chars": len(text),
        "page_text_chars": len(text),
        "ocr_pages": 0,
        "empty_pages": 0,
        "extraction_method": "pymupdf_pages",
        "confidence": 0.9,
        "failed_pages": [],
        "complete": True,
        "extraction_status": "extracted",
    }
    empty_payload = {
        **documents[1],
        "text": "",
        "pages": [{"page": 1, "text": "", "status": "empty"}],
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "sha256": empty_sha,
        "page_count": 1,
        "text_chars": 0,
        "page_text_chars": 0,
        "ocr_pages": 0,
        "empty_pages": 1,
        "extraction_method": "pymupdf_pages",
        "confidence": 0.0,
        "failed_pages": [],
        "complete": True,
        "extraction_status": "empty",
    }
    _store_document_analysis_status(sale, documents, [extracted_payload, empty_payload])
    _write_pdf_text_cache(sale, [extracted_payload, empty_payload])

    assert storage.documents_are_current(sale)
    assert storage._fresh_complete_pdf_fingerprint(sale, documents_current=True)
    rows.clear()
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    fresh_hashes = {
        row["job_type"]: row["input_hash"]
        for row in rows
        if row["job_type"] in old_hashes
    }
    assert fresh_hashes.keys() == old_hashes.keys()
    assert all(fresh_hashes[key] != old_hashes[key] for key in old_hashes)

    # Timestamp refreshes and a second enqueue keep the same two dependent
    # identities; the terminal empty document is not included in the proof.
    sale.raw_payload["document_analysis"]["checked_at"] = datetime.now(UTC).isoformat()
    sale.raw_payload["document_analysis"]["cache_proof"]["verified_at"] = datetime.now(UTC).isoformat()
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    assert len(rows) == 4
    assert {
        (row["job_type"], row["input_hash"])
        for row in rows
    } == set(fresh_hashes.items())


def test_writer_marker_generation_is_idempotent_and_claims_only_new_revision(monkeypatch):
    """A writer correction creates one durable successor without resetting history."""

    db_url = os.getenv("PIPELINE_TEST_DB_URL")
    if not db_url:
        pytest.skip("Requires disposable PostgreSQL")

    settings = {
        "llm_prompt_version": "test-prompt",
        "llm_fact_prompt_version": "test-fact-prompt",
        "llm_display_prompt_version": "test-display-prompt",
        "replicate_model": "test-model",
    }
    monkeypatch.setattr(storage, "load_settings", lambda: settings)
    source_url = "https://example.test/writer-marker-replay"
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "status": "upcoming",
            "sale_date": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            "documents": [{"label": "PV descriptif", "url": f"{source_url}/pv.pdf"}],
        }
    )
    sale.status = "upcoming"
    sale.raw_payload.update(
        {
            "document_analysis": {
                "failed_documents": 1,
                "checked_at": "2026-09-30T08:00:00+00:00",
                "last_successful_check_at": "2026-09-29T08:00:00+00:00",
                "documents_extracted": 0,
            },
            "llm_display_description": "Description de test suffisamment longue pour satisfaire le contrôle de qualité affiché.",
            "llm_display_quality_version": "display_quality_20260911_v3",
            "llm_display_status": "accepted",
            "llm_prompt_version": settings["llm_prompt_version"],
            "llm_display_prompt_version": settings["llm_display_prompt_version"],
            "llm_display_model": settings["replicate_model"],
        }
    )

    with _postgres_connect(db_url) as db:
        try:
            setup(db)
            db.execute(
                """insert into auction_sales(source_url, source_name, status, sale_date, raw_payload)
                   values (%s, %s, %s, %s, %s)""",
                (source_url, sale.source_name, sale.status, sale.sale_date, Jsonb({})),
            )

            old_generation = f"{storage.PDF_TEXT_CACHE_VERSION}:decorative_edge_v1"
            new_generation = storage.PDF_RETRY_GENERATION
            assert new_generation != old_generation
            assert new_generation.endswith(":writer_markers_v1")

            token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                # Use the real Python job generator to materialize the prior
                # generation, then make its exhausted state explicit.
                monkeypatch.setattr(storage, "PDF_RETRY_GENERATION", old_generation)
                storage._enqueue_due_enrichment([sale], "unused", "unused")
                old_hash = db.execute(
                    """select input_hash from auction_enrichment_jobs
                       where source_url=%s and job_type='pdf'""",
                    (source_url,),
                ).fetchone()[0]
                db.execute(
                    """update auction_enrichment_jobs
                       set status='failed', attempt_count=max_attempts,
                           last_error='legacy exhausted',
                           created_at=now()-interval '1 minute'
                       where source_url=%s and job_type='pdf' and input_hash=%s""",
                    (source_url, old_hash),
                )

                # The corrected writer gets one new durable identity. A
                # second scan must hit the real unique constraint, not create
                # another replay row.
                monkeypatch.setattr(storage, "PDF_RETRY_GENERATION", new_generation)
                storage._enqueue_due_enrichment([sale], "unused", "unused")
                storage._enqueue_due_enrichment([sale], "unused", "unused")
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)

            rows = db.execute(
                """select input_hash, status, attempt_count, max_attempts
                   from auction_enrichment_jobs
                   where source_url=%s and job_type='pdf'
                   order by id""",
                (source_url,),
            ).fetchall()
            assert len(rows) == 2
            new_rows = [row for row in rows if row[0] != old_hash]
            assert len(new_rows) == 1
            new_hash = new_rows[0][0]
            assert new_hash != old_hash
            assert rows[0][0] == old_hash or rows[1][0] == old_hash
            old_row = next(row for row in rows if row[0] == old_hash)
            assert old_row[1:] == ("failed", 4, 4)
            assert new_rows[0][1:] == ("queued", 0, 4)

            # The production claim RPC retires the old failed revision while
            # claiming the new one with its own bounded attempt budget.
            claimed = db.execute(
                "select source_url, input_hash, attempt_count from claim_auction_enrichment_jobs(%s)",
                (10,),
            ).fetchall()
            assert claimed == [(source_url, new_hash, 1)]
            assert db.execute(
                """select status, attempt_count, max_attempts, last_error
                   from auction_enrichment_jobs where input_hash=%s""",
                (old_hash,),
            ).fetchone() == ("cancelled", 4, 4, "Superseded by a newer input revision")
            assert db.execute(
                """select status, attempt_count, max_attempts
                   from auction_enrichment_jobs where input_hash=%s""",
                (new_hash,),
            ).fetchone() == ("running", 1, 4)
        finally:
            db.rollback()


def test_complete_pdf_write_rotates_exhausted_fact_and_display_jobs(monkeypatch, tmp_path):
    """A complete same-byte PDF proof creates fresh dependent queue rows."""

    db_url = os.getenv("PIPELINE_TEST_DB_URL")
    if not db_url:
        pytest.skip("Requires disposable PostgreSQL")

    settings = {
        "llm_prompt_version": "test-prompt",
        "llm_fact_prompt_version": "test-fact-prompt",
        "llm_display_prompt_version": "test-display-prompt",
        "replicate_model": "test-model",
    }
    monkeypatch.setattr(storage, "load_settings", lambda: settings)
    document_url = "https://example.test/pdf-success-dependent-pg/pv.pdf"
    source_url = "https://example.test/pdf-success-dependent-pg"
    file_path = tmp_path / "pv.pdf"
    file_bytes = b"%PDF-1.4\nwriter marker fixture\n%%EOF\n"
    file_path.write_bytes(file_bytes)
    file_sha = hashlib.sha256(file_bytes).hexdigest()
    text = "Surface habitable : 80 m2."
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "status": "upcoming",
            "sale_date": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            "documents": [{"label": "PV descriptif", "url": document_url}],
        }
    )
    sale.status = "upcoming"
    fingerprint = storage.document_fingerprint(sale.documents)
    sale.raw_payload["document_analysis"] = {
        "failed_documents": 1,
        "documents_extracted": 1,
        "input_fingerprint": fingerprint,
        "profiles": [{
            "url": document_url,
            "sha256": file_sha,
            "extraction_status": "incomplete",
            "complete": False,
            "failed_pages": [1],
        }],
    }

    document = {
        "label": "PV descriptif",
        "url": document_url,
        "type": "pdf",
        "document_type": "pv_huissier",
        "file_path": str(file_path),
    }
    payload = {
        **document,
        "text": text,
        "pages": [{"page": 1, "text": text, "status": "extracted"}],
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "sha256": file_sha,
        "page_count": 1,
        "text_chars": len(text),
        "page_text_chars": len(text),
        "ocr_pages": 0,
        "empty_pages": 0,
        "extraction_method": "pymupdf_pages",
        "confidence": 0.9,
        "failed_pages": [],
        "complete": True,
        "extraction_status": "extracted",
    }

    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr("src.pdf_fact_extraction.PDF_TEXTS_DIR", tmp_path)

    with _postgres_connect(db_url) as db:
        try:
            setup(db)
            db.execute(
                """insert into auction_sales(source_url, source_name, status, sale_date, raw_payload)
                   values (%s, %s, %s, %s, %s)""",
                (source_url, sale.source_name, sale.status, sale.sale_date, Jsonb({})),
            )
            token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                storage._enqueue_due_enrichment([sale], "unused", "unused")
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)

            old_hashes = {
                job_type: db.execute(
                    """select input_hash from auction_enrichment_jobs
                       where source_url=%s and job_type=%s""",
                    (source_url, job_type),
                ).fetchone()[0]
                for job_type in ("fact_extraction", "display_description")
            }
            assert set(old_hashes) == {"fact_extraction", "display_description"}
            db.execute(
                """update auction_enrichment_jobs
                   set status='failed', attempt_count=max_attempts,
                       last_error='legacy exhausted', created_at=now()-interval '1 minute'
                   where source_url=%s and job_type in ('fact_extraction','display_description')""",
                (source_url,),
            )

            # Use the production status writer and aggregate cache writer. The
            # file SHA remains exactly the same as the incomplete profile.
            _store_document_analysis_status(sale, [document], [payload])
            _write_pdf_text_cache(sale, [payload])
            db.execute(
                """update auction_enrichment_jobs
                   set status='completed', attempt_count=1, completed_at=now()
                   where source_url=%s and job_type='pdf'""",
                (source_url,),
            )

            token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                storage._enqueue_due_enrichment([sale], "unused", "unused")
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)

            first_fresh_hashes = {
                job_type: db.execute(
                    """select input_hash from auction_enrichment_jobs
                       where source_url=%s and job_type=%s
                       order by created_at desc, id desc""",
                    (source_url, job_type),
                ).fetchone()[0]
                for job_type in old_hashes
            }
            assert all(first_fresh_hashes[k] != old_hashes[k] for k in old_hashes)

            # A cold/materialized replay can refresh operational timestamps,
            # including verified_at, but the same complete proof must keep the
            # same dependent hash.
            _store_document_analysis_status(sale, [document], [payload])
            _write_pdf_text_cache(sale, [payload])
            token = storage._PUBLICATION_CONNECTION.set(db)
            try:
                storage._enqueue_due_enrichment([sale], "unused", "unused")
            finally:
                storage._PUBLICATION_CONNECTION.reset(token)

            fresh_hashes = {
                job_type: db.execute(
                    """select input_hash from auction_enrichment_jobs
                       where source_url=%s and job_type=%s
                       order by created_at desc, id desc""",
                    (source_url, job_type),
                ).fetchone()[0]
                for job_type in old_hashes
            }
            assert fresh_hashes == first_fresh_hashes
            assert all(
                db.execute(
                    """select count(*) from auction_enrichment_jobs
                       where source_url=%s and job_type=%s""",
                    (source_url, job_type),
                ).fetchone()[0]
                == 2
                for job_type in old_hashes
            )

            claimed = db.execute(
                "select job_type, input_hash, attempt_count from claim_auction_enrichment_jobs(%s)",
                (10,),
            ).fetchall()
            assert {
                job_type: (input_hash, attempt_count)
                for job_type, input_hash, attempt_count in claimed
            } == {job_type: (fresh_hashes[job_type], 1) for job_type in old_hashes}
            for job_type in old_hashes:
                assert db.execute(
                    """select status, attempt_count, max_attempts, last_error
                       from auction_enrichment_jobs
                       where source_url=%s and job_type=%s and input_hash=%s""",
                    (source_url, job_type, old_hashes[job_type]),
                ).fetchone() == (
                    "cancelled",
                    4,
                    4,
                    "Superseded by a newer input revision",
                )
        finally:
            db.rollback()
