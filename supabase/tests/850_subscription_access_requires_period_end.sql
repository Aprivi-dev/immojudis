-- Un statut d'accès sans fin de période n'ouvre plus l'accès Analyse (20261110140000, n° 47).
-- Miroir de isPlanPeriodActive (src/lib/plans.ts) : trialing / active exigent une fin connue et
-- future ; past_due garde ses 7 jours de grâce à partir d'une fin connue ; le reste n'ouvre rien.
begin;

select plan(14);

-- 01 active sans fin ; 02 active avec fin future ; 03 trialing sans fin ; 04 active déjà finie ;
-- 05 past_due sans fin ; 06 past_due dans la grâce ; 07 active sans fin, avec un client Stripe
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'noend@end850.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8500000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'future@end850.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8500000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trial@end850.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8500000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'past@end850.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8500000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'due-none@end850.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8500000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'due-grace@end850.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8500000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'customer@end850.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (
  user_id, plan_code, status, current_period_end, stripe_customer_id
) values
  ('c8500000-0000-4000-8000-000000000001', 'analyse', 'active', null, null),
  ('c8500000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days', null),
  ('c8500000-0000-4000-8000-000000000003', 'analyse', 'trialing', null, null),
  ('c8500000-0000-4000-8000-000000000004', 'analyse', 'active', now() - interval '1 day', null),
  ('c8500000-0000-4000-8000-000000000005', 'analyse', 'past_due', null, null),
  ('c8500000-0000-4000-8000-000000000006', 'analyse', 'past_due', now() - interval '3 days', null),
  ('c8500000-0000-4000-8000-000000000007', 'analyse', 'active', null, 'cus_end850');

-- La règle elle-même -------------------------------------------------------------------------------
select is(
  app_private.subscription_grants_access('active', null), false,
  'active without a period end opens nothing'
);
select is(
  app_private.subscription_grants_access('trialing', null), false,
  'trialing without a period end opens nothing'
);
select is(
  app_private.subscription_grants_access('active', now() + interval '1 day'), true,
  'active with a future period end opens the access'
);
select is(
  app_private.subscription_grants_access('active', now() - interval '1 day'), false,
  'active past its period end opens nothing'
);
select is(
  app_private.subscription_grants_access('past_due', null), false,
  'past_due without a period end opens nothing (nothing to anchor the grace on)'
);
select is(
  app_private.subscription_grants_access('past_due', now() - interval '3 days'), true,
  'past_due keeps the seven days of grace after a known period end'
);
select is(
  app_private.subscription_grants_access('past_due', now() - interval '8 days'), false,
  'past_due stops after the grace'
);
select is(
  app_private.subscription_grants_access('paused', now() + interval '30 days'), false,
  'a paused subscription opens nothing'
);

-- Les fonctions d'accès -----------------------------------------------------------------------------
select ok(
  not app_private.has_active_analysis_access('c8500000-0000-4000-8000-000000000001'),
  'a subscription row without a period end gives no Analyse access'
);
select ok(
  not app_private.has_active_analysis_access('c8500000-0000-4000-8000-000000000003'),
  'a trialing row without a period end gives no Analyse access'
);
select ok(
  app_private.has_active_analysis_access('c8500000-0000-4000-8000-000000000002'),
  'a subscription with a future period end keeps the Analyse access'
);
select ok(
  app_private.has_active_analysis_access('c8500000-0000-4000-8000-000000000006'),
  'a failed renewal keeps the access during the grace'
);

-- Réservation d'un checkout -------------------------------------------------------------------------
select is(
  public.reserve_analyse_checkout('c8500000-0000-4000-8000-000000000007', 'token-end850-0000007'),
  true,
  'a row without a period end (no access) does not block a new checkout'
);
select is(
  public.reserve_analyse_checkout('c8500000-0000-4000-8000-000000000002', 'token-end850-0000002'),
  false,
  'a subscription with a future period end still blocks a second checkout'
);

select * from finish();
rollback;
