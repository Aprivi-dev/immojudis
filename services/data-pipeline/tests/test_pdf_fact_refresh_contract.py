from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src.asset_normalization import normalize_asset_features
from src.normalize import normalize_sale
from src.pdf_enrichment import _invalidate_replaced_document_facts, enrich_sale_from_pdf_text

SOURCE_URL = "https://example.test/pdf-fact-refresh"
DOCUMENT_URL = "https://example.test/current-pv.pdf"
INITIAL = "Appartement de 50 m², 2 pièces, 1 chambre. Le bien est libre de toute occupation."
COMPETING = (
    "Lot 1 : appartement de 50 m², 2 pièces, 1 chambre. "
    "Lot 2 : appartement de 70 m², 3 pièces, 2 chambres."
)


def _sale():
    return normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": SOURCE_URL,
            "property_type": "Appartement",
            "documents": [{"url": DOCUMENT_URL, "label": "PV descriptif"}],
        }
    )


def _document(text, *, complete=True):
    return {
        "url": DOCUMENT_URL,
        "label": "PV descriptif",
        "document_type": "pv_huissier",
        "text": text,
        "complete": complete,
        "sha256": "a" * 64,
        "pages": [{"page": 1, "text": text, "method": "pymupdf_text", "confidence": 0.9}],
    }


def _replace(sale):
    sale.raw_payload["document_analysis"] = {
        "profiles": [{"url": DOCUMENT_URL, "sha256": "a" * 64}]
    }
    _invalidate_replaced_document_facts(sale, [{"url": DOCUMENT_URL, "sha256": "b" * 64}])


def test_new_multilot_scope_removes_previous_pdf_only_scalars():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    assert (sale.surface_m2, sale.rooms_count, sale.bedrooms_count) == (Decimal("50"), 2, 1)

    enrich_sale_from_pdf_text(sale, [_document(COMPETING)])

    assert sale.surface_m2 is None
    assert sale.rooms_count is None
    assert sale.bedrooms_count is None
    assert sale.raw_payload["pdf_multi_lot_guard"]["status"] == "ambiguous"


def test_pdf_projection_trace_retains_real_page_provenance():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])

    trace = sale.raw_payload["pdf_fact_provenance"]["rooms_count"]

    assert trace["document_url"] == DOCUMENT_URL
    assert trace["page_number"] == 1
    assert "2 pièces" in trace["evidence"]


def test_new_partial_multilot_scope_clears_only_challenged_pdf_fields():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    assert sale.occupancy_status == "vacant"

    enrich_sale_from_pdf_text(sale, [_document(COMPETING, complete=False)])

    assert sale.surface_m2 is None
    assert sale.rooms_count is None
    assert sale.bedrooms_count is None
    assert sale.occupancy_status == "vacant"


def test_explicit_sale_total_is_not_the_last_units_room_count():
    sale = _sale()
    sale.quality_flags.append("multi_lot_sale")
    text = (
        "Lots 1 et 2 vendus ensemble. Lot 1 : 50 m², 2 pièces, 1 chambre. "
        "Lot 2 : 70 m², 3 pièces, 2 chambres. Surface totale : 120 m², 5 pièces au total."
    )

    enrich_sale_from_pdf_text(sale, [_document(text)])

    assert sale.surface_m2 == Decimal("120")
    assert sale.rooms_count == 5


def test_replaced_bytes_remove_rooms_bedrooms_and_occupancy_from_old_pdf():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])

    _replace(sale)

    assert sale.surface_m2 is None
    assert sale.rooms_count is None
    assert sale.bedrooms_count is None
    assert sale.occupancy_status is None


def test_replaced_bytes_preserve_independent_canonical_corrections():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    sale.surface_m2 = Decimal("99")
    sale.rooms_count = 9
    sale.bedrooms_count = 4
    sale.occupancy_status = "rented"

    _replace(sale)

    assert sale.surface_m2 == Decimal("99")
    assert sale.rooms_count == 9
    assert sale.bedrooms_count == 4
    assert sale.occupancy_status == "rented"


def test_multilot_scope_removes_the_displayed_surface_derived_after_pdf_extraction():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    normalize_asset_features(sale)
    assert sale.app_surface_m2 == Decimal("50")

    enrich_sale_from_pdf_text(sale, [_document(COMPETING)])

    assert sale.surface_m2 is None
    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None


def test_replaced_bytes_remove_the_displayed_surface_derived_from_the_old_pdf():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    normalize_asset_features(sale)

    _replace(sale)

    assert sale.surface_m2 is None
    assert sale.app_surface_m2 is None


def test_replaced_bytes_preserve_a_different_displayed_surface():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    normalize_asset_features(sale)
    sale.app_surface_m2 = Decimal("99")
    sale.app_surface_kind = "habitable"

    _replace(sale)

    assert sale.surface_m2 is None
    assert sale.app_surface_m2 == Decimal("99")
    assert sale.app_surface_kind == "habitable"


def test_replaced_pdf_date_is_invalidated_after_postgres_utc_roundtrip():
    sale = _sale()
    text = "La vente aux enchères aura lieu le 22 octobre 2026 à 14h30."
    enrich_sale_from_pdf_text(sale, [_document(text)])
    assert isinstance(sale.sale_date, datetime)
    sale.sale_date = sale.sale_date.astimezone(UTC)

    _replace(sale)

    assert sale.sale_date is None


def test_replaced_pdf_visit_dates_are_invalidated():
    sale = _sale()
    enrich_sale_from_pdf_text(
        sale,
        [_document("Visite sur place le mardi 26 mai 2026 de 10h à 12h.")],
    )
    assert sale.visit_dates

    _replace(sale)

    assert sale.visit_dates == []
    assert "pdf_visit_dates_extraction" not in sale.raw_payload


def test_replaced_pdf_date_restores_a_canonical_date_from_french_source_text():
    sale = _sale()
    enrich_sale_from_pdf_text(
        sale, [_document("La vente aux enchères aura lieu le 22 octobre 2026 à 14h30.")]
    )
    sale.raw_payload["source_factual_snapshot"] = {
        "source_name": "info_encheres",
        "source_url": SOURCE_URL,
        "sale_date": "25 novembre 2026 à 15h00",
    }

    _replace(sale)

    assert isinstance(sale.sale_date, datetime)
    assert (sale.sale_date.month, sale.sale_date.day) == (11, 25)


def test_removed_document_in_complete_source_manifest_clears_old_pdf_facts():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    normalize_asset_features(sale)
    sale.raw_payload["document_analysis"] = {"profiles": [{"url": DOCUMENT_URL, "sha256": "a" * 64}]}
    sale.raw_payload["source_detail_status"] = "complete"
    sale.documents = []

    _invalidate_replaced_document_facts(sale, [])

    assert sale.rooms_count is None
    assert sale.occupancy_status is None
    assert sale.app_surface_m2 is None
    assert not sale.raw_text
    assert "pdf_fact_provenance" not in sale.raw_payload


@pytest.mark.parametrize("detail_status", [None, "partial", "restricted", "failed"])
def test_missing_document_without_complete_source_manifest_keeps_pdf_facts(detail_status):
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    sale.raw_payload["document_analysis"] = {"profiles": [{"url": DOCUMENT_URL, "sha256": "a" * 64}]}
    sale.raw_payload["source_detail_status"] = detail_status
    sale.documents = []

    _invalidate_replaced_document_facts(sale, [])

    assert sale.surface_m2 == Decimal("50")
    assert sale.rooms_count == 2
    assert sale.occupancy_status == "vacant"


def test_failed_download_does_not_remove_a_still_declared_document():
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    sale.raw_payload["document_analysis"] = {"profiles": [{"url": DOCUMENT_URL, "sha256": "a" * 64}]}
    sale.raw_payload["source_detail_status"] = "complete"

    _invalidate_replaced_document_facts(sale, [])

    assert sale.rooms_count == 2
    assert sale.surface_m2 == Decimal("50")


@pytest.mark.parametrize("source_text", [None, "", "Texte actuel de la source"])
def test_replaced_document_discards_old_pdf_text_with_an_empty_or_new_source(source_text):
    sale = _sale()
    enrich_sale_from_pdf_text(sale, [_document(INITIAL)])
    sale.raw_payload["source_factual_snapshot"] = {
        "source_name": "info_encheres", "source_url": SOURCE_URL, "raw_text": source_text,
    }

    _replace(sale)

    assert (sale.raw_text or "") == (source_text or "")
    assert INITIAL not in (sale.raw_text or "")
