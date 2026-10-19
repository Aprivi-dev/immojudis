-- 20261028130200 : la tâche quotidienne sale-reminders est supervisée par cron.stale, sans retirer
-- aucune des tâches déjà attendues.
begin;

select plan(4);

select ok(
  position(
    '(''sale-reminders'', interval ''30 hours'')'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)
  ) > 0,
  'sale-reminders est attendue toutes les 30 heures (un passage de rattrapage compris)'
);

select ok(
  position(
    '(''listing-completeness'', interval ''3 hours'')'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)
  ) > 0
  and position(
    '(''sale-change-monitor'', interval ''30 hours'')'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)
  ) > 0,
  'les tâches déjà attendues restent dans la liste'
);

select is(
  (
    select count(*)::integer
    from regexp_matches(
      pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure),
      '\(''sale-reminders''',
      'g'
    )
  ),
  1,
  'la tâche n''est ajoutée qu''une fois'
);

select ok(
  not has_function_privilege('anon', 'app_private.evaluate_operational_health(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.evaluate_operational_health(timestamptz)', 'execute'),
  'l''évaluation de la santé opérationnelle reste fermée au navigateur'
);

select * from finish();

rollback;
