from decimal import Decimal
from pathlib import Path

from src.normalize import normalize_sale
from src.pdf_enrichment import (
    _adaptive_docling_timeout,
    _read_document_text_cache,
    _select_documents_for_extraction,
    _store_document_analysis_status,
    _verify_tls,
    _write_document_text_cache,
    classify_document_type,
    download_documents,
    enrich_sale_from_pdf_text,
    extract_pdf_document,
)


def test_classify_document_type_prioritizes_known_pdf_labels() -> None:
    assert classify_document_type("PV descriptif anonyme.pdf") == "pv_huissier"
    assert classify_document_type("Cahier des conditions de vente.pdf") == "cahier_conditions_vente"
    assert classify_document_type("Diagnostics techniques DPE.pdf") == "diagnostics_techniques"
    assert classify_document_type("Avis simplifié.pdf") == "annonce_vente"
    assert classify_document_type("PV de notaire.pdf") == "pv_notaire"


def test_verify_tls_only_skips_broken_cessions_etat_chain() -> None:
    assert _verify_tls("https://cessions.immobilier-etat.gouv.fr/sites/default/files/doc.pdf") is False
    assert _verify_tls("https://avoventes.fr/doc.pdf") is True


def test_enrich_sale_from_pdf_text_extracts_fields() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf",
            "property_type": "other",
        }
    )
    text = """
    Désignation : Une maison comprenant séjour et chambres.
    Surface habitable : 87,5 m².
    Nombre de pièces principales : 4.
    Le bien comprend 3 chambres.
    Le bien est occupé par un locataire selon bail.
    Diagnostic de performance énergétique, amiante, plomb et servitude.
    """

    enrich_sale_from_pdf_text(sale, [text])

    assert sale.surface_m2 == Decimal("87.5")
    assert sale.habitable_surface_m2 == Decimal("87.5")
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3
    assert sale.occupancy_status == "rented"
    assert sale.property_type == "house"
    assert "amiante" in (sale.risk_notes or "")
    assert "PDF TEXT ENRICHMENT" in (sale.raw_text or "")


def test_enrich_sale_from_pdf_text_extracts_rooms_and_carrez_surface() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-rooms",
            "property_type": "Appartement",
        }
    )
    text = """
    Le diagnostic affiche 210 kWhEP/m2/an.
    La superficie Carrez du lot est de 39,82m2.
    Appartement de 3 pièces 2 chambres.
    """

    enrich_sale_from_pdf_text(sale, [text])

    assert sale.surface_m2 == Decimal("39.82")
    assert sale.rooms_count == 3
    assert sale.bedrooms_count == 2


def test_enrich_sale_from_pdf_text_maps_studio_to_one_room() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-studio",
        }
    )

    enrich_sale_from_pdf_text(sale, ["Désignation : studio libre d'occupation."])

    assert sale.rooms_count == 1


def test_enrich_sale_from_pdf_text_replaces_stale_pdf_context() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-stale-context",
            "raw_text": "Annonce initiale --- PDF TEXT ENRICHMENT --- ancien OCR",
        }
    )

    enrich_sale_from_pdf_text(sale, ["Surface habitable : 31 m²."])

    assert "ancien OCR" not in (sale.raw_text or "")
    assert "Surface habitable" in (sale.raw_text or "")


def test_select_documents_for_extraction_prioritizes_useful_documents(monkeypatch) -> None:
    monkeypatch.setenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")
    documents = [
        {"label": "Autre.pdf", "document_type": "pdf"},
        {"label": "Diagnostics.pdf", "document_type": "diagnostics_techniques"},
        {"label": "PV descriptif.pdf", "document_type": "pv_huissier"},
        {"label": "Cahier.pdf", "document_type": "cahier_conditions_vente"},
    ]

    selected = _select_documents_for_extraction(documents)

    assert [item["document_type"] for item in selected] == ["pv_huissier", "diagnostics_techniques"]


def test_enrich_sale_from_pdf_text_does_not_sum_repeated_document_surfaces() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pdf-repeated-surface",
            "property_type": "Appartement",
        }
    )
    pdf_texts = [
        {
            "label": "PV descriptif",
            "document_type": "pv_huissier",
            "text": "Désignation : appartement. Surface habitable : 42 m².",
        },
        {
            "label": "Diagnostics",
            "document_type": "diagnostics_techniques",
            "text": "Rapport diagnostic. Surface habitable : 42 m².",
        },
    ]

    enrich_sale_from_pdf_text(sale, pdf_texts)

    assert sale.surface_m2 == Decimal("42")
    assert sale.surface_m2 != Decimal("84")
    assert sale.surface_evidence and "Diagnostics" in sale.surface_evidence


def test_extract_pdf_document_preserves_page_level_text(tmp_path, monkeypatch) -> None:
    import fitz

    monkeypatch.setenv("PDF_EXTRACTOR", "pymupdf")
    monkeypatch.setenv("PDF_OCR_ENABLED", "false")
    path = tmp_path / "two-pages.pdf"
    with fitz.open() as document:
        page_1 = document.new_page()
        page_1.insert_text((72, 72), "Surface habitable : 50 m2")
        page_2 = document.new_page()
        page_2.insert_text((72, 72), "Occupation : bail en cours")
        document.save(path)

    payload = extract_pdf_document(path, document={"label": "PV", "document_type": "pv_huissier"})

    assert payload["cache_version"] == "pdf_text_v2_page_level"
    assert payload["page_count"] == 2
    assert [page["page"] for page in payload["pages"]] == [1, 2]
    assert "Surface habitable" in payload["text"]
    assert "bail en cours" in payload["text"]


def test_download_documents_skips_robots_disallowed_licitor_documents(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/10/87/62/example/108762.html",
            "documents": [
                {
                    "label": "PV descriptif",
                    "url": "https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.001.pdf",
                    "type": "pdf",
                }
            ],
        }
    )

    def fail_get(*args, **kwargs):
        raise AssertionError("robots-disallowed Licitor PDFs must not be downloaded")

    monkeypatch.setattr("src.pdf_enrichment.httpx.get", fail_get)

    assert download_documents(sale, output_root=tmp_path) == []


def test_adaptive_docling_timeout_shortens_signed_documents(tmp_path, monkeypatch) -> None:
    file_path = tmp_path / "ccv-sign.pdf"
    file_path.write_bytes(b"%PDF-1.4\n%%EOF")
    settings = {
        "pdf_docling_timeout_seconds": 180,
        "pdf_docling_fast_timeout_seconds": 45,
        "pdf_docling_threshold_chars": 1200,
    }

    timeout = _adaptive_docling_timeout(
        file_path,
        {"label": "CCV sign.pdf", "url": "https://example.test/CCV-sign.pdf", "document_type": "cahier_conditions_vente"},
        settings,
    )

    assert timeout == 45


def test_document_text_cache_roundtrip(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "cache"
    monkeypatch.setattr("src.pdf_enrichment.PDF_DOCUMENT_TEXTS_DIR", cache_dir)
    file_path = tmp_path / "pv.pdf"
    file_path.write_bytes(b"pdf bytes")
    document = {"url": "https://example.test/pv.pdf", "label": "PV", "document_type": "pv_huissier"}
    payload = {"label": "PV", "url": document["url"], "type": "pdf", "document_type": "pv_huissier", "file_path": str(file_path), "text": "Surface 80 m2"}

    _write_document_text_cache(document, file_path, payload)

    assert _read_document_text_cache(document, file_path)["text"] == "Surface 80 m2"


def test_store_document_analysis_status_marks_partial_document_coverage() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/doc-coverage",
            "documents": [
                {"label": "PV descriptif", "url": "https://example.test/pv.pdf"},
                {"label": "Cahier des conditions", "url": "https://example.test/ccv.pdf"},
            ],
        }
    )
    documents = [
        {"label": "PV descriptif", "url": "https://example.test/pv.pdf", "document_type": "pv_huissier"},
        {
            "label": "Cahier des conditions",
            "url": "https://example.test/ccv.pdf",
            "document_type": "cahier_conditions_vente",
        },
    ]
    pdf_texts = [
        {
            "label": "PV descriptif",
            "url": "https://example.test/pv.pdf",
            "document_type": "pv_huissier",
            "text": "Surface habitable : 40 m2.",
            "text_chars": 28,
            "page_count": 1,
            "confidence": 0.9,
            "extraction_method": "pymupdf_pages",
        }
    ]

    _store_document_analysis_status(sale, documents, pdf_texts)

    analysis = sale.raw_payload["document_analysis"]
    assert analysis["coverage_status"] == "partial"
    assert "diagnostics" in analysis["missing_core_documents"]
    assert analysis["official_documents_found"] is True
    assert analysis["profiles"][0]["family"] == "constat_et_description"
