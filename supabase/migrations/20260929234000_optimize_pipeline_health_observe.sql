begin;

-- The health observer previously queried auction_collection_items four times for
-- every source.  Roll up the current runs once and compute the historical
-- baseline once, while preserving the evidence and alert semantics below.
create or replace function public.observe_autonomous_pipeline(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_row record;
  freshness_counts jsonb;
  evidence jsonb;
  backlog integer;
  delayed integer;
  alert_active boolean;
  enabled_at timestamptz;
begin
  delete from public.auction_collection_checkpoints
   where observed_at < p_now - interval '24 hours';

  select observation_started_at
    into enabled_at
    from public.auction_pipeline_control
   where id and enabled;
  if not found then
    return jsonb_build_object('enabled', false);
  end if;

  select coalesce(
    jsonb_object_agg(
      f.source_name,
      jsonb_build_object('active', f.active_listings, 'fresh', f.fresh_listings)
    ),
    '{}'::jsonb
  )
    into freshness_counts
    from public.auction_all_source_freshness(p_now) f;

  for source_row in
    with current_run_ids as materialized (
      select distinct state.last_run_id
        from public.auction_source_state state
       where state.last_run_id is not null
    ),
    current_items as materialized (
      select item.run_id,
             item.decision,
             item.discovered_at,
             item.published_at
        from public.auction_collection_items item
        join current_run_ids current_run
          on current_run.last_run_id = item.run_id
    ),
    decision_counts as materialized (
      select item.run_id,
             item.decision,
             count(*) as decision_count
        from current_items item
       group by item.run_id, item.decision
    ),
    item_rollup as (
      select counts.run_id,
             sum(counts.decision_count)::integer as inventory_count,
             coalesce(
               sum(counts.decision_count)
                 filter (where counts.decision = 'publication_failed'),
               0
             )::integer as failed_publication,
             jsonb_object_agg(counts.decision, counts.decision_count) as decisions
        from decision_counts counts
       group by counts.run_id
    ),
    latency_rollup as (
      select item.run_id,
             (
               percentile_cont(0.95) within group (
                 order by extract(epoch from item.published_at - item.discovered_at)
               )
             )::numeric as latency_p95
        from current_items item
       where item.published_at is not null
       group by item.run_id
    ),
    baseline_candidates as materialized (
      select state.source_name,
             observation.metrics,
             observation.observed_at,
             row_number() over (
               partition by state.source_name, observation.metrics->>'run_id'
               order by observation.observed_at desc
             ) as run_rank
        from public.auction_source_state state
        join public.auction_pipeline_observations observation
          on observation.source_name = state.source_name
       where observation.metrics->>'inventory_complete' = 'true'
         and observation.metrics->>'run_id' is distinct from state.last_run_id::text
    ),
    baseline_runs as materialized (
      select candidate.source_name,
             candidate.metrics,
             candidate.observed_at,
             row_number() over (
               partition by candidate.source_name
               order by candidate.observed_at desc
             ) as source_rank
        from baseline_candidates candidate
       where candidate.run_rank = 1
    ),
    baseline_rollup as (
      select baseline.source_name,
             avg((baseline.metrics->>'inventory_count')::numeric) as inventory_baseline
        from baseline_runs baseline
       where baseline.source_rank <= 28
       group by baseline.source_name
    )
    select state.*,
           coalesce(items.inventory_count, 0) as inventory_count,
           coalesce(items.failed_publication, 0) as failed_publication,
           coalesce(items.decisions, '{}'::jsonb) as decisions,
           latency.latency_p95,
           baseline.inventory_baseline,
           run_info.summary as run_summary,
           (
             run_info.finished_at is not null
             and coalesce((state.coverage->>'coverage_complete')::boolean, false)
           ) as inventory_complete
      from public.auction_source_state state
      left join item_rollup items
        on items.run_id = state.last_run_id
      left join latency_rollup latency
        on latency.run_id = state.last_run_id
      left join baseline_rollup baseline
        on baseline.source_name = state.source_name
      left join public.auction_runs run_info
        on run_info.id = state.last_run_id
  loop
    evidence := jsonb_build_object(
      'enabled', source_row.enabled,
      'availability', source_row.availability,
      'run_id', source_row.last_run_id,
      'inventory_count', source_row.inventory_count,
      'inventory_complete', coalesce(source_row.inventory_complete, false),
      'last_inventory_complete_at', source_row.last_inventory_complete_at,
      'last_publication_complete_at', source_row.last_publication_complete_at,
      'active_listings', coalesce(
        (freshness_counts->source_row.source_name->>'active')::integer,
        0
      ),
      'fresh_listings', coalesce(
        (freshness_counts->source_row.source_name->>'fresh')::integer,
        0
      ),
      'freshness_ratio', case
        when coalesce((freshness_counts->source_row.source_name->>'active')::integer, 0) > 0
          then coalesce((freshness_counts->source_row.source_name->>'fresh')::numeric, 0)
            / (freshness_counts->source_row.source_name->>'active')::numeric
        else null
      end,
      'failed_publication', source_row.failed_publication,
      'inventory_baseline', source_row.inventory_baseline,
      'decisions', source_row.decisions,
      'discovery_to_publication_p95_seconds', source_row.latency_p95,
      'execution_seconds', source_row.run_summary->'execution_seconds',
      'http_attempts', source_row.coverage->'http_attempts_including_retries'
    );

    insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
    values (source_row.source_name, p_now, evidence);

    alert_active := source_row.enabled
      and coalesce(
        source_row.last_inventory_complete_at,
        enabled_at,
        source_row.updated_at
      ) < p_now - interval '12 hours';
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.missed',
      'import',
      'critical',
      evidence,
      alert_active,
      p_now
    );
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.drop',
      'import',
      'warning',
      evidence,
      source_row.enabled
        and source_row.inventory_baseline >= 10
        and coalesce(source_row.inventory_complete, false)
        and source_row.inventory_count < source_row.inventory_baseline * 0.7,
      p_now
    );
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.publication',
      'import',
      'critical',
      evidence,
      source_row.enabled and source_row.failed_publication > 0,
      p_now
    );
  end loop;

  select count(*),
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
  );

  -- Aggregated operation metrics follow the existing 90-day operational history policy.
  delete from public.auction_pipeline_observations
   where observed_at < p_now - interval '90 days';
  return jsonb_build_object('enabled', true, 'queue', evidence);
end;
$$;

revoke all on function public.observe_autonomous_pipeline(timestamptz)
  from public, anon, authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz)
  to service_role;

commit;
