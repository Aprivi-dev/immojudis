from datetime import UTC, datetime, timedelta

from src.lifecycle import mark_past_sales
from src.models import AuctionSale


def _sale(status: str, sale_date: datetime | None) -> AuctionSale:
    return AuctionSale(
        source_name="test",
        source_url=f"https://example.com/{status}/{sale_date}",
        status=status,
        sale_date=sale_date,
    )


def test_mark_past_sales_marks_expired_upcoming_sales() -> None:
    now = datetime(2026, 5, 19, tzinfo=UTC)
    sale = _sale("upcoming", now - timedelta(days=1))

    stats = mark_past_sales([sale], now=now)

    assert sale.status == "past"
    assert stats.marked_past == 1


def test_mark_past_sales_preserves_future_and_adjudicated_sales() -> None:
    now = datetime(2026, 5, 19, tzinfo=UTC)
    future = _sale("upcoming", now + timedelta(days=1))
    adjudicated = _sale("adjudicated", now - timedelta(days=1))

    stats = mark_past_sales([future, adjudicated], now=now)

    assert future.status == "upcoming"
    assert adjudicated.status == "adjudicated"
    assert stats.marked_past == 0
