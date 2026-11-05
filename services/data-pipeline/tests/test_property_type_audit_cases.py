"""Types de bien mal classés relevés par l'audit du 03/11/2026 (libellés et descriptions réels)."""

from __future__ import annotations

import pytest

from src.normalize import is_parking_label, normalize_property_type, normalize_sale


def _sale(source_name: str, property_type: str, description: str, title: str | None = None):
    return normalize_sale({
        "source_name": source_name,
        "source_url": f"https://example.test/{source_name}/vente",
        "property_type": property_type,
        "title": title or property_type,
        "description": description,
    })


@pytest.mark.parametrize(
    ("source", "label", "description", "title", "expected"),
    [
        (  # 1fc5d91a (info_encheres) : « Chalet » rangé en « other »
            "info_encheres", "Chalet",
            "Vente aux enchères publques : Commune d’USTOU un CHALET de 180m2 à GUZET Il s’agit d’un chalet sur 3 "
            "niveaux édifié afin d’accueillir des groupes", "Bien immobilier", "house",
        ),
        (  # ce253028 (licitor) : « Un pavillon » rangé en appartement
            "licitor", "Un pavillon",
            "Un pavillon. composé d'un rez-de-chaussée, d'un 1er étage et d'un 2ème étage sous toiture, comprenant : "
            "Au rez-de-chaussée : un espace à usage de laboratoire, un espace à usage de stockage, un quai de "
            "livraison et chambres froides Au 1er étage : un appartement utilisé à usage de stockage", None, "house",
        ),
        (  # c75b9227 (licitor) : « Un local à usage d'habitation » rangé en commerce
            "licitor", "Un local à usage d'habitation",
            "Un local à usage d'habitation. de 35,17 m² , au 3ème étage droite, comprenant : pièce principale, "
            "chambre Libre", None, "apartment",
        ),
        (  # 4ba21142 (licitor) : stationnements rangés en immeuble
            "licitor", "Dix emplacements couverts pour voiture",
            "Dix emplacements couverts pour voiture. bâtiment D, escalier P1 P2, aux 3ème, 4ème et 5ème étages "
            "Occupation à voir lors de la visite", None, "parking",
        ),
        (  # 1d0262fa (info_encheres) : « Comprenant 4 appartements » rangé en « mixed »
            "info_encheres", "mixed",
            "Vente aux enchères publiques : Un immeuble sis Commune de LANNEMEZAN, 65300, 61, rue Pasteur, "
            "cadastré section AC n°224 d’une contenance de 00a 23ca et section AC n° 225 d’une contenance de "
            "03a 27ca, Comprenant 4 appartements : - appartement de l’étage 1 nord, porte gauche",
            "Ensemble immobilier comprenant plusieurs appartements à LANNEMEZAN (65)", "building",
        ),
        (  # audit info_encheres : « UN IMMEUBLE COMPOSE D'APPARTEMENTS » rangé en appartement
            "info_encheres", "Appartement",
            "UN IMMEUBLE COMPOSE D'APPARTEMENTS ET DE GARAGES situé 12 rue des Lilas", None, "building",
        ),
    ],
)
def test_audit_property_types(source, label, description, title, expected) -> None:
    assert _sale(source, label, description, title).property_type == expected


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("Maison", "house"),
        ("Appartement dans un pavillon", "apartment"),
        ("Local commercial", "commercial"),
        ("Un local", "commercial"),
        ("Immeuble", "building"),
        ("Appartement dans un immeuble de 12 lots", "apartment"),
    ],
)
def test_existing_labels_keep_their_type(label: str, expected: str) -> None:
    assert normalize_property_type(label) == expected


def test_parking_label_reads_number_words_and_vehicle_wording() -> None:
    assert is_parking_label("Dix emplacements couverts pour voiture")
    assert is_parking_label("2 places de parking")
    assert not is_parking_label("Dix emplacements couverts pour voiture et un appartement")
