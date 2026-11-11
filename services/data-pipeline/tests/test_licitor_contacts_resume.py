"""Licitor : adresses internes après la réactivation du décodage (décision du propriétaire du 11/11/2026).

Fixtures fictives (domaine example.test), aucune requête. Ce que ces tests fixent :

* l'interrupteur : actif par défaut dans la collecte planifiée, explicite dans le code ;
* une vente connue dont le détail n'est plus frais est relue et obtient sa ligne au registre (c'est ce qui
  couvre les ventes connues après la réactivation), une vente fraîche n'est pas relue ;
* une fiche reprise d'un point de reprise n'a pas d'adresse à ce passage (le point de reprise n'en contient
  jamais) et l'obtient à la relecture suivante de son détail ;
* l'adresse ne sort que vers le registre : ni point de reprise, ni ``raw_payload``, ni colonne, ni journal, ni
  motif d'un échec de normalisation.
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
from src.freshness import SOURCE_EXTRACTION_VERSION, record_source_checks
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
    """Base du point de reprise : garde ce qui y est écrit."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    @contextmanager
    def transaction(self):
        yield

    def execute(self, statement: str, params: Any = None) -> SimpleNamespace:
        self.calls.append((statement, params))
        return SimpleNamespace(fetchall=lambda: [])

    def checkpoints(self) -> list[tuple[Any, ...]]:
        return [params for statement, params in self.calls if "insert into public.auction_collection_checkpoints" in statement]


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
        known: dict[str, str] | None = None,
    ) -> tuple[Any, list[str], _CheckpointDb]:
        db = _CheckpointDb()
        fetched: list[str] = []
        monkeypatch.setenv(licitor.DECODE_ENV, "true")
        monkeypatch.delenv(licitor.SOURCE_BUDGET_ENV, raising=False)
        monkeypatch.setattr(source_checkpoint, "_context", lambda: ("postgresql://local", "run-2", details or {}, {}))
        monkeypatch.setattr(source_checkpoint, "_checkpoint_connect", lambda *_: nullcontext(db))
        monkeypatch.setattr("src.collection_evidence.record_items", lambda *args, **kwargs: None)
        monkeypatch.setattr("src.rejected_listings.skip_detail", lambda sale: False)
        monkeypatch.setattr(licitor, "LicitorClient", lambda **kwargs: _Client(fetched))
        monkeypatch.setattr(licitor, "_collect_list_sales", lambda client, max_pages, errors: [_card()])
        monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("75",))
        source_checkpoint._connections.clear()
        try:
            return licitor.scrape_licitor_aquitaine_result(max_pages=1, known=known), fetched, db
        finally:
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


# --- Ventes connues : la fraîcheur du détail borne la relecture -----------------------------------------


def _known_signatures(monkeypatch: pytest.MonkeyPatch, checked_at: datetime) -> dict[str, str]:
    """Signatures remises à la source par le pipeline pour une vente connue, carte inchangée."""
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
    known = _known_signatures(monkeypatch, datetime.now(UTC) - timedelta(hours=25))
    assert known == {}  # au-delà de 24 h, la vente n'est plus remise comme « connue »

    result, fetched, _db = scrape(known=known)

    assert fetched == [URL]
    assert [row["email"] for row in _registry_rows(result.sales)] == [EMAIL]


def test_a_known_sale_read_within_the_freshness_window_is_not_read_twice(
    scrape, monkeypatch: pytest.MonkeyPatch
) -> None:
    known = _known_signatures(monkeypatch, datetime.now(UTC) - timedelta(hours=2))
    assert set(known) == {URL}

    result, fetched, _db = scrape(known=known)

    assert fetched == []
    assert result.sales[0]["_known_unchanged"] is True


# --- Point de reprise : comportement assumé -------------------------------------------------------------


def test_a_detail_restored_from_a_checkpoint_has_no_address_until_its_detail_is_read_again(
    scrape, monkeypatch: pytest.MonkeyPatch
) -> None:
    details = _interrupted_run(scrape)
    read_at = details[URL][1]["_checkpoint_checked_at"]

    # Passage de reprise : la fiche n'est pas relue, et le point de reprise ne porte aucune adresse.
    result, fetched, _db = scrape(details=details)
    (restored,) = result.sales
    assert fetched == [] and restored["_checkpoint_restored"] is True
    assert INTERNAL_CONTACTS_KEY not in restored
    assert _registry_rows(result.sales) == []
    # La reprise ne rajeunit pas la fiche : sa preuve de lecture garde l'heure de la lecture d'origine.
    record_source_checks([restored], {})
    assert restored["source_checks"][URL]["checked_at"] == read_at

    # 24 heures après la lecture d'origine, le détail n'est plus frais : relu, il écrit sa ligne au registre.
    known = _known_signatures(monkeypatch, datetime.fromisoformat(read_at) - timedelta(hours=24))
    assert known == {}
    result, fetched, _db = scrape(known=known)
    assert fetched == [URL]
    assert [row["email"] for row in _registry_rows(result.sales)] == [EMAIL]


# --- Vie privée -----------------------------------------------------------------------------------------


def test_the_address_only_leaves_towards_the_registry(scrape, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        result, fetched, db = scrape()
        (raw,) = result.sales
        sale = normalize_sale(raw)
        rows = _registry_rows(result.sales)

    assert fetched == [URL] and [row["email"] for row in rows] == [EMAIL]
    published = sale.model_dump(mode="json")
    assert INTERNAL_CONTACTS_KEY not in published
    assert EMAIL not in json.dumps(published, ensure_ascii=False, default=str)
    assert EMAIL not in json.dumps(sale.raw_payload, ensure_ascii=False, default=str)
    assert all(EMAIL not in str(published.get(column)) for column in UPSERT_COLUMNS)
    assert INTERNAL_CONTACTS_KEY not in UPSERT_COLUMNS
    (_run_id, _url, _signature, payload, _observed), = db.checkpoints()
    assert INTERNAL_CONTACTS_KEY not in payload.obj and EMAIL not in json.dumps(payload.obj)
    assert EMAIL not in caplog.text


def _raw_that_fails_normalization(scrape) -> dict[str, Any]:
    result, _fetched, _db = scrape()
    raw = {**result.sales[0], "observations": [1]}  # refusé par le modèle : la normalisation échoue
    assert raw[INTERNAL_CONTACTS_KEY][0]["email"] == EMAIL
    with pytest.raises(Exception):  # noqa: B017, PT011 - l'échec lui-même, quel qu'en soit le type
        normalize_sale(raw)
    return raw


def test_a_failed_normalization_never_cites_the_address_in_the_log_nor_in_the_item_reason(
    scrape, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    raw = _raw_that_fails_normalization(scrape)
    recorded: list[dict[str, Any]] = []
    monkeypatch.setattr(main, "record_items", lambda run_id, raws, **kwargs: recorded.append(kwargs))
    monkeypatch.setattr(main, "record_sale_decisions", lambda *args, **kwargs: None)
    run = main._PipelineRun(options=main.PipelineOptions(source="licitor"), settings={}, run_id="run-1")
    run.raw_sales = [raw]

    with caplog.at_level(logging.DEBUG):
        main._normalize_and_deduplicate(run)

    assert run.normalized_observations == []
    (failure,) = [item for item in recorded if item.get("decision") == "normalization_failed"]
    assert failure["reason"] and EMAIL not in failure["reason"]  # auction_collection_items.reason
    assert run.errors["licitor"] and EMAIL not in json.dumps(run.errors)
    assert "Initial normalization failed" in caplog.text and EMAIL not in caplog.text


def test_a_failed_normalization_in_a_progressive_batch_never_cites_the_address(
    scrape, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    raw = _raw_that_fails_normalization(scrape)
    recorded: list[dict[str, Any]] = []
    monkeypatch.setattr(main, "record_items", lambda run_id, raws, **kwargs: recorded.append(kwargs))
    monkeypatch.setattr(main, "record_sale_decisions", lambda *args, **kwargs: None)
    errors: dict[str, list[str]] = {}

    with caplog.at_level(logging.DEBUG):
        main.publish_factual_batch("run-1", [raw], {}, errors)

    (failure,) = [item for item in recorded if item.get("decision") == "normalization_failed"]
    assert failure["reason"] and EMAIL not in failure["reason"]
    assert EMAIL not in json.dumps(errors) and EMAIL not in caplog.text
