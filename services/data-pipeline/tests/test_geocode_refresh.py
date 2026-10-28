"""Cause 3 : le géocodage est refait quand la requête d'aujourd'hui n'est plus celle qui a donné un centre de commune."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from src import geocode
from src.geocode import GeocodeResult, geocode_sale, restore_accepted_geocode
from src.normalize import normalize_sale

NIMES_ADDRESS = "2 rue des Chapeliers, 30000 NÎMES"


def _settings():
    return {"geocode_enabled": True, "geocode_api_url": "https://ban.test", "geocode_min_score": 0.45}


def _timestamp(days_ago: int = 0) -> str:
    return (datetime.now(UTC) - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")


def _nimes(**fields):
    return normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente/nimes",
            "address": NIMES_ADDRESS,
            "postal_code": "30000",
            "city": "Nîmes",
            "department": "30",
            **fields,
        }
    )


def _commune_evidence(query: str | None) -> dict:
    return {
        "provider": "ban_geoplateforme", "query": query, "accepted": True, "attempted_at": _timestamp(40),
        "rejection_reason": None, "score": 0.97, "label": "30000 Nîmes", "type": "municipality", "city": "Nîmes",
        "citycode": "30189", "postcode": "30000", "latitude": 43.8367, "longitude": 4.3601,
    }


def _geocoded_before_the_street(**fields):
    sale = _nimes(**fields)
    sale.latitude, sale.longitude = Decimal("43.8367"), Decimal("4.3601")
    sale.raw_payload["geo_precision"] = "municipality"
    sale.raw_payload["geocode"] = _commune_evidence("30000 Nîmes")
    return sale


def _housenumber() -> GeocodeResult:
    return GeocodeResult(
        latitude=Decimal("43.836109"), longitude=Decimal("4.361307"), score=0.97, label="2 Rue des Chapeliers 30000 Nîmes",
        result_type="housenumber", city="Nîmes", citycode="30189", postcode="30000", street="Rue des Chapeliers",
    )


@pytest.fixture
def ban(monkeypatch):
    calls: list[dict] = []
    answers: list[GeocodeResult | None] = [_housenumber()]

    def fake(**kwargs):
        calls.append(kwargs)
        return answers[0]

    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _settings)
    monkeypatch.setattr(geocode, "geocode_address", fake)
    return calls, answers


def test_a_commune_result_found_before_the_street_is_geocoded_again(ban) -> None:
    calls, _ = ban
    sale = _geocoded_before_the_street()

    geocode_sale(sale)

    assert [call["query"] for call in calls] == [NIMES_ADDRESS]
    assert calls[0]["postcode"] == "30000"
    assert (sale.latitude, sale.longitude) == (Decimal("43.836109"), Decimal("4.361307"))
    assert sale.raw_payload["geo_precision"] == "address"
    assert sale.raw_payload["geocode"]["query"] == NIMES_ADDRESS
    assert sale.raw_payload["geocode"]["type"] == "housenumber"


def test_a_commune_result_found_with_the_same_query_is_kept(ban) -> None:
    calls, _ = ban
    sale = _geocoded_before_the_street()
    sale.raw_payload["geocode"]["query"] = NIMES_ADDRESS

    geocode_sale(sale)

    assert calls == []
    assert sale.raw_payload["geo_precision"] == "municipality"


def test_an_address_without_street_keeps_its_commune_result(ban) -> None:
    calls, _ = ban
    sale = _geocoded_before_the_street(address="30000 NÎMES")

    geocode_sale(sale)

    assert calls == []
    assert sale.raw_payload["geo_precision"] == "municipality"


def test_a_failed_refresh_keeps_the_commune_point_and_does_not_retry_for_14_days(ban) -> None:
    calls, answers = ban
    answers[0] = None
    sale = _geocoded_before_the_street()

    geocode_sale(sale)
    geocode_sale(sale)

    assert len(calls) == 1
    assert (sale.latitude, sale.longitude) == (Decimal("43.8367"), Decimal("4.3601"))
    assert sale.raw_payload["geo_precision"] == "municipality"
    assert sale.raw_payload["geocode"]["accepted"] is False
    assert sale.raw_payload["geocode"]["query"] == NIMES_ADDRESS


def test_restore_does_not_freeze_a_commune_result_when_a_richer_query_exists() -> None:
    sale = _nimes()
    sale.raw_payload["geocode"] = _commune_evidence("30000 Nîmes")

    assert restore_accepted_geocode(sale) is False
    assert sale.latitude is None
    assert "geo_precision" not in sale.raw_payload


def test_restore_still_restores_a_commune_result_of_the_current_query() -> None:
    sale = _nimes()
    sale.raw_payload["geocode"] = _commune_evidence(NIMES_ADDRESS)

    assert restore_accepted_geocode(sale) is True
    assert sale.raw_payload["geo_precision"] == "municipality"


def test_restore_still_restores_a_street_level_result_whatever_its_query() -> None:
    sale = _nimes()
    evidence = _commune_evidence("30000 Nîmes")
    evidence["type"] = "housenumber"
    sale.raw_payload["geocode"] = evidence

    assert restore_accepted_geocode(sale) is True
    assert sale.raw_payload["geo_precision"] == "address"


def test_restore_still_restores_a_commune_result_for_an_address_without_street() -> None:
    sale = _nimes(address="30000 NÎMES")
    sale.raw_payload["geocode"] = _commune_evidence("30000 Nîmes")

    assert restore_accepted_geocode(sale) is True


# --- cache négatif et requête construite -----------------------------------------------------------


def _negative(query: str, days_ago: int = 1) -> dict:
    return {
        "provider": "ban_geoplateforme", "query": query, "accepted": False,
        "attempted_at": _timestamp(days_ago), "rejection_reason": "no_result",
    }


def test_the_negative_cache_is_honoured_for_the_same_query(ban) -> None:
    calls, _ = ban
    sale = _nimes()
    sale.raw_payload["geocode"] = _negative(NIMES_ADDRESS)

    geocode_sale(sale)

    assert calls == []


def test_the_negative_cache_is_invalidated_when_the_query_changes(ban) -> None:
    calls, _ = ban
    sale = _nimes()
    sale.raw_payload["geocode"] = _negative("30000 Nîmes")

    geocode_sale(sale)

    assert [call["query"] for call in calls] == [NIMES_ADDRESS]
    assert sale.raw_payload["geo_precision"] == "address"


def test_the_negative_cache_expires_after_14_days(ban) -> None:
    calls, _ = ban
    sale = _nimes()
    sale.raw_payload["geocode"] = _negative(NIMES_ADDRESS, days_ago=15)

    geocode_sale(sale)

    assert len(calls) == 1


# --- requêtes envoyées à la BAN --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("address", "postal_code", "city", "query", "postcode"),
    [
        ("6 rue des Templiers, 69002 LYON 69003", "69003", "LYON", "6 rue des Templiers, 69002 LYON", "69002"),
        (
            "43 Boulevard Henri Maulini, 13014 MARSEILLE", "13006", "MARSEILLE",
            "43 Boulevard Henri Maulini, 13014 MARSEILLE", "13014",
        ),
        (
            "39 rue de la Villeneuve – Bâtiment Lizard – 56100 LORIENT LE LUNDI 23 NOVEMBRE 2026 à 14 H 00 56440 LANGUIDIC",
            "56100", "Lorient", "39 rue de la Villeneuve – 56100 LORIENT", "56100",
        ),
    ],
)
def test_the_ban_receives_the_cleaned_query_and_the_postcode_of_the_address(
    ban, address, postal_code, city, query, postcode
) -> None:
    calls, answers = ban
    answers[0] = None
    sale = normalize_sale(
        {
            "source_name": "vench", "source_url": "https://www.vench.fr/vente/x", "address": address,
            "postal_code": postal_code, "city": city,
        }
    )

    geocode_sale(sale)

    assert calls[0]["query"] == query
    assert calls[0]["postcode"] == postcode


def test_the_lorient_street_is_compared_without_the_building_and_the_date(ban) -> None:
    _, answers = ban
    answers[0] = GeocodeResult(
        latitude=Decimal("47.753012"), longitude=Decimal("-3.377389"), score=0.97,
        label="39 Rue de la Villeneuve 56100 Lorient", result_type="housenumber", city="Lorient",
        citycode="56121", postcode="56100", street="Rue de la Villeneuve",
    )
    sale = normalize_sale(
        {
            "source_name": "vench", "source_url": "https://www.vench.fr/vente/lorient",
            "address": "39 rue de la Villeneuve – Bâtiment Lizard – 56100 LORIENT LE LUNDI 23 NOVEMBRE 2026 à 14 H 00 56440 LANGUIDIC",
            "postal_code": "56100", "city": "Lorient", "department": "56",
        }
    )

    geocode_sale(sale)

    assert sale.raw_payload["geo_precision"] == "address"
    assert sale.raw_payload["geocode"]["accepted"] is True
