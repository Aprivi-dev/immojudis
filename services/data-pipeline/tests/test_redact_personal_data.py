"""Réparation des textes déjà stockés : compte seulement par défaut, écriture ciblée sur demande."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from src.redact_personal_data import (
    parse_args,
    plan_occurrence_changes,
    plan_risk_changes,
    plan_sale_changes,
    repair,
)

SALE_ID = "11111111-1111-1111-1111-111111111111"
UPDATED_AT = "2026-10-01T10:00:00+00:00"


def _sale_row() -> dict[str, Any]:
    return {
        "id": SALE_ID,
        "source_url": "https://example.test/a",
        "updated_at": UPDATED_AT,
        "description": "Appartement occupé par Monsieur Pierre DUPONT suivant bail.",
        "risk_notes": None,
        "investment_summary": "Bien libre.",
        "payload_text": {
            "source_description": "À la requête de Monsieur Henri FAURE, demeurant 14 rue des Lilas 69003 Lyon.",
            "llm_display_description": "Appartement occupé, locataire en place.",
        },
        "observations": [
            {"source_url": "https://example.test/a", "raw_payload": {"source_blocks": {"t": "locataire Madame Eva ROY"}}}
        ],
    }


class FakeCursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None, rowcount: int = 1) -> None:
        self._rows = rows or []
        self.rowcount = rowcount
        columns = list(self._rows[0]) if self._rows else []
        self.description = [SimpleNamespace(name=name) for name in columns]

    def fetchall(self) -> list[tuple[Any, ...]]:
        return [tuple(row.values()) for row in self._rows]


class FakeConnection:
    def __init__(self, sales: list[dict[str, Any]], dependent: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.sales = sales
        self.dependent = dependent or {}
        self.executed: list[tuple[str, Any]] = []
        self.commits = 0
        self.rollbacks = 0
        self._sales_served = False

    def execute(self, statement: str, params: Any = None) -> FakeCursor:
        self.executed.append((statement, params))
        if statement.startswith("select") and "from public.auction_sales" in statement:
            rows = [] if self._sales_served else self.sales
            self._sales_served = True
            return FakeCursor(rows)
        if statement.startswith("select"):
            table = statement.split("from public.")[1].split()[0]
            return FakeCursor(self.dependent.get(table, []))
        return FakeCursor()

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    @property
    def updates(self) -> list[tuple[str, Any]]:
        return [item for item in self.executed if item[0].startswith("update")]


def test_plan_sale_changes_lists_only_what_changes() -> None:
    changes = plan_sale_changes(
        _sale_row(), text_columns=("description", "risk_notes", "investment_summary"), has_observations=True
    )
    assert changes["description"] == "Appartement occupé par un locataire suivant bail."
    assert changes["payload"] == {"source_description": "À la requête du créancier poursuivant."}
    assert changes["observations"][0]["raw_payload"]["source_blocks"] == {"t": "locataire"}
    assert "risk_notes" not in changes and "investment_summary" not in changes


def test_plan_sale_changes_is_empty_for_clean_rows() -> None:
    row = {**_sale_row(), "description": "Appartement libre.", "payload_text": {}, "observations": []}
    assert plan_sale_changes(row, text_columns=("description",), has_observations=True) == {}


def test_plan_risk_and_occurrence_changes() -> None:
    risk = plan_risk_changes(
        {"evidence": "occupé par Monsieur Luc PETIT", "evidence_json": {"excerpt": "locataire Madame Eva ROY"}}
    )
    assert risk == {"evidence": "occupé par un occupant", "evidence_json": {"excerpt": "locataire"}}
    assert plan_occurrence_changes({"excerpt": "Bail consenti à Monsieur Paul ROY"}) == {
        "excerpt": "Bail consenti à un locataire"
    }
    assert plan_occurrence_changes({"excerpt": "Occupé, locataire en place"}) == {}


def test_count_only_never_writes_and_never_prints_the_text() -> None:
    connection = FakeConnection(
        [_sale_row()],
        {
            "properties": [
                {"id": "p1", "description": "occupé par Monsieur Jean ROY", "payload_text": {}},
                {"id": "p2", "description": "Libre", "payload_text": {}},
            ],
            "auction_risk_occurrences": [{"id": "o1", "excerpt": "locataire Madame Sara LOPEZ"}],
        },
    )

    report = repair(connection, apply=False)

    assert connection.executed[0][0] == "set transaction read only"
    assert connection.updates == []
    assert connection.commits == 0 and connection.rollbacks == 1
    assert report["mode"] == "count-only"
    assert report["scanned_sales"] == 1
    assert report["rows_to_update"] == 3
    assert report["tables"]["auction_sales"]["fields"] == {"description": 1, "observations": 1, "payload": 1}
    assert report["tables"]["properties"]["sample_ids"] == ["p1"]
    dump = json.dumps(report, ensure_ascii=False)
    for name in ("DUPONT", "FAURE", "ROY", "LOPEZ"):
        assert name not in dump


def test_apply_updates_only_changed_columns_and_merges_the_payload() -> None:
    connection = FakeConnection([_sale_row()], {"auction_risks": [{"id": "r1", "evidence": "locataire Madame Eva ROY", "evidence_json": {}}]})

    report = repair(connection, apply=True)

    assert report["mode"] == "apply"
    assert connection.commits == 1
    sale_update, sale_values = connection.updates[0]
    assert sale_update.startswith("update public.auction_sales set ")
    assert "raw_payload = coalesce(raw_payload, '{}'::jsonb) || %s" in sale_update
    assert "description = %s" in sale_update and "risk_notes" not in sale_update
    assert sale_update.endswith("where id = %s and updated_at = %s and jsonb_typeof(raw_payload) = 'object'")
    assert sale_values[-2:] == [SALE_ID, UPDATED_AT]
    assert [type(value).__name__ for value in sale_values[:3]] == ["str", "Jsonb", "Jsonb"]
    risk_update, risk_values = connection.updates[1]
    assert risk_update == "update public.auction_risks set evidence = %s where id = %s"
    assert risk_values == ["locataire", "r1"]


def test_apply_counts_rows_changed_by_the_pipeline_meanwhile() -> None:
    connection = FakeConnection([_sale_row()])
    original = connection.execute

    def execute(statement: str, params: Any = None) -> FakeCursor:
        cursor = original(statement, params)
        if statement.startswith("update public.auction_sales"):
            cursor.rowcount = 0
        return cursor

    connection.execute = execute  # type: ignore[method-assign]
    assert repair(connection, apply=True)["skipped_concurrent_updates"] == 1


def test_limit_and_all_statuses_reach_the_query() -> None:
    connection = FakeConnection([])
    repair(connection, apply=False, statuses=None, limit=7)
    params = connection.executed[1][1]
    assert params["statuses"] is None and params["size"] == 7


def test_count_only_is_the_default_mode() -> None:
    assert parse_args([]).apply is False
    assert parse_args(["--apply"]).apply is True
    with pytest.raises(SystemExit):
        parse_args(["--apply", "--check"])
