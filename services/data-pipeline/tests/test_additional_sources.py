import json

from src.raw_models import validate_raw_sales
from src.sources.agrasc import parse_agrasc_html
from src.sources.cessions_etat import parse_cessions_etat_html
from src.sources.encheres_immobilieres import parse_encheres_immobilieres_html
from src.sources.notaires import parse_notaires_json
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
    assert sales[0]["starting_price_eur"] == 250000
    assert validate_raw_sales("notaires", sales, []) == sales
