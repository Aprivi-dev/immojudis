begin;

select plan(10);

select has_function(
  'app_private',
  'invoke_information_agent_inbound_endpoint',
  array[]::text[],
  'the inbound worker callback exists'
);

select is(
  (select schedule from cron.job where jobname = 'immojudis-information-agent-inbound'),
  '*/2 * * * *',
  'the inbound worker runs every two minutes in Supabase'
);

select ok(
  (select active from cron.job where jobname = 'immojudis-information-agent-inbound'),
  'the inbound worker scheduler is active'
);

select is(
  (select count(*) from cron.job where jobname = 'immojudis-information-agent-inbound'),
  1::bigint,
  'there is exactly one inbound worker scheduler'
);

select ok(
  position('immojudis_operational_health_url' in pg_get_functiondef(
    'app_private.invoke_information_agent_inbound_endpoint()'::regprocedure
  )) > 0
  and position('immojudis_operational_health_secret' in pg_get_functiondef(
    'app_private.invoke_information_agent_inbound_endpoint()'::regprocedure
  )) > 0,
  'the callback reads the canonical endpoint and bearer secret from Vault'
);

select ok(
  position('/api/cron/information-agent-inbound' in pg_get_functiondef(
    'app_private.invoke_information_agent_inbound_endpoint()'::regprocedure
  )) > 0
  and position('Authorization' in pg_get_functiondef(
    'app_private.invoke_information_agent_inbound_endpoint()'::regprocedure
  )) > 0,
  'the callback targets the guarded inbound route with authorization'
);

select ok(
  position('280000' in pg_get_functiondef(
    'app_private.invoke_information_agent_inbound_endpoint()'::regprocedure
  )) > 0,
  'the callback allows the bounded worker request to finish'
);

select ok(
  exists (
    select 1
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.invoke_information_agent_inbound_endpoint()'::regprocedure
      and procedure_row.proacl is not null
      and not exists (
        select 1
        from unnest(procedure_row.proacl) privilege_row
        where privilege_row::text ~ '^=[^/]*X'
      )
  )
  and not has_function_privilege(
    'anon',
    'app_private.invoke_information_agent_inbound_endpoint()',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.invoke_information_agent_inbound_endpoint()',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'app_private.invoke_information_agent_inbound_endpoint()',
    'execute'
  ),
  'the Vault-backed scheduler callback is reserved to postgres'
);

select ok(
  position('invoke_information_agent_inbound_endpoint' in command) > 0,
  'the cron command invokes the inbound callback'
)
from cron.job
where jobname = 'immojudis-information-agent-inbound';

select ok(
  not exists (
    select 1
    from cron.job
    where jobname = 'immojudis-information-agent-inbound'
      and schedule <> '*/2 * * * *'
  ),
  'no alternate inbound schedule is active'
);

select * from finish();

rollback;
