-- 20261209100300 : porte SQL du mode réel (défense en profondeur, relectures sécurité et Postgres de la PR #553).
-- Le passage en « live » exige une session en double authentification (aal2), une AIPD attestée le 23/11/2026 ou
-- après, une preuve d'aller-retour récente, 15 envois manuels réels (destinataires distincts) sans plainte et avec
-- moins de 3 % de rebonds définitifs, et 7 jours de simulation. Chaque condition manquante donne le refus 55000.
begin;

select plan(9);

insert into auth.users (id) values ('91900000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('91900000-0000-4000-8000-0000000000a1', 'autopilot-gate-919@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

create or replace function pg_temp.as_admin(p_aal text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', '91900000-0000-4000-8000-0000000000a1', 'role', 'authenticated', 'aal', p_aal)::text,
    true
  );
$$;

-- Interrupteur admin_mfa_required coupé : l'exigence aal2 du mode réel ne dépend pas de lui.
update app_private.security_switches set enabled = false where switch_name = 'admin_mfa_required';

-- Tout est prêt : simulation de 8 jours, AIPD du jour, aller-retour attesté hier, 15 envois manuels propres.
select pg_temp.as_admin('aal2');
update public.information_agent_autopilot_settings set mode = 'simulation', simulation_started_at = now() - interval '8 days';
select public.attest_information_agent_aipd('AIPD-919', 'AIPD signée pour le test');
update public.information_agent_operations set inbound_roundtrip_verified_at = now() - interval '1 day' where singleton;
delete from public.email_send_log where category = 'agent' and mode = 'manual';
insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status)
select '919-manual-' || n, 'agent_request', 'agent', 'manual', 'avocat' || n || '@cabinet-919.example', 'delivered'
from generate_series(1, 15) as n;

-- 5. Double authentification.
select pg_temp.as_admin('aal1');
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel sans second facteur')$$,
  '55000',
  'Double authentification requise pour passer en mode réel : reconnectez-vous avec votre second facteur, puis recommencez.',
  'the real mode requires an aal2 session, whatever the MFA switch'
);
select pg_temp.as_admin('aal2');

-- 4. AIPD antérieure au 23/11/2026 (heure de Paris).
update public.information_agent_autopilot_settings
set aipd_attested_at = '2026-11-22 23:59:00 Europe/Paris'::timestamptz;
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel, AIPD ancienne')$$,
  '55000',
  'Attestation d''AIPD antérieure au 23/11/2026 : attestez la version qui couvre l''envoi automatique, puis recommencez.',
  'an AIPD attested before 23/11/2026 is refused'
);
update public.information_agent_autopilot_settings
set aipd_attested_at = '2026-11-23 00:00:00 Europe/Paris'::timestamptz;

-- 6. Envois manuels réels : 14 destinataires distincts ne suffisent pas (le 15e envoi va au même destinataire).
update public.email_send_log set to_address = 'avocat1@cabinet-919.example' where resend_email_id = '919-manual-15';
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel, 14 destinataires')$$,
  '55000', null,
  'fewer than 15 distinct manual recipients are refused'
);
update public.email_send_log set to_address = 'avocat15@cabinet-919.example' where resend_email_id = '919-manual-15';

update public.email_send_log set status = 'complained' where resend_email_id = '919-manual-3';
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel, une plainte')$$,
  '55000', null,
  'a single complaint on a manual send is refused'
);
update public.email_send_log set status = 'delivered' where resend_email_id = '919-manual-3';

-- Un rebond définitif sur 15 destinataires : 6,7 %, au-delà de 3 %.
update public.email_send_log set status = 'bounced', bounce_type = 'permanent' where resend_email_id = '919-manual-4';
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel, rebonds')$$,
  '55000', null,
  'a permanent bounce rate of 3 % or more on manual sends is refused'
);
update public.email_send_log set status = 'delivered', bounce_type = null where resend_email_id = '919-manual-4';

-- 7 jours de simulation.
update public.information_agent_autopilot_settings set simulation_started_at = now() - interval '6 days';
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel, simulation courte')$$,
  '55000', 'Moins de 7 jours de simulation : le mode réel est refusé.',
  'fewer than 7 days of simulation are refused'
);
select is(
  (select mode from public.information_agent_autopilot_settings),
  'simulation',
  'every refusal leaves the mode unchanged'
);
update public.information_agent_autopilot_settings set simulation_started_at = now() - interval '8 days';

-- Tout est réuni : accepté, et la simulation n'est pas exigée pour revenir en arrière.
select is(
  (select mode from public.set_information_agent_autopilot_mode('live', 'Passage en réel, porte franchie')),
  'live',
  'with every condition met, the real mode is accepted'
);
select pg_temp.as_admin('aal1');
select is(
  (select mode from public.set_information_agent_autopilot_mode('simulation', 'Retour en simulation')),
  'simulation',
  'leaving the real mode needs neither aal2 nor the other conditions'
);

select * from finish();
rollback;
