"""Échéance de la prochaine collecte d'une source (``finish_source``).

Une erreur de fiche détail sur un run publié garde la cadence de 12 h ; le back-off
(30 min à 6 h) est réservé aux runs en échec, sans progrès, ou refusés par la source.
"""
from __future__ import annotations

from contextlib import nullcontext
from datetime import UTC, datetime, timedelta

import pytest

from src.autonomous_runner import INVENTORY_CADENCE, access_denied, finish_source


class _Result:
    def __init__(self, value):
        self.value = value

    def fetchone(self):
        return self.value if isinstance(self.value, tuple) else None

    def fetchall(self):
        return self.value if isinstance(self.value, list) else []


class _FinishDB:
    def __init__(self, *, status, problems, coverage, published, previous_failures=0):
        self.status = status
        self.problems = problems
        self.coverage = coverage
        self.published = published
        self.previous_failures = previous_failures
        self.state_update = None

    def execute(self, sql: str, params=None):
        if "select source,status,summary,errors,started_at" in sql:
            errors = {"licitor": self.problems} if self.problems else {}
            summary = {"scrape_coverage": {"licitor": self.coverage}}
            return _Result(("licitor", self.status, summary, errors, datetime.now(UTC)))
        if "select consecutive_failures" in sql:
            return _Result((self.previous_failures,))
        if "select decision,count(*)" in sql:
            return _Result([("published", self.published)] if self.published else [])
        if "from public.auction_collection_items i" in sql:
            return _Result([])
        if "update public.auction_source_state" in sql:
            self.state_update = params
        return _Result(None)


def _finish(monkeypatch, presence: list | None = None, **kwargs) -> dict[str, object]:
    db = _FinishDB(**kwargs)
    monkeypatch.setattr("src.autonomous_runner._postgres_connect", lambda url: nullcontext(db))
    monkeypatch.setattr(
        "src.autonomous_runner.record_source_presence",
        lambda *a, **k: presence.append(a) if presence is not None else None,
    )
    before = datetime.now(UTC)
    finish_source("db", "run")
    assert db.state_update is not None
    (availability, _coverage, last_error, failures, deadline, suspended_until, *_rest) = db.state_update
    return {
        "availability": availability,
        "last_error": last_error,
        "failures": failures,
        "delay": deadline - before,
        "suspended": suspended_until is not None,
    }


DETAIL_ERROR = "Server error '500 Internal Server Error' for url 'https://example.test/vente/403'"


def test_succeeded_run_with_one_detail_error_keeps_the_twelve_hour_cadence(monkeypatch) -> None:
    result = _finish(
        monkeypatch,
        status="succeeded",
        problems=[DETAIL_ERROR],
        coverage={"listings_emitted": 40, "access_denials": 0},
        published=40,
        previous_failures=3,
    )

    assert abs(result["delay"] - INVENTORY_CADENCE) < timedelta(minutes=1)
    assert result["failures"] == 0
    assert result["suspended"] is False
    assert result["availability"] != "access_denied"
    # L'erreur reste visible pour l'exploitation.
    assert "500 Internal Server Error" in result["last_error"]


def test_succeeded_run_keeps_a_retry_after_announced_by_the_source(monkeypatch) -> None:
    retry_at = datetime.now(UTC) + timedelta(hours=20)
    result = _finish(
        monkeypatch,
        status="succeeded",
        problems=[DETAIL_ERROR],
        coverage={"listings_emitted": 40, "retry_not_before": retry_at.isoformat()},
        published=40,
    )

    assert result["delay"] > timedelta(hours=19, minutes=58)
    assert result["failures"] == 0
    assert result["suspended"] is True


def test_url_containing_403_with_http_500_is_not_an_access_denial(monkeypatch) -> None:
    result = _finish(
        monkeypatch,
        status="failed",
        problems=[DETAIL_ERROR],
        coverage={"access_denials": 0},
        published=0,
        previous_failures=1,
    )

    assert result["availability"] == "unavailable"
    assert result["failures"] == 2
    # Back-off ordinaire (60 min pour 2 échecs), pas la suspension de 24 h d'un refus.
    assert timedelta(minutes=59) < result["delay"] < timedelta(minutes=61)
    assert result["suspended"] is False


def test_failed_run_keeps_the_backoff_even_when_it_published_sales(monkeypatch) -> None:
    result = _finish(
        monkeypatch,
        status="failed",
        problems=["Execution budget exceeded; committed checkpoints preserved"],
        coverage={"listings_emitted": 10},
        published=10,
    )

    assert result["failures"] == 1
    assert timedelta(minutes=29) < result["delay"] < timedelta(minutes=31)


def test_succeeded_run_without_published_sale_and_with_errors_keeps_the_backoff(monkeypatch) -> None:
    result = _finish(
        monkeypatch,
        status="succeeded",
        problems=[DETAIL_ERROR],
        coverage={"listings_emitted": 0},
        published=0,
    )

    assert result["failures"] == 1
    assert timedelta(minutes=29) < result["delay"] < timedelta(minutes=31)


def test_structured_access_denials_keep_the_backoff_and_suspend_the_source(monkeypatch) -> None:
    result = _finish(
        monkeypatch,
        status="succeeded",
        problems=["Source suspended after repeated access refusals"],
        coverage={"listings_emitted": 40, "access_denials": 2},
        published=40,
        previous_failures=1,
    )

    assert result["availability"] == "access_denied"
    assert result["failures"] == 2
    assert result["delay"] > timedelta(hours=23, minutes=58)
    assert result["suspended"] is True


@pytest.mark.parametrize(
    ("coverage", "problems", "expected"),
    [
        ({"access_denials": 1}, [], True),
        ({"access_denials": 0}, ["robots access refused for https://x.test/a: HTTP 403"], True),
        ({}, ["authentication rejected (HTTP 401)"], True),
        ({"access_denials": 0}, [DETAIL_ERROR], False),
        ({}, ["Server error HTTP 500 for url https://x.test/lot-401"], False),
        ({}, ["fetching https://x.test/403/page failed: timeout"], False),
        ({}, ["HTTP 4031 is not a status"], False),
        ({}, [], False),
    ],
)
def test_access_denied_reads_the_structured_counter_then_the_http_status(
    coverage, problems, expected
) -> None:
    assert access_denied(coverage, problems) is expected


def test_failed_run_never_counts_as_a_complete_inventory_for_absence(monkeypatch) -> None:
    presence: list = []
    _finish(
        monkeypatch,
        presence=presence,
        status="failed",
        problems=["Execution budget exceeded; committed checkpoints preserved"],
        coverage={"listings_emitted": 10, "coverage_complete": True},
        published=10,
    )

    ((_db, _run, _source, _availability, complete),) = presence
    assert complete is False


def test_succeeded_run_with_complete_coverage_counts_for_absence(monkeypatch) -> None:
    presence: list = []
    _finish(
        monkeypatch,
        presence=presence,
        status="succeeded",
        problems=[],
        coverage={"listings_emitted": 40, "coverage_complete": True},
        published=40,
    )

    ((_db, _run, _source, _availability, complete),) = presence
    assert complete is True


def test_succeeded_run_with_partial_coverage_does_not_count_for_absence(monkeypatch) -> None:
    presence: list = []
    _finish(
        monkeypatch,
        presence=presence,
        status="succeeded",
        problems=[],
        coverage={"listings_emitted": 40, "coverage_complete": False},
        published=40,
    )

    ((_db, _run, _source, _availability, complete),) = presence
    assert complete is False
