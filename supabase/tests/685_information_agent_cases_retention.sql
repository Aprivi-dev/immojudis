-- Rétention des dossiers partagés de l'agent d'information (20261101150000) : mêmes durées que les
-- demandes (21 jours sans envoi, 12 mois sans réponse, 24 mois après le dernier échange), jamais tant
-- qu'une demande y est rattachée ; fichiers mis en file de suppression Storage ; cascade des messages.
begin;

select plan(15);

-- Fixtures (dates relatives à now() : le test ne dépend pas du jour d'exécution) ---------------------
insert into auth.users (id) values ('68500000-0000-4000-8000-000000000001');
insert into public.auction_sales (id, source_name, source_url, status)
values (
  '68500000-1000-4000-8000-000000000001',
  'information-agent-cases-retention-pgtap',
  'https://example.test/information-agent-cases-retention-pgtap',
  'upcoming'
);

-- Demande sans dossier, qui porte les messages de test (messages.mission_id est obligatoire).
insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_email, subject, body_text, question_keys, missing_information,
  privacy_version
)
values (
  '68500000-2000-4000-8000-000000000001',
  '68500000-0000-4000-8000-000000000001',
  '68500000-1000-4000-8000-000000000001',
  'carrier-685@example.test',
  'Demande porteuse des messages de test',
  'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '685-pgtap'
);

insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text,
  question_keys, missing_information, sent_at, replied_at, created_at, updated_at
)
select
  fixture.id::uuid,
  '68500000-1000-4000-8000-000000000001',
  '68500000-0000-4000-8000-000000000001',
  fixture.status,
  fixture.email,
  fixture.email,
  'Dossier de test ' || fixture.label,
  'Merci de transmettre les informations du dossier.',
  array['documents'],
  array['documents'],
  now() - fixture.sent_age,
  now() - fixture.replied_age,
  now() - fixture.created_age,
  now() - fixture.created_age
from (
  values
    -- A : jamais envoyé, 30 jours -> supprimé
    ('68500000-3000-4000-8000-00000000000a', 'draft', 'case-a-685@example.test', 'A', null::interval, null::interval, interval '30 days'),
    -- B : jamais envoyé, 5 jours -> gardé
    ('68500000-3000-4000-8000-00000000000b', 'draft', 'case-b-685@example.test', 'B', null, null, interval '5 days'),
    -- C : envoyé il y a 13 mois, sans réponse -> supprimé
    ('68500000-3000-4000-8000-00000000000c', 'sent', 'case-c-685@example.test', 'C', interval '13 months', null, interval '13 months'),
    -- D : envoyé il y a 6 mois -> gardé
    ('68500000-3000-4000-8000-00000000000d', 'sent', 'case-d-685@example.test', 'D', interval '6 months', null, interval '6 months'),
    -- E : réponse il y a 13 mois -> gardé (24 mois)
    ('68500000-3000-4000-8000-00000000000e', 'replied', 'case-e-685@example.test', 'E', interval '14 months', interval '13 months', interval '14 months'),
    -- F : réponse il y a 25 mois -> supprimé, avec sa pièce
    ('68500000-3000-4000-8000-00000000000f', 'replied', 'case-f-685@example.test', 'F', interval '26 months', interval '25 months', interval '26 months'),
    -- G : envoyé il y a 14 mois mais encore rattaché à une demande -> gardé
    ('68500000-3000-4000-8000-000000000010', 'sent', 'case-g-685@example.test', 'G', interval '14 months', null, interval '14 months')
) as fixture(id, status, email, label, sent_age, replied_age, created_age);

insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
)
values (
  '68500000-2000-4000-8000-000000000002',
  '68500000-0000-4000-8000-000000000001',
  '68500000-1000-4000-8000-000000000001',
  '68500000-3000-4000-8000-000000000010',
  'case-g-685@example.test',
  'Demande encore rattachée au dossier G',
  'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '685-pgtap'
);

insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at, created_at
)
values
  ('68500000-4000-4000-8000-00000000000e', '68500000-2000-4000-8000-000000000001',
   '68500000-3000-4000-8000-00000000000e', '68500000-0000-4000-8000-000000000001',
   'inbound', 'reply', 'received', 'Réponse du dossier E', 'Voici les informations.',
   now() - interval '13 months', now() - interval '13 months'),
  ('68500000-4000-4000-8000-00000000000f', '68500000-2000-4000-8000-000000000001',
   '68500000-3000-4000-8000-00000000000f', '68500000-0000-4000-8000-000000000001',
   'inbound', 'reply', 'received', 'Réponse du dossier F', 'Voici les informations.',
   now() - interval '25 months', now() - interval '25 months');

insert into public.information_agent_evidence_assets (
  id, case_id, message_id, sale_id, storage_path, original_filename, mime_type, size_bytes, sha256
)
values (
  '68500000-5000-4000-8000-00000000000f',
  '68500000-3000-4000-8000-00000000000f',
  '68500000-4000-4000-8000-00000000000f',
  '68500000-1000-4000-8000-000000000001',
  '68500000-3000-4000-8000-00000000000f/inbound/68500000-4000-4000-8000-00000000000f/pv.pdf',
  'pv.pdf', 'application/pdf', 1234,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

-- La fonction de durée ----------------------------------------------------------------------------
select ok(
  not has_function_privilege(
    'anon', 'app_private.information_agent_case_purge_due(public.information_agent_cases, timestamptz)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'app_private.information_agent_case_purge_due(public.information_agent_cases, timestamptz)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'app_private.information_agent_case_purge_due(public.information_agent_cases, timestamptz)', 'EXECUTE'
  ),
  'the case retention rule is closed to the browser roles'
);
select ok(
  (
    select p.prosecdef and p.proconfig @> array['search_path=""']::text[]
    from pg_proc p
    where p.oid = 'app_private.information_agent_case_purge_due(public.information_agent_cases, timestamptz)'::regprocedure
  ),
  'the case retention rule is security definer with an empty search_path'
);

select is(
  (
    select array_agg(right(shared_case.id::text, 1) order by shared_case.id)
    from public.information_agent_cases shared_case
    where shared_case.sale_id = '68500000-1000-4000-8000-000000000001'
      and app_private.information_agent_case_purge_due(shared_case, now())
  ),
  array['a', 'c', 'f'],
  'due cases: never sent after 21 days, unanswered after 12 months, answered after 24 months'
);
select is(
  app_private.information_agent_case_purge_due(
    (select shared_case from public.information_agent_cases shared_case
     where shared_case.id = '68500000-3000-4000-8000-000000000010'),
    now()
  ),
  false,
  'a case still attached to a request is never due, however old'
);

-- La purge ----------------------------------------------------------------------------------------
select is(
  (app_private.purge_information_agent_data(now()) ->> 'information_agent_cases')::integer,
  3,
  'the retention report counts the purged cases'
);
select is(
  (
    select array_agg(right(id::text, 1) order by id)
    from public.information_agent_cases
    where sale_id = '68500000-1000-4000-8000-000000000001'
  ),
  array['b', 'd', 'e', '0'],
  'the due cases are gone, the others (recent, sent 6 months ago, answered 13 months ago, attached to a request) stay'
);
select is(
  (select count(*) from public.information_agent_messages
   where case_id = '68500000-3000-4000-8000-00000000000f'),
  0::bigint,
  'the messages of a purged case go with it'
);
select is(
  (select count(*) from public.information_agent_messages
   where case_id = '68500000-3000-4000-8000-00000000000e'),
  1::bigint,
  'the messages of a kept case stay'
);
select is(
  (select count(*) from public.information_agent_evidence_assets
   where case_id = '68500000-3000-4000-8000-00000000000f'),
  0::bigint,
  'the evidence rows of a purged case go with it'
);
select is(
  (
    select count(*)
    from public.sale_retention_storage_queue
    where bucket = 'information-agent-evidence'
      and object_path = '68500000-3000-4000-8000-00000000000f/inbound/68500000-4000-4000-8000-00000000000f/pv.pdf'
  ),
  1::bigint,
  'the file of a purged case is queued for Storage deletion'
);
select is(
  (select count(*) from public.sale_retention_storage_queue
   where object_path like '68500000-%'),
  1::bigint,
  'nothing else is queued'
);
select is(
  (select count(*) from public.information_agent_missions
   where id = '68500000-2000-4000-8000-000000000002'),
  1::bigint,
  'the request attached to the kept case is untouched'
);
select is(
  app_private.purge_information_agent_data(now()),
  '{"information_agent_missions": 0, "information_agent_cases": 0, "information_agent_contacts": 0}'::jsonb,
  'a second run has nothing left to purge'
);

-- Le dossier suit la dernière demande -----------------------------------------------------------------
delete from public.information_agent_missions where id = '68500000-2000-4000-8000-000000000002';
select is(
  (app_private.purge_information_agent_data(now()) ->> 'information_agent_cases')::integer,
  1,
  'once its last request is gone, the old case (sent 14 months ago) is purged'
);
select ok(
  not has_function_privilege('authenticated', 'app_private.purge_information_agent_data(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.purge_information_agent_data(timestamptz)', 'EXECUTE'),
  'the purge stays for the server (service role) only'
);

select * from finish();

rollback;
