"""``finish_source`` : fraîcheur de l'inventaire (Agrasc, adressable) et raison d'une publication incomplète.

Point 14 du 20/10/2026 : ``last_publication_complete_at`` d'Enchères Immobilières ne bouge plus depuis le 08/10 et
Agrasc n'a jamais d'inventaire complet. Agrasc ne certifie jamais l'inventaire public entier (cartes d'archive
vendues sans lien), seulement l'inventaire adressable : il avance la date de fraîcheur de l'inventaire sans
compter pour l'absence ni le retrait. Pour toute source, les raisons qui empêchent une publication « complète »
sont maintenant écrites dans la couverture.

Point 68 du 23/10/2026 : la publication d'Agrasc est jugée sur son catalogue adressable certifié (règle propre à sa
nature, ``SCOPED_PUBLICATION_SOURCES``), sans jamais toucher à l'absence ni au retrait ; les blocages d'une
publication sont détaillés (couverture et annotation du journal) avec la date de la dernière publication complète.
"""

from __future__ import annotations

from contextlib import nullcontext
from datetime import UTC, datetime

import pytest

from src import autonomous_runner


class _Rows:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class _Db:
    def __init__(self, *, source, status, coverage, decisions, last_publication_complete_at=None, stuck_rows=()):
        self.row = (source, status, {"scrape_coverage": {source: coverage}}, {}, datetime.now(UTC))
        self.decisions = decisions
        self.last_publication_complete_at = last_publication_complete_at
        self.stuck_rows = list(stuck_rows)
        self.stuck_query: tuple | None = None
        self.state_update: tuple | None = None
        self.saved_coverage: dict | None = None

    def execute(self, sql, params=None):
        if "select source,status,summary,errors,started_at" in sql:
            return _Rows(self.row)
        if "select consecutive_failures" in sql:
            return _Rows((0, self.last_publication_complete_at))
        if "select decision,count(*)" in sql:
            return _Rows(rows=list(self.decisions.items()))
        if "from public.auction_collection_items i" in sql:
            return _Rows(rows=[])
        if "select source_url,decision,reason" in sql:
            self.stuck_query = params
            return _Rows(rows=self.stuck_rows)
        if "update public.auction_source_state set" in sql:
            self.state_update = params
            self.saved_coverage = params[1].obj
        return _Rows()


def _finish(monkeypatch, *, source="agrasc", status="succeeded", coverage, decisions=None, **db_options):
    db = _Db(source=source, status=status, coverage=coverage, decisions=decisions or {"published": 5}, **db_options)
    presence, withdrawals = [], []
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda url: nullcontext(db))
    monkeypatch.setattr(autonomous_runner, "record_source_presence", lambda *args: presence.append(args[-1]))
    monkeypatch.setattr(autonomous_runner, "withdraw_missing_sales", lambda *a, **k: withdrawals.append(a) or None)
    autonomous_runner.finish_source("db", "run-1")
    return db, presence, withdrawals


def test_a_certified_addressable_inventory_keeps_the_source_fresh_without_counting_for_absence(monkeypatch) -> None:
    coverage = {"coverage_complete": False, "scoped_inventory_complete": True, "listings_emitted": 5}

    db, presence, withdrawals = _finish(monkeypatch, coverage=coverage)

    inventory_fresh, publication_complete = db.state_update[-4], db.state_update[-3]
    assert inventory_fresh is True
    # Règle propre à Agrasc : le catalogue adressable certifié suffit à déclarer la publication complète.
    assert publication_complete is True
    assert db.saved_coverage["publication_scope"] == "addressable_public_catalogue"
    assert db.saved_coverage["publication_blockers"] == []
    assert presence == [False]  # mais l'inventaire public entier n'est pas certifié : aucun compteur d'absence ne bouge
    assert withdrawals == []  # et aucun retrait


def test_agrasc_publication_stays_incomplete_when_a_decision_is_pending_or_the_run_failed(monkeypatch) -> None:
    coverage = {"coverage_complete": False, "scoped_inventory_complete": True, "listings_emitted": 5}

    pending, _, _ = _finish(monkeypatch, coverage=coverage, decisions={"published": 4, "publication_failed": 1})
    failed, _, _ = _finish(monkeypatch, coverage=coverage, status="failed")

    assert pending.state_update[-3] is False
    assert pending.saved_coverage["publication_blockers"] == ["publication_pending"]
    assert failed.state_update[-3] is False
    assert failed.saved_coverage["publication_blockers"] == ["run_not_succeeded"]


def test_the_scoped_publication_rule_is_reserved_to_agrasc(monkeypatch) -> None:
    coverage = {"coverage_complete": False, "scoped_inventory_complete": True, "listings_emitted": 5}

    db, _, _ = _finish(monkeypatch, source="encheres_immobilieres", coverage=coverage)

    assert db.state_update[-3] is False
    assert db.saved_coverage["publication_scope"] == "public_catalogue"
    assert db.saved_coverage["publication_blockers"] == ["inventory_incomplete"]


def test_a_certificate_without_the_scoped_flag_does_not_complete_the_agrasc_publication(monkeypatch) -> None:
    coverage = {"coverage_complete": False, "listings_emitted": 5}

    db, _, _ = _finish(monkeypatch, coverage=coverage)

    assert db.state_update[-3] is False
    assert db.saved_coverage["publication_blockers"] == ["inventory_incomplete"]


@pytest.mark.parametrize(
    ("status", "coverage"),
    [
        ("failed", {"coverage_complete": False, "scoped_inventory_complete": True, "listings_emitted": 5}),
        ("succeeded", {"coverage_complete": False, "scoped_inventory_complete": False, "listings_emitted": 5}),
        ("succeeded", {"coverage_complete": False, "listings_emitted": 5}),
    ],
)
def test_a_failed_or_uncertified_run_does_not_make_the_source_fresh(monkeypatch, status, coverage) -> None:
    db, _, _ = _finish(monkeypatch, status=status, coverage=coverage)

    assert db.state_update[-4] is False


def test_the_reasons_a_publication_is_not_complete_are_recorded(monkeypatch) -> None:
    coverage = {"coverage_complete": True, "listings_emitted": 198}
    decisions = {"published": 189, "admitted": 7, "discovered": 2, "excluded": 3}

    db, _, _ = _finish(monkeypatch, source="encheres_immobilieres", status="failed", coverage=coverage,
                       decisions=decisions)

    assert db.saved_coverage["publication_blockers"] == ["publication_pending", "run_not_succeeded"]
    assert db.saved_coverage["publication_pending_decisions"] == {"discovered": 2, "admitted": 7}
    assert db.saved_coverage["publication_pending"] == 9


def test_a_complete_publication_records_no_blocker(monkeypatch) -> None:
    coverage = {"coverage_complete": True, "listings_emitted": 5}

    db, _, _ = _finish(monkeypatch, source="vench", coverage=coverage)

    assert db.saved_coverage["publication_blockers"] == []
    assert db.saved_coverage["publication_pending_decisions"] == {}
    assert db.state_update[-3] is True


def test_a_blocked_publication_says_why_since_when_and_which_items_are_stuck(monkeypatch, capsys) -> None:
    last_complete = datetime(2026, 10, 8, 5, 30, tzinfo=UTC)
    coverage = {
        "coverage_complete": False,
        "stop_reason": "source_errors",
        "errors": 1,
        "pages_fetched": 9,
        "advertised_total": 198,
        "unique_listings_seen": 198,
        "detail_failures": [{"source_url": "https://example.test/a", "kind": "identity_mismatch"}],
        "list_fetch_failures": [],
        "certificate": {"partitions": [{"reasons": ["public_announcements_not_parsed"]}]},
        "listings_emitted": 198,
    }
    stuck = [("https://example.test/b", "normalization_failed", "bad price")]

    db, _, _ = _finish(
        monkeypatch,
        source="encheres_immobilieres",
        status="failed",
        coverage=coverage,
        decisions={"published": 190, "normalization_failed": 1, "discovered": 2},
        last_publication_complete_at=last_complete,
        stuck_rows=stuck,
    )

    saved = db.saved_coverage
    assert saved["publication_blockers"] == ["inventory_incomplete", "publication_pending", "run_not_succeeded"]
    details = saved["publication_blocker_details"]
    assert details["inventory_incomplete"] == {
        "stop_reason": "source_errors",
        "errors": 1,
        "pages_fetched": 9,
        "advertised_total": 198,
        "unique_listings_seen": 198,
        "detail_failures_count": 1,
        "detail_failures_sample": [{"source_url": "https://example.test/a", "kind": "identity_mismatch"}],
        "certificate_reasons": ["public_announcements_not_parsed"],
    }
    assert details["publication_pending"] == {"decisions": {"discovered": 2, "normalization_failed": 1}, "persistent": 1}
    assert details["run_not_succeeded"] == {"run_status": "failed"}
    assert saved["publication_stuck_items"] == [
        {"source_url": "https://example.test/b", "decision": "normalization_failed", "reason": "bad price"}
    ]
    assert db.stuck_query[:2] == ("run-1", "encheres_immobilieres")
    assert saved["publication_blocked_since"] == last_complete.isoformat()
    out = capsys.readouterr().out
    assert "::warning title=Publication incomplète (encheres_immobilieres)::" in out
    assert "blockers=inventory_incomplete,publication_pending,run_not_succeeded" in out
    assert "last_complete=2026-10-08T05:30:00+00:00" in out
    assert "https://example.test" not in out  # le journal ne reprend aucun texte de la source


def test_transient_pending_decisions_do_not_trigger_the_stuck_items_query(monkeypatch) -> None:
    db, _, _ = _finish(
        monkeypatch,
        source="vench",
        coverage={"coverage_complete": True, "listings_emitted": 5},
        decisions={"published": 4, "discovered": 1},
    )

    assert db.stuck_query is None
    assert "publication_stuck_items" not in db.saved_coverage
    assert db.saved_coverage["publication_blockers"] == ["publication_pending"]


def test_a_complete_publication_prints_no_warning_and_has_no_blocked_since(monkeypatch, capsys) -> None:
    db, _, _ = _finish(monkeypatch, source="vench", coverage={"coverage_complete": True, "listings_emitted": 5})

    assert db.saved_coverage["publication_blocked_since"] is None
    assert db.saved_coverage["publication_blocker_details"] == {}
    assert "Publication incomplète" not in capsys.readouterr().out
