begin;

select plan(16);

select ok(
  not has_table_privilege('authenticated', 'public.lawyer_referral_requests', 'SELECT'),
  'requesters cannot bypass the server projection to read referral admin fields'
);

select ok(
  not has_table_privilege('authenticated', 'public.data_refresh_requests', 'INSERT'),
  'refresh queue writes are server-owned'
);

select ok(
  not has_table_privilege('authenticated', 'public.user_sale_watch_snapshots', 'INSERT'),
  'watch snapshots are server-owned'
);

select ok(
  not has_table_privilege('authenticated', 'public.user_sale_change_events', 'INSERT'),
  'sale change events cannot be forged by subscribers'
);

select ok(
  has_column_privilege('authenticated', 'public.user_sale_change_events', 'read_at', 'UPDATE'),
  'subscribers may acknowledge a sale change event'
);

select ok(
  not has_table_privilege('authenticated', 'public.user_alert_matches', 'INSERT'),
  'alert matches cannot be forged to amplify notifications'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.evaluate_operational_health(timestamptz)',
    'EXECUTE'
  ),
  'operational health evaluation is not user-callable'
);

set local role anon;

select throws_ok(
  $$select * from public.search_auction_sales_preview(p_min_surface => 40)$$,
  '42501',
  'Protected preview filters require authentication.',
  'anonymous preview cannot probe a protected surface filter'
);

select throws_ok(
  $$select * from public.search_auction_sales_preview(
      p_keywords => array['1','2','3','4','5','6']::text[]
    )$$,
  '22023',
  'Invalid or oversized preview search parameters.',
  'anonymous preview rejects oversized filter arrays'
);

reset role;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '74000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'phase45@example.test', '', now(), now(), now(),
  '{}'::jsonb, '{}'::jsonb
);

insert into public.user_subscriptions (user_id, plan_code, status)
values ('74000000-0000-0000-0000-000000000001', 'analyse', 'active');

set local role service_role;

insert into public.auction_runs (status, source, started_at, created_at, updated_at)
values (
  'running',
  'phase-4-5-test',
  '2026-07-14T14:00:00Z'::timestamptz,
  '2026-07-14T14:00:00Z'::timestamptz,
  '2026-07-14T14:00:00Z'::timestamptz
);

select lives_ok(
  $$insert into public.user_alerts (user_id, name, is_active)
    select '74000000-0000-0000-0000-000000000001', 'Alert ' || n, true
    from generate_series(1, 25) n$$,
  'twenty-five active alerts fit the atomic quota'
);

select throws_ok(
  $$insert into public.user_alerts (user_id, name, is_active)
    values ('74000000-0000-0000-0000-000000000001', 'Alert 26', true)$$,
  'P0001',
  'Quota de 25 alertes actives atteint.',
  'the database rejects a twenty-sixth active alert'
);

select lives_ok(
  $$select public.evaluate_operational_health('2026-07-14T18:30:00Z'::timestamptz)$$,
  'service role can evaluate operational health'
);

select is(
  (select status from public.operational_alerts where alert_key = 'cron.stale'),
  'open',
  'missing cron success records produce a deduplicated operational alert'
);

select is(
  (select status from public.operational_alerts where alert_key = 'pipeline.import.unhealthy'),
  'open',
  'a pipeline import running for more than three hours raises an operational alert'
);

select ok(
  has_table_privilege('service_role', 'public.operational_alerts', 'SELECT'),
  'service role can inspect operational alerts'
);

select ok(
  not has_table_privilege('authenticated', 'public.operational_alerts', 'SELECT'),
  'operational alerts are not exposed to subscribers'
);

select * from finish();

rollback;
