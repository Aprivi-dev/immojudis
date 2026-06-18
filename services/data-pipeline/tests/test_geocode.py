from decimal import Decimal

from src.geocode import geocode_sale
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
        return Decimal("43.308358"), Decimal("-0.37106")

    monkeypatch.setattr("src.geocode.geocode_address", fake_geocode_address)

    result = geocode_sale(sale)

    assert result.latitude == Decimal("43.308358")
    assert result.longitude == Decimal("-0.37106")
    assert "implausible_coordinates" in result.quality_flags
