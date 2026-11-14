-- 20261119100820 : jours de simulation EFFECTIFS du pilote (relecture du lot B du 14/11/2026). Un jour compte s'il a
-- au moins un envoi simulé depuis le début de la simulation ET aucun passage en erreur (clé `error_<code>` dans le
-- détail d'un évènement `run`). Les autres compteurs ne changent pas.
begin;

select plan(3);

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

select * from finish();
rollback;
