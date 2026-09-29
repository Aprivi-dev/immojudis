begin;

select plan(21);

select has_table(
  'public',
  'information_agent_portal_upload_reservations',
  'public contribution uploads have durable reservations'
);
select has_column(
  'public',
  'information_agent_portal_upload_reservations',
  'size_bytes',
  'reservations carry the quota charge bytes'
);
select has_column(
  'public',
  'information_agent_portal_upload_reservations',
  'requested_size_bytes',
  'reservations retain the caller-declared size separately from the quota charge'
);
select has_column(
  'public',
  'information_agent_portal_upload_reservations',
  'expires_at',
  'reservations expire with the signed upload ticket'
);
select has_function(
  'public',
  'reserve_information_agent_portal_upload',
  array['uuid', 'text', 'bigint', 'timestamptz'],
  'the portal can reserve storage quota atomically'
);
select has_function(
  'public',
  'consume_information_agent_portal_upload',
  array['uuid', 'text', 'bigint'],
  'validated portal files can consume their reservation'
);
select ok(
  (select relrowsecurity
   from pg_class relation
   join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
   where namespace_row.nspname = 'public'
     and relation.relname = 'information_agent_portal_upload_reservations'),
  'portal reservations are protected by RLS'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.information_agent_portal_upload_reservations',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.information_agent_portal_upload_reservations',
    'SELECT'
  ),
  'browser roles cannot read upload reservations'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.reserve_information_agent_portal_upload(uuid,text,bigint,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.reserve_information_agent_portal_upload(uuid,text,bigint,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.reserve_information_agent_portal_upload(uuid,text,bigint,timestamptz)',
    'EXECUTE'
  ),
  'only the server role can reserve upload quota'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.consume_information_agent_portal_upload(uuid,text,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.consume_information_agent_portal_upload(uuid,text,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.consume_information_agent_portal_upload(uuid,text,bigint)',
    'EXECUTE'
  ),
  'only the server role can consume upload quota'
);
select ok(
  position('503316480' in pg_get_functiondef(
    'public.reserve_information_agent_portal_upload(uuid,text,bigint,timestamptz)'::regprocedure
  )) > 0
  and position('41943040' in pg_get_functiondef(
    'public.reserve_information_agent_portal_upload(uuid,text,bigint,timestamptz)'::regprocedure
  )) > 0
  and position('pg_advisory_xact_lock' in pg_get_functiondef(
    'public.reserve_information_agent_portal_upload(uuid,text,bigint,timestamptz)'::regprocedure
  )) > 0
  and position('INFORMATION_AGENT_PORTAL_QUOTA_EXCEEDED' in pg_get_functiondef(
    'public.reserve_information_agent_portal_upload(uuid,text,bigint,timestamptz)'::regprocedure
  )) > 0,
  'the reservation function uses a bounded, serialized quota'
);

insert into auth.users (id) values
  ('39400000-0000-4000-8000-000000000001');

insert into public.auction_sales (id, source_name, source_url, status)
values (
  '39400000-1000-4000-8000-000000000001',
  'information-agent-portal-quota-pgtap',
  'https://example.test/information-agent-portal-quota-pgtap',
  'upcoming'
);

insert into public.information_agent_cases (
  id,
  sale_id,
  created_by,
  status,
  recipient_kind,
  recipient_email,
  normalized_recipient_email,
  subject,
  body_text,
  question_keys,
  missing_information
)
values (
  '39400000-2000-4000-8000-000000000001',
  '39400000-1000-4000-8000-000000000001',
  '39400000-0000-4000-8000-000000000001',
  'sent',
  'manual_professional',
  'contact@example.test',
  'contact@example.test',
  'Information-agent upload quota test',
  'Merci de transmettre les informations du dossier.',
  array['documents'],
  array['documents']
);

set local role service_role;

select is(
  (select remaining_bytes
   from public.reserve_information_agent_portal_upload(
     '39400000-2000-4000-8000-000000000001',
     '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000002/one.pdf',
     1000000,
     now() + interval '1 hour'
   )),
  461373440::bigint,
  'a reservation charges the full 40 MiB Storage object capacity'
);
select is(
  (select remaining_files
   from public.reserve_information_agent_portal_upload(
     '39400000-2000-4000-8000-000000000001',
     '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000003/two.pdf',
     1000000,
     now() + interval '1 hour'
   )),
  10::bigint,
  'the file counter includes active reservations'
);
update public.information_agent_portal_upload_reservations
set expires_at = now() - interval '1 minute'
where storage_path = '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000003/two.pdf';
select is(
  (select remaining_bytes
   from public.reserve_information_agent_portal_upload(
     '39400000-2000-4000-8000-000000000001',
     '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000004/three.pdf',
     1000000,
     now() + interval '1 hour'
   )),
  377487360::bigint,
  'an expired signed URL remains charged at the full object capacity'
);
insert into public.information_agent_portal_upload_reservations (
  case_id,
  storage_path,
  size_bytes,
  requested_size_bytes,
  expires_at
)
select
  '39400000-2000-4000-8000-000000000001'::uuid,
  '39400000-2000-4000-8000-000000000001/portal/' || lpad(to_hex(number), 36, '0') || '/bulk.pdf',
  41943040,
  1000000,
  now() + interval '1 hour'
from generate_series(4, 12) as numbers(number);
select is(
  (select count(*) from public.information_agent_portal_upload_reservations
   where case_id = '39400000-2000-4000-8000-000000000001'),
  12::bigint,
  'the test fixture fills all twelve reserved upload slots'
);
select throws_ok(
  $$select public.reserve_information_agent_portal_upload(
    '39400000-2000-4000-8000-000000000001',
    '39400000-2000-4000-8000-000000000001/portal/ffffffffffffffffffffffffffffffffffff/overflow.pdf',
    1000000,
    now() + interval '1 hour'
  )$$,
  '54000',
  'INFORMATION_AGENT_PORTAL_QUOTA_EXCEEDED',
  'the case quota rejects the thirteenth signed upload'
);
select lives_ok(
  $$select public.consume_information_agent_portal_upload(
    '39400000-2000-4000-8000-000000000001',
    '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000002/one.pdf',
    1000000
  )$$,
  'a validated reservation can be consumed'
);
select is(
  (select status
   from public.information_agent_portal_upload_reservations
   where storage_path = '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000002/one.pdf'),
  'consumed',
  'consumption is persisted'
);
select lives_ok(
  $$select public.consume_information_agent_portal_upload(
    '39400000-2000-4000-8000-000000000001',
    '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000002/one.pdf',
    1000000
  )$$,
  'consumption is idempotent for a retry'
);
select throws_ok(
  $$select public.reserve_information_agent_portal_upload(
    '39400000-2000-4000-8000-000000000001',
    '39400000-2000-4000-8000-000000000001/portal/not-a-uuid/bad.pdf',
    1000,
    now() + interval '1 hour'
  )$$,
  '22023',
  'Invalid information-agent portal upload reservation.',
  'reservations reject paths outside the case portal namespace'
);
select throws_ok(
  $$select public.consume_information_agent_portal_upload(
    '39400000-2000-4000-8000-000000000001',
    '39400000-2000-4000-8000-000000000001/portal/39400000-2000-4000-8000-000000000003/two.pdf',
    999999
  )$$,
  '23514',
  'Information-agent portal upload size mismatch.',
  'consumption rechecks the signed size'
);

select * from finish();
rollback;
