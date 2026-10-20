-- 20261029170000 (W9, points 49 et 50) : seuils de cron.stale et de pipeline.import.unhealthy.
--   * les quatre tâches quotidiennes de Vercel sont attendues toutes les 27 heures (et non plus 30) ;
--   * cron.stale pour sale-reminders se referme d'elle-même dès que la tâche a réussi une fois
--     (première exécution du 20/10 : l'alerte ouverte depuis l'ajout de la tâche à la liste) ;
--   * un seul échec d'import dans l'heure, file vide, n'ouvre plus pipeline.import.unhealthy.
begin;

select plan(23);

delete from public.operational_alerts;
delete from public.operational_job_runs;
delete from public.auction_runs;

create temporary table pgtap_599_context (p_now timestamptz not null) on commit drop;
insert into pgtap_599_context values ('2026-10-20T10:00:00Z');

-- Une exécution réussie de chaque tâche attendue, terminée une minute avant l'instant de l'évaluation.
-- `skipped` désigne les tâches qu'on n'enregistre pas.
create function pg_temp.fresh_runs(p_at timestamptz, skipped text[] default '{}') returns void
language sql as $$
  insert into public.operational_job_runs (job_name, status, started_at, finished_at)
  select job_name, 'success', p_at - interval '2 minutes', p_at - interval '1 minute'
  from unnest(array[
    'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor',
    'data-retention', 'sale-retention', 'information-agent-inbound', 'listing-completeness',
    'sale-reminders'
  ]) as job_name
  where not (job_name = any (skipped));
$$;

-- ---------------------------------------------------------------------------------------------
-- cron.stale : liste et seuils
-- ---------------------------------------------------------------------------------------------
select ok(
  (
    select bool_and(
      position(
        '(''' || job_name || ''', interval ''27 hours'')' in pg_get_functiondef(
          'app_private.evaluate_operational_health(timestamptz)'::regprocedure
        )
      ) > 0
    )
    from unnest(array[
      'smart-alerts', 'alert-notifications', 'sale-change-monitor', 'sale-reminders'
    ]) as job_name
  ),
  'les quatre tâches quotidiennes de Vercel sont attendues toutes les 27 heures'
);

select ok(
  position('interval ''30 hours''' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) = 0,
  'plus aucun seuil de 30 heures dans la liste attendue'
);

select ok(
  (
    select bool_and(
      position(
        '(''' || job_name || ''', interval ''' in pg_get_functiondef(
          'app_private.evaluate_operational_health(timestamptz)'::regprocedure
        )
      ) > 0
    )
    from unnest(array[
      'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor',
      'data-retention', 'sale-retention', 'information-agent-inbound', 'listing-completeness',
      'sale-reminders'
    ]) as job_name
  ),
  'les neuf tâches attendues sont toujours dans la liste'
);

select ok(
  position('precompute-valuations' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) = 0
  and position('cnb-lawyer-directory' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) = 0,
  'les tâches déclenchées à la main ne sont toujours pas supervisées comme des crons'
);

-- Limite des 27 heures : une exécution de smart-alerts terminée 26 h 59 avant l'évaluation passe,
-- une exécution de 27 h 01 non.
select pg_temp.fresh_runs((select p_now from pgtap_599_context), array['smart-alerts']);
insert into public.operational_job_runs (job_name, status, started_at, finished_at)
values (
  'smart-alerts', 'success',
  '2026-10-20T10:00:00Z'::timestamptz - interval '27 hours',
  '2026-10-20T10:00:00Z'::timestamptz - interval '26 hours 59 minutes'
);

select is(
  (
    select public.evaluate_operational_health((select p_now from pgtap_599_context))
      ->'stale_cron_jobs'
  ),
  '[]'::jsonb,
  'un succès de smart-alerts il y a 26 h 59 n''est pas périmé'
);

delete from public.operational_job_runs where job_name = 'smart-alerts';
insert into public.operational_job_runs (job_name, status, started_at, finished_at)
values (
  'smart-alerts', 'success',
  '2026-10-20T10:00:00Z'::timestamptz - interval '27 hours 5 minutes',
  '2026-10-20T10:00:00Z'::timestamptz - interval '27 hours 1 minute'
);

select is(
  (
    select public.evaluate_operational_health((select p_now from pgtap_599_context))
      ->'stale_cron_jobs'
  ),
  '["smart-alerts"]'::jsonb,
  'un succès de smart-alerts il y a 27 h 01 est périmé'
);

select ok(
  (
    select status = 'open' and severity = 'critical'
      and details->'stale_jobs' = '["smart-alerts"]'::jsonb
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'cron.stale s''ouvre en critique et nomme la tâche périmée'
);

-- ---------------------------------------------------------------------------------------------
-- cron.stale pour sale-reminders : s'ouvre avant la première exécution, se ferme d'elle-même après.
-- ---------------------------------------------------------------------------------------------
delete from public.operational_alerts;
delete from public.operational_job_runs;
update pgtap_599_context set p_now = '2026-10-20T06:00:00Z';
select pg_temp.fresh_runs((select p_now from pgtap_599_context), array['sale-reminders']);

select is(
  (
    select public.evaluate_operational_health((select p_now from pgtap_599_context))
      ->'stale_cron_jobs'
  ),
  '["sale-reminders"]'::jsonb,
  'avant sa première exécution, sale-reminders est la seule tâche périmée'
);

select ok(
  (
    select status = 'open' and details->'stale_jobs' = '["sale-reminders"]'::jsonb
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'cron.stale est ouverte pour sale-reminders (état de production du 20/10)'
);

-- La tâche s'exécute (Vercel, 07:15 à 59 minutes près) : l'alerte devient inactive au passage suivant...
update pgtap_599_context set p_now = '2026-10-20T07:30:00Z';
select pg_temp.fresh_runs((select p_now from pgtap_599_context));

select is(
  (
    select public.evaluate_operational_health((select p_now from pgtap_599_context))
      ->'stale_cron_jobs'
  ),
  '[]'::jsonb,
  'après le premier succès de sale-reminders, plus aucune tâche n''est périmée'
);

select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'l''alerte devient inactive (elle reste ouverte pendant l''hystérésis de deux heures)'
);

-- ... puis se ferme d'elle-même.
update pgtap_599_context set p_now = '2026-10-20T09:45:00Z';
select pg_temp.fresh_runs((select p_now from pgtap_599_context));
select public.evaluate_operational_health((select p_now from pgtap_599_context));

select is(
  (select status from public.operational_alerts where alert_key = 'cron.stale'),
  'resolved',
  'cron.stale se referme d''elle-même, sans intervention, deux heures après le premier succès'
);

-- Un jour manqué est vu : la tâche réussit à 07:30 le 20/10, rien le 21/10, et à 10:35 le 21/10 (27 h 05
-- plus tard) l'alerte se rouvre, que le passage de rattrapage (09:15) ait eu lieu ou non.
delete from public.operational_job_runs where job_name = 'sale-reminders';
insert into public.operational_job_runs (job_name, status, started_at, finished_at)
values ('sale-reminders', 'success', '2026-10-20T07:29:00Z', '2026-10-20T07:30:00Z');
update pgtap_599_context set p_now = '2026-10-21T10:35:00Z';
select pg_temp.fresh_runs((select p_now from pgtap_599_context), array['sale-reminders']);

select is(
  (
    select public.evaluate_operational_health((select p_now from pgtap_599_context))
      ->'stale_cron_jobs'
  ),
  '["sale-reminders"]'::jsonb,
  'un jour entier sans succès (27 h 05) rouvre la détection de sale-reminders'
);

select ok(
  (
    select status = 'open' and inactive_since is null
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'cron.stale est rouverte'
);

-- ---------------------------------------------------------------------------------------------
-- pipeline.import.unhealthy
-- ---------------------------------------------------------------------------------------------
delete from public.operational_alerts;
delete from public.auction_runs;
delete from public.operational_job_runs;
update pgtap_599_context set p_now = '2026-10-20T12:00:00Z';
select pg_temp.fresh_runs((select p_now from pgtap_599_context));

-- État de production : un échec dans l'heure, file vide.
insert into public.auction_runs (status, finished_at, created_at, updated_at)
values ('failed', '2026-10-20T11:40:00Z', '2026-10-20T11:30:00Z', '2026-10-20T11:40:00Z');

select is(
  (
    select (public.evaluate_operational_health((select p_now from pgtap_599_context))
      ->>'import_failures')::integer
  ),
  1,
  'l''échec de l''heure est compté (le compteur du résultat ne change pas)'
);

select is(
  (select count(*) from public.operational_alerts where alert_key = 'pipeline.import.unhealthy'),
  0::bigint,
  'un seul échec dans l''heure, file vide : pipeline.import.unhealthy reste fermée'
);

-- Deux échecs de plus : trois dans l'heure.
insert into public.auction_runs (status, finished_at, created_at, updated_at)
values
  ('failed', '2026-10-20T11:45:00Z', '2026-10-20T11:35:00Z', '2026-10-20T11:45:00Z'),
  ('failed', '2026-10-20T11:50:00Z', '2026-10-20T11:36:00Z', '2026-10-20T11:50:00Z');
select public.evaluate_operational_health((select p_now from pgtap_599_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.import.unhealthy'
      and status = 'open'
      and severity = 'warning'
      and (details->>'failed_last_hour')::integer = 3
      and (details->>'failure_threshold')::integer = 3
  ),
  1::bigint,
  'trois échecs dans l''heure ouvrent pipeline.import.unhealthy (avertissement)'
);

-- Un échec dans l'heure, mais une file qui attend : incident.
delete from public.operational_alerts where alert_key = 'pipeline.import.unhealthy';
delete from public.auction_runs;
insert into public.auction_runs (status, finished_at, created_at, updated_at)
values ('failed', '2026-10-20T11:40:00Z', '2026-10-20T11:30:00Z', '2026-10-20T11:40:00Z');
insert into public.auction_runs (status, created_at, updated_at)
values ('queued', '2026-10-20T11:55:00Z', '2026-10-20T11:55:00Z');
select public.evaluate_operational_health((select p_now from pgtap_599_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.import.unhealthy'
      and status = 'open'
      and (details->>'failed_last_hour')::integer = 1
      and (details->>'queued')::integer = 1
  ),
  1::bigint,
  'un échec dans l''heure avec une exécution en file ouvre l''alerte'
);

-- Un import bloqué (plus de 3 h) reste critique, comme avant.
delete from public.operational_alerts where alert_key = 'pipeline.import.unhealthy';
delete from public.auction_runs;
insert into public.auction_runs (status, started_at, created_at, updated_at)
values ('running', '2026-10-20T08:00:00Z', '2026-10-20T08:00:00Z', '2026-10-20T08:00:00Z');
select public.evaluate_operational_health((select p_now from pgtap_599_context));

select is(
  (
    select severity
    from public.operational_alerts
    where alert_key = 'pipeline.import.unhealthy' and status = 'open'
  ),
  'critical',
  'un import bloqué depuis plus de 3 heures est toujours critique'
);

-- Une file qui attend depuis plus de 30 minutes ouvre toujours l'alerte.
delete from public.operational_alerts where alert_key = 'pipeline.import.unhealthy';
delete from public.auction_runs;
insert into public.auction_runs (status, created_at, updated_at)
values ('queued', '2026-10-20T11:00:00Z', '2026-10-20T11:00:00Z');
select public.evaluate_operational_health((select p_now from pgtap_599_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.import.unhealthy' and status = 'open'
  ),
  1::bigint,
  'une exécution en file depuis plus de 30 minutes ouvre l''alerte'
);

-- L'alerte actuelle se referme dès que l'état redevient sain.
delete from public.auction_runs;
update pgtap_599_context set p_now = p_now + interval '10 minutes';
select pg_temp.fresh_runs((select p_now from pgtap_599_context));
select public.evaluate_operational_health((select p_now from pgtap_599_context));

select ok(
  (
    select inactive_since is not null
    from public.operational_alerts
    where alert_key = 'pipeline.import.unhealthy'
  ),
  'la file vide et sans échec rend l''alerte inactive'
);

update pgtap_599_context set p_now = p_now + interval '2 hours 10 minutes';
select pg_temp.fresh_runs((select p_now from pgtap_599_context));
select public.evaluate_operational_health((select p_now from pgtap_599_context));

select is(
  (select status from public.operational_alerts where alert_key = 'pipeline.import.unhealthy'),
  'resolved',
  'pipeline.import.unhealthy se referme d''elle-même'
);

select ok(
  (
    select procedure_row.prosecdef
      and has_function_privilege(
        'service_role', 'public.evaluate_operational_health(timestamptz)', 'execute'
      )
      and not has_function_privilege(
        'authenticated', 'public.evaluate_operational_health(timestamptz)', 'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid = 'public.evaluate_operational_health(timestamptz)'::regprocedure
  ),
  'l''enveloppe publique reste réservée au service'
);

select * from finish();

rollback;
