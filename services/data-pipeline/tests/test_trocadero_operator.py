from src.raw_models import validate_raw_sales
from src.sources.agrasc import parse_agrasc_html
from src.sources.agrasc_operators import enrich_agrasc_operator, parse_trocadero_operator_detail

URL = "https://lesnotairesdutrocadero.fr/appel_d_offre/domaine-dexception-antibes/"


def page() -> str:
    return """
    <main>
      <h1>Domaine d’exception – Antibes</h1>
      <h2>Description du bien</h2>
      <p>L’ETAT représenté par l’AGRASC est propriétaire de biens situés à Antibes (06160),
         41 avenue des Pins du Cap, 62 boulevard Gardiole Bacon et 43 avenue des Pins du Cap.</p>
      <h2>Purpose of the consultation</h2>
      <p>The French State owns the property and the organisation has two phases.</p>
      <h2>Calendrier</h2>
      <p>Envoi des dossiers jusqu’au 26 octobre 2026 à 12 heures.</p>
      <h2>Preliminary timeline for the consultation</h2>
      <p>Visiting period from October 5 to October 30, 2026.</p>
      <h2>Contacts</h2>
      <p>Pour toute question : capdantibes@trocadero.notaires.fr</p>
      <h2>Contacts</h2>
      <p>For any questions regarding the tender process, contact the office.</p>
      <a href="/documents/reglement-consultation.pdf">REGLEMENT DE CONSULTATION</a>
    </main>
    """


def test_trocadero_offer_extracts_location_contact_and_document_without_price_guess():
    detail = parse_trocadero_operator_detail(page(), URL)

    assert detail["title"] == "Domaine d’exception – Antibes"
    assert detail["city"] == "Antibes"
    assert detail["postal_code"] == "06160"
    assert detail["department"] == "06"
    assert detail["address"] == "41 avenue des Pins du Cap, 62 boulevard Gardiole Bacon et 43 avenue des Pins du Cap"
    assert detail["source_blocks"]["operator_contacts"] == ["capdantibes@trocadero.notaires.fr"]
    assert detail["source_blocks"]["operator_calendar_french"] == [
        "Envoi des dossiers jusqu’au 26 octobre 2026 à 12 heures."
    ]
    assert detail["documents"] == [{
        "label": "REGLEMENT DE CONSULTATION",
        "url": "https://lesnotairesdutrocadero.fr/documents/reglement-consultation.pdf",
    }]
    assert "The French State" not in detail["description"]
    assert "Visiting period" not in detail["description"]
    assert "For any questions" not in detail["description"]
    assert "starting_price_eur" not in detail


def test_trocadero_parser_fails_closed_for_other_paths():
    assert parse_trocadero_operator_detail(page(), "https://lesnotairesdutrocadero.fr/contact") == {}


def test_trocadero_enrichment_merges_verified_detail_and_preserves_catalogue_identity(monkeypatch):
    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, endpoint):
            assert endpoint == URL
            return page()

    sale = {
        "source_name": "agrasc",
        "source_url": URL,
        "external_id": "domaine-dexception-antibes",
        "title": "Domaine d’exception – Antibes",
        "source_blocks": {"origine": "AGRASC"},
    }
    clients = {}
    errors = []

    import src.sources.agrasc_operators as operators
    monkeypatch.setattr(operators, "PoliteHttpClient", Client)
    enrich_agrasc_operator(sale, clients, {"user_agent": "test", "request_delay_seconds": 0,
                                            "request_timeout_seconds": 1}, errors)

    assert errors == []
    assert sale["source_name"] == "agrasc"
    assert sale["source_url"] == URL
    assert sale["operator_detail_status"] == "complete"
    assert sale["source_detail_status"] == "complete"
    assert sale["city"] == "Antibes"


def test_agorastore_seller_catalogue_is_retained_without_fetching_other_products():
    url = "https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo"
    sale = {"source_name": "agrasc", "source_url": url, "source_blocks": {}}
    errors = []

    enrich_agrasc_operator(
        sale,
        {},
        {"user_agent": "test", "request_delay_seconds": 0, "request_timeout_seconds": 1},
        errors,
    )

    assert errors == []
    assert sale["operator_detail_status"] == "unsupported"
    assert sale["source_detail_status"] == "unsupported"
    assert sale["source_blocks"]["operator_detail_reason"] == "seller_catalogue_without_listing_identity"


def test_agrasc_cards_emit_both_new_public_operator_urls():
    html = """
    <div class="view-liste-ventes-immobilieres">
      <div class="fr-card card-vente-immo">
        <h3 class="fr-card__title"><a href="https://lesnotairesdutrocadero.fr/appel_d_offre/domaine-dexception-antibes/">Domaine d’exception</a></h3>
        <p class="fr-card__detail">Antibes (06)</p>
        <p class="fr-card__desc">Consultation par appel d’offres.</p>
      </div>
      <div class="fr-card card-vente-immo">
        <h3 class="fr-card__title"><a href="https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo">Maison AGRASC</a></h3>
        <p class="fr-card__detail">Agen (47)</p>
        <p class="fr-card__desc">Vente immobilière.</p>
      </div>
    </div>
    """

    rows = parse_agrasc_html(html)
    errors = []
    valid = validate_raw_sales("agrasc", rows, errors)

    assert [row["source_url"] for row in valid] == [
        "https://lesnotairesdutrocadero.fr/appel_d_offre/domaine-dexception-antibes/",
        "https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo",
    ]
    assert errors == []
