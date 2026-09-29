import json
from decimal import Decimal

import pytest

from src.normalize import normalize_sale
from src.sources.agrasc_operators import (
    AGORA_ORIGIN,
    enrich_agrasc_operator,
    parse_agora_operator_detail,
    parse_immo_operator_json,
)
from src.sources.agrasc_urls import classify_agrasc_operator_url, is_allowed_agrasc_source_url

URL = 'https://www.agorastore-immo.fr/vente-occasion/maison-430647.aspx'
LEGACY_MARKETPLACE_URL = (
    'https://www.agorastore.fr/vente-occasion/immobilier/appartement/'
    'appartement-115-m-paris-75-407453.aspx'
)
CANONICAL_MARKETPLACE_URL = (
    'https://www.agorastore-immo.fr/vente-occasion/immobilier/appartement/'
    'appartement-110-m-paris-75-407453.aspx'
)


def page(product_id=430647):
    model = {'product': {'id': product_id, 'realEstateInformation': {'lastVisitDate': '2026-09-30T16:00:00+02:00'}},
             'descriptifs': [{'descriptifs': [
                 {'descriptifLibelle': 'Surface habitable', 'value': '120 m² habitable et 157 m² non habitables'},
                 {'descriptifLibelle': 'Adresse', 'value': '6 route de Revel, 31250 Revel'},
                 {'descriptifLibelle': 'Points clés', 'value': 'Libre de toute occupation. Un tiers indivis de la parcelle YD 60.'}]}],
             'documents': [{'fileName': 'Diagnostics', 'url': 'https://cdn.agorastore.fr/produits/documents/abc.pdf'},
                           {'fileName': 'Autre', 'url': 'https://evil.example/file.pdf'},
                           {'url': 'https://cdn.agorastore.fr/icon.svg'}],
             'images': [{'url': 'https://cdn.agorastore.fr/produits/images/abc.jpg'}]}
    props = {'ficheProduitModel': {'productPageWrapper': {'productPageModel': model},
                                  'saleState': {'productId': product_id, 'endDate': '2026-10-22T16:00:00+02:00',
                                                'startDate': '2026-10-20T14:00:00+02:00', 'initialPrice': 78518}}}
    return '<script>ReactDOM.render(React.createElement(FicheProduitApp, ' + json.dumps(props) + '), document.body);</script>'


def synthetic_page(product_id=123456, *, cadastral_value=None):
    descriptors = [{'descriptifLibelle': 'Surface parcelle', 'value': '120 m²'}]
    if cadastral_value is not None:
        descriptors.append({'descriptifLibelle': 'Références cadastrales', 'value': f'A ({cadastral_value} m²)'})
    model = {
        'product': {'id': product_id, 'realEstateInformation': {}},
        'descriptifs': [{'descriptifs': descriptors}],
        'documents': [],
        'images': [],
    }
    props = {
        'ficheProduitModel': {
            'productPageWrapper': {'productPageModel': model},
            'saleState': {'productId': product_id},
        }
    }
    return '<script>React.createElement(FicheProduitApp, ' + json.dumps(props) + ');</script>'


def carrez_page(product_id=407453):
    props = {
        'ficheProduitModel': {
            'productPageWrapper': {'productPageModel': {
                'product': {'id': product_id, 'realEstateInformation': {}},
                'descriptifs': [{'descriptifs': [
                    {'descriptifLibelle': 'Surface Carrez', 'value': '117,31 m²'},
                    {'descriptifLibelle': 'Adresse', 'value': '1 rue de Test, 75001 Paris'},
                ]}],
                'documents': [], 'images': [],
            }},
            'saleState': {'productId': product_id},
        }
    }
    return '<script>React.createElement(FicheProduitApp, ' + json.dumps(props) + ');</script>'


def coproperty_parcel_page(product_id=424870):
    props = {
        'ficheProduitModel': {
            'productPageWrapper': {'productPageModel': {
                'product': {'id': product_id, 'realEstateInformation': {}},
                'descriptifs': [{'descriptifs': [
                    {'descriptifLibelle': 'Type de bien', 'value': 'Local et cave'},
                    {'descriptifLibelle': 'Copropriété', 'value': 'Lots 899 et 547'},
                    {'descriptifLibelle': 'Surface parcelle', 'value': '4 609 m²'},
                    {'descriptifLibelle': 'Surface Carrez', 'value': '70,53 m²'},
                ]}],
                'documents': [], 'images': [],
            }},
            'saleState': {'productId': product_id},
        }
    }
    return '<script>React.createElement(FicheProduitApp, ' + json.dumps(props) + ');</script>'


def test_public_props_supply_details_not_only_jsonld_photo():
    detail = parse_agora_operator_detail(page(), URL)
    assert detail['surface_m2'] == '120'
    assert detail['occupancy_status'] == 'vacant'
    assert detail['sale_date'] == '2026-10-22T16:00:00+02:00'
    assert detail['starting_price_eur'] == 78518
    assert detail['address'] == '6 route de Revel, 31250 Revel'
    assert 'tiers indivis' in detail['description']
    assert len(detail['documents']) == 1
    assert len(detail['source_images']) == 1
    assert detail['source_blocks']['operator_visit_coverage'] == 'last_visit_only'


def test_surface_parcelle_is_promoted_when_no_cadastral_contradiction_exists():
    detail = parse_agora_operator_detail(
        synthetic_page(), 'https://www.agorastore-immo.fr/vente-occasion/terrain-123456.aspx'
    )

    assert detail['external_id'] == '123456'
    assert detail['land_surface_m2'] == '120'


def test_surface_parcelle_of_coproperty_lot_stays_source_scoped():
    detail = parse_agora_operator_detail(
        coproperty_parcel_page(),
        'https://www.agorastore-immo.fr/vente-occasion/local-424870.aspx',
    )

    assert 'land_surface_m2' not in detail
    assert detail['operator_land_surface_scope'] == 'copropriété'
    assert detail['source_blocks']['surface_parcelle'] == '4609'

    sale = normalize_sale({
        'source_name': 'agrasc',
        'source_url': 'https://www.agorastore-immo.fr/vente-occasion/local-424870.aspx',
        'property_type': 'Local commercial',
        **detail,
    })

    assert sale.land_surface_m2 is None
    assert sale.carrez_surface_m2 == Decimal('70.53')
    assert sale.app_surface_m2 == Decimal('70.53')
    assert sale.raw_payload['source_blocks']['surface_parcelle'] == '4609'
    assert 'parcel_surface_scope_unverified' in sale.quality_flags


def test_surface_parcelle_is_withheld_when_cadastral_area_is_larger():
    detail = parse_agora_operator_detail(
        synthetic_page(cadastral_value='150'), 'https://www.agorastore-immo.fr/vente-occasion/terrain-123456.aspx'
    )

    assert detail['operator_land_surface_conflict'] is True
    assert 'land_surface_m2' not in detail


def test_enrichment_uses_validated_operator_product_id_as_external_id():
    class Client:
        def get(self, url):
            return synthetic_page()

    sale = {
        'source_url': 'https://www.agorastore-immo.fr/vente-occasion/terrain-123456.aspx',
        'external_id': 'terrain-123456.aspx',
    }
    errors = []
    enrich_agrasc_operator(
        sale,
        {AGORA_ORIGIN: Client()},
        {'user_agent': 'synthetic-test', 'request_delay_seconds': 0, 'request_timeout_seconds': 1},
        errors,
    )

    assert errors == []
    assert sale['external_id'] == '123456'


def test_legacy_agora_hostname_keeps_its_exact_source_origin(monkeypatch):
    url = 'https://agorastore-immo.fr/vente-occasion/maison-430647.aspx'
    observed = {}

    class Client:
        def __init__(self, **kwargs):
            observed.update(kwargs)

        def get(self, endpoint):
            assert endpoint == url
            return page()

    import src.sources.agrasc_operators as operators
    monkeypatch.setattr(operators, 'PoliteHttpClient', Client)
    sale = {'source_url': url, 'source_blocks': {}}
    errors = []

    enrich_agrasc_operator(
        sale,
        {},
        {'user_agent': 'synthetic-test', 'request_delay_seconds': 0, 'request_timeout_seconds': 1},
        errors,
    )

    assert errors == []
    assert observed['base_url'] == 'https://agorastore-immo.fr'
    assert sale['external_id'] == '430647'


def test_api_product_id_is_promoted_as_external_id():
    payload = json.dumps({
        'id': 777,
        'typeTransaction': 'VNI',
        'bien': {'typeBien': 'MAI', 'maison': {}},
        'vni': {'descriptions': [{'langue': 'fr', 'descLongue': 'Synthetic asset'}]},
    })

    detail = parse_immo_operator_json(payload, '777')

    assert detail['external_id'] == '777'


def test_public_props_identity_must_match_requested_listing():
    with pytest.raises(ValueError, match='identity mismatch'):
        parse_agora_operator_detail(page(123), URL)


def test_marketplace_product_variant_keeps_identity_after_canonical_redirect():
    marketplace_url = LEGACY_MARKETPLACE_URL

    detail = parse_agora_operator_detail(carrez_page(), marketplace_url)

    assert classify_agrasc_operator_url(marketplace_url) == 'agorastore_product'
    assert is_allowed_agrasc_source_url(marketplace_url) is True
    assert detail['external_id'] == '407453'
    assert detail['carrez_surface_m2'] == '117.31'
    assert 'surface_m2' not in detail
    with pytest.raises(ValueError, match='identity mismatch'):
        parse_agora_operator_detail(carrez_page(407454), marketplace_url)


def test_marketplace_product_enrichment_allows_only_known_canonical_redirect(monkeypatch):
    marketplace_url = LEGACY_MARKETPLACE_URL
    observed = {}

    class Client:
        def __init__(self, **kwargs):
            observed.update(kwargs)
            self._visited_urls = []

        def get(self, url):
            assert url == marketplace_url
            self._visited_urls.append(CANONICAL_MARKETPLACE_URL)
            return carrez_page()

    import src.sources.agrasc_operators as operators
    monkeypatch.setattr(operators, 'PoliteHttpClient', Client)
    sale = {'source_url': marketplace_url, 'source_blocks': {}}
    errors = []

    enrich_agrasc_operator(
        sale,
        {},
        {'user_agent': 'synthetic-test', 'request_delay_seconds': 0, 'request_timeout_seconds': 1},
        errors,
    )

    assert errors == []
    assert observed['base_url'] == 'https://www.agorastore.fr'
    assert observed['allowed_redirect_origins'] == (AGORA_ORIGIN,)
    assert sale['source_blocks']['operator_canonical_url'].startswith(AGORA_ORIGIN)
    assert sale['carrez_surface_m2'] == '117.31'


def test_missing_public_props_retains_partial_fallback():
    assert parse_agora_operator_detail('<html></html>', URL) == {}


def test_operator_javascript_is_never_executed():
    with pytest.raises(json.JSONDecodeError):
        parse_agora_operator_detail('<script>React.createElement(FicheProduitApp, dangerousFunction());</script>', URL)


def test_land_smaller_than_cadastral_parcel_is_flagged_without_summing_shares():
    html = page()
    # Add source fields to the existing descriptor group, not the product header.
    extra = [{'descriptifLibelle': 'Surface terrain', 'value': '92 m²'},
             {'descriptifLibelle': 'Références cadastrales', 'value': 'YD 59 (1 742m²) et YD 60 (91 m²)'}]
    prefix = 'React.createElement(FicheProduitApp, '
    props = json.JSONDecoder().raw_decode(html.split(prefix)[1])[0]
    props['ficheProduitModel']['productPageWrapper']['productPageModel']['descriptifs'][0]['descriptifs'].extend(extra)
    detail = parse_agora_operator_detail('<script>' + prefix + json.dumps(props) + ');</script>', URL)
    assert detail['operator_land_surface_conflict'] is True
    assert len(detail['source_display_constraints']) == 2
    assert 'land_surface_m2' not in detail
