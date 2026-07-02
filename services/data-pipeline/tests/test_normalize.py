from decimal import Decimal

from src.normalize import (
    normalize_sale,
    normalize_source_urls,
    parse_confidence,
    parse_french_datetime,
    parse_price,
    parse_surface,
)


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


def test_parse_french_datetime_keeps_day_before_french_month() -> None:
    parsed = parse_french_datetime("Vente immobilière le 11 Juin 2026")
    assert parsed is not None
    assert parsed.year == 2026
    assert parsed.month == 6
    assert parsed.day == 11


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


def test_normalize_sale_preserves_collected_app_ready_metadata() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://example.test/primary",
            "source_urls": ["https://example.test/secondary", "https://example.test/primary"],
            "tribunal_code": "bordeaux",
            "surface_scope": "total",
            "score_version": "score-v1",
            "score_confidence": "87",
            "score_factors": [{"factor_key": "surface"}],
        }
    )

    assert sale.source_urls == ["https://example.test/primary", "https://example.test/secondary"]
    assert sale.tribunal_code == "bordeaux"
    assert sale.surface_scope == "total"
    assert sale.score_version == "score-v1"
    assert sale.score_confidence == Decimal("0.87")
    assert sale.score_factors == [{"factor_key": "surface"}]


def test_normalize_source_urls_handles_mapping_and_dedupes_primary_first() -> None:
    assert normalize_source_urls(
        {"licitor": "https://example.test/secondary", "main": "https://example.test/primary"},
        "https://example.test/primary",
    ) == ["https://example.test/primary", "https://example.test/secondary"]


def test_normalize_sale_extracts_overseas_department() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/guadeloupe",
            "address": "12 rue Test 97100 Basse-Terre",
        }
    )

    assert sale.department == "971"
    assert sale.postal_code == "97100"


def test_normalize_sale_preserves_canonical_property_type() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/canonical",
            "property_type": "house",
        }
    )

    assert sale.property_type == "house"


def test_normalize_sale_maps_notaires_short_property_code() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/adjudication/maison/le-bouscat-33/1741074",
            "property_type": "MAI",
            "title": "Maison 5 pièces de 106 m²",
        }
    )

    assert sale.property_type == "house"


def test_normalize_sale_recovers_specific_type_from_title_when_raw_type_is_other() -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://example.test/notaires-other-title",
            "property_type": "Autre",
            "title": "Maison 5 pièces de 106 m² avec jardin",
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


def test_normalize_sale_extracts_rooms_from_listing_title() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-165170-un-appartement-de-4-pieces-pau.html",
            "title": "UN APPARTEMENT DE 4 PIÈCES - Pau",
        }
    )

    assert sale.rooms_count == 4


def test_normalize_sale_extracts_rooms_before_parking_count() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/un-appartement/pau/109107.html",
            "raw_text": "Un appartement de 79,06 m², de trois pièces deux places de parking.",
        }
    )

    assert sale.rooms_count == 3


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


def test_normalize_sale_maps_french_occupancy_to_enum() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/enchere/maison-kleber",
            "occupancy_status": "Libre de toute occupation",
        }
    )

    assert sale.occupancy_status == "vacant"


def test_normalize_sale_drops_unrecognised_occupancy() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/occ-unknown",
            "occupancy_status": "amiante, plomb, termites",
        }
    )

    assert sale.occupancy_status is None
