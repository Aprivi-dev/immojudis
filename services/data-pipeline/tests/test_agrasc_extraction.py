"""Lecture structurée des fiches opérateur AGRASC (données fictives)."""

import json

import pytest

from src.normalize import normalize_sale
from src.pdf_document_types import _canonical_document_type
from src.sources.agrasc_extraction import (
    classify_operator_document,
    points_cles_facts,
    public_document_label,
    refresh_agrasc_raw_sale,
)
from src.sources.agrasc_operators import parse_agora_operator_detail, parse_trocadero_operator_detail

URL = "https://www.agorastore-immo.fr/vente-occasion/immobilier/appartement/appartement-loue-50-m-exempleville-99-900001.aspx"


def agora_page(product_id=900001) -> str:
    model = {
        "product": {
            "id": product_id,
            "realEstateInformation": {"lastVisitDate": "2026-10-16T15:00:00+02:00", "dpeRatingValue": "E"},
            "productSupervisorInformation": {"productSupervisor": {"fullName": "Contact fictif",
                                                                   "email": "immo-ventes@agorastore.fr"}},
        },
        "descriptifs": [
            {"groupName": "Default", "descriptifs": [
                {"descriptifLibelle": "Type de bien", "value": "Appartement loué"},
                {"descriptifLibelle": "Surface Carrez", "value": "50,10 m²"},
                {"descriptifLibelle": "Adresse", "value": "1 rue Fictive, 99000 Exempleville"},
                {"descriptifLibelle": "Etage", "value": "600,00 € par trimestre"},
            ]},
            {"groupName": "DetailsTechniques", "descriptifs": [
                {"descriptifLibelle": "Chauffage", "value": "Gaz"},
                {"descriptifLibelle": "Références cadastrales", "value": "AB 12"},
            ]},
            {"groupName": "ZonagePLU", "descriptifs": [
                {"descriptifLibelle": "Zonage", "value": "UA"},
                {"descriptifLibelle": "Points clés", "value": (
                    "- État d’occupation : Loué - bail de trois ans - loyer 500 €/mois dont 80 €/mois de charges.\n\n"
                    "- Taxe foncière : 650 € pour l’année 2025."
                )},
            ]},
        ],
        "documents": [
            {"fileName": "MODALITES DE VENTE - AGORASTORE", "url": "https://cdn.agorastore.fr/produits/documents/a.pdf"},
            {"fileName": "Descriptif et urbanisme - Exempleville", "url": "https://cdn.agorastore.fr/produits/documents/b.pdf"},
            {"fileName": "DIA-XX01-0000-000_Dossier_AGRASC,_Madame_Personne_Fictive",
             "url": "https://cdn.agorastore.fr/produits/documents/c.pdf"},
            {"fileName": "BORNAGE TERMINE", "url": "https://cdn.agorastore.fr/produits/documents/d.pdf"},
        ],
        "images": [{"url": "https://cdn.agorastore.fr/produits/images/a_original.jpg"}],
    }
    props = {
        "ficheProduitModel": {
            "productPageWrapper": {"productPageModel": model},
            "saleState": {"productId": product_id, "startDate": "2026-10-27T14:00:00+01:00",
                          "endDate": "2026-10-29T16:00:00+01:00", "initialPrice": 60000.0, "bidStep": 1000.0,
                          "tauxFraisAcheteur": 8.4, "isEnchereGlissante": True, "postponedTime": 2,
                          "requireProductAuthorization": True, "isTtc": True},
            "productGeolocation": {"latitude": 45.0, "longitude": 5.0, "formattedAddress": "1 rue Fictive"},
        }
    }
    return "<script>React.createElement(FicheProduitApp, " + json.dumps(props) + ");</script>"


@pytest.mark.parametrize(
    "label,expected",
    [
        ("MODALITES DE VENTE - AGORASTORE", "conditions_vente"),
        ("REGLEMENT DE CONSULTATION", "cahier_conditions_vente"),
        ("CONSULTATION RULES", "cahier_conditions_vente"),
        ("DIA-JPR01-2601-041_Dossier_AGRASC_,", "diagnostics_techniques"),
        ("DIAGS ERP - Complet Etat AGRASC", "diagnostics_techniques"),
        ("Diagnostics", "diagnostics_techniques"),
        ("Plomb", "diagnostics_techniques"),
        ("Audit", "diagnostics_techniques"),
        ("Assainissement", "diagnostics_techniques"),
        ("diagnostic assainissement copropriété box", "diagnostics_techniques"),
        ("Reglement-du-service-de-lassainissement_Dec 2025", None),
        ("Ventes immeubles info G assainissement 2026", None),
        ("BORNAGE TERMINE", "cadastre"),
        ("Descriptif et urbanisme - Revel (maison)", "annonce_vente"),
    ],
)
def test_operator_documents_get_an_explicit_type(label, expected):
    assert classify_operator_document(label) == expected


def test_explicit_type_wins_over_the_generic_classifier():
    # Sans type explicite, « CONSULTATION RULES » sur lesnotairesdutrocadero.fr devenait un « PV de notaire ».
    url = "https://lesnotairesdutrocadero.fr/wp-content/uploads/2026/09/CONSULTATION-RULES.pdf"
    assert _canonical_document_type(None, label="CONSULTATION RULES", url=url) == "pv_notaire"
    assert _canonical_document_type("cahier_conditions_vente", label="CONSULTATION RULES", url=url) == (
        "cahier_conditions_vente")


def test_document_labels_never_carry_a_person_name():
    assert public_document_label("DIA-XX01_Dossier_AGRASC,_Madame_Personne_Fictive") == "DIA-XX01_Dossier_AGRASC"
    assert public_document_label("Rapport M. Fictif") == "Rapport"
    assert public_document_label("Programme immobilier") == "Programme immobilier"


def test_points_cles_facts():
    facts = points_cles_facts(
        "- État d’occupation : loué via un bail (date d’effet : 01/05/22) pour un loyer initial de 700 € HC "
        "et 190 € de charges / mois.\n\n- Taxe foncière 2024 : 1 116€"
    )
    assert facts["occupancy"] == "rented"
    assert facts["rent_monthly_eur"] == 700.0
    assert facts["rent_basis"] == "hors charges"
    assert facts["rent_charges_monthly_eur"] == 190.0
    assert facts["property_tax_eur"] == 1116.0
    assert facts["property_tax_year"] == 2024
    assert points_cles_facts("- État d’occupation : libre de toute occupation.")["occupancy"] == "vacant"
    assert points_cles_facts("Aucun point particulier") == {}


def test_agora_detail_reads_fees_key_points_documents_and_display():
    detail = parse_agora_operator_detail(agora_page(), URL)

    assert [(doc["label"], doc.get("document_type")) for doc in detail["documents"]] == [
        ("MODALITES DE VENTE - AGORASTORE", "conditions_vente"),
        ("Descriptif et urbanisme - Exempleville", "annonce_vente"),
        ("DIA-XX01-0000-000_Dossier_AGRASC", "diagnostics_techniques"),
        ("BORNAGE TERMINE", "cadastre"),
    ]
    assert detail["occupancy_status"] == "rented"
    terms = detail["source_property_features"]["operator_sale_terms"]
    assert terms["buyer_fee_rate_pct"] == 8.4
    assert terms["bid_increment_eur"] == 1000.0
    assert detail["source_property_features"]["operator_key_points"]["rent_monthly_eur"] == 500.0
    assert detail["source_property_features"]["operator_geolocation"]["latitude"] == 45.0
    blocks = detail["source_blocks"]
    assert blocks["dpe_classe"] == "E"
    assert blocks["frais_acheteur_pct"] == 8.4
    assert blocks["loyer_mensuel_eur"] == 500.0
    display = blocks["caracteristiques_bien"]
    labels = {item["label"]: (item["value"], item["group"]) for item in display["items"]}
    assert labels["Frais acheteur"] == ("8,4 % TTC du prix d'adjudication", "vente")
    assert labels["Loyer mensuel"] == ("500 € charges comprises", "situation")
    assert labels["Taxe foncière"] == ("650 € (2025)", "divers")
    assert labels["Chauffage"] == ("Gaz", "equipements")
    assert labels["Charges de copropriété (publiées sous « Étage »)"] == ("600,00 € par trimestre", "copropriete")
    assert display["procedure"]["prices"] == {"starting_price_eur": 60000.0, "bid_increment_eur": 1000.0}
    assert display["procedure"]["visits"] == ["Dernière visite le 16/10/2026 à 15h00"]
    assert display["manager"]["service"] == "Agorastore (commercialisateur pour l'AGRASC)"
    assert "immo-ventes@agorastore.fr" not in json.dumps(detail)  # aucune adresse e-mail collectée
    assert [item["kind_label"] for item in display["attachments"]] == [
        "Modalités de vente", "Fiche descriptive et urbanisme", "Diagnostics", "Bornage / plan"]

    sale = normalize_sale({"source_name": "agrasc", "source_url": URL, "property_type": "Appartement", **detail})
    assert [doc.get("document_type") for doc in sale.documents] == [
        "conditions_vente", "annonce_vente", "diagnostics_techniques", "cadastre"]


def test_trocadero_documents_are_typed():
    html = (
        "<main><h1>Domaine fictif</h1><h2>Description du bien</h2><p>Propriété située à Exempleville (99000), "
        "1 chemin Fictif.</p><a href='/wp-content/uploads/REGLEMENT-DE-CONSULTATION.pdf'>REGLEMENT DE CONSULTATION</a>"
        "<a href='/wp-content/uploads/CONSULTATION-RULES.pdf'>CONSULTATION RULES</a></main>"
    )
    detail = parse_trocadero_operator_detail(html, "https://lesnotairesdutrocadero.fr/appel_d_offre/domaine-fictif/")
    assert [(doc["document_type"], doc.get("language")) for doc in detail["documents"]] == [
        ("cahier_conditions_vente", None), ("cahier_conditions_vente", "en")]


def test_refresh_replays_stored_operator_fields_without_network():
    raw = {
        "source_name": "agrasc",
        "source_url": URL,
        "occupancy_status": None,
        "visit_dates": ["2026-10-16T15:00:00+02:00"],
        "source_images": ["https://cdn.agorastore.fr/produits/images/a_original.jpg"],
        "documents": [{"url": "https://cdn.agorastore.fr/produits/documents/a.pdf", "label": "Diagnostics"}],
        "source_blocks": {"operator_fields": [
            ["Type de bien", "Maison"],
            ["Points clés", "- État d’occupation : libre de toute occupation.\n\n- Taxe foncière : 104 € pour l’année 2024."],
        ]},
    }
    assert refresh_agrasc_raw_sale(raw) is True
    assert raw["documents"][0]["document_type"] == "diagnostics_techniques"
    assert raw["occupancy_status"] == "vacant"
    display = raw["source_blocks"]["caracteristiques_bien"]
    assert {item["label"] for item in display["items"]} >= {"Type de bien", "Points clés", "Taxe foncière"}
    assert raw["source_blocks"]["taxe_fonciere_eur"] == 104.0
    # Une occupation déjà connue n'est jamais remplacée.
    raw["occupancy_status"] = "rented"
    refresh_agrasc_raw_sale(raw)
    assert raw["occupancy_status"] == "rented"
    assert refresh_agrasc_raw_sale({"source_name": "notaires"}) is False
