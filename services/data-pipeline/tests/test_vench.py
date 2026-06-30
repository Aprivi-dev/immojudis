from src.normalize import normalize_sale
from src.sources.vench import _filter_catalog_sales, parse_vench_detail_html, parse_vench_list_html


def test_parse_vench_list_html_extracts_public_card_fields() -> None:
    html = """
    <div class="featured-item">
      <a href="./vente-164952-une-maison-d-habitation-levignacq.html">
        <h3>UNE MAISON D'HABITATION &bull; Lévignacq</h3>
      </a>
      <ul>
        <li class="miseAPrixVignette">Mise à prix : 106 000.00&nbsp;€</li>
        <li class="nextVisite">Prochaine visite&nbsp;: <span>09/06/2026</span></li>
        <li class="dateVenteVignette">Date de la vente&nbsp;: 25/06/26 <span>J - 24</span></li>
      </ul>
    </div>
    """

    sales = parse_vench_list_html(html, fallback_department="40")

    assert len(sales) == 1
    assert sales[0]["source_name"] == "vench"
    assert sales[0]["external_id"] == "164952"
    assert sales[0]["department"] == "40"
    assert sales[0]["city"] == "Lévignacq"
    assert sales[0]["starting_price_eur"] == "106 000.00"
    assert sales[0]["sale_date"] == "25/06/26"
    assert sales[0]["visit_dates"] == ["09/06/2026"]


def test_parse_vench_list_html_uses_last_bullet_as_city() -> None:
    html = """
    <div class="featured-item">
      <a href="./vente-165177-un-appartement-de-4-pieces-orthez.html">
        <h3>UN APPARTEMENT DE 4 PIÈCES &bull; 82,45m² &bull; Orthez</h3>
      </a>
      <p>Mise à prix : 20 000 €</p>
      <p>Date de la vente&nbsp;: 18/06/26</p>
    </div>
    """

    sales = parse_vench_list_html(html, fallback_department="64")

    assert sales[0]["title"] == "UN APPARTEMENT DE 4 PIÈCES"
    assert sales[0]["city"] == "Orthez"


def test_parse_vench_detail_html_keeps_public_details_without_disallowed_uploads() -> None:
    html = """
    <div id="page-heading"><h1>UNE MAISON DE 80 m² &bull; Ondres</h1></div>
    <p>Ventes aux enchères publiques - Tribunal judiciaire de DAX</p>
    <p>Adresse</p><p>40440 <a>Ondres</a></p>
    <p>DATE DE L'AUDIENCE</p><strong>11/06/2026 à 10:00</strong>
    <div class="amentiesDetail"><span>Terrasse</span></div>
    <div class="amentiesDetail"><span>Jardin</span></div>
    <div class="descriptionContener"><p>Pour consulter l'intégralité des informations disponibles sur cette vente, vous devez être abonné.</p></div>
    <img src="/images/vente.jpg" />
    <a href="/upload/document.pdf">Cahier des conditions</a>
    """

    raw = parse_vench_detail_html(
        html,
        "https://www.vench.fr/vente-165184-une-maison-ondres.html",
    )
    sale = normalize_sale(raw)

    assert sale.source_name == "vench"
    assert sale.external_id == "165184"
    assert sale.department == "40"
    assert sale.city == "Ondres"
    assert sale.address == "40440 Ondres"
    assert sale.surface_m2 == 80
    assert sale.has_garden is True
    assert sale.has_terrace is True
    assert sale.documents == []
    assert raw["source_blocks"]["titre"] == "UNE MAISON DE 80 m² - Ondres"
    assert raw["source_blocks"]["adresse"] == "40440 Ondres"
    assert raw["source_blocks"]["caracteristiques"] == "Terrasse, Jardin"
    assert raw["source_images"] == ["https://www.vench.fr/images/vente.jpg"]


def test_parse_vench_detail_html_ignores_lawyer_postal_code_when_address_is_missing() -> None:
    html = """
    <div id="page-heading"><h1>APPARTEMENT 49 m² &bull; Paris</h1></div>
    <p>Ventes aux enchères publiques - Tribunal judiciaire de PARIS</p>
    <p>DATE DE L'AUDIENCE</p><strong>09/07/2026 à 14:00</strong>
    <p>Maître Example</p>
    <p>12 rue Avocat 47000 Agen</p>
    """

    raw = parse_vench_detail_html(
        html,
        "https://www.vench.fr/vente-165306-un-appartement-paris.html",
    )

    assert raw["city"] == "Paris"
    assert raw["postal_code"] is None
    assert raw["department"] is None
    assert raw["address"] == "Paris"


def test_filter_catalog_sales_keeps_vench_listing_with_surface_signal() -> None:
    sale = {
        "source_name": "vench",
        "source_url": "https://www.vench.fr/vente-165177-un-appartement-orthez.html",
        "title": "UN APPARTEMENT DE 4 PIÈCES",
        "raw_text": "UN APPARTEMENT DE 4 PIÈCES • 82,45m² • Orthez",
    }

    assert _filter_catalog_sales([sale]) == [sale]


def test_filter_catalog_sales_drops_vench_listing_without_surface_signal() -> None:
    sale = {
        "source_name": "vench",
        "source_url": "https://www.vench.fr/vente-165999-maison.html",
        "title": "UNE MAISON D'HABITATION",
        "raw_text": "Mise à prix : 100 000 € Date de la vente : 25/06/26",
    }

    assert _filter_catalog_sales([sale]) == []


def test_filter_catalog_sales_backfills_paywalled_vench_from_known_details() -> None:
    sale = {
        "source_name": "vench",
        "source_url": "https://www.vench.fr/vente-165999-maison.html",
        "title": "UNE MAISON D'HABITATION",
        "raw_text": "Pour consulter l'intégralité des informations disponibles, vous devez être abonné.",
    }

    result = _filter_catalog_sales(
        [sale],
        {
            sale["source_url"]: {
                "surface_m2": 91.78,
                "address": "12 rue Test 33000 Bordeaux",
                "description": "Maison de 91,78 m² avec jardin.",
            }
        },
    )

    assert result == [sale]
    assert sale["surface_m2"] == 91.78
    assert sale["address"] == "12 rue Test 33000 Bordeaux"
