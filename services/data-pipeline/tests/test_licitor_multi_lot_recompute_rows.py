"""Recalcul de production du 03/11/2026 (run 41638946203) : deux fuites restées visibles après #407.

A. Annonces 110492 (« Lot 1 » … « Lot 4 ») et 110549 (« Lot n°1 », « Lot n°2 ») : ces en-têtes n'étaient pas
   reconnus, la page était lue comme un seul lot et chaque URL affichait le lot 1 (Talence 30 000 €, 24 000 €).
B. Lots incertains de 110280 / 110285 : sans mise à prix ni surface, le recalcul refusait de les écrire
   (``publication_rejection``) et la ligne publiée gardait la mise à prix du premier lot, visible.

Les lignes de tests/fixtures/licitor_lignes_stockees_lots_numerotes.json sont les lignes stockées réelles.
"""

import copy
import json
from pathlib import Path

import pytest

from src.admission import (
    LICITOR_MULTI_LOT_QUARANTINE,
    MISSING_PRICE_AND_SURFACE_QUARANTINE,
    admit_sales,
    catalogue_write_rejection,
    publication_rejection,
    quarantine_reason,
)
from src.models import AuctionSale
from src.recompute_scoring import _recomputed_sale_from_storage_row
from src.sources.licitor_extraction import parse_licitor_page
from src.storage import supabase_client
from src.storage.sale_row_builders import _property_rows_for_sales

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "licitor_lignes_stockees_lots_numerotes.json").read_text(encoding="utf-8")
)


def _row(row_id: str) -> dict:
    row = copy.deepcopy(next(item for item in FIXTURE["rows"] if item["id"] == row_id))
    page_text = FIXTURE["pages"][row.pop("page")]
    row["raw_text"] = page_text
    row["raw_payload"].update(raw_text=page_text, source_blocks={"page_text": page_text})
    return row


def test_numbered_lot_headings_split_the_page_into_its_lots() -> None:
    assert [lot.price_eur for lot in parse_licitor_page(FIXTURE["pages"]["110492"]).lots] == [30000, 25000, 35000, 15000]
    lots = parse_licitor_page(FIXTURE["pages"]["110549"]).lots
    assert [(lot.label, lot.price_eur) for lot in lots] == [("Lot n°1", 24000), ("Lot n°2", 4500)]


@pytest.mark.parametrize(
    ("row_id", "expected"),
    [
        # Lot 4 : Lamarque, sans rue publiée.
        ("638fdb03-13ca-4e10-8d03-d6f1ecbd29d8", ("Lamarque", 15000, None, [])),
        ("545e6fde-899f-43c8-9bde-b7e75756b96e", (
            "Bordeaux", 25000, "70, rue de Turenne, Bordeaux",
            ["Visites sur place vendredi 13 novembre 2026 de 9h30 à 11h30 et mardi 24 novembre 2026 de 9h30 à 11h30"],
        )),
        ("f29f877a-995e-4a17-b816-32c877b5ce5c", (
            "Mazeray", 4500, "45, route de Taillebourg, Mazeray", ["Visite sur place vendredi 20 novembre 2026 à 14h"],
        )),
    ],
)
def test_recompute_of_the_stored_row_shows_its_own_numbered_lot(row_id: str, expected: tuple) -> None:
    sale = _recomputed_sale_from_storage_row(_row(row_id))

    city, price, address, visits = expected
    assert (sale.city, int(sale.starting_price_eur), sale.address, sale.visit_dates) == (city, price, address, visits)
    assert sale.raw_payload["source_lot_selection"]["status"] == "selected"
    assert "multi_lot_sale" in sale.quality_flags
    assert quarantine_reason(sale) is None


def test_the_dependencies_lot_no_longer_carries_the_house_surface() -> None:
    sale = _recomputed_sale_from_storage_row(_row("f29f877a-995e-4a17-b816-32c877b5ce5c"))

    assert sale.surface_m2 is None and sale.habitable_surface_m2 is None
    assert sale.title != "Maison 141 m²"


def test_an_uncertain_lot_without_price_or_surface_is_written_hidden_instead_of_skipped() -> None:
    sale = _recomputed_sale_from_storage_row(_row("c2976bcb-a681-45b7-a63e-1d60c5174b77"))

    assert sale.starting_price_eur is None and sale.city is None
    assert publication_rejection(sale) == "missing_price_and_surface"
    # Écrite (masquée) : la ligne visible ne garde pas la mise à prix de 6 000 € du lot 1.
    assert catalogue_write_rejection(sale) is None
    assert quarantine_reason(sale) == LICITOR_MULTI_LOT_QUARANTINE
    rows = _property_rows_for_sales([sale], "2026-11-03T13:10:00+00:00", refresh_last_seen=False)
    assert sale.status == "quarantined"
    assert rows[0]["raw_payload"]["publication_quarantine"] == LICITOR_MULTI_LOT_QUARANTINE


def test_upsert_keeps_the_hidden_rewrite_and_still_drops_a_new_sale_without_price(monkeypatch) -> None:
    uncertain = _recomputed_sale_from_storage_row(_row("c2976bcb-a681-45b7-a63e-1d60c5174b77"))
    new_card = AuctionSale(source_name="licitor", source_url="https://www.licitor.com/annonce/1/2/3/x/y/z/w/1.html",
                           status="upcoming")
    kept: list[AuctionSale] = []
    monkeypatch.setattr(supabase_client, "apply_catalogue_readiness", kept.append)
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {"supabase_url": "", "supabase_service_role_key": ""})

    assert supabase_client.upsert_sales_to_supabase([uncertain, new_card], refresh_last_seen=False) == 0
    assert kept == [uncertain]


def test_a_stored_row_reread_without_price_or_surface_is_hidden_not_left_with_its_old_values() -> None:
    sale = AuctionSale(source_name="vench", source_url="https://www.vench.fr/vente-1.html", status="upcoming",
                       id="00000000-0000-0000-0000-000000000001")

    assert quarantine_reason(sale) == MISSING_PRICE_AND_SURFACE_QUARANTINE
    assert catalogue_write_rejection(sale) is None
    recorded: list[tuple] = []
    assert admit_sales([sale], lambda group, **kw: recorded.append((group, kw))) == [sale]
    # Une vente jamais stockée, sans mise à prix ni surface, reste refusée (aucune ligne masquée créée).
    sale.id = None
    assert quarantine_reason(sale) is None
    assert catalogue_write_rejection(sale) == "missing_price_and_surface"


@pytest.mark.parametrize(
    "lines",
    [
        ["Lot 1", "Un appartement", "Mise à prix : 10 000 €", "Paris"],  # un seul lot numéroté
        ["Un appartement", "de 40 m² (lots n°12 et 13)", "Lot 12", "Mise à prix : 10 000 €"],  # copropriété
        ["Un appartement", "Lot 2", "Lot 5", "Mise à prix : 10 000 €"],  # numéros qui ne se suivent pas
    ],
)
def test_numbered_lines_that_are_not_lot_headings_do_not_split_a_single_lot_page(lines: list[str]) -> None:
    head = ["Annonce publiée le", "2 novembre 2026", "110999", "Tribunal Judiciaire de Paris",
            "Vente aux enchères publiques", "jeudi 3 décembre 2026 à 15h"]
    assert len(parse_licitor_page("\n".join([*head, *lines, "Maître Exemple, Avocat"])).lots) == 1


def test_ordinal_auction_lot_headings_are_lot_headings() -> None:
    head = ["Annonce publiée le", "2 novembre 2026", "110999", "Tribunal Judiciaire de Paris",
            "Vente aux enchères publiques", "jeudi 3 décembre 2026 à 15h"]
    body = ["1er lot d'enchère", "Un appartement", "Mise à prix : 10 000 €",
            "2ème lot d'enchère", "Une cave", "Mise à prix : 1 000 €", "Maître Exemple, Avocat"]
    assert [lot.price_eur for lot in parse_licitor_page("\n".join([*head, *body])).lots] == [10000, 1000]
