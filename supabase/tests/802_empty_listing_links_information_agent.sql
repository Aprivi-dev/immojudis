-- 20261109120000 : un contact de l'agent d'information ne protège plus une annonce vide (il reste, détaché) ;
-- un favori la protège toujours.
begin;

select plan(5);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values (
  'c8020000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'listing802@example.test', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, address, city, lawyer_name, lawyer_contact, documents, source_urls
) values
  ('c8020000-1000-4000-8000-000000000001', 'listing-802', 'https://www.vench.fr/vente-802-1', 'Empty, agent contact',
   'upcoming', '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]'),
  ('c8020000-1000-4000-8000-000000000002', 'listing-802', 'https://www.vench.fr/vente-802-2', 'Empty, agent contact and favourite',
   'upcoming', '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]');

insert into public.information_agent_contacts (sale_id, scope_sale_id, email) values
  ('c8020000-1000-4000-8000-000000000001', 'c8020000-1000-4000-8000-000000000001', 'contact-802-1@example.test'),
  ('c8020000-1000-4000-8000-000000000002', 'c8020000-1000-4000-8000-000000000002', 'contact-802-2@example.test');
insert into public.user_favorites (user_id, sale_id)
values ('c8020000-0000-4000-8000-000000000001', 'c8020000-1000-4000-8000-000000000002');

select is(
  (select count(*) from app_private.empty_listing_links(array['c8020000-1000-4000-8000-000000000001']::uuid[])),
  0::bigint,
  'an information-agent contact is not a user trace'
);
select is(
  (select relation_name from app_private.empty_listing_links(array['c8020000-1000-4000-8000-000000000002']::uuid[])),
  'user_favorites',
  'a favourite still protects the listing, by its own table only'
);

create temporary table t802_result as select app_private.delete_empty_listings(5000, true) as report;

select is(
  (select count(*) from public.auction_sales where id = 'c8020000-1000-4000-8000-000000000001'),
  0::bigint,
  'the empty listing with only an agent contact is deleted'
);
select is(
  (select sale_id from public.information_agent_contacts where email = 'contact-802-1@example.test'),
  null::uuid,
  'the contact stays, detached from the deleted sale (its scope is kept)'
);
select is(
  (select count(*) from public.auction_sales where id = 'c8020000-1000-4000-8000-000000000002'),
  1::bigint,
  'the empty favourite is kept'
);

select * from finish();
rollback;
