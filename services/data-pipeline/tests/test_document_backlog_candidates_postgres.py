"""La sélection du vidage des pièces, exécutée pour de vrai (PIPELINE_TEST_DB_URL, base jetable, sinon ignoré).

Lot R6, correctif B : plafond de relecture. Le 11/11/2026, 3 ventes prenaient 104 des 200 lectures pdf terminées en
48 heures. Chaque lecture terminée laissait la vente à relire et lui créait une tâche d'une nouvelle empreinte, que
ni les 4 essais ni la garde « essayée depuis moins d'un jour » ne bornent. Les gardes de #415 (une tâche annulée
ou dépassée ne bloque pas la vente) restent vérifiées ici : une vente réellement invalidée repasse le jour même.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb

from src import document_backlog as backlog
from src.pdf_enrichment import DOCUMENT_FACTS_VERSION
from src.storage.supabase_client import _postgres_connect

ROOT = Path(__file__).resolve().parents[3]
URL = "https://example.test/vente"


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
    last_error: str | None = None,
    due_in_hours: float | None = None,
) -> None:
    """Une tâche pdf créée et mise à jour il y a ``hours_ago`` heures (terminée à ce moment si ``completed``).

    Elle est due depuis sa création, sauf ``due_in_hours`` (report : échéance dans le futur).
    """
    attempt_count = 0 if status in {"queued", "cancelled"} and due_in_hours is None else 1
    db.execute(
        """insert into auction_enrichment_jobs
               (source_url, job_type, input_hash, status, priority, attempt_count, last_error,
                created_at, updated_at, completed_at, next_attempt_at)
           values (%s, 'pdf', %s, %s, 30, %s, %s,
                   now() - make_interval(secs => %s), now() - make_interval(secs => %s),
                   case when %s = 'completed' then now() - make_interval(secs => %s) end,
                   now() + make_interval(secs => %s))""",
        (
            URL,
            input_hash,
            status,
            attempt_count,
            last_error,
            hours_ago * 3600,
            hours_ago * 3600,
            status,
            hours_ago * 3600,
            (-hours_ago if due_in_hours is None else due_in_hours) * 3600,
        ),
    )


def _selected(db) -> list[str]:
    rows = db.execute(backlog.CANDIDATES_SQL, backlog.candidate_parameters(50)).fetchall()
    return [row[0] for row in rows]


def test_a_sale_never_read_is_selected() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)

            assert _selected(db) == [URL]
        finally:
            db.rollback()


def test_a_sale_read_twice_within_a_day_waits_whatever_the_fingerprint() -> None:
    # La boucle mesurée : chaque lecture terminée écrit une nouvelle empreinte, la publication remet une tâche
    # neuve en file, et la vente a toujours une pièce « à lire » (lien mort, source retirée).
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            _job(db, "pipeline_v2:lecture-1", "completed", hours_ago=3)
            _job(db, "pipeline_v2:lecture-2", "completed", hours_ago=2)
            _job(db, "pipeline_v2:lecture-3", "queued", hours_ago=1)

            assert backlog.MAX_COMPLETED_READS_PER_DAY == 2
            assert _selected(db) == []
        finally:
            db.rollback()


def test_the_cap_also_bounds_a_reread_for_older_fact_rules() -> None:
    # Vente sans aucun texte : la version des faits n'était jamais posée, une tâche neuve terminée par tick.
    with _connect() as db:
        try:
            _setup(db)
            _sale(db, pending_document=False, facts_version="")
            _job(db, "pipeline_v2:lecture-1", "completed", hours_ago=3)
            _job(db, "pipeline_v2:lecture-2", "completed", hours_ago=2)
            _job(db, "pipeline_v2:lecture-3", "queued", hours_ago=1)

            assert _selected(db) == []
        finally:
            db.rollback()


def test_one_read_today_lets_the_next_generation_through() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            _job(db, "pipeline_v2:lecture-1", "completed", hours_ago=3)
            _job(db, "pipeline_v2:lecture-2", "queued", hours_ago=1)

            assert _selected(db) == [URL]
        finally:
            db.rollback()


def test_a_sale_invalidated_by_a_collection_is_reread_the_same_day() -> None:
    # #415 (04/11/2026, 0 vente choisie sur 270) : la collecte invalide la lecture du matin ; la tâche en file est
    # annulée (« Superseded by a newer input revision ») et une génération neuve la remplace.
    with _connect() as db:
        try:
            _setup(db)
            _sale(db, facts_version="")
            _job(db, "pipeline_v2:lecture-du-matin", "completed", hours_ago=6)
            _job(db, "pipeline_v2:invalidee", "cancelled", hours_ago=2, last_error="Superseded by a newer input revision")
            _job(db, "pipeline_v2:apres-invalidation", "queued", hours_ago=1)

            assert _selected(db) == [URL]
        finally:
            db.rollback()


def test_cancelled_failed_or_deferred_jobs_are_not_counted_as_reads() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            _job(db, "pipeline_v2:lecture-1", "completed", hours_ago=30)
            for index in range(4):
                _job(
                    db,
                    f"pipeline_v2:remplacee-{index}",
                    "cancelled",
                    hours_ago=5 + index,
                    last_error="Superseded by a newer input revision",
                )
            _job(db, "pipeline_v2:courante", "queued", hours_ago=1)

            assert _selected(db) == [URL]
        finally:
            db.rollback()


def test_reads_older_than_a_day_do_not_count() -> None:
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            _job(db, "pipeline_v2:lecture-1", "completed", hours_ago=40)
            _job(db, "pipeline_v2:lecture-2", "completed", hours_ago=30)
            _job(db, "pipeline_v2:lecture-3", "completed", hours_ago=26)
            _job(db, "pipeline_v2:lecture-4", "queued", hours_ago=1)

            assert _selected(db) == [URL]
        finally:
            db.rollback()


def test_the_earlier_guards_still_hold() -> None:
    """Une lecture terminée qui reste la plus récente, un échec ou un report non échu font attendre un jour."""
    with _connect() as db:
        try:
            _setup(db)
            _sale(db)
            db.execute("savepoint cas")
            _job(db, "pipeline_v2:lecture-1", "completed", hours_ago=2)
            assert _selected(db) == []

            db.execute("rollback to savepoint cas")
            _job(db, "pipeline_v2:echec", "failed", hours_ago=2, last_error="Document extraction incomplete")
            assert _selected(db) == []

            db.execute("rollback to savepoint cas")
            _job(db, "pipeline_v2:report", "queued", hours_ago=2, due_in_hours=20)
            assert _selected(db) == []
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
