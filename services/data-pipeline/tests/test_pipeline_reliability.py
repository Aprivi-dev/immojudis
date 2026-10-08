import hashlib
import json
import os
import threading
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import psycopg
import pytest

from src.dedupe import merge_duplicate_sales
from src.freshness import (
    SOURCE_EXTRACTION_VERSION,
    detail_is_fresh,
    document_fingerprint,
    documents_are_current,
    record_source_checks,
)
from src.normalize import normalize_sale
from src.pdf_enrichment import PDF_TEXT_CACHE_VERSION, download_documents, sale_storage_id
from src.sources.common import PaginationCoverage
from src.storage import supabase_client as storage


def test_queued_display_revision_is_rekeyed_without_cancelling_the_old_row():
    calls = []

    class Connection:
        def execute(self, query, params=None):
            calls.append((query, params))
            if query.startswith("savepoint") or query.startswith("release savepoint"):
                return SimpleNamespace(fetchall=lambda: [])
            return SimpleNamespace(
                fetchall=lambda: [("sale-1", "display_description", "pipeline_v2:new")]
            )

    jobs = [{
        "source_url": "https://example.test/sale-1",
        "job_type": "display_description",
        "input_hash": "pipeline_v2:new",
        "priority": 20,
    }]

    assert storage._coalesce_queued_display_revisions(Connection(), jobs) == {
        ("sale-1", "display_description", "pipeline_v2:new")
    }
    query = next(query for query, _params in calls if query.startswith("with incoming"))
    assert "for update skip locked" in query
    assert "queued_row.status='queued'" in query
    assert "queued.status='queued'" in query
    assert query.count("not exists") >= 2
    assert "attempt_count=0" in query
    params = next(params for query, params in calls if query.startswith("with incoming"))
    assert params == (
        "https://example.test/sale-1",
        "display_description",
        "pipeline_v2:new",
        20,
    )


def test_queued_display_revision_race_rolls_back_to_savepoint():
    statements = []

    class Connection:
        def execute(self, query, params=None):
            statements.append((query, params))
            if query.startswith("with incoming"):
                raise psycopg.errors.UniqueViolation("duplicate key value violates unique constraint")
            return SimpleNamespace(fetchall=lambda: [])

    jobs = [{
        "source_url": "https://example.test/race",
        "job_type": "display_description",
        "input_hash": "pipeline_v2:new",
        "priority": 20,
    }]

    assert storage._coalesce_queued_display_revisions(Connection(), jobs) == set()
    assert [query for query, _params in statements] == [
        "savepoint coalesce_display_revision",
        next(query for query, _params in statements if query.startswith("with incoming")),
        "rollback to savepoint coalesce_display_revision",
        "release savepoint coalesce_display_revision",
    ]


def test_queued_display_revision_reraises_non_unique_errors_after_savepoint_cleanup():
    statements = []

    class Connection:
        def execute(self, query, params=None):
            statements.append((query, params))
            if query.startswith("with incoming"):
                raise RuntimeError("permission denied for relation auction_enrichment_jobs")
            return SimpleNamespace(fetchall=lambda: [])

    jobs = [{
        "source_url": "https://example.test/error",
        "job_type": "display_description",
        "input_hash": "pipeline_v2:new",
        "priority": 20,
    }]

    with pytest.raises(RuntimeError, match="permission denied"):
        storage._coalesce_queued_display_revisions(Connection(), jobs)
    assert [query for query, _params in statements] == [
        "savepoint coalesce_display_revision",
        next(query for query, _params in statements if query.startswith("with incoming")),
        "rollback to savepoint coalesce_display_revision",
        "release savepoint coalesce_display_revision",
    ]


def test_queued_display_revision_concurrent_postgres_claim_does_not_abort_transaction():
    """Exercise SKIP LOCKED with two real publication transactions when supplied."""
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")

    source_url = f"https://example.test/coalesce-race-{uuid4()}"
    input_hash = "pipeline_v2:concurrent"
    created_queue_table = False
    created_source_sale = False
    with storage._postgres_connect(url) as db:
        created_queue_table = db.execute(
            "select to_regclass('public.auction_enrichment_jobs')"
        ).fetchone()[0] is None
        if created_queue_table:
            # The Python matrix provisions a bare PostgreSQL service rather than
            # replaying the Supabase schema. Keep this integration test useful
            # there while retaining the production table shape it exercises.
            db.execute(
                """
                create table public.auction_enrichment_jobs (
                    id bigint generated by default as identity primary key,
                    source_url text not null,
                    job_type text not null,
                    status text not null default 'queued',
                    priority integer not null default 0,
                    input_hash text not null,
                    attempt_count integer not null default 0,
                    max_attempts integer not null default 4,
                    next_attempt_at timestamptz not null default now(),
                    locked_at timestamptz,
                    completed_at timestamptz,
                    last_error text,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now(),
                    unique (source_url, job_type, input_hash)
                )
                """
            )
        if not created_queue_table and db.execute(
            "select to_regclass('public.auction_sales')"
        ).fetchone()[0] is not None:
            # The Supabase-shaped disposable database keeps the production
            # source_url foreign key; the CI matrix's bare PostgreSQL service
            # does not have auction_sales at all.
            db.execute(
                """
                insert into public.auction_sales (
                    id, source_name, source_url, status
                )
                values (%s, 'pipeline-reliability-test', %s, 'upcoming')
                """,
                (str(uuid4()), source_url),
            )
            created_source_sale = True
            # In the full Supabase schema, inserting a sale may enqueue a
            # source-shaped job through production triggers. Remove those
            # unrelated jobs before installing the single controlled fixture.
            db.execute(
                "delete from public.auction_enrichment_jobs where source_url=%s",
                (source_url,),
            )
        db.execute(
            "insert into public.auction_enrichment_jobs "
            "(source_url,job_type,input_hash,status,priority) "
            "values (%s,'display_description','pipeline_v2:old','queued',20)",
            (source_url,),
        )

    barrier = threading.Barrier(2)
    results: list[set[tuple[str, str, str]]] = []
    errors: list[BaseException] = []

    def coalesce_once() -> None:
        try:
            with storage._postgres_connect(url) as db:
                barrier.wait(timeout=10)
                results.append(storage._coalesce_queued_display_revisions(
                    db,
                    [{
                        "source_url": source_url,
                        "job_type": "display_description",
                        "input_hash": input_hash,
                        "priority": 20,
                    }],
                ))
        except BaseException as exc:  # pragma: no cover - only exercised by a disposable DB
            errors.append(exc)

    threads = [threading.Thread(target=coalesce_once) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    try:
        assert not errors
        assert len(results) == 2
        with storage._postgres_connect(url) as db:
            rows = db.execute(
                "select input_hash,status from public.auction_enrichment_jobs "
                "where source_url=%s order by id",
                (source_url,),
            ).fetchall()
            assert rows == [(input_hash, "queued")]
    finally:
        with storage._postgres_connect(url) as db:
            db.execute("delete from public.auction_enrichment_jobs where source_url=%s", (source_url,))
            if created_queue_table:
                db.execute("drop table public.auction_enrichment_jobs")
            if created_source_sale:
                # The production trigger requires a complete outcome bridge
                # before a sale can be deleted, so archive this disposable
                # source first and then remove the sale itself.
                db.execute("select public.bridge_auction_sales_to_outcome_graph()")
                db.execute("delete from public.auction_sales where source_url=%s", (source_url,))


def test_source_check_expires_and_content_change_invalidates_enrichment():
    raw = {"source_url": "https://example.test/sale", "source_name": "avoventes", "raw_text": "Libre"}
    record_source_checks([raw], {})
    known = {raw["source_url"]: {"raw_payload": dict(raw)}}
    assert detail_is_fresh(known[raw["source_url"]], raw["source_url"])
    changed = {**raw, "raw_text": "Occupé", "llm_prompt_version": "old", "document_facts_version": "old",
               "llm_display_description": "Ancienne analyse : bien libre"}
    record_source_checks([changed], known)
    assert "llm_prompt_version" not in changed
    assert "document_facts_version" not in changed
    assert 'llm_display_description' not in changed
    assert changed['llm_display_status'] == 'pending'
    assert changed['superseded_analysis']['description'] == 'Ancienne analyse : bien libre'
    known[raw["source_url"]]["raw_payload"]["source_checks"][raw["source_url"]]["checked_at"] = (datetime.now(UTC) - timedelta(days=2)).isoformat()
    assert not detail_is_fresh(known[raw["source_url"]], raw["source_url"])


def test_source_detail_refresh_detects_non_signature_fact_changes():
    """A date/price-stable listing must still invalidate changed detail facts."""
    source_url = "https://example.test/detail-refresh"
    initial = {
        "source_url": source_url,
        "source_name": "avoventes",
        "sale_date": "2026-12-01T10:00:00+01:00",
        "starting_price_eur": 100000,
        "address": "1 rue Ancienne",
        "surface_m2": 80,
        "documents": [{"url": "https://example.test/pv-v1.pdf", "label": "PV"}],
    }
    record_source_checks([initial], {})
    known = {source_url: {"raw_payload": {"source_checks": deepcopy(initial["source_checks"])}}}

    changed = {
        **initial,
        "address": "2 rue Nouvelle",
        "surface_m2": 92,
        "documents": [{"url": "https://example.test/pv-v2.pdf", "label": "PV"}],
        "llm_display_description": "Ancienne analyse",
    }
    record_source_checks([changed], known)

    assert changed["source_checks"][source_url]["fingerprint"] != initial["source_checks"][source_url]["fingerprint"]
    assert changed["source_content_changed"] is True
    assert changed["llm_display_status"] == "pending"
    assert "llm_display_description" not in changed


@pytest.mark.parametrize("marker", ["identity_mismatch", "quarantined"])
def test_identity_mismatch_or_quarantine_never_counts_as_fresh_detail(marker):
    source_url = "https://example.test/mismatched"
    row = {
        "status": "active",
        "raw_payload": {
            "source_checks": {
                source_url: {
                    "checked_at": datetime.now(UTC).isoformat(),
                    "extractor_version": SOURCE_EXTRACTION_VERSION,
                }
            }
        },
    }
    if marker == "identity_mismatch":
        row["raw_payload"]["source_identity_mismatch"] = True
    else:
        row["status"] = "quarantined"

    assert not detail_is_fresh(row, source_url)


def test_document_identity_and_failures_invalidate_analysis(tmp_path, monkeypatch):
    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/sale", "documents": [{"url": "https://example.test/a.pdf"}]})
    fingerprint = document_fingerprint(sale.documents)
    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": fingerprint,
        "profiles": [{
            "url": "https://example.test/a.pdf",
            "sha256": "pdf-a",
            "extraction_status": "extracted",
            "complete": True,
        }],
        "cache_proof": {
            "version": 1,
            "verified_at": datetime.now(UTC).isoformat(),
            "input_fingerprint": fingerprint,
            "documents": [{
                "url": "https://example.test/a.pdf",
                "sha256": "pdf-a",
                "text_sha256": hashlib.sha256(b"PDF evidence").hexdigest(),
                "text_chars": 12,
                "text_present": True,
                "extraction_status": "extracted",
                "complete": True,
                "failed_pages": [],
            }],
        },
    }
    (tmp_path / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{
            "url": "https://example.test/a.pdf",
            "text": "PDF evidence",
            "text_chars": 12,
            "sha256": "pdf-a",
            "complete": True,
            "extraction_status": "extracted",
            "failed_pages": [],
        }]),
        encoding="utf-8",
    )
    assert documents_are_current(sale)
    sale.documents.append({"url": "https://example.test/b.pdf"})
    assert not documents_are_current(sale)
    sale.documents.pop()
    sale.raw_payload["document_analysis"]["failed_documents"] = 1
    assert not documents_are_current(sale)


def test_profile_only_document_analysis_never_skips_missing_cache(tmp_path, monkeypatch):
    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://example.test/profile-only",
        "documents": [{"url": "https://example.test/a.pdf"}],
    })
    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": document_fingerprint(sale.documents),
        "documents_listed": 1,
        "documents_extracted": 1,
        "failed_documents": 0,
        "profiles": [{
            "url": "https://example.test/a.pdf",
            "sha256": "profile-only",
            "extraction_status": "extracted",
            "complete": True,
        }],
    }

    assert not documents_are_current(sale)


def test_current_document_requires_real_complete_cache_payload(tmp_path, monkeypatch):
    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://example.test/cache-proof",
        "documents": [{"url": "https://example.test/a.pdf"}],
    })
    fingerprint = document_fingerprint(sale.documents)
    now = datetime.now(UTC).isoformat()
    sale.raw_payload["document_analysis"] = {
        "checked_at": now,
        "input_fingerprint": fingerprint,
        "failed_documents": 0,
        "profiles": [{
            "url": "https://example.test/a.pdf",
            "sha256": "pdf-a",
            "extraction_status": "extracted",
            "complete": True,
        }],
        "cache_proof": {
            "version": 1,
            "verified_at": now,
            "input_fingerprint": fingerprint,
            "documents": [{
                "url": "https://example.test/a.pdf",
                "sha256": "pdf-a",
                "text_sha256": hashlib.sha256(b"PDF evidence").hexdigest(),
                "text_chars": 12,
                "text_present": True,
                "extraction_status": "extracted",
                "complete": True,
                "failed_pages": [],
            }],
        },
    }

    assert not documents_are_current(sale)
    cache_path = tmp_path / f"{sale_storage_id(sale)}.json"
    cache_path.write_text(
        json.dumps([{
            "url": "https://example.test/a.pdf",
            "text": "PDF evidence",
            "text_chars": 12,
            "sha256": "pdf-a",
            "complete": True,
            "extraction_status": "extracted",
            "failed_pages": [],
        }]),
        encoding="utf-8",
    )
    assert documents_are_current(sale)

    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    payload[0]["sha256"] = "pdf-b"
    cache_path.write_text(json.dumps(payload), encoding="utf-8")
    assert not documents_are_current(sale)

    payload[0]["sha256"] = "pdf-a"
    payload[0]["failed_pages"] = [4]
    payload[0]["complete"] = False
    payload[0]["extraction_status"] = "incomplete"
    cache_path.write_text(json.dumps(payload), encoding="utf-8")
    assert not documents_are_current(sale)


def test_document_freshness_fails_closed_for_malformed_json_and_missing_profile_sha(tmp_path, monkeypatch):
    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/malformed-pdf-cache",
            "documents": [{"url": "https://example.test/a.pdf"}],
        }
    )
    fingerprint = document_fingerprint(sale.documents)
    now = datetime.now(UTC).isoformat()
    sale.raw_payload["document_analysis"] = {
        "checked_at": now,
        "input_fingerprint": fingerprint,
        "failed_documents": 0,
        "profiles": [{
            "url": "https://example.test/a.pdf",
            "sha256": "",
            "extraction_status": "extracted",
            "complete": True,
            "failed_pages": [],
        }],
        "cache_proof": {
            "version": 1,
            "verified_at": now,
            "input_fingerprint": fingerprint,
            "documents": [{
                "url": "https://example.test/a.pdf",
                "sha256": "pdf-a",
                "text_sha256": hashlib.sha256(b"PDF evidence").hexdigest(),
                "text_chars": 12,
                "text_present": True,
                "extraction_status": "extracted",
                "complete": True,
                "failed_pages": [],
            }],
        },
    }
    cache_path = tmp_path / f"{sale_storage_id(sale)}.json"
    cache_path.write_text("{malformed", encoding="utf-8")

    assert not documents_are_current(sale)


def test_policy_blocked_document_analysis_is_current_without_extracted_documents():
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/policy-blocked-current",
            "documents": [{"url": "https://www.licitor.com/data/pub/media/pv.pdf"}],
        }
    )
    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": document_fingerprint(sale.documents),
        "documents_listed": 1,
        "documents_extracted": 0,
        "failed_documents": 0,
        "blocked_documents": 1,
        "blocked_document_urls": [sale.documents[0]["url"]],
        "blocked_document_reasons": [{
            "url": sale.documents[0]["url"],
            "reason": "robots.txt disallows fetching this Licitor document",
        }],
        "coverage_status": "partial",
    }

    assert documents_are_current(sale)


def test_pdf_revalidation_archives_replacement_and_handles_304(tmp_path, monkeypatch):
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/sale", "documents": [{"url": "https://example.test/pv.pdf", "label": "PV descriptif"}]})
    bodies = [b"%PDF-1.4\nold\n%%EOF", b"%PDF-1.4\nnew\n%%EOF"]
    requests = []
    def fetch(url, *, headers, **kwargs):
        requests.append(headers)
        return httpx.Response(200 if bodies else 304, content=bodies.pop(0) if bodies else b"", headers={"etag": "v2"}, request=httpx.Request("GET", url))
    monkeypatch.setattr("src.pdf_enrichment._download_document_response", fetch)
    downloaded = download_documents(sale, output_root=tmp_path)
    file = Path(downloaded[0]["file_path"])
    metadata = file.with_suffix(file.suffix + ".http.json")
    def expire():
        data = json.loads(metadata.read_text())
        data["checked_at"] = "2020-01-01T00:00:00+00:00"
        metadata.write_text(json.dumps(data))
    expire()
    download_documents(sale, output_root=tmp_path)
    assert b"new" in file.read_bytes()
    assert b"old" in next((file.parent / "versions").iterdir()).read_bytes()
    assert requests[-1]["If-None-Match"] == "v2"
    assert sale.raw_payload["source_content_changed"]
    expire()
    download_documents(sale, output_root=tmp_path)
    assert b"new" in file.read_bytes()
    assert len(requests) == 3


def test_stale_complete_progress_revalidates_and_tracks_new_sha(tmp_path, monkeypatch):
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/stale-complete",
            "documents": [{"url": "https://example.test/pv.pdf", "label": "PV descriptif"}],
        }
    )
    old_content = b"%PDF-1.4\nold\n%%EOF"
    new_content = b"%PDF-1.4\nnew\n%%EOF"
    bodies = [old_content, new_content]
    requests = []

    def fetch(url, *, headers, **kwargs):
        requests.append(headers)
        if bodies:
            return httpx.Response(200, content=bodies.pop(0), headers={"etag": "v2"}, request=httpx.Request("GET", url))
        return httpx.Response(304, headers={"etag": "v2"}, request=httpx.Request("GET", url))

    monkeypatch.setattr("src.pdf_enrichment._download_document_response", fetch)
    first = download_documents(sale, output_root=tmp_path)
    file = Path(first[0]["file_path"])
    metadata = file.with_suffix(file.suffix + ".http.json")
    old_sha = hashlib.sha256(old_content).hexdigest()
    text_sha = hashlib.sha256(b"cached text").hexdigest()
    fingerprint = document_fingerprint(sale.documents)
    sale.raw_payload["document_analysis"] = {
        "progress_schema_version": 1,
        "input_fingerprint": fingerprint,
        "document_progress": [{
            "url": sale.documents[0]["url"],
            "cache_version": PDF_TEXT_CACHE_VERSION,
            "sha256": old_sha,
            "text_sha256": text_sha,
            "text_chars": 11,
            "text_present": True,
            "complete": True,
            "extraction_status": "extracted",
            "failed_pages": [],
        }],
        "cache_proof": {
            "version": 1,
            "verified_at": datetime.now(UTC).isoformat(),
            "input_fingerprint": fingerprint,
            "documents": [{
                "url": sale.documents[0]["url"],
                "sha256": old_sha,
                "text_sha256": text_sha,
                "text_chars": 11,
                "text_present": True,
                "complete": True,
                "extraction_status": "extracted",
                "failed_pages": [],
            }],
        },
    }
    metadata_payload = json.loads(metadata.read_text())
    metadata_payload["checked_at"] = "2020-01-01T00:00:00+00:00"
    metadata.write_text(json.dumps(metadata_payload))

    refreshed = download_documents(sale, output_root=tmp_path)
    new_sha = hashlib.sha256(new_content).hexdigest()
    assert refreshed[0]["sha256"] == new_sha
    assert sale.documents[0]["sha256"] == new_sha
    assert requests[-1]["If-None-Match"] == "v2"

    progress = sale.raw_payload["document_analysis"]["document_progress"][0]
    proof = sale.raw_payload["document_analysis"]["cache_proof"]["documents"][0]
    progress["sha256"] = new_sha
    proof["sha256"] = new_sha
    metadata_payload = json.loads(metadata.read_text())
    metadata_payload["checked_at"] = "2020-01-01T00:00:00+00:00"
    metadata.write_text(json.dumps(metadata_payload))
    before_304 = len(requests)
    unchanged = download_documents(sale, output_root=tmp_path)
    assert unchanged[0]["sha256"] == new_sha
    assert len(requests) == before_304 + 1
    assert file.read_bytes() == new_content

    # The 304 refresh made the HTTP marker fresh; a following pass skips the
    # complete URL instead of issuing another conditional request.
    download_documents(sale, output_root=tmp_path)
    assert len(requests) == before_304 + 1


def test_pagination_reports_limit_repeat_and_exhaustion():
    page = [{"source_url": "https://example.test/a"}]
    pagination = PaginationCoverage()
    assert pagination.accept(page)
    assert not pagination.metrics()["coverage_complete"]
    assert not pagination.accept(page)
    assert pagination.metrics()["stop_reason"] == "repeated_page"
    pagination = PaginationCoverage()
    pagination.accept(page)
    pagination.accept([])
    assert not pagination.metrics()["coverage_complete"]
    pagination.accept([], terminal=True, expected_total=1)
    assert pagination.metrics()["coverage_complete"]


def test_distinct_lots_at_same_address_are_not_merged():
    base = {"address": "12 rue Victor Hugo", "city": "Bordeaux", "sale_date": "2026-10-01", "starting_price_eur": 10000}
    a = normalize_sale({**base, "source_name": "avoventes", "source_url": "https://example.test/a", "lot_number": "1"})
    b = normalize_sale({**base, "source_name": "licitor", "source_url": "https://example.test/b", "lot_number": "2"})
    assert len(merge_duplicate_sales([a, b])) == 2


def test_publication_failure_rolls_back_without_rest_fallback(monkeypatch):
    monkeypatch.setattr("src.publication_identity.resolve_publication_identities", lambda connection, sales: sales)
    events = []
    class Connection:
        def __enter__(self):
            events.append("begin")
            return self
        def __exit__(self, kind, value, tb):
            events.append("rollback" if kind else "commit")
        def execute(self, *args):
            pass
    monkeypatch.setattr(storage, "load_settings", lambda: {"supabase_url": "https://example.test", "supabase_service_role_key": "test", "supabase_db_url": "test"})
    monkeypatch.setattr(storage, "_postgres_connect", lambda _: Connection())
    monkeypatch.setattr(storage, "tribunal_reference_rows", lambda _: [])
    monkeypatch.setattr(storage, "_transaction_write", lambda *args: events.append("write"))
    monkeypatch.setattr(storage, "_sync_normalized_sale_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(storage, "_upsert_asset_tables_with_rest", lambda *args: (_ for _ in ()).throw(ValueError("broken child table")))
    monkeypatch.setattr(storage, "_upsert_with_rest", lambda *args: events.append("REST"))
    sale = normalize_sale({"source_name": "avoventes", "starting_price_eur": 10000, "source_url": "https://example.test/a"})
    with pytest.raises(ValueError, match="broken child"):
        storage.upsert_sales_to_supabase([sale])
    assert events == ["begin", "write", "rollback"]
    assert storage._PUBLICATION_CONNECTION.get() is None


def test_missing_surface_queues_fact_extraction_after_documents(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/a", "sale_date": "2099-01-01"})
    sale.raw_payload["document_analysis"] = {"documents_extracted": 1}
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert {row["job_type"] for row in rows} == {"fact_extraction", "display_description"}


def test_failed_pdf_retains_same_retry_identity_across_scans(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/retry", "sale_date": "2099-01-01", "documents": [{"url": "https://example.test/pv.pdf"}]})
    sale.raw_payload["document_analysis"] = {"failed_documents": 1, "checked_at": "2026-09-01T00:00:00+00:00"}
    storage._enqueue_due_enrichment([sale], "url", "key")
    first = next(row["input_hash"] for row in rows if row["job_type"] == "pdf")
    rows.clear()
    sale.raw_payload["document_analysis"]["checked_at"] = "2026-09-02T00:00:00+00:00"
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert next(row["input_hash"] for row in rows if row["job_type"] == "pdf") == first


def test_incomplete_pdf_gets_a_new_retry_generation_after_extractor_revision(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/retry-generation",
            "sale_date": "2099-01-01",
            "documents": [{"url": "https://example.test/pv.pdf"}],
        }
    )
    sale.raw_payload["document_analysis"] = {
        "failed_documents": 1,
        "checked_at": "2026-09-01T00:00:00+00:00",
    }
    storage._enqueue_due_enrichment([sale], "url", "key")
    first = next(row["input_hash"] for row in rows if row["job_type"] == "pdf")

    rows.clear()
    monkeypatch.setattr(storage, "PDF_RETRY_GENERATION", "pdf_text_v4_extractor_revision")
    storage._enqueue_due_enrichment([sale], "url", "key")
    second = next(row["input_hash"] for row in rows if row["job_type"] == "pdf")

    assert second != first
    assert second.startswith("pipeline_v2:")


@pytest.mark.parametrize(
    ("extracted", "expected_status"),
    [
        (
            {
                "text": "Texte partiel",
                "text_chars": 13,
                "complete": False,
                "extraction_status": "extracted",
                "failed_pages": [9],
            },
            "incomplete",
        ),
        (
            {
                "text": "Texte illisible",
                "text_chars": 15,
                "complete": False,
                "extraction_status": "failed",
            },
            "failed",
        ),
    ],
)
def test_document_rows_keep_incomplete_or_failed_pdf_status(
    extracted, expected_status, tmp_path, monkeypatch
):
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/partial-document",
            "documents": [{"label": "PV descriptif", "url": "https://example.test/pv.pdf"}],
        }
    )
    (tmp_path / f"{storage.sale_storage_id(sale)}.json").write_text(
        json.dumps(
            [
                {
                    "url": "https://example.test/pv.pdf",
                    **extracted,
                    "extraction_method": "pymupdf_pages",
                },
            ]
        ),
        encoding="utf-8",
    )

    rows = storage._document_rows_for_sale(sale)

    assert rows[0]["extraction_status"] == expected_status


def test_document_rows_require_hash_and_complete_text_and_preserve_manifest_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale({
        "source_name": "vench",
        "source_url": "https://example.test/manifest-failure",
        "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
    })
    cache_path = tmp_path / f"{storage.sale_storage_id(sale)}.json"
    cache_path.write_text(json.dumps([{
        "url": "https://example.test/pv.pdf",
        "text": "Texte réel",
        "text_chars": 10,
        "sha256": "pdf-a",
        "extraction_status": "extracted",
    }]), encoding="utf-8")
    assert storage._document_rows_for_sale(sale)[0]["extraction_status"] == "pending"

    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    payload[0]["complete"] = True
    cache_path.write_text(json.dumps(payload), encoding="utf-8")
    rows = storage._document_rows_for_sale(sale)
    assert rows[0]["extraction_status"] == "extracted"
    assert rows[0]["raw_payload"]["extraction"]["text_present"] is True

    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": document_fingerprint(sale.documents),
        "profiles": [{
            "url": "https://example.test/pv.pdf",
            "extraction_status": "incomplete",
            "complete": False,
            "failed_pages": [4],
        }],
    }
    rows = storage._document_rows_for_sale(sale)
    assert rows[0]["extraction_status"] == "incomplete"
    assert rows[0]["raw_payload"]["extraction"]["failed_pages"] == [4]


def test_document_rows_fail_closed_for_malformed_pdf_json(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://example.test/malformed-document-row",
        "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
    })
    cache_path = tmp_path / f"{storage.sale_storage_id(sale)}.json"
    cache_path.write_text("{malformed", encoding="utf-8")

    rows = storage._document_rows_for_sale(sale)
    assert rows[0]["extraction_status"] == "pending"
    assert rows[0]["text_chars"] == 0


@pytest.mark.parametrize(
    ("profile_status", "expected_status"),
    [("empty", "empty"), (None, "pending"), ("missing_profile", "pending"), ("missing_profiles_list", "pending")],
)
def test_document_rows_do_not_reuse_old_cache_for_current_empty_or_unknown_profile(
    profile_status, expected_status, tmp_path, monkeypatch
):
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/current-profile-status",
            "documents": [{"label": "PV", "url": "https://example.test/pv.pdf"}],
        }
    )
    document_url = sale.documents[0]["url"]
    profile = {"url": document_url, "sha256": "current-pdf", "complete": True}
    if profile_status is not None:
        profile["extraction_status"] = profile_status
    sale.raw_payload["document_analysis"] = {
        "checked_at": datetime.now(UTC).isoformat(),
        "input_fingerprint": document_fingerprint(sale.documents),
        "profiles": [profile],
    }
    if profile_status == "missing_profile":
        sale.raw_payload["document_analysis"]["profiles"] = []
    elif profile_status == "missing_profiles_list":
        sale.raw_payload["document_analysis"].pop("profiles")
    (tmp_path / f"{storage.sale_storage_id(sale)}.json").write_text(
        json.dumps(
            [
                {
                    "url": document_url,
                    "text": "Ancien cache à ne pas certifier",
                    "text_chars": 31,
                    "sha256": "old-pdf",
                    "file_path": "/tmp/obsolete.pdf",
                    "complete": True,
                    "extraction_status": "extracted",
                    "failed_pages": [],
                }
            ]
        ),
        encoding="utf-8",
    )

    row = storage._document_rows_for_sale(sale)[0]

    assert row["extraction_status"] == expected_status
    assert row["raw_payload"]["extraction"]["extraction_status"] == expected_status
    if profile_status == "empty":
        assert row["text_chars"] == 0
        assert row["raw_payload"]["extraction"]["text_present"] is False
        assert row["raw_payload"]["extraction"]["sha256"] == "current-pdf"
        assert row["sha256"] == "current-pdf"
    else:
        assert row["raw_payload"]["extraction"]["complete"] is False
        assert row["text_chars"] == 0
        assert row["file_path"] is None
        assert row["sha256"] is None
        assert row["download_status"] == "unknown"
        assert row["raw_payload"]["extraction"]["text_present"] is False
        assert row["raw_payload"]["extraction"]["text_sha256"] is None
        assert row["raw_payload"]["extraction"]["sha256"] is None


def test_replaced_document_creates_new_fact_job_even_at_same_url(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://example.test/replaced", "sale_date": "2099-01-01"})
    sale.raw_payload["document_analysis"] = {"documents_extracted": 1, "profiles": [{"url": "https://example.test/pv.pdf", "sha256": "old"}]}
    storage._enqueue_due_enrichment([sale], "url", "key")
    old = next(row["input_hash"] for row in rows if row["job_type"] == "fact_extraction")
    rows.clear()
    sale.raw_payload["document_analysis"]["profiles"][0]["sha256"] = "new"
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert next(row["input_hash"] for row in rows if row["job_type"] == "fact_extraction") != old


def test_new_document_url_does_not_inherit_old_pdf_price_or_surface():
    from src.main import _preserve_known_enrichment_payloads
    raw = {"source_name": "licitor", "source_url": "https://example.test/newdoc",
           "documents": [{"url": "https://example.test/new.pdf"}], "starting_price_eur": 100000}
    known = {raw["source_url"]: {"surface_m2": 90, "surface_source": "pdf", "starting_price_eur": 200000,
             "documents": [{"url": "https://example.test/old.pdf"}],
             "raw_payload": {"llm_display_description": "Ancien document", "surface_extraction": {"source": "pdf"}}}}
    _preserve_known_enrichment_payloads([raw], known)
    assert raw["starting_price_eur"] == 100000
    assert not raw.get("surface_m2")
    assert not raw.get("llm_display_description")
    assert raw["source_factual_snapshot"]["starting_price_eur"] == 100000


def test_changed_bytes_without_local_cache_invalidate_facts_before_ocr():
    from decimal import Decimal

    from src.pdf_enrichment import _invalidate_replaced_document_facts
    sale = normalize_sale({"source_name": "licitor", "source_url": "https://example.test/sale",
                           "surface_m2": 90, "surface_source": "pdf", "starting_price_eur": 200000})
    sale.raw_payload.update({"document_analysis": {"profiles": [{"url": "https://example.test/pv.pdf", "sha256": "old"}]},
                             "llm_display_description": "Ancienne analyse certaine", "starting_price_extraction": {"source": "pdf"},
                             "source_factual_snapshot": {"source_name": "licitor", "source_url": sale.source_url,
                                                         "starting_price_eur": 100000}})
    _invalidate_replaced_document_facts(sale, [{"url": "https://example.test/pv.pdf", "sha256": "old"}])
    assert sale.raw_payload.get("llm_display_description")
    _invalidate_replaced_document_facts(sale, [{"url": "https://example.test/pv.pdf", "sha256": "new"}])
    assert not sale.raw_payload.get("llm_display_description")
    assert sale.raw_payload["superseded_analysis"]["reason"] == "document_bytes_changed"
    assert sale.surface_m2 is None
    assert sale.starting_price_eur == Decimal(100000)


def test_unknown_date_still_queues_document_enrichment(monkeypatch):
    rows = []
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda url, key, table, payload, conflict: rows.extend(payload))
    sale = normalize_sale({"source_name": "licitor", "source_url": "https://example.test/no-date",
                           "documents": [{"url": "https://example.test/pv.pdf"}]})
    sale.status = "unknown"
    storage._enqueue_due_enrichment([sale], "url", "key")
    assert {row["job_type"] for row in rows} == {"pdf", "display_description"}
