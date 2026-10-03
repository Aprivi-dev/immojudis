from __future__ import annotations

import pytest

from src.normalize import normalize_sale
from src.storage import supabase_client


def _sale(
    documents: list[dict[str, str]],
    *,
    detail_status: str | None = None,
    source_url: str = "https://example.test/document-prune-sale",
):
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "starting_price_eur": 100_000,
            "source_url": source_url,
            "documents": documents,
        }
    )
    if detail_status is not None:
        sale.raw_payload["source_detail_status"] = detail_status
    return sale


def test_document_upsert_prunes_removed_urls_for_complete_revision(monkeypatch) -> None:
    sale = _sale(
        [{"url": "https://example.test/current.pdf", "label": "PV actuel"}],
        detail_status="complete",
    )
    upserts: list[list[dict[str, object]]] = []
    deletes: list[dict[str, str]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: upserts.append(payload),
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda _url, _key, _table, params: deletes.append(params),
    )

    assert supabase_client.upsert_documents_to_supabase(
        [sale],
        persisted_pdf_texts={sale.source_url: []},
        prune_stale=True,
    ) == 1

    assert len(upserts) == 1
    assert deletes == [
        {
            "source_url": f"eq.{sale.source_url}",
            "document_url": 'not.in.("https://example.test/current.pdf")',
        }
    ]


def test_document_upsert_does_not_prune_after_failed_detail_fetch(monkeypatch) -> None:
    sale = _sale([], detail_status="failed")
    deletes: list[dict[str, str]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda _url, _key, _table, params: deletes.append(params),
    )

    assert supabase_client.upsert_documents_to_supabase(
        [sale],
        persisted_pdf_texts={sale.source_url: []},
        prune_stale=True,
    ) == 0
    assert deletes == []


def test_document_upsert_does_not_prune_listing_documents_after_failed_detail_fetch(monkeypatch) -> None:
    sale = _sale(
        [{"url": "https://example.test/listing-only.pdf", "label": "Pièce"}],
        detail_status="failed",
    )
    deletes: list[dict[str, str]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda _url, _key, _table, params: deletes.append(params),
    )
    monkeypatch.setattr(supabase_client, "_postgrest_upsert", lambda *args, **kwargs: None)

    assert supabase_client.upsert_documents_to_supabase(
        [sale],
        persisted_pdf_texts={sale.source_url: []},
        prune_stale=True,
    ) == 1
    assert deletes == []


def test_document_upsert_removes_all_rows_when_complete_revision_has_no_documents(monkeypatch) -> None:
    sale = _sale([], detail_status="complete")
    deletes: list[dict[str, str]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda _url, _key, _table, params: deletes.append(params),
    )

    assert supabase_client.upsert_documents_to_supabase(
        [sale],
        persisted_pdf_texts={sale.source_url: []},
        prune_stale=True,
    ) == 0
    assert deletes == [{"source_url": f"eq.{sale.source_url}"}]


def test_document_upsert_keeps_rows_for_restricted_revision(monkeypatch) -> None:
    sale = _sale([], detail_status="restricted")
    deletes: list[dict[str, str]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda _url, _key, _table, params: deletes.append(params),
    )

    assert supabase_client.upsert_documents_to_supabase(
        [sale],
        persisted_pdf_texts={sale.source_url: []},
        prune_stale=True,
    ) == 0
    assert deletes == []


def test_document_upsert_keeps_rows_for_restricted_subset(monkeypatch) -> None:
    sale = _sale(
        [{"url": "https://example.test/current.pdf", "label": "PV actuel"}],
        detail_status="restricted",
    )
    deletes: list[dict[str, str]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda _url, _key, _table, params: deletes.append(params),
    )
    monkeypatch.setattr(supabase_client, "_postgrest_upsert", lambda *args, **kwargs: None)

    assert supabase_client.upsert_documents_to_supabase(
        [sale],
        persisted_pdf_texts={sale.source_url: []},
        prune_stale=True,
    ) == 1
    assert deletes == []


@pytest.mark.parametrize("payload", [
    {}, {"source_detail_status": None}, {"source_detail_status": ""},
    {"source_detail_status": " \t "},
])
@pytest.mark.parametrize("same_source", [False, True])
def test_unmarked_revision_does_not_abort_publication_or_authorize_pruning(
    monkeypatch, payload, same_source,
) -> None:
    complete = _sale([], detail_status="complete", source_url="https://example.test/complete")
    unmarked = _sale(
        [{"url": "https://example.test/retained.pdf", "label": "Pièce"}],
        source_url=complete.source_url if same_source else "https://example.test/unmarked",
    )
    unmarked.raw_payload = payload
    deletes = []
    writes = []
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {
        "supabase_url": "https://supabase.test", "supabase_service_role_key": "secret",
    })
    monkeypatch.setattr(supabase_client, "_postgrest_upsert", lambda *args, **kwargs: writes.append(args[3]))
    monkeypatch.setattr(supabase_client, "_postgrest_delete", lambda *args: deletes.append(args[3]))

    assert supabase_client.upsert_documents_to_supabase(
        [complete, unmarked], persisted_pdf_texts={}, prune_stale=True,
    ) == 1
    assert writes[0][0]["document_url"] == "https://example.test/retained.pdf"
    assert deletes == ([] if same_source else [{"source_url": f"eq.{complete.source_url}"}])


def test_document_url_can_be_shared_by_two_source_sales(monkeypatch) -> None:
    shared_url = "https://cdn.example/shared.pdf"
    sale_one = _sale(
        [{"url": shared_url, "label": "PV source 1"}],
        source_url="https://example.test/source-1",
    )
    sale_two = _sale(
        [{"url": shared_url, "label": "PV source 2"}],
        source_url="https://example.test/source-2",
    )
    writes: list[tuple[list[dict[str, object]], str]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: writes.append((payload, on_conflict)),
    )

    assert supabase_client.upsert_documents_to_supabase([sale_one, sale_two]) == 2
    assert writes[0][1] == "source_url,document_url"
    assert {(row["source_url"], row["document_url"]) for row in writes[0][0]} == {
        (sale_one.source_url, shared_url),
        (sale_two.source_url, shared_url),
    }


def test_postgres_document_upsert_quotes_each_composite_conflict_column(monkeypatch) -> None:
    if supabase_client.psycopg is None or supabase_client.sql is None:
        pytest.skip("psycopg is not installed")

    statements: list[tuple[str, list[tuple[object, ...]]]] = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def executemany(self, statement, rows):
            statements.append((str(statement), list(rows)))

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def cursor(self):
            return Cursor()

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _db_url: Connection())
    supabase_client._postgres_upsert(
        "postgresql://example",
        "auction_documents",
        [{"source_url": "https://example.test/source", "document_url": "https://cdn.example/doc.pdf", "label": "PV"}],
        on_conflict="source_url,document_url",
    )

    assert len(statements) == 1
    statement = statements[0][0]
    assert "Identifier('source_url')" in statement
    assert "Identifier('document_url')" in statement
    assert "Identifier('source_url,document_url')" not in statement
