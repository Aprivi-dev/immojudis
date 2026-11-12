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


# --- ce que la garde croit écrit : transaction annulée, valeur retenue par la base ------------------------------------------

LAND_ROW = {
    "property_type": "land", "title": "Un terrain", "description": "Un terrain.", "raw_text": "Un terrain.",
    "land_surface_m2": 800, "surface_m2": None, "app_surface_m2": None, "app_surface_kind": None,
    "surface_source": None, "surface_confidence": None, "rooms_count": None, "bedrooms_count": None,
    "occupancy_status": None,
}


def _confirm_by_a_document(sale: AuctionSale) -> AuctionSale:
    sale.surface_source, sale.surface_confidence = "pdf", Decimal("0.95")
    return sale


@pytest.mark.parametrize(
    ("state", "enrich"),
    [(stored_row(**LAND_ROW), lambda sale: sale), (stored_row(), _confirm_by_a_document)],
    ids=["surface_derived_from_the_land", "surface_confirmed_by_a_document"],
)
def test_a_failed_transaction_then_a_retry_writes_what_a_pass_without_failure_writes(monkeypatch, state, enrich) -> None:
    """Une instruction échoue après l'écriture de ``auction_sales`` : tout est annulé, puis le lot est repris."""

    def run(fail_first: bool) -> tuple[dict[str, Any], dict[str, Any]]:
        base_reads.reset()
        base = FakeSaleBase([deepcopy(state)])
        patch_publication(monkeypatch, base)
        known = storage.fetch_known_sale_details()
        sale = enrich(collect(card(), known))
        if fail_first:
            def broken(*_args, **_kwargs):
                raise RuntimeError("canceling statement due to statement timeout")

            monkeypatch.setattr(storage, "_upsert_asset_tables_with_rest", broken)
            with pytest.raises(RuntimeError):
                storage.upsert_sales_to_supabase([deepcopy(sale)])
            assert groups(base.rows[URL]) == groups(state)  # la transaction a bien été annulée
            monkeypatch.setattr(storage, "_upsert_asset_tables_with_rest", lambda *_args, **_kwargs: None)
        storage.upsert_sales_to_supabase([deepcopy(sale)])
        assert base_reads.moved_groups(base.rows[URL]["id"]) == frozenset()
        assert base_reads.suppressed_count() == 0
        return written(base)[-1], groups(base.rows[URL])

    witness_write, witness_row = run(fail_first=False)
    retried_write, retried_row = run(fail_first=True)

    assert retried_write == witness_write
    assert retried_row == witness_row
    assert witness_row != groups(state)  # le passage écrit bien autre chose que la ligne de départ


def test_a_value_retained_by_the_base_is_not_taken_for_a_move(monkeypatch) -> None:
    """La base retient 54 m² ; la fiche relue dit toujours 50 m². Personne n'agit : rien n'a bougé, 50 est envoyé."""
    retained = {key: POSED[key] for key in ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source",
                                            "surface_confidence")}
    base = FakeSaleBase([stored_row(habitable_surface_m2=50)])
    patch_publication(monkeypatch, base)
    base.retain(URL, **retained)
    sale_id = base.rows[URL]["id"]

    for _passage in range(2):
        base_reads.reset()
        known = storage.fetch_known_sale_details()
        raw = card(surface_m2=50, habitable_surface_m2=50, description="Une maison de 50 m².")
        raw.pop("_known_unchanged")
        sale = collect(raw, known)
        for _publication in range(2):
            storage.upsert_sales_to_supabase([sale])
            # La valeur de l'annonce part vers la base, qui décide ; elle n'est pas remplacée par la valeur retenue.
            assert (base.writes[-1]["surface_m2"], base.writes[-1]["app_surface_m2"]) == (50, 50)
            assert base_reads.moved_groups(sale_id) == frozenset()
            assert base_reads.suppressed_count() == 0

    assert groups(base.rows[URL])["app_surface_m2"] == 54


# --- une fiche réellement relue --------------------------------------------------------------------------------------------


def test_a_reread_listing_that_publishes_the_value_again_is_written_even_if_the_base_moved(monkeypatch) -> None:
    """La fiche relue redit 3 pièces ; un autre traitement a écrit 4 pendant l'import : la source l'emporte, comme avant."""
    base = FakeSaleBase([stored_row(rooms_count=3)])
    patch_publication(monkeypatch, base)
    known = storage.fetch_known_sale_details()
    raw = card(rooms_count=3, surface_m2="50 m²", occupancy_status="occupé", description="Une maison de 3 pièces.")
    raw.pop("_known_unchanged")
    sale = collect(raw, known)
    assert sale.raw_payload["source_factual_snapshot"]["rooms_count"] == 3

    base.move(URL, rooms_count=4)
    storage.upsert_sales_to_supabase([sale])

    assert base.rows[URL]["rooms_count"] == 3
    assert base_reads.suppressed_count() == 0


def test_the_same_value_of_a_listing_that_was_not_reread_is_withheld(monkeypatch) -> None:
    base = FakeSaleBase([stored_row(rooms_count=3)])
    patch_publication(monkeypatch, base)
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)  # annonce inchangée : les 3 pièces viennent de la ligne lue

    base.move(URL, rooms_count=4)
    storage.upsert_sales_to_supabase([sale])

    assert base.rows[URL]["rooms_count"] == 4
    assert base_reads.suppressed_count() == 1


# --- ce qui suit le groupe repris, et les copies de la valeur retenue ---------------------------------------------------------

CARREZ_COLUMNS = ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source", "surface_confidence",
                  "carrez_surface_m2", "habitable_surface_m2", "surface_scope", "surface_evidence")


def test_a_surface_written_by_the_document_reader_during_the_run_stays_whole(monkeypatch) -> None:
    """Pendant l'import, la lecture d'une pièce écrit 48,5 m² Carrez avec sa preuve et sa trace."""
    base = FakeSaleBase([stored_row()])
    patch_publication(monkeypatch, base)
    known = storage.fetch_known_sale_details()
    known.update(storage.fetch_known_sale_details(source_urls=[URL], include_enrichment_payload=True))
    sale = collect(card(), known)
    document = {
        "surface_m2": 48.5, "app_surface_m2": 48.5, "app_surface_kind": "carrez", "surface_source": "pdf",
        "surface_confidence": 0.9, "carrez_surface_m2": 48.5, "habitable_surface_m2": None,
        "surface_scope": "private", "surface_evidence": "superficie loi Carrez de 48,50 m²",
    }
    traces = {
        "surface_extraction": {"source": "pdf", "value_m2": 48.5, "document_url": "https://example.test/ccv.pdf"},
        "pdf_fact_provenance": {"surface_m2": {"value": 48.5, "source": "pdf", "payload_keys": ["surface_extraction"]}},
    }
    base.move(URL, **document, raw_payload={**base.rows[URL]["raw_payload"], **traces})

    storage.upsert_sales_to_supabase([sale])

    row = base.rows[URL]
    assert {column: row[column] for column in CARREZ_COLUMNS} == document
    # La valeur reste décrite par ce qui l'a établie : sa trace permet toujours de la retirer.
    assert row["raw_payload"]["surface_extraction"] == traces["surface_extraction"]
    assert row["raw_payload"]["pdf_fact_provenance"] == traces["pdf_fact_provenance"]
    # Et la copie de premier niveau suit la valeur écrite.
    assert (row["raw_payload"]["surface_m2"], row["raw_payload"]["app_surface_m2"]) == (48.5, 48.5)
    assert base_reads.suppressed_count() == 1


def test_a_withdrawn_value_does_not_stay_in_a_copy_of_the_written_row(base) -> None:
    """Retrait pendant l'import : ni le premier niveau de ``raw_payload`` ni l'observation embarquée ne gardent 3 et 54."""
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)
    sale.observations = [{"source_name": "licitor", "source_url": URL, "raw_payload": deepcopy(sale.raw_payload)}]
    assert (sale.raw_payload["rooms_count"], sale.raw_payload["surface_m2"]) == (3, 54)

    base.move(URL, **LISTING)
    storage.upsert_sales_to_supabase([sale])

    row = base.rows[URL]
    payload = row["raw_payload"]
    assert (payload["rooms_count"], payload["surface_m2"], payload["app_surface_m2"]) == (2, 50, 50)
    assert payload["occupancy_status"] == "occupied"
    copies = [item["raw_payload"] for item in row["observations"] if item["source_url"] == URL]
    assert copies and all((copy["rooms_count"], copy["surface_m2"]) == (2, 50) for copy in copies)


def test_the_canonical_row_copy_follows_too_when_a_second_source_is_withheld(monkeypatch) -> None:
    """Fusion entre sources : le ``raw_payload`` écrit est celui de la ligne stockée, avec sa copie de l'ancienne valeur."""
    stored = stored_row(**POSED, source_urls=[URL, OTHER_URL])
    stored["raw_payload"] = {**stored["raw_payload"], "rooms_count": 3, "occupancy_status": "rented"}
    fake = FakeSaleBase([stored])
    patch_publication(monkeypatch, fake)
    known = storage.fetch_known_sale_details()
    secondary = collect(card(OTHER_URL, "avoventes"), known)

    fake.move(URL, rooms_count=2, occupancy_status="occupied")
    storage.upsert_sales_to_supabase([secondary])

    payload = fake.rows[URL]["raw_payload"]
    assert (payload["rooms_count"], payload["occupancy_status"]) == (2, "occupied")


def test_the_embedded_observation_of_another_source_is_never_rewritten(monkeypatch) -> None:
    """Annonce Licitor inchangée, un autre écrivain pose 54 m² et 3 pièces : l'observation Avoventes (50 m², 2 pièces,
    sans instantané) dit ce qu'Avoventes a donné, elle reste telle quelle."""
    avoventes = {"surface_m2": 50, "rooms_count": 2, "title": "fiche Avoventes"}
    observations = [
        {"source_name": "licitor", "source_url": URL, "raw_payload": {"surface_m2": 50, "rooms_count": 2}},
        {"source_name": "avoventes", "source_url": OTHER_URL, "raw_payload": dict(avoventes)},
    ]
    fake = FakeSaleBase([stored_row(observations=observations, source_urls=[URL, OTHER_URL])])
    patch_publication(monkeypatch, fake)
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)

    fake.move(URL, **POSED)
    storage.upsert_sales_to_supabase([sale])

    written_observations = {item["source_name"]: item["raw_payload"] for item in fake.rows[URL]["observations"]}
    assert written_observations["avoventes"] == avoventes
    assert (written_observations["licitor"]["surface_m2"], written_observations["licitor"]["rooms_count"]) == (54, 3)
    assert (fake.rows[URL]["surface_m2"], fake.rows[URL]["rooms_count"]) == (54, 3)


def test_a_carrez_surface_the_reread_listing_publishes_for_the_first_time_is_written(monkeypatch) -> None:
    """Surface de 54 m² issue d'une pièce ; la fiche relue publie une Carrez de 53,2 m² ; un autre écrivain change la
    seule confiance de la surface avant la publication. La Carrez de la source est écrite, pas effacée."""
    payload = {
        "source_checks": {},
        "source_factual_snapshot": {"source_name": "licitor", "source_url": URL},
        "surface_extraction": {"source": "pdf", "value_m2": 54},
        "pdf_fact_provenance": {"surface_m2": {"value": 54, "source": "pdf", "payload_keys": ["surface_extraction"]}},
    }
    document = {"surface_m2": 54, "app_surface_m2": 54, "app_surface_kind": "built", "surface_source": "pdf",
                "surface_scope": "total"}

    def run(moved: dict[str, Any]) -> dict[str, Any]:
        base_reads.reset()
        fake = FakeSaleBase([stored_row(**document, surface_confidence=0.95, raw_payload=deepcopy(payload))])
        patch_publication(monkeypatch, fake)
        known = storage.fetch_known_sale_details()
        known.update(storage.fetch_known_sale_details(source_urls=[URL], include_enrichment_payload=True))
        raw = card(carrez_surface_m2="53,2 m²", description="Une maison d'habitation.")
        raw.pop("_known_unchanged")
        sale = collect(raw, known)
        fake.move(URL, **moved)
        storage.upsert_sales_to_supabase([sale])
        return fake.rows[URL]

    witness = run({})
    row = run({"surface_confidence": 0.9})

    assert witness["carrez_surface_m2"] == 53.2
    assert row["carrez_surface_m2"] == 53.2
    assert row["raw_payload"]["carrez_surface_m2"] == "53,2 m²"
    # Ce que l'instantané ne donne pas (la portée de la surface) suit le groupe : c'est celui de la base.
    assert row["surface_scope"] == witness["surface_scope"] == "total"
    assert row["surface_confidence"] == 0.9  # le groupe, lui, est bien celui de la base


# --- qui confirme une écriture, et quand ---------------------------------------------------------------------------------------


def _fail_the_next_write_after_the_sale_row(monkeypatch) -> None:
    calls = {"count": 0}

    def failing_once(*_args, **_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("canceling statement due to statement timeout")

    monkeypatch.setattr(storage, "_upsert_asset_tables_with_rest", failing_once)


def test_a_validated_publication_is_confirmed_before_a_later_write_is_rolled_back(base, monkeypatch) -> None:
    """Publication validée, puis écriture d'enrichissement annulée (sans lecture sous verrou entre les deux), puis
    publication finale : la base est dans l'état de la première écriture, personne d'autre n'a écrit."""
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)
    sale.surface_source, sale.surface_confidence = "pdf", Decimal("0.95")
    storage.upsert_sales_to_supabase([sale])
    sale_id = base.rows[URL]["id"]

    checkpoint = sale.model_copy(deep=True)
    checkpoint.app_surface_kind = "carrez"
    _fail_the_next_write_after_the_sale_row(monkeypatch)
    with pytest.raises(RuntimeError):
        storage.upsert_sales_to_supabase([checkpoint], refresh_last_seen=False)
    assert base.rows[URL]["app_surface_kind"] != "carrez"  # annulée

    sale.surface_confidence = Decimal("0.97")
    storage.upsert_sales_to_supabase([sale])

    assert base_reads.moved_groups(sale_id) == frozenset()
    assert base.rows[URL]["surface_confidence"] == 0.97
    assert base_reads.suppressed_count() == 0


@pytest.mark.parametrize("another_writer_writes_the_same_afterwards", [False, True])
def test_a_write_inside_the_transaction_of_a_caller_is_not_confirmed_before_its_rollback(
    base, monkeypatch, another_writer_writes_the_same_afterwards
) -> None:
    """``verify_publication`` écrit pour de bon puis annule toujours : rien ne doit rester noté comme écrit.

    Ni comme référence (la ligne d'avant, relue ensuite, n'est pas un mouvement), ni comme écriture en attente (si un
    autre écrivain écrit plus tard la même chose, c'est bien un mouvement).
    """
    from src import verify_publication

    known = storage.fetch_known_sale_details()
    storage.upsert_sales_to_supabase([collect(card(), known)])
    sale_id = base.rows[URL]["id"]
    stored = {key: value for key, value in base.rows[URL].items() if value is not None}
    hydrated = AuctionSale.model_validate({**stored, "surface_source": "pdf", "app_surface_kind": "carrez"})
    lookups = iter([[(URL,)]])
    real_execute = base.execute

    def execute(query, params=None):
        if isinstance(query, str) and "order by updated_at desc limit 1" in query:
            return type("Rows", (), {"fetchone": lambda self: next(lookups)[0]})()
        return real_execute(query, params)

    monkeypatch.setattr(base, "execute", execute)
    monkeypatch.setattr(verify_publication, "load_settings", storage.load_settings)
    monkeypatch.setattr(storage, "connect", lambda _url: base)
    monkeypatch.setattr(storage, "fetch_sale_for_data_refresh", lambda _url: hydrated)

    assert verify_publication.main() == 0
    assert base.rows[URL]["surface_source"] != "pdf"  # la vérification a bien été annulée
    assert len(base.writes) == 3  # la publication, puis les deux écritures annulées

    if another_writer_writes_the_same_afterwards:
        base.move(URL, surface_source="pdf", app_surface_kind="carrez")
    storage.upsert_sales_to_supabase([collect(card(), known)])

    expected = {"surface"} if another_writer_writes_the_same_afterwards else frozenset()
    assert base_reads.moved_groups(sale_id) == expected


class _JobBase(FakeSaleBase):
    """La base simulée, avec un travail de relecture de fiche toujours détenu par l'appelant."""

    def execute(self, query: Any, params: Any = None):
        if isinstance(query, str) and "auction_enrichment_jobs" in query:
            return type("Rows", (), {"fetchone": lambda self: (1,), "fetchall": lambda self: [(1,)]})()
        return super().execute(query, params)


def test_a_source_detail_revision_is_confirmed_once_its_transaction_is_committed(monkeypatch) -> None:
    """La relecture d'une fiche écrit par ``_write_sale_revisions`` dans sa propre transaction : elle la confirme."""
    from src import source_detail

    base = _JobBase([stored_row(**POSED)])
    patch_publication(monkeypatch, base)
    monkeypatch.setattr(storage, "connect", lambda _url: base)
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)
    storage.upsert_sales_to_supabase([sale])
    sale_id = base.rows[URL]["id"]

    sale.surface_source, sale.surface_confidence = "pdf", Decimal("0.95")
    job = {"id": "job", "attempt_count": 1, "locked_at": datetime.now(UTC)}
    assert source_detail.publish_source_revision(sale, job, storage.load_settings()) is True
    assert base.rows[URL]["surface_source"] == "pdf"
    sale.updated_at = datetime.fromisoformat(base.rows[URL]["updated_at"])

    checkpoint = sale.model_copy(deep=True)
    checkpoint.app_surface_kind = "carrez"
    _fail_the_next_write_after_the_sale_row(monkeypatch)
    with pytest.raises(RuntimeError):
        storage.upsert_sales_to_supabase([checkpoint], refresh_last_seen=False)
    storage.upsert_sales_to_supabase([sale])

    assert base_reads.moved_groups(sale_id) == frozenset()


def test_a_write_that_does_not_return_one_row_per_row_sent_is_not_noted(base, monkeypatch, caplog) -> None:
    """La base n'a pas rendu toutes les lignes écrites : rien n'est noté pour ce lot, et c'est journalisé."""
    known = storage.fetch_known_sale_details()
    sale = collect(card(), known)
    sale.surface_source = "pdf"
    real_write = storage._transaction_write

    def losing_rows(table, payload, on_conflict=None, **kwargs):
        rows = real_write(table, payload, on_conflict, **kwargs)
        return rows[:-1] if table == "auction_sales" else rows

    monkeypatch.setattr(storage, "_transaction_write", losing_rows)
    with caplog.at_level("WARNING", logger="src.storage.supabase_client"):
        storage.upsert_sales_to_supabase([sale])
    monkeypatch.setattr(storage, "_transaction_write", real_write)

    assert "Publication write returned 0 rows for 1 sent; echo reference left unchanged" in caplog.text
    # La référence est restée celle d'avant : la lecture suivante voit un mouvement, ce qui ne peut que retenir.
    storage.upsert_sales_to_supabase([sale])
    assert base_reads.moved_groups(base.rows[URL]["id"]) == {"surface"}
