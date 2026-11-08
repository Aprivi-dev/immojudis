"""Alerte de rendement du vidage des pièces : pipeline.documents_backlog.low_yield (T9 du 08/11/2026)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from src import document_backlog_yield as yield_module

MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "20261111131500_documents_backlog_low_yield_alert.sql"
)
HOUR = 3600.0


def _summary(*, elapsed: float, sales_read: int, passes: int = 10, partial_passes: int = 0) -> dict:
    return {
        "stop_reason": "budget",
        "elapsed_seconds": elapsed,
        "sales_seen": 40,
        "sales_processed": 30,
        "sales_read": sales_read,
        "passes": passes,
        "partial_passes": partial_passes,
        "partial_pass_share": yield_module.partial_pass_share(passes, partial_passes),
        "refused_checkpoints": 0,
        "prefetch": {"workers": 3, "deferred_exhausted": 0, "errors": 0},
        "by_source": {"vench": {"sales": 40}},
    }


def test_the_thresholds_are_the_decided_ones() -> None:
    assert yield_module.ALERT_KEY == "pipeline.documents_backlog.low_yield"
    assert yield_module.LOW_YIELD_MIN_DURATION_SECONDS == 60 * 60
    assert yield_module.LOW_YIELD_MIN_SALES_READ == 5
    assert yield_module.LOW_YIELD_MAX_PARTIAL_PASS_SHARE == 0.30


@pytest.mark.parametrize(
    ("elapsed", "sales_read", "passes", "partial", "active", "reasons"),
    [
        # Référence du 05/11/2026 sans lecture en avance : 43 ventes en 150 minutes.
        (150 * 60, 43, 60, 3, False, []),
        # Juste au seuil : 5 ventes lues, 30 % de passes partielles, pas d'alerte.
        (2 * HOUR, 5, 10, 3, False, []),
        # Sous le seuil de ventes lues.
        (2 * HOUR, 4, 10, 0, True, ["few_sales_read"]),
        # Au-dessus du seuil de passes partielles (4 sur 10).
        (2 * HOUR, 20, 10, 4, True, ["partial_passes"]),
        # Les deux à la fois.
        (2 * HOUR, 3, 70, 53, True, ["few_sales_read", "partial_passes"]),
        # Le 04/11 à 11:20 (8 lectures, 53 passes partielles pour 27 ventes) s'il avait duré plus d'une heure.
        (61 * 60, 8, 70, 53, True, ["partial_passes"]),
    ],
)
def test_a_long_drain_is_judged_on_sales_read_and_partial_passes(
    elapsed, sales_read, passes, partial, active, reasons
) -> None:
    evaluation = yield_module.evaluate_low_yield(
        _summary(elapsed=elapsed, sales_read=sales_read, passes=passes, partial_passes=partial)
    )

    assert evaluation["evaluated"] is True
    assert evaluation["active"] is active
    assert evaluation["reasons"] == reasons


@pytest.mark.parametrize("elapsed", [8 * 60, 45 * 60, 60 * 60])
def test_a_drain_of_one_hour_or_less_is_not_judged(elapsed) -> None:
    # Le vidage de 8 minutes après chaque passage de la file lit 6 ventes au plus : il ne touche pas l'alerte.
    evaluation = yield_module.evaluate_low_yield(_summary(elapsed=elapsed, sales_read=0, passes=10, partial_passes=10))

    assert evaluation["evaluated"] is False
    assert evaluation["active"] is False
    assert yield_module.sync_low_yield_alert("postgres://x", {}, evaluation, connect=_forbidden) == "skipped"


def test_no_pass_means_no_partial_share() -> None:
    assert yield_module.partial_pass_share(0, 0) == 0.0
    assert yield_module.partial_pass_share(3, 1) == 0.333


class _Db:
    def __init__(self, deployed: bool = True, fail: bool = False) -> None:
        self.deployed = deployed
        self.fail = fail
        self.calls: list[tuple[str, tuple]] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: str, parameters: tuple = ()):
        self.calls.append((sql, parameters))
        if self.fail:
            raise RuntimeError("connection reset")
        self._row = (yield_module.FUNCTION if self.deployed else None,) if "to_regprocedure" in sql else (None,)
        return self

    def fetchone(self):
        return self._row


def _forbidden(_db_url):
    raise AssertionError("no database access for a short drain")


def test_a_low_yield_opens_the_alert_through_the_dedicated_function() -> None:
    db = _Db()
    summary = _summary(elapsed=2 * HOUR, sales_read=2, passes=10, partial_passes=6)
    evaluation = yield_module.evaluate_low_yield(summary)

    assert yield_module.sync_low_yield_alert("postgres://x", summary, evaluation, connect=lambda _url: db) == "opened"

    sql, parameters = db.calls[-1]
    assert sql == "select app_private.sync_documents_backlog_low_yield_alert(%s, %s::jsonb)"
    assert parameters[0] is True
    details = json.loads(parameters[1])
    assert details["sales_read"] == 2 and details["partial_pass_share"] == 0.6
    assert details["reasons"] == ["few_sales_read", "partial_passes"]
    assert details["thresholds"]["min_sales_read"] == 5
    assert "by_source" not in details  # only the yield figures


def test_a_healthy_long_drain_reports_the_condition_clear() -> None:
    db = _Db()
    summary = _summary(elapsed=2 * HOUR, sales_read=30, passes=40, partial_passes=4)
    evaluation = yield_module.evaluate_low_yield(summary)

    assert yield_module.sync_low_yield_alert("postgres://x", summary, evaluation, connect=lambda _url: db) == "clear"
    assert db.calls[-1][1][0] is False


def test_a_database_without_the_function_or_unreachable_never_fails_the_drain() -> None:
    summary = _summary(elapsed=2 * HOUR, sales_read=0)
    evaluation = yield_module.evaluate_low_yield(summary)

    missing = _Db(deployed=False)
    assert yield_module.sync_low_yield_alert("postgres://x", summary, evaluation, connect=lambda _url: missing) == (
        "not_deployed"
    )
    assert len(missing.calls) == 1
    assert yield_module.sync_low_yield_alert("postgres://x", summary, evaluation, connect=lambda _url: _Db(fail=True)) == (
        "error"
    )
    assert yield_module.sync_low_yield_alert("", summary, evaluation, connect=_forbidden) == "skipped"


def test_the_migration_records_this_key_only_with_the_common_mechanism() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    body = " ".join(re.sub(r"--[^\n]*", "", sql).split())

    assert "create or replace function app_private.sync_documents_backlog_low_yield_alert(" in body
    assert "security definer set search_path = ''" in body
    assert (
        "perform app_private.sync_operational_alert( 'pipeline.documents_backlog.low_yield', 'import', 'warning',"
        " p_details, p_active, p_now );"
    ) in body
    assert (
        "revoke all on function app_private.sync_documents_backlog_low_yield_alert(boolean, jsonb, timestamptz)"
        " from public, anon, authenticated, service_role;"
    ) in body
    assert yield_module.FUNCTION == "app_private.sync_documents_backlog_low_yield_alert(boolean,jsonb,timestamptz)"
