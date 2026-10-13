"""Département d'une annonce Licitor : jamais par sous-chaîne (« Orglandes » n'est pas les Landes)."""

import pytest

from src.department_names import (
    department_from_licitor_url,
    department_from_name,
    departments_named_in_text,
)
from src.sources.licitor import parse_licitor_detail_html
from src.sources.licitor_extraction import licitor_department, refresh_licitor_raw_sale
from tests.test_licitor_extraction import MULTI_LOT_TEXT

BASE = "https://www.licitor.com/annonce/10/98/12/vente-aux-encheres"


def _detail(headline: str, tribunal: str, location: str, url: str) -> dict:
    html = f"""
    <h1>{headline}</h1>
    <p>{tribunal}</p>
    <p>Vente aux enchères publiques en un lot</p>
    <h2>Une maison</h2>
    <h3>Mise à prix : 50 000 €</h3>
    <p>{location}</p>
    """
    return parse_licitor_detail_html(html, url)


def test_orglandes_is_in_manche_not_landes() -> None:
    raw = _detail(
        "Annonce n°109812 : une maison à Orglandes (Manche), mise à prix : 50 000 €",
        "Tribunal Judiciaire de Cherbourg-en-Cotentin",
        "Orglandes",
        f"{BASE}/une-maison/orglandes/manche/109812.html",
    )
    assert raw["department"] == "50"


def test_orglandes_without_url_uses_the_headline_department() -> None:
    raw = _detail(
        "Annonce n°109812 : une maison à Orglandes (Manche), mise à prix : 50 000 €",
        "Tribunal Judiciaire de Cherbourg-en-Cotentin",
        "Orglandes",
        "https://www.licitor.com/annonce/109812.html",
    )
    assert raw["department"] == "50"


def test_orglandes_text_alone_never_gives_landes() -> None:
    assert licitor_department("Une maison à Orglandes") is None


def test_tribunal_de_vienne_isere_is_not_the_vienne_department() -> None:
    raw = _detail(
        "Annonce n°109813 : un appartement à Vienne (Isère), mise à prix : 80 000 €",
        "Tribunal Judiciaire de Vienne (Isère)",
        "Vienne",
        f"{BASE}/un-appartement/vienne/isere/109813.html",
    )
    assert raw["department"] == "38"
    # Sans URL ni code postal, le texte seul ne tranche pas : « Vienne (Isère) » est une commune.
    assert licitor_department("Tribunal Judiciaire de Vienne (Isère)") is None
    assert licitor_department("Tribunal Judiciaire de Vienne (Isère)", headline_department="Isère") == "38"


@pytest.mark.parametrize(
    ("city", "slug", "postal_code"),
    [("Limoges", "limoges", "87000"), ("Aixe-sur-Vienne", "aixe-sur-vienne", "87700")],
)
def test_haute_vienne_towns_are_87(city: str, slug: str, postal_code: str) -> None:
    raw = _detail(
        f"Annonce n°109814 : une maison à {city} (Haute-Vienne), mise à prix : 50 000 €",
        "Tribunal Judiciaire de Limoges",
        city,
        f"{BASE}/une-maison/{slug}/haute-vienne/109814.html",
    )
    assert raw["department"] == "87"
    # Par le code postal seul, puis par le texte seul.
    assert licitor_department(f"{city} {postal_code}", postal_code=postal_code) == "87"
    assert licitor_department(f"Une maison à {city}") is None


def test_url_wins_over_a_conflicting_text_name() -> None:
    text = "Tribunal Judiciaire de Bordeaux. Maison à Mérignac (Gironde), Landes cité pour mémoire."
    assert licitor_department(text, source_url=f"{BASE}/une-maison/merignac/gironde/108625.html") == "33"


def test_whole_word_text_search_is_the_last_resort() -> None:
    assert licitor_department("Maison située en Dordogne, près de Périgueux") == "24"
    assert licitor_department("Maison en Gironde et en Dordogne") is None
    assert licitor_department("Maison en Haute-Vienne") == "87"


def test_url_with_only_a_town_segment_says_nothing_about_the_department() -> None:
    assert department_from_licitor_url(f"{BASE}/bureaux/vienne/109135.html") is None
    assert department_from_licitor_url(f"{BASE}/une-maison/vienne/isere/109135.html") == "38"
    assert department_from_licitor_url("https://www.licitor.com/annonce/109001.html") is None
    assert department_from_licitor_url(None) is None


def test_department_names_match_whole_names_only() -> None:
    assert department_from_name("Val-d'Oise") == "95"
    assert department_from_name("val d'oise") == "95"
    assert department_from_name("Pyrénées-Atlantiques") == "64"
    assert department_from_name("Haute-Vienne") == "87"
    assert department_from_name("Vienne") == "86"
    assert department_from_name("Orglandes") is None
    assert departments_named_in_text("Aixe-sur-Vienne", ("86", "87")) == []


def test_refresh_replaces_a_department_read_from_a_substring() -> None:
    raw_sale = {
        "source_name": "licitor",
        "source_url": f"{BASE}/un-immeuble-de-rapport/testville/nievre/110999.html",
        "department": "86",
        "postal_code": None,
        "source_blocks": {"page_text": MULTI_LOT_TEXT},
    }
    assert refresh_licitor_raw_sale(raw_sale) is True
    assert raw_sale["department"] == "58"


def test_refresh_without_any_reliable_evidence_keeps_the_stored_department() -> None:
    raw_sale = {
        "source_name": "licitor",
        "source_url": "https://www.licitor.com/annonce/110999.html",
        "department": "58",
        "source_blocks": {"page_text": MULTI_LOT_TEXT.replace("(Nièvre)", "")},
    }
    assert refresh_licitor_raw_sale(raw_sale) is True
    assert raw_sale["department"] == "58"
