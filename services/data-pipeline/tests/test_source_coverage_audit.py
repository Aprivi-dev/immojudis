import pytest

from src import source_coverage_audit as audit
from src.catalogue_proof import certify_catalogue
from src.config import EncheresPubliquesAccessNotAuthorized
from src.source_coverage_audit import _derive_catalogue_exclusions, page_evidence
from src.sources.common import PaginationCoverage, ScrapeResult


def test_encheres_publiques_audit_refuses_before_import_or_output(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        audit,
        "load_settings",
        lambda: {
            "enable_encheres_publiques_benchmark": False,
            "encheres_publiques_access_authorized": False,
        },
    )
    monkeypatch.setattr(audit.importlib, "import_module", lambda *_: pytest.fail("collector must not import"))
    output = tmp_path / "encheres-publiques.json"

    with pytest.raises(EncheresPubliquesAccessNotAuthorized):
        audit.run_audit("encheres_publiques", output)

    assert not output.exists()


def test_empty_html_or_login_page_does_not_certify_inventory():
    p = PaginationCoverage()
    p.accept([{'source_url': 'https://example.test/a'}])
    p.accept([])
    assert p.metrics()['coverage_complete'] is False
    assert p.metrics()['stop_reason'] == 'empty_page_unverified'


def test_announced_total_must_match_distinct_listings():
    p = PaginationCoverage()
    p.accept([{'source_url': 'a'}], terminal=True, expected_total=2)
    assert not p.exhausted
    p.accept([{'source_url': 'b'}], terminal=True, expected_total=2)
    assert p.exhausted


def test_changing_totals_cannot_certify_snapshot():
    p = PaginationCoverage()
    p.accept([{'source_url': 'a'}], expected_total=1)
    p.accept([{'source_url': 'b'}], terminal=True, expected_total=2)
    assert not p.exhausted and p.total_changed


def test_failed_page_overrides_exhaustion_claim():
    result = ScrapeResult([], ['page 2 failed'], {'coverage_complete': True})
    assert result.coverage['coverage_complete'] is False
    assert result.coverage['stop_reason'] == 'source_errors'


def test_audit_records_provider_totals_and_public_next_links():
    evidence = page_evidence('{"nbTotalAnnonces":48,"nbPages":2,"page":1,"annonceResumeDto":[{}]}', 'https://example.test/api')
    assert evidence['advertised_total'] == 48 and evidence['raw_rows'] == 1
    evidence = page_evidence('<a rel="next" href="?page=2">Suivant</a>', 'https://example.test/list')
    assert evidence['pagination_links'] == ['https://example.test/list?page=2']


def test_audit_rederives_agrasc_seller_exclusion_from_traced_public_urls():
    seller = 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'
    product = 'https://www.agorastore-immo.fr/vente-occasion/maison-430647.aspx'
    proof = {
        'partition': 'agrasc',
        'page_index': 0,
        'advertised_totals': [],
        'advertised_last_pages': [0],
        'public_urls': [seller, product],
        'outside_scope_urls': [],
        'unlinked_cards': 0,
    }

    exclusions = _derive_catalogue_exclusions('agrasc', [proof])
    assert exclusions == {
        seller: 'operator_seller_catalogue_without_listing_identity',
    }

    certificate = certify_catalogue(
        'agrasc',
        [proof],
        {'agrasc': {product}},
        {product},
        [],
        False,
        {},
        exclusions=exclusions,
    )
    assert certificate['excluded_urls'] == [{
        'url': seller,
        'reason': 'operator_seller_catalogue_without_listing_identity',
    }]
    assert certificate['unhandled_public_urls'] == []
    assert certificate['public_discovery_certified'] is True
