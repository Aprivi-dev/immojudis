"""Retrait d'une source du catalogue (migration 20261021110000_licitor_source_withdrawal.sql).

Joue la vraie migration sur un schéma minimal (PIPELINE_TEST_DB_URL, base jetable, sinon ignoré) :
elle ne retire AUCUNE source ; une fois posé, l'interrupteur arrête la collecte ET masque les ventes de la
seule source retirée, sans rien supprimer, et se lève d'un seul geste.
"""

import os
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb

from src.storage.supabase_client import _postgres_connect

ROOT = Path(__file__).resolve().parents[3]
WITHDRAWAL = "20261021110000_licitor_source_withdrawal.sql"


def migration(name: str) -> str:
    return (ROOT / "supabase/migrations" / name).read_text().removeprefix("begin;").removesuffix("commit;\n")


def projection_sql() -> str:
    """La projection existante du catalogue (colonnes + fonction + déclencheurs), sans les fonctions de recherche."""
    text = migration("20261009180000_catalogue_search_materialized_projection.sql")
    columns_and_function = text[text.index("create or replace function app_private.sync_auction_sale_catalogue_projection()"):text.index("-- Backfill without firing")]
    triggers = text[text.index("drop trigger if exists zzzz_auction_sales_catalogue_projection_insert"):text.index("create or replace function app_private.search_auction_sales_preview_v3(")]
    return columns_and_function + triggers


def setup(db, *, apply_withdrawal: bool = True) -> None:
    db.execute("create schema if not exists app_private")
    for role in ("anon", "authenticated", "service_role"):
        db.execute(
            f"do $$ begin if not exists(select from pg_roles where rolname='{role}') then create role {role}; end if; end $$"
        )
    db.execute(
        """create table auction_runs(id uuid primary key default gen_random_uuid(),source text,status text,
        use_llm boolean,summary jsonb default '{}',errors jsonb default '{}',created_at timestamptz default now(),
        updated_at timestamptz default now(),started_at timestamptz,finished_at timestamptz)"""
    )
    db.execute(
        """create table auction_sales(id uuid primary key default gen_random_uuid(), source_url text unique,
        source_name text not null, observations jsonb default '[]', raw_payload jsonb default '{}',
        catalogue_quarantined boolean not null default false, catalogue_thumbnail_url text,
        status text default 'upcoming', updated_at timestamptz default now())"""
    )
    db.execute(migration("20260912110654_pipeline_autonomy_evidence.sql"))
    db.execute(projection_sql())
    # Un trigger « utilisateur » d'une autre garde : il doit rester actif après un retrait ou une levée.
    db.execute(
        """create function app_private.pgtest_touch() returns trigger language plpgsql as $$
        begin new.updated_at := now() + interval '1 day'; return new; end $$"""
    )
    db.execute(
        "create trigger auction_sales_pgtest_touch before update on auction_sales "
        "for each row execute function app_private.pgtest_touch()"
    )
    if apply_withdrawal:
        db.execute(migration(WITHDRAWAL))


def add_sale(db, url: str, source: str, observations=None, payload=None) -> None:
    obs = [{"source_name": name, "source_url": f"{url}#{name}"} for name in (observations or [source])]
    db.execute(
        "insert into auction_sales(source_url, source_name, observations, raw_payload) values (%s,%s,%s,%s)",
        (url, source, Jsonb(obs), Jsonb(payload or {})),
    )


def state(db, url: str) -> tuple[str, bool]:
    row = db.execute(
        "select coalesce(raw_payload->>'publication_quarantine',''), catalogue_quarantined from auction_sales where source_url=%s",
        (url,),
    ).fetchone()
    return row[0], row[1]


def connect():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    return _postgres_connect(url)


def seed_sales(db) -> None:
    add_sale(db, "licitor-seul", "licitor")
    add_sale(db, "licitor-sans-observation", "licitor", observations=[])
    add_sale(db, "licitor-fusionnee", "licitor", observations=["licitor", "info_encheres"])
    add_sale(db, "autre-source-avec-licitor", "avoventes", observations=["avoventes", "licitor"])
    add_sale(db, "avoventes", "avoventes")
    add_sale(db, "licitor-garde-ia", "licitor", payload={"publication_quarantine": "ai_review_projection_blocked"})


def withdraw_licitor(db) -> None:
    db.execute("select public.set_catalogue_source_withdrawal('licitor', true, 'Raison de test')")


def test_migration_withdraws_no_source_and_leaves_every_sale_untouched():
    with connect() as db:
        try:
            setup(db, apply_withdrawal=False)
            seed_sales(db)
            before = db.execute("select count(*) from auction_sales").fetchone()[0]
            enabled_before = db.execute(
                "select source_name, enabled from auction_source_state order by source_name"
            ).fetchall()
            db.execute(migration(WITHDRAWAL))

            assert db.execute("select count(*) from auction_source_state where catalogue_withdrawn").fetchone()[0] == 0
            assert db.execute(
                "select catalogue_withdrawn, withdrawn_reason is null, withdrawn_at is null "
                "from auction_source_state where source_name='licitor'"
            ).fetchone() == (False, True, True)
            # La migration ne change l'activation d'aucune source.
            assert (
                db.execute("select source_name, enabled from auction_source_state order by source_name").fetchall()
                == enabled_before
            )
            assert db.execute("select public.get_withdrawn_catalogue_sources()").fetchone()[0] == []

            # Aucune vente n'est masquée : Licitor reste dans le catalogue.
            for url in ("licitor-seul", "licitor-sans-observation", "licitor-fusionnee"):
                assert state(db, url) == ("", False)
            assert state(db, "autre-source-avec-licitor") == ("", False)
            assert state(db, "avoventes") == ("", False)
            # Le marqueur d'une autre garde n'est jamais écrasé.
            assert state(db, "licitor-garde-ia") == ("ai_review_projection_blocked", True)
            # Rien n'est supprimé, les déclencheurs des autres gardes sont actifs, updated_at est intact.
            assert db.execute("select count(*) from auction_sales").fetchone()[0] == before
            assert db.execute(
                "select tgenabled from pg_trigger where tgname='auction_sales_pgtest_touch'"
            ).fetchone()[0] == "O"
            assert db.execute(
                "select count(*) from auction_sales where updated_at > now() + interval '12 hours'"
            ).fetchone()[0] == 0
        finally:
            db.rollback()


def test_new_and_rewritten_licitor_rows_stay_visible_while_nothing_is_withdrawn():
    with connect() as db:
        try:
            setup(db)
            add_sale(db, "nouvelle", "licitor")
            assert state(db, "nouvelle") == ("", False)
            db.execute("update auction_sales set raw_payload = '{}'::jsonb where source_url='nouvelle'")
            assert state(db, "nouvelle") == ("", False)
        finally:
            db.rollback()


def test_withdrawing_hides_only_sole_source_sales_and_never_deletes():
    with connect() as db:
        try:
            setup(db)
            seed_sales(db)
            before = db.execute("select count(*) from auction_sales").fetchone()[0]
            result = db.execute(
                "select public.set_catalogue_source_withdrawal('licitor', true, 'Raison de test')"
            ).fetchone()[0]
            assert result["withdrawn"] is True
            assert result["sales_reprojected"] == 2

            assert db.execute(
                "select catalogue_withdrawn, enabled, withdrawn_reason is not null, withdrawn_at is not null "
                "from auction_source_state where source_name='licitor'"
            ).fetchone() == (True, False, True, True)
            assert db.execute(
                "select count(*) from auction_source_state where catalogue_withdrawn and source_name <> 'licitor'"
            ).fetchone()[0] == 0

            assert state(db, "licitor-seul") == ("source_withdrawn", True)
            assert state(db, "licitor-sans-observation") == ("source_withdrawn", True)
            # Fusionnée avec une autre source : visible (le site masque le contenu Licitor).
            assert state(db, "licitor-fusionnee") == ("", False)
            assert state(db, "autre-source-avec-licitor") == ("", False)
            assert state(db, "avoventes") == ("", False)
            # Le marqueur d'une autre garde n'est jamais écrasé.
            assert state(db, "licitor-garde-ia") == ("ai_review_projection_blocked", True)
            assert db.execute("select count(*) from auction_sales").fetchone()[0] == before
            assert db.execute(
                "select tgenabled from pg_trigger where tgname='auction_sales_pgtest_touch'"
            ).fetchone()[0] == "O"
            # Le retrait ne touche pas à updated_at (projection, pas un changement de vente).
            assert db.execute(
                "select count(*) from auction_sales where updated_at > now() + interval '12 hours'"
            ).fetchone()[0] == 0
        finally:
            db.rollback()


def test_new_and_rewritten_licitor_rows_stay_hidden_while_withdrawn():
    with connect() as db:
        try:
            setup(db)
            withdraw_licitor(db)
            add_sale(db, "nouvelle", "licitor")
            assert state(db, "nouvelle") == ("source_withdrawn", True)
            add_sale(db, "nouvelle-fusionnee", "licitor", observations=["licitor", "vench"])
            assert state(db, "nouvelle-fusionnee") == ("", False)
            # Une collecte qui réécrit raw_payload sans le marqueur ne remet pas la vente à l'affichage.
            db.execute("update auction_sales set raw_payload = '{}'::jsonb where source_url='nouvelle'")
            assert state(db, "nouvelle") == ("source_withdrawn", True)
            # Une fusion qui ajoute une autre source remet la vente à l'affichage.
            db.execute(
                "update auction_sales set observations = %s where source_url='nouvelle'",
                (Jsonb([{"source_name": "licitor"}, {"source_name": "notaires"}]),),
            )
            assert state(db, "nouvelle") == ("", False)
        finally:
            db.rollback()


def test_withdrawn_source_cannot_be_reenabled_by_hand():
    with connect() as db:
        try:
            setup(db)
            withdraw_licitor(db)
            with pytest.raises(psycopg.errors.CheckViolation):
                db.execute("update auction_source_state set enabled=true where source_name='licitor'")
        finally:
            db.rollback()


def test_lifting_the_switch_restores_catalogue_and_collection_in_one_call_and_can_be_repeated():
    with connect() as db:
        try:
            setup(db)
            seed_sales(db)
            before = db.execute("select count(*) from auction_sales").fetchone()[0]
            withdraw_licitor(db)

            lifted = db.execute("select public.set_catalogue_source_withdrawal('licitor', false)").fetchone()[0]
            assert lifted["withdrawn"] is False
            assert lifted["sales_reprojected"] == 2
            assert db.execute(
                "select catalogue_withdrawn, enabled, suspension_reason, withdrawn_reason, withdrawn_at "
                "from auction_source_state where source_name='licitor'"
            ).fetchone() == (False, True, None, None, None)
            assert state(db, "licitor-seul") == ("", False)
            assert state(db, "licitor-sans-observation") == ("", False)
            assert state(db, "licitor-fusionnee") == ("", False)
            assert state(db, "licitor-garde-ia") == ("ai_review_projection_blocked", True)
            assert db.execute("select count(*) from auction_sales").fetchone()[0] == before
            assert db.execute("select public.get_withdrawn_catalogue_sources()").fetchone()[0] == []

            # Levée répétée : rien à refaire.
            again = db.execute("select public.set_catalogue_source_withdrawal('licitor', false)").fetchone()[0]
            assert again["sales_reprojected"] == 0

            # Et on peut retirer de nouveau.
            db.execute("select public.set_catalogue_source_withdrawal('licitor', true, 'Raison de test')")
            assert state(db, "licitor-seul") == ("source_withdrawn", True)
            assert db.execute(
                "select enabled, withdrawn_reason from auction_source_state where source_name='licitor'"
            ).fetchone() == (False, "Raison de test")
            assert db.execute("select public.get_withdrawn_catalogue_sources()").fetchone()[0] == ["licitor"]
        finally:
            db.rollback()


def test_unknown_source_is_refused_and_only_the_service_role_can_flip_the_switch():
    with connect() as db:
        try:
            setup(db)
            with pytest.raises(psycopg.errors.NoDataFound):
                db.execute("select public.set_catalogue_source_withdrawal('inconnue', true)")
            db.rollback()
            setup(db)
            privileges = db.execute(
                """select has_function_privilege('anon','public.set_catalogue_source_withdrawal(text,boolean,text)','execute'),
                          has_function_privilege('authenticated','public.set_catalogue_source_withdrawal(text,boolean,text)','execute'),
                          has_function_privilege('service_role','public.set_catalogue_source_withdrawal(text,boolean,text)','execute'),
                          has_function_privilege('anon','public.get_withdrawn_catalogue_sources()','execute'),
                          has_function_privilege('authenticated','public.get_withdrawn_catalogue_sources()','execute')"""
            ).fetchone()
            assert privileges == (False, False, True, True, True)
        finally:
            db.rollback()


def test_scheduler_never_claims_a_withdrawn_source():
    with connect() as db:
        try:
            setup(db)
            # Même installation que test_autonomy_postgres : file d'enrichissement, puis planificateur.
            db.execute("alter table auction_sales add column sale_date timestamptz, add column sale_procedure jsonb default '{}'")
            original = migration("20260819105011_add_structured_surface_reasoning_queue.sql")
            db.execute(
                original[
                    original.index("create table if not exists public.auction_enrichment_jobs") : original.index(
                        "create index if not exists auction_surface_measurements"
                    )
                ]
            )
            db.execute(migration("20260912112441_pipeline_scheduler_control.sql"))
            db.execute(migration("20260912113935_pipeline_queue_lifecycle.sql"))
            db.execute("update auction_pipeline_control set enabled=true")
            db.execute("update auction_source_state set enabled=true where not catalogue_withdrawn")
            withdraw_licitor(db)
            db.execute("update auction_source_state set next_inventory_at = now() - interval '1 hour'")
            claimed: list[str] = []
            for _ in range(12):
                payload = db.execute("select claim_autonomous_pipeline_run()").fetchone()[0]
                if not payload:
                    break
                claimed.append(payload["source"])
                db.execute("update auction_runs set status='succeeded', finished_at=now() where id=%s", (payload["id"],))
            assert claimed
            assert "licitor" not in claimed
        finally:
            db.rollback()
