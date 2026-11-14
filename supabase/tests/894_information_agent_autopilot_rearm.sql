-- Réarmement de l'arrêt automatique du pilote (défaut I1 de la relecture du 14/11/2026, resserré par la relecture de
-- la PR #501) : les rejets de politique (`rejected_7d`) et les erreurs d'API consécutives (`consecutive_api_errors`)
-- se comptent depuis la dernière réactivation journalisée APRÈS UN ARRÊT AUTOMATIQUE (changement de mode vers
-- « simulation » ou « live » dont `before_values.auto_stopped` est vrai). Un changement de mode sans arrêt
-- automatique préalable ne remet rien à zéro, et la fonction de changement de mode refuse de reposer le même mode.
-- Les seuils ne changent pas.
begin;

select plan(13);

-- Journal vidé dans cette transaction (annulée à la fin) : seuls les évènements du test comptent.
select set_config('app.autopilot_purge', 'on', true);
delete from public.information_agent_autopilot_events;
select set_config('app.autopilot_purge', 'off', true);

create or replace function pg_temp.stat(p_key text) returns integer language sql as $$
  select (public.information_agent_autopilot_stats(now()) ->> p_key)::integer
$$;

-- Avant l'arrêt : deux rejets, trois erreurs d'API, aucun envoi réussi.
insert into public.information_agent_autopilot_events (at, kind, details) values
  (now() - interval '3 hours', 'skip', '{"code": "policy_rejected"}'),
  (now() - interval '3 hours', 'skip', '{"code": "content_rejected"}'),
  (now() - interval '3 hours', 'send_error', '{"status": 500}'),
  (now() - interval '3 hours', 'send_error', '{"status": 500}'),
  (now() - interval '3 hours', 'send_error', '{"status": 500}');
select ok(
  pg_temp.stat('rejected_7d') = 2 and pg_temp.stat('consecutive_api_errors') = 3,
  'without any reactivation the signals count as before (two rejections in 7 days, three API errors)'
);

-- Arrêt automatique, puis réactivation journalisée vers « simulation ».
insert into public.information_agent_autopilot_events (at, kind, action, before_values, after_values, reason) values
  (now() - interval '2 hours', 'auto_stop', 'stop', '{"mode": "live"}', '{"mode": "off"}', 'policy_rejections'),
  (now() - interval '1 hour', 'mode_changed', 'set_mode', '{"mode": "off", "auto_stopped": true}',
   '{"mode": "simulation"}', 'Reprise après vérification');
select ok(
  pg_temp.stat('rejected_7d') = 0 and pg_temp.stat('consecutive_api_errors') = 0,
  'after a journalled reactivation following an automatic stop, rejections and API errors count from zero again'
);

-- Les signaux d'après la réactivation comptent, avec les mêmes seuils.
insert into public.information_agent_autopilot_events (at, kind, details) values
  (now() - interval '50 minutes', 'skip', '{"code": "policy_rejected"}'),
  (now() - interval '50 minutes', 'skip', '{"code": "interrupted"}'),
  (now() - interval '50 minutes', 'send_error', '{"status": 500}'),
  (now() - interval '50 minutes', 'send_error', '{"status": 429}');
select ok(
  pg_temp.stat('rejected_7d') = 1 and pg_temp.stat('consecutive_api_errors') = 1,
  'signals after the reactivation still count (other skip codes and 429 still do not)'
);

-- Un passage à « off » n'est pas une réactivation : rien n'est remis à zéro.
insert into public.information_agent_autopilot_events (at, kind, action, before_values, after_values, reason) values
  (now() - interval '45 minutes', 'mode_changed', 'set_mode', '{"mode": "simulation", "auto_stopped": false}',
   '{"mode": "off"}', 'Pause pour vérification');
select ok(
  pg_temp.stat('rejected_7d') = 1 and pg_temp.stat('consecutive_api_errors') = 1,
  'a change to off is not a reactivation and resets nothing'
);

-- Un passage en réel sans arrêt automatique préalable ne remet rien à zéro.
insert into public.information_agent_autopilot_events (at, kind, action, before_values, after_values, reason) values
  (now() - interval '40 minutes', 'mode_changed', 'set_mode', '{"mode": "off", "auto_stopped": false}',
   '{"mode": "live"}', 'Passage en réel autorisé');
select ok(
  pg_temp.stat('rejected_7d') = 1 and pg_temp.stat('consecutive_api_errors') = 1,
  'a change to live without a prior automatic stop resets nothing'
);

-- Pas davantage un changement de mode vers le même mode (journal ancien, avant le refus de la fonction).
insert into public.information_agent_autopilot_events (at, kind, action, before_values, after_values, reason) values
  (now() - interval '35 minutes', 'mode_changed', 'set_mode', '{"mode": "simulation", "auto_stopped": false}',
   '{"mode": "simulation"}', 'Relance de la simulation');
select ok(
  pg_temp.stat('rejected_7d') = 1 and pg_temp.stat('consecutive_api_errors') = 1,
  'a simulation to simulation change without a prior automatic stop resets nothing'
);

-- Arrêt automatique, puis réactivation directe vers « live » : remise à zéro.
insert into public.information_agent_autopilot_events (at, kind, action, before_values, after_values, reason) values
  (now() - interval '30 minutes', 'auto_stop', 'stop', '{"mode": "live"}', '{"mode": "off"}', 'api_errors'),
  (now() - interval '25 minutes', 'mode_changed', 'set_mode', '{"mode": "off", "auto_stopped": true}',
   '{"mode": "live"}', 'Reprise en réel après vérification');
select ok(
  pg_temp.stat('rejected_7d') = 0 and pg_temp.stat('consecutive_api_errors') = 0,
  'a reactivation to live after an automatic stop restarts the count'
);

-- Un envoi réussi clôt toujours une série d'erreurs d'API ; la fenêtre des rejets reste de 7 jours.
insert into public.information_agent_autopilot_events (at, kind, details) values
  (now() - interval '20 minutes', 'skip', '{"code": "content_rejected"}'),
  (now() - interval '20 minutes', 'send_error', '{"status": 500}'),
  (now() - interval '10 minutes', 'sent', '{}');
select ok(
  pg_temp.stat('rejected_7d') = 1 and pg_temp.stat('consecutive_api_errors') = 0,
  'a successful send still closes a run of API errors; the rejection window is unchanged'
);
insert into public.information_agent_autopilot_events (at, kind, details) values
  (now() - interval '9 days', 'skip', '{"code": "policy_rejected"}');
select ok(
  pg_temp.stat('rejected_7d') = 1,
  'a rejection older than 7 days still does not count'
);

-- Le chemin réel : la fonction de changement de mode, appelée par un administrateur.
insert into auth.users (id) values ('89400000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('89400000-0000-4000-8000-0000000000a1', 'rearm-admin@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;
select set_config('request.jwt.claims', '{"sub":"89400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

select throws_ok(
  $$select public.set_information_agent_autopilot_mode('off', 'Mode déjà éteint')$$,
  '22023', 'Le pilote est déjà dans ce mode.',
  'the mode function refuses to set the mode the autopilot is already in (off)'
);
do $$
begin
  perform public.set_information_agent_autopilot_mode('simulation', 'Début de la simulation');
end;
$$;
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('simulation', 'Relance de la simulation')$$,
  '22023', 'Le pilote est déjà dans ce mode.',
  'the mode function refuses to set the mode the autopilot is already in (simulation)'
);

-- Changements de mode sans arrêt automatique : les signaux restent comptés.
insert into public.information_agent_autopilot_events (at, kind, details) values
  (now() - interval '5 minutes', 'skip', '{"code": "policy_rejected"}'),
  (now() - interval '5 minutes', 'send_error', '{"status": 500}');
do $$
begin
  perform public.set_information_agent_autopilot_mode('off', 'Pause pour vérification');
  perform public.set_information_agent_autopilot_mode('simulation', 'Reprise sans arrêt automatique');
end;
$$;
select ok(
  pg_temp.stat('rejected_7d') = 2 and pg_temp.stat('consecutive_api_errors') = 1,
  'mode changes through the function without an automatic stop reset nothing'
);

-- Arrêt automatique réel, puis réactivation par la fonction : remise à zéro.
do $$
begin
  perform public.record_information_agent_autopilot_auto_stop('policy_rejections', '{}');
  perform public.set_information_agent_autopilot_mode('simulation', 'Reprise après arrêt automatique');
end;
$$;
select ok(
  pg_temp.stat('rejected_7d') = 0 and pg_temp.stat('consecutive_api_errors') = 0
  and exists (
    select 1 from public.information_agent_autopilot_events
    where kind = 'mode_changed' and after_values ->> 'mode' = 'simulation'
      and (before_values ->> 'auto_stopped')::boolean and at >= now()
  ),
  'the reactivation after a real automatic stop is journalled with auto_stopped and restarts the count'
);

select * from finish();
rollback;
