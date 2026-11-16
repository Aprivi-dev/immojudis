"""Délai de relecture d'une fiche connue pendant l'inventaire (``freshness.detail_is_fresh``).

16/11/2026 : 72 h par défaut pour toutes les sources (au lieu de 24 h), 6 h pour une audience dans les 7 jours,
24 h gardées pour Licitor, dont seule la fiche dit qu'une vente est retirée, annulée ou reportée.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from src.freshness import (
    DETAIL_REREAD_HOURS,
    NEAR_SALE_REREAD_HOURS,
    SOURCE_EXTRACTION_VERSION,
    detail_is_fresh,
    detail_reread_hours,
)

NOW = datetime(2026, 11, 16, 12, tzinfo=UTC)
SOURCES_ON_DEFAULT = ("encheres_immobilieres", "vench", "info_encheres", "encheres_publiques", "cessions_etat",
                      "petites_affiches", "notaires", "avoventes", "agrasc")


def _row(source_name: str, *, checked_hours_ago: float, sale_in: timedelta | None) -> dict:
    now = datetime.now(UTC)
    return {
        "source_name": source_name,
        "sale_date": (now + sale_in).isoformat() if sale_in is not None else None,
        "raw_payload": {"source_checks": {"u": {
            "checked_at": (now - timedelta(hours=checked_hours_ago)).isoformat(),
            "source_name": source_name,
            "extractor_version": SOURCE_EXTRACTION_VERSION,
        }}},
    }


@pytest.mark.parametrize("source_name", SOURCES_ON_DEFAULT)
def test_a_far_sale_is_re_read_after_three_days(source_name) -> None:
    assert detail_reread_hours(source_name, NOW + timedelta(days=60), NOW) == DETAIL_REREAD_HOURS == 72
    assert detail_is_fresh(_row(source_name, checked_hours_ago=30, sale_in=timedelta(days=60)), "u")
    assert detail_is_fresh(_row(source_name, checked_hours_ago=71, sale_in=timedelta(days=60)), "u")
    assert not detail_is_fresh(_row(source_name, checked_hours_ago=73, sale_in=timedelta(days=60)), "u")


@pytest.mark.parametrize("source_name", (*SOURCES_ON_DEFAULT, "licitor"))
def test_a_sale_within_seven_days_keeps_the_six_hour_window(source_name) -> None:
    assert detail_reread_hours(source_name, NOW + timedelta(days=3), NOW) == NEAR_SALE_REREAD_HOURS == 6
    assert detail_reread_hours(source_name, NOW + timedelta(days=7), NOW) == 6
    assert detail_is_fresh(_row(source_name, checked_hours_ago=5, sale_in=timedelta(days=2)), "u")
    assert not detail_is_fresh(_row(source_name, checked_hours_ago=7, sale_in=timedelta(days=2)), "u")


def test_licitor_keeps_a_daily_re_read_because_only_its_detail_page_shows_a_withdrawal() -> None:
    assert detail_reread_hours("licitor", NOW + timedelta(days=60), NOW) == 24
    assert detail_is_fresh(_row("licitor", checked_hours_ago=23, sale_in=timedelta(days=60)), "u")
    assert not detail_is_fresh(_row("licitor", checked_hours_ago=25, sale_in=timedelta(days=60)), "u")


@pytest.mark.parametrize("sale_date", [None, NOW - timedelta(days=1), NOW + timedelta(days=8)])
def test_a_sale_without_a_near_hearing_uses_the_source_window(sale_date) -> None:
    assert detail_reread_hours("vench", sale_date, NOW) == 72
