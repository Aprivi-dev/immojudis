"""Faits lus dans le texte : seulement ceux du bien vendu (audit des 864 ventes en ligne du 03/11/2026).

Les phrases viennent des annonces en ligne. Chaque fait doit (a) parler du bien lui-même, (b) vouloir dire ce que dit
le champ, (c) avoir un sens pour le type de bien ; sinon la case reste vide.
"""

from __future__ import annotations

import pytest

from src.asset_normalization import normalize_asset_features
from src.extraction_profiles import attach_source_property_features, extract_source_property_features
from src.normalize import normalize_sale
from src.text_fact_scope import private_amenity_mentioned, select_unit_floor, unit_floor_claims


def _floor(text: str, property_type: str):
    chosen = select_unit_floor(unit_floor_claims(text, property_type))
    return chosen.value if chosen else None


def _features(description: str, property_type: str, **extra) -> dict:
    return extract_source_property_features({"description": description, **extra}, property_type=property_type)["fields"]


# --- Étage ---------------------------------------------------------------------------------------------------


def test_whole_building_on_a_basement_has_no_floor() -> None:
    """f91d4624 (cessions de l'État) affichait « Étage : sous-sol » pour un immeuble entier."""

    sale = attach_source_property_features(
        {
            "source_name": "cessions_etat",
            "title": "Immeuble 338 m²",
            "description": "Ancien immeuble de bureaux en pierres de taille élevé en R+2 sur un niveau de sous-sol (cave).",
        },
        property_type="building",
    )

    assert "floor" not in sale["source_property_features"]
    assert "floor_number" not in sale["source_field_observations"]
    # Même sans le type de l'appelant, la phrase décrit la structure, pas l'emplacement d'un lot.
    assert _floor("Ancien immeuble de bureaux en pierres de taille élevé en R+2 sur un niveau de sous-sol (cave).", "") is None


@pytest.mark.parametrize(
    "property_type, text",
    [
        (
            "house",
            "Une maison d'habitation. de 145,35 m², comprenant : Au sous-sol : garage, chaufferie Au rez-de-chaussée : "
            "entrée, cuisine, séjour-salon avec cheminée, chambre, salle de bains",
        ),
        ("house", "Une maison à usage d'habitation située au rez-de-chaussée d'un ancien corps de ferme"),
        ("mixed", "Au rez-de-chaussée : TROIS LOCAUX COMMERCIAUX : - Un local à usage de restaurant Loué"),
        ("land", "un terrain sur lequel est édifié un cabanon au rez-de-chaussée"),
        ("building", "Un immeuble de rapport de 246,73 m² au sol, sur cinq niveaux, comprenant : Au sous-sol : une cave"),
    ],
)
def test_floor_is_never_read_for_a_house_a_building_mixed_property_or_land(property_type: str, text: str) -> None:
    assert _floor(text, property_type) is None
    assert "floor" not in _features(text, property_type)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Un appartement situé au 3ème étage", 3),
        ("En vente à TREBEURDEN (22), un appartement au rez-de-chaussée de 35.43 m².", 0),
        ("Appartement T4 rez-de-jardin", "rez-de-jardin"),
        # Le 12e et le 30e étage sont réels (Tour Bologne) ; la cave du 3e sous-sol est un autre lot.
        (
            "LOT n°68 : Dans le bâtiment 1, escalier A, au 12ème étage, 2ème porte à gauche, UN STUDIO de 25,72m2. "
            "LOT n°206 : Dans le bâtiment Ill, escalier A, au 1er sous-sol, UNE CAVE .",
            12,
        ),
        (
            "Appartement de type T2 situé au 30e étage de la Tour Bologne, immeuble moderne de 31 étages. "
            "LOT n°11.573 : Au troisième sous-sol, descente E et F, UNE CAVE portant le numéro 3083.",
            30,
        ),
        # La cave ou le parking « au sous-sol » ne créent plus de conflit avec l'étage de l'appartement.
        (
            "Un appartement Un appartement. de 39,72 m², au 1er étage, comprenant : deux pièces, cuisine, salle de bains "
            "wc Actuellement divisé matériellement en trois studios indépendants occupés Cave, au sous-sol",
            1,
        ),
        (
            "Un appartement Un appartement. de 40,35 m² , bâtiment A, escalier A1, au 1er étage, comprenant : entrée, "
            "salon (Lots n°11 et 12 réunis) Un garage bâtiment B, escalier A1, au sous-sol",
            1,
        ),
        (
            "Un appartement. de 56,38 m² , bâtiment D, au rez-de-chaussée, de trois pièces principales, comprenant : "
            "entrée Un emplacement pour véhicule automobile (parking Q), escalier D, au sous-sol Les biens sont occupés",
            0,
        ),
        # Le greffe et le cabinet de l'avocat ne sont pas le bien.
        (
            "consulté au Greffe du Juge de l'Exécution du Tribunal Judiciaire de Créteil, Bureau A17 ou A18, au "
            "rez-de-chaussée du bâtiment Marcel Proust Un appartement. de 51,45 m² , bâtiment C, 3ème étage, comprenant",
            3,
        ),
        # « au 7e étage d'un immeuble » : l'immeuble contient le lot.
        ("À deux pas des Champs‑Élysées, au 7e étage d'un immeuble de standing de 1970, appartement de 2 pièces", 7),
        ("Un appartement. au 2ème étage, comprenant : trois chambres, cuisine Combles Vente aux enchères", 2),
        ("Cadastre 1 salle(s) de bain 1 WC Étage : 1 Chauffage : Gaz naturel", 1),
    ],
)
def test_apartment_floor_is_the_unit_own_floor(text: str, expected) -> None:
    assert _floor(text, "apartment") == expected


@pytest.mark.parametrize(
    "text",
    [
        # Deux logements à deux niveaux différents : on ne choisit pas.
        "Un studio au rez-de-chaussée Un appartement de 70,15 m², au 1er étage Quatre greniers à aménager, au 2ème étage",
        "UNE MAISON élevée sur deux niveaux comprenant : UN APPARTEMENT au rez-de-chaussée de 3 pièces principales , "
        "combles aménagés, cellier UN APPARTEMENT au rez-de-jardin de 3 pièces principales , cave, cellier",
        # Un souplex décrit niveau par niveau.
        "Un appartement en souplex. de 74,25 m² , bâtiment C, comprenant : Au rez-de-chaussée : entrée, séjour "
        "Au sous-sol : salle d'eau/wc, deux chambres Une cave",
        # Structure de l'immeuble, cabinet d'avocat, combles communs.
        "constitué d’une maison à usage d’habitation élevée sur sous-sol d’un rez-de-chaussée et de 2 étages",
        "Maître Fabienne MERLIN-LABRE DLL AVOCATS - Barreau de Toulon LE ROYAL - 2e étage 4 rue Docteur Jean Bertholet",
        "Des combles communs sont situés directement au-dessus de l’appartement",
    ],
)
def test_ambiguous_or_foreign_floor_mentions_leave_the_apartment_floor_empty(text: str) -> None:
    assert _floor(text, "apartment") is None


def test_parking_and_commercial_lots_keep_their_own_level() -> None:
    assert _floor("Un box Un box. au 2ème sous-sol, portant le n°12", "parking") == "sous-sol"
    assert _floor("un garage situé au rez-de-chaussée, portant le numéro 11.", "parking") == 0
    assert _floor("Un local commercial. au rez-de-chaussée, comprenant : boutique, réserve", "commercial") == 0
    assert _floor("Un immeuble comprenant : Au rez-de-chaussée : un local commercial (67 m² au sol)", "commercial") is None


def test_one_floor_claim_without_conflict_for_an_apartment_with_a_cellar() -> None:
    fields = _features(
        "Un appartement de 76,24 m² loi Carrez, au 4ème étage, comprenant : entrée, séjour Cave, bâtiment B, au "
        "sous-sol, portant le n°29 Occupé",
        "apartment",
    )

    assert fields["floor"]["value"] == 4
    assert fields["floor"]["state"] == "present"


def test_structured_notaires_floor_is_kept_and_house_text_adds_nothing() -> None:
    sale = attach_source_property_features(
        {
            "source_name": "notaires",
            "description": "Situé au 1er étage dans un immeuble de bonne facture, appartement de 3 pièces.",
            "source_property_features": {"floor": 1},
        },
        property_type="apartment",
    )
    assert sale["source_property_features"]["floor"] == 1
    assert sale["source_field_observations"]["floor_number"]["value"] == 1
    assert sale["source_field_observations"]["floor_number"]["state"] == "observed"

    house = attach_source_property_features(
        {
            "source_name": "notaires",
            "description": "Maison : au rez-de-chaussée : entrée, cuisine, séjour ; à l'étage : trois chambres.",
            "source_property_features": {"floor": 0},
        },
        property_type="house",
    )
    assert house["source_property_features"]["floor"] == 0
    assert "_extracted" not in house["source_property_features"]


def test_recompute_drops_a_stale_generated_house_floor() -> None:
    stale = {"value": 0, "state": "present", "origin": "source_text_extraction", "evidence": "au rez-de-chaussée"}
    sale = attach_source_property_features(
        {
            "title": "Maison",
            "description": "Une maison comprenant : Au rez-de-chaussée : entrée, cuisine",
            "source_property_features": {"floor": stale},
        },
        property_type="house",
    )

    assert "floor" not in sale["source_property_features"]
    assert "floor_number" not in sale["source_field_observations"]


# --- Autres faits lus dans le texte ----------------------------------------------------------------------------


def test_heating_reads_its_own_clause() -> None:
    fields = _features(
        "Chauffage : chauffage électrique Diagnostic Performance énergétique : G Gaz à effet de serre : C", "house"
    )
    assert fields["heating"]["value"] == {"energy": "electricity"}

    fields = _features(
        "bénéficiant d'un chauffage par réseau de chaleur performant et d'une eau chaude sanitaire électrique",
        "apartment",
    )
    assert "heating" not in fields

    fields = _features("Chauffage mixte bois-Fuel/electrique, bel espace de vie", "house")
    assert fields["heating"]["value"] == {"energy": "wood"}

    fields = _features("Chauffage et eau chaude : individuel gaz", "apartment")
    assert fields["heating"]["value"] == {"mode": "individual", "energy": "gas"}
    assert "heating" not in _features("Chauffage électrique", "land")


def test_flooring_is_a_material_not_a_basement_layout() -> None:
    assert "flooring" not in _features("Une maison comprenant : Au sous-sol : garage, chaufferie Au rez-de-chaussée", "house")
    assert "flooring" not in _features("Et une quote-part dans la propriété du sol : indéterminée.", "apartment")
    fields = _features("Menuiseries en PVC - Sols en parquet flottant et carrelage Une cave au sous-sol", "apartment")
    assert fields["flooring"]["value"] == "parquet flottant"


@pytest.mark.parametrize(
    "text",
    [
        "Construit entre 2013 et 2021, ce bien offre d'excellentes performances énergétiques",
        "Année de construction : Avant 1949 Bien d'exception",
        "Elle a été construite dans les années 1930 sur un terrain plat de 390m2.",
        "Studio de 69,1 m² situé à Antony, construction 2001-2005.",
        "Pavillon individuel construit en 2001/2002",
        "un bateau de type le PLASCOA 19 , d’une longueur de 18,80 m et d’une largeur de 5,34 m, construit en 1991",
    ],
)
def test_year_built_rejects_ranges_approximations_and_other_objects(text: str) -> None:
    assert "year_built" not in _features(text, "house")


def test_year_built_keeps_an_explicit_year() -> None:
    assert _features("une maison d’habitation de 145,35 m², construite en 1979, cadastrée", "house")["year_built"]["value"] == 1979


def test_orientation_value_is_a_direction() -> None:
    fields = _features("Balcon Cave Orientation : Est Informations complémentaires : Bel appartement", "apartment")
    assert fields["orientation"]["value"] == "Est"
    fields = _features("appartement de 2 pièces de 47,03 m² Loi Carrez exposé Nord‑Est, ouvert sur une terrasse", "apartment")
    assert fields["orientation"]["value"] == "Nord-Est"
    fields = _features("Orientation : Sud-Est et Nord-Ouest Diagnostic énergétique DPE D", "apartment")
    assert fields["orientation"]["value"] == "Sud-Est et Nord-Ouest"
    assert "orientation" not in _features("Bénéficiant d’une double orientation, sur la rue de Sèvres", "apartment")


def test_coownership_negations_are_not_a_coownership() -> None:
    for text in (
        "immeuble de rapport appartenant à un propriétaire unique et non soumis au statut de la copropriété.",
        "Bien non soumis au régime de la copropriété. Opportunité rare Maison à rénover",
        "Jardin Diagnostic énergétique DPE G GES C Type de copropriété : Pas de copropriété Documents",
        "Un immeuble à usage commercial et d'habitation. (sans mise en copropriété), comprenant",
    ):
        assert _features(text, "house")["coownership"]["value"] == {"is_coownership": False}, text
    fields = _features("VILLA MITOYENNE DE 4 PIECES (88,85 m²) DANS UNE COPROPRIETE A VILLENEUVE LOUBET", "house")
    assert fields["coownership"]["value"] == {"is_coownership": True}


def test_coownership_charges_period_follows_the_amount() -> None:
    fields = _features("Les charges de copropriété s’élèvent à 92,25 € par mois, soit 1 107 € par an ;", "apartment")
    assert fields["coownership_charges"]["value"] == {"amount_eur": 92.25, "period": "par mois"}


def test_energy_class_needs_a_real_class_letter() -> None:
    assert "dpe_class" not in _features("(le DPE a été réalisé avant travaux). Actuellement destiné à une crèche", "house")
    fields = _features("Diagnostic énergétique DPE C GES A Informations complémentaires", "house")
    assert (fields["dpe_class"]["value"], fields["ges_class"]["value"]) == ("C", "A")


@pytest.mark.parametrize(
    "text",
    [
        "Commissaires de Justice Associés, Impasse des Alouettes 83136 ROCBARON",
        "Vente aux enchères : une maison d'habitation à Plouénan (Finistère) - n°110416",
        "Il occupe une surface de plancher de 441m2.",
        "Terrain occupé (présence d'une construction à démolir) Surface en m² 5544",
    ],
)
def test_occupancy_words_must_be_whole_and_about_people(text: str) -> None:
    assert "occupancy_physical" not in _features(text, "house")


def test_room_counts_skip_attachments_and_per_level_counts() -> None:
    fields = _features("Nombre de pièces 1 Superficie du terrain 323 Surface en m² 30 Pièces jointes 2_Condition", "house")
    assert "rooms_count" not in fields
    fields = _features("Au premier étage : entrée, dégagement, 3 chambres Au deuxième étage : bureau, 2 chambres", "mixed")
    assert "bedrooms_count" not in fields
    assert _features("Maison de 5 pièces avec 3 chambres", "house")["bedrooms_count"]["value"] == 3
    assert "bedrooms_count" not in _features("Box de 3 chambres froides", "parking")


# --- Équipements ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "feature, text",
    [
        ("pool", "Copropriété de 96 appartements et 17 villas avec piscine commune. Parking handicapé privatif inclus."),
        ("pool", "L'ensemble immobilier dispose d'une piscine commune, d'un ascenseur et d'un parking."),
        ("pool", "UN APPARTEMENT EN DUPLEX DE TYPE 3 avec piscine collective, situé au niveau R+6 du bâtiment A"),
        ("pool", "Dans les parties communes : piscine extérieure et casiers à skis."),
        ("garden", "il bénéficie d’un agréable balcon donnant sur le jardin de la copropriété."),
        ("garden", "un emplacement de stationnement dans le jardin de l’ensemble immobilier portant le N° 48"),
        ("garden", "proche du centre, du port et de la plage, rue du Jardin. L'appartement est composé d'une entrée"),
        ("garden", "Dans une résidence récente, sécurisée et calme, sur jardin et non sur rue, ce T2 se trouve au 1er étage"),
        ("garden", "Rue calme, Petit immeuble de 2 étages, avec jardin partagé, Au 1er étage, lumineux appartement"),
        ("garden", "Le Cercle des nageurs et le Jardin du Pharo-Parc Emile Duclaux se situent également à proximité"),
        ("garden", "64 rue Mouffetard - 75005 PARIS - Entre Jardin des plantes et Val de Grâce"),
    ],
)
def test_building_or_place_amenities_are_not_the_lot_amenities(feature: str, text: str) -> None:
    assert private_amenity_mentioned(text, feature) is False


@pytest.mark.parametrize(
    "feature, text",
    [
        ("pool", "Garage, piscine, terrain Vente aux enchères : une villa"),
        ("pool", "-lot n°19 : un jardin avec piscine ( hors d’usage) attenant à l’appartement"),
        ("garden", "Résidence de 2016, rez-de-chaussée, appartement de 2P avec terrasse et jardin, 46,14 m²."),
        ("garden", "Droit de jouissance exclusive du jardin privatif Occupé"),
        ("garden", "Jardin privé de 25 m² attenant."),
    ],
)
def test_the_lot_own_amenities_are_kept(feature: str, text: str) -> None:
    assert private_amenity_mentioned(text, feature) is True


def test_common_pool_and_garden_do_not_reach_the_sale_columns() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/05ceee58",
            "property_type": "Appartement",
            "description": (
                "Studio de 25 m² au 2ème étage, séjour/chambre ouvrant sur balcon. Construction de 1990. "
                "L'ensemble immobilier dispose d'une piscine commune, d'un ascenseur et d'un parking. "
                "Balcon donnant sur le jardin de la copropriété."
            ),
        }
    )
    normalize_asset_features(sale)

    assert sale.has_pool is False
    assert sale.has_garden is False


def test_a_stale_common_pool_column_is_cleared_on_recompute() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/864956d5",
            "property_type": "Appartement",
            "has_pool": True,
            "has_garden": True,
            "description": (
                "Copropriété de 96 appartements et 17 villas avec piscine commune. Le Cercle des nageurs et le Jardin "
                "du Pharo se situent à proximité."
            ),
        }
    )
    normalize_asset_features(sale)

    assert sale.has_pool is False
    assert sale.has_garden is False
    assert sale.raw_payload["feature_scope_reconciliation"]["has_pool"]["status"] == "cleared"
