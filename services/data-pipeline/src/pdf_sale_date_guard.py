from __future__ import annotations

from datetime import datetime, timedelta

from src.models import AuctionSale

# A PDF date already in the past is far more often a misread (judgment date,
# previous hearing, diagnostic date) than the sale itself: applying it would
# flip the sale to "past" and expose it to catalogue retention.
PDF_SALE_DATE_PAST_GRACE = timedelta(days=1)


def pdf_sale_date_is_past(parsed: datetime, now: datetime | None = None) -> bool:
    current = now or datetime.now(parsed.tzinfo)
    if (parsed.tzinfo is None) != (current.tzinfo is None):
        current = current.replace(tzinfo=parsed.tzinfo)
    return parsed < current - PDF_SALE_DATE_PAST_GRACE


def reject_past_pdf_sale_date(sale: AuctionSale, parsed: datetime, sale_date: dict[str, object]) -> bool:
    """Record and refuse a PDF sale date that is already past; True when refused."""
    if not pdf_sale_date_is_past(parsed):
        return False
    sale.raw_payload["pdf_sale_date_rejected"] = {
        "reason": "past_date",
        "value": parsed.isoformat(),
        **{key: value for key, value in sale_date.items() if key != "value"},
    }
    return True
