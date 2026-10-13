begin;
select plan(12);

select has_table('public', 'offer_opening_notifications', 'opening requests are stored');

select ok(
  has_table_privilege('authenticated', 'public.offer_opening_notifications', 'SELECT'),
  'an account can read its own opening request'
);
select ok(
  not has_table_privilege('authenticated', 'public.offer_opening_notifications', 'INSERT'),
  'an account cannot insert a request directly: consent is recorded by the server'
);
select ok(
  not has_table_privilege('authenticated', 'public.offer_opening_notifications', 'UPDATE'),
  'an account cannot forge the consent date, the wording version or the notified mark'
);
select ok(
  not has_table_privilege('anon', 'public.offer_opening_notifications', 'SELECT'),
  'visitors cannot read opening requests'
);
select ok(
  has_table_privilege('service_role', 'public.offer_opening_notifications', 'INSERT'),
  'the trusted server route can record a request'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  ('71000000-0000-0000-0000-00000000000' || n)::uuid,
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'opening-' || n || '@example.test',
  '',
  now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from generate_series(1, 6) n;

-- Retention is evaluated at 2026-12-01.
insert into public.offer_opening_notifications
  (user_id, notify_enabled, consented_at, revoked_at, notified_at, consent_text_version)
values
  -- withdrawn 40 days ago: purged
  ('71000000-0000-0000-0000-000000000001', false, '2026-09-01T00:00:00Z', '2026-10-22T00:00:00Z', null, 'v-test'),
  -- withdrawn 10 days ago: kept
  ('71000000-0000-0000-0000-000000000002', false, '2026-09-01T00:00:00Z', '2026-11-21T00:00:00Z', null, 'v-test'),
  -- notified 40 days ago: purged
  ('71000000-0000-0000-0000-000000000003', true, '2026-09-01T00:00:00Z', null, '2026-10-22T00:00:00Z', 'v-test'),
  -- notified 10 days ago: kept
  ('71000000-0000-0000-0000-000000000004', true, '2026-09-01T00:00:00Z', null, '2026-11-21T00:00:00Z', 'v-test'),
  -- never followed by an opening for more than 12 months: purged
  ('71000000-0000-0000-0000-000000000005', true, '2025-10-30T00:00:00Z', null, null, 'v-test'),
  -- recent pending request: kept
  ('71000000-0000-0000-0000-000000000006', true, '2026-09-01T00:00:00Z', null, null, 'v-test');

set local role service_role;

select lives_ok(
  $$select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)$$,
  'the scheduled retention procedure covers opening requests'
);

select is(
  (select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)
     -> 'offer_opening_notifications'),
  '0'::jsonb,
  'the retention report names the opening requests purge (already done: nothing left to delete)'
);

select is(
  (select array_agg(right(user_id::text, 1) order by user_id)
     from public.offer_opening_notifications
     where user_id::text like '71000000-%'),
  array['2', '4', '6'],
  'withdrawn or notified requests older than 30 days and requests older than 12 months are purged'
);

select is(
  (select count(*)::integer from public.offer_opening_notifications
     where user_id::text like '71000000-%' and notify_enabled and notified_at is null),
  1,
  'a recent pending request is kept'
);

select is(
  (select count(*)::integer from public.offer_opening_notifications
     where user_id::text like '71000000-%' and not notify_enabled),
  1,
  'a request withdrawn less than 30 days ago is kept'
);

select * from finish();

rollback;
