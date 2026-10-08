"""Regression tests for cold persisted-PDF cache recovery."""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from pathlib import Path

import pytest

from src.models import AuctionSale
from src.pdf_enrichment import PDF_TEXT_CACHE_VERSION
from src.storage import supabase_client as storage


def _persisted_sale_fixture() -> tuple[AuctionSale, list[dict[str, object]]]:
    from src.pdf_document_selection import _store_document_analysis_status

    labels = (
        "PV descriptif",
        "Cahier des conditions de vente",
        "Diagnostic de performance énergétique",
        "Annonce de vente",
    )
    documents = [
        {
            "label": label,
            "url": f"https://example.test/cold-{index}.pdf",
            "document_type": "pv_huissier" if index == 0 else "other",
        }
        for index, label in enumerate(labels)
    ]
    pdf_texts = [
        {
            **document,
            "type": "pdf",
            "file_path": f"/worker-only/cold-{index}.pdf",
            "text": f"Texte complet du document {index} avec preuve stable.",
            "sha256": hashlib.sha256(f"bytes-{index}".encode()).hexdigest(),
            "cache_version": PDF_TEXT_CACHE_VERSION,
            "complete": True,
            "failed_pages": [],
            "extraction_status": "extracted",
            "extraction_method": "pymupdf_pages",
            "page_count": 1,
            "text_chars": len(f"Texte complet du document {index} avec preuve stable."),
            "pages": [{"page": 1, "text": f"Texte complet du document {index} avec preuve stable."}],
        }
        for index, document in enumerate(documents)
    ]
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/cold-sale",
        starting_price_eur=Decimal("100000"),
        documents=documents,
    )
    _store_document_analysis_status(sale, documents, pdf_texts)
    return sale, pdf_texts


def _validated_map(sale: AuctionSale, pdf_texts: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    row = {
        "source_url": sale.source_url,
        "provider": storage.PDF_EXTRACTION_PROVIDER,
        "model": storage.PDF_EXTRACTION_MODEL,
        "schema_version": storage.PDF_EXTRACTION_SCHEMA_VERSION,
        "result": [dict(item) for item in pdf_texts],
        "updated_at": "2026-09-29T01:24:38+00:00",
    }
    validated = storage._validated_persisted_pdf_texts(sale, row)
    assert validated is not None
    assert all(item.get("_persisted_pdf_proof") is True for item in validated)
    return {sale.source_url: validated}


def test_cold_restore_keeps_provenance_and_is_idempotent(monkeypatch, tmp_path: Path) -> None:
    from src import pdf_fact_extraction

    sale, pdf_texts = _persisted_sale_fixture()
    persisted_map = _validated_map(sale, pdf_texts)
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)

    # The document upsert consumes the validated map without performing a
    # second persisted lookup.  Extraction upsert happens before the cache is
    # materialized, so it sees no synthetic current row on this cold pass.
    monkeypatch.setattr(
        storage,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    document_writes: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        storage,
        "_postgrest_upsert",
        lambda _url, _key, table, payload, on_conflict: document_writes.append(payload)
        if table == "auction_documents"
        else None,
    )
    monkeypatch.setattr(
        storage,
        "_fetch_persisted_pdf_texts_for_sales",
        lambda *_args: pytest.fail("cold map must be fetched once by the caller"),
    )

    assert storage.upsert_documents_to_supabase([sale], persisted_pdf_texts=persisted_map) == 4
    assert storage.upsert_extractions_to_supabase([sale]) == 0
    assert document_writes and all(row["file_path"] is None for row in document_writes[0])
    assert not list(tmp_path.glob("*.json"))

    storage._restore_persisted_pdf_text_caches([sale], persisted_map)
    cache_path = tmp_path / f"{storage.sale_storage_id(sale)}.json"
    first_bytes = cache_path.read_bytes()
    cached_payload = json.loads(first_bytes)
    assert all(item["_persisted_pdf_proof"] is True for item in cached_payload)
    assert all(item["_persisted_verified_at"] == sale.raw_payload["document_analysis"]["cache_proof"]["verified_at"] for item in cached_payload)

    reopened_rows = storage._document_rows_for_sale(sale)
    assert all(row["file_path"] is None for row in reopened_rows)
    assert all(row["download_status"] == "verified" for row in reopened_rows)
    assert all(row["raw_payload"]["extraction"]["provenance"] == "persisted_pdf_text" for row in reopened_rows)
    assert all(
        row["raw_payload"]["extraction"]["verified_at"]
        == sale.raw_payload["document_analysis"]["cache_proof"]["verified_at"]
        for row in reopened_rows
    )

    storage._restore_persisted_pdf_text_caches([sale], persisted_map)
    assert cache_path.read_bytes() == first_bytes


def test_asset_upsert_fetches_once_and_orders_document_extraction_cache(monkeypatch) -> None:
    sale, pdf_texts = _persisted_sale_fixture()
    persisted_map = _validated_map(sale, pdf_texts)
    events: list[tuple[str, object]] = []

    monkeypatch.setattr(
        storage,
        "_fetch_persisted_pdf_texts_for_sales",
        lambda sales, _url, _key: events.append(("fetch", sales)) or persisted_map,
    )
    monkeypatch.setattr(
        storage,
        "upsert_documents_to_supabase",
        lambda sales, *, persisted_pdf_texts, prune_stale=False: events.append(("documents", persisted_pdf_texts)) or 4,
    )
    monkeypatch.setattr(
        storage,
        "upsert_extractions_to_supabase",
        lambda sales: events.append(("extractions", sales)) or 0,
    )
    monkeypatch.setattr(
        storage,
        "_restore_persisted_pdf_text_caches",
        lambda sales, persisted_pdf_texts: events.append(("cache", persisted_pdf_texts)),
    )
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(storage, "_postgrest_insert", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(storage, "_postgrest_delete_by_source_urls", lambda *_args, **_kwargs: None)

    storage._upsert_asset_tables_with_rest(
        "https://supabase.test",
        "secret",
        [sale],
        "2026-09-30T10:00:00+00:00",
    )

    assert [name for name, _value in events] == ["fetch", "documents", "extractions", "cache"]
    assert events[1][1] is persisted_map
    assert events[3][1] is persisted_map


def test_failed_cold_restore_keeps_previous_cache_intact(monkeypatch, tmp_path: Path) -> None:
    from src import pdf_fact_extraction

    sale, pdf_texts = _persisted_sale_fixture()
    persisted_map = _validated_map(sale, pdf_texts)
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(pdf_fact_extraction, "PDF_TEXTS_DIR", tmp_path)

    old_payload = [dict(item) for item in pdf_texts]
    old_payload[0]["text"] = "ancienne preuve locale"
    pdf_fact_extraction._write_pdf_text_cache(sale, old_payload)
    cache_path = tmp_path / f"{storage.sale_storage_id(sale)}.json"
    previous_bytes = cache_path.read_bytes()

    def fail_replace(self, _target):
        raise OSError("simulated atomic replace failure")

    monkeypatch.setattr(Path, "replace", fail_replace)
    storage._restore_persisted_pdf_text_caches([sale], persisted_map)

    assert cache_path.read_bytes() == previous_bytes
    assert not list(tmp_path.glob(".*.tmp"))
