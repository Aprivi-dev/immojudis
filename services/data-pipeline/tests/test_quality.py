from decimal import Decimal

from src.normalize import normalize_sale
from src.quality import build_quality_report


def test_build_quality_report_computes_percentages() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/quality",
            "tribunal": "TJ Bordeaux",
            "surface_m2": "80 m2",
            "rooms_count": 3,
            "bedrooms_count": 2,
            "visit_dates": ["Visite le 1 janvier"],
            "documents": [{"label": "Affiche", "url": "https://example.test/doc.pdf", "type": "pdf"}],
        }
    )
    sale.latitude = Decimal("44.84")
    sale.longitude = Decimal("-0.57")

    report = build_quality_report([sale])

    assert report["with_tribunal_pct"] == 100.0
    assert report["with_gps_pct"] == 100.0
    assert report["with_surface_pct"] == 100.0
    assert report["with_app_surface_pct"] == 0.0
    assert report["with_rooms_count_pct"] == 100.0
    assert report["with_bedrooms_count_pct"] == 100.0
    assert report["with_occupancy_status_pct"] == 0.0
    assert report["with_raw_text_enriched_pct"] == 0.0
    assert report["with_documents_pct"] == 100.0
    assert report["with_visit_dates_pct"] == 100.0
