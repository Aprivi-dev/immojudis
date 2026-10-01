from decimal import Decimal

from src.normalize import normalize_sale
from src.sources import info_encheres
from src.sources.info_encheres import parse_info_encheres_detail_html, parse_info_encheres_list_html


def test_parse_info_encheres_list_html_filters_public_rows() -> None:
    html = """
    <table>
      <tr>
        <td><a href="108214-d-vente-encheres-immobilieres-appartement-bordeaux-33-ref-5989.html">5989</a></td>
        <td>BORDEAUX</td>
        <td>33</td>
        <td>Appartement de type studio</td>
        <td>40.000€</td>
        <td>25/06/2026</td>
        <td>Cabinet Test</td>
      </tr>
    </table>
    """

    sales = parse_info_encheres_list_html(html)

    assert len(sales) == 1
    assert sales[0]["source_name"] == "info_encheres"
    assert sales[0]["source_url"] == (
        "https://www.info-encheres.com/"
        "108214-d-vente-encheres-immobilieres-appartement-bordeaux-33-ref-5989.html"
    )
    assert sales[0]["city"] == "Bordeaux"
    assert sales[0]["department"] == "33"
    assert sales[0]["starting_price_eur"] == "40.000€"


def test_parse_info_encheres_detail_html_extracts_documents_and_location() -> None:
    html = """
    <html>
      <head><meta name="title" content="Maison à SAINT-JEAN-DE-MARSACQ (40)" /></head>
      <body>
        <div class="avocat"><div class="nom"><b>SELARL LANDAVOCATS</b><div class="tel">05.58.90.02.26</div></div></div>
        <table>
          <tr><td><b>Référence : </b></td><td>5970</td></tr>
          <tr><td><b>Nature du bien : </b></td><td>Maison</td></tr>
          <tr><td><b>Adresse : </b></td><td>36 Impasse Alexandre Viro <br />40230 SAINT-JEAN-DE-MARSACQ</td></tr>
          <tr><td><b>Mise à prix </b></td><td>200 000 €</td></tr>
          <tr><td><b>Vente le : </b></td><td>28/05/2026</td></tr>
          <tr><td><b>Au Tribunal Judiciaire de : </b></td><td>Dax<br />Rue des Fusillés - 40100 Dax</td></tr>
          <tr><td><b>Date de visite : </b></td><td>le mercredi 20 mai 2026 - De 15 heures à 16 heures</td></tr>
        </table>
        <div class="cadre"><div class="titre">Description</div><div class="int2">Maison à usage d'habitation de 120 m², libre de toute occupation.</div></div>
        <img src="/images/maison.jpg" />
        <a href="https://www.info-encheres.com/upload/nptPpvd.pdf">Procès-verbal descriptif</a>
        <script>var lat = 43.6269275; var lon = -1.2587349;</script>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(
        html,
        "https://www.info-encheres.com/108195-d-vente-encheres-immobilieres-maison-saint-jean-de-marsacq-40-ref-5970.html",
    )
    sale = normalize_sale(raw)

    assert raw["external_id"] == "5970"
    assert sale.source_name == "info_encheres"
    assert sale.department == "40"
    assert sale.city == "Saint-Jean-De-Marsacq"
    assert sale.address == "36 Impasse Alexandre Viro 40230 SAINT-JEAN-DE-MARSACQ"
    assert sale.starting_price_eur == 200000
    assert sale.surface_m2 == 120
    assert sale.occupancy_status == "vacant"
    assert sale.lawyer_name == "SELARL LANDAVOCATS"
    assert sale.lawyer_contact == "05.58.90.02.26"
    assert sale.documents[0]["type"] == "pv_descriptif"
    assert raw["tribunal"] == "Tribunal Judiciaire de Dax"
    assert raw["source_blocks"]["detail_adresse"] == "36 Impasse Alexandre Viro 40230 SAINT-JEAN-DE-MARSACQ"
    assert raw["source_blocks"]["description"] == "Maison à usage d'habitation de 120 m², libre de toute occupation."
    assert raw["raw_image_url"] == "https://www.info-encheres.com/images/maison.jpg"
    assert raw["source_images"] == ["https://www.info-encheres.com/images/maison.jpg"]


def test_extract_postal_city_keeps_french_letters_and_rejects_math_symbols() -> None:
    assert info_encheres._extract_postal_city("40230 L'Haÿ-les-Roses") == (
        "40230",
        "L'Haÿ-les-Roses",
    )
    assert info_encheres._extract_postal_city("75000 Paris×Faubourg") == (None, None)
    assert info_encheres._extract_postal_city("75000 Paris÷Faubourg") == (None, None)


def test_parse_info_encheres_detail_filters_site_assets_from_images() -> None:
    html = """
    <html>
      <head>
        <meta property="og:image" content="/upload/ventes/5980/facade.jpg" />
      </head>
      <body>
        <img src="/images/logo.svg" />
        <img src="/upload/ventes/5980/facade.jpg" />
        <img data-src="/upload/ventes/5980/cour.webp?cache=1" />
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(
        html,
        "https://www.info-encheres.com/108220-d-vente-encheres-immobilieres-appartement-bordeaux-33-ref-5980.html",
    )

    assert raw["raw_image_url"] == "https://www.info-encheres.com/upload/ventes/5980/facade.jpg"
    assert raw["source_images"] == [
        "https://www.info-encheres.com/upload/ventes/5980/facade.jpg",
        "https://www.info-encheres.com/upload/ventes/5980/cour.webp?cache=1",
    ]


def test_info_encheres_detail_enrichment_merges_source_images() -> None:
    class Client:
        def get(self, url: str) -> str:
            assert url == "https://www.info-encheres.com/vente.html"
            return """
            <html>
              <body>
                <img src="/upload/ventes/detail-cour.jpg" />
                <img src="/upload/ventes/detail-cour.jpg" />
              </body>
            </html>
            """

    sale = {
        "source_url": "https://www.info-encheres.com/vente.html",
        "raw_image_url": "https://www.info-encheres.com/upload/ventes/card.jpg",
        "source_images": ["https://www.info-encheres.com/upload/ventes/card.jpg"],
    }
    errors: list[str] = []

    info_encheres._enrich_sale_from_detail(Client(), sale, errors)

    assert errors == []
    assert sale["raw_image_url"] == "https://www.info-encheres.com/upload/ventes/card.jpg"
    assert sale["source_images"] == [
        "https://www.info-encheres.com/upload/ventes/card.jpg",
        "https://www.info-encheres.com/upload/ventes/detail-cour.jpg",
    ]


def test_parse_info_encheres_detail_keeps_document_links_without_pdf_extension() -> None:
    html = """
    <html>
      <body>
        <table>
          <tr><td><b>Référence : </b></td><td>5980</td></tr>
          <tr><td><b>Nature du bien : </b></td><td>Appartement</td></tr>
          <tr><td><b>Adresse : </b></td><td>33000 BORDEAUX</td></tr>
          <tr><td><b>Mise à prix </b></td><td>75 000 €</td></tr>
        </table>
        <div class="cadre">
          <div class="titre">Description</div>
          <div class="int2">La superficie figure uniquement dans les documents joints.</div>
        </div>
        <a href="/download.php?id=5980&type=pvd">Procès-verbal descriptif</a>
        <a href="/telechargement?id=5980&piece=cahier">Cahier des conditions de vente</a>
        <a href="/contact.html">Contacter l'avocat</a>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(
        html,
        "https://www.info-encheres.com/108220-d-vente-encheres-immobilieres-appartement-bordeaux-33-ref-5980.html",
    )

    assert raw["surface_m2"] is None
    assert raw["documents"] == [
        {
            "label": "Procès-verbal descriptif",
            "url": "https://www.info-encheres.com/download.php?id=5980&type=pvd",
            "type": "pv_descriptif",
        },
        {
            "label": "Cahier des conditions de vente",
            "url": "https://www.info-encheres.com/telechargement?id=5980&piece=cahier",
            "type": "cahier_conditions",
        },
    ]
    assert raw["source_blocks"]["documents"] == "Procès-verbal descriptif; Cahier des conditions de vente"


def test_parse_info_encheres_detail_html_keeps_thousands_surface() -> None:
    html = """
    <html>
      <body>
        <table>
          <tr><td><b>Référence : </b></td><td>6000</td></tr>
          <tr><td><b>Nature du bien : </b></td><td>Propriété</td></tr>
          <tr><td><b>Adresse : </b></td><td>33160 SAINT-MEDARD-EN-JALLES</td></tr>
          <tr><td><b>Mise à prix </b></td><td>300 000 €</td></tr>
        </table>
        <div class="cadre">
          <div class="titre">Description</div>
          <div class="int2">Propriété d'une superficie totale de 2 464,70 m², libre.</div>
        </div>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(
        html,
        "https://www.info-encheres.com/108300-d-vente-encheres-immobilieres-propriete-saint-medard-en-jalles-33-ref-6000.html",
    )
    sale = normalize_sale(raw)

    assert raw["surface_m2"] == "2464.70"
    assert sale.surface_m2 == Decimal("2464.70")


def test_parse_info_encheres_detail_keeps_sole_cadastral_surface() -> None:
    html = """
    <html>
      <body>
        <table>
          <tr><td><b>Nature du bien : </b></td><td>Terrain</td></tr>
          <tr><td><b>Adresse : </b></td><td>33000 TESTVILLE</td></tr>
        </table>
        <div class="cadre"><div class="titre">Description</div><div class="int2">
          Terrain cadastré section AB n°1 pour une contenance de 2 464,70 m².
        </div></div>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(html, info_encheres.BASE_URL)
    sale = normalize_sale(raw)

    assert raw["surface_m2"] == "2464.70"
    assert sale.surface_m2 == Decimal("2464.70")


def test_parse_info_encheres_detail_html_does_not_treat_no_lease_as_rented() -> None:
    html = """
    <html>
      <body>
        <table>
          <tr><td><b>Référence : </b></td><td>6001</td></tr>
          <tr><td><b>Nature du bien : </b></td><td>Maison</td></tr>
          <tr><td><b>Adresse : </b></td><td>33000 BORDEAUX</td></tr>
          <tr><td><b>Mise à prix </b></td><td>100 000 €</td></tr>
        </table>
        <div class="cadre">
          <div class="titre">Description</div>
          <div class="int2">Maison occupée sans bail écrit, travaux à prévoir.</div>
        </div>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(
        html,
        "https://www.info-encheres.com/108301-d-vente-encheres-immobilieres-maison-bordeaux-33-ref-6001.html",
    )
    sale = normalize_sale(raw)

    assert raw["occupancy_status"] == "occupied"
    assert sale.occupancy_status == "occupied"


def test_info_encheres_detail_scopes_surface_land_and_parking_to_description() -> None:
    html = """
    <html>
      <body>
        <table>
          <tr><td>Référence :</td><td>fixture-1</td></tr>
          <tr><td>Nature du bien :</td><td>Appartement avec cave</td></tr>
          <tr><td>Adresse :</td><td>33000 TESTVILLE</td></tr>
          <tr><td>Superficie :</td><td>48,50 m²</td></tr>
        </table>
        <div class="cadre"><div class="titre">Description</div><div class="int2">
          Dans un ensemble immobilier cadastré section AB n°1 pour une contenance de 12a 34ca.
          Un appartement d'une superficie de 48,50 m² avec un emplacement de parking.
          BIENS OCCUPES.
        </div></div>
        <nav>Appartement Studio Terrain Parking</nav>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(html, info_encheres.BASE_URL)
    sale = normalize_sale(raw)

    assert raw["surface_m2"] == "48.50"
    assert raw["habitable_surface_m2"] == "48.50"
    assert raw["land_surface_m2"] == "1234"
    assert raw["parking_count"] == 1
    assert "page_text" not in raw["source_blocks"]
    assert sale.habitable_surface_m2 == Decimal("48.50")
    assert sale.land_surface_m2 == Decimal("1234")
    assert sale.parking_count == 1
    assert sale.occupancy_status == "occupied"


def test_info_encheres_detail_keeps_compound_lot_facts_unknown() -> None:
    html = """
    <html>
      <body>
        <table>
          <tr><td>Référence :</td><td>fixture-2</td></tr>
          <tr><td>Nature du bien :</td><td>Immeuble comprenant 2 appartements et des bureaux</td></tr>
          <tr><td>Adresse :</td><td>33000 TESTVILLE</td></tr>
        </table>
        <div class="cadre"><div class="titre">Description</div><div class="int2">
          Une propriété composée d'un appartement de 23 m² BIEN OCCUPE,
          d'un appartement de 31 m² BIEN INOCCUPE et de bureaux d'une surface
          habitable de 90 m². Cadastré section AB n°2 pour 2a 00ca.
        </div></div>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(html, info_encheres.BASE_URL)
    sale = normalize_sale(raw)

    assert raw["property_type"] == "mixed"
    assert raw["habitable_surface_m2"] is None
    assert raw["land_surface_m2"] == "200"
    assert raw["occupancy_status"] == "unknown"
    assert sale.property_type == "mixed"
    assert sale.habitable_surface_m2 is None
    assert sale.rooms_count is None
    assert sale.occupancy_status == "unknown"
    assert info_encheres._extract_parking_count("LOT NUMERO SEPT (7) : Un garage en sous-sol") == 1
    assert info_encheres._extract_occupancy_status("Le bien est occupée par la propriétaire.") == "owner_occupied"


def test_info_encheres_does_not_mark_a_single_office_building_as_mixed() -> None:
    assert info_encheres._is_mixed_asset("Immeuble de bureaux") is False
    assert info_encheres._detail_property_type("Immeuble de bureaux") == "Immeuble de bureaux"


def test_info_encheres_parses_explicit_parking_emplacement_counts() -> None:
    assert info_encheres._extract_parking_count("Deux emplacements de parking") == 2
    assert info_encheres._extract_parking_count("2 emplacements de parking") == 2
    assert info_encheres._extract_parking_count("Deux emplacements de stationnement") == 2


def test_info_encheres_detail_recovers_piece_unique_and_plural_free_occupancy() -> None:
    html = """
    <html>
      <body>
        <table>
          <tr><td>Référence :</td><td>fixture-3</td></tr>
          <tr><td>Nature du bien :</td><td>Une pièce unique</td></tr>
          <tr><td>Adresse :</td><td>33000 TESTVILLE</td></tr>
        </table>
        <div class="cadre"><div class="titre">Description</div><div class="int2">
          UNE PIECE UNIQUE d'une superficie de 21,25 m². LIBRES DE TOUT OCCUPATION.
        </div></div>
      </body>
    </html>
    """

    raw = parse_info_encheres_detail_html(html, info_encheres.BASE_URL)
    sale = normalize_sale(raw)

    assert raw["property_type"] == "apartment"
    assert raw["rooms_count"] == 1
    assert raw["habitable_surface_m2"] == "21.25"
    assert raw["occupancy_status"] == "vacant"
    assert sale.rooms_count == 1
    assert sale.occupancy_status == "vacant"


def test_info_encheres_mixed_sale_does_not_infer_one_studios_rooms_or_area() -> None:
    raw = {
        "source_name": "info_encheres",
        "source_url": "https://www.info-encheres.com/vente-encheres-immobilieres-fixture.html",
        "property_type": "mixed",
        "title": "Ensemble immobilier mixte",
        "description": "Un studio de 28 m² et un local commercial de 90 m². Surface habitable de 28 m² pour le studio.",
        "source_blocks": {"description": "Un studio de 28 m² et un local commercial de 90 m²."},
    }

    sale = normalize_sale(raw)

    assert sale.property_type == "mixed"
    assert sale.rooms_count is None
    assert sale.habitable_surface_m2 is None
