"""Plausibilité d'une date de vente lue dans une annonce.

Une vente aux enchères immobilières est annoncée quelques semaines à quelques mois à l'avance.
Une date à plus de 12 mois de la publication de l'annonce, ou à plus de 12 mois d'aujourd'hui, est
presque toujours une coquille de l'annonce (« 2044 » pour « 2024 ») ou un mauvais champ lu. Elle
n'est alors pas présentée comme certaine : la vente n'a plus de date (le site affiche « Date à
confirmer » et ne la compte pas parmi les ventes à venir), la valeur lue est conservée dans
``raw_payload['sale_date_unverified']`` et la vente porte le drapeau ``sale_date_implausible``.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from typing import Any

from dateutil.relativedelta import relativedelta

MAX_SALE_DATE_HORIZON_MONTHS = 12
SALE_DATE_IMPLAUSIBLE_FLAG = "sale_date_implausible"
_ISO_DAY = re.compile(r"(\d{4}-\d{2}-\d{2})")


def published_on(raw_sale: dict[str, Any]) -> date | None:
    """Date de publication de l'annonce quand la source la donne (ISO), sinon ``None``."""
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    features = raw_sale.get("source_property_features")
    listing = features.get("listing") if isinstance(features, dict) else None
    candidates = (
        raw_sale.get("published_on"),
        raw_sale.get("date_publication"),
        blocks.get("date_publication"),
        blocks.get("published_on"),
        listing.get("published_on") if isinstance(listing, dict) else None,
    )
    for value in candidates:
        match = _ISO_DAY.search(str(value or ""))
        if match:
            try:
                return date.fromisoformat(match.group(1))
            except ValueError:
                continue
    return None


def implausible_sale_date_reason(
    sale_date: datetime, raw_sale: dict[str, Any], *, now: datetime | None = None
) -> str | None:
    """``publication_horizon`` ou ``today_horizon`` quand la date dépasse 12 mois, sinon ``None``."""
    now = now or datetime.now(UTC)
    horizon = relativedelta(months=MAX_SALE_DATE_HORIZON_MONTHS)
    if sale_date.tzinfo is None:
        sale_date = sale_date.replace(tzinfo=UTC)
    published = published_on(raw_sale)
    if published is not None and sale_date.date() > published + horizon:
        return "publication_horizon"
    if sale_date > now + horizon:
        return "today_horizon"
    return None


def reject_implausible_sale_date(
    raw_sale: dict[str, Any], sale_date: datetime | None, *, now: datetime | None = None
) -> datetime | None:
    """Renvoie ``sale_date`` si elle est plausible ; sinon ``None``, avec la preuve dans ``raw_sale``."""
    if sale_date is None:
        return None
    reason = implausible_sale_date_reason(sale_date, raw_sale, now=now)
    if reason is None:
        return sale_date
    published = published_on(raw_sale)
    raw_sale["sale_date_unverified"] = {
        "value": sale_date.isoformat(),
        "reason": reason,
        "published_on": published.isoformat() if published else None,
        "max_horizon_months": MAX_SALE_DATE_HORIZON_MONTHS,
    }
    raw_sale["quality_flags"] = [
        *dict.fromkeys([*(raw_sale.get("quality_flags") or []), SALE_DATE_IMPLAUSIBLE_FLAG])
    ]
    return None
