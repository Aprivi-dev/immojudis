-- Planification horaire de l'observation du risque d'inondation (migration 20261106100300) : Supabase Cron
-- appelle la route protégée avec l'origine et le Bearer déjà dans Vault, décalée à :25 (avant le calcul des
-- pépites, à :35, qui lit le verdict), et la fraîcheur est surveillée par cron.stale (trois passages horaires
-- manqués) sans retirer aucune des tâches déjà attendues, pépites comprises.
begin;

select plan(13);

select has_function(
  'app_private',
  'invoke_sale_flood_risk_endpoint',
  array[]::text[],
  'the flood scheduler callback exists'
);

select is(
  (select schedule from cron.job where jobname = 'immojudis-sale-flood-risk'),
  '25 * * * *',
  'the flood job runs every hour, at :25, in Supabase'
);

select ok(
  (select active from cron.job where jobname = 'immojudis-sale-flood-risk'),
  'the flood scheduler is active'
);

select is(
  (select count(*) from cron.job where jobname = 'immojudis-sale-flood-risk'),
  1::bigint,
  'there is exactly one flood scheduler'
);

select isnt(
  (select schedule from cron.job where jobname = 'immojudis-sale-flood-risk'),
  (select schedule from cron.job where jobname = 'immojudis-listing-completeness'),
  'the flood job does not fall in the same minute as the completeness job'
);

select ok(
  position('immojudis_operational_health_url' in pg_get_functiondef(
    'app_private.invoke_sale_flood_risk_endpoint()'::regprocedure
  )) > 0
  and position('immojudis_operational_health_secret' in pg_get_functiondef(
    'app_private.invoke_sale_flood_risk_endpoint()'::regprocedure
  )) > 0,
  'the callback reads the canonical endpoint and bearer secret from Vault'
);

select ok(
  position('/api/cron/sale-flood-risk' in pg_get_functiondef(
    'app_private.invoke_sale_flood_risk_endpoint()'::regprocedure
  )) > 0
  and position('Authorization' in pg_get_functiondef(
    'app_private.invoke_sale_flood_risk_endpoint()'::regprocedure
  )) > 0,
  'the callback targets the guarded route with authorization'
);

select ok(
  not has_function_privilege('anon', 'app_private.invoke_sale_flood_risk_endpoint()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.invoke_sale_flood_risk_endpoint()', 'execute')
  and not has_function_privilege('service_role', 'app_private.invoke_sale_flood_risk_endpoint()', 'execute'),
  'the Vault-backed scheduler callback is reserved to postgres'
);

select ok(
  position('(''sale-flood-risk'', interval ''3 hours'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'the freshness alert (cron.stale) expects a successful run every three hours'
);

select is(
  (
    select count(*)::integer
    from regexp_matches(
      pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure),
      '\(''sale-flood-risk''',
      'g'
    )
  ),
  1,
  'the task is added once'
);

select ok(
  (
    select bool_and(
      position(
        '(''' || expected_job || ''', interval ''' in pg_get_functiondef(
          'app_private.evaluate_operational_health(timestamptz)'::regprocedure
        )
      ) > 0
    )
    from unnest(array[
      'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor',
      'data-retention', 'sale-retention', 'information-agent-inbound', 'listing-completeness',
      'sale-reminders', 'sale-pepites'
    ]) as expected_job
  ),
  'every previously expected job is still in the freshness alert'
);

select is(
  (select schedule from cron.job where jobname = 'immojudis-sale-pepites'),
  '35 * * * *',
  'the pepite job is unchanged, at :35 (the flood observation runs first)'
);

select ok(
  position('(''sale-pepites'', interval ''3 hours'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'the pepite freshness alert is still expected'
);

select * from finish();

rollback;
