from src.models import AuctionSale
from src.urban_planning import build_urban_planning_signal_rows


def test_urban_planning_signals_extract_pdf_permit_and_servitude() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        documents=[
            {
                "url": "/cahier.pdf",
                "label": "Cahier des conditions",
                "document_type": "cahier_conditions_vente",
            }
        ],
    )

    rows = build_urban_planning_signal_rows(
        sale,
        pdf_texts=[
            {
                "url": "/cahier.pdf",
                "label": "Cahier des conditions",
                "document_type": "cahier_conditions_vente",
                "pages": [
                    {
                        "page": 8,
                        "text": "Le bien est grevé d'une servitude de passage. Un permis de construire est mentionné.",
                        "confidence": 0.86,
                    }
                ],
            }
        ],
    )

    kinds = {row["signal_kind"] for row in rows}
    assert {"servitude", "permit"}.issubset(kinds)
    servitude = next(row for row in rows if row["signal_kind"] == "servitude")
    assert servitude["status"] == "documented"
    assert servitude["priority"] == "high"
    assert servitude["document_url"] == "/cahier.pdf"
    assert servitude["page_number"] == 8
    assert servitude["confidence"] == 0.86
    assert servitude["signal_key"].startswith("servitude_")


def test_urban_planning_signals_use_source_payload_as_to_verify_fallback() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://example.test/vente-2",
        raw_payload={
            "source_blocks": {
                "urbanisme": "Zone urbaine constructible avec droit de préemption à confirmer."
            }
        },
    )

    rows = build_urban_planning_signal_rows(sale)
    zoning = next(row for row in rows if row["signal_kind"] == "zoning")

    assert zoning["status"] == "to_verify"
    assert zoning["source_kind"] == "source_payload"
    assert zoning["source_name"] == "Données source"
    assert zoning["signal_key"] == build_urban_planning_signal_rows(sale)[0]["signal_key"]
