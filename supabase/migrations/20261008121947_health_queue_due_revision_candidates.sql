begin;

set local lock_timeout = '5s';

-- Rank only revision groups that contain a due candidate. The previous health
-- observer ranked every non-cancelled job on every tick, even when most jobs
-- were completed or not due. The candidate-group join keeps the latest
-- revision semantics while allowing the existing revision_detail index to
-- seek by source_url and job_type.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
  old_queue constant text := $old_queue$  with revision_ranked as materialized (
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
    from classified;$old_queue$;
  new_queue constant text := $new_queue$  with due_candidates as materialized (
    -- Keep the full due set for raw backlog and eligibility evidence, but carry
    -- the revision key so only these groups need to be ranked.
    select j.id,
           j.job_type,
           j.source_url,
           j.detail_source_name,
           j.detail_source_url
      from public.auction_enrichment_jobs j
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
  ), revision_ranked as materialized (
    select j.id,
           row_number() over (
             partition by j.source_url, j.job_type, j.detail_source_name, j.detail_source_url
             order by j.created_at desc,
                      (j.input_hash like 'pipeline_v2:%') desc,
                      j.id desc
           ) as revision_rank
      from public.auction_enrichment_jobs j
      join (
        select distinct source_url,
                        job_type,
                        detail_source_name,
                        detail_source_url
          from due_candidates
      ) groups
        on j.source_url = groups.source_url
       and j.job_type = groups.job_type
       and (
         (j.detail_source_name = groups.detail_source_name
          and j.detail_source_url = groups.detail_source_url)
         or (
           j.detail_source_name is null
           and groups.detail_source_name is null
           and j.detail_source_url is null
           and groups.detail_source_url is null
         )
         or (
           j.detail_source_name is null
           and groups.detail_source_name is null
           and j.detail_source_url = groups.detail_source_url
         )
         or (
           j.detail_source_name = groups.detail_source_name
           and j.detail_source_url is null
           and groups.detail_source_url is null
         )
       )
     where j.status <> 'cancelled'
  ), classified as (
    select due.id,
           (
             revision.revision_rank = 1
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
      join revision_ranked revision
        on revision.id = due.id
  )
  select count(*) filter (where claimable),
         count(*) filter (where not claimable)
    into claimable_due, excluded_due
    from classified;$new_queue$;
begin
  if (length(definition) - length(replace(definition, old_queue, '')))
       / length(old_queue) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected health observer queue block; refusing due-revision patch.';
  end if;

  definition := replace(definition, old_queue, new_queue);
  if position(old_queue in definition) > 0
     or position('due_candidates as materialized' in definition) = 0
     or position('revision_ranked as materialized' in definition) = 0
     or position('select distinct source_url' in definition) = 0
     or position('revision.revision_rank = 1' in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Health observer due-revision patch did not produce the expected classifier.';
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
