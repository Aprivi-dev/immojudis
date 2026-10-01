begin;

select plan(14);

select ok(
  position('security definer' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('set search_path to ''' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0,
  'the health observer remains a locked-down SECURITY DEFINER function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.observe_autonomous_pipeline(timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.observe_autonomous_pipeline(timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.observe_autonomous_pipeline(timestamptz)',
    'execute'
  ),
  'only the service role can run the health observer'
);

set local role service_role;

update public.auction_pipeline_control
   set enabled = true
 where id;

create temporary table pgtap_observe_402_context (
  p_now timestamptz not null,
  existing_source_count bigint not null
) on commit drop;

insert into pgtap_observe_402_context(p_now, existing_source_count)
select statement_timestamp(), count(*)
  from public.auction_source_state;

insert into public.auction_runs (
  id,
  status,
  finished_at,
  summary
)
values (
  'f4020000-0000-4000-8000-000000000001',
  'success',
  statement_timestamp() - interval '1 hour',
  '{"execution_seconds": 4}'::jsonb
);

insert into public.auction_source_state (
  source_name,
  enabled,
  last_inventory_complete_at,
  last_publication_complete_at,
  last_run_id,
  coverage,
  updated_at
)
values (
  'pgtap-observe-402',
  true,
  statement_timestamp() - interval '2 days',
  statement_timestamp() - interval '2 days',
  'f4020000-0000-4000-8000-000000000001',
  '{"coverage_complete": true, "http_attempts_including_retries": 1}'::jsonb,
  statement_timestamp() - interval '2 days'
);

insert into public.auction_collection_items (
  run_id,
  source_name,
  source_url,
  identity_hash,
  decision,
  discovered_at,
  published_at
)
values
  (
    'f4020000-0000-4000-8000-000000000001',
    'pgtap-observe-402',
    'https://example.test/pgtap/observe-402/published',
    'pgtap-observe-402-published',
    'published',
    statement_timestamp() - interval '2 minutes',
    statement_timestamp() - interval '1 minute'
  ),
  (
    'f4020000-0000-4000-8000-000000000001',
    'pgtap-observe-402',
    'https://example.test/pgtap/observe-402/failed',
    'pgtap-observe-402-failed',
    'publication_failed',
    statement_timestamp() - interval '2 minutes',
    null
  );

-- The baseline keeps the latest observation for each completed run, ignores
-- the current run, and then averages the most recent 28 distinct runs.
insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
select 'pgtap-observe-402', context.p_now - interval '5 hours',
       jsonb_build_object(
         'run_id', 'f4020000-0000-4000-8000-000000000010',
         'inventory_complete', true,
         'inventory_count', 10
       )
  from pgtap_observe_402_context context
union all
select 'pgtap-observe-402', context.p_now - interval '6 hours',
       jsonb_build_object(
         'run_id', 'f4020000-0000-4000-8000-000000000011',
         'inventory_complete', true,
         'inventory_count', 999
       )
  from pgtap_observe_402_context context
union all
select 'pgtap-observe-402', context.p_now - interval '3 hours',
       jsonb_build_object(
         'run_id', 'f4020000-0000-4000-8000-000000000011',
         'inventory_complete', true,
         'inventory_count', 30
       )
  from pgtap_observe_402_context context
union all
select 'pgtap-observe-402', context.p_now - interval '1 hour',
       jsonb_build_object(
         'run_id', 'f4020000-0000-4000-8000-000000000001',
         'inventory_complete', true,
         'inventory_count', 100
       )
  from pgtap_observe_402_context context;

create temporary table pgtap_observe_402_result (
  payload jsonb not null
) on commit drop;

insert into pgtap_observe_402_result(payload)
select public.observe_autonomous_pipeline(p_now)
  from pgtap_observe_402_context;

select ok(
  (select payload->>'enabled' = 'true'
     and payload->'queue' ? 'backlog'
     and payload->'queue' ? 'older_than_24h'
    from pgtap_observe_402_result),
  'the observer keeps its enabled result and queue JSON contract'
);

select is(
  (
    select count(*)
      from public.auction_pipeline_observations
     where observed_at = (select p_now from pgtap_observe_402_context)
  ),
  (select existing_source_count + 2 from pgtap_observe_402_context),
  'one observation is written per source plus the enrichment queue observation'
);

select is(
  (
    select count(*)
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-402'
       and observed_at = (select p_now from pgtap_observe_402_context)
  ),
  1::bigint,
  'the fixture source receives exactly one observation'
);

select is(
  (
    select count(*)
      from public.auction_pipeline_observations
     where source_name = 'enrichment-queue'
       and observed_at = (select p_now from pgtap_observe_402_context)
  ),
  1::bigint,
  'the enrichment queue receives exactly one observation'
);

select is(
  (
    select metrics->>'inventory_count'
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-402'
       and observed_at = (select p_now from pgtap_observe_402_context)
  ),
  '2',
  'the preaggregation preserves the inventory count'
);

select is(
  (
    select metrics->>'failed_publication'
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-402'
       and observed_at = (select p_now from pgtap_observe_402_context)
  ),
  '1',
  'the preaggregation preserves the publication failure count'
);

select is(
  (
    select metrics->'decisions'
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-402'
       and observed_at = (select p_now from pgtap_observe_402_context)
  ),
  '{"published": 1, "publication_failed": 1}'::jsonb,
  'the preaggregation preserves decision counts in the evidence JSON'
);

select is(
  (
    select metrics->>'inventory_complete'
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-402'
       and observed_at = (select p_now from pgtap_observe_402_context)
  ),
  'true',
  'the run completion evidence remains true for a finished covered run'
);

select is(
  (
    select (metrics->>'inventory_baseline')::numeric
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-402'
       and observed_at = (select p_now from pgtap_observe_402_context)
  ),
  20::numeric,
  'the baseline keeps the latest duplicate run and ignores the current run'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.source.pgtap-observe-402.missed'
       and status = 'open'
  ),
  1::bigint,
  'the stale source alert remains active'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.source.pgtap-observe-402.publication'
       and status = 'open'
  ),
  1::bigint,
  'the publication failure alert remains active'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.source.pgtap-observe-402.drop'
       and status = 'open'
  ),
  1::bigint,
  'the qualifying baseline keeps the drop alert active'
);

select * from finish();
rollback;
