"""P1-08 : géocodage plus strict, repli sur la commune, départements manquants."""
from decimal import Decimal

import httpx
import pytest

from src import geocode
from src.geocode import GeocodeResult, geocode_address, geocode_sale
from src.normalize import normalize_sale

API = "https://data.geopf.test/search"


def _feature(score, type_="housenumber", *, city="Bordeaux", citycode="33063", postcode="33000", coords=(-0.57, 44.84)):
    return {
        "properties": {
            "score": score,
            "label": f"label {type_}",
            "type": type_,
            "city": city,
            "citycode": citycode,
            "postcode": postcode,
        },
        "geometry": {"coordinates": list(coords)},
    }


class _Response:
    def __init__(self, features=(), status_code=200):
        self.status_code = status_code
        self._features = list(features)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=httpx.Request("GET", API), response=httpx.Response(self.status_code))

    def json(self):
        return {"features": self._features}


def _settings():
    return {"geocode_enabled": True, "geocode_api_url": API, "geocode_min_score": 0.45}


def _result(type_="housenumber", *, score=0.9, city="Bordeaux", citycode="33063", postcode="33000", lat="44.84", lon="-0.57"):
    return GeocodeResult(
        latitude=Decimal(lat), longitude=Decimal(lon), score=score, label=f"label {type_}",
        result_type=type_, city=city, citycode=citycode, postcode=postcode,
    )


def _sale(**fields):
    return normalize_sale(
        {"source_name": "info_encheres", "source_url": "https://www.info-encheres.com/geo.html", **fields}
    )


# --- seuil de score pour les adresses -------------------------------------------------------

@pytest.mark.parametrize(
    ("type_", "score", "accepted"),
    [
        ("housenumber", 0.59, False),
        ("housenumber", 0.6, True),
        ("street", 0.55, False),
        ("street", 0.6, True),
        ("locality", 0.5, True),
        ("municipality", 0.5, True),
    ],
)
def test_housenumber_and_street_need_a_score_of_0_6(monkeypatch, type_, score, accepted):
    monkeypatch.setattr("src.geocode.httpx.get", lambda url, params, timeout: _Response([_feature(score, type_)]))

    result = geocode_address("10 rue Exemple 33000 Bordeaux", api_url=API, min_score=0.45)

    assert (result is not None) is accepted


def test_configured_minimum_still_applies_to_every_type(monkeypatch):
    monkeypatch.setattr("src.geocode.httpx.get", lambda url, params, timeout: _Response([_feature(0.5, "municipality")]))

    assert geocode_address("Bordeaux", api_url=API, min_score=0.7) is None


def test_commune_with_several_postcodes_has_no_single_postcode(monkeypatch):
    feature = _feature(0.9, "municipality", postcode=["75001", "75002"])
    monkeypatch.setattr("src.geocode.httpx.get", lambda url, params, timeout: _Response([feature]))

    assert geocode_address("Paris", api_url=API).postcode is None


def test_type_filter_is_sent_only_when_requested(monkeypatch):
    calls = []

    def fake_get(url, params, timeout):
        calls.append(params)
        return _Response([_feature(0.9, "municipality")])

    monkeypatch.setattr("src.geocode.httpx.get", fake_get)

    geocode_address("Bordeaux", api_url=API, postcode="33000", result_type="municipality")
    geocode_address("Bordeaux", api_url=API)

    assert calls == [
        {"q": "Bordeaux", "limit": 1, "postcode": "33000", "type": "municipality"},
        {"q": "Bordeaux", "limit": 1},
    ]


# --- 429 : attente 1 s, 2 s puis 4 s --------------------------------------------------------

def test_rate_limit_is_retried_with_exponential_backoff(monkeypatch):
    responses = [_Response(status_code=429), _Response(status_code=429), _Response(status_code=429), _Response([_feature(0.9)])]
    sleeps = []
    monkeypatch.setattr("src.geocode.httpx.get", lambda url, params, timeout: responses.pop(0))
    monkeypatch.setattr("src.geocode.time.sleep", sleeps.append)

    result = geocode_address("10 rue Exemple 33000 Bordeaux", api_url=API)

    assert result is not None
    assert sleeps == [1, 2, 4]
    assert responses == []


def test_rate_limit_gives_up_after_three_retries(monkeypatch):
    calls = []
    sleeps = []

    def fake_get(url, params, timeout):
        calls.append(params)
        return _Response(status_code=429)

    monkeypatch.setattr("src.geocode.httpx.get", fake_get)
    monkeypatch.setattr("src.geocode.time.sleep", sleeps.append)

    with pytest.raises(httpx.HTTPStatusError):
        geocode_address("10 rue Exemple 33000 Bordeaux", api_url=API)

    assert len(calls) == 4
    assert sleeps == [1, 2, 4]


def test_no_wait_without_rate_limit(monkeypatch):
    sleeps = []
    monkeypatch.setattr("src.geocode.httpx.get", lambda url, params, timeout: _Response([_feature(0.9)]))
    monkeypatch.setattr("src.geocode.time.sleep", sleeps.append)

    geocode_address("10 rue Exemple 33000 Bordeaux", api_url=API)

    assert sleeps == []


# --- précision et repli sur la commune ------------------------------------------------------

@pytest.mark.parametrize(
    ("type_", "precision"),
    [("housenumber", "address"), ("street", "street"), ("locality", "street"), ("municipality", "municipality")],
)
def test_accepted_result_records_its_precision_in_the_payload(monkeypatch, type_, precision):
    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: _result(type_))
    sale = _sale(address="10 rue Exemple", postal_code="33000", city="Bordeaux")

    geocode_sale(sale)

    assert sale.raw_payload["geo_precision"] == precision
    assert sale.latitude == Decimal("44.84")


def test_failed_address_falls_back_to_the_commune_centroid(monkeypatch):
    calls = []

    def fake_geocode_address(**kwargs):
        calls.append(kwargs)
        if kwargs.get("result_type") == "municipality":
            return _result("municipality", score=0.8, lat="44.8378", lon="-0.5792")
        return None

    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr("src.geocode.geocode_address", fake_geocode_address)
    sale = _sale(address="chemin sans nom", postal_code="33000", city="Bordeaux")

    geocode_sale(sale)

    assert [call.get("result_type") for call in calls] == [None, "municipality"]
    assert calls[1]["query"] == "Bordeaux"
    assert calls[1]["postcode"] == "33000"
    assert (sale.latitude, sale.longitude) == (Decimal("44.8378"), Decimal("-0.5792"))
    assert sale.raw_payload["geo_precision"] == "municipality"
    assert sale.raw_payload["geocode"]["accepted"] is True
    assert sale.raw_payload["geocode"]["type"] == "municipality"


def test_commune_fallback_is_refused_in_another_department(monkeypatch):
    def fake_geocode_address(**kwargs):
        if kwargs.get("result_type") == "municipality":
            return _result("municipality", city="Bordeaux-Saint-Clair", citycode="76110", postcode="76790")
        return None

    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr("src.geocode.geocode_address", fake_geocode_address)
    sale = _sale(address="chemin sans nom", city="Bordeaux", department="33")

    geocode_sale(sale)

    assert sale.latitude is None
    assert "geo_precision" not in sale.raw_payload
    assert "geocode_outside_department" in sale.quality_flags
    assert sale.raw_payload["geocode"]["accepted"] is False


def test_commune_fallback_never_replaces_source_coordinates(monkeypatch):
    calls = []

    def fake_geocode_address(**kwargs):
        calls.append(kwargs)
        return None

    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr("src.geocode.geocode_address", fake_geocode_address)
    sale = _sale(address="chemin sans nom", postal_code="33000", city="Bordeaux")
    sale.latitude, sale.longitude = Decimal("44.83"), Decimal("-0.58")

    geocode_sale(sale)

    assert len(calls) == 1
    assert (sale.latitude, sale.longitude) == (Decimal("44.83"), Decimal("-0.58"))
    assert "geo_precision" not in sale.raw_payload


def test_sale_without_city_gets_no_commune_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: calls.append(kwargs))
    sale = _sale(address="chemin sans nom", postal_code="33000")

    geocode_sale(sale)

    assert len(calls) == 1
    assert sale.raw_payload["geocode"]["rejection_reason"] == "no_result"


# --- département et code postal absents : repli BAN par commune -----------------------------

def test_missing_department_and_postal_code_come_from_the_commune(monkeypatch):
    searched = []

    def fake_search(city, **kwargs):
        searched.append(city)
        return [_result("municipality", city="Samois-sur-Seine", citycode="77446", postcode="77920")]

    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr("src.geocode.search_municipalities", fake_search)
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: None)
    sale = _sale(city="Samois-sur-Seine")
    assert sale.department is None and sale.postal_code is None

    geocode_sale(sale)

    assert searched == ["Samois-sur-Seine"]
    assert sale.department == "77"
    assert sale.postal_code == "77920"
    assert sale.raw_payload["location_inferred_from_city"]["citycode"] == "77446"


def test_corsican_commune_gets_2a_or_2b(monkeypatch):
    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr(
        "src.geocode.search_municipalities",
        lambda city, **kwargs: [_result("municipality", city="Bastia", citycode="2B033", postcode="20200")],
    )
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: None)
    sale = _sale(city="Bastia")

    geocode_sale(sale)

    assert sale.department == "2B"


def test_homonym_communes_are_not_guessed(monkeypatch):
    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr(
        "src.geocode.search_municipalities",
        lambda city, **kwargs: [
            _result("municipality", city="Beaulieu", citycode="07036", postcode="07460"),
            _result("municipality", city="Beaulieu", citycode="34023", postcode="34160"),
        ],
    )
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: None)
    sale = _sale(city="Beaulieu")

    geocode_sale(sale)

    assert sale.department is None
    assert sale.postal_code is None
    assert "location_inferred_from_city" not in sale.raw_payload


def test_commune_lookup_is_skipped_when_the_department_is_known(monkeypatch):
    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr(
        "src.geocode.search_municipalities",
        lambda city, **kwargs: (_ for _ in ()).throw(AssertionError("no lookup expected")),
    )
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: None)

    geocode_sale(_sale(city="Bordeaux", department="33"))
    geocode_sale(_sale(city="Bordeaux", postal_code="33000"))


def test_commune_lookup_failure_does_not_break_geocoding(monkeypatch):
    monkeypatch.setattr("src.geocode.load_settings", _settings)
    monkeypatch.setattr(
        "src.geocode.search_municipalities", lambda city, **kwargs: (_ for _ in ()).throw(httpx.ConnectError("down"))
    )
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: None)
    sale = _sale(city="Samois-sur-Seine")

    assert geocode_sale(sale).department is None


def test_search_municipalities_filters_on_municipality_type(monkeypatch):
    calls = []

    def fake_get(url, params, timeout):
        calls.append(params)
        return _Response([_feature(0.9, "municipality", city="Samois-sur-Seine", citycode="77446", postcode="77920"),
                          _feature(0.3, "municipality", city="Samois", citycode="00000", postcode="00000")])

    monkeypatch.setattr("src.geocode.httpx.get", fake_get)

    results = geocode.search_municipalities("Samois-sur-Seine", api_url=API, min_score=0.45)

    assert calls == [{"q": "Samois-sur-Seine", "limit": 5, "type": "municipality"}]
    assert [result.citycode for result in results] == ["77446"]
