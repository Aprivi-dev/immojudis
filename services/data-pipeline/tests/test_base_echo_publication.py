"""Garde d'écho sur le vrai chemin d'écriture de la collecte, avec une base simulée (``fake_sale_base``).

Deux preuves :

- quand la base n'a pas bougé pendant le passage, ce que la collecte écrit est strictement identique avec et sans
  la garde (``test_writes_are_identical_when_the_base_did_not_move``) ;
- quand un autre écrivain a changé la ligne entre la lecture et l'écriture, la valeur seulement relue ne revient pas.

Les mêmes scénarios contre une vraie base, avec la retenue et la projection du registre, sont dans
``test_base_echo_registry_postgres.py``.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fake_sale_base import FakeSaleBase, patch_publication

from src import base_reads
from src import main as pipeline
from src.asset_normalization import normalize_asset_features
from src.freshness import record_source_checks
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.storage import supabase_client as storage

URL = "https://www.licitor.com/annonce/09/99/99/vente-aux-encheres/une-maison/alphaville/gironde/099999.html"
OTHER_URL = "https://www.avoventes.fr/enchere/099999-une-maison-alphaville"
SALE_DATE = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0).isoformat()
# Colonnes datées à l'instant de l'écriture : sans rapport avec la garde.
CLOCK_COLUMNS = ("last_seen_at", "updated_at", "premium_readiness_evaluated_at")
GROUP_COLUMNS = tuple(column for group in base_reads.GROUPS for column in group.columns)

LISTING = {
    "surface_m2": 50,
    "app_surface_m2": 50,
    "app_surface_kind": "built",
    "surface_source": "listing_text",
    "surface_confidence": 0.7,
    "rooms_count": 2,
    "bedrooms_count": 1,
    "occupancy_status": "occupied",
}
# Valeurs posées par un autre écrivain que la collecte, avec ses propres libellés.
POSED = {
    "surface_m2": 54,
    "app_surface_m2": 54,
    "app_surface_kind": "declared",
    "surface_source": "declared",
    "surface_confidence": 0.9,
    "rooms_count": 3,
    "occupancy_status": "rented",
}


def stored_row(**values: Any) -> dict[str, Any]:
    row = {
        "source_name": "licitor",
        "source_url": URL,
        "source_urls": [URL],
        "primary_source": "licitor",
        "status": "upcoming",
        "sale_date": SALE_DATE,
        "starting_price_eur": 90000,
        "tribunal": "Tribunal judiciaire de Bordeaux",
        "department": "33",
        "city": "Alphaville",
        "postal_code": "33000",
        "address": "12 rue des Lilas, 33000 Alphaville",
        "property_type": "house",
        "title": "Une maison",
        "description": "Une maison d'habitation.",
        "raw_text": "Une maison d'habitation.",
        "habitable_surface_m2": None,
        "carrez_surface_m2": None,
        "surface_scope": None,
        "surface_evidence": None,
        "land_surface_m2": None,
        "visit_dates": [],
        "documents": [],
        "quality_flags": [],
        "raw_payload": {
            "source_checks": {},
            "source_factual_snapshot": {"source_name": "licitor", "source_url": URL},
        },
        **LISTING,
    }
    row.update(values)
    return row


def card(url: str = URL, source_name: str = "licitor", **values: Any) -> dict[str, Any]:
    """Vignette d'une annonce inchangée : la fiche n'est pas relue, la collecte reprend la ligne connue."""
    return {
        "source_name": source_name,
        "source_url": url,
        "sale_date": SALE_DATE,
        "starting_price_eur": 90000,
        "status": "upcoming",
        "city": "Alphaville",
        "_known_unchanged": True,
        **values,
    }


def collect(raw: dict[str, Any], known: dict[str, dict[str, Any]]) -> AuctionSale:
    """Ce que fait la collecte d'une vente brute avant de la publier (``publish_factual_batch``)."""
    raws = [raw]
    pipeline._hydrate_known_unchanged_sales(raws, known)
    pipeline._preserve_known_enrichment_payloads(raws, known)
    record_source_checks(raws, known)
    sale = normalize_sale(raw)
    normalize_asset_features(sale)
    return sale


def written(base: FakeSaleBase) -> list[dict[str, Any]]:
    return [{key: value for key, value in row.items() if key not in CLOCK_COLUMNS} for row in base.writes]


def groups(row: dict[str, Any]) -> dict[str, Any]:
    return {column: row.get(column) for column in GROUP_COLUMNS}


# --- preuve d'identité : la base ne bouge pas ---------------------------------------------------------------------------


def _unchanged_listing(known):
    return [collect(card(), known)]


def _fresh_listing_with_new_values(known):
    raw = card(surface_m2="61 m²", rooms_count=4, occupancy_status="libre", description="Une maison de 61 m².")
    raw.pop("_known_unchanged")
    return [collect(raw, known)]


def _fresh_listing_that_lost_its_values(known):
    raw = card(description="Une maison.", raw_text="Une maison.")
    raw.pop("_known_unchanged")
    return [collect(raw, known)]


def _second_source_merged_into_the_row(known):
    raw = card(OTHER_URL, "avoventes", address="12 rue des Lilas, 33000 Alphaville", postal_code="33000",
               rooms_count=5, surface_m2=58)
    raw.pop("_known_unchanged")
    return [collect(raw, known)]


def _two_sources_in_the_same_batch(known):
    return [*_unchanged_listing(known), *_second_source_merged_into_the_row(known)]


BASE_STATES = {
    "listing_values": stored_row(),
    "values_posed_by_another_writer": stored_row(**POSED),
    "land_and_visits": stored_row(
        property_type="land", title="Un terrain", description="Un terrain.", raw_text="Un terrain.",
        land_surface_m2=800, surface_m2=None, app_surface_m2=800, app_surface_kind="land",
        visit_dates=["sur place le 1er décembre 2026 à 10h"],
    ),
    "no_value_at_all": stored_row(**dict.fromkeys(LISTING)),
}
COLLECTIONS = {
    "unchanged_listing": _unchanged_listing,
    "fresh_listing_with_new_values": _fresh_listing_with_new_values,
    "fresh_listing_that_lost_its_values": _fresh_listing_that_lost_its_values,
    "second_source_merged_into_the_row": _second_source_merged_into_the_row,
    "two_sources_in_the_same_batch": _two_sources_in_the_same_batch,
}


def _run_a_pass(monkeypatch, state: dict[str, Any], collection, sales_by_stage: list | None) -> tuple[list, list]:
    """Un passage : lecture des détails connus, publication anticipée, lecture d'un document, publication finale."""
    base_reads.reset()
    base = FakeSaleBase([deepcopy(state)])
    patch_publication(monkeypatch, base)
    known = storage.fetch_known_sale_details()
    known.update(storage.fetch_known_sale_details(source_urls=[URL], include_enrichment_payload=True))
    early = collection(known) if sales_by_stage is None else deepcopy(sales_by_stage[0])
    prepared = [deepcopy(early)]
    storage.upsert_sales_to_supabase(early)
    # Entre les deux publications, un document confirme la surface : seuls les libellés changent, puis la vente
    # brute est renormalisée pour la publication finale.
    final = collection(known) if sales_by_stage is None else deepcopy(sales_by_stage[1])
    prepared.append(deepcopy(final))
    for sale in final:
        if sale.app_surface_m2 is not None:
            sale.surface_source = "pdf"
            sale.surface_confidence = Decimal("0.95")
    storage.upsert_sales_to_supabase(final)
    return written(base), prepared


@pytest.mark.parametrize("collection", COLLECTIONS.values(), ids=COLLECTIONS.keys())
@pytest.mark.parametrize("state", BASE_STATES.values(), ids=BASE_STATES.keys())
def test_writes_are_identical_when_the_base_did_not_move(monkeypatch, state, collection) -> None:
    with_guard, prepared = _run_a_pass(monkeypatch, state, collection, None)
    assert base_reads.suppressed_count() == 0

    with monkeypatch.context() as patched:
        patched.setattr(base_reads, "suppress_echo", lambda existing, incoming: incoming)
        without_guard, _ = _run_a_pass(patched, state, collection, prepared)

    assert len(with_guard) == len(without_guard) >= 2
    assert with_guard == without_guard


def test_the_identity_proof_would_see_a_guard_that_rewrites_values(monkeypatch) -> None:
    """Garde-fou de la preuve ci-dessus : une garde qui toucherait à l'écriture ferait différer les deux passages."""
    state = BASE_STATES["values_posed_by_another_writer"]
    reference, prepared = _run_a_pass(monkeypatch, state, _unchanged_listing, None)

    def meddling(existing, incoming):
        changed = incoming.model_copy()
        changed.rooms_count = 9
        return changed

    with monkeypatch.context() as patched:
        patched.setattr(base_reads, "suppress_echo", meddling)
        meddled, _ = _run_a_pass(patched, state, _unchanged_listing, prepared)

    assert reference != meddled


# --- la base bouge pendant le passage --------------------------------------------------------------------------------------


@pytest.fixture
def base(monkeypatch) -> FakeSaleBase:
    fake = FakeSaleBase([stored_row(**POSED)])
    patch_publication(monkeypatch, fake)
    return fake


def test_a_value_withdrawn_between_the_read_and_the_write_does_not_come_back(base) -> None:
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)
    assert (sale.rooms_count, sale.app_surface_m2, sale.occupancy_status) == (3, 54, "rented")

    base.move(URL, **LISTING)  # retrait : la base revient aux valeurs de l'annonce
    storage.upsert_sales_to_supabase([sale])

    assert groups(base.writes[-1]) == groups(stored_row())
    assert groups(base.rows[URL]) == groups(stored_row())
    assert base_reads.suppressed_count() == 3  # surface, pièces, occupation


def test_without_the_guard_the_withdrawn_value_comes_back(base, monkeypatch) -> None:
    """Le défaut que la garde corrige : sans elle, la collecte réécrit ce qu'elle a lu avant le retrait."""
    monkeypatch.setattr(base_reads, "suppress_echo", lambda existing, incoming: incoming)
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)

    base.move(URL, **LISTING)
    storage.upsert_sales_to_supabase([sale])

    assert (base.rows[URL]["rooms_count"], base.rows[URL]["app_surface_m2"]) == (3, 54)
    assert base.rows[URL]["occupancy_status"] == "rented"


def test_a_value_replaced_during_the_run_is_not_overwritten_by_the_one_read_before(base) -> None:
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)

    base.move(URL, rooms_count=4)
    storage.upsert_sales_to_supabase([sale])

    assert base.rows[URL]["rooms_count"] == 4
    # Les groupes qui n'ont pas bougé sont écrits comme la collecte les a calculés.
    assert base.writes[-1]["occupancy_status"] == "rented"
    assert base_reads.suppressed_count() == 1


def test_a_withdrawal_between_the_early_and_the_final_publication_is_respected(base) -> None:
    known = storage.fetch_known_sale_details()
    storage.upsert_sales_to_supabase([collect(card(), known)])
    assert base.rows[URL]["rooms_count"] == 3 and base_reads.suppressed_count() == 0

    base.move(URL, **LISTING)
    # La publication finale repart de la même vente brute, qui porte toujours les valeurs lues au début.
    storage.upsert_sales_to_supabase([collect(card(), known)])

    assert groups(base.rows[URL]) == groups(stored_row())
    assert base_reads.suppressed_count() == 3


def test_a_withdrawal_stays_respected_by_every_later_write_of_the_run(base) -> None:
    known = storage.fetch_known_sale_details()
    base.move(URL, **LISTING)
    storage.upsert_sales_to_supabase([collect(card(), known)])

    storage.upsert_sales_to_supabase([collect(card(), known)])

    assert groups(base.writes[-1]) == groups(stored_row())
    assert base_reads.suppressed_count() == 3


def test_a_value_first_posed_during_the_run_is_not_overwritten_by_the_listing_value_read_before(monkeypatch) -> None:
    fake = FakeSaleBase([stored_row()])
    patch_publication(monkeypatch, fake)
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)

    fake.move(URL, **POSED)
    storage.upsert_sales_to_supabase([sale])

    assert groups(fake.rows[URL]) == groups(stored_row(**POSED))


def test_a_real_new_value_from_the_source_is_written_even_if_the_base_moved(base) -> None:
    known = storage.fetch_known_sale_details()
    raw = card(rooms_count=5, surface_m2="61 m²", occupancy_status="libre")
    raw.pop("_known_unchanged")
    sale = collect(raw, known)

    base.move(URL, **LISTING)
    storage.upsert_sales_to_supabase([sale])

    assert base.rows[URL]["rooms_count"] == 5
    assert base.rows[URL]["surface_m2"] == 61
    assert base.rows[URL]["occupancy_status"] == "vacant"
    assert base_reads.suppressed_count() == 0


def test_a_stale_second_source_neither_refills_a_released_column_nor_records_a_conflict(monkeypatch) -> None:
    """Fusion entre sources : la valeur périmée d'une source secondaire n'est pas prise pour un désaccord."""
    fake = FakeSaleBase([stored_row(**POSED, source_urls=[URL, OTHER_URL])])
    patch_publication(monkeypatch, fake)
    known = storage.fetch_known_sale_details()
    secondary = collect(card(OTHER_URL, "avoventes"), known)
    assert secondary.rooms_count == 3  # relue dans la ligne commune

    fake.move(URL, rooms_count=None, occupancy_status="occupied")  # une colonne libérée, une autre remplacée
    storage.upsert_sales_to_supabase([secondary])

    row = fake.rows[URL]
    assert row["rooms_count"] is None
    assert row["occupancy_status"] == "occupied"
    conflicts = row["raw_payload"].get("source_conflicts") or []
    assert not [item for item in conflicts if item.get("field") in {"rooms_count", "occupancy_status"}]


def test_without_the_guard_the_stale_second_source_refills_and_conflicts(monkeypatch) -> None:
    monkeypatch.setattr(base_reads, "suppress_echo", lambda existing, incoming: incoming)
    fake = FakeSaleBase([stored_row(**POSED, source_urls=[URL, OTHER_URL])])
    patch_publication(monkeypatch, fake)
    known = storage.fetch_known_sale_details()
    secondary = collect(card(OTHER_URL, "avoventes"), known)

    fake.move(URL, rooms_count=None, occupancy_status="occupied")
    storage.upsert_sales_to_supabase([secondary])

    row = fake.rows[URL]
    assert row["rooms_count"] == 3
    fields = [item["field"] for item in row["raw_payload"]["source_conflicts"]]
    assert "occupancy_status" in fields


def test_every_locked_row_is_noted_as_a_read_of_the_run(base) -> None:
    """Sans lecture préalable des détails connus, deux publications suffisent à voir la base bouger."""
    first = AuctionSale.model_validate({key: value for key, value in stored_row(**POSED).items() if value is not None})
    storage.upsert_sales_to_supabase([first])
    assert base_reads.suppressed_count() == 0

    base.move(URL, rooms_count=4)
    # ``first`` porte maintenant les valeurs de la ligne verrouillée : les réécrire serait un écho.
    storage.upsert_sales_to_supabase([first])

    assert base.rows[URL]["rooms_count"] == 4
    assert base_reads.suppressed_count() == 1


def test_an_enrichment_checkpoint_of_this_process_is_not_a_move(base) -> None:
    """Une écriture d'enrichissement (sans résolution d'identité) est aussi une écriture de ce processus."""
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)
    storage.upsert_sales_to_supabase([sale])
    sale.surface_source, sale.surface_confidence = "pdf", Decimal("0.95")
    assert storage.upsert_sales_to_supabase([sale], refresh_last_seen=False) == 1

    sale.app_surface_kind = "carrez"
    storage.upsert_sales_to_supabase([sale])

    assert base.writes[-1]["app_surface_kind"] == "carrez"
    assert base.writes[-1]["surface_source"] == "pdf"
    assert base_reads.suppressed_count() == 0
