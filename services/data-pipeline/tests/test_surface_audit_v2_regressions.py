"""Régressions du recalcul de production du 03/11/2026 sur les surfaces (textes réels, ventes citées par leur
préfixe d'id).

Chaque ligne reprend l'état stocké après ce recalcul (colonnes et ``raw_payload`` utiles) et repasse par le
chemin de production : ``_recomputed_sale_from_storage_row`` (normalisation, raisonnement sur les surfaces,
normalisation de l'actif). Principe : une case vide vaut mieux qu'une valeur fausse, mais une surface écrite
en toutes lettres sur la page ne doit pas être perdue.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import src.asset_normalization  # noqa: F401  (resolves the asset_normalization import cycle)
import src.pdf_enrichment  # noqa: F401  (resolves the pdf_enrichment / pdf_fact_extraction import cycle)
from src.enrichment.surface_reasoning import extract_surface_facts_from_text, reason_about_surfaces
from src.multi_unit_surface import listed_unit_surfaces, single_dwelling_lot_surface
from src.recompute_scoring import _recomputed_sale_from_storage_row
from src.surface_plausibility import text_states_built_surface
from src.surface_text_recovery import extra_built_surface_from_text

_STORED_SURFACE_COLUMNS = (
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
    "surface_source",
    "surface_scope",
    "surface_evidence",
    "app_surface_m2",
    "app_surface_kind",
)


def _row(
    prefix: str,
    source: str,
    url: str,
    property_type: str,
    title: str,
    description: str,
    *,
    raw_text: str | None = None,
    page_text: str | None = None,
    columns: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ligne ``auction_sales`` telle que le recalcul la lit : les colonnes vides priment sur le payload."""
    raw_payload: dict[str, Any] = {
        "source_name": source,
        "source_url": url,
        "title": title,
        "description": description,
        "property_type": property_type,
    }
    if raw_text:
        raw_payload["raw_text"] = raw_text
    if page_text:
        raw_payload["source_blocks"] = {"page_text": page_text}
    raw_payload.update(payload or {})
    row: dict[str, Any] = {
        "id": f"{prefix}-0000-4000-8000-000000000000",
        "source_name": source,
        "source_url": url,
        "status": "upcoming",
        "title": title,
        "property_type": property_type,
        "raw_payload": raw_payload,
        **dict.fromkeys(_STORED_SURFACE_COLUMNS),
    }
    row.update(columns or {})
    return row


# --- 1. ebafd1c4 : « Jardin derrière Le tout représente une surface bâtie de 259,86 m² » ----------------------

_WASSY = (
    "Une maison comportant : Rez-de-chaussée : Entrée, séjour + Cuisine ouverte, W.C., Salon (côté rue) et Garage , "
    "premier étage : Palier, Chambre 1 (côté rue), Chambre 2 (côté rue), Dégagement, Placard + anciens W.C., Salle de "
    "bains, Bureau, Chambre 3 (cour), Chambre 4 (cour), greniers en trois pièces, extérieurs : Cour intérieure, Annexe 1, "
    "Annexe 2 (- accès condamné), Jardin derrière Le tout représente une surface bâtie de 259,86 m² et cadastré : Section "
    "AD n°168 « 14 rue de la République » 04 a et 69 ca L’immeuble est inoccupé MISE A PRIX : 39.000,00 €"
)


def _wassy_row(*, stored: bool) -> dict[str, Any]:
    stale = {"land_surface_m2": "259.86", "surface_source": "land_surface_m2", "surface_scope": "land"}
    return _row(
        "ebafd1c4",
        "avoventes",
        "https://avoventes.fr/enchere/maison-dhabitation-126",
        "house",
        "Maison",
        _WASSY,
        raw_text=_WASSY.replace("derrière ", "derrière\n"),
        columns=stale if stored else None,
        payload={**stale, "land_surface_m2": 259.86} if stored else None,
    )


def test_ebafd1c4_built_surface_is_not_land_and_stored_land_is_replaced_by_the_parcel() -> None:
    sale = _recomputed_sale_from_storage_row(_wassy_row(stored=True))

    assert sale.land_surface_m2 == Decimal("469")  # 04 a 69 ca
    assert sale.surface_m2 == Decimal("259.86")
    assert sale.app_surface_m2 == Decimal("259.86")
    assert sale.app_surface_kind == "built"
    assert sale.habitable_surface_m2 is None  # « bâtie » n'est pas « habitable »
    assert sale.surface_source != "land_surface_m2"


def test_ebafd1c4_fresh_read_gives_the_same_surfaces() -> None:
    sale = _recomputed_sale_from_storage_row(_wassy_row(stored=False))

    assert (sale.surface_m2, sale.land_surface_m2) == (Decimal("259.86"), Decimal("469"))


def test_built_label_recovery_skips_an_annex_and_a_ground_area() -> None:
    assert extra_built_surface_from_text("Le tout représente une surface bâtie de 259,86 m² et cadastré") == Decimal(
        "259.86"
    )
    assert extra_built_surface_from_text("Dans la cour, un garage d'une surface bâtie de 20 m²") is None
    assert extra_built_surface_from_text("une surface bâtie de 80 m² au sol") is None


# --- 2. e538fab2 : « Résidence services « Les Jardins d’Arcadie » Studio de 31m² » ---------------------------

_ARCADIE = "Résidence services « Les Jardins d’Arcadie » Studio de 31m² au 1er étage avec cave et parking"


def test_e538fab2_studio_surface_is_not_read_as_garden_land() -> None:
    row = _row(
        "e538fab2",
        "notaires",
        "https://www.immobilier.notaires.fr/fr/annonce-immo-interactive/arcadie",
        "apartment",
        _ARCADIE,
        _ARCADIE,
        raw_text=f"VNI - ARCADIE\n{_ARCADIE}\nAnnecy\nHaute-Savoie\nVNI",
        columns={"surface_source": "land_surface_m2"},
        payload={"surface_source": "land_surface_m2", "rooms_count": 1},
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.app_surface_m2 == Decimal("31")
    assert sale.land_surface_m2 is None
    assert "built_surface_equal_to_land_reconciliation" not in sale.raw_payload
    assert sale.surface_source != "land_surface_m2"


# --- 3. 62fe27e3 : « …, soit superficie totale 1550 m² » après des parcelles --------------------------------

_BISSEY = (
    "Commune de BISSEY LA COTE (21520), 10 Grande Rue : Une ancienne maison de village à usage d’habitation élevée "
    "d’un rez-de-chaussée et de deux étages d’environ 128 m² comprenant : Au rez-de-chaussée : entrée avec placard, "
    "cuisine, bureau, cabinet de toilettes, grand avec cheminée, Au premier étage : escalier desservant un palier, deux "
    "chambres, salle de bain, cabinet de toilettes, Au deuxième étage : palier, placard, deux chambres, pièce d’eau à "
    "aménager, cabinet de toilettes. Jolie construction avec four à pain. Remise à la suite. Local accès cave. Cave. "
    "Grange. Jardin. Le tout figurant au cadastre de la manière suivante : S 162 pour 8a 82ca et S 163 pour 6a 68ca, "
    "soit superficie totale 1550 m²."
)


def test_62fe27e3_parcel_total_is_land_and_the_house_keeps_its_approximate_surface() -> None:
    stale = {"land_surface_m2": "1550.0", "surface_source": "deterministic_surface_reasoning", "surface_scope": "land"}
    row = _row(
        "62fe27e3",
        "avoventes",
        "https://avoventes.fr/enchere/maison-bissey",
        "house",
        "Maison",
        _BISSEY,
        columns=stale,
        payload={**stale, "land_surface_m2": 1550},
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.land_surface_m2 == Decimal("1550")
    assert sale.app_surface_m2 == Decimal("128")
    assert Decimal("1550") not in {sale.surface_m2, sale.habitable_surface_m2}
    rejected = sale.raw_payload["surface_analysis"]["rejected_candidates"]
    assert [item["reason"] for item in rejected] == ["parcel_total_land_surface"]


def test_explicit_built_value_of_a_land_or_annex_is_not_the_house_surface() -> None:
    for text in ("Une maison avec un jardin de 500 m².", "Une maison sur un terrain de 800 m²."):
        result = reason_about_surfaces([extract_surface_facts_from_text(text)], context=text, property_type="house")
        assert result.selected is None
        assert [item["reason"] for item in result.rejected_candidates] == ["surface_of_land_or_annex"]
    # Une virgule sépare le jardin de la surface : elle reste celle de la maison.
    text = "Une maison avec jardin, d'une surface de 90 m²."
    result = reason_about_surfaces([extract_surface_facts_from_text(text)], context=text, property_type="house")
    assert result.selected is not None and result.selected.value_m2 == Decimal("90")


def test_db4a22d3_lock_keeper_house_keeps_its_own_surface_not_the_plot() -> None:
    text = (
        "A rénover ancienne maison éclusière d'environ 80 m2 sur un terrain entièrement clos d'une superficie de 1283 m2. "
        "Fort potentiel."
    )
    stale = {"land_surface_m2": "1283", "surface_source": "deterministic_surface_reasoning", "surface_scope": "land"}
    row = _row(
        "db4a22d3",
        "cessions_etat",
        "https://cessions.immobilier-etat.gouv.fr/biens/ancienne-maison-eclusiere-en-bord-de-seine",
        "house",
        "Ancienne Maison éclusière En Bord De Seine",
        text,
        columns=stale,
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.app_surface_m2 == Decimal("80")
    assert sale.land_surface_m2 == Decimal("1283")


def test_approximate_surface_of_one_dwelling_does_not_replace_a_known_surface() -> None:
    # 3f2324c0 : deux maisons, « ce premier logement d'environ 90m² » ; la surface publiée (150 m²) reste.
    text = (
        "Découvrez cet ensemble immobilier composé de deux maisons indépendantes. Une maison principale comprenant une pièce "
        "de vie avec cuisine ouverte, une salle de bains et des WC. À l’étage, une grande mezzanine, un espace de rangement, "
        "un WC et une chambre complètent ce premier logement d'environ 90m².Une seconde maison indépendante propose deux "
        "chambres."
    )
    row = _row(
        "3f2324c0",
        "notaires",
        "https://www.immobilier.notaires.fr/fr/annonce-immo-interactive/toutry",
        "house",
        "TOUTRY : ensemble immobilier à rénover avec jardin et dépendances.",
        text,
        columns={
            "surface_m2": "150.0",
            "habitable_surface_m2": "150.0",
            "land_surface_m2": "360.0",
            "surface_source": "notaires.surfaceHabitable",
            "surface_scope": "total",
            "app_surface_m2": "150.0",
            "app_surface_kind": "habitable",
        },
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.app_surface_m2 == Decimal("150")


def test_a_house_over_a_partial_cellar_or_with_a_decimal_measure_keeps_its_surface() -> None:
    for text, value in (
        ("UNE MAISON D'HABITATION sur cave partielle de 152,64 m 2 comprenant : séjour, trois chambres.", "152.64"),
        ("UNE MAISON AVEC PISCINE, POOL-HOUSE, DEPENDANCES ET TERRAIN ATTENANT D’une superficie de 202,96 m2", "202.96"),
    ):
        result = reason_about_surfaces([extract_surface_facts_from_text(text)], context=text, property_type="house")
        assert result.selected is not None and result.selected.value_m2 == Decimal(value)


# --- 4. e34acc33 : un pavillon de 95,26 m² « construit sur un terrain … de 207 m² » --------------------------

_FOSSES = (
    "Un pavillon d'habitation. d'une superficie de 95,26 m² Aux termes du procès-verbal de description dressé le 12 "
    "décembre 2025 : une maison d'habitation en simple mitoyenneté, construite sur un terrain de forme rectangulaire de "
    "207 m², gros oeuvre en parpaings, façades enduites, toiture en tuiles mécaniques sur charpente en bois, menuiseries "
    "extérieures en PVC à double vitrage, comprenant : Au rez-de-chaussée : une entrée, un séjour double avec cheminée, "
    "une cuisine, un rangement, un garage, une buanderie et un wc Au 1er étage : trois chambres, une salle de bains, un "
    "wc et des placards Au 2ème étage : deux chambres Jardin en arrière de la maison avec abri de jardin Bien cadastré "
    "section AC n°743, pour une contenance de 2a 7ca Occupé"
)
_FOSSES_PAGE = (
    "Annonce n°110045 : un pavillon d'habitation à Fosses (Val-d'Oise), mise à prix : 70 000 €\n"
    "Tribunal Judiciaire de Pontoise (Val d'Oise)\nVente aux enchères publiques en un seul lot\n"
    "mardi 17 novembre 2026 à 14h\nUn pavillon d'habitation\nd'une superficie de 95,26 m²\n"
    + _FOSSES.split("95,26 m² ", 1)[1].replace(" Occupé", "\nOccupé")
    + "\nMise à prix : 70 000 €\nFosses\nLotissement Beau Soleil\n20, av. Debussy\n"
)


def test_e34acc33_land_value_does_not_make_a_second_dwelling() -> None:
    row = _row(
        "e34acc33",
        "licitor",
        "https://www.licitor.com/annonce/11/00/45/vente-aux-encheres/un-pavillon-d-habitation/fosses/val-d-oise/110045.html",
        "house",
        "Un pavillon d'habitation",
        _FOSSES,
        raw_text=_FOSSES_PAGE,
        page_text=_FOSSES_PAGE,
        columns={"land_surface_m2": "207.0", "surface_scope": "unknown"},
        payload={"land_surface_m2": 207, "surface_m2": 95.26, "surface_source": "source_text", "surface_scope": "total"},
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.app_surface_m2 == Decimal("95.26")
    assert sale.land_surface_m2 == Decimal("207")
    assert sale.surface_scope == "total"
    assert "ambiguous_surface" not in sale.quality_flags
    assert listed_unit_surfaces(_FOSSES_PAGE) == {Decimal("95.26")}


def test_two_dwellings_with_their_own_surfaces_stay_ambiguous() -> None:
    text = "UN LOGEMENT de 19,27 m2 au rez-de-chaussée. UN LOGEMENT de 50,22 m2 à l'étage."
    assert listed_unit_surfaces(text) == {Decimal("19.27"), Decimal("50.22")}


# --- 5. 991d7119 : le seul lot d'habitation parmi une cave, deux parkings et un jardin ---------------------

_NEAUPHLE = (
    "A NEAUPHLE LE CHATEAU (78) Dans un ensemble immobilier sis 64 route de Saint-Germain, Et cadastré Section AD n°92, "
    "lieudit« 64 route de saint Germain », Les lots de copropriété : -lot n°5 : dans le Bâtiment A, un local à usage "
    "d’habitation , situé au rez-de-chaussée : une entrée, une cuisine, un cellier, un salon/séjour, une salle de bains "
    "avec WC, une chambre, un bureau/chambre, présentant une superficie de 75,34 m² . Et les 180/1.000èmes des parties "
    "communes générales, Et les 194/1000èmes des parties communes spéciales au bâtiment A. -lot n°10 : dans le bâtiment "
    "A, une cave située au rez-de-chaussée portant le n°10 du plan. Et les 2/1.000èmes des parties communes générales, "
    "Et les 2/1000èmes des parties communes spéciales au bâtiment A. -lot n°15 : dans le bâtiment B, un parking situé au "
    "rez-de-chaussée portant le numéro 15 du plan 2 Et les 4/1.000èmes des parties communes générales, Et les "
    "167/1000èmes des parties communes spéciales au bâtiment B -lot n°16 : dans le bâtiment B, un parking situé au "
    "rez-de-chaussée portant le numéro 16 du plan Et les 4/1.000èmes des parties communes générales, Et les "
    "167/1000èmes des parties communes spéciales au bâtiment B. -lot n°19 : un jardin avec piscine ( hors d’usage) "
    "attenant à l’appartement, accessible par un portillon portant le n°19 du plan. Et les 14/1.000èmes des parties "
    "communes générales, Et les 1000/1000èmes des parties communes spéciales à la piscine. Occupé"
)


def test_991d7119_single_dwelling_lot_gives_the_surface() -> None:
    row = _row(
        "991d7119",
        "avoventes",
        "https://avoventes.fr/enchere/appartement-neauphle",
        "apartment",
        "Appartement",
        _NEAUPHLE,
        payload={
            "surface_m2": 226.02,
            "habitable_surface_m2": 226.02,
            "surface_source": "deterministic_surface_reasoning",
            "surface_scope": "partial",
        },
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.app_surface_m2 == Decimal("75.34")
    assert sale.habitable_surface_m2 is None


def test_single_dwelling_lot_rule_abstains_when_unsure() -> None:
    assert single_dwelling_lot_surface(_NEAUPHLE) == Decimal("75.34")
    two_dwellings = (
        "-lot n°1 : un appartement présentant une superficie de 40 m². -lot n°2 : un appartement présentant une "
        "superficie de 55 m². -lot n°3 : une cave."
    )
    assert single_dwelling_lot_surface(two_dwellings) is None
    unknown_lot = "-lot n°1 : un appartement d'une superficie de 40 m². -lot n°2 : un local commercial."
    assert single_dwelling_lot_surface(unknown_lot) is None
    room_value = "-lot n°1 : un appartement comprenant une chambre de 12 m². -lot n°2 : une cave."
    assert single_dwelling_lot_surface(room_value) is None


# --- 6. 07228862 : « surface habitable de 167,08 m² » contre un terrain de pièce égal ------------------------

_LONGVIC = (
    "Sur la commune de Longvic (21600), 20 rue Marcel Sembat Une maison d’habitation sur deux niveaux d’une surface de "
    "167,08 m2 avec jardin privatif, deux grandes caves, un garage et dépendances dans le jardin Salon, cuisine, trois "
    "chambres, deux salles de bains, deux dressings et deux cabinets de toilettes\n"
    "Belle maison d'habitation sur deux niveaux à Longvic, offrant une surface habitable de 167,08 m². Cette propriété "
    "dispose d'un aménagement fonctionnel avec salon, cuisine, trois chambres spacieuses, deux salles de bains et deux "
    "cabinets de toilettes, complétés par deux dressings."
)


def test_07228862_explicit_habitable_surface_wins_over_an_equal_document_land() -> None:
    stale = {"land_surface_m2": "167.08", "surface_source": "deterministic_surface_reasoning", "surface_scope": "land"}
    row = _row(
        "07228862",
        "avoventes",
        "https://avoventes.fr/enchere/maison-longvic",
        "house",
        "Maison",
        _LONGVIC,
        columns=stale,
        payload={
            **stale,
            "land_surface_m2": 167.08,
            "document_facts_version": "document_facts_v4_occupancy_dates_prices",
            "land_surface_extraction": {
                "kind": "land_surface_m2",
                "source": "pdf",
                "evidence": "Une maison d’habitation sur deux niveaux d’une surface de 167,08 m2 avec jardin privatif",
                "value_m2": 167.08,
                "document_type": "annonce_vente",
            },
        },
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.habitable_surface_m2 == Decimal("167.08")
    assert sale.app_surface_m2 == Decimal("167.08")
    assert sale.land_surface_m2 is None
    assert sale.raw_payload["land_surface_reconciliation"]["rejected_land_surface_m2"] == "167.08"


def test_a_value_stated_as_land_still_loses_its_built_copy() -> None:
    # « terrain de 1 283 m² » : la valeur est qualifiée de terrain, la surface bâtie égale reste écartée.
    text = "Maison éclusière sur un terrain de 1283 m²."
    row = _row(
        "0000aaaa",
        "avoventes",
        "https://avoventes.fr/enchere/maison-eclusiere",
        "house",
        "Maison",
        text,
        columns={"surface_m2": "1283", "habitable_surface_m2": "1283", "land_surface_m2": "1283"},
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.land_surface_m2 == Decimal("1283")
    assert sale.habitable_surface_m2 is None
    assert sale.app_surface_m2 is None


def test_text_states_built_surface_needs_a_label_on_the_number() -> None:
    assert text_states_built_surface(["offrant une surface habitable de 167,08 m²"], Decimal("167.08"))
    assert text_states_built_surface(["120 m² habitables"], Decimal("120"))
    assert not text_states_built_surface(["une maison d'une surface de 167,08 m2"], Decimal("167.08"))
    assert not text_states_built_surface(["surface habitable 90 m², terrain de 500 m²"], Decimal("500"))


# --- 7. 24d214e0 / 077acb2a : deux lots Licitor sur une même page --------------------------------------------

_CANNES_PAGE = (
    "Annonce n°110462 : un appartement à Cannes (Alpes-Maritimes), mise à prix : 90 000 €\n"
    "Tribunal Judiciaire de Grasse (Alpes maritimes)\nVente aux enchères publiques en deux lots\n"
    "jeudi 3 décembre 2026 à 9h\n1er lot\nUn appartement\nde 63,05 m², au 1er étage, de trois pièces\nCave au sous-sol\n"
    "Mansarde au 4ème étage\nOccupé\nMise à prix : 90 000 €\nCannes\n37, rue du Docteur Calmette\n2ème lot\nUn appartement\n"
    "de 70,78 m², de quatre pièces\nCave au sous-sol\nOccupé\nMise à prix : 80 000 €\nLe Cannet\nLes Cèdres\n"
    "4, av. Dolce Farniente\nMaître Laurence Sportes, Avocat"
)


def test_077acb2a_two_lot_page_keeps_abstaining() -> None:
    # La vente du 2e lot (Le Cannet, 70,78 m²) a stocké la description du 1er lot : lire la surface dans la
    # description afficherait 63,05 m² pour le mauvais appartement. Tant que le lot de la vente n'est pas
    # rattaché de façon sûre, la surface reste vide.
    row = _row(
        "077acb2a",
        "licitor",
        "https://www.licitor.com/annonce/11/04/62/vente-aux-encheres/un-appartement/le-cannet/alpes-maritimes/110462.html",
        "apartment",
        "Un appartement",
        "Un appartement. de 63,05 m², au 1er étage, de trois pièces Cave au sous-sol Mansarde au 4ème étage Occupé",
        raw_text=_CANNES_PAGE,
        page_text=_CANNES_PAGE,
        payload={
            "external_id": "110462",
            "source_lots": [
                {
                    "title": "Un appartement",
                    "raw_text": "06\nLe Cannet\nUn appartement\nde 70,78 m², de quatre pièces Cave au sous-sol Occupé",
                    "starting_price_eur": "80 000 €",
                }
            ],
        },
    )
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.app_surface_m2 is None
    assert sale.surface_m2 != Decimal("63.05")
