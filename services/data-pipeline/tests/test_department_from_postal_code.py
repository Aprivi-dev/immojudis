"""P1-08 : le département se déduit du code postal quand la source ne le donne pas."""
import pytest

from src.normalize import extract_department, normalize_sale


@pytest.mark.parametrize(
    ("postal_code", "department"),
    [
        ("33000", "33"),
        ("75008", "75"),
        ("01000", "01"),
        ("20000", "2A"),  # Ajaccio
        ("20137", "2A"),  # Porto-Vecchio
        ("20199", "2A"),
        ("20200", "2B"),  # Bastia
        ("20250", "2B"),  # Corte
        ("20260", "2B"),  # Calvi
        ("97100", "971"),  # Guadeloupe
        ("97400", "974"),  # La Réunion
        ("97600", "976"),  # Mayotte
        ("98000", "980"),  # Monaco
        ("98800", "988"),  # Nouvelle-Calédonie
    ],
)
def test_extract_department_from_postal_code(postal_code, department):
    assert extract_department(postal_code) == department


@pytest.mark.parametrize("postal_code", [None, "", "2"])
def test_extract_department_without_usable_postal_code(postal_code):
    assert extract_department(postal_code) is None


def _sale(**fields):
    return normalize_sale({"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/dep", **fields})


def test_sale_without_department_gets_it_from_the_postal_code():
    assert _sale(postal_code="77920", city="Samois-sur-Seine").department == "77"
    assert _sale(postal_code="20600").department == "2B"
    assert _sale(postal_code="97200").department == "972"


def test_department_is_found_through_the_address_postal_code():
    assert _sale(address="3 rue du Port, 20110 Propriano").department == "2A"


def test_explicit_department_is_kept():
    assert _sale(postal_code="33000", department="33").department == "33"
    assert _sale(postal_code="20000", department="2A").department == "2A"


def test_obsolete_department_20_is_replaced_by_the_postal_code_department():
    assert _sale(postal_code="20200", department="20").department == "2B"
    assert _sale(department="20").department == "20"
