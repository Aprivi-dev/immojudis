begin;

-- Lecture des pièces par l'API Anthropic (lot V1, mode fantôme) : Claude Haiku 5.5 (lecteur principal) et
-- Claude Sonnet 5.5 (second lecteur) entrent dans la grille des réservations. Jumelle de TOKEN_PRICES et
-- TOKEN_PRICE_INPUT_LIMITS (services/data-pipeline/src/pipeline_usage.py) : changer l'une, c'est changer
-- l'autre ; la base fait foi car c'est elle qui réserve le budget. Un dollar est compté pour un euro.
--
-- La réflexion adaptative est facturée en sortie : elle tient dans max_tokens, le plafond de sortie réservé,
-- toujours borné à 32 768 jetons comme pour les autres modèles.
--
-- Redéfinition complète du corps de 20261203100000 (plafond par tranche de 30 minutes, budget quotidien) :
-- seules les deux branches de prix sont ajoutées.
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
as $function$
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
    if p_input_token_ceiling is null or p_input_token_ceiling < 1 or p_input_token_ceiling > 256000 then
      raise exception 'Input token ceiling must be between 1 and 256000 for Qwen3.7 Plus'
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
  elsif p_model = 'claude-haiku-5-5' then
    -- Au-delà de 100 000 jetons d'entrée, la requête entière passe à 0,50 / 2,50 : ce palier n'est pas
    -- réservé, comme le palier haut de Qwen.
    if p_input_token_ceiling is null or p_input_token_ceiling < 1 or p_input_token_ceiling > 100000 then
      raise exception 'Input token ceiling must be between 1 and 100000 for Claude Haiku 5.5'
        using errcode = '22023';
    end if;
    v_input_rate := 0.10;
    v_output_rate := 0.50;
    v_rate_source := 'https://platform.claude.com/docs/en/about-claude/pricing; prompts up to 100,000 tokens; checked 2026-11-21';
  elsif p_model = 'claude-sonnet-5-5' then
    -- Borne de réservation par appel (le second lecteur ne relit que quelques pages), pas la limite du modèle.
    if p_input_token_ceiling is null or p_input_token_ceiling < 1 or p_input_token_ceiling > 1048576 then
      raise exception 'Input token ceiling must be between 1 and 1048576 for Claude Sonnet 5.5'
        using errcode = '22023';
    end if;
    v_input_rate := 2;
    v_output_rate := 10;
    v_rate_source := 'https://platform.claude.com/docs/en/about-claude/pricing; checked 2026-11-21';
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

  -- Plafond par tranche de 30 minutes d'une exécution (20261203100000) : une unité de la file enchaîne des
  -- passages d'environ 30 minutes ; chacun garde le plafond d'un passage d'avant. Budget quotidien inchangé.
  if (select count(*) from public.auction_pipeline_usage
       where run_id = p_run_id and created_at >= now() - interval '30 minutes') >= v_cap then
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
$function$;

revoke all on function public.reserve_pipeline_prediction(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_pipeline_prediction(uuid, text, integer, integer)
  to service_role;

-- Même résumé que 20260921110000, avec les sources des deux nouveaux prix.
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
      'https://replicate.com/google/gemini-2.5-flash; input 0.30 USD/M, output 2.50 USD/M; checked 2026-09-21',
      'https://platform.claude.com/docs/en/about-claude/pricing; claude-haiku-5-5 input 0.10 USD/M, output 0.50 USD/M up to 100,000 input tokens; checked 2026-11-21',
      'https://platform.claude.com/docs/en/about-claude/pricing; claude-sonnet-5-5 input 2 USD/M, output 10 USD/M; checked 2026-11-21'
    )
  )
  from public.auction_pipeline_usage
  where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
$$;

revoke all on function public.pipeline_usage_summary() from public, anon, authenticated;
grant execute on function public.pipeline_usage_summary() to service_role;

commit;
