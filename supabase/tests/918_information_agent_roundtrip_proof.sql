-- 20261209100300 : preuve de l'aller-retour calculée à la volée (attestation manuelle OU réponse réelle).
-- Une réponse reçue par le webhook, expéditeur authentifié et identique au destinataire, rattachée à un dossier envoyé,
-- de moins de 30 jours, suffit au garde du mode réel. Une réponse non authentifiée, d'un autre expéditeur, consignée à
-- la main, rattachée à un dossier jamais envoyé ou de plus de 30 jours ne suffit pas. Rien n'est écrit.
begin;

select plan(14);

select ok(
  not has_function_privilege('anon', 'public.information_agent_roundtrip_proof(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.information_agent_roundtrip_proof(timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.information_agent_roundtrip_proof(timestamptz)', 'execute'),
  'the round trip proof is readable by the server only'
);

-- Fixtures : un administrateur, une vente, un dossier envoyé et un dossier jamais envoyé, aucune attestation.
insert into auth.users (id) values ('91800000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('91800000-0000-4000-8000-0000000000a1', 'autopilot-proof-918@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;
insert into public.tribunals (code, canonical_name, department, city)
values ('T918', 'Tribunal de test 918', '33', 'Bordeaux');
insert into public.auction_sales (id, source_name, source_url, status, tribunal_code)
values ('91800000-1000-4000-8000-000000000001', 'autopilot-pgtap', 'https://example.test/918', 'upcoming', 'T918');
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text, question_keys, missing_information, sent_at
) values
  ('91800000-3000-4000-8000-0000000000c1', '91800000-1000-4000-8000-000000000001', '91800000-0000-4000-8000-0000000000a1', 'sent',
   'me.martin@cabinet-918.example', 'me.martin@cabinet-918.example', 'Demande de pièces', 'Demande de pièces de plus de vingt caractères.',
   array['documents'], array['documents'], now() - interval '40 days'),
  ('91800000-3000-4000-8000-0000000000c9', '91800000-1000-4000-8000-000000000001', '91800000-0000-4000-8000-0000000000a1', 'sending',
   'me.durand@cabinet-918.example', 'me.durand@cabinet-918.example', 'Demande de pièces', 'Demande de pièces de plus de vingt caractères.',
   array['documents'], array['documents'], null);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys, missing_information, privacy_version
) values (
  '91800000-3000-4000-8000-0000000000d1', '91800000-0000-4000-8000-0000000000a1', '91800000-1000-4000-8000-000000000001',
  '91800000-3000-4000-8000-0000000000c1', 'sent', 'me.martin@cabinet-918.example', 'Demande de pièces',
  'Demande de pièces de plus de vingt caractères.', array['documents'], array['documents'], '918-pgtap'
), (
  '91800000-3000-4000-8000-0000000000d9', '91800000-0000-4000-8000-0000000000a1', '91800000-1000-4000-8000-000000000001',
  '91800000-3000-4000-8000-0000000000c9', 'draft', 'me.durand@cabinet-918.example', 'Demande de pièces',
  'Demande de pièces de plus de vingt caractères.', array['documents'], array['documents'], '918-pgtap'
);
update public.information_agent_operations set inbound_roundtrip_verified_at = null where singleton;

create or replace function pg_temp.reply(
  p_id text, p_case text, p_received interval, p_metadata jsonb, p_provider text default 'provider-918'
) returns void language sql as $$
  insert into public.information_agent_messages (
    id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text, received_at, provider_message_id, metadata
  ) values (
    p_id::uuid, (select mission.id from public.information_agent_missions mission where mission.case_id = p_case::uuid),
    p_case::uuid, '91800000-0000-4000-8000-0000000000a1', 'inbound', 'reply', 'received', 'Re: Demande de pièces',
    'Réponse de test.', now() - p_received, p_provider || '-' || p_id, p_metadata
  );
$$;
create or replace function pg_temp.proof() returns text language sql as $$
  select coalesce((select source || '/' || coalesce(case_id::text, '-')
                   from public.information_agent_roundtrip_proof(now())
                   where proven_at > now() - interval '30 days'), 'none')
$$;

select set_config('request.jwt.claims', '{"sub":"91800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
update public.information_agent_autopilot_settings set mode = 'simulation', simulation_started_at = now();
select public.attest_information_agent_aipd('AIPD-918', 'AIPD signée pour le test');

select is(pg_temp.proof(), 'none', 'without attestation or reply there is no proof');
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel sans preuve')$$,
  '55000', 'Aller-retour de réception non prouvé depuis 30 jours (ni attestation, ni réponse réelle authentifiée rattachée à son dossier) : le mode réel est refusé.',
  'the real mode is refused without any round trip proof'
);

-- Réponses qui ne prouvent rien.
select pg_temp.reply('91800000-4000-4000-8000-000000000001', '91800000-3000-4000-8000-0000000000c1', interval '1 day',
  '{"imported_manually": false, "inbound_processing": {"status": "completed"}, "sender_authentication": {"status": "unverified"}, "sender_matches_recipient": true}');
select is(pg_temp.proof(), 'none', 'an unauthenticated sender proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000002', '91800000-3000-4000-8000-0000000000c1', interval '1 day',
  '{"imported_manually": false, "inbound_processing": {"status": "completed"}, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": false}');
select is(pg_temp.proof(), 'none', 'a sender other than the case recipient proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000003', '91800000-3000-4000-8000-0000000000c1', interval '1 day',
  '{"imported_manually": true, "channel": "admin_manual_reply", "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}');
select is(pg_temp.proof(), 'none', 'a reply recorded by hand (not routed by the webhook) proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000004', '91800000-3000-4000-8000-0000000000c9', interval '1 day',
  '{"imported_manually": false, "inbound_processing": {"status": "completed"}, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}');
select is(pg_temp.proof(), 'none', 'a reply on a case that was never sent proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000005', '91800000-3000-4000-8000-0000000000c1', interval '31 days',
  '{"imported_manually": false, "inbound_processing": {"status": "completed"}, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}');
select is(pg_temp.proof(), 'none', 'a valid reply older than 30 days is not enough');
select is(
  (select source from public.information_agent_roundtrip_proof(now())),
  'reply',
  'the old reply is still reported as the latest proof (for the expiry warning)'
);
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel, preuve trop ancienne')$$,
  '55000', null, 'the real mode is refused with a proof older than 30 days'
);

-- Réponse réelle, authentifiée, du destinataire, rattachée à un dossier envoyé : elle suffit.
select pg_temp.reply('91800000-4000-4000-8000-000000000006', '91800000-3000-4000-8000-0000000000c1', interval '2 days',
  '{"imported_manually": false, "inbound_processing": {"status": "completed"}, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}');
select is(
  pg_temp.proof(),
  'reply/91800000-3000-4000-8000-0000000000c1',
  'an authenticated reply from the case recipient, routed to a sent case, is a proof'
);
select is(
  (select mode from public.set_information_agent_autopilot_mode('live', 'Passage en réel, réponse réelle')),
  'live',
  'the real mode is accepted on that proof'
);
select ok(
  exists (
    select 1 from public.information_agent_autopilot_events
    where kind = 'mode_changed' and after_values ->> 'mode' = 'live'
      and after_values -> 'roundtrip_proof' ->> 'source' = 'reply'
      and after_values -> 'roundtrip_proof' ->> 'case_id' = '91800000-3000-4000-8000-0000000000c1'
      and after_values -> 'roundtrip_proof' ->> 'proven_at' is not null
  ),
  'the journal records which proof was used: nature, date and case, no address'
);
select is(
  (select inbound_roundtrip_verified_at from public.information_agent_operations where singleton),
  null,
  'nothing is written: no system attestation'
);

select * from finish();
rollback;
