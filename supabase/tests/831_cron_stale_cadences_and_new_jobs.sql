-- 20261110120100 (n° 36) et 20261110120200 (n° 39) : seuils de cron.stale alignés sur les cadences réelles de
-- 20261110100713, et sale-results / weekly-digest dans la liste attendue.
--   * operational-health 65 min, sale-retention 35 min, information-agent-inbound 25 min, sale-flood-risk 5 h ;
--   * sale-results 27 h, weekly-digest 8 jours ;
--   * aucune des onze tâches précédentes n'a quitté la liste.
begin;

select plan(16);

delete from public.operational_alerts;
delete from public.operational_job_runs;

-- Une exécution réussie de chaque tâche attendue, terminée une minute avant l'instant de l'évaluation
-- (fact-registry-check : tâche ajoutée à la liste par 20261117100600, testée dans 889).
create function pg_temp.fresh_runs(p_at timestamptz, skipped text[] default '{}') returns void
language sql as $$
  insert into public.operational_job_runs (job_name, status, started_at, finished_at)
  select job_name, 'success', p_at - interval '2 minutes', p_at - interval '1 minute'
  from unnest(array[
    'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor',
    'data-retention', 'sale-retention', 'information-agent-inbound', 'listing-completeness',
    'sale-pepites', 'sale-flood-risk', 'sale-reminders', 'sale-results', 'weekly-digest',
    'fact-registry-check'
  ]) as job_name
  where not (job_name = any (skipped));
$$;

-- Un succès de la tâche terminé il y a p_age (à la place de la dernière exécution fraîche).
create function pg_temp.last_success_ago(p_job text, p_at timestamptz, p_age interval) returns void
language sql as $$
  delete from public.operational_job_runs where job_name = p_job;
  insert into public.operational_job_runs (job_name, status, started_at, finished_at)
  values (p_job, 'success', p_at - p_age - interval '1 minute', p_at - p_age);
$$;

create function pg_temp.stale(p_at timestamptz) returns jsonb
language sql as $$
  select public.evaluate_operational_health(p_at) -> 'stale_cron_jobs';
$$;

create temporary table pgtap_831_context (p_now timestamptz not null) on commit drop;
insert into pgtap_831_context values ('2026-11-10T10:00:00Z');

-- La liste et les seuils ---------------------------------------------------------------------------------

select ok(
  (
    select bool_and(position(fragment in pg_get_functiondef(
      'app_private.evaluate_operational_health(timestamptz)'::regprocedure
    )) > 0)
    from unnest(array[
      '(''operational-health'', interval ''65 minutes'')',
      '(''sale-retention'', interval ''35 minutes'')',
      '(''information-agent-inbound'', interval ''25 minutes'')',
      '(''sale-flood-risk'', interval ''5 hours'')',
      '(''sale-results'', interval ''27 hours'')',
      '(''weekly-digest'', interval ''8 days'')'
    ]) as fragment
  ),
  'les seuils alignés sur les cadences et les deux nouvelles tâches sont dans la liste attendue'
);

select ok(
  (
    select bool_and(position(fragment in pg_get_functiondef(
      'app_private.evaluate_operational_health(timestamptz)'::regprocedure
    )) = 0)
    from unnest(array[
      '(''operational-health'', interval ''45 minutes'')',
      '(''sale-retention'', interval ''20 minutes'')',
      '(''information-agent-inbound'', interval ''10 minutes'')',
      '(''sale-flood-risk'', interval ''3 hours'')'
    ]) as fragment
  ),
  'les anciens seuils ont disparu'
);

select ok(
  (
    select bool_and(position('(''' || job_name || ''', interval ''' in pg_get_functiondef(
      'app_private.evaluate_operational_health(timestamptz)'::regprocedure
    )) > 0)
    from unnest(array[
      'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor',
      'data-retention', 'sale-retention', 'information-agent-inbound', 'listing-completeness',
      'sale-pepites', 'sale-flood-risk', 'sale-reminders', 'sale-results', 'weekly-digest'
    ]) as job_name
  ),
  'aucune des onze tâches précédentes n''a quitté la liste, les treize sont attendues'
);

-- Tout est frais : rien n'est périmé ---------------------------------------------------------------------

select pg_temp.fresh_runs((select p_now from pgtap_831_context));

select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '[]'::jsonb,
  'avec un succès récent de chacune des treize tâches, aucune n''est périmée'
);

-- operational-health : 65 minutes (cadence 30 min) --------------------------------------------------------

select pg_temp.last_success_ago('operational-health', (select p_now from pgtap_831_context), interval '64 minutes');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '[]'::jsonb,
  'un succès d''operational-health il y a 64 min n''est pas périmé'
);

select pg_temp.last_success_ago('operational-health', (select p_now from pgtap_831_context), interval '66 minutes');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '["operational-health"]'::jsonb,
  'un succès d''operational-health il y a 66 min est périmé'
);
select pg_temp.last_success_ago('operational-health', (select p_now from pgtap_831_context), interval '1 minute');

-- sale-retention : 35 minutes (cadence 15 min) --------------------------------------------------------------

select pg_temp.last_success_ago('sale-retention', (select p_now from pgtap_831_context), interval '34 minutes');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '[]'::jsonb,
  'un succès de sale-retention il y a 34 min n''est pas périmé'
);

select pg_temp.last_success_ago('sale-retention', (select p_now from pgtap_831_context), interval '36 minutes');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '["sale-retention"]'::jsonb,
  'un succès de sale-retention il y a 36 min est périmé'
);
select pg_temp.last_success_ago('sale-retention', (select p_now from pgtap_831_context), interval '1 minute');

-- information-agent-inbound : 25 minutes (cadence 8 min) -----------------------------------------------------

select pg_temp.last_success_ago('information-agent-inbound', (select p_now from pgtap_831_context), interval '24 minutes');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '[]'::jsonb,
  'un succès d''information-agent-inbound il y a 24 min n''est pas périmé'
);

select pg_temp.last_success_ago('information-agent-inbound', (select p_now from pgtap_831_context), interval '26 minutes');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '["information-agent-inbound"]'::jsonb,
  'un succès d''information-agent-inbound il y a 26 min est périmé'
);
select pg_temp.last_success_ago('information-agent-inbound', (select p_now from pgtap_831_context), interval '1 minute');

-- sale-flood-risk : 5 heures (cadence 2 h) -------------------------------------------------------------------

select pg_temp.last_success_ago('sale-flood-risk', (select p_now from pgtap_831_context), interval '4 hours 59 minutes');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '[]'::jsonb,
  'un succès de sale-flood-risk il y a 4 h 59 n''est pas périmé'
);

select pg_temp.last_success_ago('sale-flood-risk', (select p_now from pgtap_831_context), interval '5 hours 1 minute');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '["sale-flood-risk"]'::jsonb,
  'un succès de sale-flood-risk il y a 5 h 01 est périmé'
);
select pg_temp.last_success_ago('sale-flood-risk', (select p_now from pgtap_831_context), interval '1 minute');

-- sale-results (27 h) et weekly-digest (8 jours) ---------------------------------------------------------------

select pg_temp.last_success_ago('sale-results', (select p_now from pgtap_831_context), interval '26 hours 59 minutes');
select pg_temp.last_success_ago('weekly-digest', (select p_now from pgtap_831_context), interval '7 days 23 hours');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '[]'::jsonb,
  'sale-results à 26 h 59 et weekly-digest à 7 jours 23 h ne sont pas périmés'
);

select pg_temp.last_success_ago('sale-results', (select p_now from pgtap_831_context), interval '27 hours 1 minute');
select pg_temp.last_success_ago('weekly-digest', (select p_now from pgtap_831_context), interval '8 days 1 hour');
select is(
  pg_temp.stale((select p_now from pgtap_831_context)),
  '["sale-results", "weekly-digest"]'::jsonb,
  'sale-results à 27 h 01 et weekly-digest à 8 jours 1 h sont périmés et nommés'
);

-- Deux tâches qui n'ont jamais réussi : alerte critique, qui se referme d'elle-même au premier succès ----------

delete from public.operational_job_runs where job_name in ('sale-results', 'weekly-digest');
select pg_temp.stale((select p_now from pgtap_831_context));

select ok(
  (
    select status = 'open' and severity = 'critical'
      and details->'stale_jobs' = '["sale-results", "weekly-digest"]'::jsonb
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'avant leur premier succès, cron.stale s''ouvre en critique et nomme les deux tâches (état attendu à l''ouverture)'
);

select pg_temp.fresh_runs(
  (select p_now from pgtap_831_context) + interval '15 minutes',
  array['operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor', 'data-retention',
    'sale-retention', 'information-agent-inbound', 'listing-completeness', 'sale-pepites', 'sale-flood-risk',
    'sale-reminders']
);
select pg_temp.stale((select p_now from pgtap_831_context) + interval '15 minutes');

select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'après le premier succès de chaque tâche l''alerte devient inactive (elle se ferme deux heures plus tard)'
);

select * from finish();
rollback;
