"""Licitor : adresses internes après la réactivation du décodage (décision du propriétaire du 11/11/2026).

Fixtures fictives (domaine example.test), aucune requête. Trois garanties :

* une fiche reprise d'un point de reprise, dont l'adresse n'est ni dans le point de reprise ni au registre, est
  relue au lieu d'être tenue pour fraîche ;
* une vente connue dont le détail n'est plus frais est relue (c'est ce qui couvre les ventes connues après la
  réactivation), une vente fraîche ne l'est pas ;
* l'adresse ne sort que vers le registre : ni point de reprise, ni ``raw_payload``, ni colonne, ni journal.
"""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager, nullcontext
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from src import main, source_checkpoint
from src.freshness import SOURCE_EXTRACTION_VERSION
from src.models import INTERNAL_CONTACTS_KEY
from src.normalize import normalize_sale
from src.sources import common, licitor
from src.storage import internal_contacts as registry
from src.storage.column_sets import UPSERT_COLUMNS
from tests.test_licitor_cloudflare_email import cloudflare_encode
from tests.test_licitor_extraction import DETAIL_HTML, URL

EMAIL = "maitre@example.test"
SALE_ID = "11111111-1111-4111-8111-111111111111"
NOW = "2026-11-11T10:00:00+00:00"
MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
          "novembre", "décembre")
REPOSITORY = Path(__file__).resolve().parents[3]


def _french_day(offset: int = 30) -> str:
    day = date.today() + timedelta(days=offset)
    return f"{day.day} {MONTHS[day.month - 1]} {day.year}"


def _detail_html() -> str:
    """La fiche de référence, audience à venir, avec une adresse masquée dans le bloc de l'avocat."""
    encoded = cloudflare_encode(EMAIL)
    html = DETAIL_HTML.replace('data-cfemail="00"', f'data-cfemail="{encoded}"').replace(
        "email-protection#00", f"email-protection#{encoded}"
    )
    assert "jeudi 5 novembre 2026 à 14h" in html and encoded in html
    return html.replace("jeudi 5 novembre 2026 à 14h", f"{_french_day()} à 14h")


def _card() -> dict[str, Any]:
    return {
        "source_name": "licitor",
        "source_url": URL,
        "department": "75",
        "city": "Paris 16ème",
        "title": "Un appartement",
        "starting_price_eur": "300 000 €",
        "sale_date": _french_day(),
        "source_lots": [{"raw_text": "Un appartement", "title": "Un appartement"}],
    }


class _Client:
    def __init__(self, fetched: list[str]) -> None:
        self.fetched = fetched

    def get(self, url: str) -> str:
        self.fetched.append(url)
        return _detail_html()


class _CheckpointDb:
    """Base du point de reprise : garde les écritures, répond à la lecture du registre."""

    def __init__(self, registered: list[str] | None = None, *, registry_error: Exception | None = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.registered = registered or []
        self.registry_error = registry_error

    @contextmanager
    def transaction(self):
        yield

    def execute(self, statement: str, params: Any = None) -> SimpleNamespace:
        self.calls.append((statement, params))
        if "information_agent_contacts" in statement:
            if self.registry_error is not None:
                raise self.registry_error
            return SimpleNamespace(fetchall=lambda: [(url,) for url in self.registered if url in params[0]])
        return SimpleNamespace(fetchall=lambda: [])

    def checkpoints(self) -> list[tuple[Any, ...]]:
        return [params for statement, params in self.calls if "insert into public.auction_collection_checkpoints" in statement]

    def registry_reads(self) -> list[tuple[str, Any]]:
        return [call for call in self.calls if "information_agent_contacts" in call[0]]


class _PublicationConnection:
    def __init__(self) -> None:
        self.inserts: list[dict[str, Any]] = []

    @contextmanager
    def transaction(self):
        yield

    def execute(self, statement: Any, params: Any = None) -> SimpleNamespace:
        if "from public.auction_sales" in str(statement):
            return SimpleNamespace(fetchall=lambda: [(SALE_ID, URL)])
        if "insert into public.information_agent_contacts" in str(statement):
            self.inserts.append(params)
        return SimpleNamespace(fetchall=lambda: [])


@pytest.fixture
def scrape(monkeypatch: pytest.MonkeyPatch):
    """Un passage Licitor sur une liste d'une fiche ; ``details`` = points de reprise d'un run précédent en échec."""

    def run(
        *,
        details: dict[str, tuple[str, Any, datetime]] | None = None,
        db: _CheckpointDb | None = None,
        known: dict[str, str] | None = None,
        decode: str | None = "true",
    ) -> tuple[Any, list[str], _CheckpointDb]:
        db = db or _CheckpointDb()
        fetched: list[str] = []
        if decode is None:
            monkeypatch.delenv(licitor.DECODE_ENV, raising=False)
        else:
            monkeypatch.setenv(licitor.DECODE_ENV, decode)
        monkeypatch.delenv(licitor.SOURCE_BUDGET_ENV, raising=False)
        monkeypatch.setattr(source_checkpoint, "_context", lambda: ("postgresql://local", "run-2", details or {}, {}))
        monkeypatch.setattr(source_checkpoint, "_checkpoint_connect", lambda *_: nullcontext(db))
        monkeypatch.setattr("src.collection_evidence.record_items", lambda *args, **kwargs: None)
        monkeypatch.setattr("src.rejected_listings.skip_detail", lambda sale: False)
        monkeypatch.setattr(licitor, "LicitorClient", lambda **kwargs: _Client(fetched))
        monkeypatch.setattr(licitor, "_collect_list_sales", lambda client, max_pages, errors: [_card()])
        monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("75",))
        source_checkpoint._registered_contact_urls.cache_clear()
        source_checkpoint._connections.clear()
        try:
            return licitor.scrape_licitor_aquitaine_result(max_pages=1, known=known), fetched, db
        finally:
            source_checkpoint._registered_contact_urls.cache_clear()
            source_checkpoint._connections.clear()

    return run


def _interrupted_run(scrape) -> dict[str, tuple[str, Any, datetime]]:
    """Point de reprise laissé par un run qui a lu la fiche puis s'est arrêté avant de la publier."""
    result, fetched, db = scrape()
    assert fetched == [URL] and result.sales[0][INTERNAL_CONTACTS_KEY][0]["email"] == EMAIL
    (_run_id, source_url, signature, payload, observed), = db.checkpoints()
    return {source_url: (signature, payload.obj, observed)}


def _registry_rows(raw_sales: list[dict[str, Any]]) -> list[dict[str, Any]]:
    connection = _PublicationConnection()
    registry.write_internal_contacts_connection(connection, [normalize_sale(raw) for raw in raw_sales], NOW)
    return connection.inserts


# --- Interrupteur ---------------------------------------------------------------------------------------


def test_the_scheduled_workflow_decodes_unless_the_repository_variable_says_otherwise() -> None:
    workflow = (REPOSITORY / ".github/workflows/data-pipeline.yml").read_text(encoding="utf-8")

    # Variable de dépôt absente : actif. Une variable posée (« false » compris, chaîne non vide) garde la main.
    assert "LICITOR_DECODE_PROTECTED_EMAILS: ${{ vars.LICITOR_DECODE_PROTECTED_EMAILS || 'true' }}" in workflow
    assert workflow.count("LICITOR_DECODE_PROTECTED_EMAILS:") == 1


def test_the_switch_itself_stays_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(licitor.DECODE_ENV, raising=False)
    assert licitor.decode_protected_emails_enabled() is False
    monkeypatch.setenv(licitor.DECODE_ENV, "false")
    assert licitor.decode_protected_emails_enabled() is False
    monkeypatch.setenv(licitor.DECODE_ENV, "true")
    assert licitor.decode_protected_emails_enabled() is True


# --- Point de reprise -----------------------------------------------------------------------------------


def test_the_checkpoint_records_that_an_address_was_held_back_never_the_address(scrape) -> None:
    details = _interrupted_run(scrape)

    payload = details[URL][1]
    assert payload[source_checkpoint.CONTACTS_WITHHELD_KEY] is True
    assert INTERNAL_CONTACTS_KEY not in payload and EMAIL not in json.dumps(payload)


def test_a_restored_detail_without_a_registry_row_is_read_again_and_its_publication_writes_the_row(scrape) -> None:
    details = _interrupted_run(scrape)

    result, fetched, db = scrape(details=details)

    assert fetched == [URL]  # relue : le point de reprise n'a pas l'adresse, le registre non plus
    (sale,) = result.sales
    assert not sale.get("_checkpoint_restored")
    (row,) = _registry_rows(result.sales)
    assert row["email"] == EMAIL and row["sale_id"] == SALE_ID and row["source_url"] == URL
    # La lecture du registre ne demande que la page de la fiche, jamais une adresse.
    (statement, params), = db.registry_reads()
    assert "select distinct source_url" in statement and params == ([URL],)
    # La fiche relue laisse son propre point de reprise, toujours sans adresse.
    assert EMAIL not in json.dumps(db.checkpoints()[0][3].obj)


def test_a_restored_detail_with_a_registry_row_is_not_read_again(scrape) -> None:
    details = _interrupted_run(scrape)

    result, fetched, _db = scrape(details=details, db=_CheckpointDb(registered=[URL]))

    assert fetched == []
    (sale,) = result.sales
    assert sale["_checkpoint_restored"] is True
    assert source_checkpoint.CONTACTS_WITHHELD_KEY not in sale


@pytest.mark.parametrize("decode", [None, "false"])
def test_a_restored_detail_is_kept_as_is_while_decoding_is_off(scrape, decode: str | None) -> None:
    details = _interrupted_run(scrape)

    result, fetched, db = scrape(details=details, decode=decode)

    assert fetched == [] and result.sales[0]["_checkpoint_restored"] is True
    assert db.registry_reads() == []
    assert _registry_rows(result.sales) == []


def test_a_restored_detail_that_never_had_an_address_is_not_read_again(scrape) -> None:
    signature, payload, observed = _interrupted_run(scrape)[URL]
    without_address = {key: value for key, value in payload.items() if key != source_checkpoint.CONTACTS_WITHHELD_KEY}

    result, fetched, db = scrape(details={URL: (signature, without_address, observed)})

    assert fetched == [] and result.sales[0]["_checkpoint_restored"] is True
    assert db.registry_reads() == []


def test_an_unreadable_registry_keeps_the_checkpoint_and_says_so_without_any_address(
    scrape, caplog: pytest.LogCaptureFixture
) -> None:
    details = _interrupted_run(scrape)

    with caplog.at_level(logging.DEBUG):
        result, fetched, _db = scrape(
            details=details, db=_CheckpointDb(registry_error=RuntimeError(f"boom {EMAIL}"))
        )

    assert fetched == [] and result.sales[0]["_checkpoint_restored"] is True
    assert "registry unreadable" in caplog.text and "RuntimeError" in caplog.text
    assert EMAIL not in caplog.text


# --- Ventes connues : la fraîcheur du détail borne déjà la relecture -------------------------------------


def _known_signatures(monkeypatch: pytest.MonkeyPatch, checked_hours_ago: float) -> dict[str, str]:
    """Signatures remises à la source par le pipeline pour une vente connue, carte inchangée."""
    checked_at = datetime.now(UTC) - timedelta(hours=checked_hours_ago)
    row = {
        "source_name": "licitor",
        "sale_date": (datetime.now(UTC) + timedelta(days=30)).isoformat(),
        "_signature": common.listing_signature(_card()),
        "raw_payload": {
            "source_checks": {
                URL: {
                    "checked_at": checked_at.isoformat(),
                    "source_name": "licitor",
                    "extractor_version": SOURCE_EXTRACTION_VERSION,
                }
            }
        },
    }
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {URL: row})
    run = main._PipelineRun(
        options=main.PipelineOptions(source="licitor"), settings={"incremental_enrichment": True}, run_id=None
    )
    assert main._load_known_sale_details(run) is True
    return run.known_signatures


def test_a_known_sale_whose_detail_is_no_longer_fresh_is_read_again_and_gets_its_registry_row(
    scrape, monkeypatch: pytest.MonkeyPatch
) -> None:
    known = _known_signatures(monkeypatch, checked_hours_ago=25)
    assert known == {}  # au-delà de 24 h, la vente n'est plus remise comme « connue »

    result, fetched, _db = scrape(known=known)

    assert fetched == [URL]
    assert [row["email"] for row in _registry_rows(result.sales)] == [EMAIL]


def test_a_known_sale_read_within_the_freshness_window_is_not_read_twice(
    scrape, monkeypatch: pytest.MonkeyPatch
) -> None:
    known = _known_signatures(monkeypatch, checked_hours_ago=2)
    assert set(known) == {URL}

    result, fetched, _db = scrape(known=known)

    assert fetched == []
    assert result.sales[0]["_known_unchanged"] is True


# --- Vie privée -----------------------------------------------------------------------------------------


def test_the_address_only_leaves_towards_the_registry(scrape, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        details = _interrupted_run(scrape)
        result, _fetched, db = scrape(details=details)
        (raw,) = result.sales
        sale = normalize_sale(raw)
        rows = _registry_rows(result.sales)

    assert [row["email"] for row in rows] == [EMAIL]
    published = sale.model_dump(mode="json")
    assert INTERNAL_CONTACTS_KEY not in published
    assert EMAIL not in json.dumps(published, ensure_ascii=False, default=str)
    assert EMAIL not in json.dumps(sale.raw_payload, ensure_ascii=False, default=str)
    assert all(EMAIL not in str(published.get(column)) for column in UPSERT_COLUMNS)
    assert INTERNAL_CONTACTS_KEY not in UPSERT_COLUMNS
    for _run_id, _url, _signature, payload, _observed in db.checkpoints():
        assert EMAIL not in json.dumps(payload.obj)
    assert EMAIL not in caplog.text
