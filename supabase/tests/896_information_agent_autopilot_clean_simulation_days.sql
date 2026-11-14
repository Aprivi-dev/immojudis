-- 20261119100820 : jours de simulation EFFECTIFS du pilote (relecture du lot B du 14/11/2026). Un jour compte s'il a
-- au moins un envoi simulé depuis le début de la simulation ET aucun passage en erreur (clé `error_<code>` dans le
-- détail d'un évènement `run`). Les autres compteurs ne changent pas. Les envois simulés d'un passage lancé à la
-- main (trace `run` du même run_id marquée `manual`) ne font pas un jour effectif ; son erreur gâte le jour.
begin;

select plan(6);

-- Journal vidé dans cette transaction (annulée à la fin) : seuls les évènements du test comptent.
select set_config('app.autopilot_purge', 'on', true);
delete from public.information_agent_autopilot_events;
select set_config('app.autopilot_purge', 'off', true);
update public.information_agent_autopilot_settings set simulation_started_at = now() - interval '5 days';

create or replace function pg_temp.stat(p_key text) returns integer language sql as $$
  select (public.information_agent_autopilot_stats(now()) ->> p_key)::integer
$$;

-- J-6 (avant la simulation) : ignoré. J-3 : propre. J-2 : passage en erreur. J-1 : envoi simulé sans passage journalisé.
insert into public.information_agent_autopilot_events (at, kind, details) values
  (now() - interval '6 days', 'would_send', '{}'),
  (now() - interval '3 days', 'would_send', '{}'),
  (now() - interval '3 days', 'run', '{"examined": 3, "would_send": 1, "skip_draft_stale": 1}'),
  (now() - interval '2 days', 'would_send', '{}'),
  (now() - interval '2 days', 'run', '{"examined": 3, "would_send": 1, "error_mark_failed": 1}'),
  (now() - interval '1 day', 'would_send', '{}');

select is(pg_temp.stat('would_send_days'), 3, 'days with a simulated send since the simulation started are unchanged');
select is(
  pg_temp.stat('clean_simulation_days'), 2,
  'a day with a run error does not count as an effective simulation day'
);
select is(
  pg_temp.stat('anomalies_since_simulation'), 0,
  'a run error spoils its day only: it is not an anomaly that resets the whole simulation'
);

-- Passage lancé à la main : sa trace `run` de début porte `manual` et le même run_id que ses envois simulés. Ceux-ci
-- ne comptent pas ; seuls les passages planifiés (sans cette marque) font un jour effectif.
-- J-4 : un passage à la main seulement (trace de début, envoi simulé, fin), sans erreur.
insert into public.information_agent_autopilot_events (at, kind, run_id, details) values
  (now() - interval '4 days', 'run', 'a8960000-0000-4000-8000-000000000001',
   '{"mode": "simulation", "code": "on_demand_started", "manual": true}'),
  (now() - interval '4 days', 'would_send', 'a8960000-0000-4000-8000-000000000001', '{}'),
  (now() - interval '4 days', 'run', 'a8960000-0000-4000-8000-000000000001',
   '{"mode": "simulation", "manual": true, "examined": 1, "would_send": 1}');

select is(
  pg_temp.stat('clean_simulation_days'), 2,
  'a day with only on-demand simulated sends does not count as an effective simulation day'
);

-- Aujourd'hui : un passage à la main, puis un passage planifié qui simule un envoi. Le jour compte par le second.
insert into public.information_agent_autopilot_events (at, kind, run_id, details) values
  (now(), 'run', 'a8960000-0000-4000-8000-000000000002',
   '{"mode": "simulation", "code": "on_demand_started", "manual": true}'),
  (now(), 'would_send', 'a8960000-0000-4000-8000-000000000002', '{}'),
  (now(), 'run', 'a8960000-0000-4000-8000-000000000002',
   '{"mode": "simulation", "manual": true, "examined": 1, "would_send": 1}'),
  (now(), 'would_send', 'a8960000-0000-4000-8000-000000000003', '{}'),
  (now(), 'run', 'a8960000-0000-4000-8000-000000000003',
   '{"mode": "simulation", "examined": 2, "would_send": 1}');

select is(
  pg_temp.stat('clean_simulation_days'), 3,
  'a day with a simulated send from a scheduled run counts, even if an on-demand run also ran that day'
);

-- J-1 (envoi simulé planifié, jour propre jusqu'ici) : un passage à la main en erreur gâte aussi la journée.
insert into public.information_agent_autopilot_events (at, kind, run_id, details) values
  (now() - interval '1 day', 'run', 'a8960000-0000-4000-8000-000000000004',
   '{"mode": "simulation", "manual": true, "examined": 1, "error_draft_error": 1}');

select is(
  pg_temp.stat('clean_simulation_days'), 2,
  'an on-demand run error spoils its day as well: errors of any run count'
);

select * from finish();
rollback;
