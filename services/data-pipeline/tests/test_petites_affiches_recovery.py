from __future__ import annotations

from contextlib import nullcontext
from datetime import UTC, datetime, timedelta

from src import source_checkpoint
from src.autonomous_runner import finish_source
from src.sources import petites_affiches

CARD = """
<div class="annonce_lot_1 col-md-6">
  <div class="imgList"><a href="/vente/1.html"><img src="/image.jpg" /></a></div>
  <div class="titreVente"><a href="/vente/1.html">Appartement à Bordeaux</a></div>
  <div class="miseAPrix"><strong>80 000</strong> €</div>
  <div class="dateVente"><strong>24/06/2099</strong></div>
  <div>100 m²</div>
</div>
"""
PAGE_1 = CARD + '<a href="/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html">Page suivante</a>'
PAGE_2 = CARD.replace("/vente/1.html", "/vente/2.html").replace("annonce_lot_1", "annonce_lot_2")


def _settings() -> dict[str, object]:
    return {
        "browser_user_agent": "test",
        "request_delay_seconds": 0,
        "request_timeout_seconds": 1,
    }


class _Client:
    def __init__(self, *args, **kwargs) -> None:
        self.calls: list[str] = []

    def post_form(self, url: str, data: dict[str, str]) -> str:
        self.calls.append(url)
        return PAGE_1 if url.endswith("/encheres-immobilieres/") else PAGE_2

    def coverage_metrics(self) -> dict[str, object]:
        return {}


def _patch_source(monkeypatch, *, departments=("33",)) -> None:
    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", departments)
    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", _Client)
    monkeypatch.setattr(petites_affiches, "load_settings", _settings)
    monkeypatch.setattr(petites_affiches, "_enrich_sale_from_detail", lambda *args, **kwargs: None)
    monkeypatch.setattr(petites_affiches.source_checkpoint, "load_source_cursor", lambda partition: None)


def test_budget_stop_flushes_a_partial_partition_cursor_without_certifying_inventory(monkeypatch) -> None:
    _patch_source(monkeypatch, departments=("33", "75"))
    saved: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        petites_affiches.source_checkpoint,
        "save_source_cursor",
        lambda partition, payload: saved.append((partition, payload)) or True,
    )
    remaining = iter((False, False, True))
    monkeypatch.setattr(petites_affiches, "_source_budget_deadline", lambda: 1.0)
    monkeypatch.setattr(petites_affiches, "_source_budget_expired", lambda deadline: next(remaining))

    result = petites_affiches.scrape_petites_affiches_aquitaine_result()

    assert len(result.sales) == 1
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["budget_exhausted"] is True
    assert result.coverage["stop_reason"] == "source_budget_exhausted"
    assert result.coverage["certificate"]["public_discovery_certified"] is False
    cursor = next(payload for partition, payload in saved if partition == "department:33")
    assert cursor["scan_complete"] is False
    assert cursor["pending_pages"] == [
        "https://www.petitesaffiches.fr/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html"
    ]
    assert any(item["partition"] == "department:75" and not item["linked_pages_complete"]
               for item in result.coverage["partitions"])


def test_resumed_page_after_nine_hours_keeps_snapshot_evidence_but_requires_fresh_scan(monkeypatch) -> None:
    _patch_source(monkeypatch)
    cursor = {
        "schema_version": "petites_affiches_cursor_v1",
        "scan_complete": False,
        "seen_pages": [petites_affiches.LIST_URL],
        "pending_pages": [petites_affiches.LIST_URL.replace("/encheres-immobilieres/", "/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html")],
        "pages_fetched": 1,
        "inventory_pages": [{
            "partition": "department:33",
            "page_index": 1,
            "public_urls": ["https://www.petitesaffiches.fr/vente/old.html"],
            "outside_scope_urls": [],
            "advertised_totals": [],
            "advertised_last_pages": [2],
            "unlinked_cards": 0,
            "card_nodes": 1,
            "public_record_ids": [],
            "unlinked_records": [],
        }],
        "parsed_urls": {"department:33": ["https://www.petitesaffiches.fr/vente/old.html"]},
    }
    monkeypatch.setattr(petites_affiches.source_checkpoint, "load_source_cursor", lambda partition: cursor)
    monkeypatch.setattr(petites_affiches.source_checkpoint, "save_source_cursor", lambda *args: True)
    monkeypatch.setattr(petites_affiches, "_source_budget_deadline", lambda: None)
    monkeypatch.setattr(petites_affiches, "_source_budget_expired", lambda deadline: False)

    result = petites_affiches.scrape_petites_affiches_aquitaine_result()

    assert result.coverage["cursor_resumed_partitions"] == ["department:33"]
    assert result.coverage["cursor_revalidated"] is False
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["stop_reason"] == "resumed_snapshot_requires_revalidation"
    assert result.coverage["certificate"]["public_discovery_certified"] is False
    assert result.coverage["partitions"][0]["pages_fetched"] == 2


def test_failed_page_cursor_resumes_once_without_losing_page_counter(monkeypatch) -> None:
    _patch_source(monkeypatch)
    saved: list[dict] = []

    class FailingClient(_Client):
        def post_form(self, url: str, data: dict[str, str]) -> str:
            if not url.endswith("/encheres-immobilieres/"):
                raise RuntimeError("page 2 unavailable")
            return PAGE_1

    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", FailingClient)
    monkeypatch.setattr(
        petites_affiches.source_checkpoint,
        "save_source_cursor",
        lambda partition, payload: saved.append(payload) or True,
    )
    monkeypatch.setattr(petites_affiches, "_source_budget_deadline", lambda: None)
    monkeypatch.setattr(petites_affiches, "_source_budget_expired", lambda deadline: False)

    first = petites_affiches.scrape_petites_affiches_aquitaine_result()
    assert first.coverage["partitions"][0]["pages_fetched"] == 1
    assert saved[-1]["pages_fetched"] == 1
    assert saved[-1]["pending_pages"] == [
        "https://www.petitesaffiches.fr/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html"
    ]

    monkeypatch.setattr(petites_affiches.source_checkpoint, "load_source_cursor", lambda partition: saved[-1])
    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", _Client)
    resumed = petites_affiches.scrape_petites_affiches_aquitaine_result()

    assert resumed.coverage["cursor_resumed_partitions"] == ["department:33"]
    assert resumed.coverage["partitions"][0]["pages_fetched"] == 2
    assert resumed.coverage["partitions"][0]["linked_pages_complete"] is True


def test_restored_detail_uses_original_check_time_after_nine_hours(monkeypatch) -> None:
    listing = {
        "source_name": "petites_affiches",
        "source_url": "https://www.petitesaffiches.fr/vente/1.html",
        "starting_price_eur": "80000",
    }
    signature = source_checkpoint.hashlib.sha256(
        source_checkpoint.json.dumps(listing, sort_keys=True, default=str).encode()
    ).hexdigest()
    checked_at = datetime.now(UTC) - timedelta(hours=9)
    retained_at = datetime.now(UTC)
    payload = {**listing, "raw_text": "detail", "_checkpoint_checked_at": checked_at.isoformat()}
    monkeypatch.setattr(
        source_checkpoint,
        "_context",
        lambda: ("db", "run", {listing["source_url"]: (signature, payload, retained_at)}, {}),
    )

    restored = dict(listing)
    assert source_checkpoint.restore_detail(restored) is True
    assert restored["raw_text"] == "detail"
    assert restored["_checkpoint_checked_at"] == checked_at.isoformat()


def test_checkpoint_with_old_source_check_is_not_reused_even_if_retained(monkeypatch) -> None:
    listing = {
        "source_name": "petites_affiches",
        "source_url": "https://www.petitesaffiches.fr/vente/stale.html",
        "starting_price_eur": "80000",
    }
    signature = source_checkpoint.hashlib.sha256(
        source_checkpoint.json.dumps(listing, sort_keys=True, default=str).encode()
    ).hexdigest()
    stale = datetime.now(UTC) - timedelta(hours=25)
    payload = {**listing, "raw_text": "too old", "_checkpoint_checked_at": stale.isoformat()}
    monkeypatch.setattr(
        source_checkpoint,
        "_context",
        lambda: ("db", "run", {listing["source_url"]: (signature, payload, datetime.now(UTC))}, {}),
    )

    assert source_checkpoint.restore_detail(dict(listing)) is False


class _FinishDB:
    def __init__(self) -> None:
        self.state_update = None
        self.run_summary = None

    def execute(self, sql: str, params=None):
        if "select source,status,summary,errors,started_at" in sql:
            return _Result(("agrasc", "succeeded", {
                "scrape_coverage": {"agrasc": {
                    "coverage_complete": False,
                    "listings_emitted": 2,
                    "scoped_inventory_complete": True,
                    "inventory_scope": "addressable_public_catalogue",
                    "certificate": {
                        "addressable_public_inventory_certified": True,
                        "all_discovered_announcements_emitted": True,
                    },
                }},
            }, {}, datetime.now(UTC)))
        if "select consecutive_failures" in sql:
            return _Result((0,))
        if "select decision,count(*)" in sql:
            return _Result([("published", 2), ("publication_failed", 1)])
        if "from public.auction_collection_items i" in sql:
            return _Result([])
        if "update public.auction_source_state" in sql:
            self.state_update = params
            return _Result(None)
        if "update public.auction_runs set summary" in sql:
            self.run_summary = params
            return _Result(None)
        return _Result(None)


class _Result:
    def __init__(self, value):
        self.value = value

    def fetchone(self):
        return self.value if isinstance(self.value, tuple) else None

    def fetchall(self):
        return self.value if isinstance(self.value, list) else []


def test_finish_source_reports_partial_scope_and_publication_ledger(monkeypatch) -> None:
    db = _FinishDB()
    monkeypatch.setattr("src.autonomous_runner._postgres_connect", lambda url: nullcontext(db))

    finish_source("db", "run")

    assert db.state_update is not None
    assert db.state_update[0] == "partial"
    coverage = db.state_update[1].obj
    assert coverage["coverage_complete"] is False
    assert coverage["publication_status"] == "failed"
    assert coverage["publication_pending"] == 1
    assert coverage["publication_published"] == 2
    assert coverage["publication_failed"] == 1
    assert coverage["observed_at"]
