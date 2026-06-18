from src.sources.avoventes import parse_avoventes_html
from src.sources.avoventes import parse_avoventes_detail_html


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

    sales = parse_avoventes_html(html, page_url="https://avoventes.fr/recherche?departement=33", fallback_department="33")

    assert len(sales) == 1
    assert sales[0]["source_url"] == "https://avoventes.fr/enchere/maison-bordeaux-123"
    assert sales[0]["postal_code"] == "33000"
    assert sales[0]["city"] == "Bordeaux"
    assert sales[0]["starting_price_eur"] == "120 000 €"
    assert sales[0]["lawyer_name"] == "Me Test"
    assert sales[0]["documents"][0]["url"] == "https://avoventes.fr/docs/vente.pdf"
    assert sales[0]["documents"][0]["type"] == "pdf"


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
