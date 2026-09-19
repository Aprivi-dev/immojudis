from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from src.config import load_settings
from src.enrichment import extract_structured as extraction
from src.enrichment.extract_structured import LLMEnrichmentDeferred, enrich_sale_with_llm
from src.enrichment.prompts import DISPLAY_DESCRIPTION_SYSTEM_PROMPT
from src.models import AuctionSale
from src.pdf_enrichment import sale_storage_id


class FakeClient:
    model = "test-model"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, object]:
        self.calls.append((system_prompt, user_prompt))
        if system_prompt == DISPLAY_DESCRIPTION_SYSTEM_PROMPT:
            return {
                "display_description": (
                    "Maison à Bordeaux décrite dans les documents disponibles, avec les "
                    "informations restantes à vérifier."
                ),
                "confidence": {"display_description": 0.9},
            }
        # A valid empty extraction is still a successful analysis and must be
        # checkpointed so its absence is not paid for repeatedly.
        return {}


def _sale() -> AuctionSale:
    return AuctionSale(
        source_name="test",
        source_url="https://example.test/sale",
        raw_text="Maison à Bordeaux.",
    )


def _patch_contexts(monkeypatch: pytest.MonkeyPatch, contexts: list[str]) -> None:
    def load_contexts(sale: AuctionSale, **_: object) -> list[str]:
        sale.raw_payload["llm_fact_context_coverage"] = {
            "total_chunks": len(contexts),
            "selected_chunks": len(contexts),
            "complete": True,
        }
        return list(contexts)

    monkeypatch.setattr(extraction, "load_llm_fact_context_chunks_for_sale", load_contexts)
    monkeypatch.setattr(extraction, "load_llm_context_for_sale", lambda *_a, **_kw: "Maison à Bordeaux.")


def _fact_calls(client: FakeClient) -> list[tuple[str, str]]:
    return [call for call in client.calls if call[0] != DISPLAY_DESCRIPTION_SYSTEM_PROMPT]


def test_fact_budget_progresses_to_uncached_chunks_before_display(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "2")
    contexts = ["chunk-A", "chunk-B", "chunk-C", "chunk-D"]
    _patch_contexts(monkeypatch, contexts)
    sale = _sale()
    client = FakeClient()

    with pytest.raises(LLMEnrichmentDeferred) as deferred:
        enrich_sale_with_llm(
            sale,
            client=client,
            output_dir=tmp_path,
            extraction_mode="structured_then_display",
        )

    assert deferred.value.progress_made is True
    assert len(_fact_calls(client)) == 2
    assert not [call for call in client.calls if call[0] == DISPLAY_DESCRIPTION_SYSTEM_PROMPT]
    assert "llm_display_description" not in sale.raw_payload
    assert len(list((tmp_path / "chunks").glob("*.json"))) == 2

    second = enrich_sale_with_llm(
        sale,
        client=client,
        output_dir=tmp_path,
        extraction_mode="structured_then_display",
    )

    assert second.errors == 0
    assert sale.raw_payload["llm_fact_coverage"]["complete"] is True
    assert sale.raw_payload["llm_display_description"]
    assert len(_fact_calls(client)) == 4
    assert len([call for call in client.calls if call[0] == DISPLAY_DESCRIPTION_SYSTEM_PROMPT]) == 1


def test_validated_absence_is_cached_as_a_successful_fact(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "0")
    _patch_contexts(monkeypatch, ["chunk-without-a-fact"])
    sale = _sale()
    client = FakeClient()

    first = enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode="facts")
    second = enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode="facts")

    assert first.errors == 0
    assert second.errors == 0
    assert len(_fact_calls(client)) == 1
    assert sale.raw_payload["llm_fact_coverage"]["complete"] is True
    assert sale.raw_payload["llm_fact_input_key"]
    assert len(list((tmp_path / "chunks").glob("*.json"))) == 1


def test_display_cache_version_does_not_invalidate_fact_chunks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "0")
    _patch_contexts(monkeypatch, ["chunk-A"])
    sale = _sale()
    client = FakeClient()

    enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode="structured_then_display")
    assert len(_fact_calls(client)) == 1
    assert len([call for call in client.calls if call[0] == DISPLAY_DESCRIPTION_SYSTEM_PROMPT]) == 1

    monkeypatch.setenv("LLM_DISPLAY_PROMPT_VERSION", "display-test-next")
    second = enrich_sale_with_llm(
        sale,
        client=client,
        output_dir=tmp_path,
        extraction_mode="structured_then_display",
    )

    assert second.errors == 0
    assert len(_fact_calls(client)) == 1
    assert len([call for call in client.calls if call[0] == DISPLAY_DESCRIPTION_SYSTEM_PROMPT]) == 2


def test_durable_empty_fact_result_is_reused_without_provider_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "1")
    _patch_contexts(monkeypatch, ["chunk-A", "chunk-B"])
    monkeypatch.setattr(extraction, "load_cached_result", lambda *_a, **_kw: {})
    monkeypatch.setattr(extraction, "save_cached_result", lambda *_a, **_kw: None)
    sale = _sale()
    client = FakeClient()

    stats = enrich_sale_with_llm(sale, client=client, output_dir=tmp_path, extraction_mode="facts")

    assert stats.errors == 0
    assert stats.valid_json == 1
    assert client.calls == []
    assert sale.raw_payload["llm_fact_coverage"]["complete"] is True


def _document_sale(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AuctionSale:
    monkeypatch.setenv("REPLICATE_MODEL", "test-model")
    monkeypatch.setenv("LLM_FACT_PROMPT_VERSION", "facts-test")
    monkeypatch.setattr(extraction, "PDF_TEXTS_DIR", tmp_path)
    sale = AuctionSale(
        source_name="test",
        source_url="https://example.test/sale",
        raw_text="Annonce source stable.",
        documents=[{"url": "https://example.test/pv.pdf", "label": "PV"}],
        raw_payload={
            "source_checks": {
                "https://example.test/sale": {"evidence_fingerprint": "source-a"},
                "https://example.test/merged": {"evidence_fingerprint": "merged-a"},
            },
            "document_analysis": {
                "documents_extracted": 1,
                "failed_documents": 0,
                "input_fingerprint": "documents-a",
                "profiles": [
                    {
                        "url": "https://example.test/pv.pdf",
                        "sha256": "pdf-a",
                        "extraction_status": "extracted",
                        "complete": True,
                    }
                ],
            },
        },
    )
    (tmp_path / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps(
            [
                {
                    "url": "https://example.test/pv.pdf",
                    "label": "PV",
                    "text": "Surface documentée.",
                    "sha256": "pdf-a",
                }
            ]
        ),
        encoding="utf-8",
    )
    contexts = extraction.load_llm_fact_context_chunks_for_sale(sale, chunk_chars=3000, max_chunks=0)
    settings = load_settings()
    sale.raw_payload["llm_fact_input_key"] = extraction._fact_input_cache_key(
        "\n\n".join(contexts),
        str(settings["replicate_model"]),
        str(settings["llm_fact_prompt_version"]),
    )
    sale.raw_payload["llm_fact_coverage"] = {"complete": True}
    sale.raw_payload["llm_fact_context_manifest"] = extraction._fact_context_manifest(
        sale,
        model=str(settings["replicate_model"]),
        fact_prompt_version=str(settings["llm_fact_prompt_version"]),
    )
    return sale


@pytest.mark.parametrize(
    "mutation",
    [
        "pdf_sha",
        "pdf_text",
        "model",
        "fact_prompt",
        "merged_source",
    ],
)
def test_fact_manifest_rejects_changed_evidence_or_versions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    sale = _document_sale(tmp_path, monkeypatch)
    if mutation == "pdf_sha":
        sale.raw_payload["document_analysis"]["profiles"][0]["sha256"] = "pdf-b"
    elif mutation == "pdf_text":
        pdf_path = tmp_path / f"{sale_storage_id(sale)}.json"
        payload = json.loads(pdf_path.read_text(encoding="utf-8"))
        payload[0]["text"] = "Surface documentée modifiée."
        pdf_path.write_text(json.dumps(payload), encoding="utf-8")
    elif mutation == "model":
        monkeypatch.setenv("REPLICATE_MODEL", "different-model")
    elif mutation == "fact_prompt":
        monkeypatch.setenv("LLM_FACT_PROMPT_VERSION", "facts-next")
    else:
        sale.raw_payload["source_checks"]["https://example.test/merged"]["evidence_fingerprint"] = "merged-b"

    assert extraction.has_current_fact_analysis(sale) is False


def test_missing_pdf_cache_cannot_certify_document_backed_facts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(extraction, "PDF_TEXTS_DIR", tmp_path)
    sale = _sale()
    sale.documents = [{"url": "https://example.test/pv.pdf", "label": "PV"}]
    sale.raw_payload.update(llm_fact_coverage={"complete": True}, llm_fact_input_key="a" * 64)

    assert extraction.has_current_fact_analysis(sale) is False


def test_disabled_incremental_cache_processes_all_chunks_in_one_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "false")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "1")
    _patch_contexts(monkeypatch, ["chunk-A", "chunk-B", "chunk-C"])
    sale = _sale()
    client = FakeClient()

    stats = enrich_sale_with_llm(
        sale,
        client=client,
        output_dir=tmp_path,
        extraction_mode="structured_then_display",
    )

    assert stats.errors == 0
    assert sale.raw_payload["llm_fact_coverage"]["complete"] is True
    assert len(_fact_calls(client)) == 3
    assert len([call for call in client.calls if call[0] == DISPLAY_DESCRIPTION_SYSTEM_PROMPT]) == 1


def test_cached_chunk_is_merged_in_original_input_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "0")
    _patch_contexts(monkeypatch, ["chunk-A", "chunk-B", "chunk-C"])
    settings = load_settings()
    cached_key = extraction._fact_chunk_cache_key(
        "chunk-B", "test-model", str(settings["llm_fact_prompt_version"])
    )
    (tmp_path / "chunks").mkdir()
    (tmp_path / "chunks" / f"{cached_key}.json").write_text(
        json.dumps({"summary": "cached-second"}), encoding="utf-8"
    )

    class OrderedClient(FakeClient):
        def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, object]:
            self.calls.append((system_prompt, user_prompt))
            if system_prompt == DISPLAY_DESCRIPTION_SYSTEM_PROMPT:
                return {}
            if "chunk-A" in user_prompt:
                return {"summary": "first"}
            return {"summary": "third"}

    sale = _sale()
    stats = enrich_sale_with_llm(sale, client=OrderedClient(), output_dir=tmp_path, extraction_mode="facts")

    assert stats.errors == 0
    assert sale.raw_payload["llm_fact_extraction"]["summary"] == "first"


def test_display_only_keeps_current_pdf_facts_after_local_cache_loss(tmp_path, monkeypatch):
    sale = _document_sale(tmp_path, monkeypatch)
    sale.raw_payload["llm_fact_extraction"] = {
        "servitudes": ["Passage imposé par le document"],
        "occupancy_details": "Bail contesté par le propriétaire",
        "summary": "Ancienne mise à prix 999999 euros",
    }
    (tmp_path / f"{sale_storage_id(sale)}.json").unlink()
    assert extraction.has_current_fact_analysis(sale)
    client = FakeClient()
    extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path / "llm",
                                   extraction_mode="display_description")
    assert len(client.calls) == 1
    prompt = client.calls[0][1]
    assert "Passage imposé" in prompt and "Bail contesté" in prompt
    assert "999999" not in prompt


def test_display_context_uses_current_sale_financial_values() -> None:
    sale = _sale()
    sale.starting_price_eur = Decimal("125000")
    sale.adjudication_price_eur = Decimal("130000")
    sale.sale_date = datetime(2026, 9, 19, 10, 30, tzinfo=UTC)

    context = extraction._build_validated_display_context(
        sale,
        extraction.LLMExtraction(investor_notes="old cached narrative"),
        fallback_context=None,
    )

    assert '"starting_price_eur": "125000"' in context
    assert '"adjudication_price_eur": "130000"' in context
    assert '"sale_date": "2026-09-19T10:30:00+00:00"' in context
