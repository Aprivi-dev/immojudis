"""Requête BAN : second code postal, texte d'audience, « France » final, mentions de bâtiment (exemples réels du 28/10/2026)."""

from __future__ import annotations

import pytest

from src.geocode_query import (
    address_postal_codes,
    build_geocode_query,
    clean_address_for_geocoding,
    geocode_postcode,
    has_street_or_place,
)
from src.models import AuctionSale


def _sale(address: str | None, postal_code: str | None = None, city: str | None = None) -> AuctionSale:
    return AuctionSale(
        source_name="vench", source_url="https://example.test/vente", address=address, postal_code=postal_code, city=city
    )


# --- les cas réels du brief ---------------------------------------------------------------------


def test_lyon_second_postal_code_in_the_address_is_dropped() -> None:
    sale = _sale("6 rue des Templiers, 69002 LYON 69003", "69003", "LYON")

    assert build_geocode_query(sale) == "6 rue des Templiers, 69002 LYON"
    assert geocode_postcode(sale) == "69002"


def test_marseille_postal_code_of_the_sale_is_not_added_to_an_address_that_has_one() -> None:
    sale = _sale("43 Boulevard Henri Maulini, 13014 MARSEILLE", "13006", "MARSEILLE")

    assert build_geocode_query(sale) == "43 Boulevard Henri Maulini, 13014 MARSEILLE"
    assert geocode_postcode(sale) == "13014"


def test_marseille_trailing_second_postal_code_is_dropped() -> None:
    sale = _sale("43 Boulevard Henri Maulini, 13014 MARSEILLE 13006", "13006", "MARSEILLE")

    assert build_geocode_query(sale) == "43 Boulevard Henri Maulini, 13014 MARSEILLE"
    assert geocode_postcode(sale) == "13014"


def test_lorient_hearing_date_building_and_second_town_are_removed() -> None:
    address = (
        "39 rue de la Villeneuve – Bâtiment Lizard – 56100 LORIENT LE LUNDI 23 NOVEMBRE 2026 à 14 H 00 56440 LANGUIDIC"
    )
    sale = _sale(address, "56100", "Lorient")

    assert clean_address_for_geocoding(address) == "39 rue de la Villeneuve – 56100 LORIENT"
    assert build_geocode_query(sale) == "39 rue de la Villeneuve – 56100 LORIENT"
    assert geocode_postcode(sale) == "56100"


def test_nimes_street_is_part_of_the_query() -> None:
    sale = _sale("2 rue des Chapeliers, 30000 NÎMES", "30000", "NÎMES")

    assert build_geocode_query(sale) == "2 rue des Chapeliers, 30000 NÎMES"
    assert build_geocode_query(_sale(None, "30000", "Nîmes")) == "30000 Nîmes"


# --- sans texte parasite, la requête ne change pas ---------------------------------------------------


def test_a_clean_address_keeps_the_historical_query() -> None:
    assert (
        build_geocode_query(_sale("21 Boulevard Jean Sarrailh 64000 PAU", "64000", "PAU"))
        == "21 Boulevard Jean Sarrailh 64000 PAU"
    )
    assert build_geocode_query(_sale("10 rue Exemple", "33000", "Bordeaux")) == "10 rue Exemple 33000 Bordeaux"
    assert geocode_postcode(_sale("10 rue Exemple", "33000", "Bordeaux")) == "33000"


def test_the_sale_postal_code_is_kept_when_the_address_has_none() -> None:
    sale = _sale("12 rue Foch", "75008", "Paris")

    assert build_geocode_query(sale) == "12 rue Foch 75008 Paris"
    assert geocode_postcode(sale) == "75008"


def test_no_postal_code_anywhere_gives_no_postcode_filter() -> None:
    assert geocode_postcode(_sale("12 rue Foch", None, "Paris")) is None


# --- autres textes parasites -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("address", "cleaned"),
    [
        ("12 rue Foch, 75008 Paris, France", "12 rue Foch, 75008 Paris"),
        ("12 rue Foch 75008 Paris France", "12 rue Foch 75008 Paris"),
        ("12 rue Foch 75008 Paris le 12/11/2026 à 14h30", "12 rue Foch 75008 Paris"),
        ("12 rue Foch 75008 Paris jeudi 12 novembre 2026", "12 rue Foch 75008 Paris"),
        ("12 rue Foch, Bât. B, Escalier 2, 75008 Paris", "12 rue Foch, 75008 Paris"),
        ("12 rue Foch - Appartement 4 - 75008 Paris", "12 rue Foch - 75008 Paris"),
    ],
)
def test_noise_is_removed(address: str, cleaned: str) -> None:
    assert clean_address_for_geocoding(address) == cleaned


@pytest.mark.parametrize(
    "address",
    [
        # Une voie nommée d'après une date, un nom de voie qui finit par « France », un bâtiment nommé dans la voie.
        "12 avenue du 8 mai 1945, 69100 Villeurbanne",
        "12 rue du 11 novembre 1918 69100 Villeurbanne",
        "12 place de France",
        "12 place de France 57000 Metz",
        "3 rue Bâtiment-Neuf 75008 Paris",
    ],
)
def test_real_street_names_are_never_cut(address: str) -> None:
    assert clean_address_for_geocoding(address) == address


def test_an_address_that_is_only_noise_is_empty() -> None:
    assert clean_address_for_geocoding("le lundi 23 novembre 2026 à 14 H 00") == ""
    assert build_geocode_query(_sale("le lundi 23 novembre 2026", "56100", "Lorient")) == "56100 Lorient"


def test_the_same_postal_code_written_twice_is_not_a_second_code() -> None:
    assert address_postal_codes("12 rue Foch 75008 Paris, 75008 Paris") == ["75008"]
    assert clean_address_for_geocoding("12 rue Foch 75008 Paris, 75008 Paris") == "12 rue Foch 75008 Paris, 75008 Paris"


# --- voie ou lieu-dit ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("2 rue des Chapeliers, 30000 NÎMES", True),
        ("Résidence Les Pins, 12 rue Truc", True),
        ("Lieu-dit Le Moulin 21000 Dijon", True),
        ("Lieu dit la Croix, 45000 Orléans", True),
        ("Hameau de Beauvoir 21000 Dijon", True),
        ("13 Av. Koenig Maréchal de France", True),
        ("30000 Nîmes", False),
        ("Nîmes", False),
        ("", False),
        (None, False),
    ],
)
def test_street_or_place(address: str | None, expected: bool) -> None:
    assert has_street_or_place(address) is expected
