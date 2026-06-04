from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from src.models import AuctionSale


@dataclass
class SaleLifecycleStats:
    marked_past: int = 0


def mark_past_sales(sales: list[AuctionSale], now: datetime | None = None) -> SaleLifecycleStats:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    stats = SaleLifecycleStats()
    for sale in sales:
        if sale.sale_date is None or sale.status == "adjudicated":
            continue
        sale_date = sale.sale_date
        if sale_date.tzinfo is None:
            sale_date = sale_date.replace(tzinfo=timezone.utc)
        else:
            sale_date = sale_date.astimezone(timezone.utc)
        if sale_date < now and sale.status != "past":
            sale.status = "past"
            stats.marked_past += 1
    return stats
