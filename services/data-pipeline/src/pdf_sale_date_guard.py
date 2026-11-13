"""Date de vente lue dans une pièce jointe (ou, pour un appel d'offres, sur la page) : garde et affectation.

La garde écarte une date invraisemblable ; l'affectation n'écrit que ce que la garde laisse passer, avec sa trace.
Partagé par la lecture des pièces (``src.pdf_fact_extraction``) et l'échéance d'un appel d'offres
(``src.pdf_offer_deadline``).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from src.models import AuctionSale
from src.normalize import normalize_status
from src.pdf_fact_scope import _pdf_record_fact_projection

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
    """Record and refuse an implausible PDF sale date (past or too far ahead); True when refused.

    An expired offer deadline of a call for offers (``offer_deadline_expired``) is the date that closes the
    sale, not a misread: it is kept so the lifecycle marks the sale past.
    """
    if pdf_sale_date_is_past(parsed) and sale_date.get("offer_deadline_expired"):
        sale.raw_payload.pop("pdf_sale_date_rejected", None)
        return False
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


def assign_pdf_sale_date(sale: AuctionSale, sale_date: dict[str, object]) -> None:
    parsed = sale_date.get("value")
    if not isinstance(parsed, datetime) or reject_past_pdf_sale_date(sale, parsed, sale_date):
        return
    sale.sale_date = parsed
    sale.raw_payload["pdf_sale_date_extraction"] = {key: value for key, value in sale_date.items() if key != "value"}
    _pdf_record_fact_projection(sale, ["sale_date"], candidate=sale_date, payload_keys=("pdf_sale_date_extraction",))
    if sale.status in {"", "unknown"} or (sale_date.get("offer_deadline_expired") and sale.status in {"active", "upcoming"}):
        previous_status = sale.status or "unknown"
        projected_status = normalize_status(None, parsed)
        sale.status = projected_status
        if projected_status != previous_status:
            _pdf_record_fact_projection(
                sale,
                ["status"],
                candidate=sale_date,
                baseline=previous_status,
                previous_value=previous_status,
                payload_keys=("pdf_sale_date_extraction",),
            )
