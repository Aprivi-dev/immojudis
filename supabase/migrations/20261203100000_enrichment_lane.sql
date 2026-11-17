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
-- RETOUR ARRIÈRE : réappliquer le corps de 20260929153000, retouché par 20260929235500 et 20261016100000 (md5 de
-- départ ci-dessous). Les exécutions de file déjà lancées gardent running_lease_seconds dans leur résumé, que
-- l'ancien corps ignore (bail de 3 600 s) : n'appliquer le retour arrière qu'après la fin de l'unité en cours.

-- Garde de départ : empreinte md5 du corps en place (pg_proc.prosrc), vérifiée en rejouant toutes les migrations
-- depuis zéro sur une base jetable, ou celle de cette migration (migration rejouée). Tout autre corps fait échouer
-- la migration au lieu d'écraser une modification faite hors migration.
do $guard$
declare
  claim_md5 text := (
    select md5(procedure_row.prosrc)
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = 'public.claim_autonomous_pipeline_run()'::regprocedure
  );
begin
  if claim_md5 not in (
    '0ee8bdb4cd09923283f3f3a357852b0f',  -- 20261016100000 et ses prédécesseurs (point de départ)
    '29fb0e896e8b0ee0332d0ed98853363a'   -- cette migration, déjà appliquée
  ) then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected autonomous scheduler body (md5 %s); refusing the separate enrichment lane.', claim_md5
      );
  end if;
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

revoke all on function public.claim_autonomous_pipeline_run() from public,anon,authenticated;
grant execute on function public.claim_autonomous_pipeline_run() to service_role;

notify pgrst, 'reload schema';

commit;
