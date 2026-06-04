from decimal import Decimal

from src.normalize import normalize_sale, parse_confidence, parse_french_datetime, parse_price, parse_surface


def test_parse_price_handles_french_money() -> None:
    assert parse_price("Mise à prix : 125 000,50 €") == Decimal("125000.50")


def test_parse_price_preserves_already_normalized_numeric_values() -> None:
    assert parse_price(118000.0) == Decimal("118000.0")
    assert parse_price("118000.0") == Decimal("118000.0")


def test_parse_surface_preserves_decimal_point() -> None:
    assert parse_surface("91.78") == Decimal("91.78")
    assert parse_surface("91,78 m²") == Decimal("91.78")


def test_parse_confidence_normalizes_percent_and_ratio() -> None:
    assert parse_confidence("0.75") == Decimal("0.75")
    assert parse_confidence("75") == Decimal("0.75")


def test_parse_french_datetime_handles_month_and_hour() -> None:
    parsed = parse_french_datetime("Jeudi 12 décembre 2024 à 14h30")
    assert parsed is not None
    assert parsed.year == 2024
    assert parsed.month == 12
    assert parsed.day == 12
    assert parsed.hour == 14
    assert parsed.minute == 30


def test_normalize_sale_extracts_department_and_property_type() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/example",
            "title": "Vente aux enchères Maison",
            "address": "12 rue Test 33000 Bordeaux",
            "starting_price_eur": "80 000 €",
            "sale_date": "12 décembre 2026 à 10h00",
        }
    )
    assert sale.department == "33"
    assert sale.postal_code == "33000"
    assert sale.city == "Bordeaux"
    assert sale.property_type == "house"
    assert sale.status == "upcoming"


def test_normalize_sale_preserves_canonical_property_type() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/canonical",
            "property_type": "house",
        }
    )

    assert sale.property_type == "house"


def test_normalize_sale_corrects_legacy_price_with_raw_text_evidence() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/legacy-price",
            "starting_price_eur": 1180000.0,
            "raw_text": "Mise à prix : 118 000,00 €",
        }
    )

    assert sale.starting_price_eur == Decimal("118000.00")


def test_normalize_sale_extracts_rooms_count_from_source_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/rooms-from-page",
            "raw_text": "Estimez vos frais d'acquisition 5 pièces 3 chambres À propos du bien Maison.",
        }
    )

    assert sale.rooms_count == 5
    assert sale.bedrooms_count == 3


def test_normalize_sale_distinguishes_rooms_and_bedrooms() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/rooms-bedrooms",
            "raw_text": "Appartement de type 4 comprenant séjour, cuisine et 3 chambres.",
        }
    )

    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3


def test_normalize_sale_extracts_written_room_and_bedroom_counts() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/type-trois",
            "raw_text": "Appartement de type trois comprenant séjour, cuisine et deux chambres.",
        }
    )

    assert sale.rooms_count == 3
    assert sale.bedrooms_count == 2


def test_normalize_sale_counts_numbered_bedrooms() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/numbered-bedrooms",
            "raw_text": "Maison comprenant séjour, chambre n°1, chambre n°2 et chambre n°3.",
        }
    )

    assert sale.bedrooms_count == 3


def test_normalize_sale_ignores_dvf_comparable_rooms_count() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/rooms-dvf",
            "raw_text": "Données des valeurs foncières Type de bien Date de vente Surface Nb de pièces Prix de vente Maison 100 m2 4 410000 euros.",
        }
    )

    assert sale.rooms_count is None
