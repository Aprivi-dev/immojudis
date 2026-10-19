from __future__ import annotations

import logging

from src.raw_models import validate_raw_sales
from src.repeated_surface_guard import drop_repeated_foreign_surfaces

CITIES = ("Menton", "Grasse", "Cannes", "Antibes", "Vence")


def _sale(index: int, city: str, surface: object, **extra: object) -> dict[str, object]:
    return {
        "source_name": "encheres_immobilieres",
        "source_url": f"https://encheresimmobilieres.fr/ventes/{9500 + index}-bien",
        "title": f"Bien {index}",
        "city": city,
        "surface_m2": surface,
        "source_blocks": {"surface": surface, "titre": f"Bien {index}"},
        **extra,
    }


def test_same_decimal_surface_on_four_cities_is_withdrawn_and_logged(caplog) -> None:
    sales = [_sale(i, city, "35,01") for i, city in enumerate(CITIES[:4])]
    sales.append(_sale(9, "Nice", "88,40"))

    with caplog.at_level(logging.WARNING, logger="src.repeated_surface_guard"):
        flagged = drop_repeated_foreign_surfaces("encheres_immobilieres", sales)

    assert len(flagged) == 4
    for sale in sales[:4]:
        assert sale["surface_m2"] is None
        assert "surface" not in sale["source_blocks"]
        assert "ambiguous_surface" in sale["quality_flags"]
        assert "surface_shared_across_cities" in sale["quality_flags"]
        assert sale["rejected_repeated_surface_m2"] == "35,01"
    assert sales[4]["surface_m2"] == "88,40"
    assert "quality_flags" not in sales[4]
    assert "35.01" in caplog.text


def test_tolerance_of_one_hundredth_groups_neighbouring_values() -> None:
    values = ("73,83", 73.84, "73,83", 73.83)
    sales = [_sale(i, city, value) for i, (city, value) in enumerate(zip(CITIES[:4], values, strict=True))]

    assert len(drop_repeated_foreign_surfaces("encheres_immobilieres", sales)) == 4


def test_three_cities_or_the_same_city_are_left_alone() -> None:
    three = [_sale(i, city, "35,01") for i, city in enumerate(CITIES[:3])]
    same_city = [_sale(i, "Menton", "35,01") for i in range(6)]
    three_cities_four_sales = [_sale(i, city, "35,01") for i, city in enumerate(("Menton", "Grasse", "Cannes", "Menton"))]

    for sales in (three, same_city, three_cities_four_sales):
        assert drop_repeated_foreign_surfaces("encheres_immobilieres", sales) == []
        assert all(sale["surface_m2"] == "35,01" for sale in sales)


def test_round_surfaces_are_not_examined() -> None:
    sales = [_sale(i, city, "50") for i, city in enumerate(CITIES)]

    assert drop_repeated_foreign_surfaces("encheres_immobilieres", sales) == []
    assert all(sale["surface_m2"] == "50" for sale in sales)


def test_validate_raw_sales_applies_the_guard_to_a_whole_pass() -> None:
    sales = [_sale(i, city, "35,01") for i, city in enumerate(CITIES)]
    errors: list[str] = []

    valid = validate_raw_sales("encheres_immobilieres", sales, errors)

    assert errors == []
    assert len(valid) == 5
    assert all(sale["surface_m2"] is None for sale in valid)
