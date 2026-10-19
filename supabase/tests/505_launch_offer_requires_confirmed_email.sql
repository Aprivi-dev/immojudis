-- Offre de lancement : les avantages Analyse exigent une adresse email confirmée
-- (auth.users.email_confirmed_at), en plus du profil. Un compte dont l'email n'est pas confirmé
-- n'est pas surclassé ; un compte premium, abonné ou administrateur n'est pas concerné ; confirmer
-- l'email ouvre l'accès sans aucune écriture sur les tables des comptes.
begin;

select plan(24);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5050000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'confirmed@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5050000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unconfirmed@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5050000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unconfirmed-premium@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5050000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unconfirmed-subscriber@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb);

update public.user_profiles
set account_tier = 'premium'
where user_id = 'c5050000-0000-4000-8000-000000000003';

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c5050000-0000-4000-8000-000000000004', 'analyse', 'active', now() + interval '30 days');

-- L'offre est active (état par défaut après 20261028120000), posée explicitement pour ce test.
update app_private.launch_offer set active = true where singleton;

-- Les profils existent bien pour tous : seul l'email distingue les comptes ----------------------
select is(
  (select count(*) from public.user_profiles where user_id::text like 'c5050000-0000-4000-8000-00000000000%'),
  4::bigint,
  'the sign-up trigger created a profile for every account, confirmed or not'
);

-- Structure et droits ----------------------------------------------------------------------------
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'app_private.launch_offer_account_eligible(uuid)'::regprocedure),
  true,
  'launch_offer_account_eligible is stable, security definer and has an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.launch_offer_account_eligible(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.launch_offer_account_eligible(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.launch_offer_account_eligible(uuid)', 'EXECUTE'),
  'launch_offer_account_eligible is closed to the browser roles'
);
select ok(
  not has_function_privilege('anon', 'app_private.has_active_analysis_access(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.has_active_analysis_access(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.current_user_has_premium_access()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.has_analysis_access()', 'EXECUTE'),
  'the access functions keep their privileges (closed to anon, per-user helper closed to browsers)'
);

-- Offre active : la base répond pour le compte --------------------------------------------------
select is(
  app_private.launch_offer_account_eligible('c5050000-0000-4000-8000-000000000001'),
  true,
  'a confirmed account with a profile is eligible'
);
select is(
  app_private.launch_offer_account_eligible('c5050000-0000-4000-8000-000000000002'),
  false,
  'an unconfirmed account is not'
);
select is(app_private.launch_offer_account_eligible(null), false, 'no user, not eligible');
select is(
  app_private.launch_offer_account_eligible('c5050000-0000-4000-8000-0000000000ff'),
  false,
  'an unknown user id is not eligible'
);
select is(
  app_private.has_active_analysis_access('c5050000-0000-4000-8000-000000000001'),
  true,
  'active offer: the confirmed account has the Analyse access (quotas, refreshes, alerts)'
);
select is(
  app_private.has_active_analysis_access('c5050000-0000-4000-8000-000000000002'),
  false,
  'active offer: the unconfirmed account has no Analyse access'
);

-- Les accès réels ne dépendent pas de la confirmation -------------------------------------------
select is(
  app_private.has_active_analysis_access('c5050000-0000-4000-8000-000000000003'),
  true,
  'a premium account keeps its access whether or not its email is confirmed'
);
select is(
  app_private.has_active_analysis_access('c5050000-0000-4000-8000-000000000004'),
  true,
  'an Analyse subscriber keeps its access whether or not its email is confirmed'
);

-- Côté connecté (RLS, déblocages) ----------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c5050000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.has_analysis_access(), true, 'a confirmed account: has_analysis_access() is true');
select is(
  (public.get_sale_unlock_status() ->> 'analysis_access')::boolean,
  true,
  'a confirmed account: nothing to unlock, the account already has every sale'
);

set local "request.jwt.claims" = '{"sub":"c5050000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.has_analysis_access(), false, 'an unconfirmed account: has_analysis_access() is false');
select is(
  (public.get_sale_unlock_status() ->> 'analysis_access')::boolean,
  false,
  'an unconfirmed account stays a Découverte account (monthly unlocks)'
);

set local "request.jwt.claims" = '{"sub":"c5050000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(public.has_analysis_access(), true, 'an unconfirmed premium account: has_analysis_access() is true');

-- Jamais pour anon -------------------------------------------------------------------------------
set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok(
  $$select public.has_analysis_access()$$,
  '42501',
  null,
  'anon cannot even call has_analysis_access'
);

-- Offre coupée : personne n'est surclassé, confirmé ou non ---------------------------------------
reset role;
set local "request.jwt.claims" = '';
update app_private.launch_offer set active = false where singleton;
select is(
  app_private.launch_offer_account_eligible('c5050000-0000-4000-8000-000000000001'),
  true,
  'cut offer: the helper only describes the account (profile, confirmed email), the switch is read apart'
);
select is(
  app_private.has_active_analysis_access('c5050000-0000-4000-8000-000000000001'),
  false,
  'cut offer: the confirmed free account has no Analyse access'
);

-- Confirmer l'email ouvre l'accès, sans écriture sur les comptes ------------------------------------
update app_private.launch_offer set active = true where singleton;
select is(
  app_private.has_active_analysis_access('c5050000-0000-4000-8000-000000000002'),
  false,
  'before confirmation: no access'
);
update auth.users set email_confirmed_at = now() where id = 'c5050000-0000-4000-8000-000000000002';
select is(
  app_private.has_active_analysis_access('c5050000-0000-4000-8000-000000000002'),
  true,
  'after confirmation: the access opens at the next read'
);
select is(
  (select account_tier from public.user_profiles where user_id = 'c5050000-0000-4000-8000-000000000002'),
  'free',
  'the account was never touched in user_profiles'
);
select is(
  (select count(*) from public.user_subscriptions where user_id = 'c5050000-0000-4000-8000-000000000002'),
  0::bigint,
  'no subscription was created for the account'
);

select * from finish();
rollback;
