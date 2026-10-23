-- Ramassage des objets Storage des emails entrants (20261101150100) : corps et pièces jointes
-- (<dossier>/<message>/<body ou clé>/<fichier>) rejoignent les dépôts du portail dans la file de
-- suppression, 24 heures après leur création et seulement sans ligne de pièce correspondante.
begin;

select plan(9);

insert into auth.users (id) values ('68600000-0000-4000-8000-000000000001');
insert into public.auction_sales (id, source_name, source_url, status)
values (
  '68600000-1000-4000-8000-000000000001',
  'information-agent-inbound-orphans-pgtap',
  'https://example.test/information-agent-inbound-orphans-pgtap',
  'upcoming'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, recipient_email, subject, body_text, question_keys, missing_information,
  privacy_version
)
values (
  '68600000-2000-4000-8000-000000000001',
  '68600000-0000-4000-8000-000000000001',
  '68600000-1000-4000-8000-000000000001',
  'orphans-686@example.test',
  'Demande de test des objets orphelins',
  'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '686-pgtap'
);
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text,
  question_keys, missing_information
)
values (
  '68600000-3000-4000-8000-000000000001',
  '68600000-1000-4000-8000-000000000001',
  '68600000-0000-4000-8000-000000000001',
  'sent', 'orphans-686@example.test', 'orphans-686@example.test',
  'Dossier de test des objets orphelins',
  'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents']
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text
)
values (
  '68600000-4000-4000-8000-000000000001',
  '68600000-2000-4000-8000-000000000001',
  '68600000-3000-4000-8000-000000000001',
  '68600000-0000-4000-8000-000000000001',
  'inbound', 'reply', 'received', 'Réponse de test', 'Voici le document.'
);
-- Une pièce enregistrée : son objet ne doit jamais être ramassé.
insert into public.information_agent_evidence_assets (
  id, case_id, message_id, sale_id, storage_path, original_filename, mime_type, size_bytes, sha256
)
values (
  '68600000-5000-4000-8000-000000000001',
  '68600000-3000-4000-8000-000000000001',
  '68600000-4000-4000-8000-000000000001',
  '68600000-1000-4000-8000-000000000001',
  '68600000-3000-4000-8000-000000000001/68600000-4000-4000-8000-000000000001/att-1/aaaa-pv.pdf',
  'pv.pdf', 'application/pdf', 1234,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

set local role service_role;

insert into storage.objects(bucket_id, name, created_at) values
  -- orphelin du portail, ancien
  ('information-agent-evidence',
   '68600000-3000-4000-8000-000000000001/portal/68600000-6000-4000-8000-000000000001/old.pdf',
   '2030-01-01 00:00:00+00'),
  -- corps d'un email entrant sans ligne de pièce, ancien
  ('information-agent-evidence',
   '68600000-3000-4000-8000-000000000001/68600000-4000-4000-8000-000000000002/body/bbbb-email-body.txt',
   '2030-01-01 00:00:00+00'),
  -- pièce jointe d'un email entrant sans ligne de pièce, ancienne
  ('information-agent-evidence',
   '68600000-3000-4000-8000-000000000001/68600000-4000-4000-8000-000000000002/att-9/cccc-plan.pdf',
   '2030-01-01 00:00:00+00'),
  -- pièce jointe enregistrée : jamais ramassée
  ('information-agent-evidence',
   '68600000-3000-4000-8000-000000000001/68600000-4000-4000-8000-000000000001/att-1/aaaa-pv.pdf',
   '2030-01-01 00:00:00+00'),
  -- email entrant récent (moins de 24 heures) : en cours de traitement
  ('information-agent-evidence',
   '68600000-3000-4000-8000-000000000001/68600000-4000-4000-8000-000000000003/body/dddd-email-body.txt',
   '2030-01-01 12:00:00+00'),
  -- autre forme de chemin : jamais touchée
  ('information-agent-evidence',
   '68600000-3000-4000-8000-000000000001/email/nonportal.pdf',
   '2030-01-01 00:00:00+00');

select is(
  public.enqueue_orphan_information_agent_portal_uploads('2030-01-02 00:00:00+00', 100),
  3,
  'the old portal object and the two old inbound objects without a row are enqueued'
);
select is(
  (select array_agg(regexp_replace(object_path, '^[0-9a-f-]{36}/', '') order by object_path)
   from public.sale_retention_storage_queue
   where object_path like '68600000-%'),
  array[
    '68600000-4000-4000-8000-000000000002/att-9/cccc-plan.pdf',
    '68600000-4000-4000-8000-000000000002/body/bbbb-email-body.txt',
    'portal/68600000-6000-4000-8000-000000000001/old.pdf'
  ],
  'the portal object, the inbound body and the inbound attachment enter the outbox'
);
select is(
  (select count(*) from public.sale_retention_storage_queue
   where object_path like '%/att-1/aaaa-pv.pdf'),
  0::bigint,
  'an object with an evidence row is never enqueued'
);
select is(
  (select count(*) from public.sale_retention_storage_queue
   where object_path like '%/68600000-4000-4000-8000-000000000003/%'),
  0::bigint,
  'an inbound object younger than 24 hours is left to its worker'
);
select is(
  (select count(*) from public.sale_retention_storage_queue
   where object_path like '%/email/nonportal.pdf'),
  0::bigint,
  'a path of another shape is not touched'
);
select is(
  public.enqueue_orphan_information_agent_portal_uploads('2030-01-02 00:00:00+00', 100),
  0,
  'the sweep is idempotent'
);
select is(
  public.enqueue_orphan_information_agent_portal_uploads('2030-01-03 00:00:00+00', 100),
  1,
  'the recent inbound object is enqueued once it is older than 24 hours'
);
select throws_ok(
  $$select public.enqueue_orphan_information_agent_portal_uploads(now(), 101)$$,
  '22023',
  'Portal upload cleanup requires a timestamp and batch size between 1 and 100.',
  'the batch stays bounded'
);

reset role;
select ok(
  not has_function_privilege(
    'anon', 'public.enqueue_orphan_information_agent_portal_uploads(timestamptz,integer)', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'public.enqueue_orphan_information_agent_portal_uploads(timestamptz,integer)', 'execute'
  ),
  'browser roles still cannot enqueue Storage deletions'
);

select * from finish();
rollback;
