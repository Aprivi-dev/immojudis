"""Pièces et chambres : audit du 03/11/2026 (extraits réels, préfixes d'id des ventes)."""

from src.asset_normalization import normalize_asset_features
from src.models import AuctionSale
from src.room_counts import (
    composition_bedroom_count,
    extract_bedrooms_count_from_text,
    extract_rooms_count_from_text,
    source_rooms_counter,
)


def test_86f32d2b_bedrooms_are_summed_over_floors_and_parts() -> None:
    text = (
        "Au rez-de-chaussée : entrée, cuisine, salon/séjour, couloir, deux chambres, salle d'eau, wc À l'étage : "
        "palier, deux chambres, salle d'eau, wc 1ère partie : garage 2ème partie : logement , comprenant : deux "
        "chambres, salle d'eau, wc, cuisine Jardin"
    )
    assert extract_bedrooms_count_from_text(text) == 6


def test_c3fbac51_singular_bedrooms_on_several_floors_are_counted() -> None:
    text = (
        "elle comprend : - Au rez-de-chaussée : une pièce principale (34,57 m2), un couloir de dégagement (3,31 m2), "
        "une cuisine (9,31 m2), une chambre (13,66 m2), une salle d'eau (6,90 m2), un dressing (4,96 m2), un cellier "
        "(0,55 m2). - À l’étage : un bureau (13,30m2), une chambre SUD EST (11,35 m2), une chambre SUD OUEST "
        "(10,33 m2) et une salle de bains"
    )
    assert extract_bedrooms_count_from_text(text) == 3
    # « une pièce principale » d'une maison à trois chambres n'est pas un studio.
    assert extract_rooms_count_from_text(text) is None


def test_cbbd361b_ab64d6c2_bc1e692e_ceba6275_floor_by_floor_counts() -> None:
    assert extract_bedrooms_count_from_text(
        "La maison comprend : − Rez-de-chaussée / niveau haut : entrée, deux chambres, salle d’eau, salle de bains ; "
        "− Rez-de-jardin : séjour avec cuisine ouverte, dégagement, deux chambres, salle de bains, wc, buanderie"
    ) == 4
    assert extract_bedrooms_count_from_text(
        "Au rez-de-chaussée : salon, salle à manger, cuisine, salle d'eau, bureau, wc Au 1er étage : une chambre avec "
        "salle de bains attenante/wc, deux chambres, salle de bains"
    ) == 3
    assert extract_bedrooms_count_from_text(
        "Au rez-de-chaussée surélevé : entrée, couloir, salon, véranda, cuisine, wc, salle de bains, deux chambres "
        "Combles : palier, deux chambres, salle de bains"
    ) == 4
    assert extract_bedrooms_count_from_text(
        "de 91 m² , comprenant : 1ère partie : entrée, salon, chambre, cuisine, salle de bains, wc 2ème partie : "
        "entrée, salon, cuisine, deux chambres, salle d'eau, wc Terrasse Jardin"
    ) == 3


def test_repeated_description_is_counted_once() -> None:
    description = (
        "Au rez-de-chaussée : entrée, cuisine, salon, deux chambres, salle d'eau, wc. À l'étage : palier, deux "
        "chambres, salle de bains."
    )
    assert extract_bedrooms_count_from_text(description, f"Annonce. {description}", description) == 4


def test_announced_count_wins_over_the_composition() -> None:
    # 319c133c : la fiche annonce « 5 pièces 2 chambres ».
    text = (
        "5 pièces 2 chambres 116.31 m² superficie À propos du bien comprenant : Au rez-de-chaussée : séjour, cuisine, "
        "dégagement, salle de douche, bureau, chambre, WC A l'étage: palier, 2 chambres, WC, salle d'eau"
    )
    assert extract_bedrooms_count_from_text(text) == 2


def test_legal_chambers_are_not_bedrooms() -> None:
    text = "Chambre des notaires, entrée du tribunal, la chambre civile, cuisine du palais, salon d'honneur"
    assert composition_bedroom_count(text) is None


def test_rooms_announced_in_words_are_read() -> None:
    assert extract_rooms_count_from_text("UNE VILLA MITOYENNE DE 4 PIÈCES avec jardin") == 4
    assert extract_rooms_count_from_text("Entre Arles et Nîmes, cette maison en R+1 de 4 pièces, comporte un jardin") == 4
    assert extract_rooms_count_from_text("un appartement situé au 2ème étage de trois pièces") == 3
    assert extract_rooms_count_from_text("Appartement comprenant 3 pièces principales, cuisine et salle de bains") == 3
    # 622fde61 : 4, pas 5 (3 chambres + séjour + …).
    assert extract_rooms_count_from_text(
        "d'une surface habitable de 107,60 m2, elle comprend 4 pièces principales : une entrée, une grande pièce, "
        "un salon, une cuisine avec cellier attenant, un couloir de distribution, 3 chambres"
    ) == 4


def test_quarter_and_easement_codes_are_not_room_types() -> None:
    assert extract_rooms_count_from_text("Charges de copropriété : 1 426,51€ (fonds travaux) T2 en 2026 Adresse") is None
    assert extract_rooms_count_from_text("Existence de servitudes AS 1 ; T 1 Présence de bâtiments à démolir") is None


def test_mixed_property_reads_only_the_source_counter() -> None:
    assert source_rooms_counter("Estimez vos frais d'acquisition 6 pièces 4 chambres 250 m² superficie") == 6
    assert source_rooms_counter("une maison de 3 pièces et un local commercial") is None


def _normalized(property_type: str, text: str, **fields: object) -> AuctionSale:
    sale = AuctionSale(
        source_name="cessions_etat",
        source_url="https://example.test/vente",
        property_type=property_type,
        description=text,
        **fields,
    )
    return normalize_asset_features(sale)


def test_6508fee9_rooms_are_not_deduced_from_bedrooms() -> None:
    sale = _normalized(
        "house",
        "Maison comprenant une salle à manger, une cuisine, une salle d’eau et deux chambres à l’étage, ainsi qu’un garage.",
        bedrooms_count=2,
    )
    assert sale.rooms_count is None
    assert sale.bedrooms_count == 2


def test_c1763ece_bare_land_has_no_rooms() -> None:
    sale = _normalized(
        "land",
        "Constructibilité Disponibilité libre Existence de servitudes AS 1 ; T 1 Présence de bâtiments à démolir",
        rooms_count=1,
        bedrooms_count=0,
    )
    assert sale.rooms_count is None
    assert sale.bedrooms_count is None


def test_862bfb81_rooms_equal_to_bedrooms_are_withheld() -> None:
    sale = _normalized(
        "apartment",
        "comprenant une entrée, un salon, une salle à manger, une cuisine, deux chambres, une salle de bains et un WC.",
        rooms_count=2,
        bedrooms_count=2,
    )
    assert sale.rooms_count is None
    assert sale.bedrooms_count == 2
    assert "room_count_conflict" in sale.quality_flags


def test_cdedbc41_rooms_not_greater_than_bedrooms_are_withheld() -> None:
    # « 3 pièces 3 chambres » (fiche) pour « séjour, 3 chambres, cuisine, salle d’eau, WC, loggia ».
    sale = _normalized(
        "apartment",
        "3 pièces 3 chambres 68.59 m² superficie un APPARTEMENT de 68.59 m² , comprenant : séjour, 3 chambres, cuisine",
        rooms_count=3,
        bedrooms_count=3,
    )
    assert sale.rooms_count is None
    assert sale.bedrooms_count == 3


def test_44fd7c39_building_of_several_apartments_has_no_single_dwelling_counts() -> None:
    sale = _normalized(
        "building",
        "au rez-de-chaussée un appartement de 67.55 m² avec entrée, WC, 2 chambres, salle de bain, séjour/cuisine. "
        "+ un appartement de 75.37 m² avec séjour/cuisine, dégagement, 2 chambres, salle de bain, WC",
        rooms_count=3,
        bedrooms_count=2,
    )
    assert sale.rooms_count is None
    assert sale.bedrooms_count is None


def test_studio_still_counts_one_room() -> None:
    sale = _normalized("apartment", "Un studio de 18 m² au 3ème étage comprenant une pièce principale et une salle d'eau.")
    assert sale.rooms_count == 1
    assert sale.bedrooms_count == 0
