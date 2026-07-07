from datetime import UTC, datetime
from decimal import Decimal

from src.geocode import GeocodeResult, geocode_address, geocode_sale
from src.normalize import normalize_sale


def test_geocode_sale_does_not_call_api_when_coordinates_exist() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/with-coords",
            "address": "1 rue Test 33000 Bordeaux",
        }
    )
    sale.latitude = Decimal("44.84")
    sale.longitude = Decimal("-0.57")

    result = geocode_sale(sale)

    assert result.latitude == Decimal("44.84")
    assert result.longitude == Decimal("-0.57")


def test_geocode_sale_replaces_coordinates_outside_department(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/pau.html",
            "address": "21 Boulevard Jean Sarrailh 64000 PAU",
            "postal_code": "64000",
            "department": "64",
        }
    )
    sale.latitude = Decimal("44.40655")
    sale.longitude = Decimal("6.061187")

    def fake_geocode_address(**kwargs):
        assert kwargs["query"] == "21 Boulevard Jean Sarrailh 64000 PAU"
        assert kwargs["postcode"] == "64000"
        return GeocodeResult(
            latitude=Decimal("43.308358"),
            longitude=Decimal("-0.37106"),
            score=0.92,
            label="21 Boulevard Jean Sarrailh 64000 Pau",
            result_type="housenumber",
            city="Pau",
            citycode="64445",
            postcode="64000",
        )

    monkeypatch.setattr("src.geocode.geocode_address", fake_geocode_address)

    result = geocode_sale(sale)

    assert result.latitude == Decimal("43.308358")
    assert result.longitude == Decimal("-0.37106")
    assert "implausible_coordinates" in result.quality_flags
    geocode = result.raw_payload["geocode"]
    assert isinstance(geocode.get("attempted_at"), str)
    assert geocode == {
        "provider": "ban_geoplateforme",
        "query": "21 Boulevard Jean Sarrailh 64000 PAU",
        "accepted": True,
        "attempted_at": geocode["attempted_at"],
        "rejection_reason": None,
        "score": 0.92,
        "label": "21 Boulevard Jean Sarrailh 64000 Pau",
        "type": "housenumber",
        "city": "Pau",
        "citycode": "64445",
        "postcode": "64000",
        "latitude": 43.308358,
        "longitude": -0.37106,
    }


def test_geocode_sale_rejects_ban_result_outside_department(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/bordeaux.html",
            "address": "1 place Pey Berland",
            "postal_code": "33000",
            "department": "33",
        }
    )

    def fake_geocode_address(**kwargs):
        return GeocodeResult(
            latitude=Decimal("48.8566"),
            longitude=Decimal("2.3522"),
            score=0.98,
            label="1 place hors zone",
            result_type="housenumber",
            city="Paris",
            citycode="75056",
            postcode="75001",
        )

    monkeypatch.setattr("src.geocode.geocode_address", fake_geocode_address)

    result = geocode_sale(sale)

    assert result.latitude is None
    assert result.longitude is None
    assert "geocode_outside_department" in result.quality_flags
    assert result.raw_payload["geocode"]["accepted"] is False
    assert result.raw_payload["geocode"]["rejection_reason"] == "outside_department"


def test_geocode_sale_skips_recent_negative_cache(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/no-result.html",
            "address": "1 chemin introuvable",
            "postal_code": "33000",
            "department": "33",
            "city": "Bordeaux",
            "raw_payload": {
                "geocode": {
                    "provider": "ban_geoplateforme",
                    "query": "1 chemin introuvable 33000 Bordeaux",
                    "accepted": False,
                    "attempted_at": "2026-07-07T10:00:00Z",
                    "rejection_reason": "no_result",
                }
            },
        }
    )

    monkeypatch.setattr("src.geocode._utc_now", lambda: datetime(2026, 7, 8, tzinfo=UTC))
    monkeypatch.setattr(
        "src.geocode.geocode_address",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("BAN should not be called")),
    )

    result = geocode_sale(sale)

    assert result.latitude is None
    assert result.longitude is None


def test_geocode_sale_records_no_result_negative_cache(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/no-result.html",
            "address": "1 chemin introuvable",
            "postal_code": "33000",
            "department": "33",
            "city": "Bordeaux",
        }
    )

    monkeypatch.setattr("src.geocode._utc_now", lambda: datetime(2026, 7, 7, 10, tzinfo=UTC))
    monkeypatch.setattr("src.geocode.geocode_address", lambda **kwargs: None)

    result = geocode_sale(sale)

    assert result.raw_payload["geocode"] == {
        "provider": "ban_geoplateforme",
        "query": "1 chemin introuvable 33000 Bordeaux",
        "accepted": False,
        "attempted_at": "2026-07-07T10:00:00Z",
        "rejection_reason": "no_result",
    }


def test_geocode_address_parses_ban_geoplateforme_response(monkeypatch) -> None:
    calls = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "features": [
                    {
                        "properties": {
                            "score": 0.88,
                            "label": "10 Rue Sainte-Catherine 33000 Bordeaux",
                            "type": "housenumber",
                            "city": "Bordeaux",
                            "citycode": "33063",
                            "postcode": "33000",
                        },
                        "geometry": {"coordinates": [-0.573, 44.839]},
                    }
                ]
            }

    def fake_get(url, params, timeout):
        calls.append((url, params, timeout))
        return FakeResponse()

    monkeypatch.setattr("src.geocode.httpx.get", fake_get)

    result = geocode_address(
        "10 Rue Sainte-Catherine 33000 Bordeaux",
        api_url="https://data.geopf.fr/geocodage/search/",
        min_score=0.45,
        postcode="33000",
    )

    assert calls == [
        (
            "https://data.geopf.fr/geocodage/search/",
            {"q": "10 Rue Sainte-Catherine 33000 Bordeaux", "limit": 1, "postcode": "33000"},
            10,
        )
    ]
    assert result == GeocodeResult(
        latitude=Decimal("44.839"),
        longitude=Decimal("-0.573"),
        score=0.88,
        label="10 Rue Sainte-Catherine 33000 Bordeaux",
        result_type="housenumber",
        city="Bordeaux",
        citycode="33063",
        postcode="33000",
    )
