from decimal import Decimal

from src.models import AuctionSale
from src.storage.supabase_client import _read_model_row_for_sale, _sanitize_postgrest_payload


def test_sanitize_postgrest_payload_removes_null_characters_recursively() -> None:
    payload = {
        "result": [
            {
                "text": "surface\x00 habitable",
                "pages": [{"text": "page\x00 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
    }

    assert _sanitize_postgrest_payload(payload) == {
        "result": [
            {
                "text": "surface habitable",
                "pages": [{"text": "page 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
    }


def test_read_model_row_tolerates_partial_payloads() -> None:
    sale = AuctionSale(
        source_name="test",
        source_url="https://example.test/sale",
        title="Vente test",
        city="Paris",
        raw_payload={
            "asset_normalization": "unexpected",
            "investment_analysis": {"deal_memo": {"headline": "À confirmer"}},
        },
        score_factors=[{"label": "Prix", "delta": 8}],
        documents=[{"url": "https://example.test/doc.pdf", "label": "PV descriptif"}],
        starting_price_eur=Decimal("120000"),
        score_confidence=Decimal("0.64"),
    )

    row = _read_model_row_for_sale(sale, "2026-06-01T10:30:00Z")

    assert row["source_url"] == "https://example.test/sale"
    assert row["deal_memo"] == {"headline": "À confirmer"}
    assert row["risks"] == []
    assert row["score_factors"] == [{"label": "Prix", "delta": 8}]
    assert row["documents_rich"][0]["document_type"] == "pv_huissier"
