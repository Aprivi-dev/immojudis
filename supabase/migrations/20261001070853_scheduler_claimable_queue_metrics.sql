begin;

set local lock_timeout = '5s';

-- Keep the scheduler's single-writer, lease and admission ordering intact while
-- making its queue decision use the same read-only eligibility fence as the
-- all-family enrichment claim.  This is deliberately an in-place body patch:
-- later migrations have already moved detail admission behind the active-run
-- guard, and replacing only this block preserves that ordering.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  );
  old_queue constant text := $old_queue$  queue_due := (
    (worker_due <= now_at or drain_active)
    and exists(
      select 1 from public.auction_enrichment_jobs
       where status in ('queued','running','failed')
         and attempt_count<max_attempts
         and next_attempt_at<=now_at
    )
  );$old_queue$;
  new_queue constant text := $new_queue$  queue_due := (
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
  );$new_queue$;
begin
  if (length(definition) - length(replace(definition, old_queue, '')))
       / length(old_queue) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected autonomous scheduler queue block; refusing claimable queue patch.';
  end if;

  definition := replace(definition, old_queue, new_queue);
  if position(old_queue in definition) > 0
     or position('s.retention_deadline_materialized' in definition) = 0
     or position('state.suspended_until' in definition) = 0
     or position('active.status = ''running''' in definition) = 0
     or position('partition by source_url, job_type, detail_source_name, detail_source_url' in definition) = 0
     or position('where status <> ''cancelled''' in definition) = 0
     or position('revision.revision_rank = 1' in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Autonomous scheduler queue patch did not produce the expected claim fence.';
  end if;

  execute definition;
end;
$patch$;

revoke all on function public.claim_autonomous_pipeline_run()
  from public, anon, authenticated;
grant execute on function public.claim_autonomous_pipeline_run()
  to service_role;

-- Preserve the raw backlog/age counters and add a set-based split of due rows.
-- The claimable expression mirrors claim_auction_enrichment_jobs_family('all')
-- without invoking that mutating RPC from the observer.  Materialized ranking
-- and due-candidate sets keep classification set-based. Ranking includes all
-- non-cancelled revisions, even completed or not-yet-due rows, as in the claim.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
  old_declare constant text := $old_declare$  backlog integer;
  delayed integer;
  alert_active boolean;
  enabled_at timestamptz;$old_declare$;
  new_declare constant text := $new_declare$  backlog integer;
  delayed integer;
  claimable_due integer;
  excluded_due integer;
  alert_active boolean;
  enabled_at timestamptz;$new_declare$;
  old_queue constant text := $old_queue$  select count(*),
         count(*) filter (where created_at < p_now - interval '24 hours')
    into backlog, delayed
    from public.auction_enrichment_jobs
   where status in ('queued', 'running', 'failed');
  evidence := jsonb_build_object('backlog', backlog, 'older_than_24h', delayed);
  insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
  values ('enrichment-queue', p_now, evidence);
  perform app_private.sync_operational_alert(
    'pipeline.enrichment.stalled',
    'import',
    'warning',
    evidence,
    delayed > 0,
    p_now
  );$old_queue$;
  new_queue constant text := $new_queue$  with revision_ranked as materialized (
    -- Keep every non-cancelled revision in the rank.  The classifier below
    -- marks old due rows excluded instead of dropping them from raw backlog.
    select id,
           row_number() over (
             partition by source_url, job_type, detail_source_name, detail_source_url
             order by created_at desc,
                      (input_hash like 'pipeline_v2:%') desc,
                      id desc
           ) as revision_rank
      from public.auction_enrichment_jobs
     where status <> 'cancelled'
  ), due_candidates as materialized (
    select j.id, j.job_type, j.source_url, j.detail_source_name, revision.revision_rank
      from public.auction_enrichment_jobs j
      join revision_ranked revision on revision.id = j.id
     where (
             j.status in ('queued','failed')
             or (
                  j.status = 'running'
                  and coalesce(j.locked_at,j.updated_at)
                      < p_now - interval '30 minutes'
                )
           )
       and j.next_attempt_at <= p_now
       and j.attempt_count < j.max_attempts
  ), classified as (
    select due.id,
           (
             due.revision_rank = 1
             and
             exists (
               select 1
                 from public.auction_sales s
                where s.source_url = due.source_url
                  and s.status in ('active','unknown','upcoming','postponed','past')
                  and s.retention_deadline_materialized
                  and (s.retention_deadline is null or s.retention_deadline > p_now)
             )
             and (
               due.job_type <> 'source_detail'
               or (
                 exists (
                   select 1
                     from public.auction_pipeline_control c
                    where c.id and c.enabled and c.source_details_enabled
                 )
                 and exists (
                   select 1
                     from public.auction_source_state state
                    where state.source_name = due.detail_source_name
                      and state.enabled
                      and (state.suspended_until is null or state.suspended_until <= p_now)
                 )
               )
             )
             and not exists (
               select 1
                 from public.auction_enrichment_jobs active
                where active.source_url = due.source_url
                  and active.status = 'running'
                  and coalesce(active.locked_at,active.updated_at)
                      >= p_now - interval '30 minutes'
             )
           ) as claimable
      from due_candidates due
  )
  select count(*) filter (where claimable),
         count(*) filter (where not claimable)
    into claimable_due, excluded_due
    from classified;

  select count(*),
         count(*) filter (where created_at < p_now - interval '24 hours')
    into backlog, delayed
    from public.auction_enrichment_jobs
   where status in ('queued', 'running', 'failed');
  evidence := jsonb_build_object(
    'backlog', backlog,
    'older_than_24h', delayed,
    'claimable_due', claimable_due,
    'excluded_due', excluded_due
  );
  insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
  values ('enrichment-queue', p_now, evidence);
  perform app_private.sync_operational_alert(
    'pipeline.enrichment.stalled',
    'import',
    'warning',
    evidence,
    delayed > 0,
    p_now
  );$new_queue$;
begin
  if (length(definition) - length(replace(definition, old_declare, '')))
       / length(old_declare) <> 1
     or (length(definition) - length(replace(definition, old_queue, '')))
       / length(old_queue) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected health observer queue block; refusing claimable metrics patch.';
  end if;

  definition := replace(definition, old_declare, new_declare);
  definition := replace(definition, old_queue, new_queue);
  if position(old_declare in definition) > 0
     or position(old_queue in definition) > 0
     or position('claimable_due' in definition) = 0
     or position('excluded_due' in definition) = 0
     or position('due_candidates as materialized' in definition) = 0
     or position('revision_rank = 1' in definition) = 0
     or position('where status <> ''cancelled''' in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Health observer queue patch did not produce the expected metrics.';
  end if;

  execute definition;
end;
$patch$;

revoke all on function public.observe_autonomous_pipeline(timestamptz)
  from public, anon, authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz)
  to service_role;

notify pgrst, 'reload schema';

commit;
