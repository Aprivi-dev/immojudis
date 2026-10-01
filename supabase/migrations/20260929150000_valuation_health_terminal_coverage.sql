begin;

-- An exhausted queue can contain valid terminal insufficient_data outcomes.
-- Keep estimate coverage as a diagnostic, but measure worker health against
-- processed outcomes so missing comparables do not masquerade as stalled work.
create or replace function public.evaluate_market_valuation_health(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  total_count integer;
  served_count integer;
  processed_count integer;
  insufficient_count integer;
  actionable_count integer;
  due_count integer;
  oldest_due_seconds integer;
  recent_failure_count integer;
  coverage_pct numeric;
  processed_pct numeric;
  details jsonb;
begin
  select
    count(*)::integer,
    count(*) filter (where estimate is not null)::integer,
    count(*) filter (
      where (status = 'ready' and estimate is not null)
        or status = 'insufficient_data'
    )::integer,
    count(*) filter (where status = 'insufficient_data')::integer,
    count(*) filter (where estimate is not null and actionable)::integer,
    count(*) filter (where next_refresh_at <= p_now)::integer,
    coalesce(max(extract(epoch from (p_now - next_refresh_at))) filter (
      where next_refresh_at <= p_now
    ), 0)::integer
  into total_count, served_count, processed_count, insufficient_count,
       actionable_count, due_count, oldest_due_seconds
  from public.auction_sale_market_estimates;

  select count(*)::integer into recent_failure_count
  from public.valuation_estimate_attempts
  where outcome = 'failed'
    and created_at >= p_now - interval '1 hour';

  coverage_pct := case
    when total_count = 0 then 0
    else round((served_count::numeric / total_count::numeric) * 100, 1)
  end;
  processed_pct := case
    when total_count = 0 then 0
    else round((processed_count::numeric / total_count::numeric) * 100, 1)
  end;
  details := jsonb_build_object(
    'total', total_count,
    'served', served_count,
    'without_estimate', total_count - served_count,
    'insufficient_data', insufficient_count,
    'processed', processed_count,
    'processed_pct', processed_pct,
    'actionable', actionable_count,
    'coverage_pct', coverage_pct,
    'due', due_count,
    'oldest_due_seconds', oldest_due_seconds,
    'failed_last_hour', recent_failure_count
  );

  perform app_private.sync_operational_alert(
    'valuation.queue.degraded',
    'valuation',
    case
      when processed_pct < 75 or oldest_due_seconds > 3600 then 'critical'
      else 'warning'
    end,
    details,
    total_count > 0 and (
      processed_pct < 95
      or oldest_due_seconds > 900
      or recent_failure_count > 5
    ),
    p_now
  );

  return details;
end;
$$;

revoke all on function public.evaluate_market_valuation_health(timestamptz)
from public, anon, authenticated;
grant execute on function public.evaluate_market_valuation_health(timestamptz)
to service_role;

comment on function public.evaluate_market_valuation_health(timestamptz) is
  'Separates estimate coverage from processed valuation outcomes; valid insufficient-data rows do not indicate a stalled queue.';

commit;
