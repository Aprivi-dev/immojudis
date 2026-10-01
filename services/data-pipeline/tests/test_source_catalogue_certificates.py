from __future__ import annotations

from src.sources import agrasc, petites_affiches

PETITES_CARD = """
<div class="annonce_lot_1 col-md-6">
  <div class="annonceListe">
    <div class="imgList"><a href="/vente/shared.html"><img src="/image.jpg" /></a></div>
    <div class="titreVente"><a href="/vente/shared.html">Appartement à Bordeaux</a></div>
    <div class="miseAPrix"><strong>80 000</strong> €</div>
    <div class="dateVente"><strong>24/06/2026</strong></div>
  </div>
</div>
<a class="fr-pagination__link--last" href="/encheres-immobilieres/ventes-aux-encheres-immobilieres-p1.html">Dernière page</a>
"""


def _petites_settings() -> dict[str, object]:
    return {
        "browser_user_agent": "Mozilla/5.0",
        "request_delay_seconds": 0,
        "request_timeout_seconds": 1,
    }


def test_petites_affiches_certifies_each_post_partition_before_global_dedupe(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def post_form(self, url: str, data: dict[str, str]) -> str:
            calls.append((url, data.get("select_dep", "all")))
            return PETITES_CARD

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", ("33", "75"))
    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", Client)
    monkeypatch.setattr(petites_affiches, "load_settings", _petites_settings)
    monkeypatch.setattr(petites_affiches, "_enrich_sale_from_detail", lambda *args, **kwargs: None)

    result = petites_affiches.scrape_petites_affiches_aquitaine_result()

    assert [department for _url, department in calls] == ["33", "75"]
    assert len(result.sales) == 1
    assert result.coverage["coverage_complete"] is True
    assert result.coverage["certificate"]["public_discovery_certified"] is True
    assert {item["partition"] for item in result.coverage["certificate"]["partitions"]} == {
        "department:33",
        "department:75",
    }


def test_petites_affiches_incomplete_partition_cannot_be_certified(monkeypatch) -> None:
    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def post_form(self, url: str, data: dict[str, str]) -> str:
            return PETITES_CARD.replace(
                '<a class="fr-pagination__link--last" href="/encheres-immobilieres/ventes-aux-encheres-immobilieres-p1.html">Dernière page</a>',
                '<a href="/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html">Page suivante</a>',
            )

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", ("33",))
    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", Client)
    monkeypatch.setattr(petites_affiches, "load_settings", _petites_settings)
    monkeypatch.setattr(petites_affiches, "_enrich_sale_from_detail", lambda *args, **kwargs: None)

    result = petites_affiches.scrape_petites_affiches_aquitaine_result(max_pages=1)

    assert result.coverage["partitions"][0]["linked_pages_complete"] is False
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["certificate"]["public_discovery_certified"] is False


def _agrasc_html(*, unknown_unlinked: bool = False) -> str:
    unlinked_class = "card-vente-immo" if unknown_unlinked else "card-vente-immo sold"
    return f"""
    <div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo">
        <h3 class="fr-card__title"><a href="/vente/house">Maison</a></h3>
        <p class="fr-card__detail">Agen (47)</p>
      </div>
      <div class="{unlinked_class}">
        <h3>Archive vendue sans lien</h3>
        <div class="fr-card__start"><p class="fr-badge fr-badge--error">Vendu</p></div>
      </div>
      <a class="fr-pagination__link--last" href="/ventes-aux-encheres?page=0">Dernière page</a>
    </div>
    """


def _patch_agrasc_client(monkeypatch, html: str) -> None:
    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def get(self, url: str) -> str:
            return html

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(agrasc, "TARGET_DEPARTMENTS", ("47",))
    monkeypatch.setattr(agrasc, "PoliteHttpClient", Client)
    monkeypatch.setattr(
        agrasc,
        "load_settings",
        lambda: {
            "user_agent": "Mozilla/5.0",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
        },
    )
    monkeypatch.setattr(agrasc, "enrich_agrasc_operator", lambda *args, **kwargs: None)
    monkeypatch.setattr("src.source_checkpoint.restore_detail", lambda sale: False)


def test_agrasc_sold_unlinked_cards_are_counted_as_addressable_only(monkeypatch) -> None:
    _patch_agrasc_client(monkeypatch, _agrasc_html())

    result = agrasc.scrape_agrasc_aquitaine_result()

    certificate = result.coverage["certificate"]
    assert certificate["public_discovery_certified"] is False
    assert certificate["addressable_public_inventory_certified"] is True
    assert len(certificate["partitions"][0]["unlinked_public_cards"]) == 1
    assert certificate["partitions"][0]["unlinked_public_cards"][0]["sold"] is True
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["scoped_inventory_complete"] is True
    assert result.coverage["inventory_scope"] == "addressable_public_catalogue"


def test_agrasc_unknown_unlinked_cards_never_certify_inventory(monkeypatch) -> None:
    _patch_agrasc_client(monkeypatch, _agrasc_html(unknown_unlinked=True))

    result = agrasc.scrape_agrasc_aquitaine_result()

    certificate = result.coverage["certificate"]
    assert certificate["public_discovery_certified"] is False
    assert certificate["addressable_public_inventory_certified"] is False
    assert certificate["partitions"][0]["unlinked_public_cards"][0]["sold"] is False
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["scoped_inventory_complete"] is False


def test_agrasc_mixed_sold_and_unlinked_non_sold_cards_stay_blocked(monkeypatch) -> None:
    html = _agrasc_html().replace(
        '<a class="fr-pagination__link--last" href="/ventes-aux-encheres?page=0">Dernière page</a>',
        '<div class="card-vente-immo"><h3>Archive sans statut</h3></div>'
        '<a class="fr-pagination__link--last" href="/ventes-aux-encheres?page=0">Dernière page</a>',
    )
    _patch_agrasc_client(monkeypatch, html)

    result = agrasc.scrape_agrasc_aquitaine_result()

    partition = result.coverage["certificate"]["partitions"][0]
    assert partition["unlinked_public_card_count"] == 2
    assert sorted(card["sold"] for card in partition["unlinked_public_cards"]) == [False, True]
    assert not result.coverage["certificate"]["addressable_public_inventory_certified"]
    assert not result.coverage["scoped_inventory_complete"]


def test_agrasc_descriptive_sold_text_does_not_certify_unlinked_card(monkeypatch) -> None:
    _patch_agrasc_client(monkeypatch, _agrasc_html().replace(
        '<div class="fr-card__start"><p class="fr-badge fr-badge--error">Vendu</p></div>',
        '',
    ))

    result = agrasc.scrape_agrasc_aquitaine_result()

    certificate = result.coverage["certificate"]
    assert certificate["addressable_public_inventory_certified"] is False
    assert certificate["partitions"][0]["unlinked_public_cards"][0]["sold"] is False


def test_agrasc_uses_published_query_page_zero_when_bare_url_is_incoherent(monkeypatch) -> None:
    bare_url = f"{agrasc.BASE_URL}/ventes-aux-encheres"
    query_url = f"{bare_url}?page=0"
    stale_html = """
    <div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo">
        <h3 class="fr-card__title"><a href="/vente/stale">Ancienne vue</a></h3>
        <p class="fr-card__detail">Agen (47)</p>
      </div>
      <a class="fr-pagination__link--last" href="?page=5">Dernière page</a>
    </div>
    """
    query_html = """
    <div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo">
        <h3 class="fr-card__title"><a href="/vente/query">Vue page zéro</a></h3>
        <p class="fr-card__detail">Agen (47)</p>
      </div>
      <a class="fr-pagination__link--last" href="?page=0">Dernière page</a>
    </div>
    """
    calls: list[str] = []

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def get(self, url: str) -> str:
            calls.append(url)
            return {bare_url: stale_html, query_url: query_html}[url]

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(agrasc, "TARGET_DEPARTMENTS", ("47",))
    monkeypatch.setattr(agrasc, "PoliteHttpClient", Client)
    monkeypatch.setattr(
        agrasc,
        "load_settings",
        lambda: {
            "user_agent": "Mozilla/5.0",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
        },
    )
    monkeypatch.setattr(agrasc, "enrich_agrasc_operator", lambda *args, **kwargs: None)
    monkeypatch.setattr("src.source_checkpoint.restore_detail", lambda sale: False)

    result = agrasc.scrape_agrasc_aquitaine_result(max_pages=1)

    assert agrasc.LIST_URL == query_url
    assert calls == [query_url]
    assert result.sales[0]["source_url"] == "https://agrasc.gouv.fr/vente/query"
    assert result.coverage["certificate"]["partitions"][0]["visited_page_indices"] == [0]


def test_agrasc_pagination_ignores_unrelated_archive_view(monkeypatch) -> None:
    html = """
    <div class="view-other-auctions">
      <div class="card-vente-immo"><h3>Véhicules</h3></div>
      <a class="fr-pagination__link--last" href="?page=4">Dernière page</a>
    </div>
    <div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo">
        <h3 class="fr-card__title"><a href="/vente/house">Maison</a></h3>
        <p class="fr-card__detail">Agen (47)</p>
      </div>
      <a class="fr-pagination__link--last" href="?page=1">Dernière page</a>
    </div>
    """
    _patch_agrasc_client(monkeypatch, html)

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert result.coverage["pages_fetched"] == 2
    assert result.coverage["certificate"]["partitions"][0]["visited_page_indices"] == [0, 1]
    assert result.coverage["linked_pages_complete"] is True


def test_agrasc_seller_catalogue_card_is_excluded_with_public_catalogue_proof(monkeypatch) -> None:
    html = """
    <div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo">
        <h3 class="fr-card__title"><a href="https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo">AGRASC</a></h3>
        <p class="fr-card__detail">Agen (47)</p>
        <p class="fr-card__desc">Ventes immobilières AGRASC.</p>
      </div>
      <a class="fr-pagination__link--last" href="/ventes-aux-encheres?page=0">Dernière page</a>
    </div>
    """
    _patch_agrasc_client(monkeypatch, html)

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert result.sales == []
    certificate = result.coverage["certificate"]
    assert certificate["public_discovery_certified"] is True
    assert certificate["all_discovered_announcements_emitted"] is True
    assert certificate["excluded_urls"] == [{
        "url": "https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo",
        "reason": "operator_seller_catalogue_without_listing_identity",
    }]
    assert result.coverage["inventory_scope"] == "addressable_public_catalogue"


def test_agrasc_seller_url_from_public_proof_is_excluded_when_parser_has_no_card_row(monkeypatch) -> None:
    # The live archive has emitted seller cards with ``data-url`` but without
    # the title/link structure used by parse_agrasc_html.  The independent
    # catalogue proof must still classify that public URL as an explicit,
    # non-listing exclusion.
    html = """
    <div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo" data-url="https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo">
        <h3>AGRASC</h3>
        <p class="fr-card__desc">Ventes immobilières AGRASC.</p>
      </div>
      <a class="fr-pagination__link--last" href="/ventes-aux-encheres?page=0">Dernière page</a>
    </div>
    """
    _patch_agrasc_client(monkeypatch, html)

    result = agrasc.scrape_agrasc_aquitaine_result()

    assert result.sales == []
    certificate = result.coverage["certificate"]
    assert certificate["public_discovery_certified"] is True
    assert certificate["all_discovered_announcements_emitted"] is True
    assert certificate["excluded_urls"] == [{
        "url": "https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo",
        "reason": "operator_seller_catalogue_without_listing_identity",
    }]
    assert certificate["unhandled_public_urls"] == []
    assert result.coverage["scoped_inventory_complete"] is True
