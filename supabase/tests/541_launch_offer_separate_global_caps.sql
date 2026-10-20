-- Actualisations de données : les comptes de l'offre de lancement (accès Analyse sans abonnement,
-- compte premium ni rôle administrateur) ont une part de 100 demandes sur les 150 du plafond global
-- (20261029110100). Une demande refusée pour cette part répond DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT ;
-- les abonnés et les administrateurs gardent les 50 autres ; le plafond global passe avant ; les
-- demandes de plus de 24 heures sortent du compte. Même migration : has_standing_analysis_access.
begin;

select plan(21);

-- Fixtures -------------------------------------------------------------------------------------
-- 01 abonné Analyse ; 02 compte de l'offre (L1, n'a rien demandé) ; 03 compte de l'offre (L2, a déjà
-- consommé la part de l'offre) ; 04 abonné (S2, 49 demandes) ; 05 administrateur ; 06 premium
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5410000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-subscriber@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5410000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-launch-1@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5410000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-launch-2@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5410000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-subscriber-2@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5410000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5410000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-premium@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c5410000-0000-4000-8000-000000000001', 'analyse', 'active', now() + interval '30 days'),
  ('c5410000-0000-4000-8000-000000000004', 'analyse', 'active', now() + interval '30 days');
update public.user_profiles set user_role = 'admin'
where user_id = 'c5410000-0000-4000-8000-000000000005';
update public.user_profiles set account_tier = 'premium'
where user_id = 'c5410000-0000-4000-8000-000000000006';

-- L'offre est active : les comptes 02 et 03 ont l'accès Analyse, sans abonnement.
update app_private.launch_offer set active = true where singleton;

insert into public.auction_sales (id, source_name, source_url, title)
values (
  'c5410000-1000-4000-8000-000000000001',
  'refresh-cap-test', 'https://example.test/refresh-cap/sale-1', 'Refresh cap sale'
);

-- 100 demandes terminées dans les dernières 24 heures, créées par le compte de l'offre 03 : la part
-- de l'offre est consommée, le plafond global (150) ne l'est qu'aux deux tiers.
insert into public.data_refresh_requests (user_id, sale_id, source_url, request_kind, status)
select
  'c5410000-0000-4000-8000-000000000003',
  'c5410000-1000-4000-8000-000000000001',
  'https://example.test/refresh-cap/sale-1',
  'full',
  'completed'
from generate_series(1, 100);

-- Le droit durable ---------------------------------------------------------------------------------
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'app_private.has_standing_analysis_access(uuid)'::regprocedure),
  true,
  'has_standing_analysis_access is stable, security definer, with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.has_standing_analysis_access(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.has_standing_analysis_access(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.has_standing_analysis_access(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)', 'EXECUTE'),
  'the helper is closed to the browser roles and the admission function stays service-role only'
);
select is(
  app_private.has_standing_analysis_access('c5410000-0000-4000-8000-000000000001'),
  true,
  'an Analyse subscriber has the standing right'
);
select is(
  app_private.has_standing_analysis_access('c5410000-0000-4000-8000-000000000005'),
  true,
  'an administrator has it'
);
select is(
  app_private.has_standing_analysis_access('c5410000-0000-4000-8000-000000000006'),
  true,
  'a premium account has it'
);
select is(
  app_private.has_standing_analysis_access('c5410000-0000-4000-8000-000000000002'),
  false,
  'a launch-offer account does not, although it has_active_analysis_access while the offer lasts'
);
select is(
  app_private.has_active_analysis_access('c5410000-0000-4000-8000-000000000002'),
  true,
  'the launch-offer account does have the (temporary) Analyse access'
);
select is(app_private.has_standing_analysis_access(null), false, 'no user, no right');

-- La part de l'offre -------------------------------------------------------------------------------
select is(
  (select count(*) from public.data_refresh_requests
   where created_at >= statement_timestamp() - interval '24 hours'),
  100::bigint,
  'the fixtures hold 100 requests created in the last 24 hours, all by a launch-offer account'
);

set local role service_role;

select throws_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      'c5410000-0000-4000-8000-000000000002',
      'c5410000-1000-4000-8000-000000000001',
      'cadastre',
      false
    )$$,
  'P0001',
  'DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT',
  'the launch-offer share (100 per day) is spent: another launch-offer account is refused'
);

select is(
  (select reused from public.enqueue_data_refresh_bounded(
    'c5410000-0000-4000-8000-000000000001',
    'c5410000-1000-4000-8000-000000000001',
    'cadastre',
    false
  )),
  false,
  'a subscriber is still admitted: the launch offer did not use the reserve'
);

select is(
  (select reused from public.enqueue_data_refresh_bounded(
    'c5410000-0000-4000-8000-000000000005',
    'c5410000-1000-4000-8000-000000000001',
    'dpe',
    false
  )),
  false,
  'so is an administrator'
);

-- Le plafond global passe avant la part de l'offre ---------------------------------------------------
reset role;
insert into public.data_refresh_requests (user_id, sale_id, source_url, request_kind, status)
select
  'c5410000-0000-4000-8000-000000000004',
  'c5410000-1000-4000-8000-000000000001',
  'https://example.test/refresh-cap/sale-1',
  'full',
  'completed'
from generate_series(1, 48);
select is(
  (select count(*) from public.data_refresh_requests
   where created_at >= statement_timestamp() - interval '24 hours'),
  150::bigint,
  'the day now holds the 150 requests of the global cap (100 launch offer + 2 admitted + 48 subscriber)'
);
set local role service_role;

select throws_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      'c5410000-0000-4000-8000-000000000002',
      'c5410000-1000-4000-8000-000000000001',
      'dpe',
      false
    )$$,
  'P0001',
  'DATA_REFRESH_GLOBAL_DAILY_LIMIT',
  'at the global cap, a launch-offer account gets the global message'
);

select throws_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      'c5410000-0000-4000-8000-000000000006',
      'c5410000-1000-4000-8000-000000000001',
      'dpe',
      false
    )$$,
  'P0001',
  'DATA_REFRESH_GLOBAL_DAILY_LIMIT',
  'and so does a premium account: the global cap still binds everyone'
);

-- Les demandes de plus de 24 heures sortent du compte ---------------------------------------------------
reset role;
update public.data_refresh_requests
set created_at = statement_timestamp() - interval '25 hours'
where user_id = 'c5410000-0000-4000-8000-000000000003';
set local role service_role;

select is(
  (select reused from public.enqueue_data_refresh_bounded(
    'c5410000-0000-4000-8000-000000000002',
    'c5410000-1000-4000-8000-000000000001',
    'dpe',
    false
  )),
  false,
  'once the launch-offer requests are older than 24 hours, a launch-offer account is admitted again'
);

reset role;
select is(
  (select count(*) from public.data_refresh_requests request
   where request.created_at >= statement_timestamp() - interval '24 hours'
     and not app_private.has_standing_analysis_access(request.user_id)),
  1::bigint,
  'the launch-offer share now holds only the request just admitted: subscriber requests never count in it'
);
select is(
  (select count(*) from public.data_refresh_requests
   where user_id = 'c5410000-0000-4000-8000-000000000002'),
  1::bigint,
  'the refused calls created nothing: the launch-offer account has only the request admitted at the end'
);

-- Offre coupée : le compte de l'offre n'a plus d'accès, quelle que soit la part ------------------------
update app_private.launch_offer set active = false where singleton;
set local role service_role;
select throws_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      'c5410000-0000-4000-8000-000000000003',
      'c5410000-1000-4000-8000-000000000001',
      'cadastre',
      false
    )$$,
  '42501',
  'Analyse access is required.',
  'cut offer: a launch-offer account is refused before any cap'
);
reset role;
select is(
  app_private.has_standing_analysis_access('c5410000-0000-4000-8000-000000000004'),
  true,
  'cut offer: the subscriber keeps the standing right'
);
select is(
  app_private.has_standing_analysis_access('c5410000-0000-4000-8000-000000000002'),
  false,
  'cut offer: the launch-offer account never had it'
);

select * from finish();
rollback;
