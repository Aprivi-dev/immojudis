begin;

select plan(4);

insert into public.auction_sales (
  id, source_name, source_url, city, status, sale_date, raw_payload
) values (
  'c3900000-0000-4000-8000-000000000001',
  'status-quarantine-test',
  'https://example.test/status-quarantine/1',
  'StatusQuarantineC390',
  'quarantined',
  '2026-10-10T10:00:00Z',
  '{}'::jsonb
);

select is(
  app_private.auction_sale_is_publicly_visible('c3900000-0000-4000-8000-000000000001'),
  false,
  'status-only quarantine is hidden by the preview helper'
);

set local role anon;
select is(
  (select count(*) from public.v_auction_sales_app_preview
    where id = 'c3900000-0000-4000-8000-000000000001'),
  0::bigint,
  'anonymous preview hides status-only quarantine'
);
reset role;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  'c3900000-0000-4000-8000-000000000010',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'status-quarantine-premium@example.test', '',
  now(), now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values (
  'c3900000-0000-4000-8000-000000000010', 'analyse', 'active', now() + interval '30 days'
);

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c3900000-0000-4000-8000-000000000010';
select is(
  (select count(*) from public.auction_sales
    where id = 'c3900000-0000-4000-8000-000000000001'),
  0::bigint,
  'authenticated premium direct read hides status-only quarantine'
);
reset role;

select ok(
  (select pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%quarantined%'
     from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.auction_sales'::regclass
      and policy.polname = 'auction_sales_authenticated_read'),
  'authenticated read policy keeps the status gate'
);

select * from finish();

rollback;
