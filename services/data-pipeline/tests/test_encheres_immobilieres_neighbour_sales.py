"""Fiche Enchères Immobilières : le bloc « Consultez d'autres ventes » n'appartient pas à la vente.

La fixture réduit la fiche 9545 observée en octobre 2026 (propriété de Menton, mise à prix 4 700 000 €,
audience du 5 novembre 2026 à 9h00) : sous la description, la page liste des ventes voisines dont un 2 pièces de
Nice de 35,01 m². Avant la coupe, cette surface était publiée pour la maison de Menton.
"""

from __future__ import annotations

import pytest

from src.sources import encheres_immobilieres as source

DETAIL_URL = f"{source.BASE_URL}/ventes/9545-propriete-menton-06"


def _menton_detail_html(marker: str = "CONSULTEZ D'AUTRES VENTES SUR") -> str:
    return f"""
    <main>
      <h1>PROPRIÉTÉ comprenant Maison principale, Maison d’origine en pierre, piscine, grand Parc arboré</h1>
      <p>Vente n° 9545</p>
      <p>MISE À PRIX</p><p>4 700 000 €</p>
      <p>Annonce n°</p><p>9545</p>
      <p>Adresse de la vente :</p><p>Tribunal Judiciaire de Nice</p><p>-</p>
      <p>3 Place du Palais de Justice - Palais Rusca</p><p>,</p><p>06300</p><p>NICE</p>
      <p>Date de la vente :</p><p>jeudi 5 novembre 2026 à 09h00</p>
      <p>Mise à prix</p><p>Adresse du bien</p><p>4 700 000 €</p>
      <p>5215 route du Val de Gorbio</p><p>,</p><p>06500</p><p>MENTON</p>
      <p>Date de mise en vente</p><p>Adresse de la vente</p>
      <p>jeudi 5 novembre 2026 à 09h00</p><p>Tribunal Judiciaire de Nice</p>
      <h2>Descriptif du bien</h2>
      <p>Réf. annonce :</p><p>9545</p>
      <p>Adjudication le 05 novembre 2026 à 9h00</p>
      <p>À MENTON (06500), lieudit La Siga, 5215 Route du Val de Gorbio</p>
      <p>UNE PROPRIÉTÉ comprenant une maison principale, piscine, grand parc arboré.</p>
      <p>MISE À PRIX : 4.700.000 €</p>
      <p>Avocat poursuivant</p>
    </main>
    <section>
      <h2>{marker}</h2>
      <h3>ALPES-MARITIMES</h3>
      <p>03</p><p>DÉC</p><p>Appartement</p>
      <p>APPARTEMENT 2P de 35,01 m², au 1er étage, avec balcon à NICE (06)</p>
      <p>NICE (06)</p><p>Mise à prix :</p><p>30 000 €</p>
      <p>Tribunal Judiciaire de Grasse</p><p>Voir le bien</p>
      <p>Adjudication le 03 décembre 2026 à 9h00</p>
    </section>
    """


def test_detail_ignores_the_neighbouring_sales_block() -> None:
    raw = source.parse_encheres_immobilieres_detail_html(_menton_detail_html(), DETAIL_URL)

    assert raw["surface_m2"] is None
    assert raw["starting_price_eur"] == "4 700 000"
    assert raw["sale_date"] == "jeudi 5 novembre 2026 à 09h00"
    assert raw["tribunal"] == "Tribunal Judiciaire de Nice"
    assert "5215 route du Val de Gorbio" in raw["address"]
    assert raw["postal_code"] == "06500"
    # Le titre de la fiche n'a pas de « (06) » : la commune venait des ventes voisines (« NICE (06) »).
    # Elle reste vide ici ; la carte de la liste, qui n'est pas écrasée par la fiche, la fournit.
    assert raw["city"] in (None, "Menton")
    assert "35,01" not in raw["raw_text"]
    assert "35,01" not in raw["source_blocks"]["page_text"]


@pytest.mark.parametrize(
    "marker",
    ["CONSULTEZ D'AUTRES VENTES SUR", "Consultez d’autres ventes sur", "consultez d’autres ventes"],
)
def test_other_sales_marker_accepts_both_apostrophes_in_any_case(marker: str) -> None:
    raw = source.parse_encheres_immobilieres_detail_html(_menton_detail_html(marker), DETAIL_URL)

    assert raw["surface_m2"] is None


def test_without_the_marker_the_neighbouring_block_is_not_cut() -> None:
    """Contrôle de la fixture : sans marqueur, la surface du voisin remonte (défaut d'origine)."""
    raw = source.parse_encheres_immobilieres_detail_html(_menton_detail_html("VENTES PROCHES"), DETAIL_URL)

    assert raw["surface_m2"] == "35,01"


def test_cut_starts_at_the_first_marker_line_only() -> None:
    lines = ["Fiche", "Consultez la carte interactive du bien", "CONSULTEZ D'AUTRES VENTES SUR", "NICE", "Consultez d'autres ventes"]

    assert source._without_other_sales_block(lines) == ["Fiche", "Consultez la carte interactive du bien"]
    assert source._without_other_sales_block(["Fiche", "NICE"]) == ["Fiche", "NICE"]
