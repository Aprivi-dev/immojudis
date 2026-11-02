-- 20261110220000 : file de travail de l'agent d'information, attestation de l'aller-retour, indicateurs et alertes.
--   * la file est filtrée AVANT la pagination et répartie en classes A (avocat), B (texte libre), C (greffe) et D ;
--   * une vente déjà sollicitée, ou dont la date est passée, n'y figure pas ; un dossier rebondi la rend éligible ;
--   * l'attestation exige un administrateur ; les trois fonctions sont réservées à service_role ;
--   * les indicateurs comptent les envois de la catégorie « agent » ; trois alertes de santé s'ajoutent.
begin;

select plan(30);

select has_function('public', 'admin_information_agent_queue', array['integer', 'integer', 'text'], 'the queue function exists');
select has_function('public', 'attest_information_agent_roundtrip', array['uuid'], 'the attestation function exists');
select has_function('public', 'information_agent_indicators', array['timestamp with time zone', 'timestamp with time zone'], 'the indicators function exists');

select ok(
  not has_function_privilege('anon', 'public.admin_information_agent_queue(integer, integer, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.admin_information_agent_queue(integer, integer, text)', 'execute')
  and has_function_privilege('service_role', 'public.admin_information_agent_queue(integer, integer, text)', 'execute')
  and not has_function_privilege('anon', 'public.attest_information_agent_roundtrip(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.attest_information_agent_roundtrip(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.information_agent_indicators(timestamptz, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.information_agent_indicators(timestamptz, timestamptz)', 'execute'),
  'the functions are closed to the browser roles and open to the server'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.information_agent_operations'::regclass)
  and not has_table_privilege('anon', 'public.information_agent_operations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_operations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_operations', 'UPDATE')
  and has_table_privilege('service_role', 'public.information_agent_operations', 'UPDATE'),
  'the operations row has RLS and is reserved to the server'
);

select throws_ok(
  $$insert into public.information_agent_operations (singleton) values (false)$$,
  '23514', null, 'the operations table keeps a single row'
);

delete from public.operational_alerts where alert_key like 'information_agent.%';

-- Fixtures ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('86700000-0000-4000-8000-0000000000a1'), ('86700000-0000-4000-8000-0000000000a2');
insert into public.user_profiles (user_id, email, user_role) values
  ('86700000-0000-4000-8000-0000000000a1', 'queue-admin@example.test', 'admin'),
  ('86700000-0000-4000-8000-0000000000a2', 'queue-user@example.test', 'user')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (id, source_name, source_url, status, premium_readiness_status, lawyer_contact, sale_date)
values
  ('86700000-1000-4000-8000-00000000000a', 'queue-pgtap', 'https://example.test/867-a', 'upcoming', 'needs_enrichment', 'Me Dupont dupont@cabinet-dupont.example', now() + interval '20 days'),
  ('86700000-1000-4000-8000-00000000000d', 'queue-pgtap', 'https://example.test/867-d', 'upcoming', 'needs_enrichment', '04 00 00 00 00', now() + interval '20 days'),
  ('86700000-1000-4000-8000-00000000000e', 'queue-pgtap', 'https://example.test/867-e', 'upcoming', 'needs_enrichment', 'old@cabinet-dupont.example', now() - interval '5 days'),
  ('86700000-1000-4000-8000-000000000010', 'queue-pgtap', 'https://example.test/867-10', 'upcoming', 'needs_enrichment', 'sent@cabinet-dupont.example', now() + interval '5 days'),
  ('86700000-1000-4000-8000-000000000011', 'queue-pgtap', 'https://example.test/867-11', 'upcoming', 'premium_ready', 'ready@cabinet-dupont.example', now() + interval '5 days');

insert into public.information_agent_cases (id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text, question_keys, sent_at)
values (
  '86700000-2000-4000-8000-000000000010', '86700000-1000-4000-8000-000000000010',
  '86700000-0000-4000-8000-0000000000a1', 'sent', 'sent@cabinet-dupont.example', 'sent@cabinet-dupont.example',
  'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'], now() - interval '3 days'
);

-- File -------------------------------------------------------------------------------------------------------
select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000a", "class": "A"}]'::jsonb,
  true,
  'a sale with a lawyer address is in class A'
);

select is(
  (public.admin_information_agent_queue(500, 0, null) -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000d"}]'::jsonb,
  false,
  'a sale with a phone number only (class D) is not in the working list'
);

select is(
  (public.admin_information_agent_queue(500, 0, 'D') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000d", "class": "D"}]'::jsonb,
  true,
  'a sale with a phone number only is listed under « contact impossible »'
);

select is(
  ((public.admin_information_agent_queue(500, 0, null) -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000e"}]'::jsonb)
  or ((public.admin_information_agent_queue(500, 0, 'D') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000e"}]'::jsonb)
  or ((public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-00000000000e"}]'::jsonb),
  false,
  'a sale whose date has passed is in no class'
);

select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-000000000010"}]'::jsonb,
  false,
  'a sale already contacted is not in the queue'
);

select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-000000000011"}]'::jsonb,
  false,
  'a sale already ready for the Analyse offer is not in the queue'
);

update public.information_agent_cases
set metadata = '{"delivery": {"status": "bounced"}}'::jsonb
where id = '86700000-2000-4000-8000-000000000010';

select is(
  (public.admin_information_agent_queue(500, 0, 'A') -> 'items') @> '[{"id": "86700000-1000-4000-8000-000000000010", "class": "A"}]'::jsonb,
  true,
  'a bounced case makes the sale eligible again'
);

select is(
  jsonb_array_length(public.admin_information_agent_queue(1, 0, 'A') -> 'items'),
  1,
  'the page size is applied after the filter'
);

select throws_ok(
  $$select public.admin_information_agent_queue(10, 0, 'Z')$$,
  '22023', null, 'an unknown class is refused'
);

-- Attestation ----------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a2')$$,
  '42501', null, 'a non-admin account cannot attest the round trip'
);

-- Sans réponse de test reçue et routée dans les 24 dernières heures, l'attestation est refusée (ce n'est plus un clic).
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1')$$,
  '55000', null, 'the round trip cannot be attested without a received and routed test reply'
);

-- Réponse de test : dossier de l'administrateur vers une adresse de son propre domaine, réponse reçue il y a une heure.
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text, question_keys, missing_information, sent_at
) values (
  '86700000-2000-4000-8000-0000000000c1', '86700000-1000-4000-8000-00000000000a', '86700000-0000-4000-8000-0000000000a1', 'sent', 'roundtrip-test@immojudis.com', 'roundtrip-test@immojudis.com', 'Message de test', 'Message de test de plus de vingt caractères.',
  array['documents'], array['documents'], now() - interval '2 hours'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys, missing_information, privacy_version
) values (
  '86700000-2000-4000-8000-0000000000c2', '86700000-0000-4000-8000-0000000000a1', '86700000-1000-4000-8000-00000000000a', '86700000-2000-4000-8000-0000000000c1', 'sent', 'roundtrip-test@immojudis.com', 'Message de test', 'Message de test de plus de vingt caractères.',
  array['documents'], array['documents'], 'roundtrip-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text, received_at, provider_message_id, metadata
) values (
  '86700000-2000-4000-8000-0000000000c3', '86700000-2000-4000-8000-0000000000c2', '86700000-2000-4000-8000-0000000000c1', '86700000-0000-4000-8000-0000000000a1', 'inbound', 'reply', 'received', 'Re: Message de test', 'Réponse de test.', now() - interval '1 hour',
  'roundtrip-provider-867', '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb
);

-- Les preuves falsifiables sont refusées : une seule condition défaillante suffit.
update public.information_agent_messages set metadata = metadata || '{"imported_manually": true}' where id = '86700000-2000-4000-8000-0000000000c3';
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1')$$,
  '55000', null, 'a reply imported by hand is not a proof'
);
update public.information_agent_messages set metadata = '{"imported_manually": false, "sender_authentication": {"status": "fail"}, "sender_matches_recipient": true}' where id = '86700000-2000-4000-8000-0000000000c3';
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1')$$,
  '55000', null, 'a reply whose sender authentication did not pass is not a proof'
);
update public.information_agent_messages set metadata = '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": false}' where id = '86700000-2000-4000-8000-0000000000c3';
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1')$$,
  '55000', null, 'a reply whose sender differs from the recipient is not a proof'
);
update public.information_agent_messages set metadata = '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}', provider_message_id = null where id = '86700000-2000-4000-8000-0000000000c3';
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1')$$,
  '55000', null, 'a reply without a provider message id is not a proof'
);
update public.information_agent_messages set provider_message_id = 'roundtrip-provider-867' where id = '86700000-2000-4000-8000-0000000000c3';
update public.information_agent_cases set sent_at = null where id = '86700000-2000-4000-8000-0000000000c1';
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1')$$,
  '55000', null, 'a test case that was never sent is not a proof'
);
update public.information_agent_cases set sent_at = now() - interval '2 hours', normalized_recipient_email = 'roundtrip-test@gmail.com' where id = '86700000-2000-4000-8000-0000000000c1';
select throws_ok(
  $$select public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1')$$,
  '55000', null, 'a consumer mail domain is not an internal domain'
);
update public.information_agent_cases set normalized_recipient_email = 'roundtrip-test@immojudis.com' where id = '86700000-2000-4000-8000-0000000000c1';

-- La date et l'auteur sont lus dans une instruction distincte : une sous-requête de la même instruction ne voit pas
-- l'écriture de la fonction (instantané de l'instruction).
do $$
begin
  perform public.attest_information_agent_roundtrip('86700000-0000-4000-8000-0000000000a1');
end;
$$;

select ok(
  (select inbound_roundtrip_verified_by = '86700000-0000-4000-8000-0000000000a1'
     and inbound_roundtrip_verified_at is not null
   from public.information_agent_operations where singleton),
  'an administrator attests the round trip: the date and the author are stored'
);

select ok(
  (select count(*) = 1 and bool_and(admin_id = '86700000-0000-4000-8000-0000000000a1' and message_id is not null)
   from public.information_agent_roundtrip_attestations),
  'the attestation is added to the append-only history (who, when, which test reply)'
);

select throws_ok(
  $$delete from public.information_agent_roundtrip_attestations$$,
  '55000', null, 'the attestation history cannot be deleted from'
);

-- Indicateurs et santé ---------------------------------------------------------------------------------------------
insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status, bounce_type)
select '867-sent-' || n, 'agent_request', 'agent', 'manual', 'dest' || n || '@example.test',
  case when n <= 8 then 'delivered' when n = 9 then 'bounced' else 'complained' end,
  case when n = 9 then 'permanent' else null end
from generate_series(1, 10) as n;

select is(
  (public.information_agent_indicators() ->> 'sent')::integer,
  10,
  'the indicators count the sent messages of the agent'
);

select is(
  (public.information_agent_indicators() ->> 'bounced_permanent')::integer,
  1,
  'the indicators count the permanent bounces'
);

select ok(public.evaluate_information_agent_health() is not null, 'the health check runs');

select ok(
  (select count(*) from public.operational_alerts
    where alert_key in ('information_agent.delivery.bounce_rate', 'information_agent.delivery.complaint')
      and status = 'open') = 2,
  'a bounce rate of 10 % and a complaint open their alerts'
);

select * from finish();
rollback;
