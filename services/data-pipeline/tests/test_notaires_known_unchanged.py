from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

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


# --- Contact : la carte de liste porte le téléphone seul, le détail « téléphone | adresse » (11/11/2026) ---

PHONE = "05 00 00 00 01"
ADDRESS = "office@example.test"
DETAIL_CONTACT = f"{PHONE} | {ADDRESS}"


def _card_with_phone(phone: str = PHONE, **marks: object) -> dict:
    card = notaires.parse_notaires_json(json.dumps({"annonceResumeDto": [{**_row("VNI"), "telephone": phone}]}))[0]
    return {**card, **marks}


def _detail_contact(card: dict) -> str:
    detail = notaires.parse_notaires_detail_json(
        json.dumps(
            {
                "typeTransaction": "VNI",
                "vni": {"descriptionFr": "Appartement à Bordeaux"},
                "contact": {"nom": "Office Exemple", "telephone": PHONE, "mail": ADDRESS},
            }
        ),
        card,
    )
    return detail["lawyer_contact"]


def _hydrated(card: dict, stored_contact: str) -> str:
    from src import main

    known = {card["source_url"]: {"lawyer_contact": stored_contact, "raw_payload": {}}}
    main._hydrate_known_unchanged_sales([card], known)
    return card["lawyer_contact"]


def test_an_unchanged_card_keeps_the_e_mail_address_of_the_stored_detail():
    card = _card_with_phone(_known_unchanged=True)
    assert card["lawyer_contact"] == PHONE  # la carte de liste ne porte que le téléphone
    stored = _detail_contact(card)  # ce que la lecture du détail a écrit
    assert stored == DETAIL_CONTACT

    assert _hydrated(card, stored) == DETAIL_CONTACT


def test_a_phone_changed_on_the_card_replaces_the_stored_one_and_keeps_the_address():
    card = _card_with_phone("05 00 00 00 02", _known_unchanged=True)

    assert _hydrated(card, DETAIL_CONTACT) == f"05 00 00 00 02 | {ADDRESS}"


@pytest.mark.parametrize(
    "stored",
    [
        "05 00 00 00 09",  # aucune adresse connue
        "05 00 00 00 09 | écrire @ l'étude",  # un « @ » n'est pas une adresse
        "05 00 00 00 09 | maitre@avocat-conseil.fr",  # messagerie RPVA, écartée comme partout
    ],
)
def test_the_card_contact_stays_when_the_stored_one_has_no_usable_address(stored: str):
    assert _hydrated(_card_with_phone(_known_unchanged=True), stored) == PHONE


def test_a_card_that_already_carries_an_address_is_left_alone():
    card = _card_with_phone(_known_unchanged=True, lawyer_contact=f"{PHONE} | etude@example.test")

    assert _hydrated(card, DETAIL_CONTACT) == f"{PHONE} | etude@example.test"


def test_a_failed_detail_read_keeps_the_card_contact():
    # Le détail sera relu au passage suivant (il n'est pas frais) : la carte reste telle quelle d'ici là.
    card = _card_with_phone(_detail_fetch_failed=True)

    assert _hydrated(card, DETAIL_CONTACT) == PHONE


def test_the_rule_is_for_notaires_only():
    card = {
        "source_name": "encheres_immobilieres",
        "source_url": "https://www.encheres-immobilieres.example.test/vente/1",
        "lawyer_contact": PHONE,
        "_known_unchanged": True,
    }

    assert _hydrated(card, DETAIL_CONTACT) == PHONE


