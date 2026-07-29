begin;

select plan(15);

select has_table('public', 'commercial_acceptances', 'commercial acceptance evidence exists');
select has_table('public', 'commercial_confirmation_deliveries', 'durable confirmation delivery is tracked');
select has_table('public', 'data_subject_requests', 'data-subject requests are tracked');

select ok(
  not has_table_privilege('authenticated', 'public.commercial_acceptances', 'SELECT'),
  'authenticated users cannot read the commercial evidence store directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.data_subject_requests', 'SELECT'),
  'authenticated users cannot bypass the server-side privacy request projection'
);
select ok(
  has_table_privilege('service_role', 'public.commercial_acceptances', 'INSERT'),
  'the trusted checkout can write acceptance evidence'
);
select ok(
  has_table_privilege('service_role', 'public.data_subject_requests', 'UPDATE'),
  'the trusted operator path can process privacy requests'
);

set local role service_role;

insert into public.commercial_acceptances (
  id,
  terms_version,
  terms_sha256,
  privacy_version,
  privacy_sha256,
  offer_code,
  amount_cents,
  currency,
  terms_accepted,
  payment_obligation_acknowledged,
  immediate_performance_requested,
  withdrawal_information_acknowledged,
  checkout_session_id,
  checkout_created_at,
  accepted_at
) values (
  '90000000-0000-4000-8000-000000000001',
  '2026-07-29.1',
  '3b46da5f455e9420656e5269ee45749907f6fc01f9fe25a78bcd81e769560378',
  '2026-07-29.1',
  '4359b4a452946d2f2e09d87ea23e61c08f7292cdb365685e4deb95673f622b97',
  'analyse_30_days',
  2900,
  'eur',
  true,
  true,
  true,
  true,
  'cs_phase_6',
  '2026-07-29T15:00:00Z',
  '2026-07-29T15:00:00Z'
);

select is(
  (select archived_until from public.commercial_acceptances where id = '90000000-0000-4000-8000-000000000001'),
  '2036-07-29T15:00:00Z'::timestamptz,
  'commercial evidence receives a ten-year archive deadline'
);

select throws_ok(
  $$update public.commercial_acceptances set amount_cents = 2800 where id = '90000000-0000-4000-8000-000000000001'$$,
  '55000',
  'Commercial acceptance evidence is immutable.',
  'commercial evidence cannot be rewritten'
);

insert into public.data_subject_requests (
  id,
  requester_email,
  request_type,
  submitted_at,
  acknowledged_at,
  due_at
) values (
  '90000000-0000-4000-8000-000000000002',
  'phase6@example.test',
  'access',
  '2026-07-29T15:00:00Z',
  '2026-07-29T15:00:00Z',
  '2026-08-29T15:00:00Z'
);

select is(
  (select due_at - submitted_at from public.data_subject_requests where id = '90000000-0000-4000-8000-000000000002'),
  interval '1 month',
  'data-subject requests carry the one-month response deadline'
);

select throws_ok(
  $$update public.data_subject_requests set status = 'completed' where id = '90000000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'a terminal request requires a completion timestamp'
);

update public.data_subject_requests
set
  status = 'completed',
  completed_at = '2026-07-30T15:00:00Z',
  resolution_code = 'access_copy_delivered'
where id = '90000000-0000-4000-8000-000000000002';

select is(
  (select status from public.data_subject_requests where id = '90000000-0000-4000-8000-000000000002'),
  'completed',
  'an operator can close a request with its completion timestamp'
);

select lives_ok(
  $$select public.run_data_retention('2040-08-01T00:00:00Z'::timestamptz)$$,
  'the scheduled retention procedure covers Phase 6 data'
);

select is(
  (select count(*)::integer from public.commercial_acceptances where id = '90000000-0000-4000-8000-000000000001'),
  0,
  'expired commercial evidence is purged after its ten-year deadline'
);

select is(
  (select count(*)::integer from public.data_subject_requests where id = '90000000-0000-4000-8000-000000000002'),
  0,
  'closed privacy requests are purged after five years'
);

select * from finish();

rollback;
