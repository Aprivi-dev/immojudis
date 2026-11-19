"""Pièces hébergées par une source retirée du catalogue, dans une vente qui reste affichée (vente fusionnée).

Vench et Petites Affiches sont retirées : leurs pièces ne sont jamais demandées. Elles restaient pourtant « à lire »
dans le manifeste, et la tâche pdf finissait en échec définitif (« Document extraction incomplete; retry required:
0 extraction errors, N failed documents »). Elles sont maintenant écartées avec le motif ``withdrawn_source``, comme
un lien non documentaire, et relues dès que le retrait est levé.

Banc de la file (``tests/pdf_queue_bench.py``) : vrai code, faux réseau. L'hôte de la source retirée est fictif.
"""

from __future__ import annotations

import httpx
import pymupdf
import pytest

from src import document_politeness, pdf_enrichment, source_withdrawal
from src.document_politeness import DocumentPoliteness
from src.enrichment import extract_structured
from src.freshness import documents_are_current
from src.normalize import clean_text
from src.pdf_document_transport import PublicDocumentTarget
from src.pdf_progress import manifest_is_complete, stale_complete_document_urls
from tests.pdf_queue_bench import SALE_URL, QueueBench

READABLE = f"{SALE_URL}/cahier.pdf"
WITHDRAWN_HOST = "documents.vench.example"
WITHDRAWN = [f"https://{WITHDRAWN_HOST}/docs/{index}.pdf" for index in (1, 2)]
REAL_DOWNLOAD_RESPONSE = pdf_enrichment._download_document_response


@pytest.fixture
def bench(monkeypatch, tmp_path):
    monkeypatch.setitem(source_withdrawal.SOURCE_HOSTS, "vench", ("vench.example",))
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"vench"}))
    bench = QueueBench(monkeypatch, tmp_path)
    yield bench
    bench.close()


def _texts(bench: QueueBench) -> str:
    return " ".join(str(item.get("text") or "") for row in bench.extraction_rows for item in row["result"])


def _withdrawn_requests(bench: QueueBench) -> list[str]:
    return [url for url in bench.requests if WITHDRAWN_HOST in url]


def test_documents_of_a_withdrawn_source_are_skipped_and_the_others_are_read(bench: QueueBench) -> None:
    bench.publish([READABLE, *WITHDRAWN])

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert outcome.error is None and job["status"] == "completed"
    assert _withdrawn_requests(bench) == [] and bench.requests == [READABLE]
    assert "Surface habitable : 80 m2" in _texts(bench)
    manifest = bench.manifest
    assert manifest["failed_documents"] == 0 and manifest["failed_document_urls"] == []
    assert manifest["skipped_document_urls"] == WITHDRAWN
    assert manifest["skipped_document_reasons"] == [
        {"url": url, "reason": "withdrawn_source", "source": "vench"} for url in WITHDRAWN
    ]
    assert manifest_is_complete(manifest, bench.stored_sale().documents)


def test_a_sale_whose_documents_are_all_on_a_withdrawn_source_never_fails(bench: QueueBench) -> None:
    bench.publish(WITHDRAWN)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert outcome.error is None and job["status"] in {"completed", "queued"}
    assert job["attempt_count"] <= 1 and "failed documents" not in str(job["last_error"])
    assert bench.requests == []
    assert bench.manifest["failed_documents"] == 0
    assert {item["reason"] for item in bench.manifest["skipped_document_reasons"]} == {"withdrawn_source"}
    # L'avertissement nomme ce motif, pas celui des liens sociaux ou de médias.
    warning = bench.manifest["warning"]
    assert "source retirée du catalogue n'ont pas été téléchargées" in warning and "sociales" not in warning


def test_documents_are_read_once_the_withdrawal_is_lifted(bench: QueueBench, monkeypatch) -> None:
    bench.publish([READABLE, *WITHDRAWN])
    bench.drain()
    assert bench.manifest["skipped_document_urls"] == WITHDRAWN

    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset())
    bench.age(25)  # le manifeste enregistré n'est plus frais : la visite suivante fait une passe
    outcome = bench.drain()

    assert outcome.error is None and bench.jobs[-1]["status"] == "completed"
    # Dès la première passe : l'écart enregistré ne vaut plus réglé une fois le retrait levé.
    assert outcome.passes == 1 and outcome.partial_passes == 0
    assert sorted(_withdrawn_requests(bench)) == WITHDRAWN
    assert "Surface habitable : 81 m2" in _texts(bench) and "Surface habitable : 82 m2" in _texts(bench)
    assert bench.manifest["skipped_document_urls"] == []
    assert manifest_is_complete(bench.manifest, bench.stored_sale().documents)


@pytest.mark.parametrize("control", ["\n", "\t"])
def test_a_control_character_in_the_host_does_not_hide_a_withdrawn_source(
    bench: QueueBench, monkeypatch, control: str
) -> None:
    # L'URL demandée est l'URL listée : ``urlsplit`` y supprime le caractère et lit l'hôte de la source retirée, quand
    # le nettoyage (``clean_text``) le change en espace. Jugée sur la seule forme nettoyée, la pièce était demandée.
    listed = f"https://documents.ven{control}ch.example/docs/1.pdf"
    reached_download: list[str] = []
    real_suspended_host_until = pdf_enrichment.suspended_host_until

    def _suspended_host_until(url: str, db_url: str):
        reached_download.append(url)  # première étape de chaque pièce dans la boucle de téléchargement
        return real_suspended_host_until(url, db_url)

    monkeypatch.setattr(pdf_enrichment, "suspended_host_until", _suspended_host_until)
    bench.publish([READABLE, listed])

    outcome = bench.drain()

    assert outcome.error is None and bench.jobs[-1]["status"] == "completed"
    # Aucune requête vers l'hôte retiré, ni robots.txt ni pièce : la pièce n'atteint pas le téléchargement.
    assert bench.requests == [READABLE] and reached_download == [READABLE]
    skipped = clean_text(listed)
    assert bench.manifest["skipped_document_urls"] == [skipped]
    assert bench.manifest["skipped_document_reasons"] == [
        {"url": skipped, "reason": "withdrawn_source", "source": "vench"}
    ]


def _read_before_the_withdrawal(bench: QueueBench, monkeypatch, *, half_read: bool) -> None:
    """La vente est lue source ouverte, puis Vench est retirée. ``half_read`` : la pièce Vench n'est lue qu'à moitié
    (sa page 2 reste illisible), son texte partiel est dans le manifeste."""
    monkeypatch.setattr(extract_structured, "PDF_TEXTS_DIR", bench.dirs["pdf-texts"])
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset())
    bench.publish([READABLE, WITHDRAWN[0]])
    if half_read:
        bench.served[WITHDRAWN[0]] = _two_page_pdf(bench)
        real_extract = pdf_enrichment.extract_attached_document

        def second_page_unreadable(file_path: object, document: dict | None = None) -> dict:
            payload = real_extract(file_path, document=document)
            if document and document.get("url") == WITHDRAWN[0]:
                first = payload["pages"][0]
                payload["pages"] = [first, {"page": 2, "text": "", "chars": 0, "status": "failed", "retryable": True}]
                payload.update(
                    text=first["text"], text_chars=len(first["text"]), failed_pages=[2], complete=False,
                    extraction_status="incomplete",
                )
            return payload

        monkeypatch.setattr(pdf_enrichment, "extract_attached_document", second_page_unreadable)
    bench.drain()
    assert sorted(bench.requests) == sorted([READABLE, WITHDRAWN[0]])
    proof = {item["url"]: item for item in bench.manifest["cache_proof"]["documents"]}
    assert proof[WITHDRAWN[0]]["text_present"] and proof[WITHDRAWN[0]]["complete"] is not half_read
    # Lue en entier, la pièce a nourri le texte et les faits de la vente ; lue à moitié, son texte partiel est
    # enregistré (point d'étape) et la tâche reste en échec, à reprendre.
    assert ("81 m2" in str(bench.row["raw_text"])) is not half_read
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"vench"}))


def _two_page_pdf(bench: QueueBench) -> bytes:
    path = bench.tmp_path / "deux-pages.pdf"
    with pymupdf.open() as document:
        for text in ("Pièce 1. Surface habitable : 81 m2.", "Pièce 1, page 2. Texte du cahier."):
            document.new_page().insert_text((72, 72), text)
        document.save(path)
    return path.read_bytes()


def _assert_dropped(bench: QueueBench) -> None:
    """La pièce Vench est écartée, et rien de son texte ne reste : ni profil lu, ni preuve, ni progression, ni
    contrôle HTTP, ni cache local, ni faits ; la vente est à jour."""
    manifest, sale = bench.manifest, bench.stored_sale()
    assert manifest["skipped_document_urls"] == [WITHDRAWN[0]]
    assert manifest["skipped_document_reasons"] == [
        {"url": WITHDRAWN[0], "reason": "withdrawn_source", "source": "vench"}
    ]
    assert manifest["failed_documents"] == 0 and manifest["pending_document_urls"] == []
    assert manifest["http_revalidation_pending_urls"] == []
    extracted = {profile["url"] for profile in manifest["profiles"] if profile.get("extraction_status") == "extracted"}
    assert extracted == {READABLE} and manifest["documents_extracted"] == 1
    assert [item["url"] for item in manifest["cache_proof"]["documents"]] == [READABLE]
    assert [item["url"] for item in manifest["document_progress"]] == [READABLE]
    assert set(manifest["http_checked_at_by_url"]) == {READABLE}
    assert stale_complete_document_urls(manifest, sale.documents) == set()
    facts = extract_structured._fact_context_manifest(sale)
    assert [document["url"] for document in facts["documents"]] == [READABLE]
    assert "81 m2" not in str(sale.raw_text) and "80 m2" in str(sale.raw_text)
    provenance = sale.raw_payload.get("pdf_fact_provenance") or {}
    assert all(trace.get("document_url") != WITHDRAWN[0] for trace in provenance.values() if isinstance(trace, dict))
    assert manifest["manifest_complete"] is True and manifest_is_complete(manifest, sale.documents)
    assert documents_are_current(sale)


@pytest.mark.parametrize("half_read", [False, True])
@pytest.mark.parametrize("cold_runner", [False, True])
def test_a_document_read_before_the_withdrawal_is_dropped_with_its_facts(
    bench: QueueBench, monkeypatch, cold_runner: bool, half_read: bool
) -> None:
    # Décision du 19/11/2026 : dès qu'une source est retirée, ses pièces sont écartées, même déjà lues ; leur texte
    # et les faits qui en sont tirés ne servent plus tant que dure le retrait. Le même état, à chaque visite, que le
    # cache du runner soit chaud ou neuf (texte restauré depuis la base, ou relu chez l'hôte resté ouvert).
    _read_before_the_withdrawal(bench, monkeypatch, half_read=half_read)
    requests_before = len(bench.requests)

    for hours in (1, 24, 24):  # +1 h (pièces encore fraîches), +25 h et +49 h (revalidation due)
        bench.age(hours)
        if cold_runner:
            bench.cold_runner()
        outcome = _drain_without_failure(bench)

        assert outcome.error is None and outcome.passes == 1, (hours, outcome)
        assert bench.jobs[-1]["status"] == "completed"
        _assert_dropped(bench)
        # Les faits tirés de son texte sont recalculés une fois, à la première passe : l'analyse qui en dépendait
        # (faits du modèle, synthèse) est invalidée comme pour une pièce devenue terminale.
        payload = bench.row["raw_payload"]
        assert (payload.pop("source_content_change_reason", None) == "document_access_changed") is (hours == 1)
        payload.pop("source_content_changed", None)
        if not cold_runner:
            # À jour : la visite suivante ne refait pas de passe.
            assert _drain_without_failure(bench).passes == 0
            _assert_dropped(bench)

    assert _withdrawn_requests(bench) == [WITHDRAWN[0]]  # la seule, avant le retrait
    assert WITHDRAWN[0] not in bench.requests[requests_before:]


def _drain_without_failure(bench: QueueBench):
    """Une visite, dont aucune tâche ne sort en échec."""
    before = {job["id"]: dict(job) for job in bench.jobs}
    outcome = bench.drain()
    touched = [job for job in bench.jobs if before.get(job["id"]) != job]
    assert all(job["status"] != "failed" for job in touched), touched
    return outcome


# --- Le retrait jugé au point de requête : hôte tel que le client le résout, redirections


DISGUISED_HOSTS = {
    "point idéographique": "documents.vench。example",
    "point pleine chasse": "documents.vench．example",
    "pleine chasse": "documents.ｖｅｎｃｈ.example",
    "espace sans chasse": "documents.ven​ch.example",
    "trait d'union conditionnel": "documents.ven­ch.example",
}


@pytest.mark.parametrize("host", DISGUISED_HOSTS.values(), ids=DISGUISED_HOSTS.keys())
def test_a_disguised_host_of_a_withdrawn_source_is_skipped_at_selection(
    bench: QueueBench, monkeypatch, host: str
) -> None:
    # La résolution (``getaddrinfo``) ramène ces hôtes à documents.vench.example : lus tels quels, ils n'étaient pas
    # reconnus, et robots.txt puis la pièce étaient demandés à l'hôte retiré.
    listed = f"https://{host}/docs/1.pdf"
    reached_download: list[str] = []
    real_suspended_host_until = pdf_enrichment.suspended_host_until

    def _suspended_host_until(url: str, db_url: str):
        reached_download.append(url)
        return real_suspended_host_until(url, db_url)

    monkeypatch.setattr(pdf_enrichment, "suspended_host_until", _suspended_host_until)
    bench.publish([READABLE, listed])

    outcome = bench.drain()

    assert outcome.error is None and bench.jobs[-1]["status"] == "completed"
    assert bench.requests == [READABLE] and reached_download == [READABLE]
    assert bench.manifest["skipped_document_reasons"] == [
        {"url": listed, "reason": "withdrawn_source", "source": "vench"}
    ]


class _Network:
    """Le vrai chemin des requêtes de pièce (``_download_document_response``, ``_send_pinned_document_request``,
    robots.txt) devant un faux réseau : résolutions DNS et requêtes notées, redirections servies."""

    def __init__(self, monkeypatch, redirects: dict[str, str], served: dict[str, bytes]) -> None:
        self.resolved: list[str] = []
        self.requests: list[str] = []
        self.redirects, self.served = redirects, served
        monkeypatch.setattr(pdf_enrichment, "_download_document_response", REAL_DOWNLOAD_RESPONSE)
        monkeypatch.setattr(pdf_enrichment, "_resolve_public_document_target", self._resolve)
        monkeypatch.setattr(pdf_enrichment, "configured_transport", lambda _url: None)
        monkeypatch.setattr(pdf_enrichment, "_PinnedHTTPTransport", lambda _target: httpx.MockTransport(self._send))
        monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)
        monkeypatch.setattr(pdf_enrichment, "_DOCUMENT_POLITENESS", DocumentPoliteness(
            user_agent=lambda: "immojudis-banc", fetch_robots=pdf_enrichment._fetch_document_robots,
            sleep=lambda _s: None, min_delay_seconds=0.0,
        ))

    def _resolve(self, url: str) -> PublicDocumentTarget:
        host = str(httpx.URL(url).host)
        self.resolved.append(host)
        return PublicDocumentTarget(url=url, hostname=host, port=443, addresses=("203.0.113.10",))

    def _send(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requests.append(url)
        if url.endswith("/robots.txt"):
            return httpx.Response(404)
        if url in self.redirects:
            return httpx.Response(302, headers={"location": self.redirects[url]})
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=self.served[url])

    def hosts(self) -> set[str]:
        return {str(httpx.URL(url).host) for url in self.requests} | set(self.resolved)


@pytest.mark.parametrize("host", ["documents.vench.example", *DISGUISED_HOSTS.values()])
def test_no_document_request_nor_resolution_reaches_a_withdrawn_source(monkeypatch, host: str) -> None:
    # Le filet derrière la sélection : toute requête de pièce passe par ``_send_pinned_document_request``.
    monkeypatch.setitem(source_withdrawal.SOURCE_HOSTS, "vench", ("vench.example",))
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"vench"}))
    network = _Network(monkeypatch, {}, {})

    with pytest.raises(pdf_enrichment.DocumentSourceWithdrawn) as refused:
        pdf_enrichment._download_document_response(f"https://{host}/docs/1.pdf", headers={}, timeout_seconds=5)

    assert refused.value.source == "vench"
    assert network.requests == [] and network.resolved == []


def test_a_redirect_to_a_withdrawn_source_is_not_followed_and_the_document_is_skipped(
    bench: QueueBench, monkeypatch
) -> None:
    third_party = "https://pieces.etude.example/vente/cahier-2.pdf"
    network = _Network(monkeypatch, {third_party: WITHDRAWN[0]}, bench.served)
    bench.publish([READABLE, third_party])

    for visit in range(2):  # puis à la revalidation : la pièce est redemandée à son hôte, et toujours écartée
        if visit:
            bench.age(25)
        outcome = bench.drain()

        assert outcome.error is None and outcome.passes == 1
        assert bench.jobs[-1]["status"] == "completed"
        assert WITHDRAWN_HOST not in network.hosts()
        assert third_party in network.requests  # la pièce est demandée à son hôte, la redirection n'est pas suivie
        manifest = bench.manifest
        assert manifest["failed_documents"] == 0
        assert manifest["skipped_document_reasons"] == [
            {"url": third_party, "reason": "withdrawn_source", "source": "vench"}
        ]
        assert manifest_is_complete(manifest, bench.stored_sale().documents)
        assert documents_are_current(bench.stored_sale())
    assert network.requests.count(third_party) == 2
