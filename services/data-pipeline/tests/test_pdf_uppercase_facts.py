"""Facts read from upper-case or OCR'd notices (real excerpts from production PDFs)."""

from decimal import Decimal

import src.pdf_enrichment  # noqa: F401  (loads pdf_fact_extraction without a circular import)
from src.normalize import parse_french_datetime
from src.pdf_starting_price import _extract_starting_price_with_evidence


def test_unaccented_upper_case_time_does_not_turn_an_address_into_the_year() -> None:
    parsed = parse_french_datetime(
        "ADJUDICATION JEUDI 10 SEPTEMBRE 2026 a 9H au Palais de Justice de GRASSE, 37, avenue Pierre Semard"
    )

    assert parsed is not None
    assert (parsed.year, parsed.month, parsed.day, parsed.hour) == (2026, 9, 10, 7)


def test_upper_case_notice_with_time_after_capital_a_is_read() -> None:
    parsed = parse_french_datetime("MISE EN VENTE AUX ENCHERES PUBLIQUES LE MERCREDI 09 SEPTEMBRE 2026 A 14H00")

    assert parsed is not None
    assert (parsed.year, parsed.month, parsed.day, parsed.hour) == (2026, 9, 9, 12)


def test_time_written_before_the_date_is_kept() -> None:
    parsed = parse_french_datetime("audience à 14h, le 11 juin 2026, tribunal de Lyon, 67 rue Servient")

    assert parsed is not None
    assert (parsed.year, parsed.month, parsed.day, parsed.hour) == (2026, 6, 11, 12)


def test_starting_price_with_comma_thousands_separator_is_not_truncated() -> None:
    result = _extract_starting_price_with_evidence(
        "La mise à prix est ci-après indiquée : CENT QUATRE VINGT HUIT MILLE NEUF CENT TRENTE TROIS EUROS (188,933 €)"
    )

    assert result is not None
    assert result["value"] == Decimal("188933")


def test_starting_price_keeps_french_decimals() -> None:
    result = _extract_starting_price_with_evidence("Mise à prix : 125 000,50 €")

    assert result is not None
    assert result["value"] == Decimal("125000.50")
