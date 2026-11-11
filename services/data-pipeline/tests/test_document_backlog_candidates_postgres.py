"""La sélection du vidage des pièces, exécutée pour de vrai (PIPELINE_TEST_DB_URL, base jetable, sinon ignoré).

Lot R6. Plafond de relecture (correctif B) : le 11/11/2026, 3 ventes prenaient 104 des 200 lectures pdf terminées
en 48 heures. Chaque lecture terminée laissait la vente à relire et lui créait une tâche d'une nouvelle empreinte,
que ni les 4 essais ni la garde « essayée depuis moins d'un jour » ne bornent. Le plafond ne compte que les
lectures demandées par le vidage (sa priorité) et terminées. Les gardes de #415 (une tâche annulée ou dépassée ne
bloque pas la vente) restent vérifiées ici : une vente réellement invalidée repasse le jour même.

Attente d'une revue (correctif H) : une tâche pdf annulée ``review_required`` n'est pas réveillée par le vidage.

Limite : les tables sont créées ici à la main, avec les seules colonnes que la requête lit ; la table des tâches
et les deux fonctions de retrait viennent des vraies migrations.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb

from src import document_backlog as backlog
from src.pdf_enrichment import DOCUMENT_FACTS_VERSION
from src.pdf_pass_outcomes import NOTHING_DUE_DEFERRAL, WRITE_DISCARDED_ERROR, review_message
from src.storage.supabase_client import _postgres_connect

ROOT = Path(__file__).resolve().parents[3]
URL = "https://example.test/vente"
DRAIN = backlog.BACKLOG_PDF_PRIORITY
GENERAL_LANE = 30  # priorité des tâches créées à la publication (supabase_client._enqueue_due_enrichment)
SUPERSEDED = "Superseded by a newer input revision"
REVIEW = review_message("missing_price_and_surface")  # le message que la file écrit, version courante


def _migration(name: str) -> str:
    return (ROOT / "supabase/migrations" / name).read_text()


def _withdrawal_functions() -> str:
    """Les deux vraies fonctions de retrait que la sélection appelle (migration 20261021110000)."""
    text = _migration("20261021110000_licitor_source_withdrawal.sql")
    chunks = []
    for name in ("catalogue_withdrawn_sources", "sale_is_fully_withdrawn"):
        start = text.index(f"create or replace function app_private.{name}(")
        chunks.append(text[start : text.index("$function$;", start) + len("$function$;")])
    return "\n".join(chunks)


def _setup(db) -> None:
    db.execute("create schema if not exists app_private")
    db.execute(
        """create table auction_sales(source_url text primary key, source_name text not null,
        sale_date timestamptz, documents jsonb not null default '[]', status text not null default 'upcoming',
        retention_deadline_materialized boolean not null default true, retention_deadline timestamptz,
        observations jsonb not null default '[]', raw_payload jsonb not null default '{}')"""
    )
    db.execute(
        """create table auction_documents(source_url text not null, url text not null, document_type text,
        label text, extraction_status text)"""
    )
    db.execute(
        "create table auction_source_state(source_name text primary key, catalogue_withdrawn boolean not null default false)"
    )
    queue = _migration("20260819105011_add_structured_surface_reasoning_queue.sql")
    db.execute(
        queue[
            queue.index("create table if not exists public.auction_enrichment_jobs") : queue.index(
                "create index if not exists auction_surface_measurements"
            )
        ]
    )
    db.execute(_withdrawal_functions())


def _connect():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    return _postgres_connect(url)


def _sale(db, *, pending_document: bool = True, facts_version: str = DOCUMENT_FACTS_VERSION) -> None:
    """Une vente à venir avec une pièce, encore à lire (``pending_document``) ou lue."""
    db.execute(
        """insert into auction_sales(source_url, source_name, sale_date, documents, raw_payload)
           values (%s, 'avoventes', now() + interval '20 days', %s, %s)""",
        (URL, Jsonb([{"url": f"{URL}/pv.pdf"}]), Jsonb({"document_facts_version": facts_version})),
    )
    db.execute(
        "insert into auction_documents(source_url, url, document_type, extraction_status) values (%s, %s, 'pv_huissier', %s)",
        (URL, f"{URL}/pv.pdf", None if pending_document else "extracted"),
    )


def _job(
    db,
    input_hash: str,
    status: str,
    *,
    hours_ago: float,
    priority: int = GENERAL_LANE,
    job_type: str = "pdf",
    last_error: str | None = None,
    due_in_hours: float | None = None,
    completed_hours_ago: float | None = None,
) -> None:
    """Une tâche créée et mise à jour il y a ``hours_ago`` heures, due depuis sa création.

    ``completed_at`` est posé à la même heure pour une tâche ``completed`` ; ``completed_hours_ago`` le pose
    quel que soit le statut. ``due_in_hours`` repousse l'échéance dans le futur (report, nouvel essai).
    """
    if completed_hours_ago is None and status == "completed":
        completed_hours_ago = hours_ago
    attempt_count = 0 if status in {"queued", "cancelled"} and due_in_hours is None else 1
    db.execute(
        """insert into auction_enrichment_jobs
               (source_url, job_type, input_hash, status, priority, attempt_count, last_error,
                created_at, updated_at, completed_at, next_attempt_at)
           values (%s, %s, %s, %s, %s, %s, %s,
                   now() - make_interval(secs => %s), now() - make_interval(secs => %s),
                   now() - make_interval(secs => %s), now() + make_interval(secs => %s))""",
        (
            URL,
            job_type,
            input_hash,
            status,
            priority,
            attempt_count,
            last_error,
            hours_ago * 3600,
            hours_ago * 3600,
            None if completed_hours_ago is None else completed_hours_ago * 3600,
            (-hours_ago if due_in_hours is None else due_in_hours) * 3600,
        ),
    )


def _selected(db) -> list[str]:
    rows = db.execute(backlog.CANDIDATES_SQL, backlog.candidate_parameters(50)).fetchall()
    return [row[0] for row in rows]


def _selected_with(db, *jobs: tuple[tuple, dict]) -> list[str]:
    """La sélection avec ces tâches, puis retour à la vente seule (un cas par appel dans un même test)."""
    db.execute("savepoint cas")
    for args, kwargs in jobs:
        _job(db, *args, **kwargs)
    result = _selected(db)
    db.execute("rollback to savepoint cas")
    return result


def _read(name: str, hours_ago: float, **kwargs) -> tuple[tuple, dict]:
    """Une lecture terminée, demandée par le vidage sauf mention contraire."""
    return (f"pipeline_v2:{name}", "completed"), {"hours_ago": hours_ago, "priority": DRAIN, **kwargs}


def _current(hours_ago: float = 1) -> tuple[tuple, dict]:
    """La tâche en file de la génération courante, jamais essayée."""
    return ("pipeline_v2:courante", "queued"), {"hours_ago": hours_ago}


def test_a_sale_never_read_is_selected() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)

            assert _selected(db) == [URL]
        finally:
            db.rollback()


# --- Plafond de relecture


def test_a_sale_read_twice_within_a_day_waits_whatever_the_fingerprint() -> None:
    # La boucle mesurée : chaque lecture terminée écrit une nouvelle empreinte, la publication remet une tâche
    # neuve en file, et la vente a toujours une pièce « à lire » (lien mort, source retirée).
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)

            assert backlog.MAX_COMPLETED_READS_PER_DAY == 2
            assert _selected_with(db, _read("lecture-1", 3), _read("lecture-2", 2), _current()) == []
            # Une lecture terminée il y a 23 heures compte encore, une de plus de 24 heures ne compte plus.
            assert _selected_with(db, _read("lecture-1", 23), _read("lecture-2", 2), _current()) == []
            assert _selected_with(db, _read("lecture-1", 25), _read("lecture-2", 2), _current()) == [URL]
        finally:
            db.rollback()


def test_the_cap_also_bounds_a_reread_for_older_fact_rules() -> None:
    # Vente sans aucun texte : la version des faits n'était jamais posée, une tâche neuve terminée par tick.
    with _connect() as db:
        try:
            _setup(db)
            _sale(db, pending_document=False, facts_version="")

            assert _selected_with(db, _read("lecture-1", 3), _read("lecture-2", 2), _current()) == []
        finally:
            db.rollback()


def test_one_read_today_lets_the_next_generation_through() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)

            assert _selected_with(db, _read("lecture-1", 3), _current()) == [URL]
        finally:
            db.rollback()


def test_a_sale_invalidated_by_a_collection_is_reread_the_same_day() -> None:
    # #415 (04/11/2026, 0 vente choisie sur 270) : la collecte invalide la lecture du matin ; la tâche en file est
    # annulée (« Superseded by a newer input revision ») et une génération neuve la remplace.
    with _connect() as db:
        try:
            _setup(db)
            _sale(db, facts_version="")
            invalidated = (("pipeline_v2:invalidee", "cancelled"), {"hours_ago": 2, "last_error": SUPERSEDED})

            assert _selected_with(db, _read("lecture-du-matin", 6), invalidated, _current()) == [URL]
        finally:
            db.rollback()


def test_only_completed_pdf_reads_asked_by_the_drain_are_counted() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            # Tâches de la voie générale terminées sans passe (pièces à jour après restauration), puis une pièce
            # nouvelle : comptées, elles feraient attendre cette pièce jusqu'à 24 heures.
            general = [_read("fin-sans-passe-1", 20, priority=GENERAL_LANE), _read("fin-sans-passe-2", 3, priority=GENERAL_LANE)]
            assert _selected_with(db, *general, _current(0.2)) == [URL]
            # Tâches annulées du jour (une collecte invalide plusieurs fois la lecture) : elles n'ont rien lu.
            superseded = [
                ((f"pipeline_v2:remplacee-{index}", "cancelled"), {"hours_ago": 5 + index, "priority": DRAIN, "last_error": SUPERSEDED})
                for index in range(4)
            ]
            assert _selected_with(db, _read("lecture-1", 30), *superseded, _current()) == [URL]
            # Tâches en échec dont ``completed_at`` est resté posé : un échec n'est pas une lecture. (Mises à jour
            # il y a plus d'un jour, pour que la garde « essayée depuis moins d'un jour » ne décide pas à sa place.)
            failed = [
                ((f"pipeline_v2:echec-{index}", "failed"), {"hours_ago": 30 + index, "priority": DRAIN, "completed_hours_ago": 2})
                for index in range(2)
            ]
            assert _selected_with(db, *failed, _current()) == [URL]
            # Tâches terminées d'un autre type pour la même vente.
            facts = [_read(f"faits-{index}", 2 + index, job_type="fact_extraction") for index in range(2)]
            assert _selected_with(db, *facts, _current()) == [URL]
        finally:
            db.rollback()


def test_the_earlier_guards_still_hold() -> None:
    """Une lecture terminée qui reste la plus récente, un échec ou un report non échu font attendre un jour."""
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)

            assert _selected_with(db, _read("lecture-1", 2)) == []
            failed = (("pipeline_v2:echec", "failed"), {"hours_ago": 2, "last_error": "Document extraction incomplete"})
            assert _selected_with(db, failed) == []
            waiting = (("pipeline_v2:report", "queued"), {"hours_ago": 2, "due_in_hours": 20, "last_error": NOTHING_DUE_DEFERRAL})
            assert _selected_with(db, waiting) == []
            # Écriture de fin de passe écartée : un échec comme un autre, la vente attend un jour.
            discarded = (
                ("pipeline_v2:ecartee", "failed"),
                {"hours_ago": 2, "due_in_hours": 22, "last_error": f"{WRITE_DISCARDED_ERROR} (missing_price_and_surface)"},
            )
            assert _selected_with(db, discarded) == []
        finally:
            db.rollback()


# --- Attente d'une revue


def test_a_pdf_job_cancelled_for_review_is_not_woken_up_by_the_drain() -> None:
    # Le vidage réveille toute tâche annulée d'une vente candidate (ENSURE_JOB_SQL). Sans garde, l'annulation
    # « review_required » ne durait qu'un tick et la passe refusée reprenait, une par jour, sans fin.
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            review = (("pipeline_v2:refusee", "cancelled"), {"hours_ago": 24, "priority": DRAIN, "last_error": REVIEW})

            assert _selected_with(db, review) == []
            # Une génération plus récente (les pièces ont changé) : la vente repasse aussitôt.
            assert _selected_with(db, review, _current()) == [URL]
            # Passé le délai, la vente est reprise sans intervention.
            assert backlog.REVIEW_HOLD_DAYS == 7
            old = (("pipeline_v2:refusee", "cancelled"), {"hours_ago": 8 * 24, "priority": DRAIN, "last_error": REVIEW})
            assert _selected_with(db, old) == [URL]
            recent = (("pipeline_v2:refusee", "cancelled"), {"hours_ago": 6 * 24, "priority": DRAIN, "last_error": REVIEW})
            assert _selected_with(db, recent) == []
        finally:
            db.rollback()


def _review(hours_ago: float, message: str = REVIEW) -> tuple[tuple, dict]:
    """La tâche pdf de la vente, annulée pour revue il y a ``hours_ago`` heures."""
    return ("pipeline_v2:refusee", "cancelled"), {"hours_ago": hours_ago, "priority": DRAIN, "last_error": message}


@pytest.mark.parametrize(
    ("sale_date", "held_at_two_days"),
    [
        ("now() + interval '20 days'", True),
        ("now() + interval '7 days 1 hour'", True),
        # À sept jours de l'audience ou moins, ou sans date (cession dont l'échéance n'est que dans les pièces) :
        # une semaine d'attente ferait passer l'audience. Un jour, comme un essai ordinaire.
        ("now() + interval '6 days 23 hours'", False),
        ("now() + interval '5 days'", False),
        ("null", False),
    ],
)
def test_the_review_hold_lasts_a_week_only_far_from_the_hearing(sale_date: str, held_at_two_days: bool) -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            db.execute(f"update auction_sales set sale_date = {sale_date}")

            assert _selected_with(db, _review(23)) == []  # jamais avant un jour
            assert _selected_with(db, _review(48)) == ([] if held_at_two_days else [URL])
            assert _selected_with(db, _review(8 * 24)) == [URL]
        finally:
            db.rollback()


def test_new_reading_rules_lift_the_review_hold() -> None:
    # La ligne de la vente garde l'ancienne version tant que l'écriture est refusée : c'est le message de la tâche
    # qui dit avec quelles règles la passe refusée a lu.
    with _connect() as db:
        try:
            _setup(db)
            _sale(db, pending_document=False, facts_version="document_facts_v4")
            refused_with_old_rules = review_message("missing_price_and_surface", "document_facts_v4")
            assert refused_with_old_rules != REVIEW

            assert _selected_with(db, _review(48, refused_with_old_rules)) == [URL]
            # Refusée avec les règles courantes : la même vente attend, même si sa ligne porte l'ancienne version.
            assert _selected_with(db, _review(48)) == []
        finally:
            db.rollback()


def test_only_a_newer_generation_that_is_not_cancelled_lifts_the_review_hold() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            # Une pièce est apparue puis a disparu : la tâche de la liste intermédiaire est annulée, celle qui est
            # en revue est de nouveau la génération courante. Elle levait l'attente pour toujours.
            intermediate = (("pipeline_v2:intermediaire", "cancelled"), {"hours_ago": 20, "last_error": SUPERSEDED})
            assert _selected_with(db, _review(24), intermediate) == []

            for status in ("queued", "completed", "failed"):
                newer = (("pipeline_v2:nouvelle-piece", status), {"hours_ago": 30})
                assert _selected_with(db, _review(48), newer) == [URL], status
            # Une génération plus ancienne que la tâche en revue ne dit rien de la liste courante.
            older = (("pipeline_v2:ancienne", "completed"), {"hours_ago": 72})
            assert _selected_with(db, _review(48), older) == []
        finally:
            db.rollback()


def test_other_cancellations_never_hold_the_sale() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            superseded = (("pipeline_v2:remplacee", "cancelled"), {"hours_ago": 2, "last_error": SUPERSEDED})
            removed = (
                ("pipeline_v2:retiree", "cancelled"),
                {"hours_ago": 2, "last_error": "Listing removed, expired or explicitly cancelled"},
            )
            # Une passe de faits annulée pour revue ne dit rien de la lecture des pièces.
            facts = (
                ("pipeline_v2:faits", "cancelled"),
                {"hours_ago": 2, "job_type": "fact_extraction", "last_error": "review_required: no extractable PDF evidence"},
            )

            assert _selected_with(db, superseded) == [URL]
            assert _selected_with(db, removed) == [URL]
            assert _selected_with(db, facts) == [URL]
        finally:
            db.rollback()


def test_a_fully_withdrawn_sale_is_not_selected_until_the_withdrawal_is_lifted() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            db.execute("insert into auction_source_state(source_name, catalogue_withdrawn) values ('avoventes', true)")
            assert _selected(db) == []

            db.execute("update auction_source_state set catalogue_withdrawn = false")
            assert _selected(db) == [URL]
        finally:
            db.rollback()
