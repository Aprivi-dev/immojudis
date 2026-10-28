-- 20261108202000 : minimum d'une annonce (voie ou lieu-dit, email de contact, pièce, autre source) et suppression
-- des annonces vides, sans jamais toucher à une vente qui a une trace utilisateur.
--   * la règle SQL suit celle du pipeline (services/data-pipeline/src/listing_minimum.py) : la commune seule, un nom
--     d'avocat seul, un téléphone seul ne suffisent pas ; une adresse que l'agent ne sollicite jamais non plus ;
--   * delete_empty_listings en comptage seul ne supprime rien ; appliquée, elle supprime une vente vide (à venir ou
--     passée) et garde celles qui ont un email, une voie, une pièce, une autre source ou un favori ;
--   * l'adresse qui EST une référence cadastrale, les trois formes de cadastre_location (candidates, Avoventes, Info-Enchères) et
--     les abréviations de voie du Python (Bvd, Boul, Esp...) sont gardées : le SQL garde au moins tout ce que garde le Python ;
--   * une vente avec un prix d'adjudication ou une issue connue n'est jamais supprimée ;
--   * une trace posée APRÈS le calcul initial (ici : un favori créé par le pont du graphe, au milieu de la boucle) fait garder
--     la vente ; une table qui référence auction_sales par deux clés est comptée en entier ;
--   * les fonctions sont fermées au navigateur.
begin;

select plan(48);

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

-- Référence cadastrale (le Python la garde par classify_address == 'parcel') --------------------------------------
select is(app_private.listing_is_cadastral_reference('Section AB n° 123 Autreville'), true, 'a section and a number is a cadastral reference');
select is(app_private.listing_is_cadastral_reference('AB 123'), true, 'a bare reference is a cadastral reference');
select is(app_private.listing_is_cadastral_reference('Cadastre AB 123 18150 Autreville'), true, 'a cadastre mention then a reference is a cadastral reference');
select is(app_private.listing_is_cadastral_reference('Autreville'), false, 'a commune is not a cadastral reference');
select is(app_private.listing_is_cadastral_reference('ab 123'), false, 'section letters are upper case, like the Python rule');
select is(app_private.listing_is_cadastral_reference(null), false, 'no text is no reference');

-- Abréviations que le Python ramène au mot entier avant de chercher le type de voie ---------------------------------
select is(app_private.listing_has_street_or_lieu_dit('12 Bvd Foch 75001 Paris', 'Paris'), true, 'Bvd is a street type');
select is(app_private.listing_has_street_or_lieu_dit('5 Esp. de la Paix 40440 Ondres', 'Ondres'), true, 'Esp is a street type');
select is(app_private.listing_has_street_or_lieu_dit('Crs Gambetta 33000 Bordeaux', 'Bordeaux'), true, 'Crs is a street type');

-- Formes de cadastre_location ------------------------------------------------------------------------------------
select is(app_private.listing_location_has_parcels('{"candidates":[{"parcels":["AC 272"]}]}'), true, 'candidates form (cessions, notaires, Petites Affiches)');
select is(app_private.listing_location_has_parcels('{"insee_code":"18001","parcels":[{"section":"AB","number":"123"}],"designation":"Parcelle AB 123"}'), true, 'Avoventes form');
select is(app_private.listing_location_has_parcels('{"references":["BY 69"],"designation":"Parcelle BY 69","raw":"cadastrée section BY 69"}'), true, 'Info-Enchères form');
select is(app_private.listing_location_has_parcels('{"candidates":[],"parcels":[],"references":[],"designation":"Ondres"}'), false, 'a location without parcel is not a location');

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

-- Parité avec le Python : tout ce qu'il garde, le SQL le garde.
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, address, city, raw_payload, adjudication_price_eur
) values
  ('c7930000-1000-4000-8000-000000000021', 'listing-793b', 'https://www.vench.fr/793b-21', 'Address is a section reference', 'upcoming',
   '2099-01-01 12:00:00Z', 'Section AB n° 123 Autreville', 'Autreville', '{}', null),
  ('c7930000-1000-4000-8000-000000000022', 'listing-793b', 'https://www.vench.fr/793b-22', 'Address is a bare reference', 'upcoming',
   '2099-01-01 12:00:00Z', 'AB 123', 'Autreville', '{}', null),
  ('c7930000-1000-4000-8000-000000000023', 'listing-793b', 'https://www.vench.fr/793b-23', 'Address is a cadastre mention', 'upcoming',
   '2099-01-01 12:00:00Z', 'Cadastre AB 123 18150 Autreville', 'Autreville', '{}', null),
  ('c7930000-1000-4000-8000-000000000024', 'listing-793b', 'https://www.vench.fr/793b-24', 'Lower case letters, no reference', 'upcoming',
   '2099-01-01 12:00:00Z', 'ab 123', 'Autreville', '{}', null),
  ('c7930000-1000-4000-8000-000000000031', 'listing-793b', 'https://www.avoventes.test/793b-31', 'Avoventes form in the features tree', 'upcoming',
   '2099-01-01 12:00:00Z', 'Autreville', 'Autreville',
   '{"source_property_features":{"cadastre_location":{"insee_code":"18001","parcels":[{"section":"AB","number":"123"}],"designation":"Parcelle AB 123"}}}', null),
  ('c7930000-1000-4000-8000-000000000032', 'listing-793b', 'https://www.info-encheres.test/793b-32', 'Info-Encheres form in the features tree', 'upcoming',
   '2099-01-01 12:00:00Z', 'Autreville', 'Autreville',
   '{"source_property_features":{"cadastre_location":{"references":["BY 69"],"designation":"Parcelle BY 69 à Autreville","raw":"cadastrée section BY 69"}}}', null),
  ('c7930000-1000-4000-8000-000000000033', 'listing-793b', 'https://www.avoventes.test/793b-33', 'Avoventes form at the root', 'upcoming',
   '2099-01-01 12:00:00Z', 'Autreville', 'Autreville',
   '{"cadastre_location":{"insee_code":"18001","parcels":[{"section":"AB","number":"123"}]}}', null),
  ('c7930000-1000-4000-8000-000000000034', 'listing-793b', 'https://www.avoventes.test/793b-34', 'Avoventes form without parcel', 'upcoming',
   '2099-01-01 12:00:00Z', 'Autreville', 'Autreville',
   '{"source_property_features":{"cadastre_location":{"parcels":[],"designation":"x"}}}', null),
  ('c7930000-1000-4000-8000-000000000035', 'listing-793b', 'https://www.info-encheres.test/793b-35', 'Info-Encheres form without reference', 'upcoming',
   '2099-01-01 12:00:00Z', 'Autreville', 'Autreville',
   '{"source_property_features":{"cadastre_location":{"references":[],"designation":"x"}}}', null),
  ('c7930000-1000-4000-8000-000000000036', 'listing-793b', 'https://www.vench.fr/793b-36', 'Block reference with a section and a number', 'upcoming',
   '2099-01-01 12:00:00Z', 'Autreville', 'Autreville',
   '{"source_blocks":{"reference_cadastrale":"Section AB n° 123"}}', null),
  ('c7930000-1000-4000-8000-000000000041', 'listing-793b', 'https://www.vench.fr/793b-41', 'Past, adjudication price known', 'past',
   '2000-01-01 12:00:00Z', '75006 PARIS', 'Paris', '{}', 120000),
  ('c7930000-1000-4000-8000-000000000042', 'listing-793b', 'https://www.vench.fr/793b-42', 'Past, outcome known in the graph', 'past',
   '2000-01-01 12:00:00Z', '75006 PARIS', 'Paris', '{}', null),
  ('c7930000-1000-4000-8000-000000000043', 'listing-793b', 'https://www.vench.fr/793b-43', 'Past, no result', 'past',
   '2000-01-01 12:00:00Z', '75006 PARIS', 'Paris', '{}', null),
  ('c7930000-1000-4000-8000-000000000051', 'listing-793b', 'https://www.vench.fr/793b-51', 'Empty, linked by the first key', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', '{}', null),
  ('c7930000-1000-4000-8000-000000000052', 'listing-793b', 'https://www.vench.fr/793b-52', 'Empty, linked by the second key', 'upcoming',
   '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris', '{}', null);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, address, city)
values
  ('c7930000-1000-4000-8000-000000000061', 'listing-793b', 'https://www.vench.fr/793b-61', 'Street abbreviation Bvd', 'upcoming',
   '2099-01-01 12:00:00Z', '12 Bvd Foch 75001 Paris', 'Paris'),
  ('c7930000-1000-4000-8000-000000000062', 'listing-793b', 'https://www.vench.fr/793b-62', 'Street abbreviation Esp', 'upcoming',
   '2099-01-01 12:00:00Z', '5 Esp. de la Paix 40440 Ondres', 'Ondres');

-- Une table qui référence auction_sales par DEUX clés étrangères (le compte par table ne doit pas être écrasé).
create table public.t793_two_links (
  user_id uuid,
  sale_a uuid references public.auction_sales(id) on delete cascade,
  sale_b uuid references public.auction_sales(id) on delete cascade
);
insert into public.t793_two_links (sale_a) values ('c7930000-1000-4000-8000-000000000051');
insert into public.t793_two_links (sale_b) values ('c7930000-1000-4000-8000-000000000052');

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

select is(
  (select array_agg(id order by id) from public.auction_sales s
    where s.source_name = 'listing-793b' and not app_private.sale_has_listing_minimum(s)),
  array[
    'c7930000-1000-4000-8000-000000000024', 'c7930000-1000-4000-8000-000000000034',
    'c7930000-1000-4000-8000-000000000035', 'c7930000-1000-4000-8000-000000000041',
    'c7930000-1000-4000-8000-000000000042', 'c7930000-1000-4000-8000-000000000043',
    'c7930000-1000-4000-8000-000000000051', 'c7930000-1000-4000-8000-000000000052'
  ]::uuid[],
  'a reference address, every cadastre_location form with a parcel and the street abbreviations are enough; lower case letters and empty parcel lists are not'
);

-- Suppression ------------------------------------------------------------------------------------------------------
select count(*) from public.bridge_auction_sales_to_outcome_graph();

-- Issue connue dans le graphe : l'issue « unknown » du pont est remplacée par une issue connue pour la vente 42.
insert into public.auction_outcomes (round_id, version, outcome_status, supersedes_outcome_id, valid_from)
select round_row.id, 2, 'held_no_bid', previous.id, previous.valid_from + interval '1 day'
  from public.auction_lots lot_row
  join public.auction_rounds round_row on round_row.lot_id = lot_row.id
  join public.auction_outcomes previous on previous.round_id = round_row.id and previous.version = 1
 where lot_row.auction_sale_id = 'c7930000-1000-4000-8000-000000000042';

select is(
  (select array_agg(id order by id) from public.auction_sales s
    where s.source_name = 'listing-793b' and app_private.sale_has_known_outcome(s)),
  array['c7930000-1000-4000-8000-000000000041', 'c7930000-1000-4000-8000-000000000042']::uuid[],
  'an adjudication price or a known outcome in the graph is a known outcome; the unknown outcome of the bridge is not'
);

-- Une trace posée APRÈS le calcul initial : le pont du graphe, créé au milieu de la boucle pour la vente 70, pose un favori.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, address, city)
values ('c7930000-1000-4000-8000-000000000070', 'listing-793b', 'https://www.vench.fr/793b-70', 'Favourite added mid-cleanup',
        'upcoming', '2099-01-01 12:00:00Z', '75006 PARIS', 'Paris');
create function public.t793_late_favourite() returns trigger language plpgsql as $$
begin
  if new.auction_sale_id = 'c7930000-1000-4000-8000-000000000070' then
    insert into public.user_favorites (user_id, sale_id)
    values ('c7930000-0000-4000-8000-000000000001', new.auction_sale_id);
  end if;
  return new;
end;
$$;
create trigger t793_late_favourite after insert on public.auction_sale_outcome_bridges
for each row execute function public.t793_late_favourite();

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
  (app_private.delete_empty_listings(5000, false) ->> 'kept_for_known_outcome')::integer,
  '>=', 2,
  'the count names the sales kept for an adjudication price or a known outcome'
);
select is(
  (app_private.delete_empty_listings(5000, false) -> 'kept_for_user_trace_by_table' ->> 't793_two_links')::integer,
  2,
  'a table that references auction_sales by two keys is counted for both (not overwritten)'
);

create temporary table t793_result as select app_private.delete_empty_listings(5000, true) as report;

select cmp_ok(
  (select (report ->> 'deleted')::integer from t793_result),
  '>=', 11,
  'the cleanup deletes the empty listings'
);
select cmp_ok(
  (select (report ->> 'kept_after_recheck')::integer from t793_result),
  '>=', 1,
  'a trace added after the initial computation makes the cleanup keep the sale'
);
select cmp_ok(
  (select (report -> 'kept_after_recheck_by_table' ->> 'user_favorites')::integer from t793_result),
  '>=', 1,
  'the recheck names the table that holds the late trace'
);
select is(
  (select array_agg(id order by id) from public.auction_sales where source_name = 'listing-793b'),
  array[
    'c7930000-1000-4000-8000-000000000021', 'c7930000-1000-4000-8000-000000000022',
    'c7930000-1000-4000-8000-000000000023', 'c7930000-1000-4000-8000-000000000031',
    'c7930000-1000-4000-8000-000000000032', 'c7930000-1000-4000-8000-000000000033',
    'c7930000-1000-4000-8000-000000000036', 'c7930000-1000-4000-8000-000000000041',
    'c7930000-1000-4000-8000-000000000042', 'c7930000-1000-4000-8000-000000000051',
    'c7930000-1000-4000-8000-000000000052', 'c7930000-1000-4000-8000-000000000061',
    'c7930000-1000-4000-8000-000000000062', 'c7930000-1000-4000-8000-000000000070'
  ]::uuid[],
  'only the empty past listing without result and the lower-case / empty-parcel listings are deleted; known outcomes, linked sales and the late favourite stay'
);
select is(
  (select count(*) from public.user_favorites where sale_id = 'c7930000-1000-4000-8000-000000000070'),
  1::bigint,
  'the favourite added during the cleanup is still there (not lost in a cascade)'
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
