"""Régressions de l'audit du 03/11/2026 sur les surfaces (textes réels, ventes citées par leur préfixe d'id).

Principe : une valeur manquante est acceptable, une valeur fausse ne l'est pas.
"""

from decimal import Decimal

import src.pdf_enrichment  # noqa: F401  (resolves the pdf_enrichment / pdf_fact_extraction import cycle)
from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import (
    apply_surface_reasoning_to_sale,
    extract_and_apply_deterministic_surface_reasoning,
    extract_surface_facts_from_text,
    reason_about_surfaces,
)
from src.models import AuctionSale
from src.pdf_surface_patterns import _extract_surface_candidates_with_evidence


def _sale(property_type: str, **fields: object) -> AuctionSale:
    return AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        property_type=property_type,
        **fields,
    )


def _apply(text: str, property_type: str, **fields: object) -> AuctionSale:
    sale = _sale(property_type, **fields)
    asset = extract_surface_facts_from_text(text)
    if asset is not None:
        apply_surface_reasoning_to_sale(sale, [asset], context=text, source="deterministic_surface_reasoning")
    return sale


# --- Classe 3 / 6 : une même phrase recopiée n'est pas une somme de pièces --------------------------------

_991D7119 = (
    "-lot n°5 : dans le Bâtiment A, un local à usage d’habitation , situé au rez-de-chaussée : une entrée, "
    "une cuisine, un cellier, un salon/séjour, une salle de bains avec WC, une chambre, un bureau/chambre, "
    "présentant une superficie de 75,34 m² . Et les 180/1.000èmes des parties communes générales"
)


def test_991d7119_repeated_whole_property_sentence_is_not_summed_as_bedrooms() -> None:
    # La même phrase est présente dans la description, le texte de la page et la description de la source.
    context = "\n".join([_991D7119, _991D7119, _991D7119])
    sale = _apply(context, "apartment")

    assert sale.surface_m2 != Decimal("226.02")
    assert sale.habitable_surface_m2 is None
    analysis = sale.raw_payload.get("surface_analysis") or {"derivations": []}
    assert all(item["kind"] != "calculated_room_sum" for item in analysis["derivations"])


def test_ca6805b7_global_superficie_after_room_list_is_not_a_room() -> None:
    text = (
        "Un appartement d'une superficie privative de 39,17 m², classé D au diagnostic de performance. "
        "de deux pièces principales comprenant entrée, espace principal avec kitchenette, chambre, salle de "
        "bains avec WC Ledit bien présente une superficie de 39,17 m². Et les 817/100.000 èmes des parties"
    )
    sale = _apply("\n".join([text, text, text]), "apartment")

    assert sale.surface_m2 != Decimal("117.51")
    assert sale.habitable_surface_m2 != Decimal("117.51")


def test_ac5b3d99_single_room_lot_repeated_three_times_is_not_tripled() -> None:
    text = "Vente aux enchères publiques en un lot jeudi 3 décembre 2026 à 14h Une chambre de 16,18 m² , au 1er étage"
    sale = _apply("\n".join([text, text, text]), "apartment")

    assert sale.surface_m2 != Decimal("48.54")
    asset = extract_surface_facts_from_text("\n".join([text, text, text]))
    assert asset is not None
    assert [item.value_m2 for item in asset.spaces] == [Decimal("16.18")]


def test_77b416e5_building_surfaces_are_not_office_rooms() -> None:
    text = (
        "Comprend un bâtiment bureau/atelier, un entrepôt de 946,78 m², un second bâtiment avec étage et "
        "sous-sol, un local technique de 18,03 m², et des espaces de stationnement."
    )
    sale = _apply("\n".join([text, text, text]), "mixed")

    assert sale.surface_m2 != Decimal("2894.43")
    assert sale.habitable_surface_m2 is None


def test_4a791649_lot_dwellings_after_a_corridor_are_not_corridor_measurements() -> None:
    text = (
        "LE LOT N°134 : Dans le Bâtiment G, au 1er étage, dans le couloir prenant accès par l’escalier du "
        "Bâtiment F : UN LOGEMENT de 19,27 m2, à la suite du 133ème lot. LE LOT N°135 : Dans le Bâtiment G, au "
        "1er étage, au fond du couloir prenant accès par l’escalier du Bâtiment F : UN LOGEMENT de 50,22 m2, à "
        "la fois sur la grande cour"
    )
    sale = _apply("\n".join([text, text]), "apartment")

    assert sale.surface_m2 != Decimal("138.98")
    assert sale.habitable_surface_m2 is None


def test_ae3aee27_local_of_another_lot_is_not_a_wc_measurement() -> None:
    text = (
        "comprenant : entrée donnant sur bar/four à pizzas, salle de restaurant, cuisine, wc (Lot n°45) UN "
        "LOCAL D'ACTIVITÉS de 27,7 m² (hors surface au sol de 0,6 m²), au rez-de-chaussée"
    )
    sale = _apply("\n".join([text, text]), "commercial")

    assert sale.surface_m2 != Decimal("28.9")


def test_identical_value_twice_for_the_same_room_kind_withholds_the_room_sum() -> None:
    asset = extract_surface_facts_from_text(
        "Le bien comprend : séjour 20,5 m², chambre 75,34 m², cuisine 8 m². Puis : chambre (75,34 m²)."
    )
    assert asset is not None
    result = reason_about_surfaces([asset], context="", property_type="apartment")

    assert all(item.kind != "calculated_room_sum" for item in result.derivations)
    assert any(item["kind"] == "repeated_room_value" for item in result.contradictions)


# --- Classe 2 : une somme partielle de pièces n'est jamais la surface du bien ------------------------------


def test_f06650da_partial_room_sum_is_withheld() -> None:
    text = (
        "SÉJOUR Cette pièce est accessible directement depuis la cuisine et dessert les WC et la salle d'eau, "
        "elle mesure 13.65m2. WC Cette pièce est accessible depuis le séjour sans porte, elle mesure 1.37m2."
    )
    sale = _apply(text, "house")

    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None


def test_0a85767e_table_header_followed_by_a_room_is_not_the_habitable_surface() -> None:
    text = (
        "DETAIL DES SURFACES PAR LOCAL Pièce ou Local Etage Surface habitable Bureau n°1 ROC 13,450 m2 "
        "Entrée ROC 10,390 m2 WC n°1 ROC 0,930 m2 Studio ROC 29,490 m2 Bureau n°2 2ème 4,860 m2 "
        "Chambre n°2 2ème 11,810m 2 Chambre n°3 2ème 14,070 m2 Total 183.780 m2"
    )
    sale = _apply(text, "house")

    assert sale.habitable_surface_m2 != Decimal("13.45")
    assert sale.surface_m2 == Decimal("183.78")


# --- Classe 1 : surface au sol, Carrez entre parenthèses ---------------------------------------------------


def test_4bf49f1b_ground_area_is_not_the_habitable_surface() -> None:
    text = (
        "la cage d’escalier et le garage. Le tout d’une superficie privative de 130,90 m² de surface habitable "
        "totale, 158,82 m² de surface au sol totale. Les biens sont"
    )
    sale = _apply(text, "house")

    assert sale.habitable_surface_m2 == Decimal("130.90")
    assert sale.surface_m2 == Decimal("130.90")


def test_5a1da505_ground_area_is_not_the_carrez_surface() -> None:
    text = (
        "une pièce centrale, des toilettes, une chambre, une salle de bains. Le tout d’une superficie privative "
        "de 81,66 m² de surface Loi Carrez totale, 137,35 m² de surface au sol totale."
    )
    sale = _apply(text, "apartment")

    assert sale.carrez_surface_m2 == Decimal("81.66")
    assert sale.surface_m2 == Decimal("81.66")


def test_255efc64_carrez_value_before_the_ground_area_in_parentheses() -> None:
    text = (
        "LOT n° 491 : UN APPARTEMENT de type trois pièces de 63,36 m² Loi Carrez (77,56 m² surface au sol) "
        "situé au 4ème étage"
    )
    sale = _apply(text, "apartment")

    assert sale.carrez_surface_m2 == Decimal("63.36")


def test_808eb1d3_carrez_is_not_the_ground_area() -> None:
    text = "Un appartement T4 en duplex de 100 m² Carrez (146 m² au sol) situé au dernier étage"
    sale = _apply(text, "apartment")

    assert sale.carrez_surface_m2 == Decimal("100")


def test_ground_area_total_alone_is_not_projected() -> None:
    sale = _apply("Surface au sol totale : 216,56 m²", "house")

    assert sale.surface_m2 is None
    assert sale.habitable_surface_m2 is None


def test_57e3fea5_carrez_is_typed_even_when_the_page_already_gave_the_same_value() -> None:
    text = (
        "d'une surface privative (loi Carrez) de 47,01 m² (outre 1,61 m² de surface non prise en compte) , "
        "bâtiment A, escalier A, de type trois pièces"
    )
    sale = _apply(
        text,
        "apartment",
        surface_m2=Decimal("47.01"),
        surface_source="source_text",
        surface_evidence=text,
    )

    assert sale.carrez_surface_m2 == Decimal("47.01")
    assert sale.surface_source == "source_text"


# --- Classe 5 : la surface d'un des logements n'est pas celle d'une vente qui en compte plusieurs ----------

_1D0262FA = (
    "Comprenant 4 appartements : - appartement de l’étage 1 nord, porte gauche, superficie habitable totale de "
    "74,59 m² ; - appartement de l’étage 1 sud, porte droite, superficie habitable totale de 68,85 m² ; - appartement "
    "de l’étage 2, comble nord, porte gauche, superficie habitable totale de 50,76 m² - appartement de l’étage 2, "
    "comble sud, porte droite, superficie habitable totale de 50,48 m². Garages, cour intérieure"
)
_94B23E0F = (
    "Un immeuble comprenant : - Au rez-de-chaussée, un local commercial à usage de restaurant de 66,37 m² et une "
    "courette de 4,83 m². Le bien est libre d’occupation ; - Au premier étage à droite, un studio de 28,53 m². Le "
    "bien est loué 375 €/mois ; - Au premier étage à gauche, un appartement de 33,87 m² donnant sur un jardin"
)


def test_1d0262fa_first_of_four_apartments_is_not_published() -> None:
    sale = normalize_asset_features(_sale("mixed", description=_1D0262FA, surface_m2=Decimal("74.59")))

    assert sale.app_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags


def test_94b23e0f_restaurant_of_a_building_is_not_the_building_surface() -> None:
    sale = normalize_asset_features(
        _sale(
            "building",
            description=_94B23E0F,
            surface_m2=Decimal("66.37"),
            habitable_surface_m2=Decimal("66.37"),
            carrez_surface_m2=Decimal("66.37"),
        )
    )

    assert sale.app_surface_m2 is None


def test_d788c7bd_land_lot_has_no_habitable_surface_from_another_lot() -> None:
    sale = normalize_asset_features(
        _sale(
            "land",
            description="LOT N°2 : parcelles non bâties cadastrées pour 4a 13ca et 5a 04ca.",
            surface_m2=Decimal("101.3"),
            habitable_surface_m2=Decimal("101.3"),
        )
    )

    assert sale.habitable_surface_m2 is None
    assert sale.surface_m2 != Decimal("101.3")
    assert sale.app_surface_m2 != Decimal("101.3")


def test_single_apartment_with_its_cellar_keeps_its_surface() -> None:
    sale = normalize_asset_features(
        _sale(
            "apartment",
            description="Un appartement de 45,10 m² au 2ème étage comprenant séjour, chambre, cuisine. Une cave.",
            carrez_surface_m2=Decimal("45.10"),
        )
    )

    assert sale.app_surface_m2 == Decimal("45.10")


# --- Classe 8 : Carrez supérieure à la surface ---------------------------------------------------------------


def test_8f9e445d_carrez_total_wins_over_one_level() -> None:
    text = (
        "une cave et les 10/1.000ème de la propriété du sol et des parties communes générales d'une surface selon Loi "
        "Carrez au rez-de-chaussée de 62,95m², pour la cour commune 73,25m² au 1er étage 48,30m² surface totale Loi "
        "Carrez 111,25m²"
    )
    sale = normalize_asset_features(
        _sale("commercial", description=text, surface_m2=Decimal("62.95"), carrez_surface_m2=Decimal("111.25"))
    )

    assert sale.surface_m2 == Decimal("111.25")
    assert sale.app_surface_m2 in {None, Decimal("111.25")}
    assert sale.raw_payload["surface_reconciliation"]["rejected_surface_m2"] == "62.95"


def test_85136d47_named_carrez_wins_and_the_page_counter_conflict_is_flagged() -> None:
    raw_text = (
        "4 pièces 2 chambres 78.78 m² superficie À propos du bien Dans un ensemble immobilier … salle de bain, des "
        "toilettes et un balcon. Superficie privative (Loi Carrez – hors balcon) : 78,20 m² ."
    )
    sale = normalize_asset_features(
        _sale("apartment", raw_text=raw_text, surface_m2=Decimal("78.20"), carrez_surface_m2=Decimal("78.20"))
    )

    assert sale.app_surface_m2 == Decimal("78.20")
    assert "surface_source_conflict" in sale.quality_flags
    assert sale.raw_payload["surface_source_conflict"]["source_surface_m2"] == "78.78"


# --- Classe 4 : surface d'un permis de construire -------------------------------------------------------------


def test_2f7dc9f0_permit_floor_area_is_not_the_habitable_surface() -> None:
    text = (
        "Diagnostic et urbanisme: Permis de construire PC n° 006085 19D0103 délivré le 2 Mars 2020 à la SCI LP "
        "MOUGINS en vue de transformer un garage en surface habitable et de créer une terrasse en bois, créant une "
        "surface de plancher de 77.63 m2, portant la surface totale de plancher à 607.63 m?, sur un terrain de "
        "11210 m?"
    )
    assert Decimal("77.63") not in [item["value"] for item in _extract_surface_candidates_with_evidence(text)]
    sale = _apply(text, "house")
    assert sale.habitable_surface_m2 is None


def test_f06650da_a_stale_partial_sum_from_a_previous_pass_is_removed() -> None:
    """Stored row of 03/11/2026: 15,02 m² posed by the old reasoning; the corrected reasoning abstains."""
    text = (
        "SÉJOUR Cette pièce est accessible directement depuis la cuisine et dessert les WC et la salle d'eau, "
        "elle mesure 13.65m2. WC Cette pièce est accessible depuis le séjour sans porte, elle mesure 1.37m2."
    )
    stale = Decimal("15.02")
    sale = _apply(
        text, "house", surface_m2=stale, habitable_surface_m2=stale, app_surface_m2=stale,
        surface_source="deterministic_surface_reasoning", surface_evidence="Surface calculée: 13.65 + 1.37 = 15.02 m²",
    )

    assert sale.surface_m2 is None and sale.habitable_surface_m2 is None and sale.app_surface_m2 is None
    assert sale.surface_source is None and sale.surface_evidence is None


def test_a_surface_from_the_page_is_kept_when_the_reasoning_abstains() -> None:
    text = "SÉJOUR elle mesure 13.65m2. WC elle mesure 1.37m2."
    sale = _apply(text, "house", surface_m2=Decimal("41.76"), surface_source="source_page")

    assert sale.surface_m2 == Decimal("41.76")


def test_e538fab2_a_surface_still_written_on_the_page_is_not_wiped_when_the_reasoning_finds_nothing() -> None:
    """Recompute of 03/11/2026: « Studio de 31m² » set by a previous pass, then wiped when the recompute text
    (display title replaced by the description) gave no candidate. The page still states it: it stays."""
    text = "Résidence services « Les Jardins d'Arcadie » au 1er étage, avec cave et parking : 31m²"
    stale = Decimal("31")
    previous = {
        "selected_derivation_id": "d1",
        "derivations": [{"derivation_id": "d1", "kind": "explicit_built", "value_m2": "31"}],
    }
    sale = _sale(
        "apartment", surface_m2=stale, app_surface_m2=stale,
        surface_source="deterministic_surface_reasoning", surface_evidence="Studio de 31m²",
        raw_payload={"surface_analysis": previous},
    )
    extract_and_apply_deterministic_surface_reasoning(sale, text)

    assert sale.surface_m2 == stale and sale.app_surface_m2 == stale
    assert sale.surface_source == "source_text"


def test_a_stale_room_sum_stays_removed_even_when_the_number_appears_in_the_text() -> None:
    text = "SÉJOUR elle mesure 13.65m2. WC elle mesure 1.37m2. Total des pièces listées : 15,02 m²"
    stale = Decimal("15.02")
    previous = {
        "selected_derivation_id": "d1",
        "derivations": [{"derivation_id": "d1", "kind": "calculated_room_sum", "value_m2": "15.02"}],
    }
    sale = _sale(
        "house", surface_m2=stale, habitable_surface_m2=stale, app_surface_m2=stale,
        surface_source="deterministic_surface_reasoning", raw_payload={"surface_analysis": previous},
    )
    extract_and_apply_deterministic_surface_reasoning(sale, text)

    assert sale.surface_m2 is None and sale.habitable_surface_m2 is None


def test_studio_surface_is_an_explicit_built_candidate() -> None:
    sale = _apply("Résidence services « Les Jardins d'Arcadie » Studio de 31m² au 1er étage avec cave", "apartment")

    assert sale.surface_m2 == Decimal("31")
