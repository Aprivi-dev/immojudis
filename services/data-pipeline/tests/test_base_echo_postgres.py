"""Garde d'écho contre un vrai PostgreSQL (``PIPELINE_TEST_DB_URL``, service ``postgres`` de ``ci.yml``).

Les vraies requêtes de la collecte tournent ici : lecture des ventes connues, verrou des candidats, lecture des lignes
verrouillées par liste de colonnes, écriture ``insert ... on conflict``. Elles donnent à la garde les types que la
base rend vraiment (``numeric`` relu en JSON, ``jsonb``). Un autre écrivain change la ligne par une seconde connexion.

La table ``auction_sales`` est réduite aux colonnes du modèle, sans le registre des pièces ni ses déclencheurs : le
comportement de bout en bout avec le registre est dans ``test_base_echo_registry_postgres.py``. Chaque test crée sa
propre base, supprimée ensuite ; sans ``PIPELINE_TEST_DB_URL`` ils sont ignorés.
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fake_sale_base import patch_neighbouring_tables
from psycopg.types.json import Jsonb
from sale_table_columns import add_model_columns

from src import base_reads
from src import main as pipeline
from src.asset_normalization import normalize_asset_features
from src.freshness import record_source_checks
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.storage import supabase_client as storage

URL = "https://www.licitor.com/annonce/09/99/99/vente-aux-encheres/une-maison/alphaville/gironde/099997.html"
SALE_DATE = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0).isoformat()
LISTING = {
    "surface_m2": Decimal("50.25"),
    "app_surface_m2": Decimal("50.25"),
    "app_surface_kind": "built",
    "surface_source": "listing_text",
    "surface_confidence": Decimal("0.70"),
    "rooms_count": 2,
    "occupancy_status": "occupied",
}
POSED = {
    "surface_m2": Decimal("54.50"),
    "app_surface_m2": Decimal("54.50"),
    "app_surface_kind": "declared",
    "surface_source": "declared",
    "surface_confidence": Decimal("0.90"),
    "rooms_count": 3,
    "occupancy_status": "rented",
}


class Base:
    def __init__(self, url: str, other_writer: Any):
        self.url = url
        self.other_writer = other_writer

    def seed(self, **values: Any) -> None:
        row = {
            "source_name": "licitor",
            "source_url": URL,
            "source_urls": Jsonb([URL]),
            "primary_source": "licitor",
            "status": "upcoming",
            "sale_date": SALE_DATE,
            "starting_price_eur": 90000,
            "department": "33",
            "city": "Alphaville",
            "postal_code": "33000",
            "address": "12 rue des Lilas, 33000 Alphaville",
            "property_type": "house",
            "title": "Une maison",
            "description": "Une maison d'habitation.",
            "raw_text": "Une maison d'habitation.",
            "visit_dates": Jsonb([]),
            "documents": Jsonb([]),
            "quality_flags": Jsonb([]),
            "raw_payload": Jsonb({
                "source_checks": {},
                "source_factual_snapshot": {"source_name": "licitor", "source_url": URL},
            }),
            **values,
        }
        columns = ", ".join(row)
        self.other_writer.execute(
            f"insert into public.auction_sales ({columns}) values ({', '.join(['%s'] * len(row))})", list(row.values())
        )

    def move(self, **values: Any) -> None:
        """Un autre écrivain change la ligne, sur sa propre connexion."""
        assignments = ", ".join(f"{column} = %s" for column in values)
        self.other_writer.execute(
            f"update public.auction_sales set {assignments}, updated_at = now() where source_url = %s",
            [*values.values(), URL],
        )

    def row(self, *extra: str) -> dict[str, Any]:
        columns = (*LISTING, *extra)
        values = self.other_writer.execute(
            f"select {', '.join(columns)} from public.auction_sales where source_url = %s", (URL,)
        ).fetchone()
        return dict(zip(columns, values, strict=True))

    def sale_id(self) -> str:
        return str(self.other_writer.execute("select id from public.auction_sales where source_url = %s", (URL,)).fetchone()[0])

    def retain_surface(self) -> None:
        """La base retient le groupe de surface : toute écriture le laisse tel qu'il est (un déclencheur de retenue)."""
        self.other_writer.execute(
            """create function public.pgtest_retain_surface() returns trigger language plpgsql as $$
               begin
                 new.surface_m2 := old.surface_m2; new.app_surface_m2 := old.app_surface_m2;
                 new.app_surface_kind := old.app_surface_kind; new.surface_source := old.surface_source;
                 new.surface_confidence := old.surface_confidence;
                 return new;
               end $$"""
        )
        self.other_writer.execute(
            """create trigger aaab_pgtest_retain_surface before update on public.auction_sales
               for each row execute function public.pgtest_retain_surface()"""
        )


@pytest.fixture
def base(monkeypatch) -> Iterator[Base]:
    root = os.getenv("PIPELINE_TEST_DB_URL")
    if not root:
        pytest.skip("Requires disposable PostgreSQL")
    psycopg = pytest.importorskip("psycopg")

    name = f"echo_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(root, autocommit=True) as admin:
        admin.execute(f"create database \"{name}\" template template0 encoding 'UTF8'")
    url = re.sub(r"/[^/?]+(\?|$)", rf"/{name}\1", root, count=1)
    try:
        with psycopg.connect(url, autocommit=True) as other_writer:
            other_writer.execute(
                """create table public.auction_sales(
                     id uuid primary key default gen_random_uuid(), source_url text not null unique,
                     updated_at timestamptz default now())"""
            )
            add_model_columns(other_writer)
            monkeypatch.setattr(
                storage,
                "load_settings",
                lambda: {
                    "supabase_url": "http://127.0.0.1:9",
                    "supabase_service_role_key": "local-test-only",
                    "supabase_db_url": url,
                },
            )
            patch_neighbouring_tables(monkeypatch)
            yield Base(url, other_writer)
    finally:
        with psycopg.connect(root, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{name}" with (force)')


def collect_unchanged() -> AuctionSale:
    """Début d'un passage : lecture des ventes connues, puis l'annonce est vue inchangée."""
    return _collect({"_known_unchanged": True})


def collect_reread(**published: Any) -> AuctionSale:
    """Début d'un passage : lecture des ventes connues, puis la fiche est relue et publie ``published``."""
    return _collect({"source_detail_status": "complete", "property_type": "house", "title": "Une maison", **published})


def _collect(read: dict[str, Any]) -> AuctionSale:
    known = storage.fetch_known_sale_details()
    known.update(storage.fetch_known_sale_details(source_urls=[URL], include_enrichment_payload=True))
    raws = [{
        "source_name": "licitor", "source_url": URL, "sale_date": SALE_DATE, "starting_price_eur": 90000,
        "status": "upcoming", "city": "Alphaville", **read,
    }]
    pipeline._hydrate_known_unchanged_sales(raws, known)
    pipeline._preserve_known_enrichment_payloads(raws, known)
    record_source_checks(raws, known)
    sale = normalize_sale(raws[0])
    normalize_asset_features(sale)
    return sale


def test_a_value_changed_by_another_connection_is_not_overwritten_by_the_one_read_before(base) -> None:
    base.seed(**POSED)
    sale = collect_unchanged()
    assert (sale.rooms_count, sale.app_surface_m2, sale.occupancy_status) == (3, Decimal("54.5"), "rented")

    base.move(**LISTING)
    assert storage.upsert_sales_to_supabase([sale]) == 1

    assert base.row() == LISTING
    assert base_reads.suppressed_count() == 3


def test_without_the_guard_the_real_write_puts_the_stale_value_back(base, monkeypatch) -> None:
    monkeypatch.setattr(base_reads, "suppress_echo", lambda existing, incoming: incoming)
    base.seed(**POSED)
    sale = collect_unchanged()

    base.move(**LISTING)
    assert storage.upsert_sales_to_supabase([sale]) == 1

    row = base.row()
    assert (row["rooms_count"], row["app_surface_m2"], row["occupancy_status"]) == (3, Decimal("54.5"), "rented")


def test_values_read_back_from_postgres_never_look_like_a_move(base) -> None:
    """``numeric`` relu en JSON, ``Decimal`` du modèle, flottant envoyé : trois écritures du même passage, aucun
    mouvement vu, et les libellés que la collecte change entre deux publications sont bien écrits."""
    base.seed(**POSED)
    sale = collect_unchanged()
    assert storage.upsert_sales_to_supabase([sale]) == 1

    sale.surface_source, sale.surface_confidence = "pdf", Decimal("0.95")
    assert storage.upsert_sales_to_supabase([sale]) == 1
    row = base.row()
    assert (row["surface_source"], row["surface_confidence"]) == ("pdf", Decimal("0.95"))

    sale.app_surface_kind = "carrez"
    assert storage.upsert_sales_to_supabase([sale]) == 1
    row = base.row()
    assert row["app_surface_kind"] == "carrez"
    assert (row["rooms_count"], row["app_surface_m2"], row["occupancy_status"]) == (3, Decimal("54.5"), "rented")
    assert base_reads.suppressed_count() == 0


def test_a_change_between_two_publications_of_the_same_run_is_respected(base) -> None:
    base.seed(**POSED)
    assert storage.upsert_sales_to_supabase([collect_unchanged()]) == 1
    assert base.row()["rooms_count"] == 3

    base.move(rooms_count=4)
    # La publication finale repart de valeurs lues au début du passage.
    sale = collect_unchanged()
    sale.rooms_count = 3
    assert storage.upsert_sales_to_supabase([sale]) == 1

    assert base.row()["rooms_count"] == 4
    assert base_reads.suppressed_count() == 1


def _fail_once_after_the_sale_write(monkeypatch) -> None:
    """Une instruction échoue après l'écriture de ``auction_sales`` : PostgreSQL annule toute la transaction."""
    calls = {"count": 0}

    def failing_once(*_args, **_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("canceling statement due to statement timeout")

    monkeypatch.setattr(storage, "_upsert_asset_tables", failing_once)


def test_a_rolled_back_publication_then_a_retry_writes_the_labels_of_the_run(base, monkeypatch) -> None:
    base.seed(**LISTING)
    sale = collect_unchanged()
    # Un document confirme la surface entre la lecture et l'écriture : mêmes valeurs, libellés nouveaux.
    sale.surface_source, sale.surface_confidence = "pdf", Decimal("0.95")
    _fail_once_after_the_sale_write(monkeypatch)

    with pytest.raises(RuntimeError):
        storage.upsert_sales_to_supabase([sale])
    assert base.row()["surface_source"] == "listing_text"  # la transaction a bien été annulée
    assert storage.upsert_sales_to_supabase([sale]) == 1  # reprise, dans le même passage

    row = base.row()
    assert (row["surface_source"], row["surface_confidence"]) == ("pdf", Decimal("0.95"))
    assert base_reads.moved_groups(base.sale_id()) == frozenset()
    assert base_reads.suppressed_count() == 0


def test_a_rolled_back_publication_then_a_retry_writes_the_surface_derived_from_the_land(base, monkeypatch) -> None:
    """Terrain de 800 m² sans surface affichée en base : la collecte la dérive, l'écriture échoue, puis est reprise."""
    base.seed(**{**dict.fromkeys(LISTING), "property_type": "land", "land_surface_m2": Decimal("800"),
                 "title": "Un terrain", "description": "Un terrain.", "raw_text": "Un terrain."})
    sale = collect_unchanged()
    assert sale.app_surface_m2 == 800
    _fail_once_after_the_sale_write(monkeypatch)

    with pytest.raises(RuntimeError):
        storage.upsert_sales_to_supabase([sale])
    assert base.row()["app_surface_m2"] is None
    assert storage.upsert_sales_to_supabase([sale]) == 1

    assert base.row()["app_surface_m2"] == 800
    assert base_reads.moved_groups(base.sale_id()) == frozenset()
    assert base_reads.suppressed_count() == 0


def test_a_surface_retained_by_the_database_never_looks_like_a_move(base, monkeypatch) -> None:
    """La base retient 54,5 m² (déclencheur), la fiche relue publie toujours 50 m² habitables, personne n'agit.

    Deux passages de deux publications : ``returning`` rend ce que la base a gardé, donc la lecture suivante n'est
    pas un mouvement, et la valeur de l'annonce est envoyée telle quelle, jamais remplacée par la valeur retenue.
    """
    base.seed(**POSED, habitable_surface_m2=Decimal("50"))
    base.retain_surface()
    sent: list[dict[str, Any]] = []
    real_write = storage._transaction_write

    def recording_write(table, payload, on_conflict=None, **kwargs):
        if table == "auction_sales":
            sent.extend(dict(row) for row in payload)
        return real_write(table, payload, on_conflict, **kwargs)

    monkeypatch.setattr(storage, "_transaction_write", recording_write)

    for _passage in range(2):
        base_reads.reset()
        sale = collect_reread(surface_m2=50, habitable_surface_m2=50, description="Une maison de 50 m² habitables.")
        for _publication in range(2):
            assert storage.upsert_sales_to_supabase([sale]) == 1
            assert (sent[-1]["surface_m2"], sent[-1]["app_surface_m2"]) == (50, 50)
            assert base_reads.moved_groups(base.sale_id()) == frozenset()
            assert base_reads.suppressed_count() == 0

    row = base.row()
    assert (row["surface_m2"], row["app_surface_m2"], row["surface_source"]) == (Decimal("54.5"), Decimal("54.5"), "declared")
