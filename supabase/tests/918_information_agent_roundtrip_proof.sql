-- 20261209100300 : preuve de l'aller-retour (attestation manuelle, trace durable, réponse réelle calculée à la volée).
-- Une réponse reçue par le webhook, pas automatique, expéditeur authentifié et identique au destinataire, rattachée à
-- un dossier envoyé, reçue après l'envoi, de moins de 30 jours, suffit au garde du mode réel. Chaque condition manquante
-- isolée, une réponse future ou de plus de 30 jours ne suffit pas. La trace durable survit à la purge du message.
begin;

select plan(26);

select ok(
  not has_function_privilege('anon', 'public.information_agent_roundtrip_proof(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.information_agent_roundtrip_proof(timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.information_agent_roundtrip_proof(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.information_agent_roundtrip_reply_proofs(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_information_agent_roundtrip_reply_proof(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.record_information_agent_roundtrip_reply_proof(uuid)', 'execute'),
  'the round trip proof functions are reachable by the server only'
);
select is(
  (select prosecdef from pg_catalog.pg_proc where oid = 'public.information_agent_roundtrip_proof(timestamptz)'::regprocedure),
  false,
  'the proof is computed with the caller''s rights (security invoker)'
);

-- Fixtures : un administrateur, une vente, un dossier envoyé il y a 40 jours et un dossier jamais envoyé.
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
  ('91800000-3000-4000-8000-0000000000c2', '91800000-1000-4000-8000-000000000001', '91800000-0000-4000-8000-0000000000a1', 'sent',
   'me.petit@cabinet-918.example', 'me.petit@cabinet-918.example', 'Demande de pièces', 'Demande de pièces de plus de vingt caractères.',
   array['documents'], array['documents'], now() - interval '1 hour'),
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
  '91800000-3000-4000-8000-0000000000d2', '91800000-0000-4000-8000-0000000000a1', '91800000-1000-4000-8000-000000000001',
  '91800000-3000-4000-8000-0000000000c2', 'sent', 'me.petit@cabinet-918.example', 'Demande de pièces',
  'Demande de pièces de plus de vingt caractères.', array['documents'], array['documents'], '918-pgtap'
), (
  '91800000-3000-4000-8000-0000000000d9', '91800000-0000-4000-8000-0000000000a1', '91800000-1000-4000-8000-000000000001',
  '91800000-3000-4000-8000-0000000000c9', 'draft', 'me.durand@cabinet-918.example', 'Demande de pièces',
  'Demande de pièces de plus de vingt caractères.', array['documents'], array['documents'], '918-pgtap'
);
update public.information_agent_operations
set inbound_roundtrip_verified_at = null, inbound_roundtrip_proved_at = null, inbound_roundtrip_proved_case_id = null
where singleton;

-- Métadonnées d'une réponse valide ; chaque cas ci-dessous n'en change qu'une chose.
create or replace function pg_temp.valid() returns jsonb language sql as $$
  select '{"imported_manually": false, "inbound_processing": {"status": "completed"}, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb
$$;
create or replace function pg_temp.reply(
  p_id text, p_case text, p_received interval, p_metadata jsonb
) returns void language sql as $$
  insert into public.information_agent_messages (
    id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text, received_at, provider_message_id, metadata
  ) values (
    p_id::uuid, (select mission.id from public.information_agent_missions mission where mission.case_id = p_case::uuid),
    p_case::uuid, '91800000-0000-4000-8000-0000000000a1', 'inbound', 'reply', 'received', 'Re: Demande de pièces',
    'Réponse de test.', now() - p_received, 'provider-918-' || p_id, p_metadata
  );
$$;
create or replace function pg_temp.proof() returns text language sql as $$
  select coalesce((select source || '/' || coalesce(case_id::text, '-')
                   from public.information_agent_roundtrip_proof(now())
                   where proven_at > now() - interval '30 days'), 'none')
$$;

-- Porte du mode réel : AIPD récente, 15 envois manuels réels, 7 jours de simulation (seul l'aller-retour manque).
select set_config('request.jwt.claims', '{"sub":"91800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
update public.information_agent_autopilot_settings set mode = 'simulation', simulation_started_at = now() - interval '8 days';
select public.attest_information_agent_aipd('AIPD-918', 'AIPD signée pour le test');
insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status)
select '918-manual-' || n, 'agent_request', 'agent', 'manual', 'avocat' || n || '@cabinet-918-manuel.example', 'delivered'
from generate_series(1, 15) as n;

select is(pg_temp.proof(), 'none', 'without attestation or reply there is no proof');
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel sans preuve')$$,
  '55000', 'Aller-retour de réception non prouvé depuis 30 jours (ni attestation, ni réponse réelle authentifiée rattachée à son dossier) : le mode réel est refusé.',
  'the real mode is refused without any round trip proof'
);

-- Réponses qui ne prouvent rien (une condition manquante à la fois).
select pg_temp.reply('91800000-4000-4000-8000-000000000001', '91800000-3000-4000-8000-0000000000c1', interval '1 day',
  pg_temp.valid() || '{"sender_authentication": {"status": "unverified"}}');
select is(pg_temp.proof(), 'none', 'an unauthenticated sender proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000002', '91800000-3000-4000-8000-0000000000c1', interval '1 day',
  pg_temp.valid() || '{"sender_matches_recipient": false}');
select is(pg_temp.proof(), 'none', 'a sender other than the case recipient proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000003', '91800000-3000-4000-8000-0000000000c1', interval '1 day',
  pg_temp.valid() || '{"imported_manually": true}');
select is(pg_temp.proof(), 'none', 'a reply recorded by hand proves nothing, everything else being valid');
select pg_temp.reply('91800000-4000-4000-8000-000000000004', '91800000-3000-4000-8000-0000000000c9', interval '1 day',
  pg_temp.valid());
select is(pg_temp.proof(), 'none', 'a reply on a case that was never sent proves nothing');
-- Dossier envoyé il y a une heure, réponse datée d'il y a deux heures : seule l'antériorité manque.
select pg_temp.reply('91800000-4000-4000-8000-000000000005', '91800000-3000-4000-8000-0000000000c2', interval '2 hours',
  pg_temp.valid());
select is(pg_temp.proof(), 'none', 'a reply received before the case was sent proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000006', '91800000-3000-4000-8000-0000000000c1', interval '1 day',
  pg_temp.valid() || '{"inbound_processing": {"status": "ignored", "reason": "auto_reply"}}');
select is(pg_temp.proof(), 'none', 'an automatic reply (out of office) proves nothing');
select pg_temp.reply('91800000-4000-4000-8000-000000000007', '91800000-3000-4000-8000-0000000000c1', interval '-1 day',
  pg_temp.valid());
select is(pg_temp.proof(), 'none', 'a reply dated in the future proves nothing');
select is(
  public.record_information_agent_roundtrip_reply_proof('91800000-4000-4000-8000-000000000001'),
  null,
  'the durable trace refuses a message that does not qualify'
);
select is(
  (select inbound_roundtrip_proved_at from public.information_agent_operations where singleton),
  null,
  'and writes nothing'
);

select pg_temp.reply('91800000-4000-4000-8000-000000000008', '91800000-3000-4000-8000-0000000000c1', interval '31 days',
  pg_temp.valid());
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

-- Réponse réelle valide : elle suffit.
select pg_temp.reply('91800000-4000-4000-8000-000000000009', '91800000-3000-4000-8000-0000000000c1', interval '2 days',
  pg_temp.valid());
select is(
  pg_temp.proof(),
  'reply/91800000-3000-4000-8000-0000000000c1',
  'an authenticated reply from the case recipient, routed to a sent case, is a proof'
);

-- La preuve la plus récente l'emporte : une attestation plus récente que la réponse, puis plus ancienne.
update public.information_agent_operations set inbound_roundtrip_verified_at = now() - interval '1 day' where singleton;
select is(pg_temp.proof(), 'attestation/-', 'a more recent manual attestation is the proof retained');
update public.information_agent_operations set inbound_roundtrip_verified_at = now() - interval '3 days' where singleton;
select is(
  pg_temp.proof(),
  'reply/91800000-3000-4000-8000-0000000000c1',
  'an older attestation gives way to the more recent reply'
);
update public.information_agent_operations set inbound_roundtrip_verified_at = null where singleton;

-- Trace durable : écrite pour une réponse qui remplit les conditions, jamais reculée, survit à la purge du message.
select isnt(
  public.record_information_agent_roundtrip_reply_proof('91800000-4000-4000-8000-000000000009'),
  null,
  'the durable trace accepts a qualifying reply'
);
select ok(
  (select inbound_roundtrip_proved_case_id = '91800000-3000-4000-8000-0000000000c1'
          and inbound_roundtrip_proved_at > now() - interval '3 days'
   from public.information_agent_operations where singleton),
  'the trace keeps the date and the case, no address'
);
select public.record_information_agent_roundtrip_reply_proof('91800000-4000-4000-8000-000000000008');
select ok(
  (select inbound_roundtrip_proved_at > now() - interval '3 days' from public.information_agent_operations where singleton),
  'an older qualifying reply never moves the trace back'
);
delete from public.information_agent_messages where case_id = '91800000-3000-4000-8000-0000000000c1';
select is(
  pg_temp.proof(),
  'reply/91800000-3000-4000-8000-0000000000c1',
  'once the messages are purged, the durable trace still proves the round trip'
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
  'no manual attestation is ever written by the proof'
);

select * from finish();
rollback;
