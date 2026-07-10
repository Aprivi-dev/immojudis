from decimal import Decimal

from src.asset_normalization import normalize_asset_features
from src.recompute_scoring import _sale_from_storage_row


def test_storage_recompute_preserves_editorial_text_for_surface_reconciliation() -> None:
    row = {
        "id": "725939b3-f8f1-4c84-b8c4-32be90143291",
        "source_name": "encheres_publiques",
        "source_url": "https://example.test/130432",
        "property_type": "house",
        "title": "Maison 1 877 m²",
        "description": "Description d'affichage stockée",
        "surface_m2": 1877,
        "habitable_surface_m2": 1877,
        "app_surface_m2": 1877,
        "raw_payload": {
            "title": "Un ensemble immobilier de 187 m² situé rue Gâte-Bourse",
            "description": (
                "Un ensemble immobilier de 10 pièces de 187 m² avec un garage de 18 m², "
                "édifié sur une parcelle de 1 110 m²."
            ),
            "surface_m2": 1877,
            "habitable_surface_m2": 1877,
        },
    }

    sale = _sale_from_storage_row(row)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("187")
    assert sale.habitable_surface_m2 == Decimal("187")
    assert sale.land_surface_m2 == Decimal("1110")
    assert sale.app_surface_m2 == Decimal("187")
    assert sale.raw_payload["surface_reconciliation"]["rejected_surface_m2"] == "1877"
