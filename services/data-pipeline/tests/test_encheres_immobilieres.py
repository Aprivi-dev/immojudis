from __future__ import annotations

import json

from src.admission import quarantine_reason
from src.normalize import normalize_sale
from src.sources import encheres_immobilieres as source


def _listing_html(*, external_id: int, total: int, last_page: int | None = None, title: str = "CARD") -> str:
    item = {
        "id": external_id,
        "titre": f"{title} à BORDEAUX (33)",
        "prix": 90_000,
        "adresse": "1 rue de la Vente",
        "codePostal": "33000",
        "departement": "33",
        "ville": "BORDEAUX",
        "description": "Description de la carte",
        "url": f"{external_id}-maison-bordeaux-33",
        "dateVente": "$D2026-10-01T09:00:00.000Z",
        "lots": [],
    }
    escaped = json.dumps(item, ensure_ascii=False).replace('"', '\\"')
    last = (
        f'<a rel="last" href="{source.LIST_URL}?page={last_page}">Dernière page</a>'
        if last_page is not None
        else ""
    )
    return f'<p>{total} biens en vente</p>{last}<script>self.__next_f.push([1,"{escaped}"])</script>'


def _detail_html(external_id: int, *, title: str = "DETAIL") -> str:
    return f"""
    <article>
      <h1>{title} à BORDEAUX (33)</h1>
      <p>Annonce n° {external_id}</p>
      <p>Adresse du bien</p><p>2 rue du Detail, 33000 BORDEAUX</p>
      <p>MISE À PRIX</p><p>80 000 €</p>
      <h2>Descriptif du bien</h2>
      <p>Description du détail</p>
    </article>
    """


def _settings() -> dict[str, object]:
    return {
        "user_agent": "immojudis-test",
        "request_delay_seconds": 0,
        "request_timeout_seconds": 1,
        "encheres_immobilieres_max_pages": 2,
    }


def test_detail_identity_mismatch_keeps_listing_and_quarantines_sale() -> None:
    source_url = f"{source.BASE_URL}/ventes/9486-maison-bordeaux-33"
    sale = {
        "source_name": "encheres_immobilieres",
        "source_url": source_url,
        "external_id": "9486",
        "title": "CARD TITLE",
        "description": "Description de la carte",
        "raw_text": "Texte de la carte",
        "source_blocks": {"titre": "CARD TITLE"},
    }
    errors: list[str] = []
    detail_failures: list[dict[str, object]] = []

    class Client:
        def get(self, url: str) -> str:
            assert url == source_url
            return _detail_html(9490)

    source._enrich_sale_from_detail(Client(), sale, errors, detail_failures)

    assert errors == []
    assert sale["external_id"] == "9486"
    assert sale["title"] == "CARD TITLE"
    assert sale["description"] == "Description de la carte"
    assert sale["source_blocks"] == {"titre": "CARD TITLE"}
    assert sale["_detail_fetch_failed"] is True
    assert sale["source_detail_status"] == "failed"
    assert sale["source_detail_failure_reason"] == "identity_mismatch"
    assert sale["quality_flags"] == ["source_identity_mismatch"]
    assert detail_failures == [
        {
            "kind": "identity_mismatch",
            "source_url": source_url,
            "listing_external_id": "9486",
            "detail_external_id": "9490",
        }
    ]

    normalized = normalize_sale(sale)
    assert "source_identity_mismatch" in normalized.quality_flags
    assert quarantine_reason(normalized) == "source_identity_mismatch"


def test_identity_mismatch_is_item_failure_without_failing_inventory(monkeypatch) -> None:
    listing_html = _listing_html(external_id=9486, total=1)

    class Client:
        def __init__(self, **kwargs) -> None:
            self.calls: list[str] = []

        def get(self, url: str) -> str:
            self.calls.append(url)
            return listing_html if url == source.LIST_URL else _detail_html(9490, title="DETAIL TITLE")

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(source, "PoliteHttpClient", Client)
    monkeypatch.setattr(source, "load_settings", _settings)
    monkeypatch.setattr(source, "TARGET_DEPARTMENTS", ("33",))

    result = source.scrape_encheres_immobilieres_aquitaine_result(max_pages=2)

    assert result.errors == []
    assert result.coverage["coverage_complete"] is True
    assert result.coverage["advertised_total"] == 1
    assert result.coverage["detail_identity_mismatches"] == 1
    assert result.coverage["detail_failures"][0]["listing_external_id"] == "9486"
    assert result.sales[0]["title"] == "CARD à BORDEAUX (33)"
    assert result.sales[0]["source_detail_status"] == "failed"
    assert result.sales[0]["source_identity_mismatch"]["detail_external_id"] == "9490"


def test_empty_page_never_becomes_terminal_proof(monkeypatch) -> None:
    first_page = _listing_html(external_id=9486, total=2)
    empty_last_page = f'<p>2 biens en vente</p><a rel="last" href="{source.LIST_URL}?page=2">Dernière page</a>'

    class Client:
        def __init__(self, **kwargs) -> None:
            self.calls: list[str] = []

        def get(self, url: str) -> str:
            self.calls.append(url)
            return first_page if url == source.LIST_URL else empty_last_page

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(source, "PoliteHttpClient", Client)
    monkeypatch.setattr(source, "load_settings", _settings)
    monkeypatch.setattr(source, "TARGET_DEPARTMENTS", ("33",))
    monkeypatch.setattr(source, "_enrich_sale_from_detail", lambda *args, **kwargs: None)

    result = source.scrape_encheres_immobilieres_aquitaine_result(max_pages=2)

    assert len(result.sales) == 1
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["stop_reason"] == "empty_page_unverified"
