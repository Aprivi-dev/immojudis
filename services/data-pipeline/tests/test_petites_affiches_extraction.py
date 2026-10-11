"""Lecture structurée des fiches « Petites Affiches ».

Les fixtures HTML sont fictives (noms, téléphones et adresses inventés) ; elles
reproduisent l'ordre du texte des fiches stockées en production en octobre 2026
(relues en lecture seule) : fiche reprise de Vench, fiche réservée aux abonnés,
fiche publiant l'annonce légale complète.
"""

from __future__ import annotations

import copy
from pathlib import Path

from src.normalize import normalize_sale
from src.sources import petites_affiches
from src.sources.petites_affiches import (
    parse_petites_affiches_detail_html,
    refresh_petites_affiches_raw_sale,
)
from src.sources.petites_affiches_extraction import (
    extract_petites_affiches_fields,
    land_surface_from_contenance,
    parse_petites_affiches_page,
)

FIXTURES = Path(__file__).parent / "fixtures"
VENCH_URL = (
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/"
    "un-pavillon-d-habitation-a-exempleville-170001.html"
)
RESTRICTED_URL = (
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-appartement-a-sampleville-170002.html"
)
LEGAL_URL = (
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/licitation/"
    "une-maison-en-pierre-a-testbourg-58001.html"
)


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _vench() -> dict:
    return parse_petites_affiches_detail_html(_fixture("petites_affiches_fiche_vench.html"), VENCH_URL)


def test_vench_page_exposes_full_description_badges_and_sale_information() -> None:
    detail = _vench()

    assert detail["description"].startswith("UN PAVILLON d'habitation à Exempleville, de 120,72 m²")
    assert "Jardin avec cabanon" in detail["description"]
    assert detail["bedrooms_count"] == 4
    assert detail["occupancy_status"] == "vacant"
    assert detail["sale_date"] == "13/10/2026 14:00"
    assert detail["tribunal"] == "Tribunal Judiciaire de PONTOISE"
    assert detail["address"] == "12 rue des Essais, 95140 Exempleville"
    assert detail["lawyer_name"] == "Maître Jeanne EXEMPLE"
    assert detail["lawyer_contact"] == "0134000000"
    assert detail["land_surface_m2"] == "300"
    assert detail["property_type"] == "Maison"
    # La date de visite est gardée, pas l'état relatif (« Dans 8 jours ») qui change chaque jour.
    assert detail["visit_dates"] == ["Jeudi 01 Octobre 2026 à 11:00 — 12 rue des Essais, 95140 Exempleville"]
    # L'image générique d'un lot sans photo n'est pas une photo du bien.
    assert detail["source_images"] == [
        "https://www.petitesaffiches.fr/encheres-immobilieres/upload/lots/170001/img_1_e_fictive_l_1.jpg"
    ]
    blocks = detail["source_blocks"]
    assert blocks["reference_lot"] == "26/00042"
    assert blocks["acces_detail"] == "public"
    assert blocks["origine_annonce"] == "Vench.fr"
    assert blocks["publication_legale_date"] == "04/09/2026"
    assert "publication_legale_journal" not in blocks  # « Journal non renseigné »
    assert blocks["consultation_cahier_conditions"].endswith("ou au cabinet Maître Jeanne EXEMPLE")
    assert blocks["lieu_vente_adresse"] == "3 rue Victor Hugo, 95300 PONTOISE"
    assert blocks["pieces_jointes"] == "Aucune pièce jointe publiée sur la fiche"


def test_vench_page_feeds_the_characteristics_block() -> None:
    display = _vench()["source_blocks"]["caracteristiques_bien"]

    assert display["schema_version"] == "property_characteristics_v1"
    assert display["source"] == "petites_affiches"
    assert display["nature"] == [{"label": "Maison", "display": "Maison"}]
    items = {item["key"]: item["value"] for item in display["items"]}
    assert items["reference_lot"] == "26/00042"
    assert items["type_vente"] == "Judiciaire"
    assert items["bedrooms_count"] == "4"
    assert items["occupation"] == "Libre"
    assert items["origine_annonce"] == "Vench.fr"
    assert display["procedure"]["deadline"] == {"at": "2026-10-13T14:00:00", "kind": "adjudication"}
    assert display["procedure"]["prices"] == {"starting_price_eur": 130000.0}
    assert display["procedure"]["method_label"] == "Vente judiciaire"
    assert display["surfaces"] == {"land_surface_m2": "300"}
    assert display["media"] == {"photos": 1}
    assert display["attachments"] == []
    assert display["dates"] == {"published_on": "2026-09-04"}


def test_vench_page_normalizes_with_time_and_source_features() -> None:
    detail = _vench()
    sale = normalize_sale(detail)

    assert sale.sale_date is not None and sale.sale_date.isoformat() == "2026-10-13T12:00:00+00:00"
    assert sale.bedrooms_count == 4
    features = detail["source_property_features"]
    assert features["schema_version"] == "petites_affiches_features_v1"
    assert features["listing"]["origin"] == "Vench.fr"
    assert features["conditions"]["attachments_published"] is False
    assert features["visits"] == [
        {"date": "Jeudi 01 Octobre 2026", "time": "11:00", "location": "12 rue des Essais, 95140 Exempleville"}
    ]


def test_restricted_page_keeps_only_what_the_paywall_shows() -> None:
    detail = parse_petites_affiches_detail_html(_fixture("petites_affiches_fiche_abonnes.html"), RESTRICTED_URL)
    blocks = detail["source_blocks"]

    assert blocks["acces_detail"] == "abonnes"
    assert blocks["reference_lot"] == "25/00098"
    assert "descriptif_complet" not in blocks
    # Sans descriptif publié, la méta-description reste la seule description.
    assert detail["description"].startswith("Vente aux enchères d'un lot : UN APPARTEMENT à Sampleville")
    assert detail["lawyer_name"] == "Maître FICTIF"
    assert detail["lawyer_contact"] == "0900000000"
    items = {item["key"]: item["value"] for item in blocks["caracteristiques_bien"]["items"]}
    assert items["acces_detail"] == "Détail réservé aux abonnés de Petites Affiches"


def test_legal_announcement_is_split_from_lawyer_header_and_party_identities() -> None:
    detail = parse_petites_affiches_detail_html(_fixture("petites_affiches_fiche_annonce_legale.html"), LEGAL_URL)
    blocks = detail["source_blocks"]

    assert detail["description"].startswith("VENTE AUX ENCHERES PUBLIQUES EN UN LOT SUR LA COMMUNE DE TESTBOURG")
    assert "Adjudication le JEUDI 24 SEPTEMBRE 2026" in detail["description"]
    # L'identité des parties (« à la requête de… né le… ») n'est pas reprise dans le descriptif.
    assert "né le" not in detail["description"]
    assert "REQUETE" not in detail["description"]
    assert "[email" not in blocks["entete_avocat"]
    assert blocks["entete_avocat"].startswith("Maître Anne MODELE SELARL MODELE AVOCATS")
    assert blocks["numero_cahier_conditions"] == "26/00045"
    assert blocks["publication_legale_journal"] == "LA GAZETTE FICTIVE"
    assert blocks["designation_cadastrale"] == "Parcelles AB 107, 110 à Testbourg"
    assert detail["land_surface_m2"] == "1337"
    assert detail["visit_dates"] == []
    assert detail["lawyer_name"] == "SELARL MODELE AVOCATS"
    # Sans numéro de voie publié, les parcelles serviront à localiser le bien.
    location = detail["cadastre_location"]
    assert location["candidates"][0]["parcels"] == ["AB 107", "AB 110"]
    assert location["designation"] == "Parcelles AB 107, 110 à Testbourg"


def test_enrichment_replaces_card_title_with_detail_description_and_flags_access() -> None:
    card_sale = {
        "source_name": "petites_affiches",
        "source_url": VENCH_URL,
        "title": "UN PAVILLON d'habitation à Exempleville",
        "description": "UN PAVILLON d'habitation à Exempleville",
        "city": "Exempleville",
        "sale_date": "13/10/2026",
        "source_blocks": {"type_vente": "Judiciaire"},
        "source_property_features": {"schema_version": "card"},
    }

    class Client:
        def get(self, url: str) -> str:
            return _fixture("petites_affiches_fiche_vench.html")

    petites_affiches._enrich_sale_from_detail(Client(), card_sale, [])

    assert card_sale["source_detail_status"] == "complete"
    assert card_sale["description"].startswith("UN PAVILLON d'habitation à Exempleville, de 120,72 m²")
    assert card_sale["sale_date"] == "13/10/2026 14:00"
    assert card_sale["bedrooms_count"] == 4
    assert card_sale["source_property_features"]["schema_version"] == "petites_affiches_features_v1"
    assert card_sale["source_blocks"]["type_vente"] == "Judiciaire"
    assert card_sale["source_blocks"]["caracteristiques_bien"]["source"] == "petites_affiches"


def test_restricted_detail_status_comes_from_the_structured_reading() -> None:
    sale = {"source_name": "petites_affiches", "source_url": RESTRICTED_URL, "city": "Sampleville"}

    class Client:
        def get(self, url: str) -> str:
            return _fixture("petites_affiches_fiche_abonnes.html")

    petites_affiches._enrich_sale_from_detail(Client(), sale, [])

    assert sale["source_detail_status"] == "restricted"


def test_refresh_replays_stored_page_text_without_network() -> None:
    page_text = _vench()["source_blocks"]["page_text"]
    stored = {
        "source_name": "petites_affiches",
        "source_url": VENCH_URL,
        "title": "UN PAVILLON d'habitation à Exempleville",
        "description": "UN PAVILLON d'habitation à Exempleville",
        "city": "Exempleville",
        "source_detail_status": "complete",
        "visit_dates": ["Visite finie Jeudi 01 Octobre 2026 à :"],
        "source_images": [
            "https://www.petitesaffiches.fr/encheres-immobilieres/cache/images/default-pic.png",
        ],
        "raw_image_url": "https://www.petitesaffiches.fr/encheres-immobilieres/cache/images/default-pic.png",
        "source_blocks": {
            "page_text": page_text,
            "titre_detail": "UN PAVILLON d'habitation à Exempleville",
            "type_vente": "Judiciaire",
            "visites": "Visite finie Jeudi 01 Octobre 2026 à :",
        },
    }

    assert refresh_petites_affiches_raw_sale(stored) is True

    assert stored["description"].startswith("UN PAVILLON d'habitation à Exempleville, de 120,72 m²")
    assert stored["visit_dates"] == ["Jeudi 01 Octobre 2026 à 11:00 — 12 rue des Essais, 95140 Exempleville"]
    assert stored["source_blocks"]["visites"] == stored["visit_dates"][0]
    assert stored["source_images"] == []
    assert stored["raw_image_url"] is None
    assert stored["source_blocks"]["caracteristiques_bien"]["items"][0]["value"] == "26/00042"
    # Rejouer deux fois donne le même résultat.
    snapshot = copy.deepcopy(stored)
    assert refresh_petites_affiches_raw_sale(stored) is True
    assert stored == snapshot


def test_recompute_replays_petites_affiches_and_encheres_immobilieres_rows() -> None:
    from src.recompute_scoring import _recomputed_sale_from_storage_row

    page_text = _vench()["source_blocks"]["page_text"]
    row = {
        "id": "00000000-0000-4000-8000-000000000002",
        "source_name": "petites_affiches",
        "source_url": VENCH_URL,
        "status": "upcoming",
        "raw_payload": {
            "source_name": "petites_affiches",
            "source_url": VENCH_URL,
            "title": "UN PAVILLON d'habitation à Exempleville",
            "description": "UN PAVILLON d'habitation à Exempleville",
            "city": "Exempleville",
            "source_blocks": {"page_text": page_text, "titre_detail": "UN PAVILLON d'habitation à Exempleville"},
        },
    }
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.description.startswith("UN PAVILLON d'habitation à Exempleville, de 120,72 m²")
    assert sale.raw_payload["source_blocks"]["caracteristiques_bien"]["source"] == "petites_affiches"

    ei_url = "https://encheresimmobilieres.fr/ventes/9901-appartement-a-exempleville-06"
    ei_row = {
        "id": "00000000-0000-4000-8000-000000000003",
        "source_name": "encheres_immobilieres",
        "source_url": ei_url,
        "status": "upcoming",
        "raw_payload": {
            "source_name": "encheres_immobilieres",
            "source_url": ei_url,
            "title": "APPARTEMENT à EXEMPLEVILLE (06)",
            "description": "Un appartement de 70 m² à Exempleville.",
            "raw_image_url": "https://encheresimmobilieres.fr/images/departements/06.webp",
            "source_images": ["https://encheresimmobilieres.fr/images/departements/06.webp"],
        },
    }
    ei_sale = _recomputed_sale_from_storage_row(ei_row)

    assert ei_sale.raw_payload["raw_image_url"] is None
    assert ei_sale.raw_payload["source_images"] == []


def test_refresh_refuses_a_stored_page_of_another_lot() -> None:
    page_text = _vench()["source_blocks"]["page_text"]
    other_url = VENCH_URL.replace("exempleville-170001", "autreville-170009")
    stored = {
        "source_name": "petites_affiches",
        "source_url": other_url,
        "description": "UNE MAISON à Autreville",
        "source_blocks": {"page_text": page_text, "titre_detail": "UNE MAISON à Autreville"},
    }

    assert refresh_petites_affiches_raw_sale(stored) is False
    assert stored["description"] == "UNE MAISON à Autreville"


def test_refresh_cleans_legacy_visit_labels_when_no_page_text_was_kept() -> None:
    stored = {
        "source_name": "petites_affiches",
        "source_url": VENCH_URL,
        "visit_dates": [
            "Visite finie Mercredi 16 Septembre 2026 à 14:30 49 avenue Fictive, 93700 Exempleville",
            "Aucune visite n'a été renseignée pour ce lot. Contact des visites [c_tel_block] [/c_tel_block]",
            "Dans 9 jours Vendredi 02 Octobre 2026 à :",
        ],
    }

    assert refresh_petites_affiches_raw_sale(stored) is False
    assert stored["visit_dates"] == [
        "Mercredi 16 Septembre 2026 à 14:30 49 avenue Fictive, 93700 Exempleville",
        "Vendredi 02 Octobre 2026",
    ]


def test_page_reader_handles_inline_values_and_partial_paywall_notice() -> None:
    page = parse_petites_affiches_page(
        "Lot / Réf.: 261\nMise à Prix :\n90 000\n€\n•\nEn attente du résultat\n5 pièces -\nLibre\n"
        "UN PAVILLON D 'HABITATION\nLe + des Petites Affiches\n"
        "Désolé mais cette information est réservée uniquement aux abonnés, merci de vous identifier\n"
        "Informations sur la vente\nVente le\n14/11/2026\nà\n14:00\n"
        "Publication légale : inconnu du 09/10/2026\nVisites\nAucune visite n'a été renseignée pour ce lot.\n"
        "Adresse :\n112 rue Imaginaire , 60730 EXEMPLEBOURG\nDemander plus d'informations"
    )

    assert page.reference == "261"
    assert page.starting_price == "90 000"
    assert page.rooms_count == 5
    assert page.occupancy_status == "vacant"
    assert page.announcement_text == "UN PAVILLON D 'HABITATION"
    assert page.restricted is False  # seul l'encadré « Le + » est réservé
    assert page.publication_journal is None
    assert page.publication_date == "09/10/2026"
    assert page.visits == []
    assert page.address == "112 rue Imaginaire , 60730 EXEMPLEBOURG"


def test_extract_returns_none_for_text_that_is_not_a_listing() -> None:
    assert extract_petites_affiches_fields("Accueil\nActualités\nNewsletter") is None


def test_land_surface_reads_spelled_and_cadastral_forms() -> None:
    assert land_surface_from_contenance("Sur un terrain de 03 a 85 ca.") == "385"
    assert land_surface_from_contenance("Le tout sur un terrain de 00 hectare 04 ares 36 centiares.") == "436"
    assert land_surface_from_contenance("Section AB n° 1 pour une contenance de 1ha 56a 80ca") == "15680"
    assert land_surface_from_contenance("Appartement de 3 pièces") is None


NEWS_BLOCK = (
    "<div><p>News 09/10</p><p>À Nice, un nouveau bar à jeux a ouvert ses portes rue Pairolière</p>"
    "<p>News 09/10</p><p>Appel à intérêt : un local commercial de 1 273 m² à Cap d'Ail proposé à la location</p></div>"
)


def test_site_news_headlines_never_become_the_property_surface() -> None:
    # A members-only page publishes no surface: the « 1 273 m² » of a news
    # headline about another property must not take its place.
    html = _fixture("petites_affiches_fiche_abonnes.html")

    for block in (NEWS_BLOCK, NEWS_BLOCK.replace("<div>", '<div class="bloc-news">')):
        detail = parse_petites_affiches_detail_html(html.replace("<body>", f"<body>{block}", 1), RESTRICTED_URL)
        sale = normalize_sale(detail)

        assert sale.surface_m2 is None
        assert "Cap d'Ail" not in detail["raw_text"]
        assert "Cap d'Ail" not in (detail["description"] or "")
