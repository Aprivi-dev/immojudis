-- 20261112100000 (P8) : « Surface lue dans les pièces », saisie par le compte dans « Mon dossier ».
--   * une colonne de user_favorites, bornée (plus de 0 m², au plus 10 000 m²) ;
--   * modifiable par le propriétaire de la ligne seulement, colonne par colonne (ni user_id ni sale_id) ;
--   * jamais écrite dans le catalogue ; effacée avec le compte (cascade de auth.users) ;
--   * reportée sur la fiche conservée à la fusion de doublons, sans écraser une saisie existante.
begin;

select plan(14);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8730000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'surface-one@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c8730000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'surface-two@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- c1 (conservée) liste l'URL de s1 (supprimée) ; v1 est une vente sans rapport, sans surface publiée.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, source_urls)
values
  ('c8730000-1000-4000-8000-000000000001', 'surface-test', 'https://example.test/surface/c1',
   'Surface c1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/surface/c1", "https://example.test/surface/s1"]'::jsonb),
  ('c8730000-1000-4000-8000-000000000002', 'surface-test', 'https://example.test/surface/s1',
   'Surface s1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/surface/s1"]'::jsonb),
  ('c8730000-1000-4000-8000-000000000003', 'surface-test', 'https://example.test/surface/v1',
   'Surface v1', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb);

-- Structure ------------------------------------------------------------------------------------------------
select has_column('public', 'user_favorites', 'user_surface_m2', 'user_favorites stores the surface read in the documents');
select ok(
  has_column_privilege('authenticated', 'public.user_favorites', 'user_surface_m2', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_favorites', 'personal_status', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_favorites', 'bid_ceiling_eur', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_favorites', 'user_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_favorites', 'sale_id', 'UPDATE')
  and not has_table_privilege('anon', 'public.user_favorites', 'SELECT'),
  'a signed-in account can update the surface, the status and the ceiling only; visitors read nothing'
);

insert into public.user_favorites (id, user_id, sale_id) values
  ('c8730000-2000-4000-8000-000000000001', 'c8730000-0000-4000-8000-000000000001', 'c8730000-1000-4000-8000-000000000003'),
  ('c8730000-2000-4000-8000-000000000002', 'c8730000-0000-4000-8000-000000000002', 'c8730000-1000-4000-8000-000000000003');

-- Bornes ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.user_favorites set user_surface_m2 = 0 where id = 'c8730000-2000-4000-8000-000000000001'$$,
  '23514', null, 'a surface of 0 m² is refused'
);
select throws_ok(
  $$update public.user_favorites set user_surface_m2 = -12 where id = 'c8730000-2000-4000-8000-000000000001'$$,
  '23514', null, 'a negative surface is refused'
);
select throws_ok(
  $$update public.user_favorites set user_surface_m2 = 10000.01 where id = 'c8730000-2000-4000-8000-000000000001'$$,
  '23514', null, 'a surface above 10 000 m² is refused'
);
select lives_ok(
  $$update public.user_favorites set user_surface_m2 = 10000 where id = 'c8730000-2000-4000-8000-000000000001'$$,
  'a surface of exactly 10 000 m² is accepted'
);
update public.user_favorites set user_surface_m2 = null where id = 'c8730000-2000-4000-8000-000000000001';

-- RLS : le compte 1 écrit sur sa ligne, pas sur celle du compte 2 ------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c8730000-0000-4000-8000-000000000001';

select lives_ok(
  $$update public.user_favorites set user_surface_m2 = 54.5
     where sale_id = 'c8730000-1000-4000-8000-000000000003'$$,
  'an account saves the surface it read on a sale it follows'
);
select is(
  (select user_surface_m2 from public.user_favorites where sale_id = 'c8730000-1000-4000-8000-000000000003'),
  54.5::numeric,
  'the surface is stored on its own row'
);
select lives_ok(
  $$update public.user_favorites set user_surface_m2 = 99
     where user_id = 'c8730000-0000-4000-8000-000000000002'$$,
  'updating the row of another account is a no-op (row security hides it)'
);
reset role;
set local "request.jwt.claim.sub" = '';

select is(
  (select user_surface_m2 is null from public.user_favorites where id = 'c8730000-2000-4000-8000-000000000002'),
  true,
  'the row of the second account was not touched by the first'
);
select is(
  (select app_surface_m2 is null and habitable_surface_m2 is null and carrez_surface_m2 is null
     from public.auction_sales where id = 'c8730000-1000-4000-8000-000000000003'),
  true,
  'the catalogue is never written: the sale still publishes no surface'
);

-- Fusion de doublons ---------------------------------------------------------------------------------------
-- Compte 1 : favori sur s1 (surface 70) ET sur c1 (sans surface) : la surface passe à c1.
-- Compte 2 : favori sur s1 (surface 80) ET sur c1 (surface 60) : la surface de c1 n'est pas écrasée.
insert into public.user_favorites (id, user_id, sale_id, user_surface_m2) values
  ('c8730000-2000-4000-8000-000000000011', 'c8730000-0000-4000-8000-000000000001', 'c8730000-1000-4000-8000-000000000002', 70),
  ('c8730000-2000-4000-8000-000000000012', 'c8730000-0000-4000-8000-000000000001', 'c8730000-1000-4000-8000-000000000001', null),
  ('c8730000-2000-4000-8000-000000000013', 'c8730000-0000-4000-8000-000000000002', 'c8730000-1000-4000-8000-000000000002', 80),
  ('c8730000-2000-4000-8000-000000000014', 'c8730000-0000-4000-8000-000000000002', 'c8730000-1000-4000-8000-000000000001', 60);

select count(*) from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales where id = 'c8730000-1000-4000-8000-000000000002';

select is(
  (select user_surface_m2 from public.user_favorites
    where user_id = 'c8730000-0000-4000-8000-000000000001' and sale_id = 'c8730000-1000-4000-8000-000000000001'),
  70::numeric,
  'a duplicate favorite hands its surface over to the kept sale when it has none'
);
select is(
  (select user_surface_m2 from public.user_favorites
    where user_id = 'c8730000-0000-4000-8000-000000000002' and sale_id = 'c8730000-1000-4000-8000-000000000001'),
  60::numeric,
  'a surface already entered on the kept sale is not overwritten'
);

-- Effacement du compte -------------------------------------------------------------------------------------
delete from auth.users where id = 'c8730000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.user_favorites where user_id = 'c8730000-0000-4000-8000-000000000001'),
  0::bigint,
  'deleting the account erases its entered surfaces'
);

select * from finish();
rollback;
