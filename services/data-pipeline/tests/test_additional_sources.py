import json

from src.raw_models import validate_raw_sales
from src.sources import notaires
from src.sources import petites_affiches
from src.sources.agrasc import parse_agrasc_html
from src.sources.cessions_etat import parse_cessions_etat_html
from src.sources.encheres_immobilieres import parse_encheres_immobilieres_html
from src.sources.notaires import parse_notaires_detail_json, parse_notaires_json
from src.sources.petites_affiches import parse_petites_affiches_detail_html, parse_petites_affiches_html


def test_parse_petites_affiches_public_cards() -> None:
    html = """
    <div class="annonce_lot_1 col-md-6">
      <div class="annonceListe">
        <div class="imgList">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html">
            <img data-src="/image.jpg" />
          </a>
          <div class="miseAPrix">Mise a Prix : <strong>80 000</strong> €</div>
        </div>
        <div class="titreVente">
          <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html">
            UN APPARTEMENT a BORDEAUX <br /><strong>Ref. : 123 - Appartement</strong>
          </a>
        </div>
        <div class="lieuVente"><strong>TJ DE BORDEAUX</strong></div>
        <div class="typeVente"><strong>Judiciaire</strong></div>
        <div class="adresse"><strong class="lot-adresse">Bordeaux</strong></div>
        <div class="dateVente"><strong>24/06/2026</strong></div>
        <div class="infos">51 m² - 33000 Bordeaux - Maître Dupont, avocat</div>
      </div>
    </div>
    """

    sales = parse_petites_affiches_html(html, fallback_department="33")

    assert sales[0]["source_name"] == "petites_affiches"
    assert sales[0]["department"] == "33"
    assert sales[0]["city"] == "Bordeaux"
    assert sales[0]["starting_price_eur"] == "80 000"
    assert sales[0]["tribunal"] == "TJ DE BORDEAUX"
    assert sales[0]["surface_m2"] == "51"
    assert sales[0]["postal_code"] == "33000"
    assert sales[0]["lawyer_name"].startswith("Maître Dupont")
    assert validate_raw_sales("petites_affiches", sales, []) == sales


def test_parse_petites_affiches_public_detail() -> None:
    html = """
    <meta name="description" content="Vente aux enchères d'un lot : UN APPARTEMENT à Bordeaux vendu au tribunal judiciaire de TJ DE BORDEAUX le 18/06/2026" />
    <div class="row detail default">
      <h4>Mise à Prix : <strong>15 300</strong> €</h4>
      <div class="alert">réservée aux abonnés</div>
      <div class="lot-adresse"><h4>Adresse : 33000 Bordeaux</h4></div>
    </div>
    <div class="contact-container">
      <ul>
        <li><a title="Maître MERLIN-LABRE"><strong>Maître MERLIN-LABRE</strong></a></li>
        <li>0422140871</li>
      </ul>
      <div class="lieu-vente"><strong><a>TJ DE BORDEAUX</a></strong></div>
    </div>
    """

    detail = parse_petites_affiches_detail_html(html, "https://www.petitesaffiches.fr/vente.html")

    assert detail["description"].startswith("Vente aux enchères")
    assert detail["address"] == "33000 Bordeaux"
    assert detail["postal_code"] == "33000"
    assert detail["starting_price_eur"] == "15 300"
    assert detail["lawyer_name"] == "Maître MERLIN-LABRE"
    assert detail["lawyer_contact"] == "0422140871"
    assert detail["tribunal"] == "TJ DE BORDEAUX"


def test_petites_affiches_uses_single_national_listing_when_all_departments_are_targeted(monkeypatch) -> None:
    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", petites_affiches.FRANCE_DEPARTMENTS)

    assert petites_affiches._department_filters() == (None,)


def test_petites_affiches_keeps_department_listing_for_partial_scope(monkeypatch) -> None:
    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", ("33", "75"))

    assert petites_affiches._department_filters() == ("33", "75")


def test_parse_cessions_etat_public_cards() -> None:
    html = """
    <div id="bien-38760" node_id="38760" data-titre="Immeuble a Vendre a Cancon"
      data-localisation="Cancon - 47" data-type-bien="Bureaux / Commerces"
      data-url="/biens/immeuble-vendre-cancon" data-nid="38760"
      data-lat="44.538328" data-lng="0.61918">
      <h3 class="fr-card__title"><a href="/biens/immeuble-vendre-cancon">Immeuble a Vendre a Cancon</a></h3>
      <div class="fr-card__detail">Reference : 240470000</div>
      <div class="fr-card__detail">120 m² - 47290 Cancon</div>
      <img src="/photo.png" />
    </div>
    """

    sales = parse_cessions_etat_html(html)

    assert sales[0]["source_name"] == "cessions_etat"
    assert sales[0]["department"] == "47"
    assert sales[0]["city"] == "Cancon"
    assert sales[0]["surface_m2"] == "120"
    assert sales[0]["postal_code"] == "47290"
    assert sales[0]["source_url"] == "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon"
    assert validate_raw_sales("cessions_etat", sales, []) == sales


def test_parse_agrasc_public_real_estate_cards() -> None:
    html = """
    <div class="fr-card card-vente-immo external-link">
      <h3 class="fr-card__title"><a href="https://example.test/vente">Maison</a></h3>
      <p class="fr-card__detail">Agen (47)</p>
      <p class="fr-card__desc">Maison avec jardin.</p>
      <p class="fr-badge fr-badge--sm">89 m²</p>
      <p class="fr-badge fr-badge--info">MAP : 91 466 €</p>
      <p class="fr-card__detail">16 au 18 juin 2026</p>
      <img src="/maison.jpg" />
    </div>
    """

    sales = parse_agrasc_html(html)

    assert sales[0]["source_name"] == "agrasc"
    assert sales[0]["department"] == "47"
    assert sales[0]["surface_m2"] == "89"
    assert sales[0]["starting_price_eur"] == "91 466"
    assert validate_raw_sales("agrasc", sales, []) == sales


def test_parse_encheres_immobilieres_next_payload() -> None:
    item = {
        "id": 9001,
        "titre": "APPARTEMENT 2P de 51,66 m2 a PAU (64)",
        "prix": 60000,
        "typeVente": "judiciaire",
        "adresse": "1 rue Test",
        "codePostal": "64000",
        "departement": "64",
        "ville": "PAU",
        "latitude": 43.3,
        "longitude": -0.37,
        "description": "Appartement occupe",
        "url": "9001-appartement-pau-64",
        "dateVente": "$D2026-07-09T09:00:00.000Z",
        "complement": "<p>Appartement occupe</p>",
        "complementVisite": "Sur rendez-vous",
        "prixAdjudication": None,
        "entete": "Cabinet Test",
        "ccv": "RG 1",
        "avocat": {"nom": "Cabinet Test", "tel": "0559000000"},
        "lots": [],
    }
    escaped = json.dumps(item, ensure_ascii=False).replace('"', '\\"')
    html = f'<script>self.__next_f.push([1,"{escaped}"])</script>'

    sales = parse_encheres_immobilieres_html(html)

    assert sales[0]["source_name"] == "encheres_immobilieres"
    assert sales[0]["department"] == "64"
    assert sales[0]["source_url"] == "https://encheresimmobilieres.fr/ventes/9001-appartement-pau-64"
    assert sales[0]["sale_date"] == "2026-07-09T09:00:00.000Z"
    assert sales[0]["occupancy_status"] == "occupied"
    assert sales[0]["rooms_count"] == 2
    assert validate_raw_sales("encheres_immobilieres", sales, []) == sales


def test_parse_notaires_public_api_payload() -> None:
    payload = json.dumps(
        {
            "annonceResumeDto": [
                {
                    "id": 1,
                    "annonceId": 2,
                    "reference": "VNI-TEST",
                    "typeTransaction": "VNI",
                    "descriptionFr": "Maison a vendre en immo-interactif",
                    "communeNom": "Bordeaux",
                    "codePostal": "33000",
                    "inseeDepartement": "33",
                    "typeBien": "MAI",
                    "surface": 100,
                    "prixAffiche": 250000,
                    "dateDebutEncheres": "2026-07-09T11:00:00Z",
                    "urlDetailAnnonceFr": "https://www.immo-interactif.fr/encheres-en-ligne/maison/bordeaux-33/2",
                },
                {"id": 3, "typeTransaction": "VENTE", "inseeDepartement": "33"},
            ]
        }
    )

    sales = parse_notaires_json(payload)

    assert len(sales) == 1
    assert sales[0]["source_name"] == "notaires"
    assert sales[0]["department"] == "33"
    assert sales[0]["property_type"] == "maison"
    assert sales[0]["starting_price_eur"] == 250000
    assert validate_raw_sales("notaires", sales, []) == sales


def test_notaires_uses_national_api_when_all_departments_are_targeted(monkeypatch) -> None:
    monkeypatch.setattr(notaires, "TARGET_DEPARTMENTS", notaires.FRANCE_DEPARTMENTS)

    assert notaires._department_filters() == (None,)
    assert "departements=" not in notaires._api_url(1, "VAE", None)


def test_notaires_keeps_department_filter_for_targeted_override(monkeypatch) -> None:
    monkeypatch.setattr(notaires, "TARGET_DEPARTMENTS", ("33", "75"))

    assert notaires._department_filters() == ("33", "75")
    assert "departements=33" in notaires._api_url(1, "VAE", "33")


def test_parse_notaires_detail_api_payload_extracts_rich_fields() -> None:
    payload = json.dumps(
        {
            "id": 1963393,
            "typeTransaction": "VAE",
            "vae": {
                "reference": "260633VaeTondu",
                "multimedias": [
                    {
                        "urlHighestResolution": (
                            "https://media.immobilier.notaires.fr/inotr/media/0/33015/1963393/photo_QXGA.jpg"
                        ),
                        "vga": {
                            "url": "https://media.immobilier.notaires.fr/inotr/media/0/33015/1963393/photo_VGA.jpg"
                        },
                    }
                ],
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Immeuble en pierre",
                        "descLongue": (
                            "VENTE AUX ENCHERES\nBORDEAUX (33000) 65, RUE DU TONDU\n"
                            "Un immeuble en pierre à usage d'habitation et de commerce de 206.90 m², "
                            "avec 2 chambres, salle d'eau et dépendance à usage de garage. "
                            "Arrêté de péril. ABSENCE DE VISITE. DPE Non soumis. "
                            "Me Edouard FIGEROU, notaire à Bordeaux."
                        ),
                    }
                ],
                "visite": {"visiteLibre": "mercredi 27 mai de 14h00 a 15h00"},
                "miseAPrix": 300000,
                "consignation": 60000,
                "dateMaj": "2026-06-08T08:58:49Z",
                "seanceDate": "2026-06-24T12:30:00Z",
                "adresse4": "6 rue Mably",
                "codePostal": "33000",
                "ville": "BORDEAUX",
                "bienVendu": "NON",
                "origineJudiciaire": "ADJUDICATION",
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "65 RUE DU TONDU",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                    "departementNom": "Gironde",
                    "surfaceHabitable": 206.9,
                    "surfaceTerrain": 266,
                    "nbPieces": 4,
                    "situationLocative": "LIBRE",
                    "stationnement": "INCONNU",
                    "ancienNeuf": "ANCIEN",
                    "etat": "RENOVER",
                    "sousType": "VILLE",
                    "nbEtages": 1,
                    "coordonneesExactesW84": {"coordonneeX": -0.57918, "coordonneeY": 44.837789},
                },
            },
            "contact": {"nom": "Service immobilier", "telephone": "0761761899", "mail": "vente@example.test"},
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["address"] == "65 RUE DU TONDU, 33000 Bordeaux"
    assert detail["property_type"] == "immeuble"
    assert detail["description"].startswith("VENTE AUX ENCHERES BORDEAUX (33000) 65, RUE DU TONDU")
    assert detail["habitable_surface_m2"] == 206.9
    assert detail["land_surface_m2"] == 266
    assert detail["surface_source"] == "notaires.surfaceHabitable"
    assert detail["surface_confidence"] == 0.95
    assert "immeuble en pierre" in detail["surface_evidence"]
    assert detail["bedrooms_count"] == 2
    assert detail["bathrooms_count"] == 1
    assert detail["has_garage"] is True
    assert detail["occupancy_status"] == "LIBRE"
    assert detail["risk_notes"] == "Arrêté de péril; Absence de visite; DPE non soumis"
    assert detail["latitude"] == 44.837789
    assert detail["longitude"] == -0.57918
    assert detail["source_images"] == [
        "https://media.immobilier.notaires.fr/inotr/media/0/33015/1963393/photo_QXGA.jpg"
    ]
    assert detail["lawyer_contact"] == "0761761899 | vente@example.test"
    assert detail["source_blocks"]["consignation"] == 60000
    assert detail["source_blocks"]["origine_judiciaire"] == "ADJUDICATION"
    assert detail["source_blocks"]["source_updated_at"] == "2026-06-08T08:58:49Z"
    assert detail["source_blocks"]["auction_location"] == "6 rue Mably, 33000 BORDEAUX"
    assert detail["source_blocks"]["notary_name"] == "Me Edouard FIGEROU"
    assert detail["source_blocks"]["usage"] == "VILLE"
    assert detail["source_blocks"]["etat"] == "RENOVER"
    assert detail["source_blocks"]["ancien_neuf"] == "ANCIEN"
    assert detail["source_blocks"]["nb_etages"] == 1


def test_parse_notaires_detail_extracts_address_from_description() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descLongue": (
                            "LE TEICH (33470) – 20 Rue du Milon Quartier résidentiel "
                            "Maison à démolir 52 m² environ, faisant l'objet d'un arrêté de péril. "
                            "Le tout sur un terrain cadastré pour 322 m²."
                        ),
                    }
                ],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "codePostal": "33470",
                    "communeNom": "Teich",
                    "inseeDepartement": "33",
                    "surfaceTerrain": 322,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["address"] == "20 Rue du Milon, 33470 Teich"
    assert detail["property_type"] == "maison"
    assert detail["surface_m2"] == 52
    assert detail["habitable_surface_m2"] == 52
    assert detail["land_surface_m2"] == 322
    assert detail["surface_source"] == "notaires.description.surface_batie"
    assert "Maison à démolir 52 m² environ" in detail["surface_evidence"]


def test_parse_notaires_detail_extracts_main_surface_from_description_without_structured_field() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Immeuble en pierre",
                        "descLongue": (
                            "BORDEAUX (33000) 65, RUE DU TONDU "
                            "Un immeuble en pierre à usage d'habitation et de commerce de 206.90 m², comprenant : "
                            "- Sous-sol partiel de 35 m² environ. "
                            "- A l'étage : un appartement de 84 m² environ. "
                            "Ledit ensemble est cadastré section n° 179 et HN n°219 pour un total de 266 m²."
                        ),
                    }
                ],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "65 RUE DU TONDU",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                    "surfaceTerrain": 266,
                    "nbPieces": 4,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["property_type"] == "immeuble"
    assert detail["surface_m2"] == 206.9
    assert detail["habitable_surface_m2"] == 206.9
    assert detail["land_surface_m2"] == 266
    assert detail["surface_source"] == "notaires.description.surface_batie"
    assert "immeuble en pierre" in detail["surface_evidence"]


def test_parse_notaires_detail_keeps_cadastral_surface_when_habitable_placeholder() -> None:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Maison à réhabiliter",
                        "descLongue": (
                            "BORDEAUX (33000) 135, RUE KLÉBER Une maison à réhabiliter. "
                            "Cadastrée section CT n°363 pour un total de 44 m². DPE : Non soumis."
                        ),
                    }
                ],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "135 RUE KLÉBER",
                    "codePostal": "33000",
                    "communeNom": "Bordeaux",
                    "inseeDepartement": "33",
                    "surfaceHabitable": 1.0,
                    "nbPieces": 5,
                },
            },
        }
    )

    detail = parse_notaires_detail_json(payload)

    assert detail["address"] == "135 RUE KLÉBER, 33000 Bordeaux"
    assert detail["property_type"] == "maison"
    assert detail["surface_m2"] is None
    assert detail["habitable_surface_m2"] is None
    assert detail["land_surface_m2"] == 44
    assert detail["surface_source"] == "notaires.description.cadastre"
    assert detail["surface_confidence"] == 0.9
    assert detail["surface_evidence"] == "Cadastrée section CT n°363 pour un total de 44 m²."
    assert detail["rooms_count"] == 5
    assert detail["risk_notes"] == "DPE non soumis"
