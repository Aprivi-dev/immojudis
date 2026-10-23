"""n° 65 : une boîte par département métropolitain et d'outre-mer, pas seulement cinq."""

from decimal import Decimal

import pytest

from src.department_bounds import DEPARTMENT_BOUNDS, coordinates_in_department


def test_every_metropolitan_and_overseas_department_has_a_box() -> None:
    metropolitan = {f"{number:02d}" for number in range(1, 96) if number != 20} | {"2A", "2B"}
    overseas = {"971", "972", "973", "974", "976"}

    assert set(DEPARTMENT_BOUNDS) == metropolitan | overseas


def test_boxes_are_well_formed() -> None:
    for code, (min_lat, max_lat, min_lon, max_lon) in DEPARTMENT_BOUNDS.items():
        assert min_lat < max_lat, code
        assert min_lon < max_lon, code


@pytest.mark.parametrize(
    ("department", "latitude", "longitude"),
    [
        ("06", "43.6591", "6.9235"),  # Grasse
        ("75", "48.8566", "2.3522"),  # Paris
        ("2A", "41.9192", "8.7386"),  # Ajaccio
        ("2B", "42.6977", "9.4509"),  # Bastia
        ("971", "16.2410", "-61.5330"),  # Pointe-à-Pitre
        ("972", "14.6161", "-61.0588"),  # Fort-de-France
        ("973", "4.9372", "-52.3260"),  # Cayenne
        ("974", "-20.8789", "55.4481"),  # Saint-Denis de La Réunion
        ("976", "-12.7809", "45.2279"),  # Mamoudzou
        ("29", "48.3904", "-4.4861"),  # Brest, pointe ouest
        ("59", "51.0344", "2.3768"),  # Dunkerque, pointe nord
        ("67", "48.5734", "7.7521"),  # Strasbourg
    ],
)
def test_a_town_of_the_department_is_inside_its_box(department: str, latitude: str, longitude: str) -> None:
    assert coordinates_in_department(Decimal(latitude), Decimal(longitude), department)


def test_the_grasse_sale_point_in_england_is_outside_alpes_maritimes() -> None:
    # Vente 85bf9c86… (Avoventes, Grasse) : point (54.27, -0.40) dans le Yorkshire.
    assert not coordinates_in_department(54.27, -0.40, "06")


@pytest.mark.parametrize("department", ["01", "13", "33", "69", "75", "2A", "974"])
def test_a_point_of_another_region_is_outside(department: str) -> None:
    far = (48.0, 2.0) if department != "75" else (43.3, 5.4)
    assert not coordinates_in_department(far[0], far[1], department)


def test_a_department_without_a_box_is_never_refused() -> None:
    assert coordinates_in_department(48.0, 2.0, "977")
    assert coordinates_in_department(48.0, 2.0, None)
    assert coordinates_in_department(48.0, 2.0, "")
