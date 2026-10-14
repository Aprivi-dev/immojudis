-- Planification horaire du calcul de complétude (migration 20261024100100): Supabase Cron appelle
-- la route protégée avec l'origine et le Bearer déjà dans Vault, et la fraîcheur est surveillée.
begin;

select plan(9);

select has_function(
  'app_private',
  'invoke_listing_completeness_endpoint',
  array[]::text[],
  'the completeness scheduler callback exists'
);

select is(
  (select schedule from cron.job where jobname = 'immojudis-listing-completeness'),
  '20 * * * *',
  'the completeness job runs every hour in Supabase'
);

select ok(
  (select active from cron.job where jobname = 'immojudis-listing-completeness'),
  'the completeness scheduler is active'
);

select is(
  (select count(*) from cron.job where jobname = 'immojudis-listing-completeness'),
  1::bigint,
  'there is exactly one completeness scheduler'
);

select ok(
  position('immojudis_operational_health_url' in pg_get_functiondef(
    'app_private.invoke_listing_completeness_endpoint()'::regprocedure
  )) > 0
  and position('immojudis_operational_health_secret' in pg_get_functiondef(
    'app_private.invoke_listing_completeness_endpoint()'::regprocedure
  )) > 0,
  'the callback reads the canonical endpoint and bearer secret from Vault'
);

select ok(
  position('/api/cron/listing-completeness' in pg_get_functiondef(
    'app_private.invoke_listing_completeness_endpoint()'::regprocedure
  )) > 0
  and position('Authorization' in pg_get_functiondef(
    'app_private.invoke_listing_completeness_endpoint()'::regprocedure
  )) > 0,
  'the callback targets the guarded route with authorization'
);

select ok(
  not has_function_privilege(
    'anon', 'app_private.invoke_listing_completeness_endpoint()', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'app_private.invoke_listing_completeness_endpoint()', 'execute'
  )
  and not has_function_privilege(
    'service_role', 'app_private.invoke_listing_completeness_endpoint()', 'execute'
  ),
  'the Vault-backed scheduler callback is reserved to postgres'
);

select ok(
  position('(''listing-completeness'', interval ''3 hours'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'the freshness alert (cron.stale) expects a successful run every three hours'
);

select ok(
  position('(''information-agent-inbound'', interval ''10 minutes'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'the other expected jobs of the freshness alert are kept'
);

select * from finish();

rollback;
