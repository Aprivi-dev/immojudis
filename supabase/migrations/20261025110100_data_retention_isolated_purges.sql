begin;

set local lock_timeout = '5s';

-- run_data_retention chained its four purges in one SQL expression joined by "||"
-- (20261023100000_discovery_sale_unlocks.sql): if one of them raised, the whole call
-- failed and the purges after it never ran.  In particular a failure in the
-- operational purge skipped app_private.purge_information_agent_data, which deletes the
-- internal contact registry (information_agent_contacts) once its retention period is
-- over.
--
-- Each purge now runs in its own exception block (a sub-transaction), in the same order:
--   * a purge that raises is rolled back alone, its error is logged (purge name, SQLSTATE
--     and message; no row content) with RAISE WARNING, and the next purge still runs;
--   * the other purges are committed with the call, so nothing is lost by the failure;
--   * the failure is returned under "purge_errors" ({purge name: SQLSTATE}) so the caller
--     can report it.  Raising at the end would roll back every purge, including the ones
--     that succeeded.  src/lib/cron-jobs.ts (runDataRetention) turns a non-empty
--     "purge_errors" into a failed run of the "data-retention" cron job, which the
--     operational health evaluation already reports.
-- A statement_timeout (QUERY_CANCELED) is not caught by "when others" and still aborts
-- the whole call: the budget of the statement is exhausted.  A later migration that
-- redefines this function must keep all four isolated parts and the purge_errors key.
create or replace function public.run_data_retention(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_errors jsonb := '{}'::jsonb;
begin
  begin
    v_result := v_result || coalesce(app_private.purge_expired_operational_data(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_expired_operational_data', sqlstate);
    raise warning 'run_data_retention: purge_expired_operational_data failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_information_agent_data(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_information_agent_data', sqlstate);
    raise warning 'run_data_retention: purge_information_agent_data failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_offer_opening_notifications(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_offer_opening_notifications', sqlstate);
    raise warning 'run_data_retention: purge_offer_opening_notifications failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_sale_unlocks(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_sale_unlocks', sqlstate);
    raise warning 'run_data_retention: purge_sale_unlocks failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the four retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
