-- Réarmement de l'arrêt automatique du pilote (défaut I1 de la relecture du 14/11/2026) : les rejets de politique
-- (`rejected_7d`) et les erreurs d'API consécutives (`consecutive_api_errors`) se comptent depuis la dernière
-- réactivation journalisée (changement de mode vers « simulation » ou « live »). Avant, une simulation relancée après
-- un arrêt automatique s'arrêtait aussitôt de nouveau : pendant 7 jours pour les rejets, indéfiniment pour les
-- erreurs d'API (en simulation, aucun envoi réussi ne remet le compteur à zéro). Les seuils ne changent pas.
begin;

select plan(8);

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
  'after a journalled reactivation to simulation, rejections and API errors count from zero again'
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
  (now() - interval '40 minutes', 'mode_changed', 'set_mode', '{"mode": "simulation", "auto_stopped": false}',
   '{"mode": "off"}', 'Pause pour vérification');
select ok(
  pg_temp.stat('rejected_7d') = 1 and pg_temp.stat('consecutive_api_errors') = 1,
  'a change to off is not a reactivation and resets nothing'
);

-- Un passage en réel est aussi une réactivation journalisée.
insert into public.information_agent_autopilot_events (at, kind, action, before_values, after_values, reason) values
  (now() - interval '30 minutes', 'mode_changed', 'set_mode', '{"mode": "off", "auto_stopped": false}',
   '{"mode": "live"}', 'Passage en réel autorisé');
select ok(
  pg_temp.stat('rejected_7d') = 0 and pg_temp.stat('consecutive_api_errors') = 0,
  'a journalled change to live restarts the count as well'
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

-- Le chemin réel : la RPC de changement de mode journalise la réactivation qui réarme les compteurs.
insert into auth.users (id) values ('89400000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('89400000-0000-4000-8000-0000000000a1', 'rearm-admin@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;
select set_config('request.jwt.claims', '{"sub":"89400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
insert into public.information_agent_autopilot_events (at, kind, details) values
  (now() - interval '5 minutes', 'skip', '{"code": "policy_rejected"}'),
  (now() - interval '5 minutes', 'send_error', '{"status": 500}');
do $$
begin
  perform public.set_information_agent_autopilot_mode('simulation', 'Reprise de la simulation après arrêt');
end;
$$;
select ok(
  pg_temp.stat('rejected_7d') = 0 and pg_temp.stat('consecutive_api_errors') = 0
  and exists (
    select 1 from public.information_agent_autopilot_events
    where kind = 'mode_changed' and after_values ->> 'mode' = 'simulation' and at >= now()
  ),
  'set_information_agent_autopilot_mode journals the reactivation that the counters read'
);

select * from finish();
rollback;
