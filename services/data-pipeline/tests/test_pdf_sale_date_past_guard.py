from datetime import UTC, datetime, timedelta

import src.pdf_enrichment  # noqa: F401  (loads pdf_fact_extraction without a circular import)
from src.models import AuctionSale
from src.pdf_fact_extraction import _assign_pdf_sale_date
from src.pdf_sale_date_guard import pdf_sale_date_is_past


def _sale() -> AuctionSale:
    return AuctionSale(source_name="avoventes", source_url="https://example.test/vente", raw_payload={})


def test_past_pdf_date_is_never_applied():
    sale = _sale()
    past = datetime(2001, 10, 12, 14, 0, tzinfo=UTC)

    _assign_pdf_sale_date(sale, {"value": past, "document": "cahier.pdf"})

    assert sale.sale_date is None
    assert sale.raw_payload["pdf_sale_date_rejected"]["reason"] == "past_date"
    assert sale.raw_payload["pdf_sale_date_rejected"]["document"] == "cahier.pdf"
    assert "pdf_sale_date_extraction" not in sale.raw_payload


def test_future_pdf_date_is_applied():
    sale = _sale()
    future = datetime.now(UTC) + timedelta(days=30)

    _assign_pdf_sale_date(sale, {"value": future})

    assert sale.sale_date == future
    assert "pdf_sale_date_rejected" not in sale.raw_payload


def test_past_check_handles_naive_dates_and_grace():
    now = datetime(2026, 10, 11, 12, 0)
    assert pdf_sale_date_is_past(datetime(2026, 10, 9, 12, 0), now)
    assert not pdf_sale_date_is_past(datetime(2026, 10, 10, 18, 0), now)
    assert not pdf_sale_date_is_past(datetime(2026, 10, 11, 9, 0, tzinfo=UTC), now)


def test_far_future_pdf_date_is_never_applied():
    sale = _sale()
    misread = datetime.now(UTC) + timedelta(days=4000)

    _assign_pdf_sale_date(sale, {"value": misread, "document": "cahier.pdf"})

    assert sale.sale_date is None
    assert sale.raw_payload["pdf_sale_date_rejected"]["reason"] == "too_far_ahead"
