from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import pytest

from src.freshness import document_fingerprint, documents_are_current
from src.normalize import normalize_sale
from src.sale_local_files import sale_storage_id


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


# --- Une URL listée plusieurs fois (vente fusionnée entre sources) : un profil par pièce listée, une preuve par URL

DUPLICATED_URLS = ["https://example.test/cahier.pdf", "https://example.test/pv.pdf"]


def _sale_with_duplicated_documents(tmp_path, monkeypatch):
    import src.config

    monkeypatch.setattr(src.config, "PDF_TEXTS_DIR", tmp_path)
    documents = [{"url": url, "label": f"Pièce {index}"} for index, url in enumerate(DUPLICATED_URLS)]
    documents += [{**document, "label": document["label"] + " (autre source)"} for document in documents]
    sale = normalize_sale({"source_name": "licitor", "source_url": "https://example.test/doublons"})
    sale.documents = documents  # liste issue de la fusion des sources (``dedupe``), que la normalisation dédoublonne
    now = datetime.now(UTC).isoformat()
    fingerprint = document_fingerprint(sale.documents)
    texts = {url: f"Texte de {url}" for url in DUPLICATED_URLS}
    sale.raw_payload["document_analysis"] = {
        "checked_at": now,
        "input_fingerprint": fingerprint,
        "failed_documents": 0,
        # Comme ``store_document_analysis_status`` : un profil par pièce listée, doublons compris.
        "profiles": [
            {
                "url": document["url"],
                "sha256": f"pdf-{document['url']}",
                "extraction_status": "extracted",
                "complete": True,
                "failed_pages": [],
            }
            for document in sale.documents
        ],
        "cache_proof": {
            "version": 1,
            "verified_at": now,
            "input_fingerprint": fingerprint,
            "documents": [
                {
                    "url": url,
                    "sha256": f"pdf-{url}",
                    "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    "text_chars": len(text),
                    "text_present": True,
                    "extraction_status": "extracted",
                    "complete": True,
                    "failed_pages": [],
                }
                for url, text in texts.items()
            ],
        },
    }
    (tmp_path / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps(
            [
                {
                    "url": url,
                    "text": text,
                    "text_chars": len(text),
                    "sha256": f"pdf-{url}",
                    "complete": True,
                    "extraction_status": "extracted",
                    "failed_pages": [],
                }
                for url, text in texts.items()
            ]
        ),
        encoding="utf-8",
    )
    return sale


def test_documents_listed_twice_with_consistent_profiles_are_current(tmp_path, monkeypatch) -> None:
    sale = _sale_with_duplicated_documents(tmp_path, monkeypatch)
    assert len(sale.documents) == 4 and len(sale.raw_payload["document_analysis"]["profiles"]) == 4

    assert documents_are_current(sale)


def test_a_duplicated_url_without_any_profile_is_not_current(tmp_path, monkeypatch) -> None:
    sale = _sale_with_duplicated_documents(tmp_path, monkeypatch)
    analysis = sale.raw_payload["document_analysis"]
    analysis["profiles"] = [item for item in analysis["profiles"] if item["url"] != DUPLICATED_URLS[1]]

    assert not documents_are_current(sale)


@pytest.mark.parametrize("occurrence", [0, 1])  # la contradiction sur le premier ou le second profil de l'URL
def test_contradictory_profiles_for_one_url_are_not_current(tmp_path, monkeypatch, occurrence: int) -> None:
    sale = _sale_with_duplicated_documents(tmp_path, monkeypatch)
    profiles = sale.raw_payload["document_analysis"]["profiles"]
    index = [i for i, item in enumerate(profiles) if item["url"] == DUPLICATED_URLS[0]][occurrence]
    consistent = dict(profiles[index])
    assert documents_are_current(sale)  # le cas conforme, avant d'introduire la contradiction

    profiles[index] = {**consistent, "sha256": "pdf-autre-version"}
    assert not documents_are_current(sale)

    profiles[index] = {**consistent, "complete": False}
    assert not documents_are_current(sale)
