"""Carte Licitor sans « Mise à prix » : le lecteur lit sa carte, jamais la liste entière.

Depuis le 10/11/2026, une annonce publiée en quatre cartes de lot (une URL par lot) a deux cartes dont le
bloc prix est vide. Le lecteur remontait de parent en parent jusqu'à ``<ul class="AdResults">`` et lisait le
texte de toute la liste : son empreinte différait de celle de la preuve de catalogue, qui refusait à juste
titre l'inventaire (``no_matching_total_or_terminal_page_proof``), et la carte prenait la commune et la mise à
prix de la première carte de la page.

La fixture (tests/fixtures/licitor_liste_carte_sans_mise_a_prix.html) est réduite et fictive : trois cartes à
la structure du site, dont une sans prix.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest

from src.admission import LICITOR_MULTI_LOT_QUARANTINE, quarantine_reason
from src.catalogue_proof import CatalogueEvidence, public_page_proof
from src.normalize import normalize_sale
from src.sources import licitor
from src.sources.licitor import parse_licitor_list_html, parse_licitor_list_sales

FIXTURE = Path(__file__).parent / "fixtures" / "licitor_liste_carte_sans_mise_a_prix.html"
CAPTURE = Path(__file__).resolve().parents[3] / "docs/audits/sources-2026-10-02/primary/licitor-list.html"
LIST_URL = "https://www.licitor.com/ventes-aux-encheres-immobilieres/sud-est-mediterrannee/prochaines-ventes.html"
AD = "https://www.licitor.com/annonce/90/00/{}/vente-aux-encheres/{}/isere/9000{}.html"
PRICED_NEIGHBOUR = AD.format("01", "un-appartement/exempleville", "01")
BARE = AD.format("02", "deux-parcelles-de-terrain/saint-fictif-du-test", "02")
PRICED_SIBLING = AD.format("02", "sept-parcelles-de-terrain/champ-modele", "02")
BARE_CARD_TEXT = "38\nSaint-Fictif-du-Test\nDeux parcelles de terrain"
PRODUCTION_REASON = "no_matching_total_or_terminal_page_proof"


def _html() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def _container_before_fix(link: Any) -> Any:
    """Témoin : la remontée d'avant le correctif, sans arrêt sur un parent qui porte une autre annonce."""
    if "Mise à prix" in link.get_text(" ", strip=True) or "Mise a prix" in link.get_text(" ", strip=True):
        return link
    node = link
    for _ in range(5):
        parent = getattr(node, "parent", None)
        if parent is None:
            break
        text = parent.get_text(" ", strip=True)
        if "Mise à prix" in text or "Mise a prix" in text:
            return parent
        node = parent
    return link


def _certificate(rows: list[dict[str, Any]], html: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    evidence = CatalogueEvidence("licitor")
    evidence.observe(html or _html(), LIST_URL, rows)
    metrics = evidence.metrics(rows, [])
    return metrics, metrics["certificate"]["partitions"][0]


def _row(rows: list[dict[str, Any]], url: str) -> dict[str, Any]:
    return next(row for row in rows if row["source_url"] == url)


def test_reading_before_the_fix_fails_the_proof_with_the_production_reason(monkeypatch) -> None:
    monkeypatch.setattr(licitor, "_list_item_container", _container_before_fix)
    rows = parse_licitor_list_sales(_html(), LIST_URL)

    metrics, partition = _certificate(rows)

    # Trois cartes publiques, trois lignes lues, mais l'empreinte de la carte sans prix est celle de la liste.
    assert (partition["source_rows_seen"], partition["public_records"], partition["parsed_records"]) == (3, 3, 3)
    assert partition["reasons"] == [PRODUCTION_REASON]
    assert metrics["coverage_complete"] is False
    # Et la carte prenait la commune, le titre et la mise à prix de la première carte de la page.
    bare = _row(rows, BARE)
    assert (bare["city"], bare["title"], bare["starting_price_eur"]) == ("Exempleville", "Un appartement", "150 000 €")


def test_a_catalogue_with_a_priceless_card_is_certified() -> None:
    rows = parse_licitor_list_sales(_html(), LIST_URL)

    metrics, partition = _certificate(rows)

    assert partition["reasons"] == []
    assert (partition["certified"], partition["basis"]) == (True, "advertised_total")
    assert (partition["source_rows_seen"], partition["public_records"], partition["parsed_records"]) == (3, 3, 3)
    assert metrics["coverage_complete"] is True
    # Le lecteur et la preuve lisent la même carte, sans que la preuve ait changé de définition.
    proof = public_page_proof("licitor", _html(), LIST_URL)
    assert proof["public_urls"] == sorted([PRICED_NEIGHBOUR, BARE, PRICED_SIBLING])
    assert (proof["card_nodes"], proof["advertised_totals"]) == (3, [3])


def test_a_priceless_card_keeps_its_own_commune_and_title_and_no_price() -> None:
    rows = parse_licitor_list_sales(_html(), LIST_URL)

    assert [row["source_url"] for row in rows] == [PRICED_NEIGHBOUR, BARE, PRICED_SIBLING]
    bare = _row(rows, BARE)
    assert (bare["department"], bare["city"], bare["title"]) == ("38", "Saint-Fictif-du-Test", "Deux parcelles de terrain")
    assert bare["external_id"] == "900002"
    # Une valeur absente reste vide : jamais la mise à prix d'une carte voisine.
    assert bare["starting_price_eur"] is None
    assert "mise_a_prix" not in bare["source_blocks"]
    # Le texte gardé (preuve, empreinte, blocs de source) est celui de la carte seule.
    assert bare["raw_text"] == BARE_CARD_TEXT
    assert bare["source_blocks"]["page_text"] == BARE_CARD_TEXT
    assert bare["source_blocks"]["lots_publics"] == BARE_CARD_TEXT
    assert bare["source_lots"] == [
        {"raw_text": BARE_CARD_TEXT, "title": "Deux parcelles de terrain", "starting_price_eur": None}
    ]
    for neighbour_text in ("Exempleville", "150 000", "Champ-Modèle", "8 500"):
        assert neighbour_text not in str(bare)
    # Les cartes voisines sont lues comme avant.
    assert (_row(rows, PRICED_NEIGHBOUR)["city"], _row(rows, PRICED_NEIGHBOUR)["starting_price_eur"]) == (
        "Exempleville", "150 000 €")
    assert (_row(rows, PRICED_SIBLING)["city"], _row(rows, PRICED_SIBLING)["starting_price_eur"]) == (
        "Champ-Modèle", "8 500 €")


@pytest.mark.parametrize("foreign_text", ["neighbour_card", "whole_list"])
def test_the_proof_still_refuses_a_card_read_with_a_neighbours_text(foreign_text: str) -> None:
    rows = parse_licitor_list_sales(_html(), LIST_URL)
    assert _certificate(rows)[0]["coverage_complete"] is True
    tampered = copy.deepcopy(rows)
    texts = {
        "neighbour_card": _row(rows, PRICED_NEIGHBOUR)["source_lots"][0]["raw_text"],
        "whole_list": "\n".join(row["source_lots"][0]["raw_text"] for row in rows),
    }
    _row(tampered, BARE)["source_lots"][0]["raw_text"] = texts[foreign_text]

    metrics, partition = _certificate(tampered)

    # Même nombre de cartes et mêmes URL : seule l'égalité stricte des empreintes arrête ce cas.
    assert (partition["public_unique_urls"], partition["parsed_unique_urls"]) == (3, 3)
    assert (partition["omitted_urls"], partition["extra_urls"]) == ([], [])
    assert partition["reasons"] == [PRODUCTION_REASON]
    assert metrics["coverage_complete"] is False


def test_the_proof_still_refuses_a_card_that_was_not_read() -> None:
    rows = [row for row in parse_licitor_list_sales(_html(), LIST_URL) if row["source_url"] != BARE]

    metrics, partition = _certificate(rows)

    assert "public_announcements_not_parsed" in partition["reasons"]
    assert metrics["coverage_complete"] is False


def test_two_priceless_cards_sharing_one_url_stay_two_distinct_lots() -> None:
    # Deux lots sous une même URL (même nature, même commune), tous deux sans prix : aucune carte ne lit l'autre.
    card = (
        '<li><a class="Ad" href="/annonce/90/00/03/vente-aux-encheres/un-parking/exempleville/isere/900003.html">'
        '<p class="Location"><span class="Number">38</span><span class="City">Exempleville</span></p>'
        '<p class="Description"><span class="Name">Un parking</span><span class="Text">Lot n°{}</span></p>'
        '<div class="Footer"><div class="Price"><p class="Initial"></p></div></div></a></li>'
    )
    html = (
        '<article><p>Trier par : Mise à prix</p><p>2 annonces</p><ul class="AdResults">'
        + card.format(58) + card.format(59) + "</ul></article>"
    )

    rows = parse_licitor_list_sales(html, LIST_URL)

    assert len(rows) == 1
    assert [lot["raw_text"] for lot in rows[0]["source_lots"]] == [
        "38\nExempleville\nUn parking\nLot n°58", "38\nExempleville\nUn parking\nLot n°59"]
    assert rows[0]["starting_price_eur"] is None
    metrics, partition = _certificate(rows, html)
    assert partition["reasons"] == [] and metrics["coverage_complete"] is True


# Suites dans la collecte : la fiche fournit la mise à prix du lot ; rien ne vient d'une carte voisine.
_LOT_BLOCK = """
<section class="AddressBlock"><div class="Lot"><h1>{label}</h1>
 <div class="FirstSousLot SousLot"><h2>{title}</h2><p>en nature de pré</p></div>
 <h3>Mise à prix : {price}</h3></div>
 <div class="Location"><p class="City">{city}</p><p class="Street">Lieudit {place}</p>
 <p class="Map"><a class="Button" href="https://maps.google.fr/maps?q={point}&amp;z=13">Afficher le plan</a></p></div>
</section>
"""


def _detail(number: str, headline: str, lots: str, kind: str = "Vente aux enchères publiques") -> str:
    return f"""<html><body>
<div class="Search" id="legalad-search"><h1>Annonce n°{number} : {headline}</h1></div>
<article class="LegalAd"><div class="Container"><div class="AdContent" id="ad-{number}">
<p class="PublishingDate">Annonce publiée le <time>10 novembre 2026</time></p>
<p class="Number">{number}</p>
<p class="Court">Tribunal Judiciaire de Grenoble (Isère)</p>
<p class="Type">{kind}</p>
<p class="Date"><time datetime="2027-01-12T14:00:00">mardi 12 janvier 2027 à 14h</time></p>
{lots}
<div class="Trusts"><div class="Trust"><h3>Maître Jeanne Exemple, Avocat</h3><p>1, rue du Palais - 38000 Grenoble</p></div></div>
</div></div></article><p>Imprimer</p></body></html>"""


def _two_lot_detail(first_city: str) -> str:
    return _detail(
        "900002",
        f"deux parcelles de terrain à {first_city} (Isère), mise à prix : 3 000 €",
        _LOT_BLOCK.format(label="1er lot", title="Deux parcelles de terrain", price="3 000 €", city=first_city,
                          place="Le Pré Fictif", point="45.5000000,5.3000000")
        + _LOT_BLOCK.format(label="2ème lot", title="Sept parcelles de terrain", price="8 500 €", city="Champ-Modèle",
                            place="Le Champ Fictif", point="45.6000000,5.4000000"),
        kind="Vente aux enchères publiques en deux lots",
    )


_SINGLE_LOT_DETAIL = _detail(
    "900001",
    "un appartement à Exempleville (Isère), mise à prix : 150 000 €",
    _LOT_BLOCK.format(label="", title="Un appartement", price="150 000 €", city="Exempleville", place="Le Bourg",
                      point="45.4000000,5.2000000").replace("<h1></h1>", ""),
)


class _RecordedSite:
    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = pages

    def get(self, url: str) -> str:
        return self.pages[url]


def _collect(monkeypatch, two_lot_detail: str):
    pages = {LIST_URL: _html(), PRICED_NEIGHBOUR: _SINGLE_LOT_DETAIL, BARE: two_lot_detail, PRICED_SIBLING: two_lot_detail}
    monkeypatch.delenv(licitor.SOURCE_BUDGET_ENV, raising=False)
    monkeypatch.setattr(licitor, "LicitorClient", lambda **kwargs: _RecordedSite(pages))
    monkeypatch.setattr(licitor, "_start_urls_for_target_departments", lambda: (LIST_URL,))
    monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("38",))
    return licitor.scrape_licitor_aquitaine_result(max_pages=1)


def test_collection_reads_the_price_of_a_priceless_card_on_its_detail_page(monkeypatch) -> None:
    result = _collect(monkeypatch, _two_lot_detail("Saint-Fictif-du-Test"))

    assert result.errors == []
    assert result.coverage["coverage_complete"] is True
    assert [sale["source_url"] for sale in result.sales] == [PRICED_NEIGHBOUR, BARE, PRICED_SIBLING]
    bare = _row(result.sales, BARE)
    # Le lot de l'URL, désigné par la commune de l'URL et confirmé par sa propre carte : sa mise à prix vient
    # de la fiche (la carte n'en affiche pas), jamais d'une autre carte ni d'un autre lot.
    selection = bare["source_lot_selection"]
    assert (selection["status"], selection["lot_number"], selection["reason"]) == ("selected", 1, "url_city+listing_card")
    assert (bare["department"], bare["city"], bare["title"]) == ("38", "Saint-Fictif-du-Test", "Deux parcelles de terrain")
    assert bare["starting_price_eur"] == "3 000 €"
    assert bare["source_blocks"]["mise_a_prix"] == "3 000 €"
    # Carte et blocs de source : le texte de la seule carte, plus celui des annonces voisines.
    assert bare["source_lots"] == [
        {"raw_text": BARE_CARD_TEXT, "title": "Deux parcelles de terrain", "starting_price_eur": None}
    ]
    assert bare["source_blocks"]["lots_publics"] == BARE_CARD_TEXT
    assert "Exempleville" not in bare["raw_text"] and "150 000" not in bare["raw_text"]
    sale = normalize_sale(bare)
    assert (sale.city, int(sale.starting_price_eur)) == ("Saint-Fictif-du-Test", 3000)
    assert quarantine_reason(sale) is None
    sibling = _row(result.sales, PRICED_SIBLING)
    assert (sibling["city"], sibling["starting_price_eur"], sibling["source_lot_selection"]["lot_number"]) == (
        "Champ-Modèle", "8 500 €", 2)


def test_collection_leaves_the_price_empty_when_the_detail_page_cannot_name_the_lot(monkeypatch) -> None:
    # La fiche situe le premier lot dans une commune qui n'est pas celle de l'URL : le lot reste incertain.
    result = _collect(monkeypatch, _two_lot_detail("Autre-Commune-Fictive"))

    assert result.coverage["coverage_complete"] is True
    bare = _row(result.sales, BARE)
    assert bare["source_lot_selection"]["status"] == "ambiguous"
    # Ni la mise à prix de la carte voisine (150 000 €), ni celle d'un autre lot de la fiche (3 000 €, 8 500 €).
    assert bare["starting_price_eur"] is None
    assert "mise_a_prix" not in bare["source_blocks"]
    # La commune et le titre repris de la liste sont ceux de sa propre carte.
    assert (bare["department"], bare["city"], bare["title"]) == ("38", "Saint-Fictif-du-Test", "Deux parcelles de terrain")
    assert bare["source_blocks"]["lots_publics"] == BARE_CARD_TEXT
    sale = normalize_sale(bare)
    assert sale.starting_price_eur is None
    assert quarantine_reason(sale) == LICITOR_MULTI_LOT_QUARANTINE


# Cartes ordinaires, annonces à plusieurs lots, pagination : mêmes ventes qu'avant le correctif.
_RESULT_CARD = """
<div class="Result">
  <a href="/annonce/10/91/27/vente-aux-encheres/trois-appartements/paris-2eme/paris/109127.html">
    <span>75</span><span>Paris 2ème</span><strong>Trois appartements</strong>
    <p>dans le bâtiment A, au 2ème, 3ème et 4ème étage</p>
    <span>Mise à prix :</span><span>82 610 €</span><time>Mercredi 10 juin</time>
  </a>
</div>
"""
_LOTS_SHARING_ONE_URL = '<p>2 annonces</p><ul class="AdResults">' + "".join(
    f'<li><a class="Ad" href="/annonce/parking/109985.html"><p><span>33</span><span>Villenave</span></p>'
    f"<p>Un parking</p><p>Lot n°{lot}</p><p>Mise à prix : 4 000 €</p></a></li>"
    for lot in (58, 59)
) + "</ul>"
_PRICE_BESIDE_THE_LINK = "".join(
    f'<div class="Result"><a href="/annonce/10/86/{number}/vente-aux-encheres/une-maison/{slug}/gironde/1086{number}.html">'
    f"<span>33</span><span>{city}</span><strong>Une maison</strong></a><p>Mise à prix : {price}</p></div>"
    for number, slug, city, price in (("25", "merignac", "Mérignac", "200 000 €"), ("26", "pessac", "Pessac", "90 000 €"))
)
_PAGINATED = (
    '<a href="/ventes-aux-encheres-immobilieres/sud-est-mediterrannee/prochaines-ventes.html?p=2">2</a>'
    '<a href="/ventes-aux-encheres-immobilieres/sud-est-mediterrannee/prochaines-ventes.html?p=3" rel="last">3</a>'
    + _RESULT_CARD
)


def _existing_layouts() -> dict[str, str]:
    return {
        "capture_2026_10_02": CAPTURE.read_text(encoding="utf-8"),
        "result_card": _RESULT_CARD,
        "lots_sharing_one_url": _LOTS_SHARING_ONE_URL,
        "price_beside_the_link": _PRICE_BESIDE_THE_LINK,
        "paginated": _PAGINATED,
    }


@pytest.mark.parametrize(
    "layout", ["capture_2026_10_02", "result_card", "lots_sharing_one_url", "price_beside_the_link", "paginated"]
)
def test_existing_licitor_lists_give_exactly_the_same_sales_as_before(layout: str, monkeypatch) -> None:
    html = _existing_layouts()[layout]
    after = parse_licitor_list_sales(html, LIST_URL)
    links_after = parse_licitor_list_html(html, LIST_URL)
    monkeypatch.setattr(licitor, "_list_item_container", _container_before_fix)

    assert after == parse_licitor_list_sales(html, LIST_URL)
    assert links_after == parse_licitor_list_html(html, LIST_URL)
    # Aucune de ces listes n'a de carte sans prix : la comparaison porte bien sur des cartes lues en entier.
    assert after and all(row["starting_price_eur"] for row in after)


def test_existing_layouts_keep_their_known_values() -> None:
    layouts = _existing_layouts()

    capture = parse_licitor_list_sales(layouts["capture_2026_10_02"], LIST_URL)
    assert len(capture) == 5 and len({row["source_url"] for row in capture}) == 5
    assert all(len(row["source_lots"]) == 1 for row in capture)
    shared = parse_licitor_list_sales(layouts["lots_sharing_one_url"], LIST_URL)
    assert len(shared) == 1 and len(shared[0]["source_lots"]) == 2
    beside = parse_licitor_list_sales(layouts["price_beside_the_link"], LIST_URL)
    assert [(row["city"], row["starting_price_eur"]) for row in beside] == [
        ("Mérignac", "200 000 €"), ("Pessac", "90 000 €")]
    details, next_urls = parse_licitor_list_html(layouts["paginated"], LIST_URL)
    assert len(details) == 1 and [url.rsplit("=", 1)[1] for url in next_urls] == ["2", "3"]
