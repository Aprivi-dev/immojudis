"""Public syntheses that contradicted the canonical facts (production audit of 03/11/2026).

Every text below was published on immojudis before this guard; the sale id
prefix is given for each. Field values are those of the sale in production. The
same checks now guard the model's summary before it replaces a description.
"""

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from src.enrichment import display_consistency
from src.enrichment.display_evidence import verify_display_claims
from src.enrichment.display_facts import sale_nature

AGORASTORE_LISTING = (
    "Ensemble Immobilier Pouilly En Auxois Avec Logements Et Dépendances. Surface cadastrale: 2830 m². "
    "Procédure de vente par Vente par enchères en ligne Commentaire : Vente aux enchères sur le site internet "
    "Agorastore. Type de vente Vente par enchères en ligne"
)
STATE_AUCTION = {
    "source_name": "cessions_etat",
    "sale_venue_type": "state",
    "sale_legal_framework": "state_sale",
    "sale_verification_status": "cross_checked",
}


@pytest.fixture(autouse=True)
def audit_day(monkeypatch):
    monkeypatch.setattr(display_consistency, "_today", lambda: date(2026, 11, 3))


def codes(text, evidence="", **fields):
    return {issue["code"] for issue in verify_display_claims(text, evidence, fields)["issues"]}


# --- Surfaces -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sale_id,text,evidence,fields",
    [
        (
            "4a791649",  # avoventes: the 19,27 m² flat of another lot; the surface field holds 138,98 m².
            "Appartement situé à Saint-Denis (93200). La vente est prévue le 10/11/2026 pour un prix de 20 000 €. "
            "Le bien dispose d'une surface de 19,27 m², comprenant 3 pièces, 2 chambres et 1 salle d'eau.",
            "Bâtiment F : UN LOGEMENT de 19,27 m2, à la suite du 133ème lot.",
            {"property_type": "apartment", "surface_m2": Decimal("138.98"), "rooms_count": 3, "bedrooms_count": 2},
        ),
        (
            "8ff95700",  # info_encheres: the first bedroom, « Surface: 10,5m2 », for a 79,40 m² house.
            "Maison à Clarac (31210). Surface habitable retenue de 10,5 m², terrain de 1932 m².",
            "PREMIERE CHAMBRE ANGLE NORD-EST Surface: 10,5m2. SUPERFICIE DE LA MAISON : 79,40 m2. Terrain 1932 m².",
            {"property_type": "house", "surface_m2": Decimal("79.4"), "land_surface_m2": Decimal("1932")},
        ),
        (
            "cd6ae09e",  # encheres_immobilieres: the caretaker's flat instead of the 345,7 m² house.
            "Appartement à Cannes (06400). Mise à prix : 3 500 000 €. Surface retenue : 23,6 m² (loi Carrez).",
            "PROPRIÉTÉ composé de Maison d’habitation de 345,7m², Appartement gardien de 23,6 m² et Piscine",
            {"property_type": "apartment", "surface_m2": Decimal("345.7"), "starting_price_eur": Decimal("3500000")},
        ),
        (
            "64bf9b2f",  # licitor: the CCV's « environ 130m2 » against the listing's 125,50 m².
            "Maison à Noth (23). Le bien dispose d'une surface habitable de 130 m² sur un terrain de 1789 m².",
            "maison d’une superficie d'environ 130m2. Surface habitable 125,50 m². Terrain 1789 m².",
            {"property_type": "house", "surface_m2": Decimal("125.5"), "land_surface_m2": Decimal("1789")},
        ),
        (
            "44d67b3e",  # cessions_etat: 336 m² of land on a 2 830 m² plot.
            "Immeuble situé à Pouilly-en-auxois (21). Le bien dispose d'une surface de terrain de 336 m².",
            "Surface cadastrale: 2830 m². Bâtiment de 336 m².",
            {"property_type": "building", "land_surface_m2": Decimal("2830")},
        ),
    ],
)
def test_an_area_that_is_not_a_canonical_surface_is_rejected(sale_id, text, evidence, fields):
    assert "area_contradicts_canonical" in codes(text, evidence, **fields), sale_id


def test_figures_without_a_field_or_a_source_are_rejected():
    # 1d0262fa (info_encheres): four flats (74,59 / 68,85 / 50,76 / 50,48 m²); no land field, no « 21 chambres ».
    text = (
        "Ensemble mixte situé à Lannemezan (65300) faisant l'objet d'une vente judiciaire aux enchères le 10/12/2026 "
        "avec une mise à prix de 100 000 €. La surface retenue est de 74,59 m² (bâtie ou de plancher) sur un terrain "
        "de 12,6 m². Le bien comprend 21 chambres."
    )
    evidence = "Appartements de 74,59 m², 68,85 m², 50,76 m² et 50,48 m². Mise à prix : 100 000 €. Vente le 10/12/2026."
    found = codes(
        text, evidence, property_type="mixed", surface_m2=Decimal("74.59"), starting_price_eur=Decimal("100000")
    )
    assert {"unsupported_area", "unsupported_bedrooms"} <= found
    # A land figure is compared with the land field once there is one.
    assert "area_contradicts_canonical" in codes(
        text, evidence, property_type="mixed", surface_m2=Decimal("74.59"), land_surface_m2=Decimal("1260")
    )


def test_a_built_figure_without_a_built_field_only_needs_the_source():
    # 41af2124 (licitor): « Une maison de 410,27 m² » while only the land field (1 535 m²) is filled.
    text = "Immeuble situé à Marignier (74970). Le bien offre une surface habitable de 410,27 m² sur un terrain de 1535 m²."
    fields = {"property_type": "building", "land_surface_m2": Decimal("1535")}
    assert not codes(text, "Une maison de 410,27 m². Terrain de 1535 m².", **fields)


def test_built_area_presented_as_land_is_rejected_even_when_the_land_field_holds_it():
    # ebafd1c4 (avoventes): land_surface_m2 = 259,86 although the listing says « surface bâtie ».
    text = (
        "Maison à Wassy (52130) proposée en vente judiciaire aux enchères le 05/11/2026 avec une mise à prix de "
        "39 000 €. Le bien dispose d'une surface de terrain de 259,86 m², comprend 6 pièces dont 4 chambres."
    )
    evidence = "UNE MAISON • 259,86m². Le tout représente une surface bâtie de 259,86 m² et cadastré : Section AD n°168"
    fields = {"property_type": "house", "land_surface_m2": Decimal("259.86"), "rooms_count": 6, "bedrooms_count": 4}
    assert "area_kind_mismatch" in codes(text, evidence, **fields)


def test_habitable_area_on_bare_land_is_rejected():
    # d788c7bd (info_encheres): 101,3 m² copied from lot 1 onto a lot of unbuilt plots.
    text = (
        "Terrain à Millery (69390). Mise à prix : 380 000 €. Surface retenue : 101,3 m² habitable. Le bien est occupé."
    )
    fields = {"property_type": "land", "surface_m2": Decimal("101.3"), "occupancy_status": "occupied"}
    assert "area_kind_mismatch" in codes(text, "Lot 1 : maison de 101,3 m² habitable.", **fields)


def test_canonical_and_annex_areas_still_pass():
    fields = {"property_type": "house", "surface_m2": Decimal("125.8"), "land_surface_m2": Decimal("1001")}
    evidence = "maison de 125,80 m² comprenant : 1 salon séjour (42,69 m²), 1 cave de 8 m². Terrain de 1001 m²."
    text = (
        "Maison d'une surface habitable de 126 m² sur un terrain de 1001 m², avec un séjour de 42,69 m² "
        "et une cave de 8 m²."
    )
    assert not {c for c in codes(text, evidence, **fields) if c.startswith("area")}


# --- Rooms, bedrooms, parking ---------------------------------------------------------------


@pytest.mark.parametrize(
    "sale_id,text,fields",
    [
        # 5a3acacb (info_encheres): « 2 chambres » of another lot on a plot of coppice.
        (
            "5a3acacb",
            "Terrain de 919 m² situé à Saint Leon Sur L’Isle (24110). Le bien comprend 2 chambres.",
            {"property_type": "land", "land_surface_m2": Decimal("919")},
        ),
        # c1763ece (cessions_etat): a 27 044 m² wood « composé d'une pièce » (rooms_count = 1 in production).
        (
            "c1763ece",
            "Terrain de 27044 m² situé à Pessines (17). Cette cession immobilière de l'État concerne un "
            "bien libre composé d'une pièce.",
            {"property_type": "land", "land_surface_m2": Decimal("27044"), "rooms_count": 1},
        ),
        # b78b6c23 (cessions_etat): « Le bien comprend 2 pièces » for an agricultural plot.
        (
            "b78b6c23",
            "Terrain de 1169 m² situé à Saint-Alexandre (30). Le bien comprend 2 pièces.",
            {"property_type": "land", "land_surface_m2": Decimal("1169")},
        ),
    ],
)
def test_room_counts_on_land_are_rejected(sale_id, text, fields):
    assert "count_on_land" in codes(text, text, **fields), sale_id


def test_count_that_contradicts_the_canonical_field_is_rejected():
    # 7e57e2d3 (notaires): the page lists 4 parking spaces; once the field is corrected the
    # published « 5 stationnements » must not survive the revalidation.
    text = (
        "Maison à Grand-Quevilly (76120). Il comprend 7 pièces dont 5 chambres et 1 salle d'eau ou de bain. "
        "Les annexes incluent un jardin, une terrasse, un garage et 5 stationnements."
    )
    fields = {"property_type": "house", "rooms_count": 7, "bedrooms_count": 5, "bathrooms_count": 1, "parking_count": 4}
    found = verify_display_claims(text, text, fields)["issues"]
    assert {"code": "count_contradicts_canonical", "claim": "5 stationnements", "field": "parking_count"} in found
    assert not codes(text.replace("5 stationnements", "4 stationnements"), text, **fields)


def test_counts_spread_over_floors_add_up_to_the_canonical_value():
    text = "Maison avec deux chambres au rez-de-chaussée et deux chambres à l'étage."
    assert "count_contradicts_canonical" not in codes(text, text, property_type="house", bedrooms_count=4)
    assert "count_contradicts_canonical" in codes(text, text, property_type="house", bedrooms_count=3)


def test_one_room_written_with_a_digit_is_a_count():
    # af8649b4 (info_encheres, fallback): « 1 pièce, 1 chambre » with no proof and no field.
    assert "unsupported_rooms" in codes(
        "Les éléments disponibles mentionnent 1 pièce.", "Maison.", property_type="house"
    )


def test_parking_count_needs_the_field_or_the_source():
    text = "Les éléments disponibles mentionnent une annexe ou un équipement : 1 stationnement."
    assert "unsupported_parking" in codes(text, "Maison à Gaas.", property_type="house")
    assert "unsupported_parking" not in codes(text, "Maison avec 1 stationnement.", property_type="house")


# --- Prices and units -------------------------------------------------------------------------


def test_area_written_as_a_price_is_rejected():
    # aa42290d (cessions_etat): no price is known, the model wrote the area after « au prix de ».
    text = (
        "Terrain de 1805 m² situé à Saint-Aubin-du-Cormier (35). Cette cession immobilière de l'État par "
        "adjudication est proposée au prix de 1805 m²."
    )
    fields = {"property_type": "land", "surface_m2": Decimal("1805"), "land_surface_m2": Decimal("1805")}
    assert "unit_mismatch" in codes(text, "Terrain 1 805 m²", **fields)
    assert "unit_mismatch" not in codes("Terrain de 1805 m² situé à Saint-Aubin-du-Cormier (35).", "", **fields)


def test_sale_price_that_contradicts_the_canonical_price_is_rejected():
    # 862bfb81 (agrasc) with the published wording; the source also quotes an older 6 000 € price.
    text = "Cette vente d'un bien confisqué est fixée au 03/12/2026 avec une mise à prix de 6 000 €."
    fields = {
        "source_name": "agrasc",
        "starting_price_eur": Decimal("5540"),
        "sale_date": datetime(2026, 12, 3, tzinfo=UTC),
    }
    assert "price_contradicts_canonical" in codes(text, "ancienne mise à prix 6 000 €", **fields)
    assert "price_contradicts_canonical" not in codes(text.replace("6 000", "5 540"), "", **fields)


# --- Sale procedure ---------------------------------------------------------------------------


def test_adjudication_is_not_written_for_an_online_state_auction():
    # 44d67b3e (cessions_etat): Agorastore online auction stored as state_sale_method = adjudication.
    fields = {
        **STATE_AUCTION,
        "sale_procedure": {"state_sale_method": "adjudication", "participation_mode": "online"},
        "raw_text": AGORASTORE_LISTING,
        "property_type": "building",
    }
    text = (
        "Immeuble situé à Pouilly-en-auxois (21) faisant l'objet d'une cession immobilière de l'État par adjudication."
    )
    assert "procedure_unsupported" in codes(text, AGORASTORE_LISTING, **fields)
    assert sale_nature(fields).label == "cession immobilière de l'État par enchères en ligne"
    assert not codes(text.replace("par adjudication", "par enchères en ligne"), AGORASTORE_LISTING, **fields)


def test_adjudication_named_by_the_listing_is_kept():
    # 9b85bc05 (cessions_etat): « Procédure de vente par Adjudication Date d'adjudication : 18/11/2026 ».
    listing = (
        "Immeuble Bourgeois à Pau Centre Ville. Procédure de vente par Adjudication Date d'adjudication : 18/11/2026"
    )
    fields = {**STATE_AUCTION, "sale_procedure": {"state_sale_method": "adjudication"}, "raw_text": listing}
    assert sale_nature(fields).label == "cession immobilière de l'État par adjudication"
    text = "Local commercial situé à Pau (64) faisant l'objet d'une cession immobilière de l'État par adjudication."
    assert "procedure_unsupported" not in codes(text, listing, **fields)


def test_state_auction_without_method_wording_is_called_an_auction():
    # aa42290d (cessions_etat): « Procédure à venir … Commentaire : Vente aux enchères ».
    listing = (
        "Vente D'un Terrain Situé à Saint-aubin-du-cormier (35). Procédure à venir. Commentaire : Vente aux enchères."
    )
    fields = {**STATE_AUCTION, "sale_procedure": {"state_sale_method": "adjudication"}, "raw_text": listing}
    assert sale_nature(fields).label == "cession immobilière de l'État aux enchères"
    text = "Terrain situé à Saint-Aubin-du-Cormier (35). Cette cession immobilière de l'État par adjudication."
    assert "procedure_unsupported" in codes(text, listing, **fields)


def test_tender_is_not_invented_for_a_judicial_sale():
    text = "Maison à Noth (23) vendue par appel d'offres."
    fields = {"source_name": "licitor", "sale_venue_type": "tribunal", "raw_text": "Vente aux enchères publiques."}
    assert "procedure_unsupported" in codes(text, "", **fields)


# --- Tense, jargon, pasted citations ----------------------------------------------------------


def test_past_participle_before_a_coming_sale_is_rejected():
    # ab1426da (avoventes), sale on 19/11/2026.
    text = "Appartement à Antony (92160) vendu le 19/11/2026 au prix de 90 000 €. Le bien est occupé."
    fields = {
        "property_type": "apartment",
        "starting_price_eur": Decimal("90000"),
        "occupancy_status": "occupied",
        "sale_date": datetime(2026, 11, 19, 13, 30, tzinfo=UTC),
    }
    assert "past_tense_future_sale" in codes(text, "", **fields)
    proposed = "Appartement à Antony (92160) proposé le 19/11/2026 au prix de 90 000 €. Le bien est occupé."
    assert not codes(proposed, "", **fields)


def test_past_participle_after_the_sale_date_is_correct(monkeypatch):
    monkeypatch.setattr(display_consistency, "_today", lambda: date(2026, 11, 20))
    assert "past_tense_future_sale" not in codes("Appartement à Antony vendu le 19/11/2026.", "")


def test_future_and_present_passive_are_not_flagged():
    assert not codes("Maison qui sera vendue le 27/11/2026.", "Vente le 27/11/2026.")
    assert not codes("Il est vendu libre de toute occupation le 03/12/2026.", "Vente le 03/12/2026.")


@pytest.mark.parametrize(
    "text",
    [
        "L'occupation n'est pas précisée dans les faits canoniques.",  # 4ba21142, 9b85bc05, 48a12a89
        "Le champ surface_m2 vaut 120.",
        "Selon NATURE_VENTE, il s'agit d'une vente notariale.",
    ],
)
def test_internal_jargon_is_never_public(text):
    assert "internal_jargon" in codes(text, "")


def test_contradicted_absence_is_rejected():
    text = "Maison à Revel. La surface n'est pas précisée."
    fields = {"surface_m2": Decimal("120")}
    assert "absence_claim_contradicted" in codes(text, "", **fields)


# --- Real accepted syntheses that stay accepted ----------------------------------------------


@pytest.mark.parametrize(
    "sale_id,text,fields",
    [
        (
            "170c63ef",
            "Maison située au Mans (72) proposée dans le cadre d'une cession immobilière de l'État au prix de 75 000 €. "
            "Le bien offre une surface habitable de 118 m² sur un terrain de 1634 m². Il comprend 6 pièces dont "
            "5 chambres et 2 salles d'eau ou de bain, ainsi qu'un garage. Les performances énergétiques sont classées "
            "D en DPE et D en GES. L'occupation est libre.",
            {
                **STATE_AUCTION,
                "property_type": "house",
                "surface_m2": Decimal("118"),
                "land_surface_m2": Decimal("1634"),
                "rooms_count": 6,
                "bedrooms_count": 5,
                "bathrooms_count": 2,
                "parking_count": 1,
                "starting_price_eur": Decimal("75000"),
                "occupancy_status": "vacant",
            },
        ),
        (
            "858c7c78",
            "Local commercial situé à L'Haÿ-les-Roses (94) proposé dans le cadre d'une cession immobilière de l'État "
            "au prix de 1 048 000 €. Le bien dispose d'une surface retenue de 1552 m² (bâtie ou de plancher) sur un "
            "terrain de 19246 m², comprenant 4 pièces et 27 stationnements en annexe. L'occupation est libre.",
            {
                **STATE_AUCTION,
                "property_type": "commercial",
                "surface_m2": Decimal("1552"),
                "land_surface_m2": Decimal("19246"),
                "rooms_count": 4,
                "parking_count": 27,
                "starting_price_eur": Decimal("1048000"),
                "occupancy_status": "vacant",
            },
        ),
        (
            "b6326121",
            "Maison à Guichainville (27930) proposée lors d'une vente judiciaire aux enchères le 07/12/2026 avec une "
            "mise à prix de 200 000 €. Le bien dispose d'une surface habitable de 113,22 m² sur un terrain de 2174 m². "
            "Il comprend 9 pièces dont 4 chambres et 2 salles d'eau ou de bain, ainsi qu'un jardin et un garage.",
            {
                "source_name": "licitor",
                "sale_venue_type": "tribunal",
                "property_type": "house",
                "surface_m2": Decimal("113.22"),
                "land_surface_m2": Decimal("2174"),
                "rooms_count": 9,
                "bedrooms_count": 4,
                "bathrooms_count": 2,
                "starting_price_eur": Decimal("200000"),
                "sale_date": datetime(2026, 12, 7, 9, tzinfo=UTC),
            },
        ),
    ],
)
def test_consistent_published_syntheses_still_pass(sale_id, text, fields):
    assert not display_consistency.consistency_issues(text, text, fields), sale_id
