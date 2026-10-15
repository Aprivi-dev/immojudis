-- apply_stripe_subscription_state: a late event of an OLD subscription must not overwrite the row of
-- a NEW subscription that still grants access (20261021100000_stripe_superseded_subscription.sql).
begin;

select plan(15);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
      and position('superseded_subscription' in pg_get_functiondef(procedure_row.oid)) > 0
    from pg_proc procedure_row
    where procedure_row.oid = 'public.apply_stripe_subscription_state(uuid, text, text, text, text, timestamptz, bigint, jsonb)'::regprocedure
  ),
  'apply_stripe_subscription_state keeps the superseded guard and its service-only boundary'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '46600000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'stripe-superseded@example.test', '', now(), now(), now(),
  '{}'::jsonb, '{}'::jsonb
);

-- The customer re-subscribed: the row holds the NEW subscription B, active for 30 more days.
insert into public.user_subscriptions (
  user_id, plan_code, status, stripe_customer_id, stripe_subscription_id,
  current_period_end, stripe_event_created
) values (
  '46600000-0000-4000-8000-000000000001', 'analyse', 'active', 'cus_pgtap466', 'sub_B',
  now() + interval '30 days', 1000
)
on conflict (user_id) do update set
  plan_code = excluded.plan_code,
  status = excluded.status,
  stripe_customer_id = excluded.stripe_customer_id,
  stripe_subscription_id = excluded.stripe_subscription_id,
  current_period_end = excluded.current_period_end,
  stripe_event_created = excluded.stripe_event_created;

-- 1. The late customer.subscription.deleted of the OLD subscription A is ignored.
select results_eq(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'cancelled', 'cus_pgtap466', 'sub_A',
      now() + interval '10 days', 2000)$$,
  $$values (false, 'superseded_subscription'::text)$$,
  'a cancelled event of subscription A is superseded while subscription B grants access'
);

select is(
  (
    select stripe_subscription_id || ':' || status || ':' || stripe_event_created::text
    from public.user_subscriptions
    where user_id = '46600000-0000-4000-8000-000000000001'
  ),
  'sub_B:active:1000',
  'the superseded event leaves the row of subscription B untouched'
);

-- 2. An event of the CURRENT subscription B replaces the row as usual.
select results_eq(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'active', 'cus_pgtap466', 'sub_B',
      now() + interval '60 days', 3000)$$,
  $$values (true, 'applied'::text)$$,
  'an active event of subscription B is applied'
);

select is(
  (
    select stripe_subscription_id || ':' || status || ':' || stripe_event_created::text
    from public.user_subscriptions
    where user_id = '46600000-0000-4000-8000-000000000001'
  ),
  'sub_B:active:3000',
  'the event of subscription B replaced the row'
);

-- 3. A status that grants access from ANOTHER subscription still replaces the row (re-subscription).
select results_eq(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'active', 'cus_pgtap466', 'sub_A',
      now() + interval '30 days', 4000)$$,
  $$values (true, 'applied'::text)$$,
  'an active event of another subscription A is applied'
);

select is(
  (
    select stripe_subscription_id || ':' || status || ':' || stripe_event_created::text
    from public.user_subscriptions
    where user_id = '46600000-0000-4000-8000-000000000001'
  ),
  'sub_A:active:4000',
  'the active event of subscription A replaced the row'
);

-- 4. The guard is symmetric: now A is current, a late cancellation of B is ignored.
select results_eq(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'cancelled', 'cus_pgtap466', 'sub_B',
      now() + interval '10 days', 5000)$$,
  $$values (false, 'superseded_subscription'::text)$$,
  'a cancelled event of subscription B is superseded while subscription A grants access'
);

select is(
  (
    select stripe_subscription_id || ':' || status || ':' || stripe_event_created::text
    from public.user_subscriptions
    where user_id = '46600000-0000-4000-8000-000000000001'
  ),
  'sub_A:active:4000',
  'the row of subscription A is untouched'
);

-- 5. The current subscription itself can be cancelled: only OTHER ids are guarded.
select results_eq(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'cancelled', 'cus_pgtap466', 'sub_A',
      now() + interval '10 days', 6000)$$,
  $$values (true, 'applied'::text)$$,
  'the cancellation of the current subscription is applied'
);

select is(
  (
    select stripe_subscription_id || ':' || status || ':' || stripe_event_created::text
    from public.user_subscriptions
    where user_id = '46600000-0000-4000-8000-000000000001'
  ),
  'sub_A:cancelled:6000',
  'the row now holds the cancelled subscription A'
);

-- 6. The row no longer grants access: an event of another subscription, whatever its status, applies.
select results_eq(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'cancelled', 'cus_pgtap466', 'sub_B',
      now() + interval '10 days', 7000)$$,
  $$values (true, 'applied'::text)$$,
  'a cancelled event of another subscription applies when the row grants no access'
);

select is(
  (
    select stripe_subscription_id || ':' || status || ':' || stripe_event_created::text
    from public.user_subscriptions
    where user_id = '46600000-0000-4000-8000-000000000001'
  ),
  'sub_B:cancelled:7000',
  'the row holds subscription B once nothing granted access'
);

-- 7. The earlier guards are unchanged: an older event of the same subscription is stale.
select results_eq(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'active', 'cus_pgtap466', 'sub_B',
      now() + interval '30 days', 100)$$,
  $$values (false, 'stale_event'::text)$$,
  'an older event of the same subscription is still stale'
);

select throws_ok(
  $$select * from public.apply_stripe_subscription_state(
      '46600000-0000-4000-8000-000000000001', 'analyse', 'unknown', 'cus_pgtap466', 'sub_B',
      now() + interval '30 days', 8000)$$,
  '22023',
  'Invalid Stripe subscription state.',
  'an unknown status is still rejected'
);

select * from finish();

rollback;
