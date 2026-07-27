begin;

select plan(12);

select ok(
  has_column_privilege('authenticated', 'public.listing_publication_requests', 'title', 'INSERT'),
  'authenticated publishers may insert a user-owned title'
);

select ok(
  not has_column_privilege('authenticated', 'public.listing_publication_requests', 'status', 'INSERT'),
  'authenticated publishers cannot insert moderation status'
);

select ok(
  not has_table_privilege('authenticated', 'public.saved_property_reports', 'UPDATE'),
  'authenticated users cannot rewrite server-owned report snapshots'
);

select ok(
  has_column_privilege('authenticated', 'public.user_alert_notifications', 'read_at', 'UPDATE'),
  'authenticated users may mark their notification as read'
);

select ok(
  not has_column_privilege('authenticated', 'public.user_alert_notifications', 'delivery_status', 'UPDATE'),
  'authenticated users cannot forge notification delivery status'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.consume_api_rate_limit(uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated users cannot invoke the service-owned rate limiter directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.consume_api_rate_limit(uuid,text,integer,integer)',
    'EXECUTE'
  ),
  'service role can consume rate-limit buckets'
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data
) values (
  '70000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'quota-owner@example.test',
  '',
  now(),
  now(),
  now(),
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.user_subscriptions (user_id, plan_code, status)
values ('70000000-0000-0000-0000-000000000001', 'analyse', 'active');

set local role service_role;

select lives_ok(
  $$insert into public.user_api_keys (user_id, name, key_prefix, key_hash)
    values
      ('70000000-0000-0000-0000-000000000001', 'Key one', 'immojudis_key_1', repeat('1', 64)),
      ('70000000-0000-0000-0000-000000000001', 'Key two', 'immojudis_key_2', repeat('2', 64))$$,
  'two active API keys fit the atomic database quota'
);

select throws_ok(
  $$insert into public.user_api_keys (user_id, name, key_prefix, key_hash)
    values ('70000000-0000-0000-0000-000000000001', 'Key three', 'immojudis_key_3', repeat('3', 64))$$,
  'P0001',
  'Quota de 2 clés API actives atteint.',
  'the database rejects a third active API key'
);

select ok(
  public.begin_stripe_webhook_event('evt_retryable', 'charge.refunded', false),
  'a Stripe event starts processing on first delivery'
);

select public.complete_stripe_webhook_event(
  'evt_retryable',
  'failed',
  'temporary downstream failure'
);

select ok(
  public.begin_stripe_webhook_event('evt_retryable', 'charge.refunded', false),
  'a failed Stripe event can be retried atomically'
);

select ok(
  not public.begin_stripe_webhook_event('evt_retryable', 'charge.refunded', false),
  'an event already being processed cannot run concurrently'
);

select * from finish();

rollback;
