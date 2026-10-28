"""Cause 4 : un point publié par la source, vérifié et loin du centre de sa commune, reçoit la précision « address »."""

from __future__ import annotations

from decimal import Decimal

import pytest

from src import geocode, municipality_location
from src.geocode import GeocodeResult, geocode_sale, locate_sale_by_cadastre, verify_source_coordinates
from src.normalize import normalize_sale
from src.source_coordinates import MIN_DISTANCE_FROM_COMMUNE_M, PROVIDER

GRASSE = (43.6584, 6.9225)
COMMUNES = [
    {"code_insee": "06069", "name_normalized": "grasse", "department_code": "06",
     "postal_codes": ["06130"], "latitude": GRASSE[0], "longitude": GRASSE[1]},
]


@pytest.fixture
def communes(monkeypatch):
    monkeypatch.setattr(municipality_location, "load_communes", lambda: COMMUNES)
    municipality_location.reset_cache()
    yield
    municipality_location.reset_cache()


def _sale(latitude: str, longitude: str, **fields):
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/vente/1",
            "address": "12 rue Exemple 06130 Grasse",
            "postal_code": "06130",
            "city": "Grasse",
            "department": "06",
            **fields,
        }
    )
    sale.latitude, sale.longitude = Decimal(latitude), Decimal(longitude)
    return sale


def test_a_source_point_far_from_the_commune_centre_is_promoted(communes) -> None:
    sale = _sale("43.6620", "6.9290")  # environ 700 m du centre

    assert verify_source_coordinates(sale) is None

    assert sale.raw_payload["geo_precision"] == "address"
    evidence = sale.raw_payload["geocode"]
    assert evidence["provider"] == PROVIDER
    assert evidence["accepted"] is True
    assert evidence["precision"] == "address"
    assert evidence["distance_to_commune_m"] > MIN_DISTANCE_FROM_COMMUNE_M
    assert evidence["commune_code"] == "06069"
    assert (evidence["latitude"], evidence["longitude"]) == (43.662, 6.929)
    # La preuve ne porte ni type ni score de la BAN : l'application la lit comme un point sans réserve.
    assert "type" not in evidence and "score" not in evidence
    assert sale.quality_flags == []


def test_a_source_point_within_150_m_of_the_centre_stays_approximate(communes) -> None:
    sale = _sale("43.6590", "6.9230")  # environ 80 m

    assert verify_source_coordinates(sale) is None

    assert "geo_precision" not in sale.raw_payload
    assert "geocode" not in sale.raw_payload


def test_the_threshold_is_150_m(communes) -> None:
    # 0,0013 degré de latitude = environ 145 m ; 0,0015 = environ 167 m.
    near = _sale("43.6597", "6.9225")
    far = _sale("43.6599", "6.9225")

    verify_source_coordinates(near)
    verify_source_coordinates(far)

    assert "geo_precision" not in near.raw_payload
    assert far.raw_payload["geo_precision"] == "address"


def test_a_suspect_source_point_is_not_promoted(communes) -> None:
    sale = _sale("43.70", "7.25")  # environ 25 km

    assert verify_source_coordinates(sale) == "unverified"

    assert "geo_precision" not in sale.raw_payload
    assert sale.quality_flags == ["unverified_source_coordinates"]


def test_an_implausible_source_point_is_removed_and_not_promoted(communes) -> None:
    sale = _sale("54.27", "-0.40")

    assert verify_source_coordinates(sale) == "implausible"

    assert sale.latitude is None
    assert "geo_precision" not in sale.raw_payload


def test_without_the_reference_table_nothing_is_promoted() -> None:
    municipality_location.reset_cache()
    try:
        sale = _sale("43.6620", "6.9290")
        assert verify_source_coordinates(sale) is None
        assert "geo_precision" not in sale.raw_payload
    finally:
        municipality_location.reset_cache()


def test_an_accepted_ban_result_is_never_overridden(communes) -> None:
    sale = _sale("43.6620", "6.9290")
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme", "accepted": True, "type": "street", "latitude": 43.5, "longitude": 6.9,
    }

    verify_source_coordinates(sale)

    assert sale.raw_payload["geocode"]["provider"] == "ban_geoplateforme"
    assert "geo_precision" not in sale.raw_payload


def test_a_position_flag_blocks_the_promotion(communes) -> None:
    sale = _sale("43.6620", "6.9290")
    sale.quality_flags = ["geocode_outside_department"]
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme", "accepted": False, "rejection_reason": "outside_department", "query": "q",
    }

    verify_source_coordinates(sale)

    assert "geo_precision" not in sale.raw_payload
    assert sale.raw_payload["geocode"]["rejection_reason"] == "outside_department"


def test_a_ban_attempt_without_result_is_kept_inside_the_source_evidence(communes) -> None:
    sale = _sale("43.6620", "6.9290")
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme", "accepted": False, "rejection_reason": "no_result",
        "query": "12 rue Exemple 06130 Grasse", "attempted_at": "2026-10-20T10:00:00Z",
    }

    verify_source_coordinates(sale)

    evidence = sale.raw_payload["geocode"]
    assert evidence["provider"] == PROVIDER
    assert evidence["ban_query"] == "12 rue Exemple 06130 Grasse"
    assert evidence["ban_attempted_at"] == "2026-10-20T10:00:00Z"
    assert evidence["ban_rejection_reason"] == "no_result"


def test_the_promotion_is_recomputed_when_the_source_point_moves(communes) -> None:
    sale = _sale("43.6620", "6.9290")
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme", "accepted": False, "rejection_reason": "no_result",
        "query": "q", "attempted_at": "2026-10-20T10:00:00Z",
    }
    verify_source_coordinates(sale)
    assert sale.raw_payload["geo_precision"] == "address"

    # La source corrige son point : il tombe sur le centre de la commune.
    sale.latitude, sale.longitude = Decimal("43.6585"), Decimal("6.9226")
    verify_source_coordinates(sale)

    assert "geo_precision" not in sale.raw_payload
    # La trace de la tentative BAN revient sous sa forme de cache négatif.
    assert sale.raw_payload["geocode"] == {
        "provider": "ban_geoplateforme", "query": "q", "accepted": False,
        "attempted_at": "2026-10-20T10:00:00Z", "rejection_reason": "no_result",
    }


def test_the_promotion_is_idempotent(communes) -> None:
    sale = _sale("43.6620", "6.9290")

    verify_source_coordinates(sale)
    first = dict(sale.raw_payload["geocode"])
    verify_source_coordinates(sale)

    assert sale.raw_payload["geocode"] == first
    assert sale.raw_payload["geo_precision"] == "address"


def test_a_non_numbered_source_point_is_promoted_like_any_other(communes) -> None:
    sale = _sale("43.6620", "6.9290", address="Lieu-dit Le Moulin 06130 Grasse")

    verify_source_coordinates(sale)

    assert sale.raw_payload["geo_precision"] == "address"


@pytest.mark.parametrize("address", ["06130 Grasse", "Grasse", "06130 GRASSE", None])
def test_an_address_reduced_to_the_commune_keeps_an_approximate_position(communes, address) -> None:
    sale = _sale("43.6620", "6.9290", address=address)  # loin du centre, mais aucune voie ni lieu-dit

    assert verify_source_coordinates(sale) is None

    assert "geo_precision" not in sale.raw_payload
    assert sale.raw_payload.get("geocode", {}).get("provider") != PROVIDER
    assert (sale.latitude, sale.longitude) == (Decimal("43.6620"), Decimal("6.9290"))


def test_the_promotion_is_withdrawn_when_the_address_loses_its_street(communes) -> None:
    sale = _sale("43.6620", "6.9290")
    verify_source_coordinates(sale)
    assert sale.raw_payload["geo_precision"] == "address"

    sale.address = "06130 Grasse"
    verify_source_coordinates(sale)

    assert "geo_precision" not in sale.raw_payload and "geocode" not in sale.raw_payload


# --- avec la BAN ------------------------------------------------------------------------------------------


def _ban_settings():
    return {"geocode_enabled": True, "geocode_api_url": "https://ban.test", "geocode_min_score": 0.45}


def test_ban_without_result_keeps_the_promoted_source_point_and_its_negative_cache(communes, monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: calls.append(kwargs))
    sale = _sale("43.6620", "6.9290")

    geocode_sale(sale)

    assert len(calls) == 1
    assert (sale.latitude, sale.longitude) == (Decimal("43.6620"), Decimal("6.9290"))
    assert sale.raw_payload["geo_precision"] == "address"
    evidence = sale.raw_payload["geocode"]
    assert evidence["provider"] == PROVIDER
    assert evidence["ban_query"] == "12 rue Exemple 06130 Grasse"
    assert evidence["ban_rejection_reason"] == "no_result"

    # Deuxième passage : le cache négatif (14 jours) évite la BAN.
    geocode_sale(sale)

    assert len(calls) == 1
    assert sale.raw_payload["geo_precision"] == "address"


def test_ban_replaces_the_promoted_source_point(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    found = GeocodeResult(
        latitude=Decimal("43.6601"), longitude=Decimal("6.9250"), score=0.95, label="12 Rue Exemple 06130 Grasse",
        result_type="housenumber", city="Grasse", citycode="06069", postcode="06130", street="Rue Exemple",
    )
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: found)
    sale = _sale("43.6620", "6.9290")

    geocode_sale(sale)

    assert (sale.latitude, sale.longitude) == (Decimal("43.6601"), Decimal("6.9250"))
    assert sale.raw_payload["geocode"]["provider"] == "ban_geoplateforme"
    assert sale.raw_payload["geo_precision"] == "address"


def test_the_offline_path_promotes_without_any_network(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", lambda: {"geocode_enabled": False})
    sale = _sale("43.6620", "6.9290")

    locate_sale_by_cadastre(sale)

    assert sale.raw_payload["geo_precision"] == "address"
    assert sale.raw_payload["geocode"]["provider"] == PROVIDER


def test_a_ban_result_outside_the_department_withdraws_the_promotion(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    elsewhere = GeocodeResult(
        latitude=Decimal("48.85"), longitude=Decimal("2.35"), score=0.95, label="12 Rue Exemple 75001 Paris",
        result_type="housenumber", city="Paris", citycode="75056", postcode="75001", street="Rue Exemple",
    )
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: elsewhere)
    sale = _sale("43.6620", "6.9290")

    geocode_sale(sale)

    assert "geocode_outside_department" in sale.quality_flags
    assert "geo_precision" not in sale.raw_payload
    assert sale.raw_payload["geocode"]["accepted"] is False
