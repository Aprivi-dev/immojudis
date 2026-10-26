"""Lecture complète des annonces notariales (API publique + page Immo-Interactif).

Toutes les données sont fictives : elles reprennent la forme des réponses
publiques observées en octobre 2026, jamais leur contenu.
"""

import json

import pytest

from src.normalize import normalize_sale
from src.sources import notaires
from src.sources.notaires_extraction import (
    DOCUMENTS_ACCESS_NOTE,
    cadastral_parcels,
    floor_price_from_text,
    parse_immo_interactif_page,
    sale_conditions,
    virtual_tours,
)

VAE_URL = "https://www.immobilier.notaires.fr/fr/annonce-immo/adjudication/maison/exempleville-33/9000001"
VNI_URL = "https://www.immo-interactif.fr/encheres-en-ligne/appartement/exempleville-33/9000002"


def vae_payload(**transaction_overrides) -> str:
    transaction = {
        "reference": "REF-VAE-FICTIVE",
        "dateActivation": "2026-08-25T15:44:37Z",
        "dateMaj": "2026-10-09T13:27:27Z",
        "crpcen": "33999",
        "descriptions": [{
            "langue": "fr",
            "descCourte": "Maison à rénover",
            "descLongue": (
                "Maison d'habitation à rénover. Cadastrée section AB n° 12 et 13 pour 610 m². "
                "Visite virtuelle : https://view.ricoh360.com/00000000-fictif. "
                "Cahier des conditions de vente consultable en l'office."
            ),
        }],
        "multimedias": [
            {"nomDocument": "facade.jpg", "urlHighestResolution": "https://media.immobilier.notaires.fr/a.jpg"},
            {"nomDocument": "plan rdc.PNG", "urlHighestResolution": "https://media.immobilier.notaires.fr/b.jpg"},
        ],
        "visite": {"visiteLibre": "Visites les 15/10 et 22/10 à 14h00", "visiteFixe": '[{"opened":false}]'},
        "typeAdjudication": "VOLONTAIRE",
        "natureMiseAPrix": "FACULTE_BAISSE",
        "miseAPrix": 120000,
        "detailFaculteBaisse": "avec faculté de baisse de 10 000 € jusqu'à 90 000 euros",
        "consignation": 12000,
        "surenchere": "OUI",
        "seanceDate": "2026-11-05T13:30:00Z",
        "seancePaiement": "VIREMENT",
        "detailVirement": "3 jours avant l'adjudication",
        "modeVente": "BOUGIE",
        "origineJudiciaire": "LICITATION",
        "bienVendu": "NON",
        "adresse4": "Salle des ventes fictive",
        "codePostal": "33000",
        "ville": "EXEMPLEVILLE",
    }
    transaction.update(transaction_overrides)
    return json.dumps({
        "id": 9000001,
        "typeTransaction": "VAE",
        "vae": transaction,
        "bien": {
            "typeBien": "MAI",
            "maison": {
                "typeBien": "MAI",
                "communeNom": "Exempleville",
                "codePostal": "33000",
                "inseeCommune": "33999",
                "inseeDepartement": "33",
                "adresse4": "1 rue Fictive",
                "sousType": "PAVILLON",
                "ancienNeuf": "ANCIEN",
                "etat": "RENOVER",
                "epoqueConstruction": "D",
                "surfaceHabitable": 95.0,
                "surfaceTerrain": 610,
                "surfaceSejour": 28.0,
                "nbPieces": 4,
                "nbChambres": 3,
                "situationLocative": "LIBRE",
                "chauffage": "INDIVIDUEL",
                "typeCuisine": "AMERICAINE",
                "terrasse": "OUI",
                "piscine": "NON",
                "jardin": "INCONNU",
                "checkEcole": "OUI",
                "ecole": "DIST300",
                "checkGare": "NON",
                "consommationClasse": "Z",
                "emissionGesClasse": "Z",
                "taxeFonciere": 1200,
                "servitude": "non",
            },
        },
        "contact": {"nom": "Service immobilier fictif", "telephone": "0500000000", "mail": "contact@office-fictif.test"},
    })


def vni_payload(documents=None, **transaction_overrides) -> str:
    transaction = {
        "reference": "REF-VNI-FICTIVE",
        "dateActivation": "2026-10-09T13:08:41Z",
        "dateMaj": "2026-10-10T08:20:55Z",
        "descriptions": [{"langue": "fr", "descCourte": "Appartement familial", "descLongue": "Appartement de 80 m²."}],
        "visite": {"visiteLibre": "Samedi 24 octobre (10h-13h)"},
        "premierPrix": 200000,
        "pasOffres": 5000,
        "prixMin": 333333,
        "prixTotal": 348333,
        "emolumentsNegociation": 15000,
        "redevableEmoluments": "ACQUEREUR",
        "fraisPub": 0,
        "systemeEncheres": "ASCENDANTES",
        "ventePrivee": "NON",
        "dateDebutEncheres": "2026-11-16T12:00:00Z",
        "dateFinEncheres": "2026-11-17T12:00:00Z",
        "dateServeur": "2026-10-11T11:17:42Z",
    }
    if documents is not None:
        transaction["documents"] = documents
    transaction.update(transaction_overrides)
    return json.dumps({
        "id": 9000002,
        "typeTransaction": "VNI",
        "vni": transaction,
        "bien": {
            "typeBien": "APP",
            "appartement": {
                "typeBien": "APP",
                "communeNom": "Exempleville",
                "codePostal": "33000",
                "inseeCommune": "33999",
                "inseeDepartement": "33",
                "adresse4": "2 avenue Fictive",
                "coordonneesExactesW84": {"coordonneeX": -0.57, "coordonneeY": 44.84},
                "surfaceHabitable": 80.0,
                "surfaceCarrez": 79.5,
                "etage": 2,
                "nbEtages": 5,
                "ascenseur": "OUI",
                "cave": "OUI",
                "consommationClasse": "D",
                "consommation": 200,
                "emissionGesClasse": "B",
                "emissionGes": 9,
                "depensesEnergieMin": 1000,
                "depensesEnergieMax": 1400,
                "depensesEnergieAnnee": 2023,
            },
            "copropriete": {"copropriete": "OUI", "nbLots": 12, "montantChargesAnnuelles": 2400, "montantTravaux": 0},
        },
        "contact": {"nom": "Négociatrice fictive", "telephone": "0600000000", "mail": "nego@office-fictif.test"},
    })


def devalue(root, *, wrap: bool = True) -> list:
    """Encode un objet au format « devalue » de Nuxt (tableau à références par indice)."""
    table: list = []

    def add(value):
        index = len(table)
        table.append(None)
        if isinstance(value, dict):
            table[index] = {key: add(item) for key, item in value.items()}
        elif isinstance(value, list):
            table[index] = [add(item) for item in value]
        else:
            table[index] = value
        return index

    if wrap:
        table.append(["ShallowReactive", 1])
        add(root)
    else:
        add(root)
    return table


def immo_page(ad_id=9000002, documents=None) -> str:
    ad = {
        "inotrAnnonceId": ad_id,
        "id": ad_id,
        "shortContact": {"afnor1": "Office fictif", "overrideOfficeName": "Office notarial fictif"},
        "seller": {"type": "PROFESSIONAL"},
        "negotiationFeeRate": 0.045,
        "negotiationFeeOwner": "BUYER",
        "pictures": [{"mediaId": 1, "fileName": "a.jpeg", "fileUrl": "https://media.immo-interactif.fr/1/a.jpeg"}],
        "documents": documents if documents is not None else [
            {"mediaId": 10, "fileName": "x1.pdf", "documentType": "PERFORMANCE_ENERGETIQUE"},
            {"mediaId": 11, "fileName": "x2.pdf", "documentType": "AMIANTE"},
            {"mediaId": 12, "fileName": "x3.pdf", "documentType": "AMIANTE"},
        ],
        "office": {
            "title": "Maître Fictif et Associés",
            "rateSchedule": {
                "active": True,
                "cumulative": True,
                "brackets": [
                    {"min": 0, "max": 150000, "flatRate": 7000, "cumulativeBase": False},
                    {"min": 150001, "percentageRate": 4.2, "cumulativeBase": True},
                ],
            },
        },
    }
    payload = devalue({"data": {"fetchPropertyAd": ad}, "serverRendered": True})
    return (
        "<html><body><div id='__nuxt'></div>"
        f'<script type="application/json" id="__NUXT_DATA__" data-ssr="true">{json.dumps(payload)}</script>'
        "</body></html>"
    )


def test_vae_detail_reads_sale_conditions_cadastre_and_display_block():
    detail = notaires.parse_notaires_detail_json(vae_payload(), fallback={"source_url": VAE_URL, "source_blocks": {}})

    blocks = detail["source_blocks"]
    display = blocks["caracteristiques_bien"]
    labels = {item["label"]: item["value"] for item in display["items"]}
    assert labels["Nature de la mise à prix"] == "Avec faculté de baisse"
    assert labels["Délai de la consignation"] == "3 jours avant l'adjudication"
    assert labels["Origine de la vente"] == "Licitation"
    assert labels["Époque de construction"] == "De 1948 à 1969"
    assert labels["Surface du séjour"] == "28 m²"
    assert labels["École"] == "à moins de 300 m"
    assert labels["Cuisine"] == "Américaine (ouverte)"
    assert labels["Servitude"] == "Non"
    assert labels["DPE"] == "Non soumis"
    assert "Gare" not in labels  # case « gare » décochée par l'office
    assert display["procedure"]["method_label"] == "Adjudication notariale volontaire à la bougie"
    assert display["procedure"]["prices"]["floor_price_eur"] == 90000
    assert display["procedure"]["deadline"] == {"at": "2026-11-05T13:30:00Z", "kind": "adjudication"}
    assert display["media"] == {"photos": 2, "plans": 1, "virtual_tours": 1}
    assert display["manager"] == {"service": "Service immobilier fictif", "heading": "Office notarial"}
    assert display["location"]["designation"] == "Parcelles AB 12, 13 à Exempleville"
    # Z = « non soumis » : jamais une classe énergétique.
    assert blocks["dpe_classe"] is None
    assert blocks["dpe_statut"] == "Non soumis"
    assert "DPE non soumis" in detail["risk_notes"]
    assert blocks["prix_plancher_eur"] == 90000
    assert blocks["visite_virtuelle"] == "https://view.ricoh360.com/00000000-fictif"
    assert detail["cadastre_location"]["insee_code"] == "33999"
    assert detail["cadastre_location"]["candidates"][0]["parcels"] == ["AB 12", "AB 13"]
    assert not detail.get("documents")  # cahier « consultable en l'office » : aucune URL publique
    features = detail["source_property_features"]
    assert features["sale_conditions"]["deposit_eur"] == 12000
    assert features["amenities"] == {"terrace": True, "pool": False}
    # Rien d'horodaté par la requête dans les blocs (empreinte du contenu source).
    assert "dateServeur" not in json.dumps(blocks)


def test_vni_detail_never_exposes_reserve_price_and_keeps_restricted_inventory():
    documents = [{"id": 1, "typeDocument": "DIAG_AMIANTE", "nomDocument": "amiante.pdf", "size": 2048},
                 {"id": 2, "typeDocument": "COPRO_REGLEMENT", "nomDocument": "rcp.pdf"}]
    detail = notaires.parse_notaires_detail_json(
        vni_payload(documents=documents), fallback={"source_url": VNI_URL, "source_blocks": {}}
    )

    serialized = json.dumps(detail, ensure_ascii=False)
    assert "333333" not in serialized and "348333" not in serialized  # prix minimum / total non publics
    assert "15000" not in serialized  # le montant d'honoraires révélerait le prix minimum
    display = detail["source_blocks"]["caracteristiques_bien"]
    labels = {item["label"]: item["value"] for item in display["items"]}
    assert labels["Honoraires de négociation"] == "4,50 % à la charge de l'acquéreur"
    assert labels["Charges annuelles"] == "2 400 €"
    assert labels["Nombre de lots"] == "12"
    assert labels["Ascenseur"] == "Oui"
    assert display["procedure"]["prices"] == {"first_offer_eur": 200000, "bid_increment_eur": 5000}
    assert display["procedure"]["window"] == {"opens_at": "2026-11-16T12:00:00Z", "closes_at": "2026-11-17T12:00:00Z"}
    assert [item["kind_label"] for item in display["attachments"]] == [
        "Diagnostic amiante", "Règlement de copropriété"]
    assert display["attachments_access"] == {"restricted": True, "note": DOCUMENTS_ACCESS_NOTE}
    assert display["energy"] == {"dpe_class": "D", "ges_class": "B"}
    # Les pièces ne sont pas téléchargeables publiquement : aucune pièce jointe inventée.
    assert not detail.get("documents")
    assert detail.get("cadastre_location") is None  # coordonnées exactes publiées
    sale = normalize_sale({"source_name": "notaires", "source_url": VNI_URL, **detail})
    assert sale.documents == []
    assert sale.raw_payload["source_blocks"]["pieces_dossier"] == "Diagnostic amiante ; Règlement de copropriété"


def test_immo_interactif_page_supplies_inventory_office_and_fee_schedule():
    page = parse_immo_interactif_page(immo_page(), "9000002")

    assert [item["label"] for item in page["documents_inventory"]] == [
        "Diagnostic de performance énergétique", "Diagnostic amiante", "Diagnostic amiante"]
    assert page["office"]["name"] == "Office notarial fictif"
    assert page["office"]["rate_schedule"]["brackets"][1]["percentageRate"] == 4.2
    assert page["negotiation_fee_rate"] == 0.045
    assert parse_immo_interactif_page(immo_page(), "1234") == {}  # autre annonce : rien
    assert parse_immo_interactif_page("<html></html>", "9000002") == {}

    api_docs = [{"typeDocument": "DIAG_AMIANTE"}]
    detail = notaires.parse_notaires_detail_json(
        vni_payload(documents=api_docs), fallback={"source_url": VNI_URL, "source_blocks": {}}, operator_page=page
    )
    display = detail["source_blocks"]["caracteristiques_bien"]
    # La pièce amiante annoncée par l'API et par la page n'est comptée qu'une fois par rang.
    assert [item["kind_label"] for item in display["attachments"]] == [
        "Diagnostic amiante", "Diagnostic de performance énergétique", "Diagnostic amiante"]
    assert display["manager"]["service"] == "Maître Fictif et Associés"
    fee_items = [item for item in display["items"] if item["group"] == "honoraires"]
    assert [item["value"] for item in fee_items] == ["7 000 € TTC (forfait)", "4,2 % TTC"]
    assert detail["source_property_features"]["seller_type"] == "PROFESSIONAL"


def test_adjudicated_notarial_sale_reports_its_price():
    detail = notaires.parse_notaires_detail_json(
        vae_payload(bienVendu="OUI", prixAdjudication=135000), fallback={"source_url": VAE_URL, "source_blocks": {}}
    )
    assert detail["adjudication_price_eur"] == 135000
    assert detail["status"] == "past"
    labels = {item["label"]: item["value"] for item in detail["source_blocks"]["caracteristiques_bien"]["items"]}
    assert labels["Résultat"] == "Vendu"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Cadastrée section OX n° 232 pour 610 m².", ["OX 232"]),
        ("cadastré Section ZA numéro 307 pour une contenance", ["ZA 307"]),
        ("cadastre : Section BI n° 5, lieudit X, Section BI n° 6, lieudit X", ["BI 5", "BI 6"]),
        ("cadastré MN 222.", ["MN 222"]),
        ("cadastrée DE 12 ans d'âge", []),
        ("Section AB n° 12 du lotissement", []),
    ],
)
def test_cadastral_parcels_are_read_only_when_explicit(text, expected):
    assert [ref.label() for ref in cadastral_parcels(text)] == expected


def test_small_text_helpers():
    assert floor_price_from_text("faculté de baisse jusqu'à atteindre un prix minimum de 1 250 000 euros") == 1250000
    assert floor_price_from_text("baisse du 1/3 à défaut d'enchères") is None
    assert virtual_tours("Voir https://my.matterport.com/show/?m=fictif. Plan : https://exemple.test/plan") == [
        "https://my.matterport.com/show/?m=fictif"]
    assert virtual_tours("https://visite.exemple.test/360") == ["https://visite.exemple.test/360"]


def test_immo_interactif_page_url_accepts_only_the_listing_identity():
    assert notaires.immo_interactif_page_url(VNI_URL, "9000002") == VNI_URL
    assert notaires.immo_interactif_page_url(VNI_URL + "?x=1", "9000002") == VNI_URL
    assert notaires.immo_interactif_page_url(VNI_URL, "9000003") is None
    assert notaires.immo_interactif_page_url(VAE_URL, "9000001") is None
    assert notaires.immo_interactif_page_url("https://www.immo-interactif.fr/mon-compte/9000002", "9000002") is None


def test_detail_enrichment_reads_the_operator_page_once_and_tolerates_its_failure(monkeypatch):
    requested = []

    class PageClient:
        def __init__(self, **kwargs):
            assert kwargs["base_url"] == notaires.IMMO_INTERACTIF_ORIGIN
            assert kwargs["delay_seconds"] >= 2.0

        def get(self, url):
            requested.append(url)
            return immo_page()

    class ApiClient:
        def get(self, url):
            assert url.endswith("/9000002")
            return vni_payload()

    monkeypatch.setattr(notaires, "PoliteHttpClient", PageClient)
    settings = {"user_agent": "test", "request_delay_seconds": 0, "request_timeout_seconds": 1}
    token = notaires._PAGE_CONTEXT.set(({}, settings))
    try:
        sale = {"source_url": VNI_URL, "external_id": "9000002", "source_blocks": {"type_transaction": "VNI"}}
        errors: list[str] = []
        assert notaires._enrich_sale_from_detail(ApiClient(), sale, errors) is True
        assert errors == []
        assert requested == [VNI_URL]
        assert len(sale["source_blocks"]["caracteristiques_bien"]["attachments"]) == 3

        class BrokenPageClient(PageClient):
            def get(self, url):
                raise RuntimeError("page indisponible")

        notaires._PAGE_CONTEXT.get()[0].clear()
        monkeypatch.setattr(notaires, "PoliteHttpClient", BrokenPageClient)
        other = {"source_url": VNI_URL, "external_id": "9000002", "source_blocks": {"type_transaction": "VNI"}}
        assert notaires._enrich_sale_from_detail(ApiClient(), other, errors) is True
        assert errors == []
        assert "attachments" not in other["source_blocks"]["caracteristiques_bien"]
    finally:
        notaires._PAGE_CONTEXT.reset(token)


@pytest.mark.parametrize(
    ("fees", "reference", "expected"),
    [
        (15000, 333333, 0.045),  # cas courant
        (1000, 100000, 0.01),  # borne basse incluse
        (20000, 100000, 0.2),  # borne haute incluse
        (900, 100000, None),  # sous 1 % : donnée aberrante
        (20100, 100000, None),  # au-dessus de 20 %
        (6000, 1, None),  # prix de référence aberrant : taux de 6 000
        (15000, 0, None),  # sans prix de référence, pas de taux
    ],
)
def test_negotiation_fee_rate_outside_one_to_twenty_percent_is_left_absent(fees, reference, expected):
    conditions = sale_conditions("VNI", {"emolumentsNegociation": fees, "prixMin": reference})

    if expected is None:
        assert "negotiation_fee_rate" not in conditions
    else:
        assert conditions["negotiation_fee_rate"] == expected
