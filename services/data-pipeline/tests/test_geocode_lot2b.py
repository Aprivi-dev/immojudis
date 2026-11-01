"""Lot 2b, n° 30, 31 et 32 : Cedex et codes génériques, arrondissements, contrôle de commune et de la boîte France."""

from __future__ import annotations

from decimal import Decimal

import pytest

from src import geocode, municipality_location
from src.department_bounds import coordinates_in_department, coordinates_in_france
from src.geocode import GeocodeResult, geocode_sale
from src.geocode_query import (
    address_has_cedex,
    build_geocode_query,
    clean_address_for_geocoding,
    geocode_postcode,
    municipality_postcode,
)
from src.normalize import normalize_sale

API = "https://data.geopf.test/search"


def _sale(**fields):
    return normalize_sale({"source_name": "vench", "source_url": "https://example.test/vente", **fields})


def _settings():
    return {"geocode_enabled": True, "geocode_api_url": API, "geocode_min_score": 0.45}


def _feature(label, type_, citycode, postcode, coordinates, *, score=0.9, city="Ville", street=None):
    properties = {
        "score": score,
        "label": label,
        "type": type_,
        "city": city,
        "citycode": citycode,
        "postcode": postcode,
    }
    if street:
        properties["street"] = street
    return {"properties": properties, "geometry": {"coordinates": list(coordinates)}}


class _Response:
    status_code = 200

    def __init__(self, features):
        self._features = features

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"features": self._features}


@pytest.fixture
def network(monkeypatch):
    """BAN simulée : enregistre chaque appel (paramètres) et répond avec ``answers[type]``."""
    calls: list[dict] = []
    answers: dict[str | None, list[dict]] = {}

    def fake_get(url, params, timeout):
        calls.append(dict(params))
        return _Response(answers.get(params.get("type"), []))

    monkeypatch.setattr(geocode.httpx, "get", fake_get)
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _settings)
    return calls, answers


# --- n° 30 : Cedex et codes génériques ----------------------------------------------------------------------------


def test_lyon_cedex_is_removed_from_the_query_and_never_filters_the_postcode() -> None:
    sale = _sale(address="10 rue de la République, 69421 LYON CEDEX 03", postal_code="69421", city="Lyon Cedex 03")

    assert clean_address_for_geocoding(sale.address) == "10 rue de la République, LYON"
    assert build_geocode_query(sale) == "10 rue de la République, LYON"
    assert address_has_cedex(sale.address)
    assert geocode_postcode(sale) is None
    assert municipality_postcode(sale) is None


def test_cedex_without_postal_code_in_the_address_keeps_the_real_postal_code_in_the_query() -> None:
    sale = _sale(address="10 rue de la République, LYON CEDEX 03", postal_code="69003", city="Lyon")

    assert build_geocode_query(sale) == "10 rue de la République, LYON 69003"
    assert geocode_postcode(sale) == "69003"


@pytest.mark.parametrize(
    ("address", "cleaned"),
    [
        ("12 rue Foch BP 123 75008 Paris", "12 rue Foch 75008 Paris"),
        ("12 rue Foch - CS 60001 - 75008 Paris", "12 rue Foch - - 75008 Paris"),
        ("12 rue Foch TSA 12345, 75008 Paris", "12 rue Foch, 75008 Paris"),
        ("12 rue Foch Boîte postale 45 75008 Paris", "12 rue Foch 75008 Paris"),
        ("12 rue Foch 75008 Paris Cedex 8", "12 rue Foch 75008 Paris"),
    ],
)
def test_postal_boxes_are_removed_from_the_query(address: str, cleaned: str) -> None:
    assert clean_address_for_geocoding(address) == cleaned


@pytest.mark.parametrize("postal_code", ["69000", "13000", "33000", "75000"])
def test_a_generic_postal_code_is_never_a_filter(postal_code: str) -> None:
    sale = _sale(address=f"10 rue de la République, {postal_code} Marseille", postal_code=postal_code, city="Marseille")

    assert geocode_postcode(sale) is None
    assert municipality_postcode(sale) is None
    assert postal_code in build_geocode_query(sale)


def test_marseille_13000_sends_no_postcode_to_the_ban(network) -> None:
    calls, answers = network
    answers[None] = [
        _feature("10 Rue de la République 13001 Marseille", "housenumber", "13201", "13001", (5.37, 43.30),
                 city="Marseille", street="Rue de la République")
    ]
    sale = _sale(address="10 rue de la République, 13000 Marseille", postal_code="13000", city="Marseille", department="13")

    geocode_sale(sale)

    assert calls and all("postcode" not in call for call in calls)
    assert sale.latitude == Decimal("43.3")


def test_lyon_cedex_sends_a_query_without_cedex_and_no_postcode(network) -> None:
    calls, answers = network
    answers[None] = [
        _feature("10 Rue de la République 69002 Lyon", "housenumber", "69382", "69002", (4.83, 45.76),
                 city="Lyon", street="Rue de la République")
    ]
    sale = _sale(address="10 rue de la République, 69421 LYON CEDEX 03", postal_code="69421", city="Lyon Cedex 03",
                 department="69")

    geocode_sale(sale)

    assert [call["q"] for call in calls] == ["10 rue de la République, LYON"]
    assert all("cedex" not in call["q"].lower() and "postcode" not in call for call in calls)
    assert sale.latitude == Decimal("45.76")


# --- n° 31 : arrondissements de Paris, Lyon, Marseille et communes déléguées ------------------------------------------


def _plm_features():
    return {
        "75": [
            _feature("Paris", "municipality", "75056", "75001", (2.347, 48.859), score=0.97, city="Paris"),
            _feature("Paris 8e Arrondissement", "municipality", "75108", "75008", (2.3116, 48.8737), score=0.86,
                     city="Paris"),
        ],
        "13": [
            _feature("Marseille", "municipality", "13055", "13001", (5.405, 43.282), score=0.97, city="Marseille"),
            _feature("Marseille 16e Arrondissement", "municipality", "13216", "13016", (5.3219, 43.3654),
                     score=0.86, city="Marseille"),
        ],
    }


@pytest.mark.parametrize(
    ("city", "postal_code", "department", "expected_latitude", "expected_citycode"),
    [
        ("Paris", "75008", "75", Decimal("48.8737"), "75108"),
        ("Paris 8ème", "75008", "75", Decimal("48.8737"), "75108"),
        ("Marseille", "13016", "13", Decimal("43.3654"), "13216"),
    ],
)
def test_the_municipal_fallback_picks_the_arrondissement(
    network, city, postal_code, department, expected_latitude, expected_citycode
) -> None:
    calls, answers = network
    answers["municipality"] = _plm_features()[department]
    sale = _sale(address="chemin sans nom", postal_code=postal_code, city=city, department=department)

    geocode_sale(sale)

    municipal_calls = [call for call in calls if call.get("type") == "municipality"]
    assert len(municipal_calls) == 1
    assert municipal_calls[0]["limit"] == 3
    assert municipal_calls[0]["postcode"] == postal_code
    assert municipal_calls[0]["q"] == city.split()[0]
    assert sale.latitude == expected_latitude
    assert sale.raw_payload["geocode"]["citycode"] == expected_citycode
    assert sale.raw_payload["geo_precision"] == "municipality"


def test_lyon_arrondissement_is_found_from_the_postal_code(network) -> None:
    calls, answers = network
    answers["municipality"] = [
        _feature("Lyon", "municipality", "69123", "69001", (4.835, 45.758), score=0.96, city="Lyon"),
        _feature("Lyon 3e Arrondissement", "municipality", "69383", "69003", (4.8696, 45.7516), score=0.87,
                 city="Lyon"),
    ]
    sale = _sale(address="chemin sans nom", postal_code="69003", city="Lyon", department="69")

    geocode_sale(sale)

    assert sale.raw_payload["geocode"]["citycode"] == "69383"
    assert sale.latitude == Decimal("45.7516")


def test_without_arrondissement_the_whole_city_is_kept(network) -> None:
    calls, answers = network
    answers["municipality"] = _plm_features()["75"]
    sale = _sale(address="chemin sans nom", city="Paris", department="75")

    geocode_sale(sale)

    assert sale.raw_payload["geocode"]["citycode"] == "75056"


def test_other_cities_keep_a_single_result_and_their_name(network) -> None:
    calls, answers = network
    answers["municipality"] = [_feature("Pau", "municipality", "64445", "64000", (-0.37, 43.3), city="Pau")]
    sale = _sale(address="chemin sans nom", postal_code="64000", city="Pau", department="64")

    geocode_sale(sale)

    municipal_calls = [call for call in calls if call.get("type") == "municipality"]
    assert municipal_calls == [{"q": "Pau", "limit": 1, "type": "municipality"}]


def test_annecy_le_vieux_is_searched_as_annecy(network) -> None:
    calls, answers = network
    answers["municipality"] = [
        _feature("Annecy", "municipality", "74010", "74000", (6.1253, 45.9016), score=0.96, city="Annecy")
    ]
    sale = _sale(address="chemin sans nom", postal_code="74940", city="Annecy-le-Vieux", department="74")

    geocode_sale(sale)

    municipal_calls = [call for call in calls if call.get("type") == "municipality"]
    assert municipal_calls == [{"q": "Annecy", "limit": 1, "postcode": "74940", "type": "municipality"}]
    assert sale.latitude == Decimal("45.9016")
    assert sale.raw_payload["geocode"]["citycode"] == "74010"


def test_a_postal_code_that_names_a_single_commune_is_the_last_resort(network, monkeypatch) -> None:
    calls, answers = network
    monkeypatch.setattr(geocode, "commune_name_for_postal_code", lambda postal: "grand bourg")

    def fake_get(url, params, timeout):
        calls.append(dict(params))
        found = params["q"] == "grand bourg"
        return _Response([_feature("Grand Bourg", "municipality", "38100", "38390", (5.2, 45.8), city="Grand Bourg")]
                         if found else [])

    monkeypatch.setattr(geocode.httpx, "get", fake_get)
    sale = _sale(address="chemin sans nom", postal_code="38390", city="Hameau Inconnu", department="38")

    geocode_sale(sale)

    municipal_queries = [call["q"] for call in calls if call.get("type") == "municipality"]
    assert municipal_queries == ["Hameau Inconnu", "grand bourg"]
    assert sale.latitude == Decimal("45.8")


def test_commune_name_for_postal_code_needs_a_single_commune(monkeypatch) -> None:
    monkeypatch.setattr(
        municipality_location,
        "load_communes",
        lambda: [
            {"code_insee": "74010", "name_normalized": "annecy", "department_code": "74",
             "postal_codes": ["74000", "74940"], "latitude": 45.9, "longitude": 6.12},
            {"code_insee": "38001", "name_normalized": "un", "department_code": "38",
             "postal_codes": ["38000"], "latitude": 45.1, "longitude": 5.7},
            {"code_insee": "38002", "name_normalized": "deux", "department_code": "38",
             "postal_codes": ["38000"], "latitude": 45.2, "longitude": 5.8},
        ],
    )
    municipality_location.reset_cache()
    try:
        assert municipality_location.commune_name_for_postal_code("74940") == "annecy"
        assert municipality_location.commune_name_for_postal_code("38000") is None
        assert municipality_location.commune_name_for_postal_code("99999") is None
        assert municipality_location.commune_name_for_postal_code("74") is None
    finally:
        municipality_location.reset_cache()


# --- n° 32 : commune du point BAN et boîte France -----------------------------------------------------------------


def _result(citycode, *, lat="45.9", lon="6.12", type_="housenumber"):
    return GeocodeResult(
        latitude=Decimal(lat), longitude=Decimal(lon), score=0.9, label="label", result_type=type_,
        city="Ville", citycode=citycode, postcode="74000", street=None,
    )


def _with_reference(monkeypatch, code_insee: str, name: str, postal_code: str, department: str) -> None:
    monkeypatch.setattr(
        municipality_location,
        "load_communes",
        lambda: [{"code_insee": code_insee, "name_normalized": name, "department_code": department,
                  "postal_codes": [postal_code], "latitude": 45.9, "longitude": 6.12}],
    )
    municipality_location.reset_cache()


def test_a_ban_point_in_another_commune_is_refused_and_flagged(monkeypatch) -> None:
    _with_reference(monkeypatch, "74010", "annecy", "74000", "74")
    try:
        sale = _sale(address="5 rue du Château", postal_code="74000", city="Annecy", department="74")

        accepted = geocode._accept_result(sale, query="5 rue du Château 74000 Annecy", result=_result("74056"))

        assert accepted is False
        assert sale.latitude is None
        assert "geocode_commune_mismatch" in sale.quality_flags
        assert sale.raw_payload["geocode"]["accepted"] is False
        assert sale.raw_payload["geocode"]["rejection_reason"] == "commune_mismatch"
    finally:
        municipality_location.reset_cache()


def test_a_ban_point_in_the_commune_of_the_sale_is_accepted(monkeypatch) -> None:
    _with_reference(monkeypatch, "74010", "annecy", "74000", "74")
    try:
        sale = _sale(address="5 rue du Château", postal_code="74000", city="Annecy", department="74")

        assert geocode._accept_result(sale, query="q", result=_result("74010")) is True
        assert sale.latitude == Decimal("45.9")
        assert "geocode_commune_mismatch" not in sale.quality_flags
    finally:
        municipality_location.reset_cache()


def test_an_arrondissement_code_counts_for_its_commune(monkeypatch) -> None:
    _with_reference(monkeypatch, "75056", "paris", "75008", "75")
    try:
        sale = _sale(address="12 rue Foch", postal_code="75008", city="Paris", department="75")

        assert geocode._accept_result(sale, query="q", result=_result("75108", lat="48.87", lon="2.31")) is True
    finally:
        municipality_location.reset_cache()


def test_a_later_verified_point_clears_the_commune_mismatch_flag(monkeypatch) -> None:
    _with_reference(monkeypatch, "74010", "annecy", "74000", "74")
    try:
        sale = _sale(address="5 rue du Château", postal_code="74000", city="Annecy", department="74")
        geocode._accept_result(sale, query="q", result=_result("74056"))
        assert "geocode_commune_mismatch" in sale.quality_flags

        assert geocode._accept_result(sale, query="q", result=_result("74010")) is True
        assert "geocode_commune_mismatch" not in sale.quality_flags
    finally:
        municipality_location.reset_cache()


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [
        ("0", "0"),  # (0, 0) : le « Null Island »
        ("2.35", "48.85"),  # Paris, latitude et longitude inversées
        ("54.27", "-0.40"),  # Yorkshire
    ],
)
def test_a_ban_point_outside_france_is_refused_even_without_department(latitude: str, longitude: str) -> None:
    sale = _sale(address="5 rue du Château", city="Ville")
    assert sale.department is None and sale.postal_code is None

    accepted = geocode._accept_result(sale, query="q", result=_result(None, lat=latitude, lon=longitude))

    assert accepted is False
    assert sale.latitude is None
    assert "geocode_outside_department" in sale.quality_flags


@pytest.mark.parametrize(("latitude", "longitude"), [("0", "0"), ("2.35", "48.85")])
def test_a_source_point_outside_france_is_removed_even_without_department(latitude: str, longitude: str) -> None:
    sale = _sale(address="5 rue du Château", city="Ville")
    sale.latitude, sale.longitude = Decimal(latitude), Decimal(longitude)

    assert geocode.verify_source_coordinates(sale) == "implausible"
    assert sale.latitude is None and sale.longitude is None
    assert sale.raw_payload["rejected_source_coordinates"]["reason"] == "outside_department"
    assert "implausible_coordinates" in sale.quality_flags


def test_a_stored_ban_point_outside_france_is_not_restored() -> None:
    sale = _sale(address="5 rue du Château", city="Ville")
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme", "accepted": True, "type": "housenumber", "latitude": 0.0, "longitude": 0.0,
    }

    assert geocode.restore_accepted_geocode(sale) is False
    assert sale.latitude is None


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [
        (48.8566, 2.3522),  # Paris
        (16.2410, -61.5330),  # Pointe-à-Pitre
        (4.9372, -52.3260),  # Cayenne
        (-20.8789, 55.4481),  # Saint-Denis de La Réunion
        (-12.7809, 45.2279),  # Mamoudzou
        (46.7833, -56.1667),  # Saint-Pierre
        (-17.5334, -149.5667),  # Papeete
        (-22.2763, 166.4572),  # Nouméa
        (-13.2825, -176.1764),  # Mata-Utu
        (18.0731, -63.0822),  # Marigot (Saint-Martin)
    ],
)
def test_the_whole_of_france_is_inside_the_france_box(latitude: float, longitude: float) -> None:
    assert coordinates_in_france(latitude, longitude)
    assert coordinates_in_department(latitude, longitude, "")


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [(0, 0), (2.35, 48.85), (51.5, -0.12), (40.7, -74.0), (float("nan"), 2.0), (91, 2), (48.0, 181)],
)
def test_points_outside_france_are_refused_whatever_the_department(latitude: float, longitude: float) -> None:
    assert not coordinates_in_france(latitude, longitude)
    assert not coordinates_in_department(latitude, longitude, "")
    assert not coordinates_in_department(latitude, longitude, "977")
