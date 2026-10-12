from __future__ import annotations

import httpx

from src import pdf_enrichment
from src.pdf_document_transport import PublicDocumentTarget

CESSIONS_PDF = (
    "https://cessions.immobilier-etat.gouv.fr/sites/default/files/"
    "2_Condition_de_vente_-_Cahier_des_charges_260020007.pdf?download=1"
)


def _target(url: str) -> PublicDocumentTarget:
    host = httpx.URL(url).host
    return PublicDocumentTarget(url=url, hostname=host, port=443, addresses=("203.0.113.10",))


def test_cessions_documents_go_through_the_collector_relay(monkeypatch) -> None:
    # Drain of 12/10/2026: the publisher answers 403 to the runner, even for
    # robots.txt, while its collector succeeds through the relay.
    seen: list[str] = []

    def relay(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.7 relay")

    monkeypatch.setattr(pdf_enrichment, "_resolve_public_document_target", _target)
    monkeypatch.setattr(
        pdf_enrichment,
        "configured_transport",
        lambda url: httpx.MockTransport(relay) if "cessions.immobilier-etat.gouv.fr" in url else None,
    )
    monkeypatch.setattr(
        pdf_enrichment,
        "_PinnedHTTPTransport",
        lambda target: (_ for _ in ()).throw(AssertionError("direct transport used for a relayed host")),
    )

    response = pdf_enrichment._send_pinned_document_request(
        CESSIONS_PDF, headers={"User-Agent": "ImmojudisBot/1.0"}, timeout_seconds=10
    )

    assert response.status_code == 200
    assert response.content == b"%PDF-1.7 relay"
    assert seen == [CESSIONS_PDF]


def test_other_hosts_keep_the_pinned_direct_transport(monkeypatch) -> None:
    used: list[str] = []

    def direct(request: httpx.Request) -> httpx.Response:
        used.append(str(request.url))
        return httpx.Response(200, content=b"%PDF-1.7 direct")

    url = "https://avoventes.fr/public/uploads/cabinet/132/documents/6a7d825f4fe72ttt.pdf"
    monkeypatch.setattr(pdf_enrichment, "_resolve_public_document_target", _target)
    monkeypatch.setattr(pdf_enrichment, "configured_transport", lambda _url: None)
    monkeypatch.setattr(pdf_enrichment, "_PinnedHTTPTransport", lambda target: httpx.MockTransport(direct))

    response = pdf_enrichment._send_pinned_document_request(url, headers={}, timeout_seconds=10)

    assert response.content == b"%PDF-1.7 direct"
    assert used == [url]
