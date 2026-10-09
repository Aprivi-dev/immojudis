"""P2-11 : une mise à prix de lot ne remplace pas la valeur explicite d'une vente multi-lots."""
from decimal import Decimal

from src.normalize import extract_starting_price, normalize_sale, resolve_starting_price


def _raw(**extra):
    return {"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/multi-lots", **extra}


def test_explicit_price_wins_over_a_price_attached_to_another_lot():
    raw = _raw(starting_price_eur=60000, raw_text="Mise à prix : 6 000 € (lot 2)")

    assert resolve_starting_price(raw) == (Decimal("60000"), True)
    assert extract_starting_price(raw) == Decimal("60000")


def test_lot_label_before_the_price_also_scopes_it():
    raw = _raw(starting_price_eur=60000, raw_text="Lot n° 2 - Mise à prix : 6 000 €")

    assert resolve_starting_price(raw) == (Decimal("60000"), True)


def test_multi_lot_sale_never_lets_the_text_override_the_explicit_price():
    raw = _raw(
        starting_price_eur=60000,
        raw_text="Mise à prix : 6 000 €",
        quality_flags=["multi_lot_sale"],
    )

    assert resolve_starting_price(raw) == (Decimal("60000"), True)


def test_text_still_corrects_an_extra_zero_when_it_names_no_lot():
    raw = _raw(starting_price_eur=60000, raw_text="Mise à prix : 6 000 €")

    assert resolve_starting_price(raw) == (Decimal("6000"), False)


def test_matching_prices_are_not_a_conflict():
    raw = _raw(starting_price_eur=6000, raw_text="Mise à prix : 6 000 € (lot 2)")

    assert resolve_starting_price(raw) == (Decimal("6000"), False)


def test_conflict_is_recorded_on_the_sale_for_the_quality_review():
    sale = normalize_sale(_raw(starting_price_eur=60000, raw_text="Mise à prix : 6 000 € (lot 2)"))

    assert sale.starting_price_eur == Decimal("60000")
    assert sale.raw_payload["price_conflict"] is True
    assert "price_conflict" in sale.quality_flags


def test_sale_without_conflict_carries_no_flag():
    sale = normalize_sale(_raw(starting_price_eur=60000, raw_text="Mise à prix : 60 000 €"))

    assert "price_conflict" not in sale.quality_flags
    assert "price_conflict" not in sale.raw_payload
