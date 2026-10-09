from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from src.freshness import document_fingerprint, documents_are_current
from src.normalize import normalize_sale
from src.pdf_enrichment import sale_storage_id


def test_document_fingerprint_stays_stable_during_partial_checkpoint() -> None:
    documents = [
        {"url": "https://example.test/pv.pdf", "label": "PV"},
        {"url": "https://example.test/cahier.pdf", "label": "Cahier"},
    ]
    original = document_fingerprint(documents)
    documents[0]["sha256"] = "a" * 64

    assert document_fingerprint(documents) == original


def test_replaced_document_bytes_do_not_reuse_old_pdf_proof(tmp_path, monkeypatch) -> None:
    import src.config

    monkeypatch.setattr(src.config, "PDF_TEXTS_DIR", tmp_path)
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/sha-mismatch",
            "documents": [{"url": "https://example.test/a.pdf", "label": "A"}],
        }
    )
    now = datetime.now(UTC).isoformat()
    fingerprint = document_fingerprint(sale.documents)
    old_text_hash = hashlib.sha256(b"PDF evidence").hexdigest()
    sale.raw_payload["document_analysis"] = {
        "checked_at": now,
        "input_fingerprint": fingerprint,
        "failed_documents": 0,
        "profiles": [
            {
                "url": "https://example.test/a.pdf",
                "sha256": "old-pdf",
                "extraction_status": "extracted",
                "complete": True,
                "failed_pages": [],
            }
        ],
        "cache_proof": {
            "version": 1,
            "verified_at": now,
            "input_fingerprint": fingerprint,
            "documents": [
                {
                    "url": "https://example.test/a.pdf",
                    "sha256": "old-pdf",
                    "text_sha256": old_text_hash,
                    "text_chars": 12,
                    "text_present": True,
                    "extraction_status": "extracted",
                    "complete": True,
                    "failed_pages": [],
                }
            ],
        },
    }
    cache_path = tmp_path / f"{sale_storage_id(sale)}.json"
    cache_path.write_text(
        json.dumps(
            [
                {
                    "url": "https://example.test/a.pdf",
                    "text": "PDF evidence",
                    "text_chars": 12,
                    "sha256": "old-pdf",
                    "complete": True,
                    "extraction_status": "extracted",
                    "failed_pages": [],
                }
            ]
        ),
        encoding="utf-8",
    )

    assert documents_are_current(sale)
    sale.documents[0]["sha256"] = "new-pdf"

    assert not documents_are_current(sale)
