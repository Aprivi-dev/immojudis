"""Valeur remise quand une pièce cesse de porter un champ : une seule règle pour les trois chemins.

``pdf_fact_scope._pdf_restore_value_before_document`` sert la projection tracée, les anciennes listes de candidats et
la pièce remplacée (``pdf_enrichment._invalidate_replaced_document_facts``).
"""

from __future__ import annotations

from decimal import Decimal

from src.models import AuctionSale
from src.pdf_enrichment import _invalidate_replaced_document_facts
from src.pdf_fact_scope import _clear_pdf_fact_projections

URL = "https://www.vench.fr/annonce-1.html"
DOCUMENT = "https://www.avoventes.fr/doc/ccv.pdf"


def test_a_replaced_document_restores_the_value_the_collection_wrote_from_a_text_snapshot() -> None:
    """L'instantané garde le texte de la page : il est relu par la règle de la collecte, jamais remis tel quel."""
    listing = "https://www.avoventes.fr/vente/1"
    sale = AuctionSale(
        source_name="avoventes", source_url=listing, title="Appartement", surface_m2=Decimal("58.20"),
        surface_source="pdf", starting_price_eur=Decimal("12000"),
        documents=[{"label": "Cahier des conditions de vente", "url": DOCUMENT}],
        raw_payload={
            "source_factual_snapshot": {"source_name": "avoventes", "source_url": listing, "title": "Appartement",
                                        "surface_m2": "85,5", "starting_price_eur": "120 000,00 €"},
            "starting_price_extraction": {"source": "pdf"},
            "document_analysis": {"profiles": [{"url": DOCUMENT, "sha256": "ancien"}]},
        },
    )

    _invalidate_replaced_document_facts(sale, [{"url": DOCUMENT, "sha256": "nouveau"}])

    assert isinstance(sale.surface_m2, Decimal) and sale.surface_m2 == Decimal("85.5")
    assert isinstance(sale.starting_price_eur, Decimal) and sale.starting_price_eur == Decimal("120000")


def _legacy_sale(snapshot: dict) -> AuctionSale:
    """Ligne d'avant la trace par champ : seules les listes de candidats disent que la pièce a donné la valeur."""
    return AuctionSale(
        source_name="vench", source_url=URL, rooms_count=3, occupancy_status="rented",
        raw_payload={"source_detail_status": "restricted", "source_factual_snapshot": snapshot,
                     "pdf_rooms_candidates": [{"value": 3}], "pdf_occupancy_candidates": [{"value": "rented"}]},
    )


def test_a_legacy_candidate_list_does_not_empty_a_field_the_page_never_gave() -> None:
    sale = _legacy_sale({"source_name": "vench", "source_url": URL,
                         "fields_from_stored_row": ["occupancy_status", "rooms_count"]})

    state = _clear_pdf_fact_projections(sale)

    assert (sale.rooms_count, sale.occupancy_status) == (3, "rented")
    assert state == {"cleared": set(), "preserved": {"rooms_count", "occupancy_status"}}
    assert {"pdf_rooms_candidates", "pdf_occupancy_candidates"} <= set(sale.raw_payload)


def test_a_legacy_candidate_list_still_empties_a_field_the_page_was_read_for() -> None:
    """Témoin : la page a été lue en entier et ne donne ni pièces ni occupation."""
    sale = _legacy_sale({"source_name": "vench", "source_url": URL, "rooms_count": None, "occupancy_status": None})

    state = _clear_pdf_fact_projections(sale)

    assert (sale.rooms_count, sale.occupancy_status) == (None, None)
    assert state["cleared"] == {"rooms_count", "occupancy_status"}
    assert "pdf_rooms_candidates" not in sale.raw_payload


def test_the_value_kept_by_the_trace_wins_over_an_unknown_source_value() -> None:
    """La trace garde la valeur d'avant la pièce : elle est connue, même si la page ne donnait pas le champ."""
    sale = AuctionSale(
        source_name="vench", source_url=URL, rooms_count=3,
        raw_payload={
            "source_factual_snapshot": {"source_name": "vench", "source_url": URL, "fields_from_stored_row": ["rooms_count"]},
            "pdf_fact_provenance": {"rooms_count": {"value": 3, "baseline": 2, "source": "pdf", "payload_keys": []}},
        },
    )

    state = _clear_pdf_fact_projections(sale)

    assert sale.rooms_count == 2
    assert state == {"cleared": {"rooms_count"}, "preserved": set()}
    assert "pdf_fact_provenance" not in sale.raw_payload
