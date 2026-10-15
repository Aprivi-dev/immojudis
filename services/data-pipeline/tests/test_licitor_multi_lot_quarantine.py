"""Une annonce Licitor en plusieurs lots n'affiche pas les valeurs de son premier lot."""

from src.admission import LICITOR_MULTI_LOT_QUARANTINE, quarantine_reason
from src.normalize import normalize_sale
from src.publication_identity import merge_revision
from src.sources.licitor import parse_licitor_detail_html
from src.storage.sale_row_builders import _judicial_sale_rows_for_sales, _property_rows_for_sales
from tests.test_licitor_extraction import DETAIL_HTML, MULTI_LOT_TEXT, URL

MULTI_LOT_URL = "https://www.licitor.com/annonce/11/09/99/immeuble/testville/110999.html"


def _multi_lot_html() -> str:
    lines = "".join(f"<p>{line}</p>" for line in MULTI_LOT_TEXT.splitlines())
    return f"<html><body><article class='LegalAd'>{lines}</article></body></html>"


def _licitor_sale(html: str, url: str, lots: int):
    raw = parse_licitor_detail_html(html, url)
    raw["source_lots"] = [{"raw_text": f"lot {index}"} for index in range(1, lots + 1)]
    return normalize_sale(raw)


def test_multi_lot_licitor_page_is_flagged_and_quarantined() -> None:
    sale = _licitor_sale(_multi_lot_html(), MULTI_LOT_URL, lots=2)

    assert "multi_lot_sale" in sale.quality_flags
    assert quarantine_reason(sale) == LICITOR_MULTI_LOT_QUARANTINE


def test_multi_lot_licitor_page_is_quarantined_even_when_the_list_showed_a_single_card() -> None:
    sale = _licitor_sale(_multi_lot_html(), MULTI_LOT_URL, lots=1)

    assert quarantine_reason(sale) == LICITOR_MULTI_LOT_QUARANTINE


def test_single_lot_licitor_page_stays_publishable() -> None:
    sale = _licitor_sale(DETAIL_HTML, URL, lots=1)

    assert "multi_lot_sale" not in sale.quality_flags
    # (la fiche d'essai porte par ailleurs un conflit de procédure, sans rapport avec les lots)
    assert quarantine_reason(sale) != LICITOR_MULTI_LOT_QUARANTINE


def test_multi_lot_flag_on_a_single_licitor_lot_is_not_quarantined() -> None:
    sale = _licitor_sale(DETAIL_HTML, URL, lots=1)
    sale.quality_flags.append("multi_lot_sale")

    assert quarantine_reason(sale) != LICITOR_MULTI_LOT_QUARANTINE


def test_only_licitor_is_quarantined_by_this_rule() -> None:
    sale = _licitor_sale(_multi_lot_html(), MULTI_LOT_URL, lots=2)
    sale.source_name = "avoventes"

    assert quarantine_reason(sale) is None


def test_persistence_hides_the_quarantined_multi_lot_sale() -> None:
    sale = _licitor_sale(_multi_lot_html(), MULTI_LOT_URL, lots=2)
    assert sale.status != "quarantined"

    rows = _property_rows_for_sales([sale], "2026-10-15T10:00:00+00:00")

    assert sale.status == "quarantined"
    assert rows[0]["raw_payload"]["publication_quarantine"] == LICITOR_MULTI_LOT_QUARANTINE
    sale.status = "upcoming"
    judicial_rows = _judicial_sale_rows_for_sales([sale], "2026-10-15T10:00:00+00:00")
    assert judicial_rows[0]["status"] == "quarantined"


def test_the_quarantine_lifts_when_the_source_no_longer_lists_several_lots() -> None:
    sale = _licitor_sale(_multi_lot_html(), MULTI_LOT_URL, lots=2)
    _property_rows_for_sales([sale], "2026-10-15T10:00:00+00:00")
    assert sale.raw_payload["publication_quarantine"] == LICITOR_MULTI_LOT_QUARANTINE

    # Collecte suivante : la source ne montre plus qu'un lot.
    sale.quality_flags.remove("multi_lot_sale")
    sale.status = "upcoming"
    _property_rows_for_sales([sale], "2026-10-16T10:00:00+00:00")

    assert "publication_quarantine" not in sale.raw_payload
    assert sale.status == "upcoming"


def test_refresh_does_not_record_an_identity_mismatch_for_the_multi_lot_rule() -> None:
    existing = _licitor_sale(_multi_lot_html(), MULTI_LOT_URL, lots=2)
    incoming = _licitor_sale(_multi_lot_html(), MULTI_LOT_URL, lots=2)

    merged = merge_revision(existing, incoming)

    assert "source_identity_mismatch" not in merged.raw_payload
    assert quarantine_reason(merged) == LICITOR_MULTI_LOT_QUARANTINE
