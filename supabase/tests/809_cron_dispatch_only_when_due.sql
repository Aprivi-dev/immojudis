-- 20261110100713 : une tâche pg_cron n'appelle sa route Vercel que s'il y a du travail ou un passage dû.
-- Les dates sont placées loin dans le futur pour ne pas dépendre des passages réels de la base de test.
begin;

select plan(15);

create temporary table c809_now as select timestamptz '2036-01-01 12:00:00+00' as now;

select ok(
  app_private.cron_dispatch_due('operational-health', (select now from c809_now))
  and app_private.cron_dispatch_due('sale-flood-risk', (select now from c809_now))
  and app_private.cron_dispatch_due('sale-retention', (select now from c809_now)),
  'with no recent run, each task is due'
);

insert into public.operational_job_runs (job_name, status, summary, started_at, finished_at)
select job, 'success', summary, (select now from c809_now) - age, (select now from c809_now) - age + interval '1 second'
from (values
  ('operational-health', '{}'::jsonb, interval '20 minutes'),
  ('sale-flood-risk', '{}'::jsonb, interval '60 minutes'),
  ('sale-retention', '{"remaining": 0}'::jsonb, interval '10 minutes'),
  ('information-agent-inbound', '{}'::jsonb, interval '4 minutes'),
  ('precompute-valuations', '{}'::jsonb, interval '30 minutes')
) as runs(job, summary, age);

select ok(
  not app_private.cron_dispatch_due('operational-health', (select now from c809_now)),
  'operational health is skipped 20 minutes after a run (every 30 minutes)'
);

select ok(
  app_private.cron_dispatch_due('operational-health', (select now from c809_now) + interval '6 minutes'),
  'operational health runs again 26 minutes after the last run'
);

select ok(
  not app_private.cron_dispatch_due('sale-flood-risk', (select now from c809_now)),
  'the flood risk check is skipped one hour after a run (every 2 hours)'
);

select ok(
  not app_private.cron_dispatch_due('sale-retention', (select now from c809_now)),
  'retention with nothing left is skipped 10 minutes after a run'
);

update public.operational_job_runs set summary = '{"remaining": 25}'::jsonb
where job_name = 'sale-retention' and started_at = (select now from c809_now) - interval '10 minutes';

select ok(
  app_private.cron_dispatch_due('sale-retention', (select now from c809_now)),
  'retention runs again at once when the last pass left sales to delete'
);

select ok(
  app_private.cron_dispatch_due('information-agent-inbound', (select now from c809_now))
    = exists (
      select 1 from public.information_agent_inbound_jobs job
      where job.attempts < 10 and job.available_at <= (select now from c809_now)
        and job.status in ('queued', 'failed', 'processing')
    ),
  'the inbound worker is called only for a due message within 6 minutes of a run'
);

select ok(
  app_private.cron_dispatch_due('information-agent-inbound', (select now from c809_now) + interval '3 minutes'),
  'the inbound worker keeps a pass every 6 minutes for the stale-cron check'
);

select ok(
  app_private.cron_dispatch_due('precompute-valuations', (select now from c809_now) + interval '31 minutes'),
  'valuations keep an hourly pass even with an empty queue'
);

select ok(
  (
    select bool_and(position('app_private.cron_dispatch_due(' in pg_catalog.pg_get_functiondef(signature::regprocedure)) > 0)
    from (values
      ('app_private.invoke_information_agent_inbound_endpoint()'),
      ('app_private.invoke_market_valuation_precompute_endpoint()'),
      ('app_private.invoke_sale_retention_endpoint()'),
      ('app_private.invoke_operational_health_endpoint()'),
      ('app_private.invoke_sale_flood_risk_endpoint()')
    ) as targets(signature)
  )
  and not has_function_privilege('anon', 'app_private.cron_dispatch_due(text, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.cron_dispatch_due(text, timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'app_private.cron_dispatch_due(text, timestamptz)', 'execute'),
  'the five callbacks are guarded and the guard stays private'
);

-- 20261110120100 : un passage échoué ne compte pas comme un passage fait. Après un échec, la tâche est relancée
-- au tick suivant de pg_cron au lieu d'attendre la fin de sa fenêtre, mais pas avant 5 minutes après la fin de l'échec.
insert into public.operational_job_runs (job_name, status, error_message, started_at, finished_at)
values
  ('zz-c809-failed', 'failed', 'boom', (select now from c809_now) - interval '5 minutes',
    (select now from c809_now) - interval '4 minutes'),
  ('zz-c809-running', 'running', null, (select now from c809_now) - interval '5 minutes', null),
  ('zz-c809-success', 'success', null, (select now from c809_now) - interval '5 minutes',
    (select now from c809_now) - interval '4 minutes');

select ok(
  not app_private.cron_job_started_since('zz-c809-failed', (select now from c809_now) - interval '1 hour'),
  'a failed pass does not count as a started pass'
);

select ok(
  app_private.cron_job_started_since('zz-c809-running', (select now from c809_now) - interval '1 hour'),
  'a pass still running counts, so a second one is not started on top of it'
);

select ok(
  app_private.cron_job_started_since('zz-c809-success', (select now from c809_now) - interval '1 hour'),
  'a successful pass counts as a started pass'
);

delete from public.operational_job_runs
where job_name = 'sale-flood-risk' and status = 'success';
insert into public.operational_job_runs (job_name, status, error_message, started_at, finished_at)
values ('sale-flood-risk', 'failed', 'Géorisques indisponible', (select now from c809_now) - interval '5 minutes',
  (select now from c809_now) - interval '4 minutes');

select ok(
  not app_private.cron_dispatch_due('sale-flood-risk', (select now from c809_now)),
  'the route is not called again within 5 minutes of the end of a failed pass'
);

update public.operational_job_runs
set started_at = (select now from c809_now) - interval '7 minutes',
    finished_at = (select now from c809_now) - interval '6 minutes'
where job_name = 'sale-flood-risk' and status = 'failed';

select ok(
  app_private.cron_dispatch_due('sale-flood-risk', (select now from c809_now)),
  'the flood risk check is due again at the next tick once 5 minutes have passed after a failed pass (not after 110 minutes)'
);

select * from finish();

rollback;
