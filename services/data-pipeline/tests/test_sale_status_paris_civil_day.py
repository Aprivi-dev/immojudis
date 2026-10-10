"""P1-09 : le statut d'une vente se décide sur le jour civil Europe/Paris."""
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from src import admission
from src.admission import is_catalogue_expired, sale_date_has_passed
from src.normalize import normalize_sale, normalize_status
from src.sources import encheres_immobilieres as source

PARIS = ZoneInfo("Europe/Paris")


def _utc(*args):
    return datetime(*args, tzinfo=UTC)


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (_utc(2026, 10, 14, 23, 0), "upcoming"),
        (_utc(2026, 10, 15, 0, 0), "upcoming"),
        (_utc(2026, 10, 15, 18, 0), "upcoming"),  # 20 h à Paris, le jour de l'audience
        (_utc(2026, 10, 15, 21, 59), "upcoming"),  # 23 h 59 à Paris
        (_utc(2026, 10, 15, 22, 0), "past"),  # minuit à Paris
        (_utc(2026, 10, 16, 8, 0), "past"),
    ],
)
def test_date_only_sale_turns_past_the_next_paris_day(now, expected):
    status = normalize_status(None, _utc(2026, 10, 15), date_only=True, now=now)

    assert status == expected


def test_date_only_boundary_follows_winter_time():
    sale_date = _utc(2026, 12, 15)

    assert normalize_status(None, sale_date, date_only=True, now=_utc(2026, 12, 15, 22, 59)) == "upcoming"
    assert normalize_status(None, sale_date, date_only=True, now=_utc(2026, 12, 15, 23, 0)) == "past"


def test_timed_sale_is_past_once_its_hour_has_gone():
    sale_date = _utc(2026, 10, 15, 12, 0)  # 14 h à Paris

    assert normalize_status(None, sale_date, now=_utc(2026, 10, 15, 11, 59)) == "upcoming"
    assert normalize_status(None, sale_date, now=_utc(2026, 10, 15, 18, 0)) == "past"


def test_sale_dated_today_in_paris_is_upcoming_and_yesterday_is_past():
    today = datetime.now(PARIS).date()

    def status_for(day: date) -> str:
        return normalize_sale(
            {
                "source_name": "avoventes",
                "source_url": f"https://avoventes.fr/enchere/{day.isoformat()}",
                "sale_date": day.isoformat(),
            }
        ).status

    assert status_for(today) == "upcoming"
    assert status_for(today - timedelta(days=1)) == "past"


@pytest.mark.parametrize(
    "raw",
    [
        {"sale_date": "15 octobre 2026"},
        {"source_blocks": {"date_vente": "15 octobre 2026"}},
    ],
)
def test_status_and_catalogue_expiry_agree_on_date_only_sales(raw):
    sale = normalize_sale({"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/x", **raw})

    assert sale.raw_payload["date_precision"] == "day"
    for now in (
        _utc(2026, 10, 15, 0, 30),
        _utc(2026, 10, 15, 18, 0),
        _utc(2026, 10, 15, 21, 59),
        _utc(2026, 10, 15, 22, 0),
        _utc(2026, 10, 16, 6, 0),
    ):
        assert is_catalogue_expired(sale, now) == sale_date_has_passed(sale.sale_date, date_only=True, now=now)


def test_explicit_hour_keeps_the_sale_timed():
    sale = normalize_sale(
        {"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/y", "sale_date": "15 octobre 2026 à 14h"}
    )

    assert "date_precision" not in sale.raw_payload
    assert admission.is_date_only("15 octobre 2026 à 14h") is False


def test_existing_precision_is_not_overwritten():
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/z",
            "sale_date": "15 octobre 2026",
            "date_precision": "source_day",
        }
    )

    assert sale.raw_payload["date_precision"] == "source_day"


# --- encheres_immobilieres : carte de liste sans année ------------------------------------

CARD = "{day} {month} Tribunal Judiciaire de Bordeaux - Maison à BORDEAUX (33) Mise à prix 90 000 € Voir le bien"


def _card(monkeypatch, today: date, day: int, month: str):
    monkeypatch.setattr(source, "_paris_today", lambda: today)
    return source._raw_sale_from_listing_text(
        CARD.format(day=day, month=month), "https://www.encheres-immobilieres.com/ventes/123-maison-bordeaux-33"
    )


def test_card_tolerates_thirty_days_of_past_before_rolling_to_next_year(monkeypatch):
    today = date(2026, 10, 9)

    assert _card(monkeypatch, today, 20, "SEPT")["sale_date"] == "20 septembre 2026"
    assert _card(monkeypatch, today, 9, "SEPT")["sale_date"] == "9 septembre 2026"  # exactement 30 jours
    assert _card(monkeypatch, today, 8, "SEPT")["sale_date"] == "8 septembre 2027"
    assert _card(monkeypatch, today, 9, "AOUT")["sale_date"] == "9 août 2027"
    assert _card(monkeypatch, today, 15, "OCT")["sale_date"] == "15 octobre 2026"


def test_card_around_new_year_picks_the_right_year(monkeypatch):
    today = date(2027, 1, 5)

    assert _card(monkeypatch, today, 20, "DEC")["sale_date"] == "20 décembre 2026"
    assert _card(monkeypatch, today, 10, "JANV")["sale_date"] == "10 janvier 2027"


def test_card_no_longer_forces_upcoming_status(monkeypatch):
    raw = _card(monkeypatch, date(2026, 10, 9), 20, "SEPT")

    assert "status" not in raw
    sale = normalize_sale(raw)
    assert sale.sale_date.date() == date(2026, 9, 20)
    assert sale.status == "past"


def test_undated_card_is_not_reported_upcoming(monkeypatch):
    monkeypatch.setattr(source, "_paris_today", lambda: date(2026, 10, 9))
    raw = source._raw_sale_from_listing_text(
        "Tribunal Judiciaire de Bordeaux - Maison à BORDEAUX (33) Mise à prix 90 000 € Voir le bien",
        "https://www.encheres-immobilieres.com/ventes/124-maison-bordeaux-33",
    )

    assert "status" not in raw
    assert normalize_sale(raw).status == "unknown"
