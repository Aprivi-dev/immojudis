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
