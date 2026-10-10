"""Superficies présentes dans le texte mais jusque-là ignorées (formulations observées, valeurs fictives)."""

from decimal import Decimal

import pytest

from src.normalize import normalize_sale
from src.surface_text_recovery import extra_built_surface_from_text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("APPARTEMENT DE 2 PIECES (55,31 m²) A EXEMPLEVILLE - 20 000 euros", Decimal("55.31")),
        ("MAISON DE 4 PIECES (100,90 m²) A EXEMPLEVILLE", Decimal("100.90")),
        ("Une MAISON D’HABITATION sur 3 niveaux de 13 pièces principales ( 301,45 m² ) RDC : entrée", Decimal("301.45")),
        ("10 NOV Chalet CHALET de 180 m² sur 3 niveaux à EXEMPLEVILLE (09)", Decimal("180")),
        ("Le certificat de mesurage établi le 24 juin 2026 conclut à une superficie de 58,04 m². MISE À PRIX", Decimal("58.04")),
        ("Trois lots de copropriété d'une surface globale d'environ 144 m², au sous-sol", Decimal("144")),
    ],
)
def test_formulations_not_read_before_are_now_read(text, expected):
    assert extra_built_surface_from_text(text, "avoventes") == expected


def test_several_different_surfaces_in_one_text_are_not_guessed():
    text = "Un appartement de 55 m² et une maison de 120 m² vendus ensemble"
    assert extra_built_surface_from_text(text, "avoventes") is None


def test_sources_with_news_tickers_or_other_listings_are_excluded():
    text = "News 09/10 Appel à intérêt : un chalet de 1 273 m² proposé à la location"
    assert extra_built_surface_from_text(text, "petites_affiches") is None
    assert extra_built_surface_from_text(text, "vench") is None


def test_no_surface_stays_empty():
    assert extra_built_surface_from_text("Une maison d'habitation sur trois niveaux", "licitor") is None
    assert extra_built_surface_from_text(None) is None


def test_normalize_sale_uses_the_text_surface_when_the_source_gives_none():
    raw = {
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/enchere/3",
        "title": "Appartement",
        "description": "APPARTEMENT DE 2 PIECES (55,31 m²) A EXEMPLEVILLE",
    }
    assert normalize_sale(raw).surface_m2 == Decimal("55.31")
