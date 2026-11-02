"""Adresse du bien lue dans les pièces jointes (src/pdf_address.py), sur des extraits réels de diagnostics."""

from src.models import AuctionSale
from src.pdf_address import (
    PDF_ADDRESS_CANDIDATES_KEY,
    PDF_ADDRESS_EXTRACTION_KEY,
    apply_pdf_address,
    extract_pdf_address_candidates,
)

ERP = "https://example.test/3_Diagnostic_reglementaire.pdf"
DPE = "https://example.test/4_DPE.pdf"


def _sale(**overrides) -> AuctionSale:
    values = {
        "source_name": "avoventes",
        "source_url": "https://example.test/vente-1",
        "title": "Centre équestre",
        "address": "01630 Challex, France",
        "city": "Challex",
        "postal_code": "01630",
    }
    values.update(overrides)
    return AuctionSale(**values)


def _streets(text: str) -> list[str]:
    return [str(item["street"]) for item in extract_pdf_address_candidates([text])]


def test_labelled_property_addresses_are_read_with_their_postal_code() -> None:
    assert _streets("Adresse de l'immeuble : 1368 route de la Plaine 01630 CHALLEX FDA Origine du plan") == [
        "1368 route de la Plaine"
    ]
    assert _streets(
        "Adresse de l'immeuble code postal ou Insee commune 10 Lieu-dit La Grenière 33570 LUSSAC Situation de"
    ) == ["10 Lieu-dit La Grenière"]
    assert _streets("Adresse du bien Adresse du bien 64 route de Saint Germain 78640 Neauphle-le-Château") == [
        "64 route de Saint Germain"
    ]


def test_doubtful_fields_are_never_read_as_an_address() -> None:
    # No street, an OCR break, an undisclosed address, an owner's name, a parcel number.
    assert _streets("Adresse du bien Parcelle située à ValClaret 73320 Tignes Référence(s)") == []
    assert _streets("Adresse du bien : 353 route de Tro: Garage Lot n° 1) 74200 LYAUD Cabinet") == []
    assert _streets("Adresse du bien : Lieudit Keroualh (Non communiqué) 56320 MESLAN EXPERT") == []
    assert _streets("Adresse du bien Propriétaire 10 Lieu-dit La Greniére Nom : 33570 LUSSAC") == []
    assert _streets("Adresse de l'immeuble Commune : Neauphle 64 route de Saint Germain Parcelle(s) : AD92 78640") == []
    # The address of the person who ordered the diagnostic has its own label.
    assert _streets("Donneur d'ordre Adresse : 111 Cours de Verdun 33000 BORDEAUX") == []


def test_a_sale_with_only_its_town_gets_the_street_of_its_documents() -> None:
    sale = _sale()
    apply_pdf_address(
        sale,
        [
            {"url": ERP, "text": "Adresse de l'immeuble : 1368 route de la Plaine 01630 CHALLEX FDA"},
            {"url": DPE, "text": "Adresse du bien : Lieu dit La Pièce 1368 route de la Plaine 01630 CHALLEX Type"},
        ],
    )

    # The two wordings agree: the fullest is kept, with the sale's own town.
    assert sale.address == "Lieu dit La Pièce 1368 route de la Plaine, 01630 Challex"
    assert sale.raw_payload[PDF_ADDRESS_EXTRACTION_KEY]["document_url"] == DPE
    assert sale.raw_payload[PDF_ADDRESS_EXTRACTION_KEY]["occurrences"] == 2
    assert sale.raw_payload["pdf_fact_provenance"]["address"]["source"] == "pdf"


def test_an_address_of_the_source_page_is_never_replaced() -> None:
    sale = _sale(address="12 rue Foch, 01630 Challex")
    apply_pdf_address(sale, [{"url": ERP, "text": "Adresse du bien : 1368 route de la Plaine 01630 CHALLEX"}])

    assert sale.address == "12 rue Foch, 01630 Challex"
    assert PDF_ADDRESS_EXTRACTION_KEY not in sale.raw_payload
    # The candidate is still kept for review.
    assert sale.raw_payload[PDF_ADDRESS_CANDIDATES_KEY][0]["street"] == "1368 route de la Plaine"


def test_another_town_or_two_different_streets_leave_the_address_unchanged() -> None:
    elsewhere = _sale()
    apply_pdf_address(elsewhere, [{"url": ERP, "text": "Adresse du bien : 5 rue Neuve 69001 LYON"}])
    assert elsewhere.address == "01630 Challex, France"
    assert PDF_ADDRESS_CANDIDATES_KEY not in elsewhere.raw_payload

    two_streets = _sale()
    apply_pdf_address(
        two_streets,
        [
            {"url": ERP, "text": "Adresse du bien : 1368 route de la Plaine 01630 CHALLEX"},
            {"url": DPE, "text": "Adresse du bien : 4 chemin des Vignes 01630 CHALLEX"},
        ],
    )
    assert two_streets.address == "01630 Challex, France"
    assert PDF_ADDRESS_EXTRACTION_KEY not in two_streets.raw_payload


def test_a_multi_lot_sale_keeps_its_address() -> None:
    sale = _sale(quality_flags=["multi_lot_sale"])
    apply_pdf_address(sale, [{"url": ERP, "text": "Adresse du bien : 1368 route de la Plaine 01630 CHALLEX"}])

    assert sale.address == "01630 Challex, France"
