"""The fact fingerprint does not depend on the size of the chunks sent to the model.

Production extracted every sale with LLM_FACT_CHUNK_CHARS=10000. Raising that size must not make every
complete sale look stale (a full paid re-extraction): ``llm_fact_input_key`` and its check are computed
on the fixed 10 000-character split (``FACT_FINGERPRINT_CHUNK_CHARS``).
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from src.enrichment import extract_structured as extraction
from src.models import AuctionSale
from src.pdf_progress import PDF_TEXT_CACHE_VERSION
from src.sale_local_files import sale_storage_id

PAGE_LENGTHS = (18_000, 4_000, 6_000, 9_500, 3_000)


class FakeClient:
    model = "test-model"

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, object]:
        self.prompts.append(user_prompt)
        return {}


def _page_text(page: int, length: int) -> str:
    words: list[str] = []
    size = 0
    index = 0
    while size < length:
        word = f"p{page}mot{index}"
        words.append(word)
        size += len(word) + 1
        index += 1
    return " ".join(words)


def _long_document_sale(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AuctionSale:
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "0")
    monkeypatch.setenv("REPLICATE_MODEL", "test-model")
    monkeypatch.setenv("LLM_FACT_PROMPT_VERSION", "facts-test")
    monkeypatch.setattr(extraction, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr("src.config.PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(extraction, "load_cached_result", lambda *_a, **_kw: None)
    monkeypatch.setattr(extraction, "save_cached_result", lambda *_a, **_kw: None)
    sale = AuctionSale(
        source_name="test",
        source_url="https://example.test/sale",
        raw_text="Annonce source stable : appartement à Lyon.",
        documents=[{"url": "https://example.test/pv.pdf", "label": "PV"}],
        raw_payload={"source_checks": {"https://example.test/sale": {"evidence_fingerprint": "source-a"}}},
    )
    from src.pdf_document_selection import store_document_analysis_status

    pages = [
        {"page": number, "text": _page_text(number, length), "method": "native"}
        for number, length in enumerate(PAGE_LENGTHS, start=1)
    ]
    text = " ".join(str(page["text"]) for page in pages)
    pdf_payload = {
        "url": sale.documents[0]["url"],
        "label": "PV",
        "document_type": "pv_huissier",
        "text": text,
        "pages": pages,
        "sha256": hashlib.sha256(b"fixture-long-pdf").hexdigest(),
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "text_chars": len(text),
        "text_present": True,
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "complete": True,
        "extraction_status": "extracted",
        "extraction_method": "fixture",
        "failed_pages": [],
        "page_count": len(pages),
        "http_checked_at": datetime.now(UTC).isoformat(),
    }
    (tmp_path / f"{sale_storage_id(sale)}.json").write_text(json.dumps([pdf_payload]), encoding="utf-8")
    store_document_analysis_status(sale, sale.documents, [pdf_payload])
    return sale


def _joined(sale: AuctionSale, chunk_chars: int) -> str:
    return "\n\n".join(extraction.load_llm_fact_context_chunks_for_sale(sale, chunk_chars=chunk_chars))


def test_sale_extracted_at_10000_stays_current_when_chunks_grow_to_25000(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sale = _long_document_sale(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_FACT_CHUNK_CHARS", "10000")
    client_10k = FakeClient()

    stats = extraction.enrich_sale_with_llm(sale, client=client_10k, output_dir=tmp_path / "out-10k")

    assert stats.errors == 0
    assert sale.raw_payload["llm_fact_coverage"]["complete"] is True
    key_10k = sale.raw_payload["llm_fact_input_key"]
    assert extraction.has_current_fact_analysis(sale) is True
    assert extraction.needs_fact_extraction(sale) is False
    # The long page is split differently at 25 000: a key computed on the model chunks would change.
    assert _joined(sale, 25_000) != _joined(sale, 10_000)
    assert len(extraction.load_llm_fact_context_chunks_for_sale(sale, chunk_chars=25_000)) < len(client_10k.prompts)

    monkeypatch.setenv("LLM_FACT_CHUNK_CHARS", "25000")

    assert extraction.has_current_fact_analysis(sale) is True
    assert extraction.needs_fact_extraction(sale) is False
    # Older sales carry no manifest: only the input key can prove that they are current.
    without_manifest = sale.model_copy(deep=True)
    without_manifest.raw_payload.pop("llm_fact_context_manifest")
    assert extraction.has_current_fact_analysis(without_manifest) is True
    assert extraction.needs_fact_extraction(without_manifest) is False

    # A sale that is extracted again (cold chunk cache) at 25 000 stores the same fingerprint, in fewer calls.
    client_25k = FakeClient()
    again = sale.model_copy(deep=True)
    stats = extraction.enrich_sale_with_llm(again, client=client_25k, output_dir=tmp_path / "out-25k")

    assert stats.errors == 0
    assert again.raw_payload["llm_fact_coverage"]["complete"] is True
    assert again.raw_payload["llm_fact_input_key"] == key_10k
    assert 0 < len(client_25k.prompts) < len(client_10k.prompts)
    assert again.raw_payload["llm_fact_context_coverage"]["chunk_chars"] == 25_000


def test_changed_evidence_is_still_stale_at_any_chunk_size(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sale = _long_document_sale(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_FACT_CHUNK_CHARS", "10000")
    extraction.enrich_sale_with_llm(sale, client=FakeClient(), output_dir=tmp_path / "out")
    sale.raw_payload.pop("llm_fact_context_manifest")
    monkeypatch.setenv("LLM_FACT_CHUNK_CHARS", "25000")
    assert extraction.has_current_fact_analysis(sale) is True

    sale.raw_payload["source_blocks"] = {"description": "Nouvelle information de la source."}

    assert extraction.has_current_fact_analysis(sale) is False
    assert extraction.needs_fact_extraction(sale) is True
