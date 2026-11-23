-- 20261209100200 : en mode réel, le délai de l'article 14 du pilote est de 30 jours au plus (relecture juridique du
-- 23/11/2026). En simulation, 1 à 90 jours restent permis (décision du 14/11/2026). La règle reste toujours active
-- (20261119100810). La contrainte vaut pour la RPC de réglage, pour le passage en mode réel et pour une écriture
-- directe ; l'arrêt d'urgence passe toujours.
begin;

select plan(9);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.information_agent_autopilot_settings'::regclass
      and conname = 'information_agent_autopilot_settings_art14_live_max_days'
      and contype = 'c' and convalidated
  ),
  'the live article 14 constraint exists under its name and is validated'
);

insert into auth.users (id) values ('91700000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('91700000-0000-4000-8000-0000000000a1', 'autopilot-art14-917@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;
select set_config('request.jwt.claims', '{"sub":"91700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

-- Conditions du mode réel remplies (verrou levé, AIPD, aller-retour récent, 15 envois manuels réels, 7 jours de
-- simulation), pour n'isoler que l'article 14.
update public.information_agent_autopilot_settings
set mode = 'simulation', simulation_started_at = now() - interval '8 days';
insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status)
select '917-manual-' || n, 'agent_request', 'agent', 'manual', 'avocat' || n || '@cabinet-917.example', 'delivered'
from generate_series(1, 15) as n;
select public.attest_information_agent_aipd('AIPD-917', 'AIPD signée pour le test');
insert into public.information_agent_operations as ops (singleton, inbound_roundtrip_verified_at, updated_at)
values (true, now() - interval '1 day', now())
on conflict (singleton) do update set inbound_roundtrip_verified_at = excluded.inbound_roundtrip_verified_at;

select ok(
  (select art14_max_age_days = 90
   from public.update_information_agent_autopilot_settings('{"art14_max_age_days": 90}', 'Délai de 90 jours en simulation')),
  'in simulation the delay can still be set up to 90 days'
);
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel à 90 jours')$$,
  '23514', null,
  'the real mode is refused while the article 14 delay exceeds 30 days'
);
select is(
  (select mode from public.information_agent_autopilot_settings),
  'simulation',
  'the refused switch leaves the mode unchanged'
);

select public.update_information_agent_autopilot_settings('{"art14_max_age_days": 30}', 'Délai ramené à 30 jours');
select is(
  (select mode from public.set_information_agent_autopilot_mode('live', 'Passage en réel à 30 jours')),
  'live',
  'with 30 days the real mode is accepted'
);
select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"art14_max_age_days": 31}', 'Délai allongé en réel')$$,
  '23514', null,
  'in the real mode the settings function refuses a delay above 30 days'
);
select throws_ok(
  $$update public.information_agent_autopilot_settings set art14_max_age_days = 45$$,
  '23514', null,
  'the constraint also refuses a direct write in the real mode'
);
select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"art14_rule_enabled": false}', 'Règle coupée en réel')$$,
  '23514', null,
  'the article 14 rule still cannot be switched off'
);
select is(
  (select mode from public.stop_information_agent_autopilot('Arrêt du test')),
  'off',
  'the emergency stop still works'
);

select * from finish();
rollback;
