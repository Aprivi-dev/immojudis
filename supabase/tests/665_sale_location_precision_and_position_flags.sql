-- Migration 20261101110000 : location_precision dans les trois vues de ventes, et drapeaux de position réels
-- (liste blanche) dans les deux vues « découverte ».
begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(32);

-- Normalisation de la précision ------------------------------------------------------------------
select is(app_private.sale_location_precision('{"geo_precision":"address"}'), 'address', 'address is kept');
select is(app_private.sale_location_precision('{"geo_precision":"parcel"}'), 'parcel', 'parcel is kept');
select is(app_private.sale_location_precision('{"geo_precision":"street"}'), 'street', 'street is kept');
select is(
  app_private.sale_location_precision('{"geo_precision":"municipality"}'),
  'municipality',
  'municipality is kept'
);
select is(
  app_private.sale_location_precision('{"geo_precision":"  Municipality "}'),
  'municipality',
  'case and surrounding spaces are normalised'
);
select is(
  app_private.sale_location_precision('{"geo_precision":"rooftop"}'),
  null::text,
  'an unknown value is not exposed'
);
select is(app_private.sale_location_precision('{"geo_precision":""}'), null::text, 'an empty value is null');
select is(app_private.sale_location_precision('{"geo_precision":5}'), null::text, 'a non-text value is null');
select is(app_private.sale_location_precision('{}'), null::text, 'a payload without precision is null');
select is(app_private.sale_location_precision(null), null::text, 'a null payload is null');
select is(app_private.sale_location_precision('["address"]'), null::text, 'a non-object payload is null');

-- Liste blanche des drapeaux --------------------------------------------------------------------
select is(
  app_private.public_position_quality_flags(
    '["multi_lot_sale","implausible_coordinates","source_page_only","geocode_outside_department",
      "unverified_source_coordinates","property_identity_conflict","missing_address","price_conflict"]'
  ),
  '["implausible_coordinates","geocode_outside_department","unverified_source_coordinates","missing_address"]'::jsonb,
  'only the position flags pass, in their original order'
);
select is(
  app_private.public_position_quality_flags('["multi_lot_sale","tribunal_deduced"]'),
  '[]'::jsonb,
  'no position flag gives an empty list'
);
select is(app_private.public_position_quality_flags(null), '[]'::jsonb, 'a null list gives an empty list');
select is(
  app_private.public_position_quality_flags('{"implausible_coordinates":true}'),
  '[]'::jsonb,
  'a non-array value gives an empty list'
);
select is(
  app_private.public_position_quality_flags('[1, null, "implausible_coordinates"]'),
  '["implausible_coordinates"]'::jsonb,
  'non-text elements are ignored'
);

-- Droits -----------------------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'app_private.sale_location_precision(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'app_private.public_position_quality_flags(jsonb)', 'execute')
  and has_function_privilege('service_role', 'app_private.sale_location_precision(jsonb)', 'execute')
  and has_function_privilege('service_role', 'app_private.public_position_quality_flags(jsonb)', 'execute')
  and not has_function_privilege('anon', 'app_private.sale_location_precision(jsonb)', 'execute')
  and not has_function_privilege('anon', 'app_private.public_position_quality_flags(jsonb)', 'execute'),
  'the helpers are executable by authenticated and service_role, never by anon'
);

-- Forme des vues ---------------------------------------------------------------------------------
select is(
  (select array_agg(view_name order by view_name)
     from (
       select table_name::text as view_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('v_auction_sales_app', 'v_auction_sales_discovery', 'v_auction_sales_unlocked')
          and column_name = 'location_precision'
          and data_type = 'text'
          and ordinal_position = (
            select max(other.ordinal_position)
              from information_schema.columns other
             where other.table_schema = 'public' and other.table_name = columns.table_name
          )
     ) last_columns),
  array['v_auction_sales_app', 'v_auction_sales_discovery', 'v_auction_sales_unlocked']::text[],
  'location_precision is the last column, of type text, in the three sale views'
);
select ok(
  (select pg_get_viewdef('public.v_auction_sales_discovery'::regclass) ~ 'public_position_quality_flags\(s\.quality_flags\) AS quality_flags')
  and (select pg_get_viewdef('public.v_auction_sales_unlocked'::regclass) ~ 'public_position_quality_flags\(s\.quality_flags\) AS quality_flags'),
  'the discovery and unlocked views project the whitelisted position flags'
);
select ok(
  not (select pg_get_viewdef('public.v_auction_sales_discovery'::regclass) ~ '''\[\]''::jsonb AS quality_flags')
  and not (select pg_get_viewdef('public.v_auction_sales_unlocked'::regclass) ~ '''\[\]''::jsonb AS quality_flags'),
  'neither view projects an empty quality_flags any more'
);
select ok(
  (select pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 's\.quality_flags,'),
  'the fiche view keeps projecting the full quality_flags'
);
select ok(
  (select reloptions @> array['security_invoker=false', 'security_barrier=true']
     from pg_class where oid = 'public.v_auction_sales_discovery'::regclass)
  and (select reloptions @> array['security_invoker=false', 'security_barrier=true']
     from pg_class where oid = 'public.v_auction_sales_unlocked'::regclass)
  and (select reloptions @> array['security_invoker=true']
     from pg_class where oid = 'public.v_auction_sales_app'::regclass),
  'the three views keep their security options'
);
select ok(
  has_table_privilege('authenticated', 'public.v_auction_sales_discovery', 'select')
  and has_table_privilege('authenticated', 'public.v_auction_sales_unlocked', 'select')
  and has_table_privilege('authenticated', 'public.v_auction_sales_app', 'select')
  and not has_table_privilege('anon', 'public.v_auction_sales_unlocked', 'select'),
  'the view grants are unchanged'
);
select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_text', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'content_hash', 'select'),
  'no column of auction_sales was opened by the migration'
);

-- Comportement -----------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c6650000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'precision-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c6650000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'precision-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c6650000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c6650000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, quality_flags, raw_payload
) values
  ('c6650000-1000-4000-8000-000000000001', 'position-test', 'https://example.test/position/1',
   'Position test 1', 'upcoming', '2099-01-01 12:00:00Z',
   '["multi_lot_sale","unverified_source_coordinates","price_conflict","geocode_outside_department"]',
   '{"geo_precision":"municipality"}'),
  ('c6650000-1000-4000-8000-000000000002', 'position-test', 'https://example.test/position/2',
   'Position test 2', 'upcoming', '2099-01-01 12:00:00Z',
   '[]', '{"geo_precision":"rooftop"}');

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c6650000-0000-4000-8000-000000000001';

select is(
  (select location_precision from public.v_auction_sales_discovery
    where id = 'c6650000-1000-4000-8000-000000000001'),
  'municipality',
  'a free account sees the location precision in the discovery view'
);
select is(
  (select location_precision from public.v_auction_sales_discovery
    where id = 'c6650000-1000-4000-8000-000000000002'),
  null::text,
  'an unrecognised precision is not exposed by the discovery view'
);
select is(
  (select quality_flags from public.v_auction_sales_discovery
    where id = 'c6650000-1000-4000-8000-000000000001'),
  '["unverified_source_coordinates","geocode_outside_department"]'::jsonb,
  'the discovery view shows the position flags and keeps the other flags private'
);

select is(
  (select (public.unlock_sale('c6650000-1000-4000-8000-000000000001') ->> 'unlocked')::boolean),
  true,
  'the free account unlocks the sale'
);
select is(
  (select location_precision from public.v_auction_sales_unlocked
    where id = 'c6650000-1000-4000-8000-000000000001'),
  'municipality',
  'the unlocked view shows the location precision'
);
select is(
  (select quality_flags from public.v_auction_sales_unlocked
    where id = 'c6650000-1000-4000-8000-000000000001'),
  '["unverified_source_coordinates","geocode_outside_department"]'::jsonb,
  'the unlocked view shows the position flags and keeps the other flags private'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c6650000-0000-4000-8000-000000000002';
select is(
  (select location_precision from public.v_auction_sales_app
    where id = 'c6650000-1000-4000-8000-000000000001'),
  'municipality',
  'the fiche view shows the location precision'
);
select is(
  (select quality_flags from public.v_auction_sales_app
    where id = 'c6650000-1000-4000-8000-000000000001'),
  '["multi_lot_sale","unverified_source_coordinates","price_conflict","geocode_outside_department"]'::jsonb,
  'the fiche view still shows every quality flag to an Analyse account'
);
reset role;

select * from finish();
rollback;
