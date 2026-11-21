"""Prix des lecteurs de pièces (Claude) et concordance de la grille Python avec la grille SQL."""

from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path

import pytest

from src import pipeline_usage

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase/migrations"
RESERVATION = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.reserve_pipeline_prediction\(\s*p_run_id\s+uuid,\s*"
    r"p_model\s+text,\s*p_input_token_ceiling",
    re.I,
)
# Chaque branche commence à « if p_model = '…' » ou « elsif p_model = '…' » et va jusqu'à la suivante.
BRANCH_START = re.compile(r"\b(?:els)?if\s+p_model\s*=\s*'([^']+)'\s+then", re.I)


def sql_price_grid() -> dict[str, dict[str, object]]:
    """Prix de la dernière migration qui définit la réservation à quatre arguments : celle que la base exécute."""
    latest = max(path for path in MIGRATIONS.glob("*.sql") if RESERVATION.search(path.read_text(encoding="utf-8")))
    sql = latest.read_text(encoding="utf-8")
    match = RESERVATION.search(sql)
    assert match is not None
    body = sql[match.start() :]
    starts = list(BRANCH_START.finditer(body))
    grid: dict[str, dict[str, object]] = {}
    for start, end in zip(starts, [*starts[1:], None], strict=True):
        model = start.group(1)
        branch = body[start.end() : end.start() if end else len(body)]
        rates = dict(re.findall(r"v_(input_rate|output_rate)\s*:=\s*([\d.]+)\s*;", branch))
        if not rates:
            continue  # le modèle à la seconde délègue à la réservation à deux arguments
        bound = re.search(r"p_input_token_ceiling\s*>\s*(\d+)", branch)
        source = re.search(r"v_rate_source\s*:=\s*'([^']+)'", branch)
        grid[model] = {
            "input": Decimal(rates["input_rate"]),
            "output": Decimal(rates["output_rate"]),
            "source": source.group(1) if source else None,
            "input_limit": int(bound.group(1)) if bound else None,
        }
    return grid


def test_python_and_sql_price_grids_agree() -> None:
    grid = sql_price_grid()

    assert set(grid) == set(pipeline_usage.TOKEN_PRICES)
    for model, (input_price, output_price, source) in pipeline_usage.TOKEN_PRICES.items():
        assert (grid[model]["input"], grid[model]["output"], grid[model]["source"]) == (
            input_price,
            output_price,
            source,
        )
    for model, (limit, _high_input, _high_output) in pipeline_usage.TOKEN_PRICE_INPUT_LIMITS.items():
        assert grid[model]["input_limit"] == limit


def test_claude_readers_are_priced_with_their_published_rates() -> None:
    assert pipeline_usage.TOKEN_PRICES["claude-haiku-5-5"][:2] == (Decimal("0.10"), Decimal("0.50"))
    assert pipeline_usage.TOKEN_PRICES["claude-sonnet-5-5"][:2] == (Decimal("2"), Decimal("10"))
    # La réflexion est facturée en sortie : 1 000 jetons d'entrée et 3 000 de sortie de Haiku.
    cost, _ = pipeline_usage._prediction_cost(
        "claude-haiku-5-5", {}, {"input_token_count": 1000, "output_token_count": 3000}
    )
    assert cost == Decimal("0.0016")


def test_haiku_is_never_reserved_above_its_lower_price_tier(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", lambda: {"supabase_db_url": None})
    monkeypatch.delenv("PIPELINE_AUTONOMOUS_RUN_ID", raising=False)

    assert (
        pipeline_usage.reserve_prediction("claude-haiku-5-5", input_token_ceiling=100_000, output_token_ceiling=1)
        is None
    )
    with pytest.raises(pipeline_usage.LLMModelNotPriced, match="100000"):
        pipeline_usage.reserve_prediction("claude-haiku-5-5", input_token_ceiling=100_001, output_token_ceiling=1)


def test_a_haiku_request_over_100000_input_tokens_costs_the_higher_tier_on_the_whole_request() -> None:
    cost, _ = pipeline_usage._prediction_cost(
        "claude-haiku-5-5", {}, {"input_token_count": 100_001, "output_token_count": 1_000}
    )
    # 100 001 × 0.50 + 1 000 × 2.50 par million.
    assert cost == Decimal("0.0525005")
    assert pipeline_usage.ledger_token_counts("claude-haiku-5-5", 100_001, 1_000) == (500_005, 5_000)
    assert pipeline_usage.ledger_token_counts("claude-haiku-5-5", 100_000, 1_000) == (100_000, 1_000)
    assert pipeline_usage.ledger_token_counts("claude-sonnet-5-5", 200_000, 1_000) == (200_000, 1_000)


def test_a_ceiling_already_in_the_ledger_is_not_counted_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pipeline_usage, "load_settings", lambda: {"supabase_db_url": "postgresql://local.invalid/db"})
    monkeypatch.setenv("LLM_DAILY_BUDGET_EUR", "1")
    # Le registre porte déjà 0,90 € de Sonnet, plafond de cette requête (0,21 €) compris.
    monkeypatch.setattr(
        pipeline_usage,
        "_spend_groups_via_postgres",
        lambda db_url, since: [("claude-sonnet-5-5", 1, 0, 250_000, 40_000)],
    )
    pipeline_usage.enforce_daily_budget(
        "claude-sonnet-5-5", input_token_ceiling=25_000, output_token_ceiling=16_000, ceiling_in_ledger=True
    )
    with pytest.raises(pipeline_usage.PipelineBudgetExhausted):
        pipeline_usage.enforce_daily_budget("claude-sonnet-5-5", input_token_ceiling=25_000, output_token_ceiling=16_000)
