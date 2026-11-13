"""Contrat dont dépend la fin d'une passe pdf (lot R6, correctif H), sur une vraie base (PIPELINE_TEST_DB_URL).

``queued_runner`` ne termine pas la tâche pdf quand ``upsert_sales_to_supabase`` rend 0
(``pdf_pass_outcomes.final_write_was_discarded``). Le banc ``tests/pdf_queue_bench.py`` simule ce retour ; ici
c'est le vrai chemin d'écriture qui le rend, dans les deux cas que la file distingue : la garde de révision
(``_guard_enrichment_revision``, lue en base) et l'admission (``catalogue_write_rejection``). L'écriture des
tables elle-même n'est pas le sujet : elle est remplacée par un témoin, qui prouve que rien n'est écrit quand le
retour est 0 et que la même vente est écrite quand rien ne l'écarte.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from src.models import AuctionSale
from src.pdf_pass_outcomes import WRITE_DISCARDED_ERROR, discarded_write_ending, final_write_was_discarded
from src.storage import supabase_client as storage

SALE_URL = "https://example.test/contrat-ecriture-finale"
JOB = {"id": "tache-pdf", "job_type": "pdf", "attempt_count": 1, "max_attempts": 4}


@pytest.fixture
def database() -> str:
    """Une base à part : ``upsert_sales_to_supabase`` ouvre sa propre connexion et valide sa transaction."""
    root_dsn = os.getenv("PIPELINE_TEST_DB_URL")
    if not root_dsn:
        pytest.skip("Requires disposable PostgreSQL")
    host = str(conninfo_to_dict(root_dsn).get("host") or "")
    if host not in {"127.0.0.1", "localhost"}:
        pytest.fail(f"Refusing non-local database host: {host}")
    name = f"immojudis_final_write_{os.getpid()}_{uuid4().hex[:10]}"
    dsn = make_conninfo(root_dsn, dbname=name)
    created = False
    try:
        with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
            root_db.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
        created = True
        with psycopg.connect(dsn, autocommit=True, prepare_threshold=None) as db:
            db.execute("create table public.auction_sales(source_url text primary key, updated_at timestamptz not null)")
        yield dsn
    finally:
        if created:
            with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root_db:
                root_db.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name)))


@pytest.fixture
def writes(monkeypatch, database: str) -> list[list[str]]:
    """Les écritures qui ont passé l'admission et la garde de révision (l'écriture des tables est un témoin)."""
    settings = {"supabase_url": "http://base.invalid", "supabase_service_role_key": "contrat", "supabase_db_url": database}
    monkeypatch.setattr(storage, "load_settings", lambda: settings)
    written: list[list[str]] = []

    def witness(sales, **_kwargs) -> int:
        written.append([sale.source_url for sale in sales])
        return len(sales)

    monkeypatch.setattr(storage, "_write_sale_revisions", witness)
    return written


def _stored_revision(database: str, updated_at: datetime | None) -> None:
    with psycopg.connect(database, autocommit=True, prepare_threshold=None) as db:
        db.execute("delete from public.auction_sales")
        if updated_at is not None:
            db.execute("insert into public.auction_sales(source_url, updated_at) values (%s, %s)", (SALE_URL, updated_at))


def _sale(updated_at: datetime, **fields: object) -> AuctionSale:
    values = {
        "source_name": "avoventes",
        "source_url": SALE_URL,
        "status": "upcoming",
        "sale_date": datetime.now(UTC) + timedelta(days=20),
        "starting_price_eur": 90_000,
        "updated_at": updated_at,
        **fields,
    }
    return AuctionSale(**values)


def test_a_sale_whose_row_moved_during_the_pass_is_not_written_and_counts_zero(database: str, writes: list) -> None:
    read_at = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=5)
    _stored_revision(database, read_at + timedelta(minutes=2))  # un autre écrivain a publié la vente entre-temps
    sale = _sale(read_at)

    written = storage.upsert_sales_to_supabase([sale], refresh_last_seen=False)

    assert written == 0 and writes == []
    assert final_write_was_discarded(written, sale)
    assert discarded_write_ending(sale, JOB)["error_message"] == f"{WRITE_DISCARDED_ERROR} (revision_moved)"


def test_a_sale_whose_row_was_deleted_during_the_pass_is_not_recreated(database: str, writes: list) -> None:
    _stored_revision(database, None)
    sale = _sale(datetime.now(UTC).replace(microsecond=0))

    assert storage.upsert_sales_to_supabase([sale], refresh_last_seen=False) == 0
    assert writes == []


def test_the_same_sale_is_written_when_its_row_did_not_move(database: str, writes: list) -> None:
    read_at = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=5)
    _stored_revision(database, read_at)
    sale = _sale(read_at)

    written = storage.upsert_sales_to_supabase([sale], refresh_last_seen=False)

    assert written == 1 and writes == [[SALE_URL]]
    assert not final_write_was_discarded(written, sale)


@pytest.mark.parametrize(
    ("fields", "reason"),
    [
        ({"starting_price_eur": None}, "missing_price_and_surface"),
        ({"sale_date": datetime.now(UTC) - timedelta(days=3), "status": "past"}, "expired"),
    ],
)
def test_a_sale_refused_at_admission_is_not_written_and_counts_zero(
    database: str, writes: list, fields: dict[str, object], reason: str
) -> None:
    read_at = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=5)
    _stored_revision(database, read_at)  # la ligne n'a pas bougé : seule l'admission écarte l'écriture
    sale = _sale(read_at, **fields)

    written = storage.upsert_sales_to_supabase([sale], refresh_last_seen=False)

    assert written == 0 and writes == []
    assert final_write_was_discarded(written, sale)
    assert discarded_write_ending(sale, JOB)["error_message"] == f"{WRITE_DISCARDED_ERROR} ({reason})"
