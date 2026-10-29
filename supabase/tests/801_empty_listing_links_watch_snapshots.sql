-- 20261108204300 : un cliché de surveillance né d'une correspondance d'alerte ne protège pas une annonce vide
-- (comme user_alert_matches) ; un favori la protège toujours, par sa propre table.
begin;

select plan(4);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values (
  'c8010000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'listing801@example.test', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, address, city, lawyer_name, lawyer_contact, documents, source_urls
) values
  ('c8010000-1000-4000-8000-000000000001', 'listing-801', 'https://www.vench.fr/vente-801-1', 'Empty, watched by an alert',
   'upcoming', '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]'),
  ('c8010000-1000-4000-8000-000000000002', 'listing-801', 'https://www.vench.fr/vente-801-2', 'Empty, favourite',
   'upcoming', '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]');

insert into public.user_sale_watch_snapshots (user_id, sale_id, watch_kind, watch_id, fingerprint) values
  ('c8010000-0000-4000-8000-000000000001', 'c8010000-1000-4000-8000-000000000001', 'alert_match',
   'c8010000-2000-4000-8000-000000000001', 'fp-801-1'),
  ('c8010000-0000-4000-8000-000000000001', 'c8010000-1000-4000-8000-000000000002', 'favorite',
   'c8010000-2000-4000-8000-000000000002', 'fp-801-2');
insert into public.user_favorites (user_id, sale_id)
values ('c8010000-0000-4000-8000-000000000001', 'c8010000-1000-4000-8000-000000000002');

select is(
  (select count(*) from app_private.empty_listing_links(array['c8010000-1000-4000-8000-000000000001']::uuid[])),
  0::bigint,
  'a watch snapshot born of an alert match is not a user trace'
);
select is(
  (select relation_name from app_private.empty_listing_links(array['c8010000-1000-4000-8000-000000000002']::uuid[])),
  'user_favorites',
  'a favourite still protects the listing, by its own table only'
);

create temporary table t801_result as select app_private.delete_empty_listings(5000, true) as report;

select is(
  (select count(*) from public.auction_sales where id = 'c8010000-1000-4000-8000-000000000001'),
  0::bigint,
  'the empty listing watched only by an alert is deleted, its snapshot with it'
);
select is(
  (select count(*) from public.auction_sales where id = 'c8010000-1000-4000-8000-000000000002'),
  1::bigint,
  'the empty favourite is kept'
);

select * from finish();
rollback;
