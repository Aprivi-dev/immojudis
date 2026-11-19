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


# --- Interrupteur illisible : une lecture ratée ne lève jamais un retrait


REAL_WITHDRAWN_SOURCES = source_withdrawal.withdrawn_sources


class _Switch:
    """L'interrupteur lu par le vrai cache (``withdrawn_sources``, ``known_withdrawn_sources``), relu à chaque appel.

    ``sources`` : les sources retirées en base, ou ``None`` quand la lecture rate (base injoignable).
    """

    def __init__(self, monkeypatch, sources: frozenset[str] | None) -> None:
        self.sources = sources
        monkeypatch.setattr(source_withdrawal, "withdrawn_sources", REAL_WITHDRAWN_SOURCES)
        monkeypatch.setattr(source_withdrawal, "read_withdrawn_sources", self._read)
        monkeypatch.setattr(source_withdrawal, "CACHE_SECONDS", 0.0)
        source_withdrawal.reset_cache()  # un processus neuf : aucune lecture réussie

    def _read(self, _db_url, *, unreadable=source_withdrawal.DEFAULT_WITHDRAWN, **_):
        return unreadable if self.sources is None else self.sources


def _record_invalidations(monkeypatch) -> list[str]:
    reasons: list[str] = []
    real = pdf_enrichment.invalidate_analysis

    def recording(payload: dict, reason: str, **kwargs) -> None:
        reasons.append(reason)
        real(payload, reason, **kwargs)

    monkeypatch.setattr(pdf_enrichment, "invalidate_analysis", recording)
    return reasons


def test_an_unreadable_switch_never_lifts_a_withdrawal(bench: QueueBench, monkeypatch) -> None:
    # Relecture du 19/11/2026 : une lecture ratée mettait DEFAULT_WITHDRAWN (vide) en cache, la vente cessait d'être à
    # jour, la pièce écartée était demandée à l'hôte retiré, puis révoquée au retour de l'interrupteur (analyse payée
    # deux fois).
    switch = _Switch(monkeypatch, frozenset())
    monkeypatch.setattr(extract_structured, "PDF_TEXTS_DIR", bench.dirs["pdf-texts"])
    bench.publish([READABLE, WITHDRAWN[0]])
    bench.drain()
    switch.sources = frozenset({"vench"})
    bench.age(1)
    bench.drain()
    _assert_dropped(bench)
    bench.row["raw_payload"]["llm_display_description"] = "Synthèse sans la pièce Vench."
    invalidations = _record_invalidations(monkeypatch)
    requests_before = len(bench.requests)

    switch.sources = None  # la base ne répond plus
    for hours in (1, 1, 24):  # visites répétées, puis la revalidation de 24 h (passe due à elle seule)
        bench.age(hours)
        assert documents_are_current(bench.stored_sale()) is (hours == 1)
        outcome = _drain_without_failure(bench)
        assert outcome.error is None and outcome.passes == (hours == 24), (hours, outcome)
        _assert_dropped(bench)
    switch.sources = frozenset({"vench"})  # la base répond de nouveau : rien ne change
    bench.age(1)
    assert _drain_without_failure(bench).passes == 0
    _assert_dropped(bench)

    assert WITHDRAWN[0] not in bench.requests[requests_before:]
    assert invalidations == []
    assert bench.row["raw_payload"]["llm_display_description"] == "Synthèse sans la pièce Vench."


def test_a_fresh_process_whose_first_switch_read_fails_sends_no_request_to_a_source_host(
    bench: QueueBench, monkeypatch
) -> None:
    # Aucune lecture réussie dans ce processus : on ne sait pas si Vench est retirée. La passe attend, sans requête,
    # sans rien écrire au manifeste et sans consommer d'essai ; elle reprend dès que l'interrupteur est lu.
    switch = _Switch(monkeypatch, None)
    bench.publish([READABLE, WITHDRAWN[0]])

    outcome = _drain_without_failure(bench)

    assert bench.requests == [] and bench.manifest == {}
    assert outcome.passes == 1 and all(job["attempt_count"] == 0 for job in bench.jobs)
    assert {job["status"] for job in bench.jobs} == {"queued"}
    assert "withdrawal switch unreadable" in bench.jobs[-1]["last_error"]

    switch.sources = frozenset({"vench"})
    bench.age(1)  # échéance du report
    outcome = _drain_without_failure(bench)
    assert outcome.error is None and bench.requests == [READABLE]
    assert bench.manifest["skipped_document_reasons"] == [
        {"url": WITHDRAWN[0], "reason": "withdrawn_source", "source": "vench"}
    ]


def test_an_unknown_withdrawal_state_does_not_touch_documents_of_other_hosts(bench: QueueBench, monkeypatch) -> None:
    _Switch(monkeypatch, None)
    bench.publish([READABLE])

    outcome = bench.drain()

    assert outcome.error is None and bench.jobs[-1]["status"] == "completed"
    assert bench.requests == [READABLE] and "80 m2" in str(bench.row["raw_text"])


def test_the_request_point_refuses_a_source_host_while_the_withdrawal_state_is_unknown(monkeypatch) -> None:
    monkeypatch.setitem(source_withdrawal.SOURCE_HOSTS, "vench", ("vench.example",))
    _Switch(monkeypatch, None)
    network = _Network(monkeypatch, {"https://pieces.etude.example/cahier.pdf": WITHDRAWN[0]}, {})

    with pytest.raises(pdf_enrichment.DocumentWithdrawalUnknown):
        pdf_enrichment._download_document_response(WITHDRAWN[0], headers={}, timeout_seconds=5)
    assert network.requests == [] and network.resolved == []
    # Une redirection vers l'hôte d'une source, retrait inconnu : le saut n'est pas suivi.
    with pytest.raises(pdf_enrichment.DocumentWithdrawalUnknown):
        pdf_enrichment._download_document_response(
            "https://pieces.etude.example/cahier.pdf", headers={}, timeout_seconds=5
        )
    assert WITHDRAWN_HOST not in network.hosts()


# --- Une URL écartée pour un autre motif sur l'hôte retiré


@pytest.mark.parametrize(
    "listed", [f"//{WITHDRAWN_HOST}/docs/1.pdf", "ftp://vench.example/docs/1.pdf"], ids=["sans-schema", "ftp"]
)
def test_a_document_of_a_withdrawn_host_skipped_for_another_reason_is_settled(bench: QueueBench, listed: str) -> None:
    # Écartée « invalid_url » (motif jugé avant le retrait), elle laissait la vente « pas à jour » pour toujours :
    # une passe à chaque visite. La règle de la sélection juge aussi le retrait enregistré.
    bench.publish([READABLE, listed])
    bench.drain()
    assert bench.manifest["skipped_document_reasons"] == [{"url": listed, "reason": "invalid_url"}]

    assert documents_are_current(bench.stored_sale())
    bench.age(1)
    assert bench.drain().passes == 0
    assert bench.requests == [READABLE]


# --- Révocation indépendante du point d'étape


def test_a_withdrawal_seen_in_a_deferred_pass_still_invalidates_the_analysis_once(
    bench: QueueBench, monkeypatch
) -> None:
    # Le point d'étape n'enregistre que le manifeste : il effaçait la preuve de la pièce retirée sans que la
    # révocation soit enregistrée, et la passe suivante, sans preuve, ne révoquait plus rien. Les faits du modèle et
    # la synthèse restaient tirés de la pièce retirée.
    switch = _Switch(monkeypatch, frozenset())
    monkeypatch.setattr(extract_structured, "PDF_TEXTS_DIR", bench.dirs["pdf-texts"])
    bench.publish([READABLE, WITHDRAWN[0]])
    bench.drain()
    payload = bench.row["raw_payload"]
    # Les faits du modèle lus sur les deux pièces (le contexte que ``extract_structured`` enregistre avec eux).
    payload["llm_fact_context_manifest"] = extract_structured._fact_context_manifest(bench.stored_sale())
    assert WITHDRAWN[0] in {document["url"] for document in payload["llm_fact_context_manifest"]["documents"]}
    payload["llm_fact_extraction"] = {"summary": "Surface 81 m2 (pièce Vench)."}
    payload["llm_display_description"] = "Synthèse avec la pièce Vench."

    switch.sources = frozenset({"vench"})
    late = f"{SALE_URL}/long-scan.pdf"  # une collecte liste une pièce nouvelle, à la lecture reportée une fois
    bench.serve(late, "Pièce nouvelle. Texte long.")
    bench.row["documents"].append({"label": "Cahier des conditions de vente 9", "url": late, "document_type": "pdf"})
    real_extract = pdf_enrichment.extract_attached_document
    deferred: list[str] = []

    def defer_once(file_path: object, document: dict | None = None) -> dict:
        if document and document.get("url") == late and not deferred:
            deferred.append(late)
            raise pdf_enrichment.PdfExtractionDeferred(
                "OCR budget", checkpointed_pages=0, total_pages=9, new_progress_pages=0
            )
        return real_extract(file_path, document=document)

    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", defer_once)
    bench.age(1)
    outcome = bench.drain()

    assert deferred == [late] and outcome.passes >= 2  # le point d'étape, puis la passe qui lit la pièce nouvelle
    payload = bench.row["raw_payload"]
    assert payload.get("source_content_change_reason") == "document_access_changed"
    for key in ("llm_fact_extraction", "llm_fact_context_manifest", "llm_display_description"):
        assert key not in payload, key
    assert "81 m2" not in str(bench.row["raw_text"])
    assert WITHDRAWN[0] not in str(bench.extraction_rows[-1]["result"])

    # Une seule fois : la nouvelle synthèse, faite sans la pièce, n'est plus invalidée.
    payload.update(llm_display_description="Synthèse sans la pièce Vench.")
    payload.pop("source_content_changed", None)
    payload.pop("source_content_change_reason", None)
    invalidations = _record_invalidations(monkeypatch)
    for hours in (1, 24):
        bench.age(hours)
        assert _drain_without_failure(bench).error is None
    assert invalidations == []
    assert bench.row["raw_payload"]["llm_display_description"] == "Synthèse sans la pièce Vench."


# --- La purge des textes reçus ne vise que les pièces écartées pour retrait


def test_a_document_skipped_for_another_reason_keeps_its_received_text() -> None:
    from src.models import AuctionSale
    from src.pdf_document_selection import store_document_analysis_status

    social = "https://www.facebook.com/etude/cahier.pdf"
    sale = AuctionSale(
        source_name="licitor",
        source_url=SALE_URL,
        documents=[{"label": "Cahier", "url": social, "document_type": "pdf"}],
        raw_payload={},
    )
    received = {
        "url": social,
        "label": "Cahier",
        "text": "Cahier. Surface habitable : 70 m2.",
        "complete": True,
        "extraction_status": "extracted",
        "sha256": "a" * 64,
        "page_count": 1,
    }

    store_document_analysis_status(sale, [], [received], merged_pdf_texts=[received])

    manifest = sale.raw_payload["document_analysis"]
    assert manifest["skipped_document_reasons"] == [{"url": social, "reason": "social_url"}]
    # Comportement d'avant le retrait des sources : le texte reçu reste dans la preuve et les profils.
    assert [item["url"] for item in manifest["cache_proof"]["documents"]] == [social]
    assert manifest["documents_extracted"] == 1


# --- Ordre des contrôles sur une redirection


def test_a_redirect_hop_to_a_withdrawn_source_never_enters_the_host_turn(monkeypatch) -> None:
    monkeypatch.setitem(source_withdrawal.SOURCE_HOSTS, "vench", ("vench.example",))
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"vench"}))
    third_party = "https://pieces.etude.example/vente/cahier-2.pdf"
    _Network(monkeypatch, {third_party: WITHDRAWN[0]}, {})
    turns: list[str] = []
    real_turn = pdf_enrichment._DOCUMENT_POLITENESS.turn

    def recording_turn(url: str):
        turns.append(url)  # copie robots en base, attente et tour d'hôte : rien de cela pour l'hôte retiré
        return real_turn(url)

    monkeypatch.setattr(pdf_enrichment._DOCUMENT_POLITENESS, "turn", recording_turn)

    with pytest.raises(pdf_enrichment.DocumentSourceWithdrawn):
        pdf_enrichment._download_document_response(third_party, headers={}, timeout_seconds=5)

    assert turns == [third_party]


# --- Séquence complète : lue, retirée, réintégrée


def test_a_document_dropped_by_a_withdrawal_is_read_again_as_soon_as_it_is_lifted(
    bench: QueueBench, monkeypatch
) -> None:
    switch = _Switch(monkeypatch, frozenset())
    monkeypatch.setattr(extract_structured, "PDF_TEXTS_DIR", bench.dirs["pdf-texts"])
    bench.publish([READABLE, WITHDRAWN[0]])
    bench.drain()
    assert "81 m2" in str(bench.row["raw_text"])
    bench.row["raw_payload"]["llm_display_description"] = "Synthèse avec la pièce Vench."

    switch.sources = frozenset({"vench"})
    bench.age(1)
    bench.drain()
    _assert_dropped(bench)
    assert bench.row["raw_payload"].get("source_content_change_reason") == "document_access_changed"
    assert "llm_display_description" not in bench.row["raw_payload"]

    switch.sources = frozenset()  # retrait levé, une heure plus tard : sans attendre la revalidation de 24 h
    bench.age(1)
    assert not documents_are_current(bench.stored_sale())
    outcome = bench.drain()

    assert outcome.error is None and outcome.passes == 1
    manifest, sale = bench.manifest, bench.stored_sale()
    assert manifest["skipped_document_urls"] == []
    assert {item["url"] for item in manifest["cache_proof"]["documents"]} == {READABLE, WITHDRAWN[0]}
    assert "81 m2" in str(sale.raw_text)
    assert WITHDRAWN[0] in {document["url"] for document in extract_structured._fact_context_manifest(sale)["documents"]}
    assert documents_are_current(sale)
