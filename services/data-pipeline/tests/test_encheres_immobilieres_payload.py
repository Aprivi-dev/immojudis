"""Objet ``vente`` des fiches « Enchères Immobilières » (flux Next.js de la page).

La fiche construite ici est fictive (vente, avocat, adresses inventés) mais suit
la structure observée en octobre 2026 : HTML rendu (onglet « Description »,
vignettes des ventes voisines, visuel du département, logo du journal) et objet
``vente`` transmis dans ``self.__next_f`` (pièces jointes, galerie, visites…).
"""

from __future__ import annotations

import json

from src.normalize import normalize_sale
from src.sources.encheres_immobilieres import (
    _enrich_sale_from_detail,
    parse_encheres_immobilieres_detail_html,
    refresh_encheres_immobilieres_raw_sale,
)
from src.sources.encheres_immobilieres_payload import extract_vente_payload, vente_fields

URL = "https://encheresimmobilieres.fr/ventes/9901-appartement-3p-de-7000-m-et-cave-a-exempleville-06"
DESCRIPTION_HTML = (
    "<h2>VENTE AUX ENCHÈRES PUBLIQUES</h2><p>au Tribunal Judiciaire de GRASSE</p>"
    "<p>Adjudication le 19 novembre 2026 à 9h00</p><p>UN APPARTEMENT de 70,00 m² et une cave</p>"
)
VENTE = {
    "id": 9901,
    "titre": "APPARTEMENT 3P de 70,00 m² et Cave à EXEMPLEVILLE (06)",
    "prix": 50000,
    "typeVente": "judiciaire",
    "typeEnchere": "normal",
    "adresse": "1 avenue Fictive",
    "codePostal": "06130",
    "departement": "06",
    "ville": "EXEMPLEVILLE",
    "adressesMultiples": False,
    "latitude": 43.6,
    "longitude": 6.9,
    "description": "$54",
    "dateVente": "$D2026-11-19T09:00:00.000Z",
    "dateParution": "$D2026-10-02T00:00:00.000Z",
    "premium": True,
    "complement": "<p><b>- APPARTEMENT 3P de 70,00 m² - lot 77 - occupé</b></p><p><b>- Cave - lot 53</b></p>",
    "entete": "Maître Claire TEST\nAvocat au Barreau de GRASSE\n",
    "ccv": "25/09/2025 RG 25/00999 ",
    "complementVisite": "Par la SELARL FICTIVE, Commissaires de justice",
    "prixAdjudication": None,
    "statut": "en_cours",
    "photos": [
        {"id": 2, "position": 1, "name": "2026/10/9901-1.webp?t=1", "venteId": 9901},
        {"id": 1, "position": 0, "name": "2026/10/9901-0.webp?t=1", "venteId": 9901},
    ],
    "lots": [
        {"designation": "• LOT n° 1 : Appartement", "prix": 40000, "complement": "de 70 m²", "adjudication": None},
        {"designation": "• LOT n° 2 : Cave", "prix": 10000, "complement": None, "adjudication": 12000},
    ],
    "tgi": {"nom": "Tribunal Judiciaire de Grasse", "adresse": "1 place du Palais", "codePostal": "06130",
            "ville": "GRASSE", "tel": "0400000000", "mail": "prenom.nom@justice.fr"},
    "avocat": {"nom": "Me Claire TEST", "adresse": "2 rue Exemple", "tel": "+33400000001",
               "email": "contact@cabinet-test.fr", "ville": "CANNES", "codePostal": "06400",
               "complement": "Avocat au Barreau de GRASSE"},
    "mandataire": None,
    "typesBiens": [{"venteId": 9901, "typeId": 1, "type": {"id": 1, "label": "Appartement"}}],
    "visites": [
        {"id": 1, "venteId": 9901, "start": "$D2026-10-30T09:00:00.000Z", "end": "$D2026-10-30T10:00:00.000Z",
         "complement": ""},
        {"id": 2, "venteId": 9901, "start": "$D2026-11-02T14:00:00.000Z", "end": "$D2026-11-02T15:00:00.000Z",
         "complement": "Maître TEST"},
    ],
    "documents": [
        {"id": 1, "type": "texte_complet", "name": "texte_complet.pdf"},
        {"id": 2, "type": "ccv", "name": "ccv_1.pdf"},
        {"id": 3, "type": "ccv", "name": "ccv_2.pdf"},
        {"id": 4, "type": "pv_descriptif", "name": "pv_descriptif.pdf"},
        {"id": 5, "type": "diagnostic", "name": "diagnostic.pdf"},
    ],
    "journal": {"id": 1, "journal": "La Tribune Fictive", "logo": "x.jpg"},
}


def _push(text: str) -> str:
    return f"<script>self.__next_f.push([1,{json.dumps(text)}])</script>"


def _page(vente: dict | None = VENTE) -> str:
    chunks = []
    if vente is not None:
        chunks.append(_push('5:["$","div",null,{"vente":' + json.dumps(vente, ensure_ascii=False) + "}]\n"))
        size = len(DESCRIPTION_HTML.encode("utf-8"))
        chunks.append(_push(f"54:T{size:x},"))
        chunks.append(_push(DESCRIPTION_HTML))
    return f"""<!DOCTYPE html><html><head><title>Fiche fictive</title></head><body>
    <a href="/"><img src="/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo.webp&amp;w=3840&amp;q=75" alt=""/></a>
    <h1>APPARTEMENT 3P de 70,00 m² et Cave à EXEMPLEVILLE (06)</h1>
    <p>Annonce n°</p><p>9901</p>
    <p>Adresse de la vente :</p><p>Tribunal Judiciaire de Grasse</p>
    <p>Date de la vente :</p><p>jeudi 19 novembre 2026 à 09h00</p>
    <img src="/_next/image?url=https%3A%2F%2Fencheresimmobilieres.fr%2Fimages%2Fdepartements%2F06.webp&amp;w=828&amp;q=75"/>
    <img src="/_next/image?url=https%3A%2F%2Falpha.tribuca.pro%2Fimg%2Fjournaux_vae%2Fabc.png&amp;w=640&amp;q=75"/>
    <img src="/_next/image?url=https%3A%2F%2Fencheresimmobilieres.fr%2Fimages%2Fphotos%2F2026%2F10%2F9901-0.webp&amp;w=3840&amp;q=75"/>
    <a href="/ventes/9800-autre-vente"><img src="/_next/image?url=https%3A%2F%2Fencheresimmobilieres.fr%2Fimages%2Fphotos%2F2026%2F09%2F9800-0.webp&amp;w=828&amp;q=75" alt="image de la vente"/>Autre vente</a>
    <h2>Description</h2><p>VENTE AUX ENCHÈRES PUBLIQUES au Tribunal Judiciaire de GRASSE</p>
    <p>Mise à prix : 50 000 €</p>
    {''.join(chunks)}
    </body></html>"""


def test_payload_reads_vente_object_and_resolves_description_chunk() -> None:
    vente = extract_vente_payload(_page(), "9901")

    assert vente is not None and vente["id"] == 9901
    assert vente["description"] == DESCRIPTION_HTML
    assert extract_vente_payload(_page(), "9902") is None
    assert extract_vente_payload(_page(None), "9901") is None


def test_payload_documents_photos_visits_and_references() -> None:
    read = vente_fields(extract_vente_payload(_page(), "9901"))
    fields = read["fields"]

    assert [(doc["label"], doc["url"], doc["type"]) for doc in fields["documents"]] == [
        ("Texte complet", "https://encheresimmobilieres.fr/documents/9901/texte_complet.pdf", "annonce_vente"),
        ("Cahier des conditions des ventes", "https://encheresimmobilieres.fr/documents/9901/ccv_1.pdf",
         "cahier_conditions"),
        ("Cahier des conditions des ventes (2)", "https://encheresimmobilieres.fr/documents/9901/ccv_2.pdf",
         "cahier_conditions"),
        ("PV de description", "https://encheresimmobilieres.fr/documents/9901/pv_descriptif.pdf", "pv_descriptif"),
        ("Diagnostic et urbanisme", "https://encheresimmobilieres.fr/documents/9901/diagnostic.pdf", "diagnostic"),
    ]
    assert fields["source_images"] == [
        "https://encheresimmobilieres.fr/images/photos/2026/10/9901-0.webp?t=1",
        "https://encheresimmobilieres.fr/images/photos/2026/10/9901-1.webp?t=1",
    ]
    # Le site enregistre l'heure affichée suivie de « Z » : 09:00 est l'heure de Paris.
    assert fields["sale_date"] == "2026-11-19T09:00:00+01:00"
    assert fields["visit_dates"] == [
        "vendredi 30 octobre 2026 de 09h00 à 10h00",
        "lundi 2 novembre 2026 de 14h00 à 15h00 (Maître TEST)",
    ]
    blocks = read["source_blocks"]
    assert blocks["numero_rg"] == "25/00999"
    assert blocks["date_depot_cahier"] == "25/09/2025"
    assert blocks["parution_journal"] == "La Tribune Fictive"
    assert blocks["lots_vente"].startswith("LOT n° 1 : Appartement — de 70 m² — mise à prix 40")
    assert "adjugé 12" in blocks["lots_vente"]
    features = read["source_property_features"]
    assert features["court"] == {"name": "Tribunal Judiciaire de Grasse", "address": "1 place du Palais, 06130 GRASSE",
                                 "phone": "0400000000"}  # adresse nominative du greffe non reprise
    assert features["media"]["attachment_count"] == 5


def test_characteristics_block_lists_attachments_and_procedure() -> None:
    display = vente_fields(extract_vente_payload(_page(), "9901"))["source_blocks"]["caracteristiques_bien"]

    assert display["schema_version"] == "property_characteristics_v1"
    assert display["nature"] == [{"label": "Appartement", "display": "Appartement"}]
    assert [item["kind_label"] for item in display["attachments"]][:2] == [
        "Texte complet", "Cahier des conditions des ventes",
    ]
    assert display["media"] == {"photos": 2}
    assert display["procedure"]["method_label"] == "Vente judiciaire"
    assert display["procedure"]["deadline"] == {"at": "2026-11-19T09:00:00+01:00", "kind": "adjudication"}
    items = {item["key"]: item["value"] for item in display["items"]}
    assert items["cahier_conditions"] == "RG 25/00999 — déposé le 25/09/2025"
    assert items["lot_2"].startswith("LOT n° 2 : Cave")
    assert display["dates"] == {"published_on": "2026-10-02"}


def test_detail_parser_uses_payload_gallery_and_drops_generic_images() -> None:
    detail = parse_encheres_immobilieres_detail_html(_page(), URL)

    assert detail["source_images"] == [
        "https://encheresimmobilieres.fr/images/photos/2026/10/9901-0.webp?t=1",
        "https://encheresimmobilieres.fr/images/photos/2026/10/9901-1.webp?t=1",
    ]
    assert len(detail["documents"]) == 5
    assert all(doc["url"].startswith("https://encheresimmobilieres.fr/documents/9901/") for doc in detail["documents"])
    assert detail["latitude"] == 43.6
    assert detail["lawyer_name"] == "Me Claire TEST"
    assert detail["source_blocks"]["caracteristiques_bien"]["source"] == "encheres_immobilieres"
    sale = normalize_sale(detail)
    assert len(sale.documents) == 5


def test_detail_without_payload_filters_html_images_and_home_link() -> None:
    detail = parse_encheres_immobilieres_detail_html(_page(None), URL)

    # Ni lien d'accueil pris pour une pièce jointe, ni visuel de département, logo de journal
    # ou vignette d'une autre vente.
    assert detail["documents"] == []
    assert detail["source_images"] == ["https://encheresimmobilieres.fr/images/photos/2026/10/9901-0.webp"]


def test_enrichment_replaces_card_values_with_payload_values() -> None:
    sale = {
        "source_name": "encheres_immobilieres",
        "source_url": URL,
        "external_id": "9901",
        "sale_date": "19 novembre 2026",
        "source_images": [],
        "documents": [],
    }

    class Client:
        def get(self, url: str) -> str:
            return _page()

    _enrich_sale_from_detail(Client(), sale, [])

    assert sale["source_detail_status"] == "complete"
    assert sale["sale_date"] == "2026-11-19T09:00:00+01:00"
    assert len(sale["documents"]) == 5
    assert sale["source_property_features"]["schema_version"] == "encheres_immobilieres_features_v1"


def test_refresh_removes_department_visual_and_other_sale_photos_from_stored_images() -> None:
    stored = {
        "source_name": "encheres_immobilieres",
        "source_url": URL,
        "external_id": "9901",
        "raw_image_url": "https://encheresimmobilieres.fr/images/departements/06.webp",
        "source_images": [
            "https://encheresimmobilieres.fr/images/departements/06.webp",
            "https://encheresimmobilieres.fr/_next/image?url=https%3A%2F%2Falpha.tribuca.pro%2Fimg%2Fjournaux_vae%2Fa.png&w=640&q=75",
            "https://encheresimmobilieres.fr/_next/image?url=https%3A%2F%2Fencheresimmobilieres.fr%2Fimages%2Fphotos%2F2026%2F09%2F9800-0.webp&w=828&q=75",
            "https://encheresimmobilieres.fr/images/photos/2026/10/9901-0.webp?t=1",
        ],
    }

    assert refresh_encheres_immobilieres_raw_sale(stored) is True
    assert stored["source_images"] == ["https://encheresimmobilieres.fr/images/photos/2026/10/9901-0.webp?t=1"]
    assert stored["raw_image_url"] == "https://encheresimmobilieres.fr/images/photos/2026/10/9901-0.webp?t=1"
    assert refresh_encheres_immobilieres_raw_sale(stored) is False
