"""P2-10 : une date incomplète n'est jamais complétée avec la date du jour."""
from datetime import UTC, datetime

import pytest

from src.normalize import normalize_sale, parse_french_datetime


@pytest.mark.parametrize(
    "text",
    [
        "lot 3 au 2ème étage",
        "mardi à 14h30",
        "15 mars à 14h",
        "15 mars",
        "mars 2027",
        "2027",
        "14h30",
    ],
)
def test_incomplete_dates_are_rejected(text):
    assert parse_french_datetime(text) is None


def test_complete_french_date_keeps_the_paris_time():
    assert parse_french_datetime("15 mars 2027 à 14h") == datetime(2027, 3, 15, 13, 0, tzinfo=UTC)


def test_weekday_prefix_does_not_change_a_complete_date():
    assert parse_french_datetime("mardi 16 mars 2027 à 14h30") == datetime(2027, 3, 16, 13, 30, tzinfo=UTC)


def test_first_of_january_is_not_mistaken_for_a_missing_component():
    assert parse_french_datetime("1er janvier 2027") == datetime(2027, 1, 1, tzinfo=UTC)
    assert parse_french_datetime("1 janvier 2027 à 10h") == datetime(2027, 1, 1, 9, 0, tzinfo=UTC)


def test_numeric_and_iso_dates_still_parse():
    assert parse_french_datetime("15/03/2027") == datetime(2027, 3, 15, tzinfo=UTC)
    assert parse_french_datetime("2027-03-15T14:00:00+01:00") == datetime(2027, 3, 15, 13, 0, tzinfo=UTC)


def test_sale_with_an_incomplete_date_has_no_sale_date():
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/date-incomplete",
            "sale_date": "mardi à 14h30",
        }
    )

    assert sale.sale_date is None
