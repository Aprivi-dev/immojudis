begin;

-- Drain mode is an explicitly time-bounded maintenance override.  It keeps
-- the normal scheduler as the only writer: the existing autonomous claim RPC
-- still owns the pipeline advisory lock and still refuses to dispatch while a
-- previous automatic run is active.
alter table public.auction_pipeline_control
  add column if not exists enrichment_drain_until timestamptz;

comment on column public.auction_pipeline_control.enrichment_drain_until is
  'Optional maintenance window during which due enrichment work may use every scheduler tick; null or a past value keeps the normal cadence. Maximum future window: six hours.';

create or replace function app_private.validate_enrichment_drain_window()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.enrichment_drain_until is not null
     and new.enrichment_drain_until > statement_timestamp() + interval '6 hours' then
    raise exception using
      errcode = '22023',
      message = 'Enrichment drain window cannot exceed six hours.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.validate_enrichment_drain_window() from public, anon, authenticated;
grant execute on function app_private.validate_enrichment_drain_window() to service_role;

drop trigger if exists auction_pipeline_control_validate_enrichment_drain
  on public.auction_pipeline_control;
create trigger auction_pipeline_control_validate_enrichment_drain
before insert or update of enrichment_drain_until
on public.auction_pipeline_control
for each row
execute function app_private.validate_enrichment_drain_window();

-- Use this function for operator changes so the activation and deactivation
-- command is auditable and has the same bound as direct service-role writes.
create or replace function app_private.set_enrichment_drain_until(
  p_until timestamptz
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_until is not null
     and p_until > statement_timestamp() + interval '6 hours' then
    raise exception using
      errcode = '22023',
      message = 'Enrichment drain window cannot exceed six hours.';
  end if;

  update public.auction_pipeline_control
     set enrichment_drain_until = p_until,
         updated_at = statement_timestamp()
   where id;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Pipeline control row is missing.';
  end if;
  return p_until;
end;
$$;

revoke all on function app_private.set_enrichment_drain_until(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.set_enrichment_drain_until(timestamptz)
  to service_role;

-- Keep the current dispatcher implementation and its lease/retry branches
-- intact.  Drain mode only changes whether a queue that has work may use a
-- tick before next_enrichment_at; the existing source arbitration still gives
-- a source inside its one-hour freshness budget to the queue and gives an
-- older source a collection turn until the persisted three-turn fairness
-- threshold is reached.
create or replace function public.claim_autonomous_pipeline_run()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  chosen text;
  chosen_source_due_at timestamptz;
  queue_due boolean;
  drain_active boolean;
  run_uuid uuid;
  worker_due timestamptz;
  drain_until timestamptz;
  selected_mode text;
  active_id uuid;
  active_source text;
  active_status text;
  active_scheduler_owned boolean;
  active_summary jsonb;
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
  perform public.enqueue_due_source_details(now_at,500);

  -- A manual run keeps the legacy 190-minute lease.  A running automatic
  -- worker keeps the existing 60-minute execution lease.  A queued automatic
  -- run uses the dispatch lease recorded in its summary, so a long
  -- Retry-After or an accepted workflow cannot be expired before the next
  -- scheduler decision.
  update public.auction_runs r set status='failed',finished_at=now_at,updated_at=now_at,
    summary=coalesce(r.summary,'{}') || '{"completion_status":"lease_expired"}',
    errors=coalesce(r.errors,'{}') || '{"runner":["Execution lease expired; committed batches preserved"]}'
  where r.status in ('queued','running')
    and (
      (not r.scheduler_owned and coalesce(r.started_at,r.created_at) <
        now_at-interval '190 minutes')
      or (r.scheduler_owned and r.status='running' and
        coalesce(r.started_at,r.created_at) < now_at-interval '60 minutes')
      or (r.scheduler_owned and r.status='queued' and
        case
          when r.summary #>> '{github_dispatch,lease_until}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
            then (r.summary #>> '{github_dispatch,lease_until}')::timestamptz
          else coalesce(r.created_at,now_at)+interval '60 minutes'
        end < now_at
        )
    );

  -- Reclaim the existing automatic row for a retry.  The row lock and the
  -- advisory lock make the increment a compare-and-set for scheduler ticks.
  select r.id,r.source,r.status,r.scheduler_owned,coalesce(r.summary,'{}')
    into active_id,active_source,active_status,active_scheduler_owned,active_summary
    from public.auction_runs r
    where r.status in ('queued','running')
    order by r.created_at,r.id
    limit 1 for update;

  if active_id is not null then
    if active_status='running' or not active_scheduler_owned then return null; end if;

    dispatch := coalesce(active_summary->'github_dispatch','{}'::jsonb);
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
        coalesce((select created_at from public.auction_runs where id=active_id),now_at)+interval '15 minutes'
      end
    end;

    if dispatch_state in ('accepted','terminal','exhausted')
      or dispatch_attempt >= dispatch_max_attempts
      or dispatch_next_at is null or dispatch_next_at > now_at then
      return null;
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
    update public.auction_runs set summary=active_summary ||
        jsonb_build_object('github_dispatch',dispatch),updated_at=now_at
      where id=active_id and status='queued';
    return jsonb_build_object('id',active_id,'source',active_source,
      'mode',case when active_source='enrichment-queue' then 'enrichment' else 'collect' end,
      'attempt',dispatch_attempt,'max_attempts',dispatch_max_attempts);
  end if;

  update public.auction_source_state s set next_inventory_at=least(s.next_inventory_at,now_at)
    from public.auction_runs r where r.id=s.last_run_id and r.summary->>'completion_status'='lease_expired';
  select source_name,next_inventory_at into chosen,chosen_source_due_at
    from public.auction_source_state
    where enabled and (suspended_until is null or suspended_until<=now_at) and next_inventory_at<=now_at
    order by next_inventory_at,source_name limit 1 for update skip locked;

  -- During the bounded maintenance window the queue may use every scheduler
  -- tick with available work, even though its normal cadence was advanced by
  -- the previous queue claim.  The source arbitration helper still applies:
  -- a source newer than one hour may be preempted, while an older source gets
  -- a fair collection turn until the persisted streak threshold is met.
  queue_due := (
    (worker_due <= now_at or drain_active)
    and exists(
      select 1 from public.auction_enrichment_jobs
       where status in ('queued','running','failed')
         and attempt_count<max_attempts
         and next_attempt_at<=now_at
    )
  );

  if app_private.pipeline_queue_should_preempt_source(queue_due,chosen_source_due_at,now_at) then
    chosen := 'enrichment-queue';
  elsif chosen is null then
    if worker_due > now_at then return null; end if;
    update public.auction_pipeline_control set next_enrichment_at=now_at+interval '30 minutes' where id;
    return null;
  end if;

  selected_mode := case when chosen='enrichment-queue' then 'enrichment' else 'collect' end;
  insert into public.auction_runs(status,source,use_llm,scheduler_owned,summary,errors)
    values('queued',chosen,false,true,
      jsonb_build_object('trigger','autonomous','mode',selected_mode,
        'github_dispatch',jsonb_build_object(
          'version',1,'attempt',1,'max_attempts',4,'state','in_flight',
          'attempt_started_at',now_at,
          'next_attempt_at',now_at+interval '15 minutes',
          'lease_until',now_at+interval '60 minutes')),'{}')
    returning id into run_uuid;
  if selected_mode='collect' then
    update public.auction_source_state set last_run_id=run_uuid,last_attempt_at=now_at,
      next_inventory_at=now_at+interval '6 hours',updated_at=now_at where source_name=chosen;
  else
    update public.auction_pipeline_control set next_enrichment_at=now_at+interval '30 minutes' where id;
  end if;
  update public.auction_pipeline_control set last_dispatch_at=now_at,updated_at=now_at where id;
  return jsonb_build_object('id',run_uuid,'source',chosen,'mode',selected_mode,'attempt',1,'max_attempts',4);
end;
$$;

revoke all on function public.claim_autonomous_pipeline_run() from public,anon,authenticated;
grant execute on function public.claim_autonomous_pipeline_run() to service_role;

notify pgrst, 'reload schema';

commit;
