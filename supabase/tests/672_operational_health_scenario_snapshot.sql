-- 20261101120200 (W3, point 6) : evaluate_operational_health surveille l'âge du cliché des lots des scénarios
-- d'enchères (auction_scenarios.snapshot.stale, ouverte au-delà de 3 jours) et garde les alertes précédentes.
begin;

select plan(11);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role', 'app_private.evaluate_operational_health(timestamptz)', 'execute'
      )
      and not has_function_privilege(
        'anon', 'app_private.evaluate_operational_health(timestamptz)', 'execute'
      )
      and not has_function_privilege(
        'authenticated', 'app_private.evaluate_operational_health(timestamptz)', 'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  ),
  'l''évaluation reste SECURITY DEFINER, fermée au navigateur, ouverte au service'
);

select ok(
  position('auction_scenarios.snapshot.stale' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('alerts.delivery.late' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('catalogue.invalidation.backlog' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('retention.sale.overdue' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('dvf.freshness' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('(''sale-reminders'', interval ''27 hours'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'la nouvelle définition porte l''alerte du cliché et garde les précédentes et la liste des tâches'
);

delete from public.operational_alerts;

create temporary table pgtap_672_context (p_now timestamptz not null) on commit drop;
insert into pgtap_672_context values ('2026-11-10T10:00:00Z');

-- Cliché recopié il y a deux jours et 23 heures : pas d'alerte.
insert into app_private.auction_scenario_snapshot_state (singleton, refreshed_at, observation_count)
values (true, '2026-11-10T10:00:00Z'::timestamptz - interval '2 days 23 hours', 3000)
on conflict (singleton) do update
  set refreshed_at = excluded.refreshed_at, observation_count = excluded.observation_count;

select lives_ok(
  $sql$select public.evaluate_operational_health((select p_now from pgtap_672_context))$sql$,
  'l''évaluation tourne avec un cliché de moins de 3 jours'
);
select is(
  (select count(*) from public.operational_alerts where alert_key = 'auction_scenarios.snapshot.stale'),
  0::bigint,
  'un cliché de moins de 3 jours n''ouvre pas auction_scenarios.snapshot.stale'
);

-- Trois jours et une heure.
update app_private.auction_scenario_snapshot_state
set refreshed_at = '2026-11-10T10:00:00Z'::timestamptz - interval '3 days 1 hour';
select public.evaluate_operational_health((select p_now from pgtap_672_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'auction_scenarios.snapshot.stale'
      and status = 'open'
      and category = 'cron'
      and severity = 'warning'
      and (details->>'age_hours')::integer = 73
      and (details->>'maximum_age_days')::integer = 3
  ),
  1::bigint,
  'un cliché de plus de 3 jours ouvre l''alerte (avertissement, avec son âge en heures)'
);
select is(
  (
    public.evaluate_operational_health((select p_now from pgtap_672_context))
    ->>'auction_scenario_snapshot_refreshed_at'
  )::timestamptz,
  '2026-11-10T10:00:00Z'::timestamptz - interval '3 days 1 hour',
  'la réponse porte la date du cliché'
);
select is(
  (select count(*) from public.operational_alerts where alert_key = 'auction_scenarios.snapshot.stale'),
  1::bigint,
  'une seconde évaluation ne double pas l''alerte'
);

-- La recopie réussit : l'alerte devient inactive puis se ferme après l'hystérésis de deux heures.
update app_private.auction_scenario_snapshot_state set refreshed_at = '2026-11-10T10:00:00Z';
update pgtap_672_context set p_now = p_now + interval '5 minutes';
select public.evaluate_operational_health((select p_now from pgtap_672_context));
select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'auction_scenarios.snapshot.stale'
  ),
  'après une recopie réussie, l''alerte devient inactive (elle reste ouverte pendant l''hystérésis)'
);
update pgtap_672_context set p_now = p_now + interval '2 hours 10 minutes';
select public.evaluate_operational_health((select p_now from pgtap_672_context));
select is(
  (select status from public.operational_alerts where alert_key = 'auction_scenarios.snapshot.stale'),
  'resolved',
  'l''alerte se ferme d''elle-même'
);

-- Un cliché jamais rempli (ligne absente) est signalé aussi.
delete from public.operational_alerts;
delete from app_private.auction_scenario_snapshot_state;
select public.evaluate_operational_health((select p_now from pgtap_672_context));
select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'auction_scenarios.snapshot.stale' and status = 'open'
      and details->'age_hours' = 'null'::jsonb
  ),
  1::bigint,
  'un cliché jamais rempli ouvre l''alerte (âge inconnu)'
);

-- Aucune autre alerte ne naît de ce contrôle.
select is(
  (select count(*) from public.operational_alerts where alert_key = 'auction_scenarios.snapshot.stale'),
  1::bigint,
  'une seule alerte pour le cliché'
);

select * from finish();
rollback;
