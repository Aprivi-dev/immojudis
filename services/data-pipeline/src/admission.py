"""Minimum collection admission shared by publication entry points."""
import re
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from src.models import AuctionSale

DATE_ONLY_PRECISIONS = {"day", "date", "day_only", "date_only", "unknown_time", "time_unknown"}
PARIS = ZoneInfo("Europe/Paris")


def is_date_only(raw_date: object, precision: object = None) -> bool:
    """Whether a source gave a day without an hour (the stored midnight is a convention)."""
    raw = str(raw_date or "")
    if str(precision or "").strip().lower() in DATE_ONLY_PRECISIONS:
        return True
    return bool(raw and not re.search(r"[0-9]{1,2}\s*([hH]|:[0-9]{2})", raw))


def sale_date_has_passed(sale_date: datetime, *, date_only: bool, now: datetime | None = None) -> bool:
    """A timed sale is over once its instant has passed; a date-only one only the next Paris day."""
    now = now or datetime.now(UTC)
    if sale_date.tzinfo is None:
        sale_date = sale_date.replace(tzinfo=UTC)
    if date_only:
        return now.astimezone(PARIS).date() > sale_date.astimezone(PARIS).date()
    return sale_date <= now


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
    if is_date_only(raw_date, precision):
        next_paris_midnight = datetime.combine(
            sale_datetime.astimezone(ZoneInfo('Europe/Paris')).date() + timedelta(days=1),
            datetime.min.time(),
            ZoneInfo('Europe/Paris'),
        )
        return next_paris_midnight.astimezone(UTC) + timedelta(hours=24)
    return sale_datetime.astimezone(UTC) + timedelta(hours=24)


def catalogue_expiry_deadline(sale: AuctionSale, *, policy: str | None = None):
    """Return the instant after which a sale leaves the public catalogue.

    Catalogue visibility has a stricter rule than retention.  A dated sale is
    hidden as soon as its known timestamp has passed.  A date-only source is
    kept visible through that civil day in Europe/Paris, because midnight in
    the normalized value is an ingestion convention rather than evidence that
    the hearing started at 00:00.  The policy is explicit and can be changed
    with ``IMMOJUDIS_DATE_ONLY_CATALOGUE_POLICY`` (``end_of_local_day`` is the
    safe default; ``start_of_day`` is available for a deliberate product
    decision).

    A missing date remains eligible for retention and review, but is not an
    upcoming catalogue item.  The SQL catalogue uses the same rule.
    """
    import os
    from datetime import UTC, datetime, timedelta
    from zoneinfo import ZoneInfo

    if sale.sale_date is None:
        return None

    sale_datetime = sale.sale_date.replace(tzinfo=UTC) if sale.sale_date.tzinfo is None else sale.sale_date
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}

    # An online sale can open at ``sale_date`` and remain actionable until
    # the observed closing instant.  Keep this ingestion-side cutoff aligned
    # with the SQL catalogue helper; otherwise an upsert could drop a listing
    # while the public catalogue still considers its window live.
    procedure = sale.sale_procedure if isinstance(sale.sale_procedure, dict) else {}
    for schedule in (
        procedure.get("sale_window"),
        procedure.get("sale_session"),
        raw_payload.get("source_sale_schedule"),
    ):
        if not isinstance(schedule, dict):
            continue
        try:
            start = datetime.fromisoformat(str(schedule["opens_at"]).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(schedule["closes_at"]).replace("Z", "+00:00"))
            if start.tzinfo is not None and end.tzinfo is not None and end > start:
                return end.astimezone(UTC)
        except (KeyError, TypeError, ValueError):
            continue

    raw_date = str(raw_payload.get("sale_date") or "")
    precision = (
        str(raw_payload.get("date_precision") or "").strip()
        or str(raw_payload.get("sale_date_precision") or "").strip()
    ).lower()
    date_only = is_date_only(raw_date, precision)

    selected_policy = (
        policy
        or os.getenv("IMMOJUDIS_DATE_ONLY_CATALOGUE_POLICY")
        or "end_of_local_day"
    ).strip().lower()
    if selected_policy not in {"end_of_local_day", "start_of_day"}:
        selected_policy = "end_of_local_day"
    if not date_only:
        return sale_datetime.astimezone(UTC)

    local_date = sale_datetime.astimezone(ZoneInfo("Europe/Paris")).date()
    if selected_policy == "start_of_day":
        return datetime.combine(
            local_date,
            datetime.min.time(),
            ZoneInfo("Europe/Paris"),
        ).astimezone(UTC)

    next_paris_midnight = datetime.combine(
        local_date + timedelta(days=1),
        datetime.min.time(),
        ZoneInfo("Europe/Paris"),
    )
    return next_paris_midnight.astimezone(UTC)


def is_catalogue_expired(sale: AuctionSale, now=None, *, policy: str | None = None) -> bool:
    """Whether the sale must be excluded before writing catalogue rows."""
    from datetime import UTC, datetime

    deadline = catalogue_expiry_deadline(sale, policy=policy)
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
