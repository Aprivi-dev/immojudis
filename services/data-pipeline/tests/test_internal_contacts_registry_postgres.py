"""SQL du registre des contacts internes exécuté sur une vraie base PostgreSQL jetable.

``test_internal_contacts_registry.py`` ne compare que des sous-chaînes du SQL : ici ``_INSERT_SQL`` est
exécuté pour de bon, par ``write_internal_contacts_connection`` (relecture des ids, un point de sauvegarde par
ligne). Il faut ``PIPELINE_TEST_DB_URL`` (service ``postgres`` de ``ci.yml``) ; sans elle, les tests sont
ignorés. Chaque test crée sa propre base, supprimée ensuite.

Le schéma reprend les colonnes, contraintes et gardes du registre qui comptent pour cette écriture
(``20260928160000_information_agent_contact_registry.sql`` et ``20261023120000_information_agent_legal_safeguards.sql``),
sans les tables ni les rôles du reste de l'application. Adresses fictives (exemple.test).
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from src.models import AuctionSale
from src.storage import internal_contacts as registry

URL = "https://www.licitor.com/annonce/10/99/99/vente-aux-encheres/un-appartement/paris-16eme/paris/109999.html"
FIRST = "2026-10-14T10:00:00+00:00"
SECOND = "2026-10-15T10:00:00+00:00"

SCHEMA = """
create table public.auction_sales (
  id uuid primary key default gen_random_uuid(),
  source_url text not null unique
);

create table public.information_agent_contacts (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references public.auction_sales(id) on delete set null,
  scope_sale_id uuid,
  email text not null,
  normalized_email text generated always as (lower(btrim(email))) stored,
  display_name text,
  role text not null default 'source_contact' check (
    role in ('lawyer', 'notary', 'organizer', 'source_contact', 'manual_professional')
  ),
  provenance jsonb not null default '[]'::jsonb,
  verification_status text not null default 'unverified' check (
    verification_status in ('unverified', 'source_observed', 'verified', 'rejected')
  ),
  opposition_status text not null default 'unknown' check (opposition_status in ('unknown', 'none', 'opposed')),
  bounce_status text not null default 'none' check (bounce_status in ('none', 'temporary', 'permanent')),
  source_name text,
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_kind text,
  observed_at timestamptz,
  observed_by text,
  constraint information_agent_contacts_identity_unique unique nulls not distinct (scope_sale_id, normalized_email),
  constraint information_agent_contacts_source_kind_check check (
    source_kind is null
    or source_kind in ('sale_listing', 'other_listing', 'firm_website', 'official_directory', 'admin_entry')
  ),
  constraint information_agent_contacts_observed_by_check check (observed_by is null or observed_by in ('agent', 'admin')),
  constraint information_agent_contacts_typed_source_check check (
    (source_kind is null) = (observed_at is null) and (source_kind is null) = (observed_by is null)
  )
);

create function public.guard_information_agent_contact_scope() returns trigger language plpgsql as $$
begin
  if new.scope_sale_id is distinct from new.sale_id then
    raise exception using errcode = '23514', message = 'A contact scope must match its sale at insertion time.';
  end if;
  return new;
end;
$$;

create trigger information_agent_contacts_scope_guard before insert on public.information_agent_contacts
for each row execute function public.guard_information_agent_contact_scope();
"""


@pytest.fixture
def registry_db() -> Iterator[Any]:
    base = os.getenv("PIPELINE_TEST_DB_URL")
    if not base:
        pytest.skip("Requires disposable PostgreSQL")
    psycopg = pytest.importorskip("psycopg")

    name = f"contacts_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f"create database \"{name}\" template template0 encoding 'UTF8'")
    url = re.sub(r"/[^/?]+(\?|$)", rf"/{name}\1", base, count=1)
    try:
        with psycopg.connect(url, autocommit=True) as db:
            db.execute(SCHEMA)
            yield db
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{name}" with (force)')


def _sale(*emails: str) -> AuctionSale:
    return AuctionSale(
        source_name="licitor",
        source_url=URL,
        sale_date=datetime.now(UTC) + timedelta(days=30),
        internal_contacts=[
            {"email": email, "name": "Maître Exemple, Avocat", "role": "lawyer", "source_url": URL} for email in emails
        ],
    )


def _sale_id(db: Any) -> str:
    return str(db.execute("insert into public.auction_sales(source_url) values (%s) returning id", (URL,)).fetchone()[0])


def _row(db: Any, email: str) -> dict[str, Any] | None:
    found = db.execute(
        "select to_jsonb(c) from public.information_agent_contacts c where normalized_email = %s", (email,)
    ).fetchall()
    assert len(found) <= 1
    return found[0][0] if found else None


def _count(db: Any) -> int:
    return db.execute("select count(*) from public.information_agent_contacts").fetchone()[0]


def test_two_writes_of_one_address_leave_one_refreshed_row_that_keeps_its_first_observation_date(
    registry_db: Any,
) -> None:
    sale_id = _sale_id(registry_db)
    email = "maitre@exemple.test"

    assert registry.write_internal_contacts_connection(registry_db, [_sale(email)], FIRST) == 1
    first = _row(registry_db, email)
    assert first is not None
    assert first["scope_sale_id"] == first["sale_id"] == sale_id
    assert (first["source_kind"], first["observed_by"], first["verification_status"]) == (
        "sale_listing",
        "agent",
        "source_observed",
    )
    assert first["source_url"] == URL and first["source_name"] == "licitor" and first["role"] == "lawyer"
    assert datetime.fromisoformat(first["observed_at"]) == datetime.fromisoformat(FIRST)

    assert registry.write_internal_contacts_connection(registry_db, [_sale(email)], SECOND) == 1
    second = _row(registry_db, email)
    assert second is not None and _count(registry_db) == 1  # idempotent : ni doublon ni erreur
    assert datetime.fromisoformat(second["observed_at"]) == datetime.fromisoformat(SECOND)
    assert datetime.fromisoformat(second["last_seen_at"]) == datetime.fromisoformat(SECOND)
    assert second["created_at"] == first["created_at"]  # la date du premier relevé n'est jamais réécrite
    assert second["id"] == first["id"]


def test_an_opposed_address_is_neither_written_nor_refreshed(registry_db: Any) -> None:
    sale_id = _sale_id(registry_db)
    # Opposition globale (sans portée) et opposition portée par la vente : toutes deux bloquent l'adresse.
    # Une ligne d'opposition ne garde aucune donnée de source (déclencheur de la migration).
    registry_db.execute(
        "insert into public.information_agent_contacts (email, opposition_status) values (%s, 'opposed')",
        ("globale@exemple.test",),
    )
    registry_db.execute(
        "insert into public.information_agent_contacts (sale_id, scope_sale_id, email, opposition_status) "
        "values (%s, %s, %s, 'opposed')",
        (sale_id, sale_id, "portee@exemple.test"),
    )
    before = {email: _row(registry_db, email) for email in ("globale@exemple.test", "portee@exemple.test")}

    written = registry.write_internal_contacts_connection(
        registry_db, [_sale("Globale@Exemple.test", "portee@exemple.test", "libre@exemple.test")], FIRST
    )

    assert written == 3  # les trois instructions s'exécutent ; seules les adresses libres produisent une ligne
    assert _count(registry_db) == 3
    assert {email: _row(registry_db, email) for email in before} == before  # lignes d'opposition intactes
    free = _row(registry_db, "libre@exemple.test")
    assert free is not None and free["opposition_status"] == "unknown"

    registry.write_internal_contacts_connection(registry_db, [_sale("globale@exemple.test", "portee@exemple.test")], SECOND)
    assert {email: _row(registry_db, email) for email in before} == before


def test_a_row_of_another_kind_is_never_rewritten(registry_db: Any) -> None:
    sale_id = _sale_id(registry_db)
    email = "saisie@exemple.test"
    registry_db.execute(
        "insert into public.information_agent_contacts "
        "(sale_id, scope_sale_id, email, display_name, role, verification_status, opposition_status, "
        " source_name, source_url, source_kind, observed_at, observed_by, last_seen_at) "
        "values (%s, %s, %s, 'Saisie administrateur', 'manual_professional', 'verified', 'none', "
        " 'admin', 'https://exemple.test/cabinet', 'admin_entry', %s, 'admin', %s)",
        (sale_id, sale_id, email, "2026-09-01T00:00:00+00:00", "2026-09-01T00:00:00+00:00"),
    )
    before = _row(registry_db, email)

    registry.write_internal_contacts_connection(registry_db, [_sale(email)], FIRST)
    registry.write_internal_contacts_connection(registry_db, [_sale(email)], SECOND)

    assert _count(registry_db) == 1
    assert _row(registry_db, email) == before  # ni observed_at, ni source_url, ni nom, ni type n'ont bougé
