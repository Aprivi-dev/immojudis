"""Annonce Licitor en plusieurs lots : la vente d'une URL décrit le lot de cette URL, jamais d'office le premier.

Fiche réelle (tests/fixtures/licitor_fiche_deux_lots_cannes_le_cannet.html, téléchargée le 03/11/2026) :
annonce 110462, deux lots dans deux blocs ``.AddressBlock`` (« 1er lot » Cannes, « 2ème lot » Le Cannet),
joignables par deux URL qui ne diffèrent que par la commune. Les deux lignes publiées affichaient Cannes,
90 000 € et la désignation du lot 1 (24d214e0 et 077acb2a).
"""

import copy
from pathlib import Path

import pytest

from src import main
from src.admission import LICITOR_MULTI_LOT_QUARANTINE, quarantine_reason
from src.normalize import normalize_sale
from src.publication_identity import conflicting_identity
from src.recompute_scoring import _recomputed_sale_from_storage_row
from src.sources.licitor import parse_licitor_detail_html
from src.sources.licitor_extraction import refresh_licitor_raw_sale
from tests.test_licitor_extraction import DETAIL_HTML, URL

FIXTURE = Path(__file__).parent / "fixtures" / "licitor_fiche_deux_lots_cannes_le_cannet.html"
BASE = "https://www.licitor.com/annonce/11/04/62/vente-aux-encheres/un-appartement/{}/alpes-maritimes/110462.html"
CANNES, LE_CANNET = BASE.format("cannes"), BASE.format("le-cannet")
# Cartes de la liste publique, telles que stockées dans raw_payload.source_lots.
CARDS = {
    CANNES: "06\nCannes\nUn appartement\nde 63,05 m², au 1er étage, de trois pièces Cave au sous-sol Mansarde au "
    "4ème étage Occupé\nMise à prix :\n90 000 €",
    LE_CANNET: "06\nLe Cannet\nUn appartement\nde 70,78 m², de quatre pièces Cave au sous-sol Occupé\nMise à prix :\n80 000 €",
}
EXPECTED = {
    CANNES: {
        "city": "Cannes",
        "starting_price_eur": "90 000 €",
        "surface_m2": "63.05",
        "address": "37, rue du Docteur Calmette, Cannes",
        "description": "Un appartement. de 63,05 m², au 1er étage, de trois pièces Cave au sous-sol Mansarde au 4ème "
        "étage Occupé",
        "visit_dates": ["Visites sur place mercredi 18 novembre 2026 de 9h30 à 10h30 et lundi 23 novembre 2026 de 14h à 15h"],
        "latitude": "43.5723152",
        "longitude": "7.0063429",
        "lot_number": 1,
    },
    LE_CANNET: {
        "city": "Le Cannet",
        "starting_price_eur": "80 000 €",
        "surface_m2": "70.78",
        "address": "Les Cèdres, 4, av. Dolce Farniente, Le Cannet",
        "description": "Un appartement. de 70,78 m², de quatre pièces Cave au sous-sol Occupé",
        "visit_dates": ["Visites sur place mercredi 18 novembre 2026 de 11h à 12h et lundi 23 novembre 2026 de 15h30 à 16h30"],
        "latitude": "43.5663605",
        "longitude": "7.0215516",
        "lot_number": 2,
    },
}


def _html() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def _cards(*urls: str) -> list[dict[str, str]]:
    return [{"title": "Un appartement", "raw_text": CARDS[url]} for url in urls]


@pytest.mark.parametrize("url", [CANNES, LE_CANNET])
@pytest.mark.parametrize("with_listing_card", [False, True])
def test_each_lot_url_of_the_real_two_lot_page_reads_its_own_lot(url: str, with_listing_card: bool) -> None:
    raw = parse_licitor_detail_html(_html(), url, _cards(url) if with_listing_card else None)

    expected = EXPECTED[url]
    for key in ("city", "starting_price_eur", "surface_m2", "address", "description", "visit_dates", "latitude",
                "longitude"):
        assert raw[key] == expected[key], key
    assert raw["title"] == "Un appartement"
    assert raw["occupancy_status"] == "occupied"
    # Champs communes aux lots : la page entière.
    assert raw["sale_date"] == "jeudi 3 décembre 2026 à 9h"
    assert raw["tribunal"].startswith("Tribunal Judiciaire de Grasse")
    assert raw["lawyer_name"] == "Maître Laurence Sportes, Avocat"
    assert raw["source_blocks"]["mise_a_prix"] == expected["starting_price_eur"]
    selection = raw["source_lot_selection"]
    assert (selection["status"], selection["lot_number"], selection["lot_count"]) == ("selected", expected["lot_number"], 2)
    assert raw["source_property_features"]["procedure"]["visits"] == expected["visit_dates"]


def test_normalized_lots_are_published_with_their_own_values_and_never_another_lots_rooms() -> None:
    cannes = normalize_sale(parse_licitor_detail_html(_html(), CANNES, _cards(CANNES)))
    cannet = normalize_sale(parse_licitor_detail_html(_html(), LE_CANNET, _cards(LE_CANNET)))

    assert (cannes.city, int(cannes.starting_price_eur), float(cannes.surface_m2)) == ("Cannes", 90000, 63.05)
    assert (cannet.city, int(cannet.starting_price_eur), float(cannet.surface_m2)) == ("Le Cannet", 80000, 70.78)
    # « quatre pièces » est le lot 2 : le lot 1 (« de trois pièces », non lu) restait affiché à 4 pièces.
    assert cannes.rooms_count is None
    assert cannet.rooms_count == 4
    for sale in (cannes, cannet):
        assert "multi_lot_sale" in sale.quality_flags  # pièces jointes communes aux deux lots
        assert quarantine_reason(sale) is None


def test_single_lot_page_is_read_exactly_as_before() -> None:
    plain = parse_licitor_detail_html(DETAIL_HTML, URL)
    with_card = parse_licitor_detail_html(DETAIL_HTML, URL, [{"raw_text": "75\nParis 16ème\nUn appartement\nMise à prix :\n1 €"}])

    assert "source_lot_selection" not in plain
    assert "lot_vendu" not in plain["source_blocks"]
    assert (plain["city"], plain["starting_price_eur"], plain["surface_m2"]) == ("Paris 16ème", "300 000 €", "61.40")
    assert plain["address"] == "10, rue de l'Exemple, 75016 Paris 16ème"
    assert (plain["latitude"], plain["longitude"]) == ("48.8600000", "2.2800000")
    with_card.pop("source_lots")
    assert with_card == plain


def test_a_url_naming_no_lot_leaves_every_lot_field_empty_and_stays_quarantined() -> None:
    url = BASE.format("antibes")
    raw = parse_licitor_detail_html(_html(), url)

    assert raw["source_lot_selection"]["status"] == "ambiguous"
    for key in ("city", "address", "starting_price_eur", "surface_m2", "description", "rooms_count", "occupancy_status",
                "latitude", "longitude"):
        assert raw[key] is None, key
    for block in ("mise_a_prix", "description", "ville", "adresse", "surface", "occupation"):
        assert block not in raw["source_blocks"], block
    sale = normalize_sale(raw)
    assert sale.starting_price_eur is None and sale.city is None and sale.surface_m2 is None
    assert quarantine_reason(sale) == LICITOR_MULTI_LOT_QUARANTINE


def _same_city_page() -> str:
    # Les deux lots dans la même commune et de même nature : Licitor les publie sous une seule URL.
    return _html().replace('<p class="City">Le Cannet', '<p class="City">Cannes')


def test_two_lots_behind_one_url_abstain_but_keep_what_they_share() -> None:
    raw = parse_licitor_detail_html(_same_city_page(), CANNES, _cards(CANNES, LE_CANNET))

    assert raw["source_lot_selection"]["reason"] == "several_lots_match_url"
    assert raw["city"] == "Cannes"  # commune des deux lots
    assert raw["starting_price_eur"] is None and raw["description"] is None and raw["address"] is None
    assert raw["visit_dates"] == EXPECTED[CANNES]["visit_dates"] + EXPECTED[LE_CANNET]["visit_dates"]


def test_the_listing_card_of_the_url_picks_the_lot_when_the_url_names_two() -> None:
    card = [{"raw_text": CARDS[LE_CANNET].replace("Le Cannet", "Cannes")}]
    raw = parse_licitor_detail_html(_same_city_page(), CANNES, card)

    assert raw["source_lot_selection"]["lot_number"] == 2
    assert (raw["starting_price_eur"], raw["surface_m2"]) == ("80 000 €", "70.78")


def test_a_listing_card_contradicting_the_url_abstains() -> None:
    raw = parse_licitor_detail_html(_html(), LE_CANNET, _cards(CANNES))

    assert raw["source_lot_selection"]["reason"] == "listing_card_conflict"
    assert raw["starting_price_eur"] is None and raw["city"] is None


def _stored_first_lot_row(url: str, cards: list[dict[str, str]]) -> dict:
    """Ligne stockée par l'ancienne lecture : valeurs du premier lot pour toutes les URL, point géocodé à Cannes."""
    raw = parse_licitor_detail_html(_html(), CANNES)
    raw.pop("source_lot_selection")
    raw.update(source_url=url, source_lots=cards, rooms_count=4)
    sale = normalize_sale(raw)
    sale.raw_payload["geocode"] = {"provider": "ban_geoplateforme", "accepted": True, "type": "housenumber",
                                   "query": "37, rue du Docteur Calmette, Cannes", "citycode": "06029",
                                   "latitude": 43.557814, "longitude": 7.022106}
    row = sale.to_storage_dict(exclude_none=False)
    row.update(id="077acb2a", raw_payload=copy.deepcopy(sale.raw_payload), quality_flags=[])
    assert (row["city"], row["starting_price_eur"]) == ("Cannes", 90000.0)
    return row


def test_recompute_repairs_a_row_stored_with_the_first_lots_values() -> None:
    sale = _recomputed_sale_from_storage_row(_stored_first_lot_row(LE_CANNET, _cards(LE_CANNET)))

    assert (sale.city, int(sale.starting_price_eur), float(sale.surface_m2)) == ("Le Cannet", 80000, 70.78)
    assert sale.address == "Les Cèdres, 4, av. Dolce Farniente, Le Cannet"
    assert sale.description == EXPECTED[LE_CANNET]["description"]
    assert sale.visit_dates == EXPECTED[LE_CANNET]["visit_dates"]
    # Le point et le géocodage étaient ceux de l'adresse de Cannes : retirés, à refaire.
    assert sale.latitude is None and "geocode" not in sale.raw_payload
    assert quarantine_reason(sale) is None


def test_recompute_keeps_the_first_lot_row_and_its_position() -> None:
    sale = _recomputed_sale_from_storage_row(_stored_first_lot_row(CANNES, _cards(CANNES)))

    assert (sale.city, int(sale.starting_price_eur), sale.rooms_count) == ("Cannes", 90000, None)
    assert sale.raw_payload["geocode"]["citycode"] == "06029"


def test_recompute_keeps_an_uncertain_lot_in_quarantine() -> None:
    row = _stored_first_lot_row(CANNES, _cards(CANNES, LE_CANNET))
    row["raw_payload"]["source_blocks"]["page_text"] = row["raw_payload"]["source_blocks"]["page_text"].replace(
        "Le Cannet", "Cannes"
    )

    sale = _recomputed_sale_from_storage_row(row)

    # « multi_lot_sale » était perdu au recalcul : la quarantaine des lots incertains se levait.
    assert "multi_lot_sale" in sale.quality_flags
    assert quarantine_reason(sale) == LICITOR_MULTI_LOT_QUARANTINE
    assert sale.starting_price_eur is None


def test_reading_the_url_lot_is_not_an_identity_conflict_with_the_old_first_lot_reading() -> None:
    old_row = _stored_first_lot_row(LE_CANNET, _cards(LE_CANNET))
    existing = normalize_sale({**old_row["raw_payload"], **{k: v for k, v in old_row.items() if k != "raw_payload"}})
    incoming = normalize_sale(parse_licitor_detail_html(_html(), LE_CANNET, _cards(LE_CANNET)))

    assert not conflicting_identity(existing, incoming)
    # Une ligne déjà lue lot par lot garde la règle ordinaire : une autre adresse est un conflit.
    relabelled = incoming.model_copy(deep=True)
    relabelled.address = "37, rue du Docteur Calmette, Cannes"
    assert conflicting_identity(relabelled, incoming)


def test_a_known_geocode_of_another_commune_is_not_carried_over() -> None:
    known_payload = {"geocode": {"query": "37, rue du Docteur Calmette, Cannes", "citycode": "06029"}}
    sale = {"source_url": LE_CANNET, "city": "Le Cannet", "source_detail_status": "complete"}
    main._preserve_known_enrichment_payloads([sale], {LE_CANNET: {"city": "Cannes", "raw_payload": known_payload}})
    assert "geocode" not in sale

    same_commune = {"source_url": CANNES, "city": "Cannes", "source_detail_status": "complete"}
    main._preserve_known_enrichment_payloads([same_commune], {CANNES: {"city": "Cannes", "raw_payload": known_payload}})
    assert same_commune["geocode"] == known_payload["geocode"]


# Annonce 110285 (texte de page stocké, 03/11/2026) : quatre lots dans quatre communes ; la situation des lots 2
# et 3 (« Saint-Pargoire », « Vendémian ») n'est pas suivie de « Afficher le plan » et n'est pas reconnue.
FOUR_LOTS_TEXT = """Accueil
Annonce n°110285 : diverses parcelles de terres à Saint-Pons-de-Mauchiens (Hérault), mise à prix : 6 000 €
Annonce publiée le
14 octobre 2026
110285
Tribunal Judiciaire de Montpellier (Hérault)
Vente aux enchères publiques en quatre lots
lundi 9 novembre 2026 à 14h
1er lot
Diverses parcelles de terres
en nature de vignes
Mise à prix : 6 000 €
Saint-Pons-de-Mauchiens
Les Hisserts et
Pioch Blanc
2ème lot
Diverses parcelles
en nature de vignes et landes
Mise à prix : 20 000 €
Saint-Pargoire
Lieudit Prat del Monseigne
3ème lot
Diverses parcelles
en nature de vignes et landes
Mise à prix : 10 000 €
Vendémian
Les Prades
4ème lot
Diverses parcelles
en nature de vignes et landes
Mise à prix : 10 000 €
Plaissan
Le Puech Delvas
Visite(s) sur place :
mercredi 21 octobre 2026 à 14h, devant la mairie de Saint-Pargoire
Maître Pascal Exemple, Avocat
Imprimer
"""
FOUR_LOTS_URL = "https://www.licitor.com/annonce/11/02/85/vente-aux-encheres/{}/{}/herault/110285.html"


@pytest.mark.parametrize(
    ("nature", "city", "card", "expected"),
    [
        ("diverses-parcelles-de-terres", "saint-pons-de-mauchiens", "Saint-Pons-de-Mauchiens\nDiverses parcelles de terres\nMise à prix :\n6 000 €", ("Saint-Pons-de-Mauchiens", "6 000 €")),
        ("diverses-parcelles", "plaissan", "Plaissan\nDiverses parcelles\nMise à prix :\n10 000 €", ("Plaissan", "10 000 €")),
        # Situation illisible : ni la commune de Plaissan (lot suivant) ni aucune valeur d'un autre lot.
        ("diverses-parcelles", "saint-pargoire", "Saint-Pargoire\nDiverses parcelles\nMise à prix :\n20 000 €", (None, None)),
        ("diverses-parcelles", "vendemian", "Vendémian\nDiverses parcelles\nMise à prix :\n10 000 €", (None, None)),
    ],
)
def test_stored_page_text_of_a_four_lot_sale_is_read_lot_by_lot_or_not_at_all(nature, city, card, expected) -> None:
    raw = {"source_name": "licitor", "source_url": FOUR_LOTS_URL.format(nature, city),
           "source_lots": [{"raw_text": f"34\n{card}"}], "source_blocks": {"page_text": FOUR_LOTS_TEXT},
           "city": "Saint-Pons-de-Mauchiens", "starting_price_eur": "6 000 €"}

    assert refresh_licitor_raw_sale(raw) is True
    assert (raw["city"], raw["starting_price_eur"]) == expected
