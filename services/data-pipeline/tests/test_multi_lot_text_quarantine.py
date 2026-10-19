"""Avoventes et Enchères Immobilières : une annonce en plusieurs lots n'affiche pas les valeurs d'un seul lot."""

import pytest

from src.admission import (
    LICITOR_MULTI_LOT_QUARANTINE,
    MULTI_LOT_QUARANTINE,
    announces_several_lots,
    is_multi_lot_with_first_lot_values,
    quarantine_reason,
)
from src.normalize import normalize_sale
from src.publication_identity import merge_revision
from src.storage.sale_row_builders import _property_rows_for_sales

URLS = {
    "avoventes": "https://avoventes.fr/enchere/{slug}",
    "encheres_immobilieres": "https://encheresimmobilieres.fr/ventes/9{slug}",
}


def _sale(source: str, *, title: str, description: str = "", slug: str = "bien"):
    return normalize_sale(
        {
            "source_name": source,
            "source_url": URLS[source].format(slug=slug),
            "title": title,
            "description": description,
            "address": "12 rue Test, 33000 Bordeaux",
            "starting_price_eur": "50 000",
        }
    )


@pytest.mark.parametrize("source", sorted(URLS))
@pytest.mark.parametrize(
    "title,description,slug",
    [
        ("Immeuble en deux lots à Bordeaux (33)", "", "bien"),
        ("Deux appartements à Bordeaux", "Vente en 2 lots. Mise à prix 50 000 €.", "bien"),
        ("Appartement à Bordeaux", "Lot 1 mise à prix 30 000 €. Lot 2 mise à prix 20 000 €.", "bien"),
        ("Appartement à Bordeaux", "Lot n°1 : mise à prix 30 000 €", "bien"),
        ("Appartement à Bordeaux", "", "5-immeuble-en-trois-lots-bordeaux-33"),
    ],
)
def test_announcement_in_several_lots_is_quarantined(source, title, description, slug) -> None:
    sale = _sale(source, title=title, description=description, slug=slug)

    assert is_multi_lot_with_first_lot_values(sale)
    assert quarantine_reason(sale) == MULTI_LOT_QUARANTINE


@pytest.mark.parametrize("source", sorted(URLS))
def test_one_single_lot_with_two_flats_stays_publishable(source) -> None:
    sale = _sale(
        source,
        title="Deux appartements à Bordeaux (33) vendus en un seul lot",
        description="Les deux appartements sont mis en vente en un seul lot, mise à prix de l'ensemble 100 000 €.",
    )

    assert not is_multi_lot_with_first_lot_values(sale)
    assert quarantine_reason(sale) is None


def test_single_lot_statement_wins_over_the_number_of_dwellings() -> None:
    assert not announces_several_lots("Immeuble de deux appartements", "vendu en un seul lot")
    assert not announces_several_lots("Lot unique : deux appartements, lot 1 mise à prix 80 000 €")
    assert not announces_several_lots("Appartement de 3 pièces", "Une cave et un parking", None)


@pytest.mark.parametrize("source", ["vench", "info_encheres", "petites_affiches"])
def test_other_sources_are_not_concerned(source) -> None:
    sale = _sale("avoventes", title="Immeuble en deux lots")
    sale.source_name = source

    assert quarantine_reason(sale) is None


def test_licitor_keeps_its_own_reason_code() -> None:
    sale = _sale("avoventes", title="Immeuble en deux lots")
    sale.source_name = "licitor"
    sale.quality_flags.append("multi_lot_sale")
    sale.raw_payload["source_lots"] = [{}, {}]

    assert quarantine_reason(sale) == LICITOR_MULTI_LOT_QUARANTINE


def test_persistence_hides_the_sale_and_the_quarantine_lifts_with_the_text() -> None:
    sale = _sale("encheres_immobilieres", title="Immeuble en deux lots à Bordeaux (33)")

    rows = _property_rows_for_sales([sale], "2026-10-19T10:00:00+00:00")

    assert sale.status == "quarantined"
    assert rows[0]["raw_payload"]["publication_quarantine"] == MULTI_LOT_QUARANTINE

    sale.title = "Immeuble à Bordeaux (33)"
    sale.status = "upcoming"
    _property_rows_for_sales([sale], "2026-10-20T10:00:00+00:00")

    assert "publication_quarantine" not in sale.raw_payload


def test_refresh_does_not_record_an_identity_mismatch_for_the_multi_lot_rule() -> None:
    existing = _sale("avoventes", title="Immeuble en deux lots à Bordeaux (33)")
    incoming = _sale("avoventes", title="Immeuble en deux lots à Bordeaux (33)")

    merged = merge_revision(existing, incoming)

    assert "source_identity_mismatch" not in merged.raw_payload
    assert quarantine_reason(merged) == MULTI_LOT_QUARANTINE
