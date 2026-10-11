from __future__ import annotations

from datetime import datetime, timedelta

from src.models import AuctionSale

# A PDF date already in the past is far more often a misread (judgment date,
# previous hearing, diagnostic date) than the sale itself: applying it would
# flip the sale to "past" and expose it to catalogue retention.
PDF_SALE_DATE_PAST_GRACE = timedelta(days=1)
# Judicial sales are published weeks, at most a few months, ahead. A PDF date
# further out is a misread (a year taken from an address or a reference).
PDF_SALE_DATE_MAX_AHEAD = timedelta(days=548)


def pdf_sale_date_is_past(parsed: datetime, now: datetime | None = None) -> bool:
    current = now or datetime.now(parsed.tzinfo)
    if (parsed.tzinfo is None) != (current.tzinfo is None):
        current = current.replace(tzinfo=parsed.tzinfo)
    return parsed < current - PDF_SALE_DATE_PAST_GRACE


def pdf_sale_date_is_too_far(parsed: datetime, now: datetime | None = None) -> bool:
    current = now or datetime.now(parsed.tzinfo)
    if (parsed.tzinfo is None) != (current.tzinfo is None):
        current = current.replace(tzinfo=parsed.tzinfo)
    return parsed > current + PDF_SALE_DATE_MAX_AHEAD


def reject_past_pdf_sale_date(sale: AuctionSale, parsed: datetime, sale_date: dict[str, object]) -> bool:
    """Record and refuse an implausible PDF sale date (past or too far ahead); True when refused."""
    if pdf_sale_date_is_past(parsed):
        reason = "past_date"
    elif pdf_sale_date_is_too_far(parsed):
        reason = "too_far_ahead"
    else:
        return False
    sale.raw_payload["pdf_sale_date_rejected"] = {
        "reason": reason,
        "value": parsed.isoformat(),
        **{key: value for key, value in sale_date.items() if key != "value"},
    }
    return True
