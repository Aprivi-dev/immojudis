from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

from src.freshness import SOURCE_EXTRACTION_VERSION, detail_is_fresh
from src.sources import notaires
from src.sources.common import listing_signature
from src.sources.notaires_extraction import card_sale_long_past


def _row(transaction_type: str, price: int = 100000, **dates: str) -> dict:
    return {
        **dates,
        "annonceId": f"{transaction_type}-1",
        "typeTransaction": transaction_type,
        "urlDetailAnnonceFr": f"{notaires.BASE_URL}/fr/annonce-immo/{transaction_type.lower()}-1",
        "inseeDepartement": "33",
        "communeNom": "Bordeaux",
        "codePostal": "33000",
        "typeBien": "APP",
        "descriptionFr": "Appartement à Bordeaux",
        "prixAffiche": price,
        # Relative au jour d'exécution : une séance datée en dur finit par être passée (carte « longtemps passée »).
        "seanceDate": (datetime.now(UTC) + timedelta(days=60)).date().isoformat(),
    }


def _scrape(monkeypatch, known: dict[str, str], vni_price: int = 100000, **dates: str):
    fetched: list[str] = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            transaction_type = parse_qs(urlparse(url).query)["typeTransactions"][0]
            price = vni_price if transaction_type == "VNI" else 100000
            return json.dumps(
                {"nbTotalAnnonces": 1, "nbPages": 1, "annonceResumeDto": [_row(transaction_type, price, **dates)]}
            )

    def detail(client, sale, errors):
        fetched.append(sale["source_url"])
        return True

    monkeypatch.setattr(notaires, "PoliteHttpClient", Client)
    monkeypatch.setattr(notaires, "TARGET_DEPARTMENTS", ("33",))
    monkeypatch.setattr(notaires, "_department_filters", lambda: ("33",))
    monkeypatch.setattr(notaires, "_enrich_sale_from_detail", detail)
    monkeypatch.setattr(
        notaires,
        "load_settings",
        lambda: {
            "user_agent": "immojudis-test",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
            "notaires_max_pages": 1,
        },
    )
    return notaires.scrape_notaires_aquitaine_result(max_pages=1, known=known), fetched


def _known_vni() -> dict[str, str]:
    card = notaires.parse_notaires_json(json.dumps({"annonceResumeDto": [_row("VNI")]}))[0]
    signature = listing_signature(card)
    assert signature
    return {card["source_url"]: signature}


def test_unchanged_card_keeps_the_stored_detail_without_a_request(monkeypatch):
    known = _known_vni()
    result, fetched = _scrape(monkeypatch, known)

    vni_url = next(iter(known))
    assert vni_url not in fetched
    assert len(fetched) == 1  # the VAE listing is not known: its detail is read
    unchanged = next(sale for sale in result.sales if sale["source_url"] == vni_url)
    assert unchanged["_known_unchanged"] is True
    assert result.coverage["coverage_complete"] is True


def test_a_changed_price_on_the_card_reads_the_detail_again(monkeypatch):
    known = _known_vni()
    _result, fetched = _scrape(monkeypatch, known, vni_price=90000)

    assert next(iter(known)) in fetched


def _row_checked(source_name: str, checked_at: datetime, sale_date: datetime) -> dict:
    return {
        "source_name": source_name,
        "sale_date": sale_date.isoformat(),
        "raw_payload": {
            "source_checks": {
                "u": {
                    "checked_at": checked_at.isoformat(),
                    "source_name": source_name,
                    "extractor_version": SOURCE_EXTRACTION_VERSION,
                }
            }
        },
    }


def test_notaires_details_stay_fresh_three_days_except_near_the_sale():
    now = datetime.now(UTC)
    far = now + timedelta(days=30)
    assert detail_is_fresh(_row_checked("notaires", now - timedelta(hours=48), far), "u")
    assert not detail_is_fresh(_row_checked("notaires", now - timedelta(hours=80), far), "u")
    assert not detail_is_fresh(_row_checked("vench", now - timedelta(hours=48), far), "u")
    # Within a week of the sale every source keeps the six-hour window.
    assert not detail_is_fresh(_row_checked("notaires", now - timedelta(hours=8), now + timedelta(days=3)), "u")


def test_closed_sales_are_kept_in_the_inventory_without_reading_their_detail(monkeypatch):
    closed = {
        "seanceDate": "2026-01-15",
        "dateDebutEncheres": "2026-01-10T10:00:00",
        "dateFinEncheres": "2026-01-15T16:00:00",
    }
    result, fetched = _scrape(monkeypatch, {}, **closed)

    assert fetched == []
    assert {sale["source_detail_status"] for sale in result.sales} == {"skipped_closed_sale"}
    assert len(result.sales) == 2
    assert result.coverage["coverage_complete"] is True


def test_closed_card_rule_needs_a_proven_end():
    now = datetime(2026, 10, 11, 12, tzinfo=UTC)
    assert card_sale_long_past({"sale_date": "2026-10-07"}, now)
    assert not card_sale_long_past({"sale_date": "2026-10-09"}, now)
    assert not card_sale_long_past({"sale_date": None}, now)
    assert not card_sale_long_past(
        {"source_sale_schedule": {"opens_at": "2026-09-01T10:00:00+00:00", "closes_at": None}}, now
    )
    assert card_sale_long_past({"source_sale_schedule": {"closes_at": "2026-10-01T16:00:00+00:00"}}, now)
