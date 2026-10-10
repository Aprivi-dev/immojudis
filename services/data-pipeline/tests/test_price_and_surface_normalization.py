"""P2-18 : formats de prix (M€, k€, seuil de 100 €) et helpers de surface partagés entre sources."""
import re
from decimal import Decimal
from pathlib import Path

import pytest

from src.normalize import extract_adjudication_price, extract_starting_price, normalize_sale, parse_price
from src.sources import agrasc, cessions_etat, common, info_encheres, licitor, petites_affiches, vench
from src.sources import encheres_publiques as encheres_publiques_source

# --- parse_price -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1,5 M€", "1500000"),
        ("1,5 M €", "1500000"),
        ("2M€", "2000000"),
        ("1.5 M€", "1500000"),
        ("2 millions d'euros", "2000000"),
        ("1,2 million d’euros", "1200000"),
        ("85 k€", "85000"),
        ("85k€", "85000"),
        ("85 K€", "85000"),
        ("12,5 k€", "12500"),
        ("85 k euros", "85000"),
        ("125 000,50 €", "125000.50"),
        ("1.180.000 €", "1180000"),
        ("100 €", "100"),
    ],
)
def test_parse_price_understands_scaled_amounts(text, expected):
    assert parse_price(text) == Decimal(expected)


@pytest.mark.parametrize("value", ["99 €", "11 €", "1 €", "0", "0 €", 0, 50, 99.5, Decimal("99.99")])
def test_parse_price_rejects_amounts_under_100_euros(value):
    assert parse_price(value) is None


def test_parse_price_keeps_plausible_numeric_values():
    assert parse_price(100) == Decimal(100)
    assert parse_price(118000.0) == Decimal("118000.0")
    assert parse_price(Decimal("250000")) == Decimal("250000")


def test_area_is_not_scaled_as_a_price():
    assert parse_price("1500 m²") == Decimal("1500")


def test_scaled_amounts_are_read_from_the_page_text():
    assert extract_starting_price({"raw_text": "Mise à prix : 85 k€ - visite le 3 mars"}) == Decimal("85000")
    assert extract_starting_price({"raw_text": "Mise à prix : 1,5 M€"}) == Decimal("1500000")
    assert extract_starting_price({"raw_text": "Mise à prix : 150 000 € visite"}) == Decimal("150000")


def test_scaled_adjudication_is_read_too():
    raw = {"starting_price_eur": 1000000, "raw_text": "Adjugé : 1,2 M€"}

    assert extract_adjudication_price(raw) == Decimal("1200000")


def test_implausible_starting_price_does_not_reach_the_sale():
    sale = normalize_sale(
        {"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/mini", "starting_price_eur": "11 €"}
    )

    assert sale.starting_price_eur is None


def test_investment_score_is_not_filtered_as_a_price():
    sale = normalize_sale(
        {"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/score", "investment_score": "72,5"}
    )

    assert sale.investment_score == Decimal("72.5")


# --- helpers de surface partagés ---------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1 234,5", "1234.5"),
        ("1.234,5", "1234.5"),
        ("1\xa0234,5", "1234.5"),
        ("1.234", "1234"),
        ("2.464", "2464"),
        ("91.78", "91.78"),
        ("91,78", "91.78"),
        ("72", "72"),
        ("1.2.3", None),
        ("", None),
        (None, None),
    ],
)
def test_normalize_surface_number(text, expected):
    assert common.normalize_surface_number(text) == expected


def test_extract_surface_reads_a_french_thousands_number():
    assert common.extract_surface("Surface : 1 234,5 m² habitables") == "1234.5"
    assert common.extract_surface("bien de 72 m2", "autre texte") == "72"
    assert common.extract_surface("aucune surface", None) is None


def test_extract_surface_prefers_labelled_pattern_then_skips_excluded_matches():
    labelled = (r"\bSurface\s+en\s+m²\s*:?\s*([0-9][0-9.,]*)\b",)
    text = "terrain 5 000 m² - Surface en m² : 72,5"
    assert common.extract_surface(text, labelled=labelled) == "72.5"

    def exclude(text, start, end):
        return "terrain" in text[max(0, start - 20) : start]

    assert common.extract_surface("terrain 5 000 m² et maison 80 m²", exclude=exclude) == "80"
    assert common.extract_surface("terrain 5 000 m²", exclude=exclude) == "5000"


@pytest.mark.parametrize("module", [agrasc, cessions_etat, licitor, vench, info_encheres])
def test_sources_share_the_surface_number_normalizer(module):
    assert module.normalize_surface_number is common.normalize_surface_number
    assert not hasattr(module, "_normalize_surface_number")


@pytest.mark.parametrize(
    "module", [agrasc, cessions_etat, vench, info_encheres, petites_affiches, encheres_publiques_source]
)
def test_sources_share_the_surface_extractor(module):
    assert module.extract_surface is common.extract_surface
    assert not hasattr(module, "_extract_surface")


def test_every_source_reads_1234_5_square_metres_the_same_way():
    assert licitor._extract_surface_m2("Appartement de 1 234,5 m² environ") == "1234.5"
    assert common.extract_surface(
        "Surface en m² : 1 234,5", number=cessions_etat.SURFACE_VALUE_PATTERN, labelled=cessions_etat.SURFACE_LABELLED_PATTERNS
    ) == "1234.5"
    assert common.extract_surface("1 234,5 m²", number=agrasc.SURFACE_VALUE_PATTERN) == "1234.5"
    detail = petites_affiches.parse_petites_affiches_detail_html(
        "<div class='row detail default'><h4>Mise à Prix : <strong>95 000</strong> €</h4>"
        "<p>Surface totale : 1 234,5 m²</p></div>",
        "https://www.petitesaffiches.fr/vente.html",
    )
    assert detail["surface_m2"] == "1234.5"


def test_surface_helpers_are_not_copied_back_into_the_sources():
    sources_dir = Path(common.__file__).parent
    copies = {
        path.name: re.findall(r"^def (_normalize_surface_number|_extract_surface)\(", path.read_text(), re.M)
        for path in sources_dir.glob("*.py")
    }

    # encheres_immobilieres ranks asset facts; it is not a copy of the regex helper.
    assert {name: found for name, found in copies.items() if found} == {
        "encheres_immobilieres.py": ["_extract_surface"]
    }
