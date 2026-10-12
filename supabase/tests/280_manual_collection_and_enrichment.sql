begin;
select plan(3);
select is((select count(*) from cron.job where jobname = 'immojudis-market-valuations' and active), 0::bigint, 'No automatic valuation enrichment');
select is((select count(*) from cron.job where jobname = 'immojudis-licitor-resume' and active), 0::bigint, 'No automatic collector resumption');
-- The Licitor history is collected by the primary scheduler since 12/10/2026
-- (autonomous_runner → licitor_history_refresh), never by a database cron.
select ok(
  has_function_privilege('service_role', 'app_private.attest_licitor_reported_candidates()', 'execute')
    and not has_function_privilege('licitor_collector', 'app_private.attest_licitor_reported_candidates()', 'execute'),
  'Only the main pipeline role attests collected Licitor lots'
);
select * from finish();
rollback;
