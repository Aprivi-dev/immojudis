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


def test_storage_recompute_restores_partial_pdf_surface_scope() -> None:
    row = {
        "id": "35f44afc-36ff-4c0b-93c0-4288334989a2",
        "source_name": "info_encheres",
        "source_url": "https://www.info-encheres.com/vente-6009.html",
        "property_type": "apartment",
        "title": "Appartement 4 m²",
        "surface_m2": 3.78,
        "carrez_surface_m2": 3.78,
        "app_surface_m2": 3.78,
        "app_surface_kind": "carrez",
        "surface_scope": "total",
        "surface_source": "pdf",
        "surface_confidence": 0.45,
        "raw_payload": {
            "surface_extraction": {
                "source": "pdf",
                "value_m2": "3.78",
                "surface_scope": "partial",
            }
        },
    }

    sale = _sale_from_storage_row(row)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("3.78")
    assert sale.carrez_surface_m2 == Decimal("3.78")
    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert sale.surface_scope == "partial"
    assert sale.title == "Appartement"
