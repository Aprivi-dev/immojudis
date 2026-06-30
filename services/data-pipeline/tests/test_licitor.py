from decimal import Decimal

from src.normalize import normalize_sale
from src.sources import licitor
from src.sources.licitor import RobotsRules, parse_licitor_detail_html, parse_licitor_list_html


def test_robots_rules_allows_public_licitor_pages_and_blocks_disallowed_documents() -> None:
    rules = RobotsRules.parse(
        """
        User-agent: *
        Disallow: /data/pub/doc/
        Disallow: /services.html

        User-agent: ClaudeBot
        Disallow: /
        """,
        "immojudis-data-pipeline/1.0 (+contact@example.com)",
    )

    assert rules.can_fetch(
        "https://www.licitor.com/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/prochaines-ventes.html"
    )
    assert rules.can_fetch("https://www.licitor.com/annonce/10/84/61/x/108461.html")
    assert not rules.can_fetch("https://www.licitor.com/data/pub/doc/example.pdf")


def test_parse_licitor_list_html_extracts_detail_and_next_urls() -> None:
    html = """
    <a href="/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/prochaines-ventes.html?p=2">2</a>
    <a href="/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html">
      33 Mérignac Une maison Mise à prix : 200 000 €
    </a>
    """
    details, next_urls = parse_licitor_list_html(html)

    assert details == [
        "https://www.licitor.com/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html"
    ]
    assert next_urls == [
        "https://www.licitor.com/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/prochaines-ventes.html?p=2"
    ]


def test_licitor_uses_aquitaine_listing_page_for_aquitaine_targets(monkeypatch) -> None:
    monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("24", "33", "40", "47", "64"))

    assert licitor._start_urls_for_target_departments() == (licitor.AQUITAINE_URL,)


def test_licitor_uses_all_listing_pages_for_national_targets(monkeypatch) -> None:
    monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("33", "75"))

    assert licitor._start_urls_for_target_departments() == licitor.LICITOR_ZONE_URLS


def test_parse_licitor_detail_html_extracts_national_postal_code() -> None:
    html = """
    <h1>Annonce n°109000 : un appartement à Paris (Paris), mise à prix : 100 000 €</h1>
    <p>Tribunal Judiciaire de Paris</p>
    <h2>Un appartement</h2>
    <h3>Mise à prix : 100 000 €</h3>
    <p>Paris</p>
    <p>12 rue Test - 75001 Paris</p>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/90/00/vente-aux-encheres/un-appartement/paris/paris/109000.html",
    )

    assert raw["department"] == "75"
    assert raw["postal_code"] == "75001"


def test_parse_licitor_detail_html_accepts_missing_postal_code() -> None:
    html = """
    <h1>Annonce n°108625 : une maison d'habitation à Mérignac (Gironde), mise à prix : 200 000 €</h1>
    <p>Annonce publiée le</p>
    <p>6 mai 2026</p>
    <p>108625</p>
    <p>Tribunal Judiciaire de Bordeaux (Gironde)</p>
    <p>Vente aux enchères publiques</p>
    <p>jeudi 11 juin 2026 à 15h</p>
    <h2>Une maison d'habitation</h2>
    <h3>Mise à prix : 200 000 €</h3>
    <p>Mérignac</p>
    <p>2, av. des Azalés</p>
    <p><a href="https://maps.google.fr/maps?q=44.8401,-0.6512&z=13">Afficher le plan</a></p>
    <p>Visite sur place mardi 26 mai 2026 de 10h à 12h</p>
    <h3>Maître Juliette André, de ABR et associés, Avocat</h3>
    <p>4, quai Hubert Prom - 33300 Bordeaux</p>
    <p>Tél.: 05 35 54 98 12</p>
    <p>Surface habitable : 90 m² environ</p>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html",
    )
    sale = normalize_sale(raw)

    assert raw["external_id"] == "108625"
    assert raw["surface_m2"] == "90"
    assert sale.source_name == "licitor"
    assert sale.department == "33"
    assert sale.city == "Mérignac"
    assert sale.address == "2, av. des Azalés, 33300 Mérignac"
    assert sale.latitude == Decimal("44.8401")
    assert sale.longitude == Decimal("-0.6512")
    assert sale.starting_price_eur == 200000
    assert sale.property_type == "house"
    assert sale.visit_dates == ["Visite sur place mardi 26 mai 2026 de 10h à 12h"]


def test_parse_licitor_detail_html_keeps_linked_pdf_documents() -> None:
    html = """
    <h1>Annonce n°108762 : divers biens à Montardon (Pyrénées-Atlantiques), mise à prix : 500 000 €</h1>
    <p>Tribunal Judiciaire de Pau</p>
    <a href="https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.001.pdf">PV descriptif</a>
    <a href="/data/pub/media/annonce/10/87/62/108762.000.002.pdf">Cahier des conditions de vente</a>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/87/62/vente-aux-encheres/divers-biens/montardon/pyrenees-atlantiques/108762.html",
    )

    assert raw["documents"] == [
        {
            "label": "PV descriptif",
            "url": "https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.001.pdf",
            "type": "pdf",
        },
        {
            "label": "Cahier des conditions de vente",
            "url": "https://www.licitor.com/data/pub/media/annonce/10/87/62/108762.000.002.pdf",
            "type": "pdf",
        },
    ]


def test_parse_licitor_detail_html_extracts_ad_images_without_site_assets() -> None:
    html = """
    <h1>Annonce n°108762 : divers biens à Montardon (Pyrénées-Atlantiques), mise à prix : 500 000 €</h1>
    <article class="LegalAd">
      <img src="static/img/licitor.png">
      <img src="/data/pub/media/annonce/10/87/62/maison.jpg">
    </article>
    """

    raw = parse_licitor_detail_html(
        html,
        "https://www.licitor.com/annonce/10/87/62/vente-aux-encheres/divers-biens/montardon/pyrenees-atlantiques/108762.html",
    )

    assert raw["raw_image_url"] == "https://www.licitor.com/data/pub/media/annonce/10/87/62/maison.jpg"
    assert raw["source_images"] == ["https://www.licitor.com/data/pub/media/annonce/10/87/62/maison.jpg"]
