"""Pièces hébergées par une source retirée du catalogue, dans une vente qui reste affichée (vente fusionnée).

Vench et Petites Affiches sont retirées : leurs pièces ne sont jamais demandées. Elles restaient pourtant « à lire »
dans le manifeste, et la tâche pdf finissait en échec définitif (« Document extraction incomplete; retry required:
0 extraction errors, N failed documents »). Elles sont maintenant écartées avec le motif ``withdrawn_source``, comme
un lien non documentaire, et relues dès que le retrait est levé.

Banc de la file (``tests/pdf_queue_bench.py``) : vrai code, faux réseau. L'hôte de la source retirée est fictif.
"""

from __future__ import annotations

import pytest

from src import pdf_enrichment, source_withdrawal
from src.enrichment import extract_structured
from src.freshness import documents_are_current
from src.normalize import clean_text
from src.pdf_progress import manifest_is_complete
from tests.pdf_queue_bench import SALE_URL, QueueBench

READABLE = f"{SALE_URL}/cahier.pdf"
WITHDRAWN_HOST = "documents.vench.example"
WITHDRAWN = [f"https://{WITHDRAWN_HOST}/docs/{index}.pdf" for index in (1, 2)]


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


@pytest.mark.parametrize("cold_runner", [False, True])
def test_documents_read_before_the_withdrawal_keep_their_text_and_facts(
    bench: QueueBench, monkeypatch, cold_runner: bool
) -> None:
    # Vente fusionnée dont une pièce Vench a été lue avant le retrait, relue depuis le cache (règles de lecture
    # nouvelles). Avant le motif withdrawn_source, son texte restait dans le manifeste et dans les faits ; garder ou
    # retirer ces faits pendant le retrait est une décision à part. Seule une nouvelle requête est empêchée.
    monkeypatch.setattr(extract_structured, "PDF_TEXTS_DIR", bench.dirs["pdf-texts"])
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset())
    bench.publish([READABLE, WITHDRAWN[0]])
    assert bench.drain().error is None
    assert sorted(bench.requests) == sorted([READABLE, WITHDRAWN[0]])

    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"vench"}))
    if cold_runner:
        bench.cold_runner()  # le texte vient de la base (restauration), plus du disque du runner
    bench.row["raw_payload"]["document_facts_version"] = "document_facts_v0"
    outcome = bench.drain()

    assert outcome.error is None and bench.jobs[-1]["status"] == "completed"
    assert len(bench.requests) == 2
    manifest = bench.manifest
    assert manifest["skipped_document_urls"] == [] and manifest["skipped_document_reasons"] == []
    extracted = {profile["url"] for profile in manifest["profiles"] if profile.get("extraction_status") == "extracted"}
    assert extracted == {READABLE, WITHDRAWN[0]}
    facts = extract_structured._fact_context_manifest(bench.stored_sale())
    assert {document["url"] for document in facts["documents"]} == {READABLE, WITHDRAWN[0]}
    # Pièces à jour : la vente n'est pas reprise à chaque vidage.
    assert documents_are_current(bench.stored_sale())
