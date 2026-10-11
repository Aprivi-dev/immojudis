"""Relecture locale des blocs « Enchères Publiques » (aucune requête, aucune collecte).

Les textes reprennent les formulations relevées dans les 22 ventes stockées en
production (octobre 2026, lecture seule) avec des lieux et montants fictifs.
"""

from __future__ import annotations

import json

from src.normalize import normalize_sale
from src.sources.encheres_publiques import parse_encheres_publiques_detail_html
from src.sources.encheres_publiques_extraction import (
    extract_encheres_publiques_characteristics,
    refresh_encheres_publiques_raw_sale,
)

URL = "https://www.encheres-publiques.com/encheres/immobilier/appartements/exempleville-76/appartement-situe-rue-test_190001"


def _stored_judicial() -> dict:
    return {
        "source_name": "encheres_publiques",
        "source_url": URL,
        "city": "Exempleville",
        "starting_price_eur": 44000,
        "sale_date": "2026-11-05T13:00:00+00:00",
        "visit_dates": ["26/10/2026 14:00 - 15:00 sur place"],
        "raw_text": "Un appartement de 81,90 m²\nType de vente: En salle - Vente judiciaire\nMise a prix: 44 000",
        "source_images": ["https://www.encheres-publiques.com/static/lot/photo/fictive.webp"],
        "source_blocks": {
            "description": (
                "Dans l’ensemble immobilier sis à Exempleville, cadastré section IT n°415 : un appartement de 81,90 m² "
                "(lot n°215), une cave (lot n°246). Occupation : Les lieux sont occupés par leur propriétaire."
            ),
            "conditions_de_vente": (
                "Les enchères qui ne seront pas inférieures à 500,00 €, ne pourront être portées que par le "
                "ministère d’un avocat au Barreau de Rouen."
            ),
            "frais_de_vente": "Outre les frais préalables inscrits au cahier de vente.",
            "renseignements_de_vente": (
                "Les clauses et conditions de vente peuvent être consultés au Greffe du juge de l’exécution du "
                "Tribunal judiciaire de ROUEN et au Cabinet de l’Avocat poursuivant."
            ),
            "occupation": "Libre de toute occupation",
            "dpe": "D",
            "visites": "Sur place.",
        },
    }


def test_judicial_sale_rules_fees_and_occupancy_are_read_from_stored_blocks() -> None:
    raw = _stored_judicial()

    assert refresh_encheres_publiques_raw_sale(raw) is True

    blocks = raw["source_blocks"]
    assert blocks["mode_participation"] == "En salle"
    assert blocks["cadre_vente"] == "Vente judiciaire"
    assert blocks["pas_enchere_eur"] == 500.0
    assert blocks["barreau_admis"] == "Rouen"
    assert blocks["consultation_cahier_conditions"].startswith("au Greffe du juge de l’exécution")
    # Le critère publié et le descriptif divergent : les deux sont gardés.
    assert blocks["occupation_selon_texte"] == "Les lieux sont occupés par leur propriétaire"
    assert blocks["designation_cadastrale"] == "Parcelle IT 415 à Exempleville"
    display = blocks["caracteristiques_bien"]
    items = {item["key"]: item["value"] for item in display["items"]}
    assert items["occupation_critere"] == "Libre de toute occupation"
    assert items["lots_copropriete"] == "215, 246"
    assert items["pieces_jointes"] == "Non collectées (accès au site soumis à autorisation)"
    assert display["energy"] == {"dpe_class": "D"}
    assert display["procedure"]["prices"] == {"starting_price_eur": 44000.0, "bid_increment_eur": 500.0}
    assert display["procedure"]["method_label"] == "Vente judiciaire — En salle"
    assert display["media"] == {"photos": 1}
    assert display["attachments"] == []
    features = raw["source_property_features"]
    assert features["schema_version"] == "encheres_publiques_features_v1"
    assert features["conditions"]["attachments_collected"] is False
    # Aucune pièce jointe n'est inventée.
    assert normalize_sale(raw).documents == []


def test_online_voluntary_sale_reads_buyer_fees_extension_and_floor_price() -> None:
    raw = {
        "source_name": "encheres_publiques",
        "source_url": URL,
        "raw_text": "Type de vente: En ligne - Vente volontaire",
        "source_sale_schedule": {"opens_at": "2026-11-01T09:00:00+00:00", "closes_at": "2026-11-02T17:00:00+00:00"},
        "source_blocks": {
            "conditions_de_vente": (
                "Si une offre est déposée dans les 4 minutes précédant la fin programmée des offres, celle-ci sera "
                "automatiquement décalée de 4 minutes Le bien est présenté en Immo-interactif à la hausse. "
                "Avec baisses successives jusqu’à 10 000,00€ en cas de carence d’enchères"
            ),
            "frais_de_vente": "Honoraires inclus à la charge de l'acquéreur (4.5%)",
            "organisateur": "Étude Fictive",
        },
    }

    extracted = extract_encheres_publiques_characteristics(raw)

    blocks = extracted["source_blocks"]
    assert blocks["honoraires_acquereur_pourcent"] == 4.5
    assert blocks["prolongation_minutes"] == 4
    assert blocks["prix_plancher_eur"] == 10000.0
    display = blocks["caracteristiques_bien"]
    items = {item["key"]: item["value"] for item in display["items"]}
    assert items["honoraires_acquereur"] == "4,5 %"
    assert items["format_enchere"] == "Immo-interactif"
    assert display["procedure"]["window"] == {
        "opens_at": "2026-11-01T09:00:00+00:00", "closes_at": "2026-11-02T17:00:00+00:00",
    }
    assert display["procedure"]["deadline"]["kind"] == "sale_window_close"


def test_refresh_ignores_other_sources_and_empty_blocks() -> None:
    assert refresh_encheres_publiques_raw_sale({"source_name": "vench", "source_blocks": {"description": "x"}}) is False
    assert refresh_encheres_publiques_raw_sale({"source_name": "encheres_publiques"}) is False


def test_detail_parser_keeps_extra_criteria_and_builds_characteristics() -> None:
    state = {
        "Adresse:1": {"__typename": "Adresse", "id": "1", "text": "1 Rue Test, 76000 Exempleville, France",
                      "ville": "Exempleville", "ville_slug": "exempleville-76"},
        "Lot:190001": {
            "__typename": "Lot", "id": "190001", "nom": "Appartement de 50 m²", "categorie": "immobilier",
            "type": "En salle", "type_de_vente": "Vente judiciaire", "adresse_physique": {"__ref": "Adresse:1"},
            "critere_etage": "3", "critere_chauffage": "Collectif gaz", "critere_occupation_du_bien": "Occupé",
            "infos_frais_de_vente": "Honoraires à la charge du vendeur", "mise_a_prix": 30000, "termine": False,
        },
    }
    html = (
        '<script id="__NEXT_DATA__" type="application/json">'
        + json.dumps({"props": {"pageProps": {"apolloState": {"data": state}}}})
        + "</script>"
    )

    detail = parse_encheres_publiques_detail_html(html, URL)

    assert detail["source_blocks"]["critere_etage"] == "3"
    items = {item["key"]: item["value"] for item in detail["source_blocks"]["caracteristiques_bien"]["items"]}
    assert items["critere_etage"] == "3"
    assert items["critere_chauffage"] == "Collectif gaz"
    assert items["honoraires_vendeur"] == "À la charge du vendeur"
    assert detail["documents"] == []
