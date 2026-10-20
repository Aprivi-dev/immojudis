"""``finish_source`` : fraîcheur de l'inventaire (Agrasc, adressable) et raison d'une publication incomplète.

Point 14 du 20/10/2026 : ``last_publication_complete_at`` d'Enchères Immobilières ne bouge plus depuis le 08/10 et
Agrasc n'a jamais d'inventaire complet. Agrasc ne certifie jamais l'inventaire public entier (cartes d'archive
vendues sans lien), seulement l'inventaire adressable : il avance la date de fraîcheur de l'inventaire sans
compter pour l'absence ni le retrait. Pour toute source, les raisons qui empêchent une publication « complète »
sont maintenant écrites dans la couverture.
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
    def __init__(self, *, source, status, coverage, decisions):
        self.row = (source, status, {"scrape_coverage": {source: coverage}}, {}, datetime.now(UTC))
        self.decisions = decisions
        self.state_update: tuple | None = None
        self.saved_coverage: dict | None = None

    def execute(self, sql, params=None):
        if "select source,status,summary,errors,started_at" in sql:
            return _Rows(self.row)
        if "select consecutive_failures" in sql:
            return _Rows((0,))
        if "select decision,count(*)" in sql:
            return _Rows(rows=list(self.decisions.items()))
        if "from public.auction_collection_items i" in sql:
            return _Rows(rows=[])
        if "update public.auction_source_state set" in sql:
            self.state_update = params
            self.saved_coverage = params[1].obj
        return _Rows()


def _finish(monkeypatch, *, source="agrasc", status="succeeded", coverage, decisions=None):
    db = _Db(source=source, status=status, coverage=coverage, decisions=decisions or {"published": 5})
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
    assert publication_complete is False  # l'inventaire public entier n'est pas certifié
    assert presence == [False]  # aucun compteur d'absence ne bouge
    assert withdrawals == []  # et aucun retrait


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
