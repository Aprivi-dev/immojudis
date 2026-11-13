"""Un drapeau qualité s'ajoute une seule fois, en fin de liste : la règle unique de ``src.models``."""

from __future__ import annotations

from src.models import AuctionSale, add_quality_flag


def test_a_flag_is_appended_once_and_the_order_is_kept() -> None:
    flags = ["ambiguous_surface", "missing_gps"]

    add_quality_flag(flags, "annex_lot")
    add_quality_flag(flags, "ambiguous_surface")
    add_quality_flag(flags, "annex_lot")

    assert flags == ["ambiguous_surface", "missing_gps", "annex_lot"]


def test_the_sale_list_itself_is_updated() -> None:
    sale = AuctionSale(source_name="licitor", source_url="https://example.test/1", quality_flags=["missing_gps"])
    flags = sale.quality_flags

    add_quality_flag(sale.quality_flags, "tribunal_inconsistent")

    assert sale.quality_flags is flags
    assert sale.quality_flags == ["missing_gps", "tribunal_inconsistent"]
