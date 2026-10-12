"""Occupancy read from the PDF documents (situations seen on production sales)."""

import src.pdf_enrichment  # noqa: F401  (loads pdf_fact_extraction without a circular import)
from src.normalize import normalize_sale
from src.pdf_fact_extraction import enrich_sale_from_pdf_text
from src.pdf_fact_scope import _pdf_lot_scope_labels


def _sale(url: str):
    return normalize_sale({"source_name": "licitor", "source_url": url, "property_type": "Maison"})


def _doc(document_type: str, text: str, page: int = 1) -> dict[str, object]:
    return {
        "label": document_type,
        "url": f"https://example.test/{document_type}.pdf",
        "document_type": document_type,
        "text": text,
        "pages": [{"page": page, "text": text, "confidence": 0.9, "method": "pymupdf_text"}],
    }


CCV_BOILERPLATE = (
    "Si la même vente comprend plusieurs lots vendus séparément, chaque lot sera adjugé. "
    "La preuve de l'antériorité du bail incombe au locataire. "
    "Article 20 – Entrée en jouissance. Si l'immeuble est loué, l'adjudicataire percevra les loyers. "
    "Les surfaces occupées par les murs ne sont pas comprises."
)


def test_on_site_report_wins_over_standard_clauses() -> None:
    sale = _sale("https://example.test/saint-quentin")
    pdf_texts = [
        _doc("cahier_conditions_vente", CCV_BOILERPLATE),
        _doc("pv_huissier", "Conditions d'occupation : les lieux sont libres de toute occupation."),
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.occupancy_status == "vacant"
    assert "pdf_multi_lot_guard" not in sale.raw_payload
    provenance = sale.raw_payload["pdf_fact_provenance"]["occupancy_status"]
    assert "libres de toute occupation" in provenance["evidence"]


def test_resident_statement_is_read_as_occupied() -> None:
    sale = _sale("https://example.test/villepinte")
    pdf_texts = [_doc("pv_huissier", "Elle m'indique vivre dans les lieux avec son mari et leurs trois enfants.")]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.occupancy_status == "occupied"


def test_agreeing_statements_survive_co_ownership_lot_numbers() -> None:
    sale = _sale("https://example.test/copro")
    pdf_texts = [
        _doc("annonce_vente", "Lot 12 : un appartement. Lot 45 : une cave. Maison occupée."),
        _doc("pv_huissier", "Les lieux sont occupés par le débiteur."),
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.occupancy_status == "occupied"


def test_diagnostic_wording_is_not_an_occupancy_statement() -> None:
    sale = _sale("https://example.test/diagnostic")
    pdf_texts = [_doc("diagnostics_techniques", "Pièces non visitées : chambre occupée par du mobilier.")]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.occupancy_status is None


def test_verbs_and_elisions_are_not_unit_labels() -> None:
    text = "L'appartement n'est pas chauffé. L'appartement a été visité. Appartement à usage d'habitation."

    assert _pdf_lot_scope_labels(text) == set()
    assert _pdf_lot_scope_labels("Appartement B et appartement 3") == {"unit:b", "unit:3"}
