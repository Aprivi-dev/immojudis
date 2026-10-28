-- 20261108202000 : minimum d'une annonce (voie ou lieu-dit, email de contact, pièce, autre source) et suppression
-- des annonces vides, sans jamais toucher à une vente qui a une trace utilisateur.
--   * la règle SQL suit celle du pipeline (services/data-pipeline/src/listing_minimum.py) : la commune seule, un nom
--     d'avocat seul, un téléphone seul ne suffisent pas ; une adresse que l'agent ne sollicite jamais non plus ;
--   * delete_empty_listings en comptage seul ne supprime rien ; appliquée, elle supprime une vente vide (à venir ou
--     passée) et garde celles qui ont un email, une voie, une pièce, une autre source ou un favori ;
--   * les fonctions sont fermées au navigateur.
begin;

select plan(27);

-- Voie ou lieu-dit ---------------------------------------------------------------------------------------------
select is(app_private.listing_has_street_or_lieu_dit('12 rue des Lilas 33000 Bordeaux', 'Bordeaux'), true, 'a numbered street is a street');
select is(app_private.listing_has_street_or_lieu_dit('3 pl. du Marché 40440 Ondres', 'Ondres'), true, 'an abbreviated street type is a street');
select is(app_private.listing_has_street_or_lieu_dit('Lieu-dit Le Bourg, 40440 Ondres', 'Ondres'), true, 'a lieu-dit is accepted');
select is(app_private.listing_has_street_or_lieu_dit('Les Prés Exemple, 18150 Autreville', 'Autreville'), true, 'a named place before the commune is accepted');
select is(app_private.listing_has_street_or_lieu_dit('75006 PARIS', 'Paris'), false, 'a postal code and a commune are not a street');
select is(app_private.listing_has_street_or_lieu_dit('02400 CHÂTEAU-THIERRY', 'Château-Thierry'), false, 'a commune whose name holds a lieu-dit word is not a lieu-dit');
select is(app_private.listing_has_street_or_lieu_dit('69470 COURS', 'Cours'), false, 'a commune named like a street type is not a street');
select is(app_private.listing_has_street_or_lieu_dit(null, null), false, 'no address is no street');

-- Email de contact ------------------------------------------------------------------------------------------------
select is(app_private.listing_has_contact_email('05 00 00 00 15 · contact@cabinet-modele.example'), true, 'an email after a phone is an email');
select is(app_private.listing_has_contact_email('05 00 00 00 15'), false, 'a phone alone is not an email');
select is(app_private.listing_has_contact_email('[email protected]'), false, 'a masked address is not an email');
select is(app_private.listing_has_contact_email('contact@cabinet'), false, 'an address without a domain extension is not an email');
select is(app_private.listing_has_contact_email('greffe@tj-bordeaux.justice.fr'), false, 'a court address is never counted');
select is(app_private.listing_has_contact_email('cabinet@avocat-conseil.fr'), false, 'the RPVA mailbox is never counted');
select is(app_private.listing_has_contact_email('noreply@cabinet.example'), false, 'a technical address is never counted');

-- Annonces ---------------------------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  'c7930000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'listing793@example.test', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, address, city, lawyer_name, lawyer_contact, documents, source_urls
) values
  ('c7930000-1000-4000-8000-000000000001', 'listing-793', 'https://www.vench.fr/vente-793-1', 'Empty', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '["https://www.vench.fr/vente-793-1"]'),
  ('c7930000-1000-4000-8000-000000000002', 'listing-793', 'https://www.vench.fr/vente-793-2', 'Name and phone only', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', 'Maître Modèle', '05 00 00 00 15', null, '[]'),
  ('c7930000-1000-4000-8000-000000000003', 'listing-793', 'https://www.vench.fr/vente-793-3', 'With an email', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, '05 00 00 00 15 · contact@cabinet-modele.example', null, '[]'),
  ('c7930000-1000-4000-8000-000000000004', 'listing-793', 'https://www.vench.fr/vente-793-4', 'With a street', 'upcoming',
   '2099-01-01 12:00:00Z', '1 rue Haute 75006 PARIS', 'Paris', null, null, null, '[]'),
  ('c7930000-1000-4000-8000-000000000005', 'listing-793', 'https://www.vench.fr/vente-793-5', 'With a document', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, '[{"label":"Cahier","url":"https://example.test/c.pdf"}]', '[]'),
  ('c7930000-1000-4000-8000-000000000006', 'listing-793', 'https://www.vench.fr/vente-793-6', 'With another source', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null,
   '["https://www.vench.fr/vente-793-6","https://www.licitor.com/ventes/793-6.html"]'),
  ('c7930000-1000-4000-8000-000000000007', 'listing-793', 'https://www.vench.fr/vente-793-7', 'Empty with a favourite', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]'),
  ('c7930000-1000-4000-8000-000000000008', 'listing-793', 'https://www.vench.fr/vente-793-8', 'Empty and past', 'past',
   '2000-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null, '[]'),
  ('c7930000-1000-4000-8000-000000000009', 'listing-793', 'https://www.vench.fr/vente-793-9', 'Same source twice', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', null, null, null,
   '["https://www.vench.fr/vente-793-9","https://vench.fr/vente-793-9b"]');

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, address, city, raw_payload
) values
  ('c7930000-1000-4000-8000-00000000000a', 'listing-793', 'https://www.vench.fr/vente-793-10', 'Manager email block', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', '{"source_blocks":{"gestionnaire_email":"gestion@service-exemple.example"}}'),
  ('c7930000-1000-4000-8000-00000000000b', 'listing-793', 'https://www.vench.fr/vente-793-11', 'Email only in the page text', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', '{"source_blocks":{"page_text":"Ecrire a contact@site-exemple.example"}}'),
  ('c7930000-1000-4000-8000-00000000000c', 'listing-793', 'https://www.cessions.test/793-12', 'Cadastre location', 'upcoming',
   '2099-01-01 12:00:00Z', 'Paris', 'Paris', '{"cadastre_location":{"candidates":[{"parcels":["AC 272"]}]}}'),
  ('c7930000-1000-4000-8000-00000000000d', 'listing-793', 'https://www.cessions.test/793-13', 'Cadastral reference block', 'upcoming',
   '2099-01-01 12:00:00Z', 'Paris', 'Paris', '{"source_blocks":{"reference_cadastrale":"AC 272 et AC 829"}}'),
  ('c7930000-1000-4000-8000-00000000000e', 'listing-793', 'https://www.cessions.test/793-14', 'Reference block with a commune only', 'upcoming',
   '2099-01-01 12:00:00Z', 'Paris', 'Paris', '{"source_blocks":{"reference_cadastrale":"Paris"}}'),
  ('c7930000-1000-4000-8000-00000000000f', 'listing-793', 'https://www.cessions.test/793-15', 'Parcel found by reference', 'upcoming',
   '2099-01-01 12:00:00Z', 'Paris', 'Paris', '{}'),
  ('c7930000-1000-4000-8000-000000000010', 'listing-793', 'https://www.cessions.test/793-16', 'Parcel found under the commune centre', 'upcoming',
   '2099-01-01 12:00:00Z', 'Paris', 'Paris', '{}');

insert into public.auction_cadastre_parcels (source_url, parcel_key, match_kind)
values
  ('https://www.cessions.test/793-15', 'AC272', 'reference_lookup'),
  ('https://www.cessions.test/793-16', 'AC999', 'point_intersection');

insert into public.user_favorites (user_id, sale_id)
values ('c7930000-0000-4000-8000-000000000001', 'c7930000-1000-4000-8000-000000000007');

select is(
  (select array_agg(id order by id) from public.auction_sales s
    where s.source_name = 'listing-793' and not app_private.sale_has_listing_minimum(s)),
  array[
    'c7930000-1000-4000-8000-000000000001', 'c7930000-1000-4000-8000-000000000002',
    'c7930000-1000-4000-8000-000000000007', 'c7930000-1000-4000-8000-000000000008',
    'c7930000-1000-4000-8000-000000000009', 'c7930000-1000-4000-8000-00000000000b',
    'c7930000-1000-4000-8000-00000000000e', 'c7930000-1000-4000-8000-000000000010'
  ]::uuid[],
  'the rule also refuses an email found only in the page text, a commune given as a cadastral reference and a parcel found under the commune centre'
);
select is(
  (select array_agg(id order by id) from public.auction_sales s
    where s.source_name = 'listing-793' and app_private.sale_has_listing_minimum(s)),
  array[
    'c7930000-1000-4000-8000-000000000003', 'c7930000-1000-4000-8000-000000000004',
    'c7930000-1000-4000-8000-000000000005', 'c7930000-1000-4000-8000-000000000006',
    'c7930000-1000-4000-8000-00000000000a', 'c7930000-1000-4000-8000-00000000000c',
    'c7930000-1000-4000-8000-00000000000d', 'c7930000-1000-4000-8000-00000000000f'
  ]::uuid[],
  'an email, a street, a document, another source or a cadastral reference (location, block or parcel found by reference) is enough'
);

-- Suppression ------------------------------------------------------------------------------------------------------
select count(*) from public.bridge_auction_sales_to_outcome_graph();

select is(
  (app_private.delete_empty_listings(5000, false) ->> 'applied')::boolean,
  false,
  'the count-only mode says it applied nothing'
);
select is(
  (select count(*) from public.auction_sales where source_name = 'listing-793'),
  16::bigint,
  'the count-only mode deletes nothing'
);
select cmp_ok(
  (app_private.delete_empty_listings(5000, false) -> 'kept_for_user_trace_by_table' ->> 'user_favorites')::integer,
  '>=', 1,
  'the count names the table that holds a user trace'
);

select cmp_ok(
  (app_private.delete_empty_listings(5000, true) ->> 'deleted')::integer,
  '>=', 7,
  'the cleanup deletes the empty listings'
);

select is(
  (select array_agg(id order by id) from public.auction_sales where source_name = 'listing-793'),
  array[
    'c7930000-1000-4000-8000-000000000003', 'c7930000-1000-4000-8000-000000000004',
    'c7930000-1000-4000-8000-000000000005', 'c7930000-1000-4000-8000-000000000006',
    'c7930000-1000-4000-8000-000000000007', 'c7930000-1000-4000-8000-00000000000a',
    'c7930000-1000-4000-8000-00000000000c', 'c7930000-1000-4000-8000-00000000000d',
    'c7930000-1000-4000-8000-00000000000f'
  ]::uuid[],
  'empty upcoming and past listings are gone; the email, street, document, other-source and favourite ones stay'
);
select is(
  (select count(*) from public.user_favorites where sale_id = 'c7930000-1000-4000-8000-000000000007'),
  1::bigint,
  'the favourite is still there'
);
select is(
  (app_private.delete_empty_listings(5000, true) ->> 'deleted')::integer,
  0,
  'a second pass has nothing more to delete (idempotent)'
);

-- Droits ----------------------------------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'app_private.delete_empty_listings(integer, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.delete_empty_listings(integer, boolean)', 'execute')
  and has_function_privilege('service_role', 'app_private.delete_empty_listings(integer, boolean)', 'execute'),
  'the cleanup is closed to the browser roles'
);
select ok(
  not has_function_privilege('anon', 'app_private.sale_has_listing_minimum(public.auction_sales)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.sale_has_listing_minimum(public.auction_sales)', 'execute'),
  'the rule on a sale row is closed to the browser roles'
);
select throws_ok(
  $$select app_private.delete_empty_listings(0, false)$$,
  '22023',
  'The cleanup limit must be between 1 and 5000.',
  'a cleanup needs a sensible limit'
);

select * from finish();
rollback;
