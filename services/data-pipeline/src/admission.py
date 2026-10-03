"""Minimum collection admission shared by publication entry points."""
from decimal import Decimal, InvalidOperation

from src.models import AuctionSale


def has_price_or_surface(sale: AuctionSale) -> bool:
    for name in ("starting_price_eur", "surface_m2", "habitable_surface_m2",
                 "carrez_surface_m2", "land_surface_m2", "app_surface_m2"):
        value = getattr(sale, name, None)
        if value is None:
            continue
        try:
            number = Decimal(str(value))
            if number.is_finite() and number > 0:
                return True
        except (InvalidOperation, ValueError):
            continue
    return False


def retention_deadline(sale: AuctionSale):
    """Mirror the database retention deadline; uncertain schedules are retained.

    A date-only source does not prove a sale time. Its retention window starts
    after the Paris civil day has ended, then runs for 24 elapsed hours. A
    midnight in ``sale_date`` alone is never treated as date-only evidence.
    """
    import re
    from datetime import UTC, datetime, timedelta
    from zoneinfo import ZoneInfo

    if re.search(r'\b(postponed|reported|report[eé]e?)\b', str(sale.status or '') + ' ' + str(sale.raw_payload.get('status') or ''), re.I):
        return None
    conflicts = sale.raw_payload.get('source_conflicts')
    if isinstance(conflicts, list) and any(isinstance(conflict, dict) and conflict.get('field') == 'sale_date'
                                          for conflict in conflicts):
        return None
    procedure = sale.sale_procedure or {}
    for schedule in (procedure.get('sale_window'), procedure.get('sale_session'), sale.raw_payload.get('source_sale_schedule')):
        if schedule is None:
            continue
        try:
            start = datetime.fromisoformat(schedule['opens_at'])
            end = datetime.fromisoformat(schedule['closes_at'])
            if start.tzinfo is None or end.tzinfo is None or end <= start:
                return None
            return end.astimezone(UTC) + timedelta(hours=24)
        except (KeyError, TypeError, ValueError):
            return None
    if sale.sale_date is None:
        return None
    sale_datetime = sale.sale_date.replace(tzinfo=UTC) if sale.sale_date.tzinfo is None else sale.sale_date
    raw_date = str(sale.raw_payload.get('sale_date') or '')
    precision = (
        str(sale.raw_payload.get('date_precision') or '').strip()
        or str(sale.raw_payload.get('sale_date_precision') or '').strip()
    ).lower()
    date_only = precision in {'day', 'date', 'day_only', 'date_only', 'unknown_time', 'time_unknown'}
    date_only = date_only or bool(raw_date and not re.search(r'[0-9]{1,2}\s*([hH]|:[0-9]{2})', raw_date))
    if date_only:
        next_paris_midnight = datetime.combine(
            sale_datetime.astimezone(ZoneInfo('Europe/Paris')).date() + timedelta(days=1),
            datetime.min.time(),
            ZoneInfo('Europe/Paris'),
        )
        return next_paris_midnight.astimezone(UTC) + timedelta(hours=24)
    return sale_datetime.astimezone(UTC) + timedelta(hours=24)


def catalogue_expiry_deadline(sale: AuctionSale):
    """Return when a sale must leave the public catalogue.

    A date-only source is normalized to midnight, which is an ingestion
    convention rather than evidence that the hearing started at midnight.
    Keep that listing through the corresponding civil day in Europe/Paris.
    A validated online sale window takes precedence and remains visible until
    its observed ``closes_at`` instant.
    """
    import re
    from datetime import UTC, datetime, timedelta
    from zoneinfo import ZoneInfo

    if sale.sale_date is None:
        return None

    sale_datetime = sale.sale_date.replace(tzinfo=UTC) if sale.sale_date.tzinfo is None else sale.sale_date
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}

    for schedule in (
        (sale.sale_procedure or {}).get("sale_window"),
        (sale.sale_procedure or {}).get("sale_session"),
        raw_payload.get("source_sale_schedule"),
    ):
        if not isinstance(schedule, dict):
            continue
        try:
            start = datetime.fromisoformat(str(schedule["opens_at"]).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(schedule["closes_at"]).replace("Z", "+00:00"))
        except (KeyError, TypeError, ValueError):
            continue
        if start.tzinfo is not None and end.tzinfo is not None and end > start:
            return end.astimezone(UTC)

    raw_date = str(raw_payload.get("sale_date") or "")
    precision = (
        str(raw_payload.get("date_precision") or "").strip()
        or str(raw_payload.get("sale_date_precision") or "").strip()
    ).lower()
    date_only = precision in {"day", "date", "day_only", "date_only", "unknown_time", "time_unknown"}
    date_only = date_only or bool(
        raw_date and not re.search(r"[0-9]{1,2}\s*([hH]|:[0-9]{2})", raw_date)
    )
    if not date_only:
        return sale_datetime.astimezone(UTC)

    local_date = sale_datetime.astimezone(ZoneInfo("Europe/Paris")).date()
    next_paris_midnight = datetime.combine(
        local_date + timedelta(days=1),
        datetime.min.time(),
        ZoneInfo("Europe/Paris"),
    )
    return next_paris_midnight.astimezone(UTC)


def is_catalogue_expired(sale: AuctionSale, now=None) -> bool:
    """Whether a sale must be excluded before writing catalogue rows."""
    from datetime import UTC, datetime

    deadline = catalogue_expiry_deadline(sale)
    return deadline is not None and deadline <= (now or datetime.now(UTC))


def is_expired(sale: AuctionSale, now=None) -> bool:
    from datetime import UTC, datetime
    deadline = retention_deadline(sale)
    return deadline is not None and deadline <= (now or datetime.now(UTC))


def quarantine_reason(sale: AuctionSale) -> str | None:
    """Only positive evidence of inconsistency blocks publication, never a missing secondary fact."""
    import re
    text = str(sale.raw_payload.get("description") or sale.raw_payload.get("raw_text") or "")
    if re.search(r"\bpas\s+d['’]ench[eè]res\s+sur\s+ce\s+bien", text, re.I):
        return "fixed_price_sale_conflicts_with_auction_scope"
    if sale.sale_verification_status == "conflict" or "sale_procedure_conflict" in sale.quality_flags:
        return "conflicting_sale_procedure"
    for flag in ("property_identity_conflict", "lot_identity_conflict", "source_identity_mismatch"):
        if flag in sale.quality_flags:
            return flag
    return None
