"""Offer deadlines read from conditions of sale feed calls for offers."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from src.models import AuctionSale
from src.pdf_fact_extraction import enrich_sale_from_pdf_text
from src.pdf_offer_deadline import (
    extract_offer_deadline_from_documents,
    offer_deadline_candidates,
    offer_deadline_may_feed_sale_date,
)

FUTURE_YEAR = datetime.now(UTC).year + 1
_FRENCH_MONTHS = (
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
)


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
    # Une date passée ou à plus de 548 jours est écartée (pdf_sale_date_guard) : « 15 novembre <année suivante> »
    # sortait de la fenêtre dès le 1er janvier. La date est donc relative au jour d'exécution.
    deadline = date.today() + timedelta(days=60)
    month = _FRENCH_MONTHS[deadline.month - 1]
    document = _document(
        f"Consultation. La date limite de remise des offres est fixée au {deadline.day} {month} {deadline.year} "
        "à 12h00. Le bien est libre de toute occupation."
    )

    enrich_sale_from_pdf_text(sale, [document])

    assert sale.sale_date is not None and sale.sale_date.year == deadline.year
    assert sale.sale_date.month == deadline.month and sale.sale_date.day == deadline.day
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


def _deadlines(text: str) -> list[str]:
    return [str(item["offer_deadline"]) for item in offer_deadline_candidates(text)]


def test_state_tender_wordings_of_the_offer_deadline_are_read() -> None:
    # Real Cessions de l'État wordings left undated before 02/11/2026.
    assert _deadlines(
        "Date limite de réception des offres et de transmission des documents visés au II. ci-dessus "
        "13 novembre 2026 à midi (heure locale de Paris)"
    ) == ["2026-11-13T11:00:00+00:00"]  # « midi » est 12 h à Paris
    assert _deadlines("Date limite de réception du dossier d’offre 02/12/2026 2.5.2 – Mise en œuvre") == [
        "2026-12-02T00:00:00+00:00"
    ]
    # A table cell split by the PDF text layer.
    assert _deadlines("Date limite de réception du dossier 10/12/2026 à 16h00 d'offre Date de sélection") == [
        "2026-12-10T15:00:00+00:00"
    ]
    assert _deadlines("LA DATE LIMITE D’ENVOI DES CANDIDATURES EST FIXÉE AU : MARDI 1 ER DECEMBRE 2026 INCLUS") == [
        "2026-12-01T00:00:00+00:00"
    ]
    assert _deadlines("• Date limite de dépôt des dossiers : 19 mai 2026 à 12h00 • Début des enchères") == [
        "2026-05-19T10:00:00+00:00"
    ]


def test_other_deadlines_of_a_tender_are_not_the_offer_deadline() -> None:
    assert _deadlines("Date limite de l'envoi des questions 30 octobre 2026 à midi") == []
    assert _deadlines("Date limite pour poser des questions 03/12/2026") == []
    assert _deadlines("Date limite de réception du dossier de diagnostic technique 12/12/2026") == []
    assert _deadlines("4 – Date limite de réception des demandes d’agrément.......14 5 – Date") == []
