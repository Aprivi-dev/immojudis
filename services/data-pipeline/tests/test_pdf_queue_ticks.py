"""La file de lecture des pièces, visite après visite (lot R6 du 11/11/2026, correctifs C, D, F, G et H).

Chaque test rejoue un cas du diagnostic sur le banc ``tests/pdf_queue_bench.py`` : vrai code, faux réseau, fausse
base. Les trois derniers blocs sont les garde-fous à ne pas affaiblir : une pièce nouvelle ou modifiée est
toujours lue, un texte réellement perdu est toujours relu, une vente invalidée repasse.
"""

from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta

import pytest

from src.document_backlog import _read_with_current_rules, is_refused_checkpoint
from src.models import AuctionSale
from src.pdf_enrichment import DOCUMENT_FACTS_VERSION
from src.pdf_pass_outcomes import NOTHING_DUE_DEFERRAL, WRITE_DISCARDED_ERROR, WRITE_REFUSED_REVIEW
from src.pdf_progress import manifest_is_complete
from tests.pdf_queue_bench import SALE_URL, QueueBench, pdf_enrichment

READABLE = [f"{SALE_URL}/piece-{index}.pdf" for index in range(3)]


@pytest.fixture
def bench(monkeypatch, tmp_path):
    bench = QueueBench(monkeypatch, tmp_path)
    yield bench
    bench.close()


def _texts(bench: QueueBench) -> str:
    """Tout le texte des pièces enregistré en base pour la vente."""
    return " ".join(str(item.get("text") or "") for row in bench.extraction_rows for item in row["result"])


def _complete(bench: QueueBench) -> bool:
    return manifest_is_complete(bench.manifest, bench.stored_sale().documents)


def _first_read(bench: QueueBench, urls: list[str]) -> None:
    bench.publish(urls)
    outcome = bench.drain()
    assert outcome.passes == 1 and outcome.error is None
    assert bench.jobs[-1]["status"] == "completed"
    assert _complete(bench)


# --- C : la péremption se juge sur la preuve persistée (cas T8)


def test_prefetched_documents_are_reread_once_the_persisted_checks_expired(bench: QueueBench) -> None:
    # La lecture en avance télécharge les pièces d'un manifeste de plus de 24 heures : ses fichiers de suivi sont
    # frais, mais elle n'écrit rien en base. Jugée sur ces fichiers, la passe sous verrou ne reprenait aucune
    # pièce, n'avait aucun texte (restauration refusée : preuve périmée) et son point d'étape était refusé.
    _first_read(bench, READABLE)
    bench.age(25)
    bench.cold_runner()
    assert bench.prefetch()["read"] == 3
    downloaded_ahead = len(bench.requests)

    outcome = bench.drain()

    assert outcome.error is None and outcome.refused_checkpoints == 0
    assert bench.jobs[-1]["status"] == "completed"
    assert _complete(bench) and _read_with_current_rules(bench.stored_sale())
    assert len(bench.requests) == downloaded_ahead  # la passe relit les fichiers préparés, sans nouvelle requête


# --- D et G : rien à lire sur un manifeste complet (cas T3)


def test_a_cold_worker_waits_for_the_revalidation_instead_of_failing(bench: QueueBench) -> None:
    # Deux pièces lues et un lien mort : le manifeste est complet, mais son texte n'est pas restaurable sur un
    # runner neuf (règle stricte de restauration). Rien n'est périmé, la passe ne choisit aucune pièce.
    dead = f"{SALE_URL}/retiree.pdf"
    bench.publish([*READABLE[:2], dead])
    bench.gone.add(dead)
    assert bench.drain().error is None
    assert _complete(bench)
    bench.age(1)
    bench.cold_runner()
    manifest_before = copy.deepcopy(bench.manifest)
    requests_before = len(bench.requests)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert (job["status"], job["last_error"]) == ("queued", NOTHING_DUE_DEFERRAL)
    assert job["attempt_count"] == 0  # aucun essai consommé
    assert outcome.passes == 1  # le vidage n'enchaîne pas la même passe quatre fois
    assert outcome.waiting_passes == 1  # la visite apparaît dans le bilan du vidage
    assert outcome.error is None and outcome.refused_checkpoints == 0
    assert len(bench.requests) == requests_before
    assert bench.manifest == manifest_before  # le manifeste complet n'est pas remplacé par un manifeste vide
    # L'échéance est celle de la plus ancienne vérification enregistrée : 24 heures après la première lecture.
    wait = job["next_attempt_at"] - datetime.now(UTC)
    assert timedelta(hours=22, minutes=55) < wait < timedelta(hours=23, minutes=5)


def test_the_waiting_sale_is_read_again_when_its_checks_expire(bench: QueueBench) -> None:
    dead = f"{SALE_URL}/retiree.pdf"
    bench.publish([*READABLE[:2], dead])
    bench.gone.add(dead)
    bench.drain()
    bench.age(1)
    bench.cold_runner()
    bench.drain()
    waiting = bench.jobs[-1]
    assert waiting["last_error"] == NOTHING_DUE_DEFERRAL
    requests_before, jobs_before = len(bench.requests), len(bench.jobs)

    bench.age(24)
    bench.cold_runner()
    outcome = bench.drain()

    assert outcome.error is None and outcome.waiting_passes == 0
    # C'est la même tâche qui est reprise à son échéance, à son premier essai : aucune tâche neuve.
    assert len(bench.jobs) == jobs_before and bench.jobs[-1] is waiting
    assert (waiting["status"], waiting["attempt_count"]) == ("completed", 1)
    assert sorted(bench.requests[requests_before:]) == sorted([*READABLE[:2], dead])
    assert _complete(bench) and _read_with_current_rules(bench.stored_sale())


# --- F : la version des faits est posée dès que le manifeste est complet (cas T4)


def test_a_sale_without_any_readable_document_is_settled_after_one_pass(bench: QueueBench) -> None:
    # Toutes les pièces répondent 404 : aucun texte, donc aucune version de faits, donc une vente « à relire »
    # à chaque vidage, une tâche neuve terminée par tick.
    bench.publish(READABLE[:2])
    bench.gone.update(READABLE[:2])

    first = bench.drain()

    assert first.action == "processed" and bench.jobs[-1]["status"] == "completed"
    stored = bench.stored_sale()
    assert stored.raw_payload["document_facts_version"] == DOCUMENT_FACTS_VERSION
    assert _read_with_current_rules(stored)

    bench.cold_runner()
    second = bench.drain()

    assert second.action == "reprojected" and second.passes == 0
    assert len(bench.jobs) == 1


def test_dead_links_of_a_partial_manifest_do_not_set_the_facts_version(bench: QueueBench) -> None:
    # Huit liens morts : la passe en solde six, deux restent à essayer. Tant que le manifeste est partiel, rien
    # ne certifie que la vente est lue avec les règles actuelles.
    urls = [f"{SALE_URL}/lot-{index}.pdf" for index in range(8)]
    bench.publish(urls)
    bench.gone.update(urls)
    sale = bench.stored_sale()

    pdf_enrichment.enrich_sale_from_pdfs(sale)

    analysis = sale.raw_payload["document_analysis"]
    assert len(analysis["terminal_document_urls"]) == 6 and len(analysis["pending_document_urls"]) == 2
    assert not manifest_is_complete(analysis, sale.documents)
    assert "document_facts_version" not in sale.raw_payload


def test_a_sale_without_any_document_gets_no_facts_version(bench: QueueBench) -> None:
    # La collecte passe aussi par ``enrich_sale_from_pdfs`` pour une vente sans pièce : rien n'y est lu, la
    # version des faits n'a pas à dire le contraire.
    sale = AuctionSale(source_name="avoventes", source_url=SALE_URL, raw_text="Maison vendue aux enchères.")

    pdf_enrichment.enrich_sale_from_pdfs(sale)

    assert "document_facts_version" not in sale.raw_payload


# --- H : une écriture de fin de passe écartée ne termine pas la tâche, et ses essais sont bornés


def test_a_final_write_discarded_once_fails_the_attempt_then_the_reading_lands(bench: QueueBench) -> None:
    bench.publish(READABLE)
    bench.discarded_writes = 1  # la ligne de la vente a changé pendant la passe (garde de révision)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert (job["status"], job["last_error"]) == ("failed", f"{WRITE_DISCARDED_ERROR} (revision_moved)")
    assert job["attempt_count"] == 1  # un essai consommé : la tâche n'attend pas sans compter
    assert outcome.passes == 1 and outcome.error == job["last_error"]
    assert bench.manifest == {}  # rien n'a été enregistré : la tâche ne pouvait pas être « terminée »

    bench.age(1)
    bench.drain()

    assert len(bench.jobs) == 1 and (job["status"], job["attempt_count"]) == ("completed", 2)
    assert _complete(bench) and "Surface habitable : 81 m2" in _texts(bench)


def test_a_final_write_discarded_every_time_stops_after_four_attempts(bench: QueueBench) -> None:
    # Reportée sans essai, la tâche rejouait une passe complète à chaque visite, sans fin : ni le plafond de
    # relecture (elle n'est jamais « terminée ») ni la garde d'un jour (0 essai) ne la voyaient.
    bench.publish(READABLE)
    bench.discarded_writes = 99

    passes = 0
    for _visit in range(4):
        passes += bench.drain().passes
        bench.age(0.6)

    job = bench.jobs[-1]
    assert len(bench.jobs) == 1 and passes == 4
    assert (job["status"], job["attempt_count"], job["max_attempts"]) == ("failed", 4, 4)
    assert job["last_error"] == f"{WRITE_DISCARDED_ERROR} (revision_moved)"
    assert bench._claim("base-du-banc", job["id"]) is None  # essais épuisés : plus aucune prise


def test_a_final_write_refused_at_admission_ends_in_review_after_four_daily_attempts(bench: QueueBench) -> None:
    # La vente n'a ni prix ni surface une fois ses pièces lues : l'écriture est refusée à chaque passe. C'est un
    # état de la vente : un essai par jour, puis la tâche est annulée pour revue au lieu de tourner sans fin.
    bench.publish(READABLE)
    for url in READABLE:
        bench.serve(url, "Cahier des conditions de vente. Texte sans mesure ni montant.")
    bench.row["starting_price_eur"] = None

    endings = []
    for _day in range(4):
        outcome = bench.drain()
        job = bench.jobs[-1]
        endings.append((outcome.passes, job["status"], job["attempt_count"], job["last_error"]))
        if job["status"] == "failed":
            wait = job["next_attempt_at"] - datetime.now(UTC)
            assert timedelta(hours=23, minutes=59) < wait <= timedelta(hours=24)
        bench.age(24.1)
        bench.cold_runner()

    refused = f"{WRITE_DISCARDED_ERROR} (missing_price_and_surface)"
    assert len(bench.jobs) == 1
    assert endings == [
        (1, "failed", 1, refused),
        (1, "failed", 2, refused),
        (1, "failed", 3, refused),
        (1, "cancelled", 4, f"{WRITE_REFUSED_REVIEW} (missing_price_and_surface)"),
    ]
    assert bench.manifest == {}


# --- Garde-fou : une pièce nouvelle ou modifiée est toujours lue


def test_a_new_document_is_read_on_the_next_visit(bench: QueueBench) -> None:
    _first_read(bench, READABLE)
    new_url = f"{SALE_URL}/avenant.pdf"
    bench.serve(new_url, "Avenant au cahier. La visite aura lieu sur place.")
    bench.row["documents"].append({"label": "Avenant", "url": new_url, "document_type": "pdf"})

    outcome = bench.drain()

    assert outcome.error is None and new_url in bench.requests
    assert bench.jobs[-1]["status"] == "completed"
    assert _complete(bench) and "Avenant au cahier" in _texts(bench)


@pytest.mark.parametrize("prefetched", [False, True])
def test_a_document_replaced_at_its_source_is_read_again_after_the_window(bench: QueueBench, prefetched: bool) -> None:
    _first_read(bench, READABLE)
    assert "Surface habitable : 80 m2" in _texts(bench)
    bench.serve(READABLE[0], "Pièce rectifiée. Surface habitable : 95 m2. Texte du cahier.")
    bench.age(25)
    if prefetched:
        # La lecture en avance télécharge la nouvelle version et rafraîchit le fichier de suivi : la passe doit
        # quand même reprendre la pièce, puisque rien n'en est enregistré.
        bench.prefetch()

    outcome = bench.drain()

    assert outcome.error is None and bench.jobs[-1]["status"] == "completed"
    texts = _texts(bench)
    assert "Surface habitable : 95 m2" in texts and "Surface habitable : 80 m2" not in texts
    assert _complete(bench)


# --- Garde-fou : un texte réellement perdu n'est pas masqué, et il est relu


def test_a_lost_text_stays_a_visible_failure_with_its_reason(bench: QueueBench) -> None:
    # Manifeste complet et restaurable par règle, mais les lignes d'extraction ont disparu : ce n'est pas le cas
    # « rien à lire », la tâche ne doit pas être mise en attente comme si tout allait bien.
    _first_read(bench, READABLE)
    bench.extraction_rows.clear()
    bench.age(1)
    bench.cold_runner()
    manifest_before = copy.deepcopy(bench.manifest)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert job["status"] == "failed"
    assert job["last_error"] == "PDF document checkpoint was not persisted; retry required: no_progress_entries"
    assert is_refused_checkpoint(job["last_error"]) and outcome.refused_checkpoints == 1
    assert bench.manifest == manifest_before


def test_a_complete_manifest_whose_proof_was_altered_stays_a_visible_failure(bench: QueueBench) -> None:
    # Aucune URL écartée : rien n'interdit de restaurer ce texte, c'est la preuve qui est abîmée. Ce n'est pas le
    # cas « rien à lire », la tâche ne doit pas attendre un jour comme si tout allait bien.
    _first_read(bench, READABLE)
    bench.row["raw_payload"]["document_analysis"]["cache_proof"]["input_fingerprint"] = "autre"
    assert _complete(bench)
    bench.age(1)
    bench.cold_runner()

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert job["status"] == "failed"
    assert job["last_error"] == "PDF document checkpoint was not persisted; retry required: no_progress_entries"
    assert outcome.waiting_passes == 0 and outcome.refused_checkpoints == 1


def test_a_lost_text_is_read_again_when_its_checks_expire(bench: QueueBench) -> None:
    _first_read(bench, READABLE)
    bench.extraction_rows.clear()
    bench.age(25)
    bench.cold_runner()
    requests_before = len(bench.requests)

    outcome = bench.drain()

    assert outcome.error is None and bench.jobs[-1]["status"] == "completed"
    assert sorted(bench.requests[requests_before:]) == sorted(READABLE)
    assert all(f"Surface habitable : {80 + index} m2" in _texts(bench) for index in range(3))


# --- Garde-fou : une vente réellement invalidée repasse


def test_a_sale_whose_reading_was_invalidated_is_read_again_at_once(bench: QueueBench) -> None:
    # Une collecte constate que la liste des pièces a changé : elle retire le manifeste et la version des faits
    # (main._preserve_known_enrichment_payloads). La vente est relue à la visite suivante, sans attendre.
    _first_read(bench, READABLE)
    payload = bench.row["raw_payload"]
    payload["superseded_document_analysis"] = payload.pop("document_analysis")
    payload.pop("document_facts_version")
    bench.cold_runner()
    requests_before = len(bench.requests)

    outcome = bench.drain()

    assert outcome.action == "processed" and outcome.error is None
    assert bench.jobs[-1]["status"] == "completed"
    assert sorted(bench.requests[requests_before:]) == sorted(READABLE)
    assert _read_with_current_rules(bench.stored_sale())
