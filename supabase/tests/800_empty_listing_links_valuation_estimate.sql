-- 20261108204200 : une estimation automatique (valuation_estimates, user_id vide) ne protège pas une annonce vide ;
-- un événement de compte (account_product_events, avec un utilisateur) la protège toujours.
begin;

select plan(5);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values (
  'c8000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'listing800@example.test', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, address, city, lawyer_name, lawyer_contact, documents, source_urls
) values
  ('c8000000-1000-4000-8000-000000000001', 'listing-800', 'https://www.vench.fr/vente-800-1', 'Empty with an estimate',
   'upcoming', '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]'),
  ('c8000000-1000-4000-8000-000000000002', 'listing-800', 'https://www.vench.fr/vente-800-2', 'Empty with an account event',
   'upcoming', '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]');

insert into public.valuation_estimates (auction_sale_id, engine_version, engine_kind, segment)
values ('c8000000-1000-4000-8000-000000000001', 'test', 'comparable_ensemble', 'house');

select is(
  (select count(*) from app_private.empty_listing_links(array['c8000000-1000-4000-8000-000000000001']::uuid[])),
  0::bigint,
  'an automatic estimate is neither a user trace nor a blocking link'
);

insert into public.account_product_events (user_id, event_type, detail, sale_id)
values ('c8000000-0000-4000-8000-000000000001', 'sale_unlocked', null, 'c8000000-1000-4000-8000-000000000002');

select is(
  (select link_kind from app_private.empty_listing_links(array['c8000000-1000-4000-8000-000000000002']::uuid[])),
  'user_trace',
  'an account event still protects the listing'
);

-- La suppression ne touche qu'aux ventes de ce test : les autres ventes de la base de test ne sont pas vides.
create temporary table t800_result as select app_private.delete_empty_listings(5000, true) as report;

select is(
  (select count(*) from public.auction_sales where id = 'c8000000-1000-4000-8000-000000000001'),
  0::bigint,
  'the empty listing with only an automatic estimate is deleted'
);
select is(
  (select count(*) from public.valuation_estimates where auction_sale_id = 'c8000000-1000-4000-8000-000000000001'),
  0::bigint,
  'its estimate goes with it (removed first, as the retention does)'
);

select is(
  (select count(*) from public.auction_sales where id = 'c8000000-1000-4000-8000-000000000002'),
  1::bigint,
  'the empty listing with an account event is kept'
);

select * from finish();
rollback;
