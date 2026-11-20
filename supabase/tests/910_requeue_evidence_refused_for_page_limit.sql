-- 20261206100000 (20/11/2026) : les pièces de l'agent d'information refusées pour leur nombre de pages
-- (PAGE_LIMIT_EXCEEDED, au-delà de 100 pages) repartent en file pour être lues ; les autres refus et les lectures
-- terminées ne bougent pas ; un second passage ne remet plus rien en file.
begin;

select plan(7);

insert into auth.users (id) values ('91000000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('91000000-0000-4000-8000-0000000000a1', 'requeue-admin-910@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (id, source_name, source_url, status, sale_date, raw_payload)
values (
  '91000000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/910/sale', 'upcoming',
  current_timestamp + interval '20 days', '{}'::jsonb
);
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_kind, recipient_email, normalized_recipient_email, subject,
  body_text, question_keys, missing_information, sent_at, replied_at
) values (
  '91000000-3000-4000-8000-000000000001', '91000000-1000-4000-8000-000000000001',
  '91000000-0000-4000-8000-0000000000a1', 'review', 'source_lawyer', 'avocat-910@example.test',
  'avocat-910@example.test', 'Demande d''informations', 'Merci de nous transmettre les informations manquantes.',
  array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
) values (
  '91000000-2000-4000-8000-000000000001', '91000000-0000-4000-8000-0000000000a1',
  '91000000-1000-4000-8000-000000000001', '91000000-3000-4000-8000-000000000001', 'sent',
  'avocat-910@example.test', 'Demande d''informations',
  'Merci de nous transmettre les informations manquantes.', array['surface'], array['surface'], '910-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at, provider_message_id, metadata
) values (
  '91000000-4000-4000-8000-000000000001', '91000000-2000-4000-8000-000000000001',
  '91000000-3000-4000-8000-000000000001', '91000000-0000-4000-8000-0000000000a1',
  'inbound', 'reply', 'received', 'Re: Demande d''informations', 'Voici le cahier des conditions de vente.',
  now() - interval '2 days', 'requeue-provider-910',
  '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb
);

-- Une pièce par cas ; le déclencheur de réception crée sa ligne d'extraction en file.
insert into public.information_agent_evidence_assets (
  id, case_id, message_id, sale_id, storage_path, original_filename, mime_type, size_bytes, sha256
)
select
  fixture.asset_id::uuid, '91000000-3000-4000-8000-000000000001', '91000000-4000-4000-8000-000000000001',
  '91000000-1000-4000-8000-000000000001',
  '91000000-3000-4000-8000-000000000001/91000000-4000-4000-8000-000000000001/' || fixture.name,
  fixture.name, 'application/pdf', 4096, repeat(fixture.digit, 64)
from (
  values
    ('91000000-6000-4000-8000-000000000001', 'cahier-long.pdf', 'a'),
    ('91000000-6000-4000-8000-000000000002', 'signature.pdf', 'b'),
    ('91000000-6000-4000-8000-000000000003', 'chiffre.pdf', 'c'),
    ('91000000-6000-4000-8000-000000000004', 'lu.pdf', 'd')
) as fixture(asset_id, name, digit);

update public.information_agent_evidence_extractions
   set status = 'unsupported', attempts = 1, error_code = 'PAGE_LIMIT_EXCEEDED',
       error_message = 'Le PDF dépasse la limite de 100 pages.', completed_at = now() - interval '1 day',
       available_at = now() - interval '1 day'
 where asset_id = '91000000-6000-4000-8000-000000000001';
update public.information_agent_evidence_extractions
   set status = 'unsupported', attempts = 1, error_code = 'UNSUPPORTED_FILE_SIGNATURE',
       error_message = 'La signature du fichier n’est pas prise en charge.', completed_at = now() - interval '1 day'
 where asset_id = '91000000-6000-4000-8000-000000000002';
update public.information_agent_evidence_extractions
   set status = 'needs_password', attempts = 1, is_encrypted = true, error_code = 'PDF_PASSWORD_REQUIRED',
       completed_at = now() - interval '1 day'
 where asset_id = '91000000-6000-4000-8000-000000000003';
update public.information_agent_evidence_extractions
   set status = 'completed', attempts = 1, summary = 'Cahier des conditions de vente · 40 page(s).',
       completed_at = now() - interval '1 day'
 where asset_id = '91000000-6000-4000-8000-000000000004';

create temporary table pgtap_910_before on commit drop as
select asset_id, status, attempts, error_code, error_message, completed_at, updated_at
  from public.information_agent_evidence_extractions
 where asset_id::text like '91000000-6000-%';

select ok(
  not has_function_privilege(
    'service_role', 'app_private.requeue_evidence_extractions_refused_for_page_limit()', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'app_private.requeue_evidence_extractions_refused_for_page_limit()', 'execute'
  )
  and not has_function_privilege(
    'anon', 'app_private.requeue_evidence_extractions_refused_for_page_limit()', 'execute'
  ),
  'the requeue is executable by no API role'
);

select is(
  app_private.requeue_evidence_extractions_refused_for_page_limit(),
  1,
  'one extraction refused for its page count is put back in the queue'
);

select ok(
  (
    select status = 'queued' and attempts = 0 and error_code is null and error_message is null
           and completed_at is null and locked_at is null and available_at <= statement_timestamp()
      from public.information_agent_evidence_extractions
     where asset_id = '91000000-6000-4000-8000-000000000001'
  ),
  'it is queued again with no attempt spent, no error and no completion'
);

select is(
  (
    select count(*)::integer
      from public.claim_information_agent_evidence_extractions(10) claimed
     where claimed.asset_id = '91000000-6000-4000-8000-000000000001'
  ),
  1,
  'the worker claim takes it'
);

select ok(
  (
    select bool_and(
             (extraction.status, extraction.attempts, extraction.error_code, extraction.completed_at)
               is not distinct from (before.status, before.attempts, before.error_code, before.completed_at)
           )
      from public.information_agent_evidence_extractions extraction
      join pgtap_910_before before using (asset_id)
     where extraction.asset_id in (
       '91000000-6000-4000-8000-000000000002', '91000000-6000-4000-8000-000000000003'
     )
  ),
  'a refusal for another reason (file signature, encrypted PDF) is untouched'
);

select ok(
  (
    select (extraction.status, extraction.attempts, extraction.summary, extraction.completed_at)
           is not distinct from ('completed', 1, 'Cahier des conditions de vente · 40 page(s).', before.completed_at)
      from public.information_agent_evidence_extractions extraction
      join pgtap_910_before before using (asset_id)
     where extraction.asset_id = '91000000-6000-4000-8000-000000000004'
  ),
  'a completed reading is untouched'
);

select is(
  app_private.requeue_evidence_extractions_refused_for_page_limit(),
  0,
  'a second run puts nothing back in the queue'
);

select * from finish();

rollback;
