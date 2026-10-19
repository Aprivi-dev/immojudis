-- Après l'audience (20261028190100) : une vente suivie dont l'audience est passée laisse un instantané
-- dans l'espace du compte quand le catalogue la purge ; l'instantané suit les règles de source (pas de
-- prix Licitor, prix réservé à l'offre Analyse), la RLS (propriétaire seul), la fusion de doublons (une
-- fusion n'est pas une purge) et une conservation bornée à 6 mois, puis purgée.
begin;

select plan(49);

-- Fixtures -------------------------------------------------------------------------------------
-- L'offre de lancement est active (posée explicitement) : le compte 1, dont l'adresse est confirmée,
-- a l'accès Analyse. Le compte 2, adresse non confirmée, est un compte Découverte.
update app_private.launch_offer set active = true where singleton;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5160000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'snapshot-analyse@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5160000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'snapshot-free@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5160000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'snapshot-other@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- Ventes dont l'audience est passée (purgées à l'instant de l'audience : 2000-01-02 12:00 UTC).
--   a : adjugée, prix publié par une source autre que Licitor, avocat connu
--   b : adjugée, source principale Licitor, prix publié (jamais copié)
--   c : résultat inconnu
--   d : adjugée, prix publié, mais Licitor figure dans ses observations (jamais copié)
insert into public.auction_sales (
  id, source_name, source_url, title, city, department, property_type, tribunal, status,
  starting_price_eur, sale_date, adjudication_price_eur, lawyer_name, lawyer_contact, observations
) values
  ('c5160000-1000-4000-8000-000000000001', 'snapshot-test', 'https://example.test/snapshot/a',
   'Maison A', 'Bordeaux', '33', 'house', 'Tribunal judiciaire de Test', 'adjudicated',
   100000, '2000-01-02 12:00:00Z', 250000, 'Me Dupont', 'dupont@example.test', null),
  ('c5160000-1000-4000-8000-000000000002', 'licitor', 'https://www.licitor.com/snapshot/b',
   'Maison B', 'Bordeaux', '33', 'house', 'Tribunal judiciaire de Test', 'adjudicated',
   80000, '2000-01-02 12:00:00Z', 100000, null, null, null),
  ('c5160000-1000-4000-8000-000000000003', 'snapshot-test', 'https://example.test/snapshot/c',
   'Maison C', 'Bordeaux', '33', 'house', 'Tribunal judiciaire de Test', 'unknown',
   60000, '2000-01-02 12:00:00Z', null, null, null, null),
  ('c5160000-1000-4000-8000-000000000004', 'snapshot-test', 'https://example.test/snapshot/d',
   'Maison D', 'Bordeaux', '33', 'house', 'Tribunal judiciaire de Test', 'adjudicated',
   50000, '2000-01-02 12:00:00Z', 90000, null, null, '[{"source_name": "licitor"}]'::jsonb);

-- Ventes qui ne doivent PAS laisser d'instantané : audience à venir, vente reportée, vente en quarantaine.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date) values
  ('c5160000-1000-4000-8000-000000000005', 'snapshot-test', 'https://example.test/snapshot/future',
   'Maison à venir', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c5160000-1000-4000-8000-000000000006', 'snapshot-test', 'https://example.test/snapshot/postponed',
   'Maison reportée', 'postponed', '2000-01-02 12:00:00Z'),
  ('c5160000-1000-4000-8000-000000000007', 'snapshot-test', 'https://example.test/snapshot/quarantine',
   'Maison en quarantaine', 'adjudicated', '2000-02-01 12:00:00Z');
update public.auction_sales
   set raw_payload = '{"publication_quarantine": "snapshot_test"}'::jsonb
 where id = 'c5160000-1000-4000-8000-000000000007';

-- Fusion : g (conservée, audience 2000-01-09, prix publié) liste l'URL de h (doublon supprimé).
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, adjudication_price_eur, source_urls
) values
  ('c5160000-1000-4000-8000-000000000008', 'snapshot-test', 'https://example.test/snapshot/g',
   'Maison G', 'adjudicated', '2000-01-09 12:00:00Z', 70000,
   '["https://example.test/snapshot/g", "https://example.test/snapshot/h"]'::jsonb),
  ('c5160000-1000-4000-8000-000000000009', 'snapshot-test', 'https://example.test/snapshot/h',
   'Maison H', 'adjudicated', '2000-01-09 12:00:00Z', null,
   '["https://example.test/snapshot/h"]'::jsonb);

-- Favoris. Compte 1 : toutes les ventes, avec statut et plafond sur a ; sur h, statut et plafond qui
-- doivent passer à g. Compte 2 : a, b, et h seulement (déplacé sur g par la fusion).
insert into public.user_favorites (id, user_id, sale_id, personal_status, bid_ceiling_eur) values
  ('c5160000-2000-4000-8000-000000000001', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000001', 'bidding', 180000),
  ('c5160000-2000-4000-8000-000000000002', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000002', null, null),
  ('c5160000-2000-4000-8000-000000000003', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000003', null, null),
  ('c5160000-2000-4000-8000-000000000004', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000004', null, null),
  ('c5160000-2000-4000-8000-000000000005', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000005', null, null),
  ('c5160000-2000-4000-8000-000000000006', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000006', null, null),
  ('c5160000-2000-4000-8000-000000000007', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000007', null, null),
  ('c5160000-2000-4000-8000-000000000008', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000008', null, null),
  ('c5160000-2000-4000-8000-000000000009', 'c5160000-0000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000009', 'reviewing', 120000),
  ('c5160000-2000-4000-8000-000000000011', 'c5160000-0000-4000-8000-000000000002', 'c5160000-1000-4000-8000-000000000001', null, null),
  ('c5160000-2000-4000-8000-000000000012', 'c5160000-0000-4000-8000-000000000002', 'c5160000-1000-4000-8000-000000000002', null, null),
  ('c5160000-2000-4000-8000-000000000013', 'c5160000-0000-4000-8000-000000000002', 'c5160000-1000-4000-8000-000000000009', 'won', 99000);

-- Structure -------------------------------------------------------------------------------------
select has_table('public', 'user_followed_sale_snapshots', 'the snapshot table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_followed_sale_snapshots'::regclass)
  and has_table_privilege('authenticated', 'public.user_followed_sale_snapshots', 'SELECT')
  and has_table_privilege('authenticated', 'public.user_followed_sale_snapshots', 'DELETE')
  and not has_table_privilege('authenticated', 'public.user_followed_sale_snapshots', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_followed_sale_snapshots', 'UPDATE')
  and not has_table_privilege('anon', 'public.user_followed_sale_snapshots', 'SELECT')
  and has_table_privilege('service_role', 'public.user_followed_sale_snapshots', 'SELECT'),
  'row security is on; an account reads and deletes its own rows but cannot write one; visitors read nothing'
);
select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.user_followed_sale_snapshots'::regclass
      and contype = 'f'
      and confrelid = 'public.auction_sales'::regclass),
  0::bigint,
  'no foreign key to auction_sales: the snapshot survives the purge of the sale'
);
select is(
  (select confdeltype from pg_constraint
    where conrelid = 'public.user_followed_sale_snapshots'::regclass
      and contype = 'f'
      and confrelid = 'auth.users'::regclass),
  'c'::"char",
  'erasing the account erases its snapshots (on delete cascade)'
);
select hasnt_column('public', 'user_followed_sale_snapshots', 'lawyer_contact',
  'the lawyer contact (possible decoded Licitor email) is never copied');
select has_trigger('public', 'auction_sales', 'auction_sales_snapshot_followed_sale', 'the capture trigger exists');
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc where oid = 'app_private.snapshot_followed_sale_before_delete()'::regprocedure)
  and not has_function_privilege('anon', 'app_private.snapshot_followed_sale_before_delete()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.snapshot_followed_sale_before_delete()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.purge_followed_sale_snapshots(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.purge_followed_sale_snapshots(timestamptz)', 'EXECUTE'),
  'the capture and purge functions are SECURITY DEFINER with an empty search_path and closed to browser roles'
);
select is(
  app_private.followed_sale_snapshot_retention(),
  interval '6 months',
  'the documented retention is 6 months'
);
select ok(
  position('purge_followed_sale_snapshots' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_sale_unlocks' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_errors' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0,
  'run_data_retention runs the snapshot purge and keeps its other purges and purge_errors'
);

-- Pas d'instantané hors audience passée ------------------------------------------------------------
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales where id in (
      'c5160000-1000-4000-8000-000000000005',
      'c5160000-1000-4000-8000-000000000006',
      'c5160000-1000-4000-8000-000000000007')$$,
  'a future sale, a postponed sale and a quarantined sale are deleted'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots),
  0::bigint,
  'none of them leaves a snapshot'
);

-- Purge de la vente par la rétention du catalogue ----------------------------------------------------
select is(
  (select count(*) from public.user_favorites where sale_id in (
     'c5160000-1000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000002',
     'c5160000-1000-4000-8000-000000000003', 'c5160000-1000-4000-8000-000000000004')),
  6::bigint,
  'before the purge, the four sales are followed by 6 favorites'
);
-- La purge supprime une vente par appel (limit least(p_limit, 1)) : quatre appels, un de plus pour constater
-- qu'il n'en reste aucune.
set local role service_role;
select lives_ok(
  $sql$do $loop$
    begin
      for i in 1..5 loop
        perform public.purge_expired_auction_sales('2000-01-02 12:00Z', 25);
      end loop;
    end
  $loop$$sql$,
  'the catalogue retention deletes the four sales whose audience has passed'
);
reset role;
select is(
  (select count(*) from public.auction_sales where id in (
     'c5160000-1000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000002',
     'c5160000-1000-4000-8000-000000000003', 'c5160000-1000-4000-8000-000000000004')),
  0::bigint,
  'the four sales are gone from the catalogue'
);
select is(
  (select count(*) from public.user_favorites where sale_id in (
     'c5160000-1000-4000-8000-000000000001', 'c5160000-1000-4000-8000-000000000002',
     'c5160000-1000-4000-8000-000000000003', 'c5160000-1000-4000-8000-000000000004')),
  0::bigint,
  'the favorites went with the sales (cascade)'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'),
  4::bigint,
  'the Analyse account keeps one snapshot per purged sale'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000002'),
  2::bigint,
  'the Découverte account keeps its two'
);
select is(
  (select count(*) from public.auction_sales where id = 'c5160000-1000-4000-8000-000000000001'),
  0::bigint,
  'the sale itself is gone: the snapshot is all that remains'
);

-- Contenu de l'instantané ----------------------------------------------------------------------------
select is(
  (select title || '|' || city || '|' || department || '|' || property_type || '|' || tribunal_name
          || '|' || starting_price_eur::text || '|' || lawyer_name || '|' || source_name
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000001'),
  'Maison A|Bordeaux|33|house|Tribunal judiciaire de Test|100000|Me Dupont|snapshot-test',
  'the key facts of the sale are kept'
);
select is(
  (select sale_date from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000001'),
  '2000-01-02 12:00:00Z'::timestamptz,
  'and the date of the hearing'
);
select is(
  (select result_status || '|' || adjudication_price_eur::text || '|' || adjudication_price_source
          || '|' || adjudication_price_withheld::text
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000001'),
  'adjudicated|250000|snapshot-test|false',
  'the published price is kept with its source for an account with the Analyse access'
);
select is(
  (select personal_status || '|' || bid_ceiling_eur::text from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000001'),
  'bidding|180000',
  'the personal status and ceiling of the account are kept'
);
select is(
  (select adjudication_price_eur is null and adjudication_price_source is null
          and adjudication_price_withheld and personal_status is null and bid_ceiling_eur is null
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000002'
      and sale_id = 'c5160000-1000-4000-8000-000000000001'),
  true,
  'a Découverte account gets no price (reserved to Analyse), flagged as withheld, not as unknown'
);
select is(
  (select result_status || '|' || (adjudication_price_eur is null)::text || '|' || adjudication_price_withheld::text
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000002'),
  'adjudicated|true|false',
  'a Licitor price is never copied (aggregates only), even for an Analyse account'
);
select is(
  (select adjudication_price_eur is null and not adjudication_price_withheld
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000002'
      and sale_id = 'c5160000-1000-4000-8000-000000000002'),
  true,
  'and a Licitor price is not reported as withheld for a Découverte account either'
);
select is(
  (select adjudication_price_eur is null and not adjudication_price_withheld
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000004'),
  true,
  'a price on a sale that Licitor also lists is not copied: its provenance is not certain'
);
select is(
  (select result_status || '|' || (adjudication_price_eur is null)::text
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000003'),
  'unknown|true',
  'an unknown result stays unknown, with no price deduced'
);
select is(
  (select bool_and(expires_at = captured_at + interval '6 months')
     from public.user_followed_sale_snapshots),
  true,
  'every snapshot expires 6 months after its capture'
);

-- Contraintes ------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.user_followed_sale_snapshots (user_id, sale_id, expires_at, result_status)
    values ('c5160000-0000-4000-8000-000000000003', gen_random_uuid(), now() + interval '13 months', 'unknown')$$,
  '23514', null, 'a retention above 12 months is refused'
);
select throws_ok(
  $$insert into public.user_followed_sale_snapshots (user_id, sale_id, expires_at, result_status, adjudication_price_eur)
    values ('c5160000-0000-4000-8000-000000000003', gen_random_uuid(), now() + interval '1 month', 'adjudicated', 1000)$$,
  '23514', null, 'a price without its source is refused'
);
select throws_ok(
  $$insert into public.user_followed_sale_snapshots (user_id, sale_id, expires_at, result_status)
    values ('c5160000-0000-4000-8000-000000000003', gen_random_uuid(), now() + interval '1 month', 'sold')$$,
  '23514', null, 'a result other than adjudicated or unknown is refused'
);

-- RLS --------------------------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c5160000-0000-4000-8000-000000000002';

select is(
  (select count(*) from public.user_followed_sale_snapshots),
  2::bigint,
  'an account sees only its own snapshots'
);
select lives_ok(
  $$delete from public.user_followed_sale_snapshots
     where user_id = 'c5160000-0000-4000-8000-000000000001'$$,
  'deleting the snapshots of another account is accepted as a no-op (row security hides them)'
);
select throws_ok(
  $$insert into public.user_followed_sale_snapshots (user_id, sale_id, expires_at, result_status)
    values ('c5160000-0000-4000-8000-000000000002', gen_random_uuid(), now() + interval '1 month', 'unknown')$$,
  '42501', null, 'an account cannot forge a snapshot'
);
select throws_ok(
  $$update public.user_followed_sale_snapshots set adjudication_price_eur = 1$$,
  '42501', null, 'an account cannot edit a snapshot'
);
select lives_ok(
  $$delete from public.user_followed_sale_snapshots
     where sale_id = 'c5160000-1000-4000-8000-000000000002'$$,
  'an account removes one of its own snapshots'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots),
  1::bigint,
  'and only that one'
);

set local "request.jwt.claim.sub" = 'c5160000-0000-4000-8000-000000000003';
select is(
  (select count(*) from public.user_followed_sale_snapshots),
  0::bigint,
  'an account with no followed sale sees no snapshot'
);
reset role;
set local "request.jwt.claim.sub" = '';

select is(
  (select count(*) from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'),
  4::bigint,
  'the snapshots of the first account were not touched by the others'
);

set local role anon;
select throws_ok(
  $$select count(*) from public.user_followed_sale_snapshots$$,
  '42501', null, 'a visitor cannot read snapshots'
);
reset role;

-- Fusion de doublons : une fusion n'est pas une purge -----------------------------------------------
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales where id = 'c5160000-1000-4000-8000-000000000009'$$,
  'the duplicate h is deleted (merge into g)'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots
    where sale_id = 'c5160000-1000-4000-8000-000000000009'),
  0::bigint,
  'the merge leaves no snapshot for the deleted duplicate'
);
set local role service_role;
select is(
  (public.purge_expired_auction_sales('2000-01-09 12:00Z', 25)->>'deleted')::integer,
  1,
  'later, the catalogue retention purges the kept sale g'
);
reset role;
select is(
  (select personal_status || '|' || bid_ceiling_eur::text || '|' || adjudication_price_eur::text
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000001'
      and sale_id = 'c5160000-1000-4000-8000-000000000008'),
  'reviewing|120000|70000',
  'the status and ceiling saved on the duplicate reach the snapshot of the kept sale'
);
select is(
  (select personal_status || '|' || bid_ceiling_eur::text || '|' || adjudication_price_withheld::text
     from public.user_followed_sale_snapshots
    where user_id = 'c5160000-0000-4000-8000-000000000002'
      and sale_id = 'c5160000-1000-4000-8000-000000000008'),
  'won|99000|true',
  'the favorite moved by the merge also reaches the snapshot of the kept sale'
);

-- Conservation bornée et purge ---------------------------------------------------------------------------
select is(
  (select count(*) from public.user_followed_sale_snapshots),
  7::bigint,
  'seven snapshots are kept before the end of the retention period'
);
select is(
  (app_private.purge_followed_sale_snapshots(now() + interval '5 months')->>'user_followed_sale_snapshots')::integer,
  0,
  'nothing is purged before the retention period ends'
);
select is(
  (public.run_data_retention(now() + interval '7 months')->>'user_followed_sale_snapshots')::integer,
  7,
  'the weekly retention purges every snapshot once its period is over'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots),
  0::bigint,
  'and none remains'
);

select * from finish();
rollback;
