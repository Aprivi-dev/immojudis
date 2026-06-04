from src.normalize import normalize_sale
from src.sources.vench import parse_vench_detail_html, parse_vench_list_html


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
