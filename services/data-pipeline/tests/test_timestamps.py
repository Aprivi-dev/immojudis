"""Lecture d'un horodatage (``src.timestamps``) : une règle par origine de la date, et le créneau de vente."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from src.timestamps import assumed_utc_timestamp, aware_timestamp, sale_window

PARIS_WINTER = timezone(timedelta(hours=1))


@pytest.mark.parametrize(
    "value",
    ["2026-11-13T08:30:00Z", "2026-11-13T08:30:00+00:00", "2026-11-13T09:30:00+01:00", "2026-11-13 08:30:00Z"],
)
def test_an_iso_text_with_a_time_zone_gives_its_instant_in_utc(value) -> None:
    parsed = aware_timestamp(value)

    assert parsed == datetime(2026, 11, 13, 8, 30, tzinfo=UTC)
    assert parsed.utcoffset() == timedelta(0)


def test_an_aware_datetime_is_kept_and_given_in_utc() -> None:
    assert aware_timestamp(datetime(2026, 11, 13, 9, 30, tzinfo=PARIS_WINTER)) == datetime(2026, 11, 13, 8, 30, tzinfo=UTC)
    assert aware_timestamp(datetime(2026, 11, 13, 9, 30, tzinfo=PARIS_WINTER)).tzinfo is UTC


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


# --- assumed_utc_timestamp : un horodatage écrit par le pipeline ou la base --------------------------------------


@pytest.mark.parametrize(
    "value",
    ["2026-11-13T08:30:00", "2026-11-13 08:30:00", datetime(2026, 11, 13, 8, 30)],
)
def test_a_stored_date_without_time_zone_is_taken_as_utc(value) -> None:
    parsed = assumed_utc_timestamp(value)

    assert parsed == datetime(2026, 11, 13, 8, 30, tzinfo=UTC)
    assert parsed.tzinfo is UTC


@pytest.mark.parametrize(
    "value",
    ["2026-11-13T09:30:00+01:00", "2026-11-13T08:30:00Z", datetime(2026, 11, 13, 9, 30, tzinfo=PARIS_WINTER)],
)
def test_a_stored_date_with_a_time_zone_keeps_its_instant_given_in_utc(value) -> None:
    parsed = assumed_utc_timestamp(value)

    assert parsed == datetime(2026, 11, 13, 8, 30, tzinfo=UTC)
    assert parsed.tzinfo is UTC


@pytest.mark.parametrize("value", ["not a date", "", None, 1_700_000_000, date(2026, 11, 13)])
def test_an_unreadable_stored_value_gives_none(value) -> None:
    assert assumed_utc_timestamp(value) is None


def test_the_two_rules_differ_only_on_a_date_without_time_zone() -> None:
    assert aware_timestamp("2026-11-13T08:30:00") is None
    assert assumed_utc_timestamp("2026-11-13T08:30:00") == datetime(2026, 11, 13, 8, 30, tzinfo=UTC)
    assert aware_timestamp("2026-11-13T09:30:00+01:00") == assumed_utc_timestamp("2026-11-13T09:30:00+01:00")


# --- sale_window : bornes à fuseau, clôture après l'ouverture -----------------------------------------------------


def test_a_window_with_aware_ordered_bounds_keeps_the_source_offsets() -> None:
    window = sale_window({"opens_at": "2026-11-20T10:00:00+01:00", "closes_at": "2026-11-21T10:00:00Z"})

    assert window == (
        datetime(2026, 11, 20, 10, tzinfo=PARIS_WINTER),
        datetime(2026, 11, 21, 10, tzinfo=UTC),
    )
    assert window[0].isoformat() == "2026-11-20T10:00:00+01:00"


@pytest.mark.parametrize(
    "schedule",
    [
        {"opens_at": "2026-11-20T10:00:00", "closes_at": "2026-11-21T10:00:00+01:00"},  # ouverture sans fuseau
        {"opens_at": "2026-11-20T10:00:00+01:00", "closes_at": "2026-11-21T10:00:00"},  # clôture sans fuseau
        {"opens_at": "2026-11-21T10:00:00+01:00", "closes_at": "2026-11-20T10:00:00+01:00"},  # clôture avant
        {"opens_at": "2026-11-20T10:00:00+01:00", "closes_at": "2026-11-20T09:00:00Z"},  # même instant
        {"opens_at": "2026-11-20T10:00:00+01:00"},
        {"opens_at": None, "closes_at": "2026-11-21T10:00:00+01:00"},
        {"opens_at": "lundi", "closes_at": "mardi"},
        {},
        None,
        "2026-11-20T10:00:00+01:00",
        ["2026-11-20T10:00:00+01:00", "2026-11-21T10:00:00+01:00"],
    ],
)
def test_an_incomplete_naive_or_unordered_window_gives_none(schedule) -> None:
    assert sale_window(schedule) is None
