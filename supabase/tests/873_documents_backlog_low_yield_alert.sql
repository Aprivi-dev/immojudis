-- 20261111131500 : alerte de rendement du vidage des pièces (pipeline.documents_backlog.low_yield).
--   * la fonction est security definer, avec un search_path vide, et fermée à public, anon, authenticated et
--     service_role (appelée par le rôle de connexion du pipeline, comme withdraw_missing_source_sales) ;
--   * elle ouvre cette seule clé, en avertissement, catégorie import, avec le détail transmis ;
--   * elle refuse un détail qui n'est pas un objet JSON et un drapeau absent ;
--   * la fermeture suit l'hystérésis commune de deux heures ;
--   * son commentaire donne la règle du 08/11/2026 (plus de 30 minutes, attente du verrou retranchée).
begin;

select plan(10);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and not has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.sync_documents_backlog_low_yield_alert(boolean, jsonb, timestamptz)'::regprocedure
  ),
  'the function is security definer, with an empty search_path, and closed to the API roles'
);

select ok(
  obj_description(
    'app_private.sync_documents_backlog_low_yield_alert(boolean, jsonb, timestamptz)'::regprocedure,
    'pg_proc'
  ) like '%plus de 30 minutes (attente du verrou du catalogue retranchée)%',
  'the comment states the evaluated duration: more than 30 minutes, lock wait excluded'
);

-- Rollback-only fixture.
delete from public.operational_alerts where alert_key = 'pipeline.documents_backlog.low_yield';

select lives_ok(
  $sql$
    select app_private.sync_documents_backlog_low_yield_alert(
      true,
      '{"sales_read": 2, "sales_read_per_hour": 1.0, "partial_pass_share": 0.6, "reasons": ["low_read_rate", "partial_passes"]}'::jsonb,
      statement_timestamp()
    );
  $sql$,
  'a low-yield drain is recorded'
);

select is(
  (
    select concat_ws(':', status, category, severity, details->>'sales_read')
      from public.operational_alerts
     where alert_key = 'pipeline.documents_backlog.low_yield'
  ),
  'open:import:warning:2',
  'the alert opens as a warning of the import category, with the drain figures'
);

select throws_ok(
  $sql$
    select app_private.sync_documents_backlog_low_yield_alert(true, '[1, 2]'::jsonb, statement_timestamp());
  $sql$,
  '22023',
  'The document backlog yield alert details must be a JSON object.',
  'details that are not a JSON object are refused'
);

select throws_ok(
  $sql$
    select app_private.sync_documents_backlog_low_yield_alert(null, '{}'::jsonb, statement_timestamp());
  $sql$,
  '22004',
  'The document backlog yield alert needs an explicit active flag.',
  'a missing active flag is refused'
);

select lives_ok(
  $sql$
    select app_private.sync_documents_backlog_low_yield_alert(
      false, '{"sales_read": 30}'::jsonb, statement_timestamp() + interval '1 hour'
    );
  $sql$,
  'a healthy long drain is recorded'
);

select is(
  (
    select status
      from public.operational_alerts
     where alert_key = 'pipeline.documents_backlog.low_yield'
  ),
  'open',
  'the alert stays open right after a healthy drain (two-hour hysteresis)'
);

select lives_ok(
  $sql$
    select app_private.sync_documents_backlog_low_yield_alert(
      false, '{"sales_read": 35}'::jsonb, statement_timestamp() + interval '4 hours'
    );
  $sql$,
  'a second healthy long drain is recorded'
);

select is(
  (
    select status
      from public.operational_alerts
     where alert_key = 'pipeline.documents_backlog.low_yield'
  ),
  'resolved',
  'a second healthy long drain more than two hours later closes it'
);

select * from finish();
rollback;
