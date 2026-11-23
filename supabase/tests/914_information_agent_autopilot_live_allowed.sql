-- 20261209100900 : verrou du mode réel du pilote levé par migration (décision du propriétaire du 23/11/2026).
-- live_allowed vaut vrai, le mode n'a pas changé (le passage en « Réel » reste un geste du propriétaire), la levée est
-- journalisée par le système, et la RPC garde ses autres conditions (AIPD, aller-retour).
begin;

select plan(4);

select ok(
  (select live_allowed from public.information_agent_autopilot_settings where singleton),
  'the migration lifts the live_allowed lock'
);

-- Base de test : la ligne n'a été touchée que par les migrations ; le mode est resté sa valeur par défaut.
select ok(
  (select mode = 'off' and simulation_started_at is null and auto_stopped_at is null
   from public.information_agent_autopilot_settings where singleton),
  'the mode is unchanged: still the default off, no simulation clock started'
);

select ok(
  exists (
    select 1 from public.information_agent_autopilot_events
    where kind = 'settings_changed' and action = 'live_allowed' and actor is null
      and before_values ->> 'live_allowed' = 'false' and after_values ->> 'live_allowed' = 'true'
      and before_values ->> 'mode' = after_values ->> 'mode'
  ),
  'the lift is journalled by the system, with the mode identical before and after'
);

-- Les autres conditions de la RPC restent : sans AIPD, le mode réel est refusé.
insert into auth.users (id) values ('91400000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role)
values ('91400000-0000-4000-8000-0000000000a1', 'autopilot-admin-914@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;
select set_config('request.jwt.claims', '{"sub":"91400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel sans AIPD')$$,
  '55000', 'Attestation d''AIPD manquante : le mode réel est refusé.',
  'with the lock lifted, the real mode is still refused without an AIPD attestation'
);

select * from finish();

rollback;
