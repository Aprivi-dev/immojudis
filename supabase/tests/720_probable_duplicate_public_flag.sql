-- Migration 20261102120000 : probable_duplicate rejoint la liste blanche des drapeaux visibles par les comptes
-- (app_private.public_position_quality_flags), donc les vues « découverte » et « débloquée ».
begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(16);

-- Liste blanche ----------------------------------------------------------------------------------
select is(
  app_private.public_position_quality_flags('["multi_lot_sale","probable_duplicate","price_conflict"]'),
  '["probable_duplicate"]'::jsonb,
  'probable_duplicate passes, the other flags stay private'
);
select is(
  app_private.public_position_quality_flags(
    '["probable_duplicate","multi_lot_sale","implausible_coordinates","source_page_only","geocode_outside_department",
      "unverified_source_coordinates","property_identity_conflict","missing_address","price_conflict"]'
  ),
  '["probable_duplicate","implausible_coordinates","geocode_outside_department","unverified_source_coordinates","missing_address"]'::jsonb,
  'the position flags and probable_duplicate pass, in their original order'
);
select is(
  app_private.public_position_quality_flags(
    '["multi_lot_sale","tribunal_deduced","property_identity_conflict","source_identity_mismatch","probable_duplicate_candidate"]'
  ),
  '[]'::jsonb,
  'no other flag passes, and a look-alike name does not match'
);
select is(
  app_private.public_position_quality_flags('["Probable_Duplicate"]'),
  '[]'::jsonb,
  'the match is exact: a different case is not the flag'
);
select is(app_private.public_position_quality_flags(null), '[]'::jsonb, 'a null list gives an empty list');
select is(
  app_private.public_position_quality_flags('{"probable_duplicate":true}'),
  '[]'::jsonb,
  'a non-array value gives an empty list'
);
select is(
  app_private.public_position_quality_flags('[1, null, "probable_duplicate", "probable_duplicate"]'),
  '["probable_duplicate","probable_duplicate"]'::jsonb,
  'non-text elements are ignored (the function does not deduplicate)'
);

-- Définition et droits inchangés -----------------------------------------------------------------
select ok(
  (select not prosecdef and provolatile = 'i' and proparallel = 's' and proconfig = array['search_path=""']
     from pg_proc
    where oid = 'app_private.public_position_quality_flags(jsonb)'::regprocedure),
  'the function is still security invoker, immutable, parallel safe, with an empty search_path'
);
select ok(
  has_function_privilege('authenticated', 'app_private.public_position_quality_flags(jsonb)', 'execute')
  and has_function_privilege('service_role', 'app_private.public_position_quality_flags(jsonb)', 'execute')
  and not has_function_privilege('anon', 'app_private.public_position_quality_flags(jsonb)', 'execute'),
  'the function is executable by authenticated and service_role, never by anon'
);
select ok(
  obj_description('app_private.public_position_quality_flags(jsonb)'::regprocedure, 'pg_proc') ~ 'probable_duplicate',
  'the function comment names the new flag'
);
select ok(
  (select pg_get_viewdef('public.v_auction_sales_discovery'::regclass) ~ 'public_position_quality_flags\(s\.quality_flags\) AS quality_flags')
  and (select pg_get_viewdef('public.v_auction_sales_unlocked'::regclass) ~ 'public_position_quality_flags\(s\.quality_flags\) AS quality_flags'),
  'the discovery and unlocked views still project the whitelisted flags'
);
select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_text', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'content_hash', 'select'),
  'no column of auction_sales was opened by the migration'
);

-- Comportement dans les vues ---------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'duplicate-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c7200000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'duplicate-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c7200000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c7200000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, quality_flags, raw_payload
) values
  ('c7200000-1000-4000-8000-000000000001', 'duplicate-test', 'https://example.test/duplicate/1',
   'Duplicate test 1', 'upcoming', '2099-01-01 12:00:00Z',
   '["multi_lot_sale","probable_duplicate","price_conflict"]',
   '{"geo_precision":"address"}');

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c7200000-0000-4000-8000-000000000001';

select is(
  (select quality_flags from public.v_auction_sales_discovery
    where id = 'c7200000-1000-4000-8000-000000000001'),
  '["probable_duplicate"]'::jsonb,
  'a free account sees probable_duplicate in the discovery view and nothing else'
);
select is(
  (select (public.unlock_sale('c7200000-1000-4000-8000-000000000001') ->> 'unlocked')::boolean),
  true,
  'the free account unlocks the sale'
);
select is(
  (select quality_flags from public.v_auction_sales_unlocked
    where id = 'c7200000-1000-4000-8000-000000000001'),
  '["probable_duplicate"]'::jsonb,
  'the unlocked view shows probable_duplicate and keeps the other flags private'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c7200000-0000-4000-8000-000000000002';
select is(
  (select quality_flags from public.v_auction_sales_app
    where id = 'c7200000-1000-4000-8000-000000000001'),
  '["multi_lot_sale","probable_duplicate","price_conflict"]'::jsonb,
  'the fiche view still shows every quality flag to an Analyse account'
);
reset role;

select * from finish();
rollback;
