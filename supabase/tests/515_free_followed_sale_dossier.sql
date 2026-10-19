-- « Mon dossier » gratuit (20261028190000) : un compte, même Découverte, enregistre sur une vente qu'il
-- suit un statut personnel et son enchère plafond. RLS stricte (propriétaire seul, deux colonnes
-- modifiables), dates posées par la base, report à la fusion de doublons.
begin;

select plan(31);

-- Fixtures -------------------------------------------------------------------------------------
-- Compte 1 : adresse non confirmée (donc pas d'offre de lancement) = compte Découverte.
-- Compte 2 : un autre compte Découverte. Compte 3 : sans favori.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5150000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dossier-one@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5150000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dossier-two@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5150000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dossier-three@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- c1 (conservée) liste l'URL de s1 (supprimée) ; v1 est une vente sans rapport.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, source_urls)
values
  ('c5150000-1000-4000-8000-000000000001', 'dossier-test', 'https://example.test/dossier/c1',
   'Dossier c1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/dossier/c1", "https://example.test/dossier/s1"]'::jsonb),
  ('c5150000-1000-4000-8000-000000000002', 'dossier-test', 'https://example.test/dossier/s1',
   'Dossier s1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/dossier/s1"]'::jsonb),
  ('c5150000-1000-4000-8000-000000000003', 'dossier-test', 'https://example.test/dossier/v1',
   'Dossier v1', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb);

-- Structure -------------------------------------------------------------------------------------
select has_column('public', 'user_favorites', 'personal_status', 'user_favorites stores a personal status');
select has_column('public', 'user_favorites', 'bid_ceiling_eur', 'user_favorites stores the saved bid ceiling');
select ok(
  has_column_privilege('authenticated', 'public.user_favorites', 'personal_status', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_favorites', 'bid_ceiling_eur', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_favorites', 'user_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_favorites', 'sale_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_favorites', 'bid_ceiling_saved_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_favorites', 'personal_status_updated_at', 'UPDATE')
  and not has_table_privilege('anon', 'public.user_favorites', 'SELECT'),
  'a signed-in account can update the two dossier columns only; visitors read nothing'
);
select has_trigger('public', 'user_favorites', 'touch_favorite_dossier', 'the dates of the dossier are set by a trigger');
select has_trigger('public', 'auction_sales', 'auction_sales_carry_favorite_dossier', 'the merge trigger of the dossier exists');
select ok(
  not has_function_privilege('anon', 'app_private.carry_favorite_dossier_to_merged_sale()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.carry_favorite_dossier_to_merged_sale()', 'EXECUTE'),
  'the merge trigger function is not callable by browser roles'
);

-- Données de départ (créées avec le rôle propriétaire) ------------------------------------------
insert into public.user_favorites (id, user_id, sale_id) values
  ('c5150000-2000-4000-8000-000000000001', 'c5150000-0000-4000-8000-000000000001', 'c5150000-1000-4000-8000-000000000003'),
  ('c5150000-2000-4000-8000-000000000002', 'c5150000-0000-4000-8000-000000000002', 'c5150000-1000-4000-8000-000000000003');
select is(
  (select personal_status is null and bid_ceiling_eur is null
      and personal_status_updated_at is null and bid_ceiling_saved_at is null
     from public.user_favorites where id = 'c5150000-2000-4000-8000-000000000001'),
  true,
  'a new favorite has no status and no ceiling: absent stays absent'
);

-- Contraintes ------------------------------------------------------------------------------------
select throws_ok(
  $$update public.user_favorites set personal_status = 'bogus' where id = 'c5150000-2000-4000-8000-000000000001'$$,
  '23514', null, 'an unknown status is refused'
);
select throws_ok(
  $$update public.user_favorites set bid_ceiling_eur = -1 where id = 'c5150000-2000-4000-8000-000000000001'$$,
  '23514', null, 'a negative ceiling is refused'
);
select throws_ok(
  $$update public.user_favorites set bid_ceiling_eur = 10000000001 where id = 'c5150000-2000-4000-8000-000000000001'$$,
  '23514', null, 'a ceiling above the simulator bound is refused'
);

-- RLS : le compte 1 écrit sur sa ligne ----------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c5150000-0000-4000-8000-000000000001';

select lives_ok(
  $$update public.user_favorites
       set personal_status = 'reviewing', bid_ceiling_eur = 185000
     where sale_id = 'c5150000-1000-4000-8000-000000000003'$$,
  'a free account saves a status and a ceiling on a sale it follows'
);
select is(
  (select personal_status || ' ' || bid_ceiling_eur::text from public.user_favorites
    where sale_id = 'c5150000-1000-4000-8000-000000000003'),
  'reviewing 185000',
  'the values are stored on its own row'
);
select is(
  (select personal_status_updated_at is not null and bid_ceiling_saved_at is not null
     from public.user_favorites where sale_id = 'c5150000-1000-4000-8000-000000000003'),
  true,
  'the database sets the two dates'
);
select throws_ok(
  $$update public.user_favorites set bid_ceiling_saved_at = '2000-01-01' where sale_id = 'c5150000-1000-4000-8000-000000000003'$$,
  '42501', null, 'the client cannot write the date of the ceiling'
);
select throws_ok(
  $$update public.user_favorites set sale_id = 'c5150000-1000-4000-8000-000000000001'
     where sale_id = 'c5150000-1000-4000-8000-000000000003'$$,
  '42501', null, 'the client cannot move a favorite to another sale'
);
select throws_ok(
  $$update public.user_favorites set user_id = 'c5150000-0000-4000-8000-000000000002'
     where sale_id = 'c5150000-1000-4000-8000-000000000003'$$,
  '42501', null, 'the client cannot hand a favorite to another account'
);

-- Le compte 1 ne voit ni ne modifie la ligne du compte 2.
select is(
  (select count(*) from public.user_favorites where user_id = 'c5150000-0000-4000-8000-000000000002'),
  0::bigint,
  'an account does not see the favorites of another account'
);
select lives_ok(
  $$update public.user_favorites set personal_status = 'lost', bid_ceiling_eur = 1
     where user_id = 'c5150000-0000-4000-8000-000000000002'$$,
  'updating the row of another account is accepted as a no-op (row security hides it)'
);

-- Le compte 3 (sans favori) n'a rien à voir ni à modifier.
set local "request.jwt.claim.sub" = 'c5150000-0000-4000-8000-000000000003';
select is(
  (select count(*) from public.user_favorites),
  0::bigint,
  'a third account sees no favorite'
);
reset role;
set local "request.jwt.claim.sub" = '';

select is(
  (select personal_status || ' ' || bid_ceiling_eur::text from public.user_favorites
    where id = 'c5150000-2000-4000-8000-000000000001'),
  'reviewing 185000',
  'the row of the first account is unchanged by the others'
);
select is(
  (select personal_status is null and bid_ceiling_eur is null from public.user_favorites
    where id = 'c5150000-2000-4000-8000-000000000002'),
  true,
  'the row of the second account was not touched by the first'
);

-- Visiteur : aucune lecture.
set local role anon;
select throws_ok(
  $$select count(*) from public.user_favorites$$,
  '42501', null, 'a visitor cannot read favorites'
);
reset role;

-- Dates : posées au changement, conservées sans changement, effacées avec la valeur.
update public.user_favorites
   set personal_status_updated_at = '2000-01-01', bid_ceiling_saved_at = '2000-01-01'
 where id = 'c5150000-2000-4000-8000-000000000001';
select is(
  (select personal_status_updated_at > '2020-01-01' and bid_ceiling_saved_at > '2020-01-01'
     from public.user_favorites where id = 'c5150000-2000-4000-8000-000000000001'),
  true,
  'even the table owner cannot rewrite the dates by hand: the trigger keeps the old ones'
);
update public.user_favorites set bid_ceiling_eur = null
 where id = 'c5150000-2000-4000-8000-000000000001';
select is(
  (select bid_ceiling_saved_at is null and personal_status = 'reviewing' and personal_status_updated_at is not null
     from public.user_favorites where id = 'c5150000-2000-4000-8000-000000000001'),
  true,
  'removing the ceiling removes its date and leaves the status alone'
);

-- Fusion de doublons -----------------------------------------------------------------------------
-- Compte 1 : favori sur s1 (statut + plafond) ET sur c1 (sans rien) : le doublon disparaît, ses valeurs passent à c1.
-- Compte 2 : favori sur s1 seulement (statut + plafond) : la ligne est déplacée sur c1 avec ses valeurs.
-- Compte 3 : favori sur s1 ET sur c1, chacun avec ses valeurs : la ligne conservée n'est pas écrasée.
insert into public.user_favorites (id, user_id, sale_id, personal_status, bid_ceiling_eur) values
  ('c5150000-2000-4000-8000-000000000011', 'c5150000-0000-4000-8000-000000000001', 'c5150000-1000-4000-8000-000000000002', 'bidding', 120000),
  ('c5150000-2000-4000-8000-000000000012', 'c5150000-0000-4000-8000-000000000001', 'c5150000-1000-4000-8000-000000000001', null, null),
  ('c5150000-2000-4000-8000-000000000013', 'c5150000-0000-4000-8000-000000000002', 'c5150000-1000-4000-8000-000000000002', 'won', 99000),
  ('c5150000-2000-4000-8000-000000000014', 'c5150000-0000-4000-8000-000000000003', 'c5150000-1000-4000-8000-000000000002', 'lost', 50000),
  ('c5150000-2000-4000-8000-000000000015', 'c5150000-0000-4000-8000-000000000003', 'c5150000-1000-4000-8000-000000000001', 'archived', 60000);

select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales where id = 'c5150000-1000-4000-8000-000000000002'$$,
  'the secondary sale is deleted (merge) without error'
);

select is(
  (select personal_status || ' ' || bid_ceiling_eur::text from public.user_favorites
    where user_id = 'c5150000-0000-4000-8000-000000000001' and sale_id = 'c5150000-1000-4000-8000-000000000001'),
  'bidding 120000',
  'a duplicate favorite without values on the kept sale hands over its status and ceiling'
);
select is(
  (select personal_status || ' ' || bid_ceiling_eur::text from public.user_favorites
    where user_id = 'c5150000-0000-4000-8000-000000000002' and sale_id = 'c5150000-1000-4000-8000-000000000001'),
  'won 99000',
  'a favorite moved to the kept sale keeps its status and ceiling'
);
select is(
  (select id from public.user_favorites
    where user_id = 'c5150000-0000-4000-8000-000000000002' and sale_id = 'c5150000-1000-4000-8000-000000000001'),
  'c5150000-2000-4000-8000-000000000013'::uuid,
  'and its identifier'
);
select is(
  (select personal_status || ' ' || bid_ceiling_eur::text from public.user_favorites
    where user_id = 'c5150000-0000-4000-8000-000000000003' and sale_id = 'c5150000-1000-4000-8000-000000000001'),
  'archived 60000',
  'a favorite that already had its own values on the kept sale is not overwritten'
);
select is(
  (select count(*) from public.user_favorites where sale_id = 'c5150000-1000-4000-8000-000000000001'),
  3::bigint,
  'one favorite per account on the kept sale, no duplicate'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots
    where sale_id = 'c5150000-1000-4000-8000-000000000002'),
  0::bigint,
  'a merge is not a purge: it leaves no after-hearing snapshot'
);

select * from finish();
rollback;
