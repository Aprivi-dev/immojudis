from decimal import Decimal

import pytest

from src.catalogue_proof import public_page_proof
from src.normalize import normalize_sale
from src.sources.avoventes import (
    compact_avoventes_catalogue_html,
    parse_avoventes_detail_html,
    parse_avoventes_html,
)
from src.sources.common import MAX_SOURCE_HTML_CHARS, SourceParseLimitExceeded, parse_html


def test_large_avoventes_city_filters_do_not_hide_catalogue_cards() -> None:
    cities = '<option value="1">Ville témoin</option>' * 65_000
    html = (
        '<select id="alerte_ville" name="villes[]">' + cities + '</select>'
        '<select name="villes[]" id="modal_search_ville">' + cities + '</select>'
        '<article data-link="/enchere/maison-bordeaux-123"><h2>Vente aux enchères Maison</h2>'
        '<a href="/enchere/maison-bordeaux-123">Voir la vente</a>'
        '<p>12 rue Test 33000 Bordeaux</p><p>Mise à prix : 120 000 €</p>'
        '<p>Date de la vente : jeudi 10 janvier 2027 à 09h00</p></article>'
    )
    assert len(html) > MAX_SOURCE_HTML_CHARS
    with pytest.raises(SourceParseLimitExceeded):
        parse_html(html)

    compacted = compact_avoventes_catalogue_html(html)
    assert len(compacted) < MAX_SOURCE_HTML_CHARS
    assert compacted.count('Ville témoin') == 0
    assert len(parse_avoventes_html(html, fallback_department='33')) == 1
    proof = public_page_proof('avoventes', compacted, 'https://avoventes.fr/recherche')
    assert 'https://avoventes.fr/enchere/maison-bordeaux-123' in proof['public_urls']


def test_parse_avoventes_html_extracts_public_sale_fields() -> None:
    html = """
    <article>
      <h2>Vente aux enchères Maison</h2>
      <a href="/enchere/maison-bordeaux-123">Voir la vente</a>
      <p>12 rue Test 33000 Bordeaux</p>
      <p>Mise à prix : 120 000 €</p>
      <p>Date de la vente : jeudi 10 janvier 2027 à 09h00</p>
      <p>Date des visites : 5 janvier 2027 à 10h00</p>
      <p>Cabinet : Me Test</p>
      <a href="/docs/vente.pdf">Cahier des conditions</a>
    </article>
    """

    sales = parse_avoventes_html(
        html, page_url="https://avoventes.fr/recherche?departement=33", fallback_department="33"
    )

    assert len(sales) == 1
    assert sales[0]["source_url"] == "https://avoventes.fr/enchere/maison-bordeaux-123"
    assert sales[0]["postal_code"] == "33000"
    assert sales[0]["city"] == "Bordeaux"
    assert sales[0]["starting_price_eur"] == "120 000 €"
    assert sales[0]["lawyer_name"] == "Me Test"
    assert sales[0]["source_blocks"]["mise_a_prix"] == "120 000 €"
    assert sales[0]["source_blocks"]["date_vente"] == "jeudi 10 janvier 2027 à 09h00"
    assert sales[0]["source_blocks"]["cabinet"] == "Me Test"
    assert sales[0]["documents"][0]["url"] == "https://avoventes.fr/docs/vente.pdf"
    assert sales[0]["documents"][0]["type"] == "pdf"


def test_parse_avoventes_html_rejects_cross_origin_sale_and_document_urls() -> None:
    html = """
    <article data-link="https://evil.example/enchere/replace-existing-sale">
      <h2>Maison à Bordeaux</h2>
      <p>Mise à prix : 100 000 €</p>
      <p>Date de la vente : 10 septembre 2026</p>
      <a href="https://evil.example/cahier.pdf">Cahier des conditions de vente</a>
    </article>
    """

    assert parse_avoventes_html(html) == []


def test_parse_avoventes_html_does_not_turn_generic_search_text_into_a_sale() -> None:
    html = """
    <html>
      <body>
        <form action="/recherche">
          <label>Prix minimum</label>
          <span>Mise à prix</span>
          <select><option>Gironde</option></select>
        </form>
        <p>Aucun résultat pour ces critères.</p>
      </body>
    </html>
    """

    assert parse_avoventes_html(
        html,
        page_url="https://avoventes.fr/recherche?display=liste&order=asc&sort=date",
        fallback_department="33",
    ) == []


def test_parse_avoventes_html_rejects_card_without_a_property_detail_url() -> None:
    html = """
    <article>
      <h2>Vente aux enchères Maison</h2>
      <a href="/recherche">Retour aux résultats</a>
      <p>33 000 Bordeaux</p>
      <p>Mise à prix : 120 000 €</p>
      <p>Date de la vente : jeudi 10 janvier 2027 à 09h00</p>
    </article>
    """

    assert parse_avoventes_html(html, page_url="https://avoventes.fr/recherche") == []


def test_parse_avoventes_html_extracts_adjudication_without_polluting_title() -> None:
    html = """
    <article>
      <h2>Vente aux enchères Autres</h2>
      <h3>UN BATIMENT D'EXPLOITATION AGRICOLE A HAUT-VALROMEY</h3>
      <a href="/enchere/batiment-agricole">Voir la vente</a>
      <p>01260 Haut-Valromey, France</p>
      <p>Mise à prix initiale : 35 000,00 €</p>
      <p>Adjugé :</p><p>36 000,00 €</p>
      <p>Surenchère possible jusqu'au 10 juillet 2026</p>
      <p>Date de la vente : mardi 30 juin 2026 à 14h00</p>
    </article>
    """

    raw = parse_avoventes_html(html, page_url="https://avoventes.fr/recherche", fallback_department="01")[0]
    sale = normalize_sale(raw)

    assert raw["title"] == "UN BATIMENT D'EXPLOITATION AGRICOLE A HAUT-VALROMEY"
    assert raw["adjudication_price_eur"] == "36 000,00 €"
    assert raw["source_blocks"]["prix_adjudication"] == "36 000,00 €"
    assert sale.starting_price_eur == Decimal("35000.00")
    assert sale.adjudication_price_eur == Decimal("36000.00")
    assert sale.status == "adjudicated"


def test_parse_avoventes_detail_html_extracts_pdf_documents() -> None:
    html = """
    <html>
      <body>
        <a href="/public/uploads/documents/affiche.pdf">Affiche greffe</a>
        <a href="/conditions-generales-dutilisation">CGU</a>
      </body>
    </html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/test")

    assert details["documents"] == [
        {
            "label": "Affiche greffe",
            "url": "https://avoventes.fr/public/uploads/documents/affiche.pdf",
            "type": "pdf",
        }
    ]
    assert details["source_blocks"]["documents"] == "Affiche greffe"


def test_parse_avoventes_detail_extracts_explicit_scoped_fields() -> None:
    html = """
    <html><body>
      <h1>Appartement à TESTVILLE</h1>
      <div class="summary"><span>2</span><span>pièces</span><span>42</span><span>m² superficie</span></div>
      <div><h2>À propos du bien</h2>
        <div>TESTVILLE (33000), 4 rue du Test. Terrain : 207 m².
          Le bien est vide de toute occupation.</div>
      </div>
      <li>Parking (Cinq emplacements de parking privatifs disponibles)</li>
      <div>Diagnostic énergétique</div>
      <div>DPE</div><div>E</div><div>GES</div><div>B</div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-fields")
    sale = normalize_sale({**details, "source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/synthetic-fields"})

    assert details["land_surface_m2"] == "207"
    assert details["occupancy_status"] == "vacant"
    assert details["parking_count"] == 5
    assert details["source_energy_diagnostics"] == {
        "source": "avoventes.detail",
        "dpe_class": "E",
        "ges_class": "B",
        "diagnostic_date": None,
    }
    assert sale.land_surface_m2 == Decimal("207")
    assert sale.occupancy_status == "vacant"
    assert sale.parking_count == 5
    assert sale.raw_payload["source_energy_diagnostics"]["dpe_class"] == "E"
    # The page's generic ``m² superficie`` counter is not evidence of a
    # habitable area.
    assert sale.habitable_surface_m2 is None


def test_parse_avoventes_detail_keeps_unquantified_parking_unknown() -> None:
    html = """
    <html><body>
      <h1>Appartement à TESTVILLE</h1>
      <div><h2>À propos du bien</h2>
        <div>TESTVILLE (33000), 4 rue du Test. Le bien dispose d'un parking couvert et d'un parking extérieur.</div>
      </div>
      <li>Parking (Parking couvert payant complété par un parking extérieur)</li>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-parking")
    sale = normalize_sale({**details, "source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/synthetic-parking"})

    assert details["parking_count"] is None
    assert sale.parking_count is None


def test_parse_avoventes_detail_treats_negated_occupancy_as_vacant() -> None:
    html = """
    <html><body>
      <h1>Appartement à TESTVILLE</h1>
      <div><h2>À propos du bien</h2>
        <div>TESTVILLE (33000), 4 rue du Test. Le bien n'est pas occupé.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-negated-occupancy")

    assert details["occupancy_status"] == "vacant"
    assert details["quality_flags"] == []


def test_parse_avoventes_detail_quarantines_conflicting_lot_occupancy() -> None:
    html = """
    <html><body>
      <h1>Ensemble immobilier à TESTVILLE</h1>
      <div><h2>À propos du bien</h2>
        <div>TESTVILLE (33000), vente en 2 lots. Le studio n'est pas occupé.
          Le local est occupé et fait l'objet d'un bail commercial.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-occupancy")
    sale = normalize_sale({**details, "source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/synthetic-occupancy"})

    assert details["occupancy_status"] is None
    assert "ambiguous_occupancy" in details["quality_flags"]
    assert sale.occupancy_status is None


def test_catalogue_returned_for_removed_detail_is_not_parsed_as_property():
    import pytest

    from src.sources.avoventes import _enrich_sale_from_detail

    html = '<html><title>AVOVENTES - Ventes aux enchères publiques immobilières</title><select>'
    html += ''.join(f'<option>Ville {i}</option>' for i in range(101))
    html += '</select><h2>Appartement à vendre à Riorges 42120</h2></html>'
    with pytest.raises(ValueError, match='identity unverified'):
        parse_avoventes_detail_html(html, 'https://avoventes.fr/enchere/le-cannet')
    class Client:
        def get(self, url):
            return html
    sale = {'source_url':'https://avoventes.fr/enchere/le-cannet','postal_code':'06110'}
    errors = []
    _enrich_sale_from_detail(Client(), sale, errors)
    assert sale['_detail_fetch_failed']
    assert sale['postal_code'] == '06110'
    assert len(errors) == 1


def test_parse_avoventes_detail_html_extracts_lot_superficie() -> None:
    html = """
    <html>
      <body>
        <h1>Appartement Lot 5, 2 pièces</h1>
        <section>
          <h2>À propos du bien</h2>
          <p>Cadastré section AC n°164 pour 07a 02ca</p>
          <p>Superficie Lots 5 et 8 : 48,80 m² - DPE : non réalisable</p>
        </section>
      </body>
    </html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/test")

    assert details["title"] == "Appartement Lot 5, 2 pièces"
    assert details["surface_m2"] == "48,80"
    assert details["source_blocks"]["titre_detail"] == "Appartement Lot 5, 2 pièces"
    assert details["source_blocks"]["surface"] == "48,80"
    assert "Superficie Lots 5 et 8" in details["source_blocks"]["page_text"]


def test_parse_avoventes_detail_html_extracts_source_images() -> None:
    html = """
    <html>
      <head>
        <meta property="og:image" content="/public/uploads/cabinet/114/images/cropped_photo.jpg">
        <meta name="twitter:image" content="/public/uploads/cabinet/114/images/cropped_photo.jpg">
      </head>
      <body>
        <ul id="lightSliderDetails">
          <li data-src="/public/uploads/cabinet/114/images/resized_photo.jpg"></li>
        </ul>
        <img src="/images/logo.svg">
      </body>
    </html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/test")

    assert details["raw_image_url"] == "https://avoventes.fr/public/uploads/cabinet/114/images/cropped_photo.jpg"
    assert details["source_images"] == [
        "https://avoventes.fr/public/uploads/cabinet/114/images/cropped_photo.jpg",
        "https://avoventes.fr/public/uploads/cabinet/114/images/resized_photo.jpg",
    ]


def test_detail_postponement_is_not_replaced_by_nearby_sale_date():
    from src.sources.avoventes import parse_avoventes_detail_html
    detail = parse_avoventes_detail_html('''<h1>Maison à Marsannay-la-Côte</h1>
        <div>Adjudication : VENTE REPORTÉE</div><div>Vente reportée</div>
        <h2>À propos du bien</h2><p>Maison 127,31 m²</p>
        <h2>Autres biens à proximité</h2><div>Appartement, vente le 16 septembre 2026</div>''',
        'https://avoventes.fr/enchere/une-maison-dhabitation-a-marsannay-la-cote')
    assert detail['status'] == 'postponed'
    assert detail.get('sale_date') is None


def test_detail_extracts_structured_location_schedule_and_carrez_from_reduced_fixture():
    html = """
    <html><body>
      <h1>Appartement + cave à LE PONT DE BEAUVOISIN</h1>
      <p><strong>Vente</strong><br>12 octobre 2026 à 14h00</p>
      <p><span><strong>VISITES :</strong></span><br>
        Sur place le 05 octobre 2026 de 10 h à 11 h</p>
      <div><h2>À propos du bien</h2>
        <div>Sur la commune de LE PONT DE BEAUVOISIN (33000), 12 rue des Lilas,
        un appartement de type 3. Superficie (Loi Carrez) : 64,20 m².</div>
      </div>
      <h2>Autres biens à proximité</h2>
      <div class="card annonce" data-link="https://avoventes.fr/enchere/nearby">
        <span>Date de la vente : 20 octobre 2026</span>
        <span>Visite le 19 octobre 2026</span>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic")

    assert details["city"] == "LE PONT DE BEAUVOISIN"
    assert details["postal_code"] == "33000"
    assert details["address"] == "12 rue des Lilas"
    assert details["property_type"] == "apartment"
    assert details["sale_date"] == "12 octobre 2026 à 14h00"
    assert details["visit_dates"] == ["Sur place le 05 octobre 2026 de 10 h à 11 h"]
    assert details["rooms_count"] is None
    assert details["carrez_surface_m2"] == "64,20"
    assert "20 octobre 2026" not in details["source_blocks"]["page_text"]


def test_detail_keeps_ambiguous_address_and_multi_lot_rooms_unknown():
    html = """
    <html><body>
      <h1>Appartement et local commercial à VILLE-TEST (33000)</h1>
      <p><strong>Vente</strong><br>12 octobre 2026 à 14h00</p>
      <p><span><strong>VISITES :</strong></span><br>Sur rendez-vous</p>
      <div><h2>À propos du bien</h2>
        <div>VILLE-TEST (33000), 12 rue des Lilas et 18 avenue du Test,
        vente en 2 lots. Lot 1 : appartement de type 3. Lot 2 : local commercial.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-multi-lot")

    assert details["city"] == "VILLE-TEST"
    assert details["postal_code"] == "33000"
    assert details["address"] is None
    assert details["property_type"] == "mixed"
    assert details["rooms_count"] is None


def test_detail_does_not_infer_rooms_from_a_commercial_summary():
    html = """
    <html><body>
      <h1>LOCAL COMMERCIAL à VILLE-TEST</h1>
      <p><strong>Vente</strong><br>12 octobre 2026 à 14h00</p>
      <div class="summary"><span>1</span><span>pièces</span></div>
      <div><h2>À propos du bien</h2>
        <div>VILLE-TEST (33000), 4 rue du Commerce. Un local commercial.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-commercial")

    assert details["property_type"] == "commercial"
    assert details["rooms_count"] is None


def test_detail_handles_same_line_sale_date_mixed_case_city_and_ensemble_title():
    html = """
    <html><body>
      <h1>Ensemble immobilier à Megève</h1>
      <p>Vente 16 octobre 2026 à 14h00</p>
      <div><h2>À propos du bien</h2>
        <div>97 RUE DE GENEVE (74240), ensemble immobilier à usage d'habitation.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-mixed-case")

    assert details["title"] == "Ensemble immobilier à Megève"
    assert details["property_type"] == "mixed"
    assert details["sale_date"] == "16 octobre 2026 à 14h00"
    assert details["city"] == "Megève"
    assert details["postal_code"] == "74240"
    assert details["address"] == "97 RUE DE GENEVE"


def test_detail_lot_one_and_two_block_room_inference_without_lot_summary():
    html = """
    <html><body>
      <h1>Appartement à VILLE-TEST</h1>
      <div class="summary">3 pièces</div>
      <div><h2>À propos du bien</h2>
        <div>VILLE-TEST (33000), LOT 1 : appartement de 3 pièces. LOT 2 : cave.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-lot-pair")

    assert details["property_type"] == "apartment"
    assert details["rooms_count"] is None


def test_detail_does_not_classify_house_t4_as_mixed():
    html = """
    <html><body>
      <h1>Maison T4 à VILLE-TEST</h1>
      <div><h2>À propos du bien</h2>
        <div>VILLE-TEST (33000), 8 rue du Test.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-house-t4")

    assert details["property_type"] == "house"


def test_detail_does_not_turn_mixed_case_street_name_into_city():
    html = """
    <html><body>
      <h1>Appartement</h1>
      <div><h2>À propos du bien</h2>
        <div>97 rue de Genève (74240), appartement à usage d'habitation.</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-street-city")

    assert details["city"] is None
    assert details["postal_code"] == "74240"
    assert details["address"] == "97 rue de Genève"


def test_detail_keeps_city_after_a_previous_sentence_with_a_street_address():
    html = """
    <html><body>
      <h1>Appartement</h1>
      <div><h2>À propos du bien</h2>
        <div>Adresse : 12 rue de Genève. Bien situé à Gex (01170).</div>
      </div>
    </body></html>
    """

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic-street-and-city")

    assert details["city"] == "Gex"
    assert details["postal_code"] == "01170"
    assert details["address"] == "12 rue de Genève"


def test_normalize_sale_keeps_ambiguous_avoventes_rooms_null_but_keeps_single_dwelling_count():
    multi_lot = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/synthetic-multi-lot-normalized",
            "title": "3 APPARTEMENTS à VILLE-TEST (VENTE EN 3 LOTS)",
            "property_type": "apartment",
            "description": "Lot 1 : studio. Lot 2 : appartement de 3 pièces. Lot 3 : studio.",
            "raw_text": "3 APPARTEMENTS à VILLE-TEST (VENTE EN 3 LOTS)",
        }
    )
    commercial = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/synthetic-commercial-normalized",
            "title": "LOCAL COMMERCIAL à VILLE-TEST",
            "property_type": "commercial",
            "raw_text": "LOCAL COMMERCIAL à VILLE-TEST. Une pièce principale.",
        }
    )
    mixed = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/synthetic-mixed-normalized",
            "title": "Ensemble immobilier à VILLE-TEST",
            "property_type": "mixed",
            "raw_text": "Ensemble immobilier composé d'un appartement de 3 pièces et d'un local.",
        }
    )
    lot_pair = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/synthetic-lot-pair-normalized",
            "title": "Appartement à VILLE-TEST",
            "property_type": "apartment",
            "raw_text": "LOT 1 : appartement de 3 pièces. LOT 2 : cave.",
        }
    )
    single_dwelling = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/synthetic-single-normalized",
            "title": "Appartement T3 à VILLE-TEST",
            "property_type": "apartment",
            "raw_text": "Appartement T3 de 60 m², 3 pièces et 2 chambres.",
        }
    )

    assert multi_lot.rooms_count is None
    assert commercial.rooms_count is None
    assert mixed.rooms_count is None
    assert lot_pair.rooms_count is None
    assert single_dwelling.rooms_count == 3
