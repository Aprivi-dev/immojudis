from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from src import pdf_enrichment
from src.config import EncheresPubliquesAccessNotAuthorized
from src.encheres_publiques_guard import require_encheres_publiques_sale_access
from src.models import AuctionSale

EP_DOCUMENT_URL = "https://www.encheres-publiques.com/documents/pv.pdf"


def _sale_with_cross_source_ep_document() -> AuctionSale:
    return AuctionSale(
        source_name="avoventes",
        source_url="https://avoventes.fr/vente/cross-source-document",
        description="Maison",
        documents=[{"label": "PV", "url": EP_DOCUMENT_URL, "document_type": "pdf"}],
    )


def _settings(*, authorized: bool) -> dict[str, object]:
    return {
        "enable_encheres_publiques_benchmark": authorized,
        "encheres_publiques_access_authorized": authorized,
        "user_agent": "immojudis-document-guard-test",
        "request_timeout_seconds": 5,
        "pdf_max_download_mb": 25,
    }


def test_cross_source_ep_alias_url_requires_authorization() -> None:
    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        require_encheres_publiques_sale_access(
            source_name="avoventes",
            source_url="https://avoventes.fr/vente/alias",
            source_urls=[EP_DOCUMENT_URL],
            documents=[],
            settings=_settings(authorized=False),
        )


def test_cross_source_ep_document_is_rejected_before_any_request(monkeypatch, tmp_path: Path) -> None:
    sale = _sale_with_cross_source_ep_document()
    requests: list[str] = []
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: _settings(authorized=False))
    monkeypatch.setattr(
        pdf_enrichment,
        "_select_documents_for_extraction",
        lambda documents, **_: documents,
    )
    monkeypatch.setattr(
        pdf_enrichment,
        "_download_document_response",
        lambda url, **_: requests.append(url) or pytest.fail("EP request must be blocked"),
    )

    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        pdf_enrichment.download_documents(sale, output_root=tmp_path)

    assert requests == []
    assert list(tmp_path.iterdir()) == []


def test_cross_source_ep_document_downloads_when_both_access_switches_are_true(
    monkeypatch,
    tmp_path: Path,
) -> None:
    sale = _sale_with_cross_source_ep_document()
    requests: list[str] = []
    settings = _settings(authorized=True)
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: settings)
    monkeypatch.setattr(
        pdf_enrichment,
        "_select_documents_for_extraction",
        lambda documents, **_: documents,
    )

    def fake_download_response(url: str, **_: object) -> httpx.Response:
        requests.append(url)
        return httpx.Response(
            200,
            headers={"content-type": "application/pdf"},
            content=b"%PDF-1.4 synthetic EP document",
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(pdf_enrichment, "_download_document_response", fake_download_response)

    downloaded = pdf_enrichment.download_documents(sale, output_root=tmp_path)

    assert requests == [EP_DOCUMENT_URL]
    assert downloaded[0]["url"] == EP_DOCUMENT_URL
    assert downloaded[0]["file_format"] == "pdf"


def test_redirect_to_ep_is_blocked_before_the_second_request(monkeypatch) -> None:
    requests: list[str] = []
    monkeypatch.setattr(pdf_enrichment, "load_settings", lambda: _settings(authorized=False))

    def fake_request(url: str, **_: object) -> httpx.Response:
        requests.append(url)
        return httpx.Response(
            302,
            headers={"location": EP_DOCUMENT_URL},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(pdf_enrichment, "_send_pinned_document_request", fake_request)

    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        pdf_enrichment._download_document_response(
            "https://avoventes.fr/documents/redirect.pdf",
            headers={},
            timeout_seconds=5,
        )

    assert requests == ["https://avoventes.fr/documents/redirect.pdf"]
