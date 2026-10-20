"""Point au centre de la commune pour les ventes sans aucun essai de géocodage (Vench, « 27100 Le Vaudreuil »)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from src import geocode, municipality_location
from src.normalize import normalize_sale

COMMUNES = [
    {"code_insee": "27701", "name_normalized": "le vaudreuil", "department_code": "27",
     "postal_codes": ["27100"], "latitude": 49.2656, "longitude": 1.2095},
    {"code_insee": "27691", "name_normalized": "val de reuil", "department_code": "27",
     "postal_codes": ["27100"], "latitude": 49.2689, "longitude": 1.2085},
    {"code_insee": "93066", "name_normalized": "saint denis", "department_code": "93",
     "postal_codes": ["93200"], "latitude": 48.9362, "longitude": 2.3574},
    {"code_insee": "974411", "name_normalized": "saint denis", "department_code": "974",
     "postal_codes": ["97400"], "latitude": -20.88, "longitude": 55.45},
    {"code_insee": "40209", "name_normalized": "ondres", "department_code": "40",
     "postal_codes": ["40440"], "latitude": 43.5683, "longitude": -1.4503},
]


@pytest.fixture
def communes(monkeypatch):
    monkeypatch.setattr(municipality_location, "load_communes", lambda: COMMUNES)
    municipality_location.reset_cache()


def _vench_sale(**overrides):
    raw = {
        "source_name": "vench",
        "source_url": "https://www.vench.fr/vente-166573-appartement-le-vaudreuil.html",
        "address": "27100 Le Vaudreuil",
        "city": "Le Vaudreuil",
        "postal_code": "27100",
        "property_type": "apartment",
        "starting_price_eur": "20 000 €",
        **overrides,
    }
    return normalize_sale(raw)


def test_a_sale_without_a_point_gets_its_commune_centre_at_municipality_precision(communes) -> None:
    sale = _vench_sale()
    assert sale.latitude is None

    assert municipality_location.locate_sale_by_municipality(sale) is True

    assert (sale.latitude, sale.longitude) == (Decimal("49.2656"), Decimal("1.2095"))
    assert sale.raw_payload["geo_precision"] == "municipality"
    evidence = sale.raw_payload["geocode"]
    assert (evidence["provider"], evidence["accepted"], evidence["type"], evidence["citycode"]) == (
        "reference_communes", True, "municipality", "27701",
    )


def test_the_commune_is_chosen_by_name_among_those_of_the_postal_code(communes) -> None:
    """27100 couvre Val-de-Reuil et Le Vaudreuil : le nom tranche, jamais l'ordre."""
    sale = _vench_sale(city="Val-de-Reuil", address="27100 Val-de-Reuil")

    municipality_location.locate_sale_by_municipality(sale)

    assert sale.raw_payload["geocode"]["citycode"] == "27691"


@pytest.mark.parametrize(
    "overrides",
    [
        {"city": "Louviers", "address": "27100 Louviers"},  # une commune qui n'est pas celle du code postal
        {"postal_code": None, "department": None, "city": "Saint-Denis", "address": "Saint-Denis"},  # homonymes
        {"city": None, "address": None},
    ],
)
def test_an_ambiguous_or_unknown_commune_gets_no_point(communes, overrides) -> None:
    sale = _vench_sale(**overrides)

    assert municipality_location.locate_sale_by_municipality(sale) is False
    assert sale.latitude is None and "geocode" not in sale.raw_payload


def test_without_a_postal_code_a_name_unique_in_the_department_is_enough(communes) -> None:
    sale = _vench_sale(postal_code=None, department="40", city="Ondres (40)", address="Ondres")

    assert municipality_location.locate_sale_by_municipality(sale) is True
    assert sale.raw_payload["geocode"]["citycode"] == "40209"


def test_a_sale_that_already_has_a_point_is_left_alone(communes) -> None:
    sale = _vench_sale()
    sale.latitude, sale.longitude = Decimal("1"), Decimal("2")

    assert municipality_location.locate_sale_by_municipality(sale) is False
    assert (sale.latitude, sale.longitude) == (Decimal("1"), Decimal("2"))


def test_without_the_reference_table_nothing_is_placed(monkeypatch) -> None:
    def broken():
        raise RuntimeError("no table")

    monkeypatch.setattr(municipality_location, "load_communes", broken)
    municipality_location.reset_cache()

    assert municipality_location.locate_sale_by_municipality(_vench_sale()) is False


def test_the_autonomous_finalisation_path_places_the_point_without_any_network(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", lambda: {"geocode_enabled": False})
    sale = _vench_sale()

    geocode.locate_sale_by_cadastre(sale)

    assert sale.latitude is not None
    assert sale.raw_payload["geo_precision"] == "municipality"


def _ban_settings():
    return {
        "geocode_enabled": True,
        "geocode_api_url": "https://ban.test",
        "geocode_min_score": 0.5,
    }


def test_ban_replaces_the_commune_centre_when_it_finds_an_address(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    sale = _vench_sale()
    municipality_location.locate_sale_by_municipality(sale)
    found = geocode.GeocodeResult(
        latitude=Decimal("49.2701"), longitude=Decimal("1.2201"), score=0.9, label="1 rue X 27100 Le Vaudreuil",
        result_type="housenumber", city="Le Vaudreuil", citycode="27701", postcode="27100",
    )
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: found)

    geocode.geocode_sale(sale)

    assert (sale.latitude, sale.longitude) == (Decimal("49.2701"), Decimal("1.2201"))
    assert sale.raw_payload["geo_precision"] == "address"
    assert sale.raw_payload["geocode"]["provider"] == "ban_geoplateforme"
    assert "unverified_source_coordinates" not in sale.quality_flags


def test_a_failed_ban_attempt_keeps_the_commune_centre(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    sale = _vench_sale()
    municipality_location.locate_sale_by_municipality(sale)
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: None)

    geocode.geocode_sale(sale)

    assert (sale.latitude, sale.longitude) == (Decimal("49.2656"), Decimal("1.2095"))
    assert sale.raw_payload["geo_precision"] == "municipality"
    assert "unverified_source_coordinates" not in sale.quality_flags
