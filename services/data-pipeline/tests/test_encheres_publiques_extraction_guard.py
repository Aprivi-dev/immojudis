from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path

import pytest

from src.config import EncheresPubliquesAccessNotAuthorized
from src.enrichment import extract_structured as extraction
from src.models import AuctionSale

EP_URL = "https://www.encheres-publiques.com/vente/alias"
EP_DOCUMENT_URL = "https://documents.encheres-publiques.com/pv.pdf"


def _settings(*, authorized: bool) -> dict[str, object]:
    return {
        "llm_enabled": True,
        "llm_prompt_version": "test-prompt",
        "llm_fact_prompt_version": "test-fact-prompt",
        "replicate_model": "test-model",
        "incremental_enrichment": False,
        "enable_encheres_publiques_benchmark": authorized,
        "encheres_publiques_access_authorized": authorized,
    }


def _sale(*, source_urls: list[str] | None = None, documents: list[dict[str, str]] | None = None) -> AuctionSale:
    return AuctionSale(
        source_name="avoventes",
        source_url="https://avoventes.fr/vente/cross-source",
        source_urls=source_urls or [],
        documents=documents or [],
        description="Maison",
    )


def _forbid_cache_or_provider_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        extraction,
        "_has_pdf_fact_cache",
        lambda *_args, **_kwargs: pytest.fail("EP guard must run before PDF cache inspection"),
    )
    monkeypatch.setattr(
        extraction,
        "load_llm_fact_context_chunks_for_sale",
        lambda *_args, **_kwargs: pytest.fail("EP guard must run before fact-cache loading"),
    )
    monkeypatch.setattr(
        extraction,
        "create_llm_client",
        lambda: pytest.fail("EP guard must run before provider creation"),
    )


@pytest.mark.parametrize(
    "sale",
    [
        pytest.param(
            _sale(documents=[{"label": "PV", "url": EP_DOCUMENT_URL}]),
            id="ep-document",
        ),
        pytest.param(
            _sale(source_urls=[EP_URL]),
            id="reviewed-ep-alias",
        ),
    ],
)
def test_cross_source_ep_evidence_is_rejected_before_cache_or_provider(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    sale: AuctionSale,
) -> None:
    monkeypatch.setattr(extraction, "load_settings", lambda: _settings(authorized=False))
    _forbid_cache_or_provider_reads(monkeypatch)

    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        extraction.enrich_sale_with_llm(sale, output_dir=tmp_path)


def test_authorized_cross_source_ep_alias_reaches_provider(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    sale = _sale(source_urls=[EP_URL])
    monkeypatch.setattr(extraction, "load_settings", lambda: _settings(authorized=True))
    contexts: list[str] = []
    monkeypatch.setattr(
        extraction,
        "load_llm_fact_context_chunks_for_sale",
        lambda _sale, **_kwargs: contexts.append("loaded") or ["EP context"],
    )
    monkeypatch.setattr(extraction, "_llm_request_context", lambda _sale, **_kwargs: nullcontext())

    class FakeClient:
        model = "test-model"

        def __init__(self) -> None:
            self.calls = 0

        def is_available(self) -> bool:
            return True

        def generate_json(self, _system_prompt: str, _user_prompt: str) -> dict[str, object]:
            self.calls += 1
            return {}

    client = FakeClient()
    stats = extraction.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path)

    assert client.calls == 1
    assert contexts == ["loaded"]
    assert stats.valid_json == 1
