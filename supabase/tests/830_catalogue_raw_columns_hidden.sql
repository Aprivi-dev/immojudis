-- Étape 2 de P4-01 (migration 20261110120000) : raw_payload, lawyer_contact et observations ne sont plus
-- lisibles par authenticated sur public.auction_sales ; v_auction_sales_app, devenue une vue definer gardée par
-- le prédicat de la politique de lecture, continue de servir les projections.
--   * un compte Analyse lit la fiche, la ligne d'avocat et les blocs de source par la vue ;
--   * le même compte ne peut plus sélectionner les trois colonnes sur la table (42501) ;
--   * un compte gratuit (offre de lancement coupée) ne voit aucune ligne par la vue ;
--   * anon n'a aucun droit sur la vue ;
--   * les droits sur les colonnes restantes (id, title, lawyer_name) sont conservés.
begin;

-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte connecté :
-- ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(13);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'raw-columns-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c8300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'raw-columns-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c8300000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c8300000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, lawyer_name, lawyer_contact, raw_payload, observations
) values (
  'c8300000-1000-4000-8000-000000000001', 'raw-columns-hidden-test',
  'https://example.test/raw-columns/1', 'Raw columns title', 'Raw columns address', 'ColonnesC830',
  '33', 'apartment', 100000, '2099-03-10 10:00:00Z'::timestamptz, 50, 'habitable', 2, 1, 1,
  'upcoming', 44.837812, -0.579234, 'tribunal', 'pending', 'Me Colonnes',
  'colonnes-830@example.test', '{"source_blocks": {"licitor": {"marker": 830}}}'::jsonb, '[]'::jsonb
);

-- Les droits ------------------------------------------------------------------------------------------

select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_payload', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'lawyer_contact', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'observations', 'select'),
  'authenticated cannot select raw_payload, lawyer_contact or observations'
);

select ok(
  has_column_privilege('authenticated', 'public.auction_sales', 'id', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'title', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'lawyer_name', 'select')
  and has_column_privilege('service_role', 'public.auction_sales', 'raw_payload', 'select'),
  'the other columns stay selectable and service_role still reads the raw ones'
);

select ok(
  not has_column_privilege('anon', 'public.auction_sales', 'raw_payload', 'select')
  and not has_table_privilege('anon', 'public.v_auction_sales_app', 'select')
  and has_table_privilege('authenticated', 'public.v_auction_sales_app', 'select'),
  'anon holds nothing on the raw columns or the catalogue view, authenticated keeps the view'
);

-- Un compte Analyse ------------------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c8300000-0000-4000-8000-000000000002';

select is(
  (select count(*)::integer from public.v_auction_sales_app where id = 'c8300000-1000-4000-8000-000000000001'),
  1,
  'an Analyse account reads the sale through the catalogue view'
);

select is(
  (select lawyer_contact from public.v_auction_sales_app where id = 'c8300000-1000-4000-8000-000000000001'),
  'colonnes-830@example.test',
  'the view still projects the lawyer line'
);

select is(
  (
    select source_blocks -> 'licitor' ->> 'marker'
    from public.v_auction_sales_app
    where id = 'c8300000-1000-4000-8000-000000000001'
  ),
  '830',
  'the view still projects the source blocks derived from raw_payload'
);

select is(
  (select count(*)::integer from public.auction_sales where id = 'c8300000-1000-4000-8000-000000000001'),
  1,
  'the table stays readable on its granted columns for an Analyse account'
);

select throws_ok(
  $$select raw_payload from public.auction_sales where id = 'c8300000-1000-4000-8000-000000000001'$$,
  '42501',
  null,
  'an Analyse account cannot select raw_payload on the table'
);

select throws_ok(
  $$select lawyer_contact, observations from public.auction_sales where id = 'c8300000-1000-4000-8000-000000000001'$$,
  '42501',
  null,
  'an Analyse account cannot select lawyer_contact or observations on the table'
);

select throws_ok(
  $$select * from public.auction_sales where id = 'c8300000-1000-4000-8000-000000000001'$$,
  '42501',
  null,
  'select * on the table is refused (the table-wide grant is gone)'
);

-- Un compte gratuit ------------------------------------------------------------------------------------

set local "request.jwt.claim.sub" = 'c8300000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.v_auction_sales_app where id = 'c8300000-1000-4000-8000-000000000001'),
  0,
  'a free account sees no row through the guarded catalogue view'
);

select is(
  (select count(*)::integer from public.auction_sales where id = 'c8300000-1000-4000-8000-000000000001'),
  0,
  'a free account sees no row on the table either (same rule)'
);

-- anon ---------------------------------------------------------------------------------------------------

reset role;
set local role anon;

select throws_ok(
  $$select id from public.v_auction_sales_app limit 1$$,
  '42501',
  null,
  'anon cannot read the catalogue view'
);

reset role;

select * from finish();
rollback;
