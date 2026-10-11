begin;

set local lock_timeout = '5s';

-- Owner decision (11/10/2026): each source is collected at most every 12 hours
-- instead of 6, to lighten the database and the collection load. The
-- enrichment queue keeps its 30-minute cadence. The autonomous runner sets the
-- definitive deadline when the run ends (INVENTORY_CADENCE); this placeholder
-- only holds the source back while its dispatched run is pending. In-place
-- body patch, like the previous scheduler migrations.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  );
  old_cadence constant text := $old$next_inventory_at=now_at+interval '6 hours'$old$;
  new_cadence constant text := $new$next_inventory_at=now_at+interval '12 hours'$new$;
begin
  if (length(definition) - length(replace(definition, old_cadence, '')))
       / length(old_cadence) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected autonomous scheduler cadence; refusing 12-hour cadence patch.';
  end if;

  definition := replace(definition, old_cadence, new_cadence);
  if position(old_cadence in definition) > 0
     or position(new_cadence in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Autonomous scheduler cadence patch did not produce the 12-hour cadence.';
  end if;

  execute definition;
end;
$patch$;

revoke all on function public.claim_autonomous_pipeline_run()
  from public, anon, authenticated;
grant execute on function public.claim_autonomous_pipeline_run()
  to service_role;

-- Sources already scheduled under the six-hour cadence keep their next turn;
-- the new cadence applies from their next collection.

commit;
