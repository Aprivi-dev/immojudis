"""Meter predictions without retaining prompts, outputs, logs or credentials."""
from __future__ import annotations

import math
import os
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal

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


class PipelineBudgetExhausted(RuntimeError):
    def __init__(self, message: str):
        super().__init__(message)
        now = datetime.now(UTC)
        self.next_attempt_at = (now+timedelta(days=1)).replace(hour=0,minute=0,second=0,microsecond=0) if 'Daily' in message else now+timedelta(minutes=30)


def defer_budget_jobs(jobs: list, error: PipelineBudgetExhausted) -> None:
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


def reserve_prediction(model: str, *, input_token_ceiling: int, output_token_ceiling: int) -> str | None:
    run_id = os.getenv('PIPELINE_AUTONOMOUS_RUN_ID')
    if not run_id:
        return None
    from src.storage.supabase_client import _postgres_connect
    try:
        with _postgres_connect(str(load_settings()['supabase_db_url'])) as db:
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
    from src.storage.supabase_client import _postgres_connect
    metrics = {key:value for key,value in (prediction.get('metrics') or {}).items()
               if key in {'predict_time','total_time','input_token_count','output_token_count',
                          'token_input_count','token_output_count'}
               and isinstance(value,(int,float)) and math.isfinite(value) and value>=0}
    model = model or str(prediction.get('model') or PINNED_MODEL)
    cost, rate_source = _prediction_cost(model, prediction, metrics)
    with _postgres_connect(str(load_settings()['supabase_db_url'])) as db:
        db.execute("""update public.auction_pipeline_usage set prediction_id=coalesce(%s,prediction_id),
          status=%s,metrics=%s,estimated_usd=case when model=%s then coalesce(%s::numeric,estimated_usd) else estimated_usd end,
          rate_source=coalesce(%s,rate_source),updated_at=now() where run_id=%s and (id=%s or prediction_id=%s)""",
          (prediction.get('id'),prediction.get('status') or 'unknown',Jsonb(metrics),model,cost,
           rate_source,run_id,reservation,prediction.get('id')))
