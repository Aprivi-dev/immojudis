"""A partial PDF checkpoint keeps the claimed retry generation identifiable."""

from __future__ import annotations

from src import queued_runner
from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.pdf_document_selection import _store_document_analysis_status
from src.storage import supabase_client as storage


def _sale() -> AuctionSale:
    return normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/pdf-checkpoint-generation",
            "status": "upcoming",
            "documents": [
                {
                    "label": f"Pièce {index}",
                    "url": f"https://example.test/pdf-checkpoint-generation/{index}.pdf",
                }
                for index in range(12)
            ],
        }
    )


def test_retry_cap_requires_the_current_generation_after_partial_checkpoint(monkeypatch) -> None:
    sale = _sale()
    fingerprint = document_fingerprint(sale.documents)
    sale.raw_payload["document_analysis"] = {
        "checked_at": "2026-09-30T09:00:00+00:00",
        "input_fingerprint": fingerprint,
        "progress_schema_version": 1,
        "manifest_complete": False,
        "failed_documents": 1,
        "profiles": [],
    }
    initial_hash = storage.pdf_enrichment_input_hash_for_sale(sale)

    states = [
        {
            "status": "failed",
            "attempt_count": 4,
            "max_attempts": 4,
            "input_hash": initial_hash,
            "created_at": "2026-09-30T09:00:00+00:00",
            "updated_at": "2026-10-01T10:00:00+00:00",
        }
    ]
    monkeypatch.setattr(
        queued_runner,
        "read_pdf_job_states_for_sale",
        lambda _source_url, **_kwargs: states,
    )
    assert queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)

    # The bounded pass has persisted six modern profiles. The PDF hash now
    # changes, so the old exhausted row must not block the new generation.
    downloaded_documents = [
        {**document, "sha256": f"{index + 1:064x}"}
        for index, document in enumerate(sale.documents[:6])
    ]
    pdf_texts = [
        {
            "url": document["url"],
            "label": document["label"],
            "type": "pdf",
            "document_type": "pv_huissier",
            "file_path": f"/worker-only/{index}.pdf",
            "text": f"Pièce extraite {index}",
            "cache_version": storage.PDF_TEXT_CACHE_VERSION,
            "sha256": f"{index + 1:064x}",
            "text_chars": len(f"Pièce extraite {index}"),
            "failed_pages": [],
            "complete": True,
            "extraction_status": "extracted",
        }
        for index, document in enumerate(sale.documents[:6])
    ]
    _store_document_analysis_status(sale, downloaded_documents, pdf_texts)
    current_hash = storage.pdf_enrichment_input_hash_for_sale(sale)
    assert current_hash != initial_hash
    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)

    # Once the queue contains the exact current hash at its cap, cancellation
    # is allowed again.
    states.append(
        {
            "status": "queued",
            "attempt_count": 0,
            "max_attempts": 4,
            "input_hash": current_hash,
            "created_at": "2026-09-30T10:01:00+00:00",
            "updated_at": "2026-10-02T10:01:00+00:00",
        }
    )
    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)
    states[-1].update({"status": "failed", "attempt_count": 4})
    assert queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)

    # A writer generation change creates a different current hash. The old
    # failed row must not be reused as evidence that the new generation is
    # exhausted.
    old_generation = storage.PDF_RETRY_GENERATION
    monkeypatch.setattr(storage, "PDF_RETRY_GENERATION", old_generation + ":writer_markers_v2")
    assert storage.pdf_enrichment_input_hash_for_sale(sale) != current_hash
    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)

    # A source manifest revision also invalidates the current row.
    sale.documents[0]["label"] = "Pièce actualisée"
    assert not queued_runner._pdf_failure_reached_retry_cap(sale, sale.source_url)
