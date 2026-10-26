-- Purge des ventes (public.purge_expired_auction_sales) : le verdict d'inondation et le code commune d'une vente
-- disparaissent avec elle (suppression en cascade, migrations 20261106100000 et 20261106100200). Aucune donnée de
-- risque ni de commune ne survit à la vente ; la vente plus jeune garde les siennes. Modèle : 320_sale_retention.sql.
begin;

select plan(9);

insert into public.auction_sales (id, source_name, source_url, status, starting_price_eur, sale_date) values
  ('c7570000-1000-4000-8000-000000000001', 'flood-purge-test', 'https://example.test/flood-purge/1',
   'upcoming', 10000, '2000-01-02 12:00Z'),
  ('c7570000-1000-4000-8000-000000000002', 'flood-purge-test', 'https://example.test/flood-purge/2',
   'upcoming', 10000, '2000-01-03 12:00Z');

insert into public.auction_sale_flood_risk (
  sale_id, verdict, derive_version, position_key, position_kind, tri_scenarios, observed_at
) values
  ('c7570000-1000-4000-8000-000000000001', 'high', 'flood-v1', 'point:address:abc', 'point',
   '[["01For"]]'::jsonb, '2026-11-01 08:00:00Z'),
  ('c7570000-1000-4000-8000-000000000002', 'none_found', 'flood-v1', 'point:address:def', 'point',
   '[[]]'::jsonb, '2026-11-01 08:00:00Z');

insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source) values
  ('c7570000-1000-4000-8000-000000000001', '75056', '75108', 'geocode'),
  ('c7570000-1000-4000-8000-000000000002', '37261', null, 'reference_communes');

select is(
  (select count(*) from public.auction_sale_flood_risk where sale_id::text like 'c7570000-%'),
  2::bigint,
  'two flood verdicts before the purge'
);
select is(
  (select count(*) from public.auction_sale_communes where sale_id::text like 'c7570000-%'),
  2::bigint,
  'two commune codes before the purge'
);
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.auction_sale_flood_risk'::regclass and contype = 'f'),
  'c',
  'a flood verdict disappears with its sale (on delete cascade)'
);
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.auction_sale_communes'::regclass and contype = 'f'),
  'c',
  'a commune code disappears with its sale (on delete cascade)'
);

-- Les tâches pg_cron de la base de test (rétention toutes les 5 minutes, observateurs) peuvent tenir le verrou
-- consultatif de la purge ou un verrou d'auction_sales : la purge rend alors « busy » sans rien supprimer. Le test
-- prend lui-même ces deux verrous, dans l'ordre de la purge (voir 320_sale_retention.sql).
select pg_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0));
lock table public.auction_sales in share row exclusive mode;
set local role service_role;
select is(
  (public.purge_expired_auction_sales('2000-01-02 12:00Z', 25)->>'deleted')::integer,
  1,
  'the sale at its catalogue boundary is purged'
);
reset role;

select is(
  (select count(*) from public.auction_sale_flood_risk where sale_id = 'c7570000-1000-4000-8000-000000000001'),
  0::bigint,
  'the purged sale takes its flood verdict with it'
);
select is(
  (select count(*) from public.auction_sale_communes where sale_id = 'c7570000-1000-4000-8000-000000000001'),
  0::bigint,
  'the purged sale takes its commune code with it'
);
select is(
  (select count(*) from public.auction_sale_flood_risk where sale_id = 'c7570000-1000-4000-8000-000000000002'),
  1::bigint,
  'the younger sale keeps its flood verdict'
);
select is(
  (select count(*) from public.auction_sale_communes where sale_id = 'c7570000-1000-4000-8000-000000000002'),
  1::bigint,
  'the younger sale keeps its commune code'
);

select * from finish();

rollback;
