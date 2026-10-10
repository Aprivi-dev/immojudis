"""P2-09 : le prix d'adjudication ne doit jamais être lu dans une date ou un compteur."""
from decimal import Decimal

from src.normalize import extract_adjudication_price, normalize_sale


def test_adjudication_price_skips_the_date_following_the_word():
    assert extract_adjudication_price({"raw_text": "Bien adjugé 12/03/2025 pour 150 000 €"}) == Decimal("150000")


def test_adjudication_price_ignores_a_count_after_adjuge():
    assert extract_adjudication_price({"raw_text": "Lot adjugé 1 fois"}) is None


def test_adjudication_price_accepts_euros_spelled_out():
    assert extract_adjudication_price({"raw_text": "adjugé : 85 000 euros"}) == Decimal("85000")


def test_adjudication_price_requires_a_currency_in_every_pattern():
    for text in ("Adjugé : 85 000", "Prix d'adjudication : 85 000", "Adjudication : 85 000"):
        assert extract_adjudication_price({"raw_text": text}) is None


def test_adjudication_price_below_1000_euros_is_rejected():
    assert extract_adjudication_price({"raw_text": "Adjugé : 500 €"}) is None
    assert extract_adjudication_price({"adjudication_price_eur": 800}) is None


def test_adjudication_price_below_a_tenth_of_the_reserve_is_rejected():
    raw = {"starting_price_eur": 200000, "raw_text": "Adjugé : 15 000 €"}
    assert extract_adjudication_price(raw) is None
    assert extract_adjudication_price({**raw, "raw_text": "Adjugé : 25 000 €"}) == Decimal("25000")


def test_misread_adjudication_does_not_mark_the_sale_adjudicated():
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/lot-adjuge-une-fois",
            "sale_date": "2020-03-12",
            "raw_text": "Lot adjugé 1 fois",
        }
    )

    assert sale.adjudication_price_eur is None
    assert sale.status == "past"
