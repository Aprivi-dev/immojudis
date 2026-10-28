"""Verrous de ligne de la publication : ``for no key update`` (n° 6, chantier W2a).

Un ``for update`` tenu pendant toute la transaction de publication bloque le contrôle de clé étrangère
(``for key share``) de toute insertion dans une table fille de ``auction_sales`` (verdict d'inondation,
commune, pépite, correspondance d'alerte) : l'écriture attend jusqu'au délai (incident 57014 du 27/10).
``for no key update`` garde l'exclusion mutuelle entre écrivains mais laisse passer ces contrôles, tant que
la transaction ne modifie ni ``id`` ni ``source_url`` (colonnes des index uniques visés par des clés
étrangères) : la publication met à jour ``source_url`` seulement comme clé de conflit, jamais en valeur.
"""

import inspect
import os
import re
import uuid

import pytest

from src.publication_identity import _candidate_lock_query
from src.storage import supabase_client as storage
from src.storage.supabase_client import _postgres_connect

FOR_UPDATE = re.compile(r"\bfor\s+update\b", re.IGNORECASE)


def test_candidate_lock_query_uses_the_weak_row_lock() -> None:
    for listing_ids in ([], ["166526"]):
        sql, _params = _candidate_lock_query(["u"], ["40440"], ["h"], [], listing_ids)
        assert sql.rstrip().endswith("for no key update")
        assert not FOR_UPDATE.search(sql)


@pytest.mark.parametrize(
    "function",
    [
        storage._guard_enrichment_revision,
        storage._persist_pdf_document_checkpoint_with_connection,
    ],
)
def test_publication_selects_never_take_the_strong_row_lock(function) -> None:
    source = inspect.getsource(function)
    assert "for no key update" in source
    assert not FOR_UPDATE.search(source)


@pytest.fixture
def two_connections():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    suffix = uuid.uuid4().hex[:8]
    parent, child = f"lock_parent_{suffix}", f"lock_child_{suffix}"
    with _postgres_connect(url) as setup:
        setup.execute(
            f"""create table public.{parent}(id uuid primary key default gen_random_uuid(),
            source_url text not null unique, raw_payload jsonb, updated_at timestamptz default now())"""
        )
        setup.execute(
            f"create table public.{child}(sale_id uuid primary key references public.{parent}(id) on delete cascade)"
        )
        setup.commit()
    holder = _postgres_connect(url)
    writer = _postgres_connect(url)
    try:
        yield holder, writer, parent, child
    finally:
        holder.rollback()
        writer.rollback()
        holder.close()
        writer.close()
        with _postgres_connect(url) as cleanup:
            cleanup.execute(f"drop table if exists public.{child}, public.{parent}")
            cleanup.commit()


def _insert_parent(holder, parent: str) -> str:
    row = holder.execute(
        f"insert into public.{parent}(source_url) values ('https://example.test/a') returning id"
    ).fetchone()
    holder.commit()
    return str(row[0])


def test_child_insert_is_not_blocked_by_the_publication_lock(two_connections) -> None:
    holder, writer, parent, child = two_connections
    sale_id = _insert_parent(holder, parent)
    holder.execute(
        f"select id from public.{parent} where source_url=%s for no key update", ("https://example.test/a",)
    )
    # Mise à jour d'une colonne ordinaire, comme l'upsert (« do update set » exclut la clé de conflit).
    holder.execute(f"update public.{parent} set raw_payload='{{}}'::jsonb where id=%s", (sale_id,))
    writer.execute("set local lock_timeout = '1s'")
    writer.execute(f"insert into public.{child}(sale_id) values (%s)", (sale_id,))
    writer.commit()


def test_two_publications_still_exclude_each_other(two_connections) -> None:
    holder, writer, parent, _child = two_connections
    _insert_parent(holder, parent)
    query = f"select id from public.{parent} where source_url=%s for no key update"
    holder.execute(query, ("https://example.test/a",))
    writer.execute("set local lock_timeout = '300ms'")
    with pytest.raises(Exception) as raised:
        writer.execute(query, ("https://example.test/a",))
    assert getattr(raised.value, "sqlstate", None) == "55P03"


def test_the_strong_lock_would_have_blocked_the_child_insert(two_connections) -> None:
    """Garde-fou de la prémisse : avec ``for update``, la même insertion attend (c'était l'incident)."""
    holder, writer, parent, child = two_connections
    sale_id = _insert_parent(holder, parent)
    holder.execute(f"select id from public.{parent} where id=%s for update", (sale_id,))
    writer.execute("set local lock_timeout = '300ms'")
    with pytest.raises(Exception) as raised:
        writer.execute(f"insert into public.{child}(sale_id) values (%s)", (sale_id,))
    assert getattr(raised.value, "sqlstate", None) == "55P03"

