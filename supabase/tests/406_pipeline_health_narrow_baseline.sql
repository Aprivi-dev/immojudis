begin;

select plan(12);

select has_function(
  'public',
  'observe_autonomous_pipeline',
  array['timestamptz'],
  'the health observer keeps its existing signature'
);

select ok(
  (
    select procedure_row.prosecdef
      and has_function_privilege(
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
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ),
  'the health observer remains SECURITY DEFINER and service-role-only'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ),
  'the health observer keeps an empty search_path'
);

select ok(
  position('baseline_projection as materialized' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('baseline.metrics->>''inventory_count''' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) = 0
  and position('avg(baseline.inventory_count_text::numeric)' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0,
  'the baseline windows use the narrow scalar projection and cast only in the final average'
);

set local role service_role;

update public.auction_pipeline_control
   set enabled = true
 where id;

create temporary table pgtap_observe_406_context (
  p_now timestamptz not null,
  current_run_id uuid not null,
  first_run_id uuid not null
) on commit drop;

insert into pgtap_observe_406_context(p_now, current_run_id, first_run_id)
values (
  statement_timestamp(),
  'f4060000-0000-4000-8000-000000000999',
  'f4060000-0000-4000-8000-000000000001'
);

insert into public.auction_runs (
  id,
  status,
  finished_at,
  summary
)
select
  context.current_run_id,
  'success',
  context.p_now - interval '1 hour',
  '{"execution_seconds": 4}'::jsonb
from pgtap_observe_406_context context;

insert into public.auction_source_state (
  source_name,
  enabled,
  last_inventory_complete_at,
  last_publication_complete_at,
  last_run_id,
  coverage,
  updated_at
)
select
  'pgtap-observe-406',
  true,
  context.p_now - interval '2 days',
  context.p_now - interval '2 days',
  context.current_run_id,
  '{"coverage_complete": true, "http_attempts_including_retries": 1}'::jsonb,
  context.p_now - interval '2 days'
from pgtap_observe_406_context context;

-- Twenty-eight distinct historical runs are retained.  Run 1 has an older
-- duplicate so the latest snapshot must win; the current run is excluded by
-- last_run_id; the malformed count is older than the 28-run cutoff.
insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
select
  'pgtap-observe-406',
  context.p_now - (series.run_number * interval '1 hour'),
  jsonb_build_object(
    'run_id',
    ('f4060000-0000-4000-8000-' || lpad(series.run_number::text, 12, '0'))::uuid,
    'inventory_complete', true,
    'inventory_count', series.run_number
  )
from pgtap_observe_406_context context
cross join generate_series(1, 28) as series(run_number);

insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
select
  'pgtap-observe-406',
  context.p_now - interval '200 hours',
  jsonb_build_object(
    'run_id', context.first_run_id,
    'inventory_complete', true,
    'inventory_count', 999
  )
from pgtap_observe_406_context context;

insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
select
  'pgtap-observe-406',
  context.p_now - interval '30 minutes',
  jsonb_build_object(
    'run_id', context.current_run_id,
    'inventory_complete', true,
    'inventory_count', 100000
  )
from pgtap_observe_406_context context;

insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
select
  'pgtap-observe-406',
  context.p_now - interval '300 hours',
  jsonb_build_object(
    'run_id', 'f4060000-0000-4000-8000-000000000998'::uuid,
    'inventory_complete', true,
    'inventory_count', 'not-a-number'
  )
from pgtap_observe_406_context context;

create temporary table pgtap_observe_406_result (
  payload jsonb not null
) on commit drop;

select lives_ok(
  $sql$
    insert into pgtap_observe_406_result(payload)
    select public.observe_autonomous_pipeline(context.p_now)
      from pgtap_observe_406_context context;
  $sql$,
  'the observer ignores an invalid numeric count outside the 28-run window'
);

select ok(
  (
    select payload->>'enabled' = 'true'
       and payload->'queue' ? 'backlog'
       and payload->'queue' ? 'older_than_24h'
      from pgtap_observe_406_result
  ),
  'the observer keeps its enabled result and queue JSON contract'
);

select is(
  (
    select count(*)
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-406'
       and observed_at = (select p_now from pgtap_observe_406_context)
  ),
  1::bigint,
  'the fixture source receives exactly one health observation'
);

select is(
  (
    select (metrics->>'inventory_baseline')::numeric
      from public.auction_pipeline_observations
     where source_name = 'pgtap-observe-406'
       and observed_at = (select p_now from pgtap_observe_406_context)
  ),
  14.5::numeric,
  'the baseline averages the 28 distinct historical runs'
);

create temporary table pgtap_observe_406_baseline_rows (
  source_name text not null,
  observed_at timestamptz not null,
  run_id_text text,
  inventory_count_text text,
  run_rank bigint not null,
  source_rank bigint
) on commit drop;

insert into pgtap_observe_406_baseline_rows (
  source_name,
  observed_at,
  run_id_text,
  inventory_count_text,
  run_rank,
  source_rank
)
with baseline_projection as materialized (
  select state.source_name,
         observation.observed_at,
         observation.metrics->>'run_id' as run_id_text,
         observation.metrics->>'inventory_count' as inventory_count_text
    from public.auction_source_state state
    join public.auction_pipeline_observations observation
      on observation.source_name = state.source_name
   where state.source_name = 'pgtap-observe-406'
     and observation.metrics->>'inventory_complete' = 'true'
     and observation.metrics->>'run_id' is distinct from state.last_run_id::text
), baseline_candidates as materialized (
  select projection.*,
         row_number() over (
           partition by projection.source_name, projection.run_id_text
           order by projection.observed_at desc
         ) as run_rank
    from baseline_projection projection
), baseline_runs as materialized (
  select candidate.*,
         row_number() over (
           partition by candidate.source_name
           order by candidate.observed_at desc
         ) as source_rank
    from baseline_candidates candidate
   where candidate.run_rank = 1
)
select source_name, observed_at, run_id_text, inventory_count_text,
       run_rank, source_rank
  from baseline_runs;

select is(
  (
    select count(distinct run_id_text)
      from pgtap_observe_406_baseline_rows
     where source_rank <= 28
  ),
  28::bigint,
  'the baseline retains 28 distinct historical runs'
);

select is(
  (
    select inventory_count_text
      from pgtap_observe_406_baseline_rows
     where run_id_text = (
       select first_run_id::text from pgtap_observe_406_context
     )
       and run_rank = 1
  ),
  '1',
  'the newest snapshot wins for a duplicated historical run'
);

select is(
  (
    select count(*)
      from pgtap_observe_406_baseline_rows
     where run_id_text = (
       select current_run_id::text from pgtap_observe_406_context
     )
  ),
  0::bigint,
  'the current run is excluded from the historical baseline'
);

select is(
  (
    select count(*)
      from pgtap_observe_406_baseline_rows
     where inventory_count_text = 'not-a-number'
       and source_rank = 29
  ),
  1::bigint,
  'the malformed old snapshot remains outside the 28-run cast window'
);

select * from finish();
rollback;
