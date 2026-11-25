-- 20261209101000 : correction du 25/11/2026 (décision du propriétaire). Après l'arrêt d'urgence involontaire du 25/11
-- à 10:01:36 UTC, le pilote repasse en simulation depuis le 2026-11-14 10:47:15.380297+00, et la correction est
-- journalisée par le système. Tout autre état est refusé sans rien modifier. Sur une base où le pilote n'a jamais été
-- mis en route (rejeu des migrations), il n'y a rien à corriger.
begin;

select plan(13);

-- Base de test : les migrations ont été rejouées à partir de zéro, sans historique du pilote.
select ok(
  (select mode = 'off' and simulation_started_at is null
   from public.information_agent_autopilot_settings where singleton)
  and not exists (
    select 1 from public.information_agent_autopilot_events where action = 'restore_simulation'
  ),
  'on a base where the autopilot never ran, the migration changes nothing'
);
select is(
  app_private.restore_information_agent_autopilot_simulation_20261125(),
  'nothing_to_correct',
  'without any mode change in the journal there is nothing to correct'
);

-- Historique de production : le journal est vidé (drapeau de la purge, transaction annulée à la fin) puis rempli.
select set_config('app.autopilot_purge', 'on', true);
delete from public.information_agent_autopilot_events;
select set_config('app.autopilot_purge', 'off', true);

insert into public.information_agent_autopilot_events (at, kind, actor, action, before_values, after_values, reason)
values (
  '2026-11-14 10:47:15.379+00', 'mode_changed', '92000000-0000-4000-8000-0000000000a1', 'set_mode',
  '{"mode": "off", "auto_stopped": false}', '{"mode": "simulation"}', 'Mise en route de la simulation'
);
insert into public.information_agent_autopilot_events (at, kind, action, run_id, details)
select day + interval '1 minute', 'would_send', 'would_send', run_id, '{}'::jsonb
from (values
  ('2026-11-17 09:00:00+00'::timestamptz, '92000000-0000-4000-8000-000000000b01'::uuid),
  ('2026-11-20 09:00:00+00'::timestamptz, '92000000-0000-4000-8000-000000000b02'::uuid),
  ('2026-11-24 09:00:00+00'::timestamptz, '92000000-0000-4000-8000-000000000b03'::uuid)
) as runs (day, run_id)
union all
select day + interval '2 minutes', 'run', 'run', run_id, '{"mode": "simulation", "would_send": 1}'::jsonb
from (values
  ('2026-11-17 09:00:00+00'::timestamptz, '92000000-0000-4000-8000-000000000b01'::uuid),
  ('2026-11-20 09:00:00+00'::timestamptz, '92000000-0000-4000-8000-000000000b02'::uuid),
  ('2026-11-24 09:00:00+00'::timestamptz, '92000000-0000-4000-8000-000000000b03'::uuid)
) as runs (day, run_id);
insert into public.information_agent_autopilot_events (at, kind, actor, action, before_values, after_values, reason)
values (
  '2026-11-25 10:01:36.512+00', 'emergency_stop', '92000000-0000-4000-8000-0000000000a1', 'stop',
  '{"mode": "simulation"}', '{"mode": "off"}', 'Arrêt d''urgence'
);
-- Trace de fin du passage en cours au moment de l'arrêt : un évènement `run` ne compte pas.
insert into public.information_agent_autopilot_events (at, kind, action, run_id, details)
values (
  '2026-11-25 10:03:00+00', 'run', 'run', '92000000-0000-4000-8000-000000000b04',
  '{"mode": "simulation", "skip_interrupted": 1}'
);
update public.information_agent_autopilot_settings
set mode = 'off', simulation_started_at = null, auto_stopped_at = null, auto_stop_reason = null
where singleton;

create temporary table settings_snapshot (value jsonb);

-- Refus 1 : le pilote a déjà été remis en simulation (nouvelle date).
update public.information_agent_autopilot_settings
set mode = 'simulation', simulation_started_at = '2026-11-25 14:00:00+00' where singleton;
insert into settings_snapshot select to_jsonb(s) from public.information_agent_autopilot_settings s;
select throws_like(
  $$select app_private.restore_information_agent_autopilot_simulation_20261125()$$,
  '%état inattendu%aucune modification faite.',
  'a pilot already back in simulation is refused'
);
select ok(
  (select to_jsonb(s) from public.information_agent_autopilot_settings s) = (select value from settings_snapshot)
  and not exists (
    select 1 from public.information_agent_autopilot_events where action = 'restore_simulation'
  ),
  'the refusal leaves the settings and the journal untouched'
);

-- Refus 2 : un arrêt automatique est inscrit.
truncate settings_snapshot;
update public.information_agent_autopilot_settings
set mode = 'off', simulation_started_at = null, auto_stopped_at = '2026-11-25 10:30:00+00',
    auto_stop_reason = 'complaints' where singleton;
insert into settings_snapshot select to_jsonb(s) from public.information_agent_autopilot_settings s;
select throws_like(
  $$select app_private.restore_information_agent_autopilot_simulation_20261125()$$,
  '%état inattendu%aucune modification faite.',
  'an automatic stop is refused'
);
select ok(
  (select to_jsonb(s) from public.information_agent_autopilot_settings s) = (select value from settings_snapshot)
  and not exists (
    select 1 from public.information_agent_autopilot_events where action = 'restore_simulation'
  ),
  'the refusal after an automatic stop leaves the settings and the journal untouched'
);

-- Refus 3 : un évènement hors passages suit l'arrêt d'urgence.
truncate settings_snapshot;
update public.information_agent_autopilot_settings
set auto_stopped_at = null, auto_stop_reason = null where singleton;
insert into public.information_agent_autopilot_events (at, kind, action, run_id, details)
values (
  '2026-11-25 10:04:00+00', 'skip', 'skip', '92000000-0000-4000-8000-000000000b04', '{"code": "interrupted"}'
);
insert into settings_snapshot select to_jsonb(s) from public.information_agent_autopilot_settings s;
select throws_like(
  $$select app_private.restore_information_agent_autopilot_simulation_20261125()$$,
  '%dernier évènement hors passages%aucune modification faite.',
  'an event other than a run after the emergency stop is refused'
);
select ok(
  (select to_jsonb(s) from public.information_agent_autopilot_settings s) = (select value from settings_snapshot)
  and not exists (
    select 1 from public.information_agent_autopilot_events where action = 'restore_simulation'
  ),
  'the refusal on the journal leaves the settings and the journal untouched'
);
select set_config('app.autopilot_purge', 'on', true);
delete from public.information_agent_autopilot_events where kind = 'skip';
select set_config('app.autopilot_purge', 'off', true);

-- État décrit : la correction s'applique.
select is(
  app_private.restore_information_agent_autopilot_simulation_20261125(),
  'restored',
  'after the emergency stop of 25/11 the correction applies'
);
select ok(
  (select mode = 'simulation' and simulation_started_at = '2026-11-14 10:47:15.380297+00'::timestamptz
     and auto_stopped_at is null
   from public.information_agent_autopilot_settings where singleton),
  'the pilot is back in simulation since the original date of 14/11'
);
select ok(
  (select pg_catalog.count(*) = 1
     and pg_catalog.bool_and(
       kind = 'settings_changed' and actor is null
       and reason = 'Correction 25/11 : arrêt d''urgence involontaire, simulation rétablie depuis le 14/11 (décision du propriétaire)'
       and before_values = '{"mode": "off", "simulation_started_at": null}'::jsonb
       and after_values ->> 'mode' = 'simulation'
       and (after_values ->> 'simulation_started_at')::timestamptz = '2026-11-14 10:47:15.380297+00'::timestamptz
       and position('@' in reason || details::text || before_values::text || after_values::text) = 0
     )
   from public.information_agent_autopilot_events where action = 'restore_simulation'),
  'the correction is journalled once, by the system, with its reason and without any address'
);
-- La porte relit la simulation depuis le 14/11 ; l'arrêt d'urgence n'est pas une anomalie.
select is(
  (select pg_catalog.jsonb_build_object(
     'would_send_days', stats -> 'would_send_days',
     'clean_simulation_days', stats -> 'clean_simulation_days',
     'anomalies_since_simulation', stats -> 'anomalies_since_simulation')
   from (select public.information_agent_autopilot_stats('2026-11-25 12:00:00+00') as stats) computed),
  '{"would_send_days": 3, "clean_simulation_days": 3, "anomalies_since_simulation": 0}'::jsonb,
  'the simulation days since 14/11 count again and the emergency stop is not an anomaly'
);
select throws_like(
  $$select app_private.restore_information_agent_autopilot_simulation_20261125()$$,
  '%état inattendu%aucune modification faite.',
  'a second correction is refused'
);

select * from finish();

rollback;
