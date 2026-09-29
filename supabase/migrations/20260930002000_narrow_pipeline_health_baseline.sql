begin;

set local lock_timeout = '5s';

-- Keep the health observer's identity, security attributes and alert semantics,
-- but project the historical baseline to the four scalar values used by its
-- two windows.  In particular, keep the numeric cast after source_rank <= 28
-- so an old malformed snapshot outside the retained window remains harmless.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
  old_baseline constant text := $old_baseline$
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
  $old_baseline$;
  new_baseline constant text := $new_baseline$
    baseline_projection as materialized (
      select state.source_name,
             observation.observed_at,
             observation.metrics->>'run_id' as run_id_text,
             observation.metrics->>'inventory_count' as inventory_count_text
        from public.auction_source_state state
        join public.auction_pipeline_observations observation
          on observation.source_name = state.source_name
       where observation.metrics->>'inventory_complete' = 'true'
         and observation.metrics->>'run_id' is distinct from state.last_run_id::text
    ),
    baseline_candidates as materialized (
      select projection.source_name,
             projection.observed_at,
             projection.run_id_text,
             projection.inventory_count_text,
             row_number() over (
               partition by projection.source_name, projection.run_id_text
               order by projection.observed_at desc
             ) as run_rank
        from baseline_projection projection
    ),
    baseline_runs as materialized (
      select candidate.source_name,
             candidate.observed_at,
             candidate.inventory_count_text,
             row_number() over (
               partition by candidate.source_name
               order by candidate.observed_at desc
             ) as source_rank
        from baseline_candidates candidate
       where candidate.run_rank = 1
    ),
    baseline_rollup as (
      select baseline.source_name,
             avg(baseline.inventory_count_text::numeric) as inventory_baseline
        from baseline_runs baseline
       where baseline.source_rank <= 28
       group by baseline.source_name
    )
  $new_baseline$;
begin
  if (length(definition) - length(replace(definition, old_baseline, '')))
       / length(old_baseline) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected health observer baseline; refusing narrow projection patch.';
  end if;

  definition := replace(definition, old_baseline, new_baseline);
  if position('baseline_projection as materialized' in definition) = 0
     or position('avg(baseline.inventory_count_text::numeric)' in definition) = 0
     or position('baseline.metrics->>''inventory_count''' in definition) > 0 then
    raise exception using
      errcode = '55000',
      message = 'Narrow health observer baseline patch did not produce the expected shape.';
  end if;

  execute definition;
end;
$patch$;

-- CREATE OR REPLACE preserves the existing function identity.  Reassert the
-- established private execution boundary without changing service_role ACLs.
revoke all on function public.observe_autonomous_pipeline(timestamptz)
  from public, anon, authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz)
  to service_role;

notify pgrst, 'reload schema';

commit;
