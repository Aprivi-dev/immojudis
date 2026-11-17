begin;

set local lock_timeout = '5s';

-- Voie d'enrichissement séparée des collectes (décision du propriétaire du 17/11/2026, étape 1 sur 3).
--
-- Mesure du 16-17/11 : le travailleur de la file (source enrichment-queue) a tourné 8 h 24 sur 24 h, les collectes
-- 3 h 30, et rien le reste du temps. Une seule unité tournait à la fois : chaque passage d'environ 30 min, plus le
-- démarrage du workflow, manquait le passage suivant d'operational-health (toutes les 30 min) et laissait le créneau
-- vide une demi-heure.
--
-- public.claim_autonomous_pipeline_run() répartit désormais deux voies, chacune avec au plus une exécution active :
--
-- * collectes : une exécution d'enrichissement active ne les retient plus (avant : la file passait devant une source
--   en retard de moins d'une heure, et une source attendait la fin de l'unité). Une exécution manuelle retient
--   toujours tout le planificateur ;
-- * file d'enrichissement : elle est lancée même pendant une collecte. Elle ne travaille pourtant jamais en même temps
--   qu'elle (services/data-pipeline/src/collection_priority.py) : le travailleur ne prend plus de lot dès qu'une
--   collecte est demandée, l'unité attend la fin de la collecte, et la collecte attend le verrou des écritures du
--   catalogue avant de démarrer. Les écritures du catalogue restent sous ce verrou, pris par le travailleur pour
--   chaque passage (src/queued_runner.py, run_with_catalogue_lock).
--
-- Un appel rend au plus une unité : une nouvelle tentative de lancement d'abord (chaque voie la sienne), puis une
-- collecte due, puis la file. Le site appelle une fois par voie à chaque passage (src/lib/pipeline-dispatch.ts).
--
-- Bail d'exécution de la file : 7 200 s (au lieu de 3 600 s), écrit dans le résumé de l'exécution
-- (running_lease_seconds) et relu par l'expiration des baux, seul endroit où la valeur est écrite. L'unité de la voie
-- séparée travaille jusqu'à ce bail moins 15 minutes (ENRICHMENT_LEASE_MARGIN_SECONDS, src/autonomous_runner.py),
-- soit 105 minutes : avec le démarrage du workflow (~5 min), elle se termine avant le quatrième passage
-- d'operational-health (120 min), qui lance la suivante. Les collectes gardent 3 600 s.
--
-- Les admissions de fiches dues (enqueue_due_source_details) ont lieu dès qu'une voie est libre : la file travaille
-- presque en continu et doit les recevoir pendant ce temps. Une seule voie occupée ne les saute plus.
--
-- La file reste soumise à sa cadence (next_enrichment_at, 30 min) et au mode de vidage borné (enrichment_drain_until).
-- app_private.pipeline_queue_should_preempt_source n'est plus appelée (plus d'arbitrage entre les deux voies) ; elle
-- reste en place, comme le compteur source_dispatch_streak, pour un retour arrière.
--
-- ORDRE DE DÉPLOIEMENT : indifférent.
-- * Code (site, workflow, pipeline) avant la migration : l'ancienne fonction ne rend qu'une unité à la fois, le
--   second appel du site ne rend rien ; une exécution de file sans running_lease_seconds fait un seul passage, comme
--   avant.
-- * Migration avant le code : l'ancien site n'appelle qu'une fois par passage et lance la file sans enrichment_only,
--   dans le groupe des collectes : collecte et file s'y suivent, sans écritures simultanées ; l'ancien lanceur fait un
--   seul passage de file, sous le bail de 7 200 s.
--
-- Plafond IA par exécution (reserve_pipeline_prediction, deux surcharges) compté sur 30 minutes glissantes, et
-- pipeline.import.unhealthy (app_private.evaluate_operational_health) qui ne compte plus une collecte en pré-attente :
-- voir les sections correspondantes plus bas.
--
-- RETOUR ARRIÈRE : d'abord la variable de dépôt ENRICHMENT_LANE=off (sans commit). Retour complet :
-- supabase/maintenance/20261203100000_restore_pipeline_scheduler_before_lanes.sql, qui remet les corps exacts de
-- départ des quatre fonctions (claim_autonomous_pipeline_run : 20260929153000 retouchée par 20260929235500,
-- 20261001070853 et 20261016100000 ; md5 de départ ci-dessous) et le vérifie. À lancer quand aucune unité de file ne
-- tourne : l'ancien corps ignore running_lease_seconds (bail de 3 600 s).

-- Gardes de départ, toutes ici, avant toute écriture : empreinte md5 du corps en place (pg_proc.prosrc), vérifiée en rejouant toutes les migrations
-- depuis zéro sur une base jetable, ou celle de cette migration (migration rejouée). Tout autre corps fait échouer
-- la migration au lieu d'écraser une modification faite hors migration.
do $guard$
declare
  found_md5 text;
  expected record;
begin
  for expected in
    select * from (values
      -- (signature, point de départ vérifié par rejeu depuis zéro, cette migration déjà appliquée)
      ('public.claim_autonomous_pipeline_run()',
        '0ee8bdb4cd09923283f3f3a357852b0f', '29fb0e896e8b0ee0332d0ed98853363a'),
      ('public.reserve_pipeline_prediction(uuid,text)',
        'e02842aa56a1915843d3d7ba8501778b', '1b4c820c5bac83affc7eddfc1e5bd3f2'),
      ('public.reserve_pipeline_prediction(uuid,text,integer,integer)',
        'c5db331db33b54c40d38e88b9d27244e', 'f76b0e91b21d18342d47979c099cf97d'),
      ('app_private.evaluate_operational_health(timestamptz)',
        'a3ffbb215334372e19ab6cc250d2e3f3', 'fe8e2c373948e17727c15898b6fbaca3')
    ) as t(signature, start_md5, applied_md5)
  loop
    select md5(procedure_row.prosrc) into found_md5
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = expected.signature::regprocedure;
    if found_md5 is distinct from expected.start_md5 and found_md5 is distinct from expected.applied_md5 then
      raise exception using
        errcode = '55000',
        message = format(
          'Unexpected body for %s (md5 %s); refusing the separate enrichment lane.', expected.signature, found_md5
        );
    end if;
  end loop;
end;
$guard$;

create or replace function public.claim_autonomous_pipeline_run()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  chosen text;
  queue_due boolean;
  drain_active boolean;
  run_uuid uuid;
  worker_due timestamptz;
  drain_until timestamptz;
  collection_busy boolean;
  enrichment_busy boolean;
  retry_run record;
  dispatch jsonb;
  dispatch_state text;
  dispatch_attempt integer;
  dispatch_max_attempts integer;
  dispatch_next_at timestamptz;
  dispatch_lease_until timestamptz;
  dispatch_lease_text text;
  now_at timestamptz := statement_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtextextended('immojudis-pipeline-dispatch',0)) then return null; end if;
  select next_enrichment_at, enrichment_drain_until
    into worker_due, drain_until
    from public.auction_pipeline_control
   where id and enabled for update;
  if not found then return null; end if;
  drain_active := drain_until is not null and drain_until > now_at;

  -- A manual run keeps the legacy 190-minute lease.  A running automatic
  -- worker keeps the execution lease written in its summary at claim time
  -- (running_lease_seconds: the enrichment lane), 60 minutes otherwise.  A
  -- queued automatic run uses the dispatch lease recorded in its summary, so a
  -- long Retry-After or an accepted workflow cannot be expired before the next
  -- scheduler decision.
  update public.auction_runs r set status='failed',finished_at=now_at,updated_at=now_at,
    summary=coalesce(r.summary,'{}') || '{"completion_status":"lease_expired"}',
    errors=coalesce(r.errors,'{}') || '{"runner":["Execution lease expired; committed batches preserved"]}'
  where r.status in ('queued','running')
    and (
      (not r.scheduler_owned and coalesce(r.started_at,r.created_at) <
        now_at-interval '190 minutes')
      or (r.scheduler_owned and r.status='running' and
        coalesce(r.started_at,r.created_at) < now_at-make_interval(secs => case
          when r.summary->>'running_lease_seconds' ~ '^[1-9][0-9]{0,5}$'
            then (r.summary->>'running_lease_seconds')::integer
          else 3600
        end))
      or (r.scheduler_owned and r.status='queued' and
        case
          when r.summary #>> '{github_dispatch,lease_until}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
            then (r.summary #>> '{github_dispatch,lease_until}')::timestamptz
          else coalesce(r.created_at,now_at)+interval '60 minutes'
        end < now_at
        )
    );

  -- A manual run keeps the whole scheduler blocked, as before the lanes.
  if exists(
    select 1 from public.auction_runs r
     where r.status in ('queued','running') and not r.scheduler_owned
  ) then
    return null;
  end if;

  -- Reclaim an existing automatic row for a retry, whatever its lane.  The row
  -- lock and the advisory lock make the increment a compare-and-set for
  -- scheduler ticks.
  for retry_run in
    select r.id,r.source,r.created_at,coalesce(r.summary,'{}') as summary
      from public.auction_runs r
     where r.status='queued' and r.scheduler_owned
     order by r.created_at,r.id
     for update
  loop
    dispatch := coalesce(retry_run.summary->'github_dispatch','{}'::jsonb);
    dispatch_state := coalesce(dispatch->>'state','legacy');
    dispatch_max_attempts := least(case
      when coalesce(dispatch->>'max_attempts','') ~ '^[1-9][0-9]*$'
        then (dispatch->>'max_attempts')::integer
      else 4
    end,4);
    dispatch_attempt := case
      when coalesce(dispatch->>'attempt','') ~ '^[0-9]+$'
        then (dispatch->>'attempt')::integer
      -- A queued automatic row created by the previous migration already
      -- represents an initial dispatch attempt, although it has no metadata.
      else case when dispatch_state='legacy' then 1 else 0 end
    end;
    dispatch_next_at := case
      when dispatch->>'next_attempt_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
        then (dispatch->>'next_attempt_at')::timestamptz
      else case when dispatch_state='legacy' then
        coalesce(retry_run.created_at,now_at)+interval '15 minutes'
      end
    end;

    if dispatch_state in ('accepted','terminal','exhausted')
      or dispatch_attempt >= dispatch_max_attempts
      or dispatch_next_at is null or dispatch_next_at > now_at then
      continue;
    end if;

    dispatch_attempt := dispatch_attempt + 1;
    dispatch_lease_text := dispatch->>'lease_until';
    dispatch_lease_until := case
      when dispatch_lease_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
        then greatest(dispatch_lease_text::timestamptz,now_at+interval '60 minutes')
      else now_at+interval '60 minutes'
    end;
    dispatch := dispatch || jsonb_build_object(
      'version',1,
      'attempt',dispatch_attempt,
      'max_attempts',dispatch_max_attempts,
      'state','in_flight',
      'attempt_started_at',now_at,
      -- This default also covers an HTTP timeout before the result RPC can
      -- persist the actual Retry-After value.
      'next_attempt_at',now_at+interval '15 minutes',
      'lease_until',dispatch_lease_until
    );
    update public.auction_runs set summary=retry_run.summary ||
        jsonb_build_object('github_dispatch',dispatch),updated_at=now_at
      where id=retry_run.id and status='queued';
    return jsonb_build_object('id',retry_run.id,'source',retry_run.source,
      'mode',case when retry_run.source='enrichment-queue' then 'enrichment' else 'collect' end,
      'attempt',dispatch_attempt,'max_attempts',dispatch_max_attempts);
  end loop;

  -- Each lane keeps at most one active automatic run.
  select
    coalesce(bool_or(r.source is distinct from 'enrichment-queue'),false),
    coalesce(bool_or(r.source='enrichment-queue'),false)
    into collection_busy, enrichment_busy
    from public.auction_runs r
   where r.status in ('queued','running') and r.scheduler_owned;
  if collection_busy and enrichment_busy then return null; end if;

  perform public.enqueue_due_source_details(now_at,500);

  if not collection_busy then
    update public.auction_source_state s set next_inventory_at=least(s.next_inventory_at,now_at)
      from public.auction_runs r where r.id=s.last_run_id and r.summary->>'completion_status'='lease_expired';
    select source_name into chosen
      from public.auction_source_state
      where enabled and (suspended_until is null or suspended_until<=now_at) and next_inventory_at<=now_at
      order by next_inventory_at,source_name limit 1 for update skip locked;
    if chosen is not null then
      insert into public.auction_runs(status,source,use_llm,scheduler_owned,summary,errors)
        values('queued',chosen,false,true,
          jsonb_build_object('trigger','autonomous','mode','collect',
            'github_dispatch',jsonb_build_object(
              'version',1,'attempt',1,'max_attempts',4,'state','in_flight',
              'attempt_started_at',now_at,
              'next_attempt_at',now_at+interval '15 minutes',
              'lease_until',now_at+interval '60 minutes')),'{}')
        returning id into run_uuid;
      update public.auction_source_state set last_run_id=run_uuid,last_attempt_at=now_at,
        next_inventory_at=now_at+interval '12 hours',updated_at=now_at where source_name=chosen;
      update public.auction_pipeline_control set last_dispatch_at=now_at,updated_at=now_at where id;
      return jsonb_build_object('id',run_uuid,'source',chosen,'mode','collect','attempt',1,'max_attempts',4);
    end if;
  end if;

  if enrichment_busy then return null; end if;

  -- During the bounded maintenance window the queue may use every scheduler
  -- tick with available work, even though its normal cadence was advanced by
  -- the previous queue claim.
  queue_due := (
    (worker_due <= now_at or drain_active)
    and exists(
      -- Match the claim housekeeping winner before applying its admission
      -- predicate; an older due revision must never wake an empty worker.
      with ranked as materialized (
        select id,
               row_number() over (
                 partition by source_url, job_type, detail_source_name, detail_source_url
                 order by created_at desc,
                          (input_hash like 'pipeline_v2:%') desc,
                          id desc
               ) as revision_rank
          from public.auction_enrichment_jobs
         where status <> 'cancelled'
      ), eligible as (
        select j.id
          from public.auction_enrichment_jobs j
          join ranked revision
            on revision.id = j.id
           and revision.revision_rank = 1
          join public.auction_sales s
            on s.source_url = j.source_url
         where (
                 j.status in ('queued','failed')
                 or (
                      j.status = 'running'
                      and coalesce(j.locked_at,j.updated_at)
                          < now_at - interval '30 minutes'
                    )
               )
           and j.next_attempt_at <= now_at
           and j.attempt_count < j.max_attempts
           and (
             j.job_type <> 'source_detail'
             or (
               exists (
                 select 1
                   from public.auction_pipeline_control c
                  where c.id and c.enabled and c.source_details_enabled
               )
               and exists (
                 select 1
                   from public.auction_source_state state
                  where state.source_name = j.detail_source_name
                    and state.enabled
                    and (state.suspended_until is null or state.suspended_until <= now_at)
               )
             )
           )
           and s.status in ('active','unknown','upcoming','postponed','past')
           and s.retention_deadline_materialized
           and (s.retention_deadline is null or s.retention_deadline > now_at)
           and not exists (
             select 1
               from public.auction_enrichment_jobs active
              where active.source_url = j.source_url
                and active.status = 'running'
                and coalesce(active.locked_at,active.updated_at)
                    >= now_at - interval '30 minutes'
           )
      )
      select 1 from eligible
    )
  );

  if not queue_due then
    if worker_due <= now_at then
      update public.auction_pipeline_control set next_enrichment_at=now_at+interval '30 minutes' where id;
    end if;
    return null;
  end if;

  insert into public.auction_runs(status,source,use_llm,scheduler_owned,summary,errors)
    values('queued','enrichment-queue',false,true,
      jsonb_build_object('trigger','autonomous','mode','enrichment',
        -- Seule valeur du bail d'exécution de la voie d'enrichissement : relue par l'expiration des baux
        -- ci-dessus et par l'unité (src/autonomous_runner.py), qui s'arrête 15 minutes avant.
        'running_lease_seconds',7200,
        'github_dispatch',jsonb_build_object(
          'version',1,'attempt',1,'max_attempts',4,'state','in_flight',
          'attempt_started_at',now_at,
          'next_attempt_at',now_at+interval '15 minutes',
          'lease_until',now_at+interval '60 minutes')),'{}')
    returning id into run_uuid;
  update public.auction_pipeline_control set next_enrichment_at=now_at+interval '30 minutes',
    last_dispatch_at=now_at,updated_at=now_at where id;
  return jsonb_build_object('id',run_uuid,'source','enrichment-queue','mode','enrichment',
    'attempt',1,'max_attempts',4);
end;
$$;

-- Plafond d'appels IA par exécution (max_ai_predictions_per_run, 90) : compté sur les 30 dernières minutes de
-- l'exécution au lieu de toute sa durée. Un passage d'avant durait ~30 min (24 appels en moyenne, 39 au plus sur
-- 56 passages) ; une unité de la file en enchaîne ~3,5 et aurait buté sur 90 (« AI prediction budget exhausted
-- for this execution », report de 30 min que l'observation ne compte pas comme budget). Le budget quotidien
-- (daily_ai_budget_usd) et le plafond horaire (reserve_llm_request) restent les garde-fous globaux, inchangés.
-- Redéfinitions complètes des deux surcharges (corps en place recopiés, seule la fenêtre de comptage change).
CREATE OR REPLACE FUNCTION public.reserve_pipeline_prediction(p_run_id uuid, p_model text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare cap integer; daily_budget numeric; reservation uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('immojudis-prediction-budget',0));
  if not exists(select 1 from public.auction_runs where id=p_run_id and scheduler_owned and status='running') then
    raise exception 'No active autonomous execution';
  end if;
  select max_ai_predictions_per_run,daily_ai_budget_usd into cap,daily_budget from public.auction_pipeline_control where id;
  if (select count(*) from public.auction_pipeline_usage where run_id=p_run_id
      and created_at >= now() - interval '30 minutes')>=cap then
    raise exception 'AI prediction budget exhausted for this execution';
  end if;
  -- Pinned public L40S model, $0.000975/s checked 2026-09-12, maximum 5-minute prediction.
  -- https://replicate.com/zsxkib/qwen2-7b-instruct and https://replicate.com/pricing
  if p_model <> 'zsxkib/qwen2-7b-instruct:5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4' then
    raise exception 'Automatic AI model has no configured cost reservation';
  end if;
  if coalesce((select sum(coalesce(estimated_usd,reserved_usd)) from public.auction_pipeline_usage
      where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)+0.2925>daily_budget then
    raise exception 'Daily AI budget exhausted; pending documents retained';
  end if;
  insert into public.auction_pipeline_usage(run_id,model) values(p_run_id,p_model) returning id into reservation;
  return reservation;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_pipeline_prediction(p_run_id uuid, p_model text, p_input_token_ceiling integer, p_output_token_ceiling integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- pipeline.import.unhealthy : « un échec dans l'heure ET une exécution en file » ne compte plus que les exécutions
-- en file depuis plus de 30 minutes (une collecte attend en file le verrou du catalogue, 25 min au plus, à côté de
-- la voie de la file). Redéfinition complète du corps de 20261201100000 ; seuils d'âge (5 400 / 7 200 s) inchangés.
CREATE OR REPLACE FUNCTION app_private.evaluate_operational_health(p_now timestamp with time zone DEFAULT statement_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  stale_cron_jobs text[] := '{}'::text[];
  webhook_failure_count integer;
  webhook_stuck_count integer;
  import_failure_count integer;
  import_stuck_count integer;
  import_backlog_count integer;
  import_stale_backlog_count integer;
  oldest_import_age_seconds integer;
  refresh_backlog_count integer;
  oldest_refresh_age_seconds integer;
  dvf_batch_count bigint;
  dvf_transaction_count bigint;
  dvf_failed_since_last_success integer;
  dvf_stuck_count integer;
  dvf_last_completed_at timestamptz;
  retention_overdue_count integer;
  retention_oldest_overdue timestamptz;
  retention_passes_counted integer;
  retention_passes_remaining integer;
  invalidation_count integer;
  invalidation_oldest timestamptz;
  late_delivery_count integer;
  late_delivery_oldest timestamptz;
  snapshot_refreshed_at timestamptz;
  open_alert_count integer;
begin
  with expected(job_name, max_age) as (
    values
      ('operational-health', interval '65 minutes'),
      ('smart-alerts', interval '27 hours'),
      ('alert-notifications', interval '27 hours'),
      ('sale-change-monitor', interval '27 hours'),
      ('data-retention', interval '8 days'),
      ('sale-retention', interval '35 minutes'),
      ('information-agent-inbound', interval '25 minutes'),
      ('listing-completeness', interval '3 hours'), ('sale-pepites', interval '3 hours'), ('sale-flood-risk', interval '5 hours'),
      ('sale-reminders', interval '27 hours'), ('sale-results', interval '27 hours'), ('weekly-digest', interval '8 days'), ('fact-registry-check', interval '27 hours')
  )
  select coalesce(array_agg(expected.job_name order by expected.job_name), '{}'::text[])
  into stale_cron_jobs
  from expected
  where not exists (
    select 1
    from public.operational_job_runs run
    where run.job_name = expected.job_name
      and (
        (
          run.status = 'success'
          and run.finished_at >= p_now - expected.max_age
        )
        or (
          expected.job_name = 'operational-health'
          and run.status = 'running'
          and run.started_at >= p_now - interval '10 minutes'
        )
      )
  );

  select count(*)::integer into webhook_failure_count
  from public.stripe_webhook_events
  where processing_status = 'failed'
    and updated_at >= p_now - interval '1 hour';

  select count(*)::integer into webhook_stuck_count
  from public.stripe_webhook_events
  where processing_status = 'processing'
    and updated_at < p_now - interval '15 minutes';

  select count(*)::integer into import_failure_count
  from public.auction_runs
  where status = 'failed'
    and coalesce(finished_at, updated_at, created_at) >= p_now - interval '1 hour';

  select count(*)::integer into import_stuck_count
  from public.auction_runs
  where status = 'running'
    and started_at < p_now - interval '3 hours';

  select
    count(*)::integer,
    coalesce(max(extract(epoch from (p_now - created_at)))::integer, 0)
  into import_backlog_count, oldest_import_age_seconds
  from public.auction_runs
  where status = 'queued';

  -- Une collecte reste en file pendant sa pré-attente du verrou du catalogue (25 min au plus, 20261203100000) :
  -- seule une exécution en file depuis plus de 30 minutes accompagne un échec pour ouvrir l'alerte.
  select count(*)::integer into import_stale_backlog_count
  from public.auction_runs
  where status = 'queued'
    and created_at < p_now - interval '30 minutes';

  select
    count(*)::integer,
    coalesce(max(extract(epoch from (p_now - created_at)))::integer, 0)
  into refresh_backlog_count, oldest_refresh_age_seconds
  from public.data_refresh_requests
  where status in ('queued', 'running');

  select
    count(*)::bigint,
    max(completed_at) filter (where status = 'completed'),
    count(*) filter (
      where status = 'running' and created_at < p_now - interval '6 hours'
    )::integer
  into dvf_batch_count, dvf_last_completed_at, dvf_stuck_count
  from public.dvf_import_batches;

  select count(*)::integer
  into dvf_failed_since_last_success
  from public.dvf_import_batches
  where status = 'failed'
    and updated_at >= p_now - interval '24 hours'
    and (dvf_last_completed_at is null or updated_at > dvf_last_completed_at);

  select
    case
      when exists (select 1 from public.dvf_transactions limit 1)
        then greatest(coalesce(dvf_table.reltuples::bigint, 0), 1)
      else 0
    end
  into dvf_transaction_count
  from pg_catalog.pg_class dvf_table
  join pg_catalog.pg_namespace dvf_schema on dvf_schema.oid = dvf_table.relnamespace
  where dvf_schema.nspname = 'public'
    and dvf_table.relname = 'dvf_transactions';

  -- Ventes échues pas encore purgées (index partiel auction_sales_catalogue_expiry_deadline_idx).
  -- La lecture s'arrête à 1 001 lignes : le nombre exact n'importe pas au-delà.
  select count(*)::integer, min(overdue.deadline)
  into retention_overdue_count, retention_oldest_overdue
  from (
    select sale.catalogue_expiry_deadline as deadline
    from public.auction_sales sale
    where sale.catalogue_expiry_materialized
      and sale.catalogue_expiry_deadline is not null
      and sale.catalogue_expiry_deadline <= p_now
    order by sale.catalogue_expiry_deadline
    limit 1001
  ) overdue;

  -- Les six derniers passages de la purge (toutes les 5 minutes) : tous réussis, tous avec des ventes
  -- restantes (`remaining` du résultat de /api/cron/sale-retention).
  select
    count(*)::integer,
    count(*) filter (
      where passes.status = 'success'
        and case
          when pg_catalog.jsonb_typeof(passes.summary->'remaining') = 'number'
            then (passes.summary->>'remaining')::numeric
          else 0
        end > 0
    )::integer
  into retention_passes_counted, retention_passes_remaining
  from (
    select run.status, run.summary
    from public.operational_job_runs run
    where run.job_name = 'sale-retention'
    order by run.started_at desc
    limit 6
  ) passes;

  -- Boîte d'invalidation du cache public (app_private.catalogue_invalidations, index sur `at`).
  select count(*)::integer, min(pending.at)
  into invalidation_count, invalidation_oldest
  from (
    select box.at
    from app_private.catalogue_invalidations box
    order by box.at
    limit 1001
  ) pending;

  -- Notifications d'alerte prévues depuis plus de 26 h et toujours en file (index delivery_status,
  -- scheduled_for). Les envois sont quotidiens : un retard normal reste sous 24 h.
  select count(*)::integer, min(late.scheduled_for)
  into late_delivery_count, late_delivery_oldest
  from (
    select notification.scheduled_for
    from public.user_alert_notifications notification
    where notification.delivery_status = 'queued'
      and notification.scheduled_for < p_now - interval '26 hours'
    order by notification.scheduled_for
    limit 1001
  ) late;

  -- Cliché des lots des scénarios d'enchères (ligne unique ; absente = jamais rempli).
  select state.refreshed_at into snapshot_refreshed_at
  from app_private.auction_scenario_snapshot_state state;

  perform app_private.sync_operational_alert(
    'cron.stale',
    'cron',
    'critical',
    jsonb_build_object(
      'stale_job_count', cardinality(stale_cron_jobs),
      'stale_jobs', to_jsonb(stale_cron_jobs)
    ),
    cardinality(stale_cron_jobs) > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'stripe.webhook.unhealthy',
    'webhook',
    'critical',
    jsonb_build_object(
      'failed_last_hour', webhook_failure_count,
      'stuck_processing', webhook_stuck_count
    ),
    webhook_failure_count > 0 or webhook_stuck_count > 0,
    p_now
  );

  -- Un échec isolé avec une file vide se rattrape seul (le lanceur relance la source au passage
  -- suivant) : seuil à 3 échecs dans l'heure, ou dès un échec quand une file attend.
  perform app_private.sync_operational_alert(
    'pipeline.import.unhealthy',
    'import',
    case
      when import_stuck_count > 0 or oldest_import_age_seconds > 7200 then 'critical'
      else 'warning'
    end,
    jsonb_build_object(
      'failed_last_hour', import_failure_count,
      'stuck_running', import_stuck_count,
      'queued', import_backlog_count,
      'queued_over_30_minutes', import_stale_backlog_count,
      'oldest_queued_age_seconds', oldest_import_age_seconds,
      'failure_threshold', 3,
      'maximum_queued_age_seconds', 5400
    ),
    -- Âge de file : 5 400 s, soit 2 x la cadence de 30 min + un passage de ~29 min (20261201100000).
    import_failure_count >= 3
      or (import_failure_count > 0 and import_stale_backlog_count > 0)
      or import_stuck_count > 0
      or oldest_import_age_seconds > 5400,
    p_now
  );

  perform app_private.sync_operational_alert(
    'refresh_queue.stale',
    'refresh_queue',
    case when oldest_refresh_age_seconds > 7200 then 'critical' else 'warning' end,
    jsonb_build_object(
      'backlog', refresh_backlog_count,
      'oldest_age_seconds', oldest_refresh_age_seconds
    ),
    oldest_refresh_age_seconds > 1800,
    p_now
  );

  perform app_private.sync_operational_alert(
    'dvf.freshness',
    'dvf',
    case
      when dvf_transaction_count = 0
        or dvf_failed_since_last_success > 0
        or dvf_stuck_count > 0 then 'critical'
      else 'warning'
    end,
    jsonb_build_object(
      'transaction_count', dvf_transaction_count,
      'batch_count', dvf_batch_count,
      'last_completed_at', dvf_last_completed_at,
      'failed_since_last_success', dvf_failed_since_last_success,
      'stuck_running', dvf_stuck_count,
      'maximum_age_days', 220
    ),
    dvf_transaction_count = 0
      or dvf_last_completed_at is null
      or dvf_last_completed_at < p_now - interval '220 days'
      or dvf_failed_since_last_success > 0
      or dvf_stuck_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'retention.sale.overdue',
    'cron',
    'critical',
    jsonb_build_object(
      'overdue_count', retention_overdue_count,
      'oldest_overdue_at', retention_oldest_overdue,
      'oldest_overdue_age_minutes',
        case
          when retention_oldest_overdue is null then null
          else (extract(epoch from (p_now - retention_oldest_overdue)) / 60)::integer
        end,
      'passes_checked', retention_passes_counted,
      'passes_with_remaining', retention_passes_remaining,
      'maximum_age_hours', 2,
      'passes_threshold', 6
    ),
    (
      retention_oldest_overdue is not null
      and retention_oldest_overdue < p_now - interval '2 hours'
    )
      or (retention_passes_counted = 6 and retention_passes_remaining = 6),
    p_now
  );

  perform app_private.sync_operational_alert(
    'catalogue.invalidation.backlog',
    'import',
    'warning',
    jsonb_build_object(
      'pending_count', invalidation_count,
      'oldest_at', invalidation_oldest,
      'oldest_age_minutes',
        case
          when invalidation_oldest is null then null
          else (extract(epoch from (p_now - invalidation_oldest)) / 60)::integer
        end,
      'maximum_age_hours', 2,
      'maximum_count', 1000
    ),
    (invalidation_oldest is not null and invalidation_oldest < p_now - interval '2 hours')
      or invalidation_count > 1000,
    p_now
  );

  perform app_private.sync_operational_alert(
    'alerts.delivery.late',
    'cron',
    'warning',
    jsonb_build_object(
      'late_count', late_delivery_count,
      'oldest_scheduled_for', late_delivery_oldest,
      'maximum_delay_hours', 26
    ),
    late_delivery_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'auction_scenarios.snapshot.stale',
    'cron',
    'warning',
    jsonb_build_object(
      'refreshed_at', snapshot_refreshed_at,
      'age_hours',
        case
          when snapshot_refreshed_at is null then null
          else (extract(epoch from (p_now - snapshot_refreshed_at)) / 3600)::integer
        end,
      'maximum_age_days', 3
    ),
    snapshot_refreshed_at is null or snapshot_refreshed_at < p_now - interval '3 days',
    p_now
  );

  perform app_private.evaluate_flood_pepite_reference_health(p_now);
  perform app_private.evaluate_catalogue_duplicates_health(p_now);
  perform app_private.evaluate_catalogue_quality_health(p_now);

  select count(*)::integer into open_alert_count
  from public.operational_alerts
  where status = 'open';

  return jsonb_build_object(
    'ok', open_alert_count = 0,
    'open_alerts', open_alert_count,
    'stale_crons', cardinality(stale_cron_jobs),
    'stale_cron_jobs', to_jsonb(stale_cron_jobs),
    'webhook_failures', webhook_failure_count,
    'webhook_stuck', webhook_stuck_count,
    'import_failures', import_failure_count,
    'import_stuck', import_stuck_count,
    'import_backlog', import_backlog_count,
    'oldest_import_age_seconds', oldest_import_age_seconds,
    'refresh_backlog', refresh_backlog_count,
    'oldest_refresh_age_seconds', oldest_refresh_age_seconds,
    'dvf_transactions', dvf_transaction_count,
    'dvf_batches', dvf_batch_count,
    'dvf_last_completed_at', dvf_last_completed_at,
    'dvf_failed_since_last_success', dvf_failed_since_last_success,
    'dvf_stuck', dvf_stuck_count,
    'retention_overdue', retention_overdue_count,
    'catalogue_invalidations', invalidation_count,
    'late_alert_deliveries', late_delivery_count,
    'auction_scenario_snapshot_refreshed_at', snapshot_refreshed_at
  );
end;
$function$;

revoke all on function app_private.evaluate_operational_health(timestamptz) from public, anon, authenticated;
grant execute on function app_private.evaluate_operational_health(timestamptz) to service_role;

revoke all on function public.claim_autonomous_pipeline_run() from public,anon,authenticated;
grant execute on function public.claim_autonomous_pipeline_run() to service_role;

notify pgrst, 'reload schema';

commit;
