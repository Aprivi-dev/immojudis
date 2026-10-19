-- Offre de lancement : tant que app_private.launch_offer est active, tout compte connecté qui a un
-- profil a l'accès Analyse, sans aucune écriture dans user_profiles ni user_subscriptions ; la
-- couper rend l'état normal sans nettoyage ; anon n'y a jamais accès.
begin;

select plan(44);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c4800000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'launch-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4800000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'launch-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4800000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'launch-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4800000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'launch-noprofile@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c4800000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c4800000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

update public.user_profiles
set user_role = 'admin'
where user_id = 'c4800000-0000-4000-8000-000000000003';

-- Un compte dont le profil manque (jamais le cas après l'inscription) n'est pas surclassé.
delete from public.user_profiles where user_id = 'c4800000-0000-4000-8000-000000000004';

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values (
  'c4800000-1000-4000-8000-000000000001', 'launch-offer-test',
  'https://example.test/launch-offer/1', 'Launch offer title', 'upcoming', '2099-01-01 12:00:00Z'
);
insert into public.auction_documents (source_url, document_url, label, document_type)
values (
  'https://example.test/launch-offer/1', 'https://example.test/launch-offer/1/pv.pdf', 'PV', 'pv'
);

-- Structure and privileges ----------------------------------------------------------------------
select has_table('app_private', 'launch_offer', 'the launch offer has its own table');
select is((select count(*) from app_private.launch_offer), 1::bigint, 'the table holds a single row');
select is(
  (select active from app_private.launch_offer where singleton),
  true,
  'the offer is active once the migration is applied'
);
select throws_ok(
  $$insert into app_private.launch_offer (singleton, active) values (false, true)$$,
  '23514',
  null,
  'the table cannot hold a second row'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.launch_offer'::regclass),
  'row level security is enabled on the launch offer table'
);
select ok(
  not has_table_privilege('anon', 'app_private.launch_offer', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.launch_offer', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.launch_offer', 'UPDATE'),
  'no browser role reads or writes the launch offer table'
);
select ok(
  not has_function_privilege('anon', 'app_private.launch_offer_active()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.launch_offer_active()', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.launch_offer_active()', 'EXECUTE'),
  'launch_offer_active is closed to the browser roles'
);
select ok(
  not has_function_privilege('anon', 'public.get_launch_offer_status()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_launch_offer_status()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_launch_offer_status()', 'EXECUTE'),
  'the status RPC is for the server (service role) only'
);
select ok(
  not has_function_privilege('anon', 'public.set_launch_offer(boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_launch_offer(boolean)', 'EXECUTE'),
  'the switch is callable by a signed-in account, and refused to anon'
);
select ok(
  not has_function_privilege('anon', 'public.has_analysis_access()', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.current_user_has_premium_access()', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.has_active_analysis_access(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.has_active_analysis_access(uuid)', 'EXECUTE'),
  'the access functions stay closed to anon (and the per-user helper to every browser role)'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'app_private.launch_offer_active()'::regprocedure),
  true,
  'launch_offer_active is stable, security definer and has an empty search_path'
);
select is(
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'public.set_launch_offer(boolean)'::regprocedure),
  true,
  'set_launch_offer is security definer with an empty search_path'
);

-- Offer active: the database answers for the account -------------------------------------------
select is(app_private.launch_offer_active(), true, 'the offer reads as active');
select is(
  app_private.has_active_analysis_access('c4800000-0000-4000-8000-000000000001'),
  true,
  'active offer: a free account with a profile has the Analyse access (quotas, favourites, alerts)'
);
select is(
  app_private.has_active_analysis_access('c4800000-0000-4000-8000-000000000004'),
  false,
  'active offer: an account without a profile does not'
);
select is(
  app_private.has_active_analysis_access(null),
  false,
  'active offer: no user, no access'
);

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4800000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(public.has_analysis_access(), true, 'active offer: has_analysis_access() is true for a free account');
select is(
  (select count(*) from public.auction_documents where source_url like 'https://example.test/launch-offer/%'),
  1::bigint,
  'active offer: a free account reads the Analyse-only rows (row level security)'
);
select is(
  (public.get_sale_unlock_status() ->> 'analysis_access')::boolean,
  true,
  'active offer: nothing to unlock, the account already has every sale'
);
select is(
  (public.unlock_sale('c4800000-1000-4000-8000-000000000001') ->> 'consumed')::boolean,
  false,
  'active offer: opening a sale consumes no monthly unlock'
);

set local "request.jwt.claims" = '{"sub":"c4800000-0000-4000-8000-000000000004","role":"authenticated"}';
select is(public.has_analysis_access(), false, 'active offer: an account without a profile has no access');

-- Never for anon -------------------------------------------------------------------------------
set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok(
  $$select public.has_analysis_access()$$,
  '42501',
  null,
  'active offer: anon cannot even call has_analysis_access'
);
select ok(
  not has_table_privilege('anon', 'public.auction_documents', 'SELECT'),
  'active offer: anon has no read access to the Analyse-only rows at all'
);
select throws_ok(
  $$select public.set_launch_offer(false)$$,
  '42501',
  null,
  'anon cannot switch the offer'
);

reset role;
set local "request.jwt.claims" = '{"role":"anon"}';
select is(
  app_private.current_user_has_premium_access(),
  false,
  'active offer: without a signed-in user (no sub) the premium access is false'
);
set local "request.jwt.claims" = '';

-- The offer writes nothing on the accounts -----------------------------------------------------
select is(
  (select account_tier from public.user_profiles where user_id = 'c4800000-0000-4000-8000-000000000001'),
  'free',
  'the free account is still free in user_profiles'
);
select is(
  (select plan_code || '/' || status from public.user_subscriptions where user_id = 'c4800000-0000-4000-8000-000000000001'),
  'decouverte/active',
  'the free account still has its Découverte subscription row'
);
select is(
  (select count(*) from public.user_subscriptions
   where user_id in ('c4800000-0000-4000-8000-000000000001', 'c4800000-0000-4000-8000-000000000003')
     and plan_code = 'analyse'),
  0::bigint,
  'no subscription was created for the accounts that benefit from the offer'
);

-- The switch: administrators only, and it is the only gesture needed ----------------------------
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4800000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.set_launch_offer(false)$$,
  '42501',
  'Admin access required.',
  'a regular account cannot cut the offer'
);
reset role;
select is(app_private.launch_offer_active(), true, 'the refused call changed nothing');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4800000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$select public.set_launch_offer(null)$$,
  '22023',
  null,
  'the switch needs an explicit state'
);
select is(public.set_launch_offer(false), false, 'an administrator cuts the offer');
reset role;
select is(
  (select updated_by from app_private.launch_offer where singleton),
  'c4800000-0000-4000-8000-000000000003'::uuid,
  'the switch records who made the change'
);
select is(app_private.launch_offer_active(), false, 'the offer reads as cut');

-- Offer cut: back to the normal rules, with nothing to clean up --------------------------------
select is(
  app_private.has_active_analysis_access('c4800000-0000-4000-8000-000000000001'),
  false,
  'cut offer: the free account has no Analyse access any more (quotas, favourites, alerts)'
);
select is(
  app_private.has_active_analysis_access('c4800000-0000-4000-8000-000000000002'),
  true,
  'cut offer: a real Analyse subscriber keeps the access'
);

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4800000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.has_analysis_access(), false, 'cut offer: has_analysis_access() is false for a free account');
select is(
  (select count(*) from public.auction_documents where source_url like 'https://example.test/launch-offer/%'),
  0::bigint,
  'cut offer: the Analyse-only rows are closed again'
);
select is(
  (public.get_sale_unlock_status() ->> 'analysis_access')::boolean,
  false,
  'cut offer: the account is a Découverte account again, with its monthly unlocks'
);

set local "request.jwt.claims" = '{"sub":"c4800000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.has_analysis_access(), true, 'cut offer: an Analyse subscriber keeps the access');
set local "request.jwt.claims" = '{"sub":"c4800000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(public.has_analysis_access(), true, 'cut offer: an administrator keeps the access');

-- Switching it back on -------------------------------------------------------------------------
select is(public.set_launch_offer(true), true, 'an administrator restores the offer');
reset role;
select is(
  app_private.has_active_analysis_access('c4800000-0000-4000-8000-000000000001'),
  true,
  'restored offer: the free account has the access again, with no cleanup in between'
);
select is(
  (select account_tier from public.user_profiles where user_id = 'c4800000-0000-4000-8000-000000000001'),
  'free',
  'the account was never touched by the switch'
);

select * from finish();
rollback;
