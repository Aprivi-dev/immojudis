"""Repli AGRASC par la page vendeur Agorastore quand agrasc.gouv.fr est en panne (01/11/2026).

Le repli découvre les ventes, les enrichit par leur fiche ``.aspx``, mais ne certifie jamais l'inventaire AGRASC :
ni ``last_publication_complete_at``, ni retrait par absence, et le run reste en échec tant que le catalogue l'est.
"""

from __future__ import annotations

import copy
import json
import types
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from src import main
from src.dedupe import merge_duplicate_sales
from src.normalize import normalize_sale
from src.sources import agrasc, agrasc_operators
from src.sources.agrasc_operators import discover_agora_seller_products, parse_agora_seller_listing
from src.sources.agrasc_urls import AGORA_IMMO_SELLER_URL, classify_agrasc_operator_url
from src.sources.common import RobotsAccessRefusedError, RobotsRules, RobotsUnavailableError, ScrapeResult
from tests.test_finish_source_inventory import _finish
from tests.test_main import _settings

FIXTURE = Path(__file__).parent / "fixtures" / "agrasc_agorastore_vendeur.html"
PREFIX = "React.createElement(SearchPageApp, "
FIXTURE_NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
CATALOGUE_URL = agrasc.LIST_URL
# (identifiant, mise à prix réelle de la fiche) : jamais égale au prix courant de la liste de la fixture.
INITIAL_PRICES = {424878: 9000, 429755: 140000, 435966: 4000, 435931: 50000, 436616: 11000}
CURRENT_PRICES = {424878: 11634.0, 429755: 169917.0, 435966: 5540.0, 435931: 61712.0, 436616: 13296.0}
SETTINGS = {"user_agent": "ImmojudisBot/1.0 (+https://immojudis.com/contact)", "request_delay_seconds": 0,
            "request_timeout_seconds": 1}
ROBOTS_AGORASTORE = """
User-agent: *
Disallow: /ventes-immobilieres*r=*
Disallow: /ventes-immobilieres*s=*
Disallow: /*sort=*
"""


def _props(html: str) -> dict[str, Any]:
    return json.JSONDecoder().raw_decode(html.split(PREFIX, 1)[1].lstrip())[0]


def _page(props: dict[str, Any]) -> str:
    return (f"<html><body><script>ReactDOM.render({PREFIX}{json.dumps(props)}, "
            "document.getElementById(\"search-page-app\"));</script></body></html>")


def _seller_html(mutate=None, *, relative_dates: bool = False) -> str:
    props = copy.deepcopy(_props(FIXTURE.read_text(encoding="utf-8")))
    if relative_dates:  # les dates figées de la fixture finiraient par être passées
        for index, item in enumerate(props["searchPageModel"]["searchResults"]["products"]):
            item["sale"]["startDate"] = (datetime.now(UTC) + timedelta(days=20 + index)).isoformat()
            item["sale"]["endDate"] = (datetime.now(UTC) + timedelta(days=22 + index)).isoformat()
    if mutate:
        mutate(props["searchPageModel"]["searchResults"], props["searchPageModel"])
    return _page(props)


def _fiche(product_id: int) -> str:
    sale_day = datetime.now(UTC) + timedelta(days=30)
    model = {
        "product": {"id": product_id, "realEstateInformation": {}},
        "descriptifs": [{"descriptifs": [
            {"descriptifLibelle": "Surface habitable", "value": "80 m²"},
            {"descriptifLibelle": "Adresse", "value": "1 rue de l'Exemple"},
        ]}],
        "documents": [], "images": [],
    }
    props = {"ficheProduitModel": {
        "productPageWrapper": {"productPageModel": model},
        "saleState": {"productId": product_id, "endDate": sale_day.isoformat(),
                      "startDate": (sale_day - timedelta(days=2)).isoformat(),
                      "initialPrice": INITIAL_PRICES[product_id]},
    }}
    return "<script>ReactDOM.render(React.createElement(FicheProduitApp, " + json.dumps(props) + "), x);</script>"


def _status_error(code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", CATALOGUE_URL)
    return httpx.HTTPStatusError(f"Server error '{code}'", request=request, response=httpx.Response(code, request=request))


class _World:
    """Les deux origines simulées : le catalogue AGRASC (panne ou page) et Agorastore (page vendeur et fiches)."""

    def __init__(self, monkeypatch, *, catalogue, seller_html=None, broken_fiches=()) -> None:
        self.requested: list[str] = []
        self.catalogue = catalogue
        self.seller_html = seller_html if seller_html is not None else _seller_html(relative_dates=True)
        self.broken_fiches = set(broken_fiches)
        world = self

        class AgrascClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def get(self, url: str) -> str:
                world.requested.append(url)
                outcome = world.catalogue(url) if callable(world.catalogue) else world.catalogue
                if isinstance(outcome, BaseException):
                    raise outcome
                return outcome

            def coverage_metrics(self) -> dict[str, object]:
                return {"requests_attempted": 1}

        class OperatorClient:
            def __init__(self, *, base_url: str, **kwargs) -> None:
                self.base_url = base_url

            def get(self, url: str) -> str:
                world.requested.append(url)
                if url == AGORA_IMMO_SELLER_URL:
                    if isinstance(world.seller_html, BaseException):
                        raise world.seller_html
                    return world.seller_html
                product_id = int(url.rsplit("-", 1)[-1].removesuffix(".aspx"))
                if product_id in world.broken_fiches:
                    raise _status_error(500)
                return _fiche(product_id)

        monkeypatch.setattr(agrasc, "PoliteHttpClient", AgrascClient)
        monkeypatch.setattr(agrasc_operators, "PoliteHttpClient", OperatorClient)
        monkeypatch.setattr(agrasc, "load_settings", lambda: SETTINGS)
        monkeypatch.setattr("src.source_checkpoint.restore_detail", lambda sale: False)


# --- Le parseur ---------------------------------------------------------------------------------------------


def test_the_parser_reads_the_five_agrasc_products_of_the_seller_page() -> None:
    discovery = parse_agora_seller_listing(FIXTURE.read_text(encoding="utf-8"), now=FIXTURE_NOW)

    assert discovery.complete and discovery.reasons == []
    assert discovery.advertised_total == 5 and discovery.products_read == 5 and discovery.ignored == []
    assert [sale["external_id"] for sale in discovery.products] == ["424878", "429755", "435966", "435931", "436616"]
    auchel = discovery.products[0]
    assert auchel["source_url"] == (
        "https://www.agorastore-immo.fr/vente-occasion/immobilier/maison/maison-62-m-auchel-62-424878.aspx"
    )
    assert (auchel["source_name"], auchel["department"], auchel["city"], auchel["surface_m2"]) == (
        "agrasc", "62", "Auchel", "62")
    assert auchel["sale_date"] == "2026-11-26T16:00:00+01:00"
    assert auchel["source_blocks"]["discovery_channel"] == "agorastore_seller"
    assert {sale["department"] for sale in discovery.products} == {"62", "13", "90", "16", "86"}
    assert all(classify_agrasc_operator_url(sale["source_url"]) == "agorastore_product" for sale in discovery.products)


def test_the_current_price_of_the_list_is_never_used_as_the_starting_price() -> None:
    discovery = parse_agora_seller_listing(FIXTURE.read_text(encoding="utf-8"), now=FIXTURE_NOW)

    for sale in discovery.products:
        assert not sale.get("starting_price_eur")
        dumped = json.dumps(sale, ensure_ascii=False)
        assert not any(str(int(price)) in dumped for price in CURRENT_PRICES.values())
        assert "currentPrice" not in dumped
        assert normalize_sale(sale).starting_price_eur is None


@pytest.mark.parametrize(
    ("sale", "expected"),
    [
        ({"saleStatus": 0, "endDate": "2026-11-26T16:00:00+01:00"}, "upcoming"),
        ({"saleStatus": 1, "endDate": "2026-11-26T16:00:00+01:00"}, "unknown"),
        ({"saleStatus": 0, "endDate": "2026-10-26T16:00:00+01:00"}, "unknown"),  # échéance passée
        ({"saleStatus": 0}, "unknown"),
        ({"saleStatus": 0, "endDate": "pas une date"}, "unknown"),
        ({"saleStatus": 0, "endDate": "2026-11-26T16:00:00"}, "unknown"),  # sans fuseau : non prouvée
        ({"saleStatus": False, "endDate": "2026-11-26T16:00:00+01:00"}, "unknown"),  # un booléen n'est pas le code 0
        ({"saleStatus": None, "endDate": "2026-11-26T16:00:00+01:00"}, "unknown"),
    ],
)
def test_a_product_is_upcoming_only_when_not_started_and_its_end_date_is_future(sale, expected) -> None:
    def mutate(results, _model) -> None:
        results["products"] = results["products"][:1]
        results["countTotal"] = 1
        results["products"][0]["sale"] = {**sale, "currentPrice": 1.0}

    discovery = parse_agora_seller_listing(_seller_html(mutate), now=FIXTURE_NOW)

    assert [item["status"] for item in discovery.products] == [expected]


def test_a_product_of_another_seller_is_ignored() -> None:
    def mutate(results, _model) -> None:
        results["products"][1]["sellerName"] = "Commune de Paradou"

    discovery = parse_agora_seller_listing(_seller_html(mutate), now=FIXTURE_NOW)

    assert [sale["external_id"] for sale in discovery.products] == ["424878", "435966", "435931", "436616"]
    assert discovery.ignored == [{
        "product_id": "429755", "reason": "other_seller",
        "url": "https://www.agorastore-immo.fr/vente-occasion/immobilier/maison/maison-117-m-paradou-13-429755.aspx",
    }]
    assert discovery.complete  # 5 produits lus pour countTotal=5 : la page est complète, un produit est écarté


@pytest.mark.parametrize(
    ("product_page_url", "reason"),
    [
        ("/ventes-immobilieres/vendeur/agrascimmo", "not_agorastore_product_url"),  # la page catalogue elle-même
        ("https://evil.example/vente-occasion/maison/maison-1-424878.aspx", "not_agorastore_product_url"),
        ("/vente-occasion/immobilier/maison/maison-sans-numero.aspx", "not_agorastore_product_url"),
        ("/vente-occasion/immobilier/maison/maison-62-m-auchel-62-999999.aspx", "product_identity_mismatch"),
        (None, "not_agorastore_product_url"),
    ],
)
def test_a_product_without_a_listing_identity_is_ignored(product_page_url, reason) -> None:
    def mutate(results, _model) -> None:
        results["products"][0]["productPageUrl"] = product_page_url

    discovery = parse_agora_seller_listing(_seller_html(mutate), now=FIXTURE_NOW)

    assert [sale["external_id"] for sale in discovery.products] == ["429755", "435966", "435931", "436616"]
    assert [item["reason"] for item in discovery.ignored] == [reason]


@pytest.mark.parametrize(("show_on_site", "kept"), [(False, False), (True, True), ("absent", True), (None, True)])
def test_a_product_explicitly_hidden_on_the_site_is_ignored(show_on_site, kept) -> None:
    def mutate(results, _model) -> None:
        if show_on_site == "absent":
            results["products"][1].pop("showOnSite", None)
        else:
            results["products"][1]["showOnSite"] = show_on_site
        results["products"][1]["hidePrice"] = True  # hidePrice ne change rien : la mise à prix vient de la fiche

    discovery = parse_agora_seller_listing(_seller_html(mutate), now=FIXTURE_NOW)

    assert ("429755" in [sale["external_id"] for sale in discovery.products]) is kept
    if kept:
        assert discovery.ignored == []
    else:
        assert [(item["product_id"], item["reason"]) for item in discovery.ignored] == [("429755", "hidden_on_site")]
        assert discovery.complete  # 5 produits lus pour countTotal=5 : la page reste complète


def test_a_duplicated_product_is_read_once() -> None:
    def mutate(results, _model) -> None:
        results["products"].append(copy.deepcopy(results["products"][0]))
        results["countTotal"] = 6

    discovery = parse_agora_seller_listing(_seller_html(mutate), now=FIXTURE_NOW)

    assert len(discovery.products) == 5
    assert [item["reason"] for item in discovery.ignored] == ["duplicate_product"]


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"countTotal": 12}, "advertised_total_mismatch"),
        ({"countTotal": 3}, "advertised_total_mismatch"),
        ({"countTotal": None}, "advertised_total_missing"),
        ({"countTotal": "5"}, "advertised_total_missing"),
        ({"from": 5}, "page_offset_not_zero"),
    ],
)
def test_an_inconsistent_total_makes_the_coverage_incomplete_without_guessing_a_page(changes, reason) -> None:
    def mutate(results, _model) -> None:
        results.update(changes)

    discovery = parse_agora_seller_listing(_seller_html(mutate), now=FIXTURE_NOW)

    assert not discovery.complete
    assert reason in discovery.reasons
    assert len(discovery.products) == 5  # ce qui est lu reste exploitable


def test_a_page_of_another_seller_or_without_props_is_refused() -> None:
    def other_seller(_results, model) -> None:
        model["sellerInfo"] = {"id": 1, "name": "AUTRE", "url": "autre"}

    with pytest.raises(ValueError, match="seller mismatch"):
        parse_agora_seller_listing(_seller_html(other_seller), now=FIXTURE_NOW)
    with pytest.raises(ValueError, match="props not found"):
        parse_agora_seller_listing("<html><body>Maintenance</body></html>", now=FIXTURE_NOW)


# --- La découverte : URL nue, robots.txt, client poli -----------------------------------------------------------


def test_the_discovery_requests_the_bare_seller_url_through_the_polite_client(monkeypatch) -> None:
    world = _World(monkeypatch, catalogue=_status_error(500))
    clients: dict[str, Any] = {}

    discovery = discover_agora_seller_products(clients, SETTINGS, now=FIXTURE_NOW)

    assert world.requested == [AGORA_IMMO_SELLER_URL]
    assert "?" not in AGORA_IMMO_SELLER_URL
    assert list(clients) == ["https://www.agorastore-immo.fr"]
    assert discovery.complete


def test_the_robots_rules_of_agorastore_allow_the_bare_url_and_refuse_the_sort_parameters() -> None:
    rules = RobotsRules.parse(ROBOTS_AGORASTORE, SETTINGS["user_agent"])

    assert rules.can_fetch(AGORA_IMMO_SELLER_URL)
    assert not rules.can_fetch(f"{AGORA_IMMO_SELLER_URL}?sort=3")
    assert not rules.can_fetch(f"{AGORA_IMMO_SELLER_URL}?r=75")


# --- Le repli ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "failure",
    [
        _status_error(500),
        _status_error(503),
        httpx.ConnectError("connection refused"),
        httpx.ReadTimeout("timed out"),
        RobotsUnavailableError("robots.txt could not be verified for https://agrasc.gouv.fr/robots.txt: HTTP 500"),
    ],
)
def test_a_server_or_network_failure_on_page_zero_triggers_the_agorastore_fallback(monkeypatch, failure) -> None:
    world = _World(monkeypatch, catalogue=failure)

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert world.requested[:2] == [CATALOGUE_URL, AGORA_IMMO_SELLER_URL]
    assert len(result.sales) == 5
    assert {sale["source_url"] for sale in result.sales} == {
        item["source_url"] for item in parse_agora_seller_listing(_seller_html(relative_dates=True)).products
    }
    # L'erreur d'origine reste visible, en tête des erreurs, et dans un champ dédié.
    assert result.errors[0].startswith(f"{CATALOGUE_URL}: ")
    assert result.coverage["fallback"]["trigger_error"] == result.errors[0]
    assert result.coverage["errors"] == len(result.errors)


@pytest.mark.parametrize(
    "failure",
    [
        _status_error(403),
        _status_error(404),
        _status_error(429),
        RobotsAccessRefusedError("robots access refused for https://agrasc.gouv.fr/robots.txt: HTTP 403"),
        httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"),
        ValueError("page illisible"),
    ],
)
def test_a_refusal_or_a_client_error_does_not_trigger_the_fallback(monkeypatch, failure) -> None:
    world = _World(monkeypatch, catalogue=failure)

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert world.requested == [CATALOGUE_URL]  # aucune requête vers Agorastore
    assert result.sales == [] and len(result.errors) == 1
    assert "fallback" not in result.coverage and "discovery_channel" not in result.coverage


def test_a_failure_after_the_first_catalogue_page_keeps_the_partial_catalogue_behaviour(monkeypatch) -> None:
    first = """<div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo"><h3 class="fr-card__title"><a href="/vente/house">Maison</a></h3>
        <p class="fr-card__detail">Agen (47)</p></div>
      <a href="/ventes-aux-encheres?page=1">Page suivante</a></div>"""
    world = _World(monkeypatch, catalogue=lambda url: first if url == CATALOGUE_URL else _status_error(500))
    monkeypatch.setattr(agrasc, "enrich_agrasc_operator", lambda *args, **kwargs: None)

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert AGORA_IMMO_SELLER_URL not in world.requested
    assert len(result.sales) == 1 and result.coverage["coverage_complete"] is False
    assert "fallback" not in result.coverage


def test_the_fallback_enriches_each_product_with_its_page_and_takes_the_starting_price_from_it(monkeypatch) -> None:
    world = _World(monkeypatch, catalogue=_status_error(500))

    result = agrasc.scrape_agrasc_aquitaine_result()

    fiches = [url for url in world.requested if url.endswith(".aspx")]
    assert sorted(fiches) == sorted(sale["source_url"] for sale in result.sales)
    for sale in result.sales:
        product_id = int(sale["external_id"])
        assert sale["starting_price_eur"] == INITIAL_PRICES[product_id]
        assert sale["starting_price_eur"] != CURRENT_PRICES[product_id]
        assert sale["operator_detail_status"] == "complete"
        assert sale["source_blocks"]["discovery_channel"] == "agorastore_seller"
        assert classify_agrasc_operator_url(sale["source_url"]) == "agorastore_product"
        assert sale["status"] == "upcoming"
    assert result.coverage["operator_details"]["complete"] == 5


def test_an_unreadable_product_page_leaves_the_starting_price_empty(monkeypatch) -> None:
    _World(monkeypatch, catalogue=_status_error(500), broken_fiches={424878})

    result = agrasc.scrape_agrasc_aquitaine_result()

    auchel = next(sale for sale in result.sales if sale["external_id"] == "424878")
    assert not auchel.get("starting_price_eur")
    assert "11634" not in json.dumps(auchel)
    assert auchel["operator_detail_status"] == "failed" and auchel["_detail_fetch_failed"] is True
    assert any("operator detail" in error and "424878" in error for error in result.errors)


def test_the_fallback_coverage_is_explicitly_not_certified(monkeypatch) -> None:
    _World(monkeypatch, catalogue=_status_error(500))

    result = agrasc.scrape_agrasc_aquitaine_result()

    coverage = result.coverage
    assert coverage["coverage_complete"] is False
    assert coverage["scoped_inventory_complete"] is False
    assert coverage["inventory_scope"] != "addressable_public_catalogue"
    assert coverage["discovery_channel"] == "agorastore_seller"
    assert coverage["fallback"]["discovery_channel"] == "agorastore_seller"
    assert coverage["fallback"]["discovery_url"] == AGORA_IMMO_SELLER_URL
    assert coverage["fallback"]["discovery_complete"] is True
    assert coverage["certificate"]["public_discovery_certified"] is False
    assert coverage["certificate"]["addressable_public_inventory_certified"] is False
    assert coverage["certificate"]["all_discovered_announcements_emitted"] is False
    json.dumps(coverage)  # la couverture est écrite telle quelle dans le résumé du run


def test_the_department_filter_applies_to_the_fallback_like_to_the_catalogue(monkeypatch) -> None:
    world = _World(monkeypatch, catalogue=_status_error(500))
    monkeypatch.setattr(agrasc, "TARGET_DEPARTMENTS", ("62", "86"))

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert sorted(sale["department"] for sale in result.sales) == ["62", "86"]
    assert sorted(item["reason"] for item in result.coverage["fallback"]["excluded_urls"]) == ["department_filter"] * 3
    assert len([url for url in world.requested if url.endswith(".aspx")]) == 2  # les autres fiches ne sont pas lues


def test_an_incomplete_seller_page_is_reported_and_its_products_are_still_collected(monkeypatch) -> None:
    def mutate(results, _model) -> None:
        results["countTotal"] = 9

    _World(monkeypatch, catalogue=_status_error(500), seller_html=_seller_html(mutate, relative_dates=True))

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert len(result.sales) == 5
    assert result.coverage["fallback"]["discovery_complete"] is False
    assert result.coverage["fallback"]["incomplete_reasons"] == ["advertised_total_mismatch"]
    assert any("discovery incomplete" in error and "countTotal=9" in error for error in result.errors)
    assert result.coverage["coverage_complete"] is False


def test_a_failing_seller_page_leaves_only_the_errors(monkeypatch) -> None:
    _World(monkeypatch, catalogue=_status_error(500), seller_html=_status_error(500))

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert result.sales == []
    assert len(result.errors) == 2 and result.errors[0].startswith(CATALOGUE_URL)
    assert "agorastore seller discovery" in result.errors[1]
    assert result.coverage["coverage_complete"] is False and result.coverage["scoped_inventory_complete"] is False


# --- Pas de certification, pas de retrait par absence ------------------------------------------------------


@pytest.mark.parametrize("status", ["failed", "succeeded"])
def test_the_fallback_never_certifies_the_inventory_nor_withdraws_sales(monkeypatch, status) -> None:
    _World(monkeypatch, catalogue=_status_error(500))
    result = agrasc.scrape_agrasc_aquitaine_result()
    # « succeeded » ne se produit pas aujourd'hui (l'erreur d'origine fait échouer le run) : la couverture seule doit
    # suffire à interdire la certification, même si le statut du run changeait un jour.
    coverage = {**result.coverage, "listings_emitted": len(result.sales)}

    db, presence, withdrawals = _finish(monkeypatch, status=status, coverage=coverage, decisions={"published": 5})

    inventory_fresh, publication_complete = db.state_update[-4], db.state_update[-3]
    assert inventory_fresh is False  # last_inventory_complete_at n'avance pas
    assert publication_complete is False  # last_publication_complete_at n'avance pas
    assert presence == [False]  # aucun compteur d'absence ne bouge
    assert withdrawals == []  # withdraw_missing_source_sales n'est jamais appelé
    assert db.saved_coverage["publication_scope"] == "public_catalogue"
    assert "inventory_incomplete" in db.saved_coverage["publication_blockers"]
    assert db.saved_coverage["discovery_channel"] == "agorastore_seller"


# --- Le run complet : ventes écrites, statut inchangé -------------------------------------------------------


def _run_pipeline_with_fallback(monkeypatch, result: ScrapeResult) -> dict[str, Any]:
    seen: dict[str, Any] = {"calls": [], "finish": []}
    calls = seen["calls"]

    # En GitHub Actions, GITHUB_ENV est défini et register_run exigerait un vrai UUID (comme test_main.py).
    monkeypatch.delenv("GITHUB_ENV", raising=False)
    monkeypatch.setattr(main, "load_settings", lambda: {**_settings(), "enable_agrasc_benchmark": True})
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase",
                        lambda run_id, status, summary, errors: seen["finish"].append((status, summary, dict(errors))))
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_agrasc_aquitaine_result", lambda: result)
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "build_extraction_gap_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "format_extraction_gap_report", lambda report: [])
    monkeypatch.setattr(main, "bridge_auction_sales_before_cleanup",
                        lambda settings: calls.append("bridge") or types.SimpleNamespace(
                            scanned_count=0, created_count=0, reused_count=0))
    monkeypatch.setattr(main, "delete_secondary_sales_in_supabase", lambda sales: calls.append("delete_secondary") or 0)
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: calls.append("mark_past") or 0)
    monkeypatch.setattr(main, "delete_expired_sales_in_supabase", lambda: calls.append("delete_expired") or 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase",
                        lambda sales: seen.setdefault("upserted", []).extend(sales) or len(sales))
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales: len(sales))

    seen["exit_code"] = main.run_pipeline(main.PipelineOptions(
        source="agrasc", use_llm=False, heavy_enrichment=False, upsert=True))
    return seen


def test_a_run_with_agrasc_down_still_writes_the_sales_found_but_stays_failed(monkeypatch) -> None:
    _World(monkeypatch, catalogue=_status_error(500))
    result = agrasc.scrape_agrasc_aquitaine_result()
    assert len(result.sales) == 5

    seen = _run_pipeline_with_fallback(monkeypatch, result)

    # Statut inchangé par rapport à la panne seule : run en échec, code 1, erreur d'origine conservée.
    assert seen["exit_code"] == 1
    status, summary, errors = seen["finish"][-1]
    assert status == "failed"
    assert errors["agrasc"][0].startswith(f"{CATALOGUE_URL}: ")
    assert summary["stage_status"]["collection"] == "failed"
    assert summary["global_cleanup_skipped"] == "collection_incomplete"
    assert summary["scrape_coverage"]["agrasc"]["coverage_complete"] is False
    assert summary["scrape_coverage"]["agrasc"]["scoped_inventory_complete"] is False
    # Mais les ventes trouvées sont bien publiées (upsert avant l'arrêt de nettoyage), et rien n'est supprimé.
    assert {sale.source_url for sale in seen["upserted"]} == {sale["source_url"] for sale in result.sales}
    assert summary["upserted"] == 5
    assert summary["stage_status"]["publication"] == "partial"
    assert seen["calls"] == []


# --- Même source_url que les cartes AGRASC : pas de doublon -----------------------------------------------------


def test_a_fallback_row_merges_with_the_agrasc_card_of_the_same_listing(monkeypatch) -> None:
    _World(monkeypatch, catalogue=_status_error(500))
    result = agrasc.scrape_agrasc_aquitaine_result()
    fallback_row = next(sale for sale in result.sales if sale["external_id"] == "424878")
    card = {
        "source_name": "agrasc", "source_url": fallback_row["source_url"], "external_id": "maison-62-m-auchel-62-424878.aspx",
        "department": "62", "city": "Auchel", "property_type": "Maison", "title": "Maison à Auchel",
        "description": "Maison de 62 m²", "surface_m2": "62", "starting_price_eur": "9 000",
        "sale_date": fallback_row["sale_date"], "status": "upcoming", "documents": [],
        "raw_text": "Maison à Auchel MAP : 9 000 €",
    }

    merged = merge_duplicate_sales([normalize_sale(card), normalize_sale(fallback_row)])
    other_products = merge_duplicate_sales([normalize_sale(sale) for sale in result.sales])

    assert [sale.source_url for sale in merged] == [card["source_url"]]
    assert len(other_products) == 5
    assert len({sale.source_url for sale in other_products}) == 5
