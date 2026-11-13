"""Lecture d'un horodatage à fuseau : une seule règle (``src.timestamps.aware_timestamp``)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from src.timestamps import aware_timestamp


@pytest.mark.parametrize(
    "value",
    ["2026-11-13T08:30:00Z", "2026-11-13T08:30:00+00:00", "2026-11-13T09:30:00+01:00", "2026-11-13 08:30:00Z"],
)
def test_an_iso_text_with_a_time_zone_gives_its_instant_in_utc(value) -> None:
    parsed = aware_timestamp(value)

    assert parsed == datetime(2026, 11, 13, 8, 30, tzinfo=UTC)
    assert parsed.utcoffset() == timedelta(0)


def test_an_aware_datetime_is_kept_and_given_in_utc() -> None:
    paris_winter = timezone(timedelta(hours=1))

    assert aware_timestamp(datetime(2026, 11, 13, 9, 30, tzinfo=paris_winter)) == datetime(2026, 11, 13, 8, 30, tzinfo=UTC)
    assert aware_timestamp(datetime(2026, 11, 13, 9, 30, tzinfo=paris_winter)).tzinfo is UTC


@pytest.mark.parametrize(
    "value",
    [
        "2026-11-13T08:30:00",  # sans fuseau : on ne sait pas quel instant
        datetime(2026, 11, 13, 8, 30),
        "2026-11-13",
        "not a date",
        "",
        None,
        1_700_000_000,
        date(2026, 11, 13),
    ],
)
def test_a_date_without_time_zone_or_an_unreadable_value_gives_none(value) -> None:
    assert aware_timestamp(value) is None
