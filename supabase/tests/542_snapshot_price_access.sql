-- Instantanés d'une vente suivie : le prix d'adjudication ne suit que le droit durable (20261029110200).
-- app_private.snapshot_price_access(user_id) est vrai pour un abonné Analyse, un compte premium et un
-- administrateur, jamais pour un compte qui n'a que l'offre de lancement, même pendant qu'elle dure.
-- (Le déclencheur snapshot_followed_sale_before_delete doit l'appeler à la place de
-- has_active_analysis_access : voir l'en-tête de la migration.)
begin;

select plan(12);

-- Fixtures -------------------------------------------------------------------------------------
-- 01 abonné Analyse ; 02 compte de l'offre (confirmé) ; 03 compte de l'offre non confirmé ;
-- 04 administrateur ; 05 premium ; 06 abonné dont l'abonnement est expiré
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5420000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'price-subscriber@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5420000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'price-launch@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5420000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'price-unconfirmed@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5420000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'price-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5420000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'price-premium@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5420000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'price-expired@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c5420000-0000-4000-8000-000000000001', 'analyse', 'active', now() + interval '30 days'),
  ('c5420000-0000-4000-8000-000000000006', 'analyse', 'active', now() - interval '10 days');
update public.user_profiles set user_role = 'admin'
where user_id = 'c5420000-0000-4000-8000-000000000004';
update public.user_profiles set account_tier = 'premium'
where user_id = 'c5420000-0000-4000-8000-000000000005';

-- L'offre est active : le compte 02 a l'accès Analyse de l'offre.
update app_private.launch_offer set active = true where singleton;

-- Structure et droits ----------------------------------------------------------------------------
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'app_private.snapshot_price_access(uuid)'::regprocedure),
  true,
  'snapshot_price_access is stable, security definer, with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.snapshot_price_access(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.snapshot_price_access(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.snapshot_price_access(uuid)', 'EXECUTE'),
  'snapshot_price_access is closed to the browser roles'
);

-- Le droit durable donne le prix ----------------------------------------------------------------------
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000001'),
  true,
  'an Analyse subscriber gets the adjudication price in the snapshot'
);
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000004'),
  true,
  'an administrator does'
);
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000005'),
  true,
  'a premium account does'
);

-- L'offre de lancement ne le donne pas ---------------------------------------------------------------
select is(
  app_private.has_active_analysis_access('c5420000-0000-4000-8000-000000000002'),
  true,
  'while the offer lasts, the launch-offer account has the Analyse access (the old trigger condition)'
);
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000002'),
  false,
  'but its snapshot does not copy the adjudication price'
);
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000003'),
  false,
  'an unconfirmed account does not either'
);
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000006'),
  false,
  'an expired subscription does not'
);
select is(app_private.snapshot_price_access(null), false, 'no user, no price');

-- Offre coupée ---------------------------------------------------------------------------------------
update app_private.launch_offer set active = false where singleton;
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000001'),
  true,
  'cut offer: the subscriber still gets the price'
);
select is(
  app_private.snapshot_price_access('c5420000-0000-4000-8000-000000000002'),
  false,
  'cut offer: the launch-offer account still does not'
);

select * from finish();
rollback;
