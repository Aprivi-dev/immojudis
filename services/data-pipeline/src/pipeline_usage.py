"""Meter predictions without retaining prompts, outputs, logs or credentials."""
from __future__ import annotations

import math
import os
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import psycopg
from psycopg.types.json import Jsonb

from src.config import load_settings

PINNED_MODEL = 'zsxkib/qwen2-7b-instruct:5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4'
RATE_SOURCE = 'https://replicate.com/pricing#hardware; L40S 0.000975 USD/s; checked 2026-09-12'
TOKEN_PRICES = {
    'qwen/qwen3-7-plus': (
        Decimal('0.276'), Decimal('1.101'),
        'https://replicate.com/qwen/qwen3-7-plus; checked 2026-09-21',
    ),
    'google/gemini-2.5-flash': (
        Decimal('0.30'), Decimal('2.50'),
        'https://replicate.com/google/gemini-2.5-flash; checked 2026-09-21',
    ),
}

# Global daily LLM budget shared by the pipeline, backfills and the information
# agent: every Replicate request is written to llm_usage_events whatever the
# execution mode, so that ledger is the single source of spend.
DEFAULT_LLM_DAILY_BUDGET_EUR = Decimal('5')
# Provider prices are in USD; counting one USD as one EUR is deliberately pessimistic.
EUR_PER_USD = Decimal('1')
# Charged for a request that reserved a slot but never reported token counts
# (in flight, ambiguous transport outcome, crashed worker).
UNMETERED_REQUEST_COST_EUR = Decimal('0.01')
# Worst case of the pinned per-second model: 5 minutes at 0.000975 USD/s.
PINNED_REQUEST_COST_USD = Decimal('0.2925')
_BUDGET_REST_PAGE_SIZE = 1000
_BUDGET_REST_MAX_PAGES = 50
_BUDGET_TIMEOUT_SECONDS = 15.0


class PipelineBudgetExhausted(RuntimeError):
    def __init__(self, message: str):
        super().__init__(message)
        now = datetime.now(UTC)
        self.next_attempt_at = (now+timedelta(days=1)).replace(hour=0,minute=0,second=0,microsecond=0) if 'Daily' in message else now+timedelta(minutes=30)


class LLMModelNotPriced(RuntimeError):
    """The model has no entry in TOKEN_PRICES, so its cost cannot be bounded."""


class LLMBudgetUnavailable(PipelineBudgetExhausted):
    """The daily budget could not be read; the request is refused (fail closed)."""


class QueueJobDeferred(RuntimeError):
    """A claimed job must wait for a prerequisite without spending an attempt.

    Queue claims increment ``attempt_count`` before the worker starts.  Some
    outcomes are expected coordination states rather than failures (for
    example, a fact pass waiting for the PDF worker to finish).  Keeping this
    state explicit prevents those jobs from being counted as failed while
    retaining a finite wake-up deadline.
    """

    def __init__(self, message: str, *, retry_after: datetime | None = None) -> None:
        super().__init__(message)
        self.next_attempt_at = retry_after or (datetime.now(UTC) + timedelta(minutes=30))


def defer_budget_jobs(jobs: list, error: PipelineBudgetExhausted | QueueJobDeferred) -> None:
    from src.storage.supabase_client import _postgres_connect
    with _postgres_connect(str(load_settings()['supabase_db_url'])) as db:
        for job in jobs:
            lease_filter = ' and locked_at=%s' if job.get('locked_at') is not None else ''
            parameters = (error.next_attempt_at,str(error),job['id'],job['attempt_count'])
            if lease_filter:
                parameters += (job['locked_at'],)
            db.execute("""update public.auction_enrichment_jobs set status='queued',locked_at=null,
              attempt_count=greatest(0,attempt_count-1),next_attempt_at=%s,last_error=%s,updated_at=now()
              where id=%s and status='running' and attempt_count=%s""" + lease_filter, parameters)


def llm_daily_budget_eur() -> Decimal:
    """Daily LLM budget in euros from LLM_DAILY_BUDGET_EUR (5 by default)."""
    raw = (os.getenv('LLM_DAILY_BUDGET_EUR') or '').strip()
    if not raw:
        return DEFAULT_LLM_DAILY_BUDGET_EUR
    try:
        value = Decimal(raw)
    except ArithmeticError:
        value = Decimal(-1)
    if not value.is_finite() or value < 0:
        raise ValueError(f'LLM_DAILY_BUDGET_EUR must be a non-negative number, got {raw!r}')
    return value


def require_priced_model(model: str) -> None:
    if model != PINNED_MODEL and model not in TOKEN_PRICES:
        raise LLMModelNotPriced(
            f'Model {model!r} has no entry in TOKEN_PRICES; refusing a call whose cost cannot be bounded'
        )


def _worst_known_prices() -> tuple[Decimal, Decimal]:
    return (
        max(prices[0] for prices in TOKEN_PRICES.values()),
        max(prices[1] for prices in TOKEN_PRICES.values()),
    )


def _request_cost_eur(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    if model == PINNED_MODEL:
        return PINNED_REQUEST_COST_USD * EUR_PER_USD
    prices = TOKEN_PRICES.get(model)
    input_price, output_price = (prices[0], prices[1]) if prices else _worst_known_prices()
    cost_usd = (Decimal(input_tokens) * input_price + Decimal(output_tokens) * output_price) / Decimal(1_000_000)
    return cost_usd * EUR_PER_USD


def spent_today_eur(groups: list[tuple[str, int, int, int, int]]) -> Decimal:
    """Sum the day's spend from (model, requests, unmetered, input_tokens, output_tokens) groups.

    Models without a price (older rows) are charged at the dearest known rate.
    """
    total = Decimal(0)
    for model, requests, unmetered, input_tokens, output_tokens in groups:
        if model == PINNED_MODEL:
            total += _request_cost_eur(model, 0, 0) * requests
            continue
        total += _request_cost_eur(model, input_tokens, output_tokens)
        total += UNMETERED_REQUEST_COST_EUR * unmetered
    return total


def _utc_day_start() -> datetime:
    return datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


def _spend_groups_via_postgres(db_url: str, since: datetime) -> list[tuple[str, int, int, int, int]]:
    from src.storage.supabase_client import _shared_postgres_connection
    with _shared_postgres_connection(db_url) as db:
        rows = db.execute(
            """select model, count(*),
                      count(*) filter (where coalesce(input_tokens_estimate,0)=0 and coalesce(output_tokens_estimate,0)=0),
                      coalesce(sum(input_tokens_estimate),0), coalesce(sum(output_tokens_estimate),0)
                 from public.llm_usage_events
                where created_at >= %s and request_status <> 'released'
                group by model""",
            (since,),
        ).fetchall()
    return [(str(row[0]), int(row[1]), int(row[2]), int(row[3]), int(row[4])) for row in rows]


def _spend_groups_via_rest(settings: dict, since: datetime) -> list[tuple[str, int, int, int, int]]:
    base_url = str(settings['supabase_url']).rstrip('/')
    api_key = str(settings['supabase_service_role_key'])
    groups: dict[str, list[int]] = {}
    for page in range(_BUDGET_REST_MAX_PAGES):
        response = httpx.get(
            f'{base_url}/rest/v1/llm_usage_events',
            headers={'apikey': api_key, 'Authorization': f'Bearer {api_key}'},
            params={
                'select': 'model,input_tokens_estimate,output_tokens_estimate',
                'created_at': f'gte.{since.isoformat()}',
                'request_status': 'neq.released',
                'order': 'created_at.asc,id.asc',
                'limit': str(_BUDGET_REST_PAGE_SIZE),
                'offset': str(page * _BUDGET_REST_PAGE_SIZE),
            },
            timeout=_BUDGET_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        rows = response.json()
        for row in rows:
            input_tokens = int(row.get('input_tokens_estimate') or 0)
            output_tokens = int(row.get('output_tokens_estimate') or 0)
            group = groups.setdefault(str(row.get('model') or ''), [0, 0, 0, 0])
            group[0] += 1
            group[1] += 1 if input_tokens == 0 and output_tokens == 0 else 0
            group[2] += input_tokens
            group[3] += output_tokens
        if len(rows) < _BUDGET_REST_PAGE_SIZE:
            break
    else:
        raise RuntimeError('LLM usage ledger is too large to total through the REST API')
    return [(model, *values) for model, values in groups.items()]


def enforce_daily_budget(model: str, *, input_token_ceiling: int, output_token_ceiling: int) -> None:
    """Refuse a request that would take today's LLM spend over LLM_DAILY_BUDGET_EUR.

    Applies to every execution mode. Without any configured storage (local
    development and unit tests) there is no ledger to total and the check is
    skipped; production storage is already mandatory in reserve_llm_request.
    """
    settings = load_settings()
    since = _utc_day_start()
    try:
        if settings.get('supabase_db_url'):
            groups = _spend_groups_via_postgres(str(settings['supabase_db_url']), since)
        elif settings.get('supabase_url') and settings.get('supabase_service_role_key'):
            groups = _spend_groups_via_rest(settings, since)
        else:
            return
    except Exception as exc:
        raise LLMBudgetUnavailable('LLM daily budget could not be verified; request refused') from exc
    budget = llm_daily_budget_eur()
    spent = spent_today_eur(groups)
    request_cost = _request_cost_eur(model, max(0, input_token_ceiling), max(0, output_token_ceiling))
    if spent + request_cost > budget:
        raise PipelineBudgetExhausted(
            f'Daily LLM budget exhausted: {spent:.4f} EUR spent of {budget} EUR, '
            f'request needs up to {request_cost:.4f} EUR'
        )


def reserve_prediction(model: str, *, input_token_ceiling: int, output_token_ceiling: int) -> str | None:
    require_priced_model(model)
    enforce_daily_budget(
        model, input_token_ceiling=input_token_ceiling, output_token_ceiling=output_token_ceiling
    )
    run_id = os.getenv('PIPELINE_AUTONOMOUS_RUN_ID')
    if not run_id:
        return None
    from src.storage.supabase_client import _shared_postgres_connection
    try:
        with _shared_postgres_connection(str(load_settings()['supabase_db_url'])) as db:
            return str(db.execute(
                'select public.reserve_pipeline_prediction(%s,%s,%s,%s)',
                (run_id, model, input_token_ceiling, output_token_ceiling),
            ).fetchone()[0])
    except psycopg.errors.RaiseException as exc:
        message = exc.diag.message_primary or str(exc)
        if 'budget exhausted' in message:
            raise PipelineBudgetExhausted(message) from exc
        raise


def _token_counts(prediction: dict, metrics: dict) -> tuple[int, int] | None:
    counts = []
    for keys, label in (
        (('input_token_count', 'token_input_count'), 'Input token count'),
        (('output_token_count', 'token_output_count'), 'Output token count'),
    ):
        value = next((metrics[key] for key in keys if metrics.get(key) is not None), None)
        if value is None:
            match = re.search(rf'(?im)^\s*{re.escape(label)}:\s*(\d+)\b', str(prediction.get('logs') or ''))
            value = int(match.group(1)) if match else None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            return None
        counts.append(int(value))
    return counts[0], counts[1]


def _prediction_cost(model: str, prediction: dict, metrics: dict) -> tuple[Decimal | None, str | None]:
    if model == PINNED_MODEL:
        seconds = metrics.get('predict_time')
        return (Decimal(str(seconds)) * Decimal('0.000975') if seconds is not None else None, RATE_SOURCE)
    prices = TOKEN_PRICES.get(model)
    if prices is None:
        return None, None
    counts = _token_counts(prediction, metrics)
    if counts is None:
        return None, prices[2]
    metrics['input_token_count'], metrics['output_token_count'] = counts
    return (Decimal(counts[0]) * prices[0] + Decimal(counts[1]) * prices[1]) / Decimal(1_000_000), prices[2]


def record_prediction(prediction: dict, *, reservation: str | None = None, model: str | None = None) -> None:
    run_id = os.getenv('PIPELINE_AUTONOMOUS_RUN_ID')
    if not run_id:
        return
    from src.storage.supabase_client import _shared_postgres_connection
    metrics = {key:value for key,value in (prediction.get('metrics') or {}).items()
               if key in {'predict_time','total_time','input_token_count','output_token_count','image_count',
                          'token_input_count','token_output_count'}
               and isinstance(value,(int,float)) and math.isfinite(value) and value>=0}
    model = model or str(prediction.get('model') or PINNED_MODEL)
    cost, rate_source = _prediction_cost(model, prediction, metrics)
    with _shared_postgres_connection(str(load_settings()['supabase_db_url'])) as db:
        db.execute("""update public.auction_pipeline_usage set prediction_id=coalesce(%s,prediction_id),
          status=%s,metrics=%s,estimated_usd=case when model=%s then coalesce(%s::numeric,estimated_usd) else estimated_usd end,
          rate_source=coalesce(%s,rate_source),updated_at=now() where run_id=%s and (id=%s or prediction_id=%s)""",
          (prediction.get('id'),prediction.get('status') or 'unknown',Jsonb(metrics),model,cost,
           rate_source,run_id,reservation,prediction.get('id')))
