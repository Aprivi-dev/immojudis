"""P2-15 : une carte annulée, reportée ou retirée relance la lecture de la page de détail."""
import pytest

from src.normalize import make_sale_signature
from src.sources import common

URL = "https://example.test/auction/7"
KNOWN_UPCOMING = {URL: "2027-01-10|100000"}


def _card(**extra):
    return {"source_url": URL, "sale_date": "10 janvier 2027", "starting_price_eur": 100000, **extra}


def test_card_turning_cancelled_triggers_a_detail_read():
    card = _card(status="Annulée")

    assert common.should_fetch_detail(card, KNOWN_UPCOMING) is True
    assert "_known_unchanged" not in card


@pytest.mark.parametrize(
    ("label", "status"),
    [
        ("Annulée", "cancelled"),
        ("annulée", "cancelled"),
        ("Vente annulée", "cancelled"),
        ("Reportée", "postponed"),
        ("Vente reportée", "postponed"),
        ("Retirée", "withdrawn"),
        ("Bien retiré de la vente", "withdrawn"),
    ],
)
def test_signature_carries_the_badge_of_the_card(label, status):
    key_variants = [{"status": label}, {"statut": label}, {"badge": label}]

    for extra in key_variants:
        assert common.listing_signature(_card(**extra)) == f"2027-01-10|100000|{status}"


def test_badge_found_in_the_card_text_is_taken_into_account():
    card = _card(raw_text="10 JANV Maison à Bordeaux (33) Vente annulée Mise à prix : 100 000 €")

    assert common.listing_signature(card) == "2027-01-10|100000|cancelled"
    assert common.should_fetch_detail(card, KNOWN_UPCOMING) is True


def test_unchanged_upcoming_card_still_skips_the_detail_page():
    for extra in ({}, {"status": "upcoming"}, {"status": "À venir"}, {"badge": "Nouveau"}):
        card = _card(**extra)

        assert common.listing_signature(card) == "2027-01-10|100000"
        assert common.should_fetch_detail(card, KNOWN_UPCOMING) is False
        assert card["_known_unchanged"] is True


def test_long_text_mentioning_a_cancellation_is_not_a_badge():
    card = _card(status="Avertissement : " + "texte " * 20 + "une visite annulée peut être reportée")

    assert common.listing_signature(card) == "2027-01-10|100000"


def test_card_still_cancelled_does_not_force_a_new_read_every_run():
    known = {URL: make_sale_signature("2027-01-10", 100000, "cancelled")}
    card = _card(status="Annulée")

    assert common.should_fetch_detail(card, known) is False


def test_card_back_to_upcoming_after_a_cancellation_is_read_again():
    known = {URL: make_sale_signature("2027-01-10", 100000, "cancelled")}

    assert common.should_fetch_detail(_card(), known) is True


def test_make_sale_signature_only_adds_interrupting_statuses():
    assert make_sale_signature("2027-01-10", 100000) == "2027-01-10|100000"
    for status in (None, "", "upcoming", "past", "adjudicated", "unknown"):
        assert make_sale_signature("2027-01-10", 100000, status) == "2027-01-10|100000"
    for status in ("cancelled", "postponed", "withdrawn", "Annulée", "reportée", "retirée"):
        assert make_sale_signature("2027-01-10", 100000, status).count("|") == 2
