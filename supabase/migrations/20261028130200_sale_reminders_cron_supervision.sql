begin;

-- Supervision de la tâche quotidienne /api/cron/sale-reminders (rappels d'audience et
-- avertissements graves): ajouter 'sale-reminders' à la liste des tâches attendues de cron.stale,
-- avec le seuil des autres tâches quotidiennes (30 heures, un passage de rattrapage compris).
-- Même méthode que 20261024100100 (listing-completeness): refuser de deviner si une migration
-- ultérieure a changé la forme de cette liste.  La tâche est enregistrée à chaque passage même
-- quand SALE_REMINDERS_MODE vaut off (le passage réussit sans rien envoyer): la supervision ne
-- dépend donc pas du mode.
do $$
declare
  definition text;
begin
  definition := pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure);
  if position('(''sale-reminders''' in definition) = 0 then
    if position('(''listing-completeness'', interval ''3 hours'')' in definition) = 0 then
      raise exception 'Operational health expected-jobs list changed; review sale reminders monitoring';
    end if;
    execute replace(
      definition,
      '(''listing-completeness'', interval ''3 hours'')',
      '(''listing-completeness'', interval ''3 hours''), (''sale-reminders'', interval ''30 hours'')'
    );
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
