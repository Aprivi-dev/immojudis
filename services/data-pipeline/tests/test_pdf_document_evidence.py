"""Per-document PDF evidence keeps read attachments visible on cold workers."""

from __future__ import annotations

import hashlib
from decimal import Decimal
from pathlib import Path

from src.models import AuctionSale
from src.pdf_progress import PDF_TEXT_CACHE_VERSION
from src.storage import pdf_document_evidence as evidence
from src.storage import supabase_client as storage

SHA_A = hashlib.sha256(b"a").hexdigest()
SHA_B = hashlib.sha256(b"b").hexdigest()


def _sale() -> AuctionSale:
    return AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        starting_price_eur=Decimal("100000"),
        documents=[
            {"label": "Cahier des conditions de vente", "url": "https://example.test/ccv.pdf"},
            {"label": "PV descriptif", "url": "https://example.test/pv.pdf"},
            {"label": "Diagnostics", "url": "https://example.test/diag.pdf"},
        ],
    )


def _row(url: str, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "source_url": "https://example.test/vente",
        "document_url": url,
        "sha256": SHA_A,
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "extraction_status": "extracted",
        "extraction_method": "pymupdf_pages",
        "complete": "true",
        "text_chars": "1200",
        "text_length": 1200,
        "failed_pages": 0,
        "page_count": 4,
        "updated_at": "2026-10-10T10:00:00+00:00",
    }
    row.update(overrides)
    return row


def test_valid_extracted_document_is_accepted() -> None:
    item = evidence.validated_document_evidence(_sale(), _row("https://example.test/ccv.pdf"))

    assert item is not None
    assert item["extraction_status"] == "extracted"
    assert item["text_chars"] == 1200
    assert item["page_count"] == 4
    assert item["_persisted_document_proof"] is True
    assert item["label"] == "Cahier des conditions de vente"


def test_rejected_entries() -> None:
    sale = _sale()
    url = "https://example.test/ccv.pdf"

    assert evidence.validated_document_evidence(sale, _row("https://example.test/removed.pdf")) is None
    assert evidence.validated_document_evidence(sale, _row(url, cache_version="pdf_text_v3")) is None
    assert evidence.validated_document_evidence(sale, _row(url, sha256="not-a-hash")) is None
    assert evidence.validated_document_evidence(sale, _row(url, text_length=10)) is None
    assert evidence.validated_document_evidence(sale, _row(url, complete="false")) is None
    assert evidence.validated_document_evidence(sale, _row(url, extraction_status="failed")) is None
    assert evidence.validated_document_evidence(sale, _row(url, text_chars="0", text_length=0)) is None


def test_incomplete_and_empty_documents_keep_their_status() -> None:
    sale = _sale()
    incomplete = evidence.validated_document_evidence(
        sale, _row("https://example.test/pv.pdf", extraction_status="incomplete", complete="false", failed_pages=2)
    )
    empty = evidence.validated_document_evidence(
        sale, _row("https://example.test/diag.pdf", extraction_status="empty", text_chars="0", text_length=0)
    )

    assert incomplete is not None and incomplete["extraction_status"] == "incomplete"
    assert incomplete["complete"] is False and incomplete["failed_page_count"] == 2
    assert empty is not None and empty["extraction_status"] == "empty"


def test_a_current_manifest_with_another_byte_hash_wins() -> None:
    sale = _sale()
    sale.documents[0]["sha256"] = SHA_B

    assert evidence.validated_document_evidence(sale, _row("https://example.test/ccv.pdf")) is None


def test_local_cache_entries_win_over_persisted_evidence() -> None:
    local = [{"url": "https://example.test/ccv.pdf", "text": "local"}]
    persisted = [
        {"url": "https://example.test/ccv.pdf", "text_chars": 1},
        {"url": "https://example.test/pv.pdf", "text_chars": 2},
    ]

    merged = evidence.merge_document_evidence(local, persisted)

    assert [item.get("text") for item in merged] == ["local", None]
    assert [item["url"] for item in merged] == ["https://example.test/ccv.pdf", "https://example.test/pv.pdf"]


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _Connection:
    def __init__(self, rows):
        self.rows = rows
        self.calls: list[tuple[str, tuple]] = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return _Cursor(self.rows)


def test_read_persisted_document_evidence_uses_metadata_only() -> None:
    sale = _sale()
    connection = _Connection([_row("https://example.test/ccv.pdf"), _row("https://example.test/gone.pdf")])

    result = evidence.read_persisted_document_evidence(connection, [sale])

    assert [item["url"] for item in result[sale.source_url]] == ["https://example.test/ccv.pdf"]
    sql, params = connection.calls[0]
    assert "item ->> 'text' as" not in sql  # never transfers the text itself
    assert params[0] == [sale.source_url]
    assert evidence.read_persisted_document_evidence(None, [sale]) == {}


def test_cold_publication_marks_persisted_documents_read_and_others_pending(monkeypatch, tmp_path: Path) -> None:
    sale = _sale()
    connection = _Connection(
        [
            _row("https://example.test/ccv.pdf"),
            _row("https://example.test/pv.pdf", extraction_status="incomplete", complete="false", failed_pages=1),
        ]
    )
    monkeypatch.setattr(storage, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(
        storage,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    writes: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        storage,
        "_postgrest_upsert",
        lambda _url, _key, table, payload, on_conflict: writes.append(payload) if table == "auction_documents" else None,
    )
    token = storage._PUBLICATION_CONNECTION.set(connection)
    try:
        assert storage.upsert_documents_to_supabase([sale], persisted_pdf_texts={}) == 3
    finally:
        storage._PUBLICATION_CONNECTION.reset(token)

    rows = {row["document_url"]: row for row in writes[0]}
    ccv = rows["https://example.test/ccv.pdf"]
    assert (ccv["download_status"], ccv["extraction_status"], ccv["text_chars"]) == ("verified", "extracted", 1200)
    assert ccv["sha256"] == SHA_A and ccv["file_path"] is None
    assert ccv["raw_payload"]["extraction"]["provenance"] == "persisted_pdf_text"
    assert ccv["raw_payload"]["extraction"]["text_present"] is True
    assert ccv["raw_payload"]["extraction"]["page_count"] == 4
    assert rows["https://example.test/pv.pdf"]["extraction_status"] == "incomplete"
    diag = rows["https://example.test/diag.pdf"]
    assert (diag["download_status"], diag["extraction_status"]) == ("unknown", "pending")
