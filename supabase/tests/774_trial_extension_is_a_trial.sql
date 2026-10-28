-- Prolongation d'essai par l'administrateur (20261108130000) : une ligne d'essai, pas un abonnement.
-- Le compte prolongé a l'accès Analyse jusqu'à la fin choisie, mais pas le droit durable
-- (has_standing_analysis_access) ; il peut réserver un checkout ; un abonné Stripe ou une ligne
-- ordinaire garde son comportement.
begin;

select plan(16);

-- 01 prolongé (source admin_trial_extension, sans abonnement Stripe) ; 02 prolongé puis payé
-- (stripe_subscription_id présent) ; 03 attribution manuelle ordinaire (source admin) ; 04 abonné ;
-- 05 prolongation échue ; 06 sans ligne
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7700000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ext-trial@ext770.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7700000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ext-paid@ext770.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7700000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ext-manual@ext770.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7700000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ext-sub@ext770.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7700000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ext-expired@ext770.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7700000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ext-none@ext770.example.test', '', now() - interval '20 days',
   now() - interval '20 days', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (
  user_id, plan_code, status, current_period_end, stripe_subscription_id, metadata
) values
  ('c7700000-0000-4000-8000-000000000001', 'analyse', 'trialing', now() + interval '30 days', null,
   '{"manual_grant": {"source": "admin_trial_extension"}}'::jsonb),
  ('c7700000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days', 'sub_ext770',
   '{"manual_grant": {"source": "admin_trial_extension"}}'::jsonb),
  ('c7700000-0000-4000-8000-000000000003', 'analyse', 'active', now() + interval '30 days', null,
   '{"manual_grant": {"source": "admin"}}'::jsonb),
  ('c7700000-0000-4000-8000-000000000004', 'analyse', 'active', now() + interval '30 days', 'sub_ext770_2',
   '{}'::jsonb),
  ('c7700000-0000-4000-8000-000000000005', 'analyse', 'trialing', now() - interval '1 day', null,
   '{"manual_grant": {"source": "admin_trial_extension"}}'::jsonb);

-- Reconnaissance de la ligne ------------------------------------------------------------------------
select is(
  app_private.is_admin_trial_extension('{"manual_grant": {"source": "admin_trial_extension"}}'::jsonb, null),
  true,
  'a trial extension row without a Stripe subscription is recognised'
);
select is(
  app_private.is_admin_trial_extension('{"manual_grant": {"source": "admin_trial_extension"}}'::jsonb, 'sub_1'),
  false,
  'a row carrying a Stripe subscription is an ordinary subscription'
);
select is(
  app_private.is_admin_trial_extension('{"manual_grant": {"source": "admin"}}'::jsonb, null),
  false,
  'an ordinary manual grant is not a trial extension'
);
select is(app_private.is_admin_trial_extension(null, null), false, 'no metadata, no extension');

-- Accès Analyse (inchangé) et droit durable (exclu) ----------------------------------------------------
update app_private.launch_offer set active = true where singleton;
select ok(
  app_private.has_active_analysis_access('c7700000-0000-4000-8000-000000000001'),
  'the extended account has the Analyse access until the chosen end'
);
select ok(
  not app_private.has_standing_analysis_access('c7700000-0000-4000-8000-000000000001'),
  'the extended account has no standing access'
);
select ok(
  not app_private.snapshot_price_access('c7700000-0000-4000-8000-000000000001'),
  'the extended account does not get the adjudication price in its snapshots'
);
select ok(
  app_private.has_standing_analysis_access('c7700000-0000-4000-8000-000000000002'),
  'an extension that became a Stripe subscription is a standing access'
);
select ok(
  app_private.has_standing_analysis_access('c7700000-0000-4000-8000-000000000003'),
  'an ordinary manual grant keeps the standing access'
);
select ok(
  app_private.has_standing_analysis_access('c7700000-0000-4000-8000-000000000004'),
  'a subscriber keeps the standing access'
);
select ok(
  not app_private.has_active_analysis_access('c7700000-0000-4000-8000-000000000005'),
  'an expired extension (and an expired trial) opens nothing'
);

-- Réservation d'un checkout -------------------------------------------------------------------------
select is(
  public.reserve_analyse_checkout('c7700000-0000-4000-8000-000000000001', 'token-ext770-0000001'),
  true,
  'the extended account can reserve a checkout'
);
select is(
  (select plan_code || '/' || status from public.user_subscriptions
   where user_id = 'c7700000-0000-4000-8000-000000000001'),
  'analyse/trialing',
  'the reservation leaves the extension row as it was'
);
select is(
  public.reserve_analyse_checkout('c7700000-0000-4000-8000-000000000002', 'token-ext770-0000002'),
  false,
  'a Stripe subscription still blocks a second checkout'
);
select is(
  public.reserve_analyse_checkout('c7700000-0000-4000-8000-000000000003', 'token-ext770-0000003'),
  false,
  'an ordinary manual grant still blocks the checkout'
);
select is(
  public.reserve_analyse_checkout('c7700000-0000-4000-8000-000000000006', 'token-ext770-0000006'),
  true,
  'an account without a row can reserve a checkout'
);

select * from finish();
rollback;
