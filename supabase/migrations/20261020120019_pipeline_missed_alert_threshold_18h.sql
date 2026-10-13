begin;

set local lock_timeout = '5s';

-- The critical alert pipeline.source.<source>.missed opens when a source has not
-- completed its inventory for 12 hours. Since the 12-hour inventory cadence
-- (20261016100000_source_inventory_cadence_12h.sql, owner decision of
-- 11/10/2026) a healthy source finishes about every 12 hours, plus up to ~50
-- minutes of dispatch and run time, plus up to two 15-minute scheduler ticks:
-- the alert would open at every cycle. Raise the threshold to 18 hours, which
-- leaves a real margin before a missed cycle is reported. In-place body patch of
-- the latest observe_autonomous_pipeline(timestamptz) definition, like the
-- previous scheduler migrations, idempotent (an observer already at 18 hours is a
-- no-op); the invariant is checked by
-- services/data-pipeline/tests/test_pipeline_cadence_invariants.py.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
  old_threshold constant text := $old$) < p_now - interval '12 hours';$old$;
  new_threshold constant text := $new$) < p_now - interval '18 hours';$new$;
  old_count integer;
  new_count integer;
begin
  old_count := (length(definition) - length(replace(definition, old_threshold, '')))
    / length(old_threshold);
  new_count := (length(definition) - length(replace(definition, new_threshold, '')))
    / length(new_threshold);

  -- Already patched (second application, or a database rebuilt with the 18-hour observer):
  -- nothing to do, and this must not fail the whole migration run.
  if old_count = 0 and new_count = 1 then
    raise notice 'Missed-inventory alert threshold is already 18 hours; nothing to patch.';
    return;
  end if;

  -- Neither the 12-hour nor the 18-hour threshold, or an ambiguous body: refuse to guess.
  if old_count <> 1 or new_count <> 0 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected missed-inventory alert threshold; refusing 18-hour threshold patch.';
  end if;

  definition := replace(definition, old_threshold, new_threshold);
  if position(old_threshold in definition) > 0
     or position(new_threshold in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Missed-inventory alert threshold patch did not produce the 18-hour threshold.';
  end if;

  execute definition;
end;
$patch$;

revoke all on function public.observe_autonomous_pipeline(timestamptz)
  from public, anon, authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz)
  to service_role;

commit;
