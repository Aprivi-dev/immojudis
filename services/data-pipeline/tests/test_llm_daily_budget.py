"""Global daily LLM budget and unpriced-model refusal (P2-16)."""

from __future__ import annotations

import os
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from src import pipeline_usage
from src.pipeline_usage import (
    LLMBudgetUnavailable,
    LLMModelNotPriced,
    PipelineBudgetExhausted,
)

QWEN = "qwen/qwen3-7-plus"
ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "supabase/migrations"


def _settings(**overrides):
    settings = {"supabase_url": None, "supabase_service_role_key": None, "supabase_db_url": None}
    settings.update(overrides)
    return settings


@pytest.fixture(autouse=True)
def _no_autonomous_run(monkeypatch):
    monkeypatch.delenv("PIPELINE_AUTONOMOUS_RUN_ID", raising=False)
    monkeypatch.delenv("LLM_DAILY_BUDGET_EUR", raising=False)


def test_default_budget_is_five_euros_and_env_overrides_it(monkeypatch) -> None:
    assert pipeline_usage.llm_daily_budget_eur() == Decimal("5")
    monkeypatch.setenv("LLM_DAILY_BUDGET_EUR", "1.5")
    assert pipeline_usage.llm_daily_budget_eur() == Decimal("1.5")
    monkeypatch.setenv("LLM_DAILY_BUDGET_EUR", "0")
    assert pipeline_usage.llm_daily_budget_eur() == Decimal("0")


@pytest.mark.parametrize("raw", ["abc", "-1", "nan", "inf"])
def test_invalid_budget_is_rejected_instead_of_silently_unbounded(monkeypatch, raw) -> None:
    monkeypatch.setenv("LLM_DAILY_BUDGET_EUR", raw)
    with pytest.raises(ValueError, match="LLM_DAILY_BUDGET_EUR"):
        pipeline_usage.llm_daily_budget_eur()


def test_models_missing_from_token_prices_are_refused_before_any_budget_lookup(monkeypatch) -> None:
    monkeypatch.setattr(
        pipeline_usage,
        "load_settings",
        lambda: pytest.fail("the model check must come first"),
    )

    with pytest.raises(LLMModelNotPriced, match="other/model"):
        pipeline_usage.reserve_prediction("other/model", input_token_ceiling=10, output_token_ceiling=10)


def test_every_priced_model_and_the_pinned_model_are_accepted(monkeypatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", _settings)
    for model in (*pipeline_usage.TOKEN_PRICES, pipeline_usage.PINNED_MODEL):
        assert pipeline_usage.reserve_prediction(model, input_token_ceiling=1, output_token_ceiling=1) is None


def test_spend_counts_tokens_unmetered_requests_and_pinned_model() -> None:
    pinned = pipeline_usage.PINNED_MODEL
    spent = pipeline_usage.spent_today_eur(
        [
            (QWEN, 3, 1, 3000, 500),  # 0.0013785 USD of tokens + one unmetered request
            (pinned, 2, 2, 0, 0),
            ("legacy/unknown", 1, 0, 1_000_000, 0),  # dearest known input rate
        ]
    )

    expected = (
        Decimal("0.0013785")
        + pipeline_usage.UNMETERED_REQUEST_COST_EUR
        + 2 * pipeline_usage.PINNED_REQUEST_COST_USD
        + Decimal("0.30")
    )
    assert spent == expected


def test_manual_backfill_stops_when_the_days_budget_is_reached(monkeypatch) -> None:
    """No PIPELINE_AUTONOMOUS_RUN_ID: the budget still applies."""
    monkeypatch.setattr(pipeline_usage, "load_settings", lambda: _settings(supabase_db_url="postgresql://x"))
    monkeypatch.setenv("LLM_DAILY_BUDGET_EUR", "1")
    # 1_000_000 output tokens of qwen = 1.101 EUR > 1 EUR budget.
    monkeypatch.setattr(
        pipeline_usage,
        "_spend_groups_via_postgres",
        lambda db_url, since: [(QWEN, 400, 0, 0, 1_000_000)],
    )

    with pytest.raises(PipelineBudgetExhausted, match="Daily LLM budget exhausted") as error:
        pipeline_usage.reserve_prediction(QWEN, input_token_ceiling=1000, output_token_ceiling=512)

    # "Daily" makes the queue wait until the next UTC day instead of 30 minutes.
    assert error.value.next_attempt_at.hour == 0


def test_request_is_allowed_while_spend_plus_ceiling_fits_in_the_budget(monkeypatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", lambda: _settings(supabase_db_url="postgresql://x"))
    monkeypatch.setattr(
        pipeline_usage, "_spend_groups_via_postgres", lambda db_url, since: [(QWEN, 10, 0, 40_000, 5_000)]
    )

    assert pipeline_usage.reserve_prediction(QWEN, input_token_ceiling=1000, output_token_ceiling=512) is None


def test_budget_is_bounded_by_the_request_ceiling_itself(monkeypatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", lambda: _settings(supabase_db_url="postgresql://x"))
    monkeypatch.setenv("LLM_DAILY_BUDGET_EUR", "0.001")
    monkeypatch.setattr(pipeline_usage, "_spend_groups_via_postgres", lambda db_url, since: [])

    with pytest.raises(PipelineBudgetExhausted):
        pipeline_usage.reserve_prediction(QWEN, input_token_ceiling=100_000, output_token_ceiling=8192)


def test_unreadable_ledger_refuses_the_request(monkeypatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", lambda: _settings(supabase_db_url="postgresql://x"))

    def broken(db_url, since):
        raise psycopg.OperationalError("connection lost")

    monkeypatch.setattr(pipeline_usage, "_spend_groups_via_postgres", broken)

    with pytest.raises(LLMBudgetUnavailable) as error:
        pipeline_usage.reserve_prediction(QWEN, input_token_ceiling=10, output_token_ceiling=10)
    assert error.value.next_attempt_at.hour != 0 or error.value.next_attempt_at.minute != 0


def test_rest_mode_totals_the_ledger_for_workflows_without_a_database_url(monkeypatch) -> None:
    monkeypatch.setattr(
        pipeline_usage,
        "load_settings",
        lambda: _settings(supabase_url="https://db.example.test", supabase_service_role_key="key"),
    )
    monkeypatch.setenv("LLM_DAILY_BUDGET_EUR", "0.05")
    calls: list[dict] = []

    def fake_get(url, *, headers, params, timeout):
        calls.append({"url": url, "params": params})
        rows = (
            [{"model": QWEN, "input_tokens_estimate": 0, "output_tokens_estimate": 0}] * 1000
            if params["offset"] == "0"
            else [{"model": QWEN, "input_tokens_estimate": 2000, "output_tokens_estimate": 300}] * 10
        )
        return httpx.Response(200, json=rows, request=httpx.Request("GET", url))

    monkeypatch.setattr(pipeline_usage.httpx, "get", fake_get)

    # 1000 unmetered requests alone cost 10 EUR, far over the 0.05 EUR budget.
    with pytest.raises(PipelineBudgetExhausted, match="Daily"):
        pipeline_usage.reserve_prediction(QWEN, input_token_ceiling=100, output_token_ceiling=100)

    assert [call["params"]["offset"] for call in calls] == ["0", "1000"]
    assert calls[0]["url"] == "https://db.example.test/rest/v1/llm_usage_events"
    assert calls[0]["params"]["request_status"] == "neq.released"
    assert calls[0]["params"]["created_at"].startswith("gte.")


def test_without_any_storage_the_check_is_skipped(monkeypatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", _settings)

    assert pipeline_usage.reserve_prediction(QWEN, input_token_ceiling=10**9, output_token_ceiling=10**9) is None


def test_autonomous_runs_still_use_the_sql_reservation_after_the_daily_check(monkeypatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", _settings)
    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "run-1")
    executed: list[tuple] = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return None

        def execute(self, statement, parameters):
            executed.append((statement, parameters))
            return self

        def fetchone(self):
            return ("usage-1",)

    import src.storage.supabase_client as storage

    monkeypatch.setattr(storage, "_postgres_connect", lambda url: Connection())
    monkeypatch.setattr(pipeline_usage, "load_settings", lambda: _settings(supabase_db_url="postgresql://x"))
    monkeypatch.setattr(pipeline_usage, "_spend_groups_via_postgres", lambda db_url, since: [])

    assert pipeline_usage.reserve_prediction(QWEN, input_token_ceiling=10, output_token_ceiling=10) == "usage-1"
    assert executed[0][1] == ("run-1", QWEN, 10, 10)


# --- PostgreSQL integration -------------------------------------------------


@pytest.fixture
def ledger_database():
    root_dsn = os.getenv("PIPELINE_TEST_DB_URL")
    if not root_dsn:
        pytest.skip("Requires disposable PostgreSQL")
    host = str(conninfo_to_dict(root_dsn).get("host") or "").split(",", 1)[0]
    if host not in {"127.0.0.1", "localhost"}:
        pytest.fail(f"Refusing non-local LLM budget database: {host}")
    name = f"immojudis_llm_budget_{os.getpid()}_{uuid4().hex[:10]}"
    with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root:
        for role in ("anon", "authenticated", "service_role"):
            root.execute(
                sql.SQL(
                    "do $$ begin if not exists(select from pg_roles where rolname={n}) "
                    "then create role {i} nologin {a}; end if; end $$"
                ).format(
                    n=sql.Literal(role),
                    i=sql.Identifier(role),
                    a=sql.SQL("bypassrls" if role == "service_role" else ""),
                )
            )
        root.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    dsn = make_conninfo(root_dsn, dbname=name)
    with psycopg.connect(dsn, autocommit=True, prepare_threshold=None) as db:
        for migration in (
            "20260916143556_llm_usage_tracking_and_queue_guards.sql",
            "20260916144159_add_llm_token_estimates.sql",
        ):
            db.execute((MIGRATIONS / migration).read_text(encoding="utf-8"))
        db.execute((next(MIGRATIONS.glob("*_llm_request_budget.sql"))).read_text(encoding="utf-8"))
    try:
        yield dsn
    finally:
        with psycopg.connect(root_dsn, autocommit=True, prepare_threshold=None) as root:
            root.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(name)))


def test_ledger_query_totals_today_across_modes_and_ignores_released(ledger_database) -> None:
    from datetime import UTC, datetime, timedelta

    with psycopg.connect(ledger_database, autocommit=True, prepare_threshold=None) as db:
        insert = (
            "insert into public.llm_usage_events(model, request_kind, request_status, "
            "input_tokens_estimate, output_tokens_estimate, created_at) values (%s,'k',%s,%s,%s,%s)"
        )
        now = datetime.now(UTC)
        db.execute(insert, (QWEN, "succeeded", 3000, 500, now))
        db.execute(insert, (QWEN, "reserved", 0, 0, now))
        db.execute(insert, (QWEN, "released", 9000, 9000, now))
        db.execute(insert, (QWEN, "succeeded", 9000, 9000, now - timedelta(days=2)))

    groups = pipeline_usage._spend_groups_via_postgres(
        ledger_database, now.replace(hour=0, minute=0, second=0, microsecond=0)
    )

    assert groups == [(QWEN, 2, 1, 3000, 500)]
    assert pipeline_usage.spent_today_eur(groups) == Decimal("0.0013785") + pipeline_usage.UNMETERED_REQUEST_COST_EUR
