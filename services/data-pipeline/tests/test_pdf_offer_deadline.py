"""Offer deadlines read from conditions of sale feed calls for offers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from src.models import AuctionSale
from src.pdf_enrichment import enrich_sale_from_pdf_text
from src.pdf_offer_deadline import (
    extract_offer_deadline_from_documents,
    offer_deadline_candidates,
    offer_deadline_may_feed_sale_date,
)

FUTURE_YEAR = datetime.now(UTC).year + 1


def _document(
    text: str, label: str = "Cahier des charges", url: str = "https://example.test/ccv.pdf"
) -> dict[str, object]:
    return {
        "label": label,
        "url": url,
        "text": text,
        "pages": [{"page": 3, "text": text}],
        "complete": True,
        "extraction_status": "extracted",
    }


def test_deadline_phrases_are_recognized() -> None:
    texts = [
        f"La date limite de remise des offres est fixée au 15 novembre {FUTURE_YEAR} à 12h00.",
        f"Date limite de dépôt des offres : 3 décembre {FUTURE_YEAR} 16 h",
        f"Les offres devront parvenir au plus tard le 1er février {FUTURE_YEAR} à 11h.",
        f"Date limite des offres : 07/01/{FUTURE_YEAR} à 14h30",
    ]
    for text in texts:
        candidates = offer_deadline_candidates(text)
        assert candidates, text
        assert candidates[0]["value"].year == FUTURE_YEAR


def test_unrelated_dates_are_ignored() -> None:
    assert offer_deadline_candidates(f"Audience d'adjudication le 15 novembre {FUTURE_YEAR}.") == []
    assert offer_deadline_candidates("Les offres devront être remises en main propre.") == []


def test_document_ranking_and_ambiguity() -> None:
    ccv = _document(f"Date limite de remise des offres : 15 novembre {FUTURE_YEAR} à 12h.")
    other = _document(f"Date limite de remise des offres : 20 novembre {FUTURE_YEAR}.", label="Plan", url="https://example.test/plan.pdf")
    selected = extract_offer_deadline_from_documents([other, ccv])

    assert selected is not None
    assert selected["document_type"] == "cahier_conditions_vente"
    assert selected["page_number"] == 3
    assert selected["ambiguous"] is False

    conflicting = _document(f"Date limite de remise des offres : 18 novembre {FUTURE_YEAR}.")
    assert extract_offer_deadline_from_documents([ccv, conflicting])["ambiguous"] is True


def test_only_unambiguous_upcoming_deadlines_may_feed_sale_date() -> None:
    now = datetime(2026, 10, 11, tzinfo=UTC)
    assert offer_deadline_may_feed_sale_date({"value": now + timedelta(days=30)}, now=now)
    assert not offer_deadline_may_feed_sale_date({"value": now - timedelta(days=3)}, now=now)
    assert not offer_deadline_may_feed_sale_date({"value": now + timedelta(days=30), "ambiguous": True}, now=now)


def test_call_for_offers_gets_its_deadline_as_sale_date() -> None:
    sale = AuctionSale(
        source_name="cessions_etat",
        source_url="https://example.test/cession",
        starting_price_eur=Decimal("90000"),
        status="upcoming",
    )
    document = _document(
        f"Consultation. La date limite de remise des offres est fixée au 15 novembre {FUTURE_YEAR} à 12h00. "
        "Le bien est libre de toute occupation."
    )

    enrich_sale_from_pdf_text(sale, [document])

    assert sale.sale_date is not None and sale.sale_date.year == FUTURE_YEAR
    assert sale.sale_date.month == 11 and sale.sale_date.day == 15
    assert sale.raw_payload["pdf_offer_deadline_extraction"]["document_type"] == "cahier_conditions_vente"
    assert sale.raw_payload["pdf_sale_date_extraction"]["sale_date_kind"] == "offer_deadline"


def test_known_sale_date_is_never_replaced_by_an_offer_deadline() -> None:
    known = datetime(FUTURE_YEAR, 12, 1, 9, tzinfo=UTC)
    sale = AuctionSale(
        source_name="cessions_etat",
        source_url="https://example.test/cession-known",
        starting_price_eur=Decimal("90000"),
        sale_date=known,
    )

    enrich_sale_from_pdf_text(sale, [_document(f"Date limite de remise des offres : 15 novembre {FUTURE_YEAR}.")])

    assert sale.sale_date == known
    assert "pdf_offer_deadline_extraction" in sale.raw_payload
