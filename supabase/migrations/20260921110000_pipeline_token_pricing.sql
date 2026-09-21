begin;

-- The two-argument function remains the compatibility path for the pinned
-- Qwen2 reservation.  Token-priced models use a separate overload so an
-- existing caller cannot accidentally change the pricing semantics of an
-- already deployed rollout.
create or replace function public.reserve_pipeline_prediction(
  p_run_id uuid,
  p_model text,
  p_input_token_ceiling integer,
  p_output_token_ceiling integer
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cap integer;
  v_daily_budget numeric;
  v_reservation uuid;
  v_reserved_usd numeric;
  v_input_rate numeric;
  v_output_rate numeric;
  v_rate_source text;
begin
  -- Keep the legacy hardware-priced reservation unchanged, including its
  -- original validation and default reserved_usd amount.
  if p_model = 'zsxkib/qwen2-7b-instruct:5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4' then
    return public.reserve_pipeline_prediction(p_run_id, p_model);
  end if;

  if p_model = 'qwen/qwen3-7-plus' then
    -- Replicate has a higher Qwen input tier above 256K tokens.  Keep this
    -- reservation on the documented lower tier until that tier is explicitly
    -- priced and supported by the caller.
    if p_input_token_ceiling is null or p_input_token_ceiling < 1 or p_input_token_ceiling > 262144 then
      raise exception 'Input token ceiling must be between 1 and 262144 for Qwen3.7 Plus'
        using errcode = '22023';
    end if;
    v_input_rate := 0.276;
    v_output_rate := 1.101;
    v_rate_source := 'https://replicate.com/qwen/qwen3-7-plus; checked 2026-09-21';
  elsif p_model = 'google/gemini-2.5-flash' then
    -- Keep every token reservation finite.  This is below the provider's
    -- advertised context limit and bounds the amount committed to one call.
    if p_input_token_ceiling is null or p_input_token_ceiling < 1 or p_input_token_ceiling > 1048576 then
      raise exception 'Input token ceiling must be between 1 and 1048576 for Gemini 2.5 Flash'
        using errcode = '22023';
    end if;
    v_input_rate := 0.30;
    v_output_rate := 2.50;
    v_rate_source := 'https://replicate.com/google/gemini-2.5-flash; checked 2026-09-21';
  else
    raise exception 'Automatic AI model has no configured cost reservation';
  end if;

  if p_output_token_ceiling is null or p_output_token_ceiling < 1 or p_output_token_ceiling > 32768 then
    raise exception 'Output token ceiling must be between 1 and 32768'
      using errcode = '22023';
  end if;

  v_reserved_usd := (
    p_input_token_ceiling::numeric * v_input_rate
    + p_output_token_ceiling::numeric * v_output_rate
  ) / 1000000;

  -- Serialize the per-run count and UTC daily spend check with the insert.
  perform pg_advisory_xact_lock(hashtextextended('immojudis-prediction-budget', 0));

  if not exists (
    select 1
    from public.auction_runs
    where id = p_run_id
      and scheduler_owned
      and status = 'running'
  ) then
    raise exception 'No active autonomous execution';
  end if;

  select max_ai_predictions_per_run, daily_ai_budget_usd
    into v_cap, v_daily_budget
  from public.auction_pipeline_control
  where id;

  if (select count(*) from public.auction_pipeline_usage where run_id = p_run_id) >= v_cap then
    raise exception 'AI prediction budget exhausted for this execution';
  end if;

  if coalesce((
    select sum(coalesce(estimated_usd, reserved_usd))
    from public.auction_pipeline_usage
    where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
  ), 0) + v_reserved_usd > v_daily_budget then
    raise exception 'Daily AI budget exhausted; pending documents retained';
  end if;

  insert into public.auction_pipeline_usage (
    run_id,
    model,
    reserved_usd,
    rate_source
  ) values (
    p_run_id,
    p_model,
    v_reserved_usd,
    v_rate_source
  )
  returning id into v_reservation;

  return v_reservation;
end;
$$;

revoke all on function public.reserve_pipeline_prediction(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_pipeline_prediction(uuid, text, integer, integer)
  to service_role;

create or replace function public.pipeline_usage_summary()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'day_utc', (now() at time zone 'UTC')::date,
    'ai_requests', count(*),
    'ai_estimated_usd', coalesce(sum(estimated_usd), 0),
    'ai_unpriced_requests', count(*) filter (where estimated_usd is null),
    'ai_reserved_usd', coalesce(sum(coalesce(estimated_usd, reserved_usd)), 0),
    'daily_ai_budget_usd', (select daily_ai_budget_usd from public.auction_pipeline_control where id),
    'runner_seconds', (
      select coalesce(sum((summary->>'execution_seconds')::numeric), 0)
      from public.auction_runs
      where scheduler_owned
        and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    ),
    'rate_source', concat_ws(
      '; ',
      'https://replicate.com/pricing#hardware; L40S 0.000975 USD/s; checked 2026-09-12',
      'https://replicate.com/qwen/qwen3-7-plus; input 0.276 USD/M, output 1.101 USD/M; checked 2026-09-21',
      'https://replicate.com/google/gemini-2.5-flash; input 0.30 USD/M, output 2.50 USD/M; checked 2026-09-21'
    )
  )
  from public.auction_pipeline_usage
  where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
$$;

revoke all on function public.pipeline_usage_summary() from public, anon, authenticated;
grant execute on function public.pipeline_usage_summary() to service_role;

commit;
