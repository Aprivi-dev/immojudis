-- Instantanés d'estimation de marché (migration 20261102110100) : juste avant la disparition de la ligne
-- d'estimation d'une vente de tribunal dont l'audience est passée (suppression de la vente à l'heure de
-- l'audience, ou sortie des statuts active / upcoming), une ligne est gardée dans une table privée, une seule fois
-- par vente, sans adresse ni identifiant de vente. RLS, droits, garde (audience à venir, vente reportée,
-- estimation non prête, autre type de vente, tribunal inconnu, fusion), conservation de 36 mois, purge isolée.
begin;

select plan(37);

insert into public.tribunals (code, canonical_name, department, city, aliases)
values ('pgtap_716_tj', 'TJ pgTAP 716', '33', 'Bordeaux', '[]'::jsonb);

-- Ventes dont l'audience est passée (2000-01-02), en statut « upcoming » : l'estimation est mise en file à
-- l'insertion par le déclencheur de file. Une estimation « ready » est posée à la main plus bas.
--   a : suppression de la vente (purge à l'audience)        -> instantané
--   b : passage à « adjudicated » puis suppression           -> un seul instantané
--   c : estimation restée « pending »                        -> aucun
--   d : audience à venir                                     -> aucun
--   e : vente reportée                                       -> aucun
--   f : vente d'un autre type (domaniale ; les ventes notariales ont leur instantané depuis 20261104110000, voir le test 752) -> aucun
--   g : fusion de doublons                                   -> aucun
--   i : sans code de tribunal                                -> aucun
--   k : appels répétés de la fonction d'écriture             -> un seul instantané
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, tribunal_code, department,
  property_type, sale_venue_type
) values
  ('c7160000-1000-4000-8000-000000000001', 'pgtap-716', 'https://example.test/716/a', 'Maison A', 'upcoming',
   '2000-01-02 12:00:00Z', 100000, 'pgtap_716_tj', '33', 'house', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000002', 'pgtap-716', 'https://example.test/716/b', 'Appartement B', 'upcoming',
   '2000-01-02 12:00:00Z', 50000, 'pgtap_716_tj', '33', 'apartment', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000003', 'pgtap-716', 'https://example.test/716/c', 'Maison C', 'upcoming',
   '2000-01-02 12:00:00Z', 60000, 'pgtap_716_tj', '33', 'house', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000004', 'pgtap-716', 'https://example.test/716/d', 'Maison D', 'upcoming',
   '2099-01-02 12:00:00Z', 70000, 'pgtap_716_tj', '33', 'house', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000005', 'pgtap-716', 'https://example.test/716/e', 'Maison E', 'upcoming',
   '2000-01-02 12:00:00Z', 80000, 'pgtap_716_tj', '33', 'house', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000006', 'pgtap-716', 'https://example.test/716/f', 'Maison F', 'upcoming',
   '2000-01-02 12:00:00Z', 90000, 'pgtap_716_tj', '33', 'house', 'state'),
  ('c7160000-1000-4000-8000-000000000007', 'pgtap-716', 'https://example.test/716/g', 'Maison G', 'upcoming',
   '2000-01-02 12:00:00Z', 95000, 'pgtap_716_tj', '33', 'house', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000008', 'pgtap-716', 'https://example.test/716/h', 'Maison H (conservée)', 'upcoming',
   '2000-01-02 12:00:00Z', 95000, 'pgtap_716_tj', '33', 'house', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000009', 'pgtap-716', 'https://example.test/716/i', 'Maison I', 'upcoming',
   '2000-01-02 12:00:00Z', 40000, null, '33', 'house', 'tribunal'),
  ('c7160000-1000-4000-8000-000000000010', 'pgtap-716', 'https://example.test/716/k', 'Terrain K', 'upcoming',
   '2000-01-03 12:00:00Z', 20000, 'pgtap_716_tj', '24', 'land', 'tribunal');

-- Estimations prêtes (toutes sauf c, qui reste en attente).
update public.auction_sale_market_estimates
   set status = 'ready',
       estimate = '{}'::jsonb,
       value_p10_eur = 150000,
       value_p50_eur = 200000,
       value_p90_eur = 260000,
       actionable = true,
       comparable_count = 12,
       confidence_score = 70,
       engine_kind = 'comparable_ensemble',
       model_version = 'pgtap-716-v1',
       computed_at = '1999-12-20 08:00:00Z'
 where auction_sale_id in (
   'c7160000-1000-4000-8000-000000000001', 'c7160000-1000-4000-8000-000000000002',
   'c7160000-1000-4000-8000-000000000004', 'c7160000-1000-4000-8000-000000000005',
   'c7160000-1000-4000-8000-000000000006', 'c7160000-1000-4000-8000-000000000007',
   'c7160000-1000-4000-8000-000000000008', 'c7160000-1000-4000-8000-000000000009',
   'c7160000-1000-4000-8000-000000000010'
 );

-- Pont Outcome Graph exigé avant toute suppression d'une vente (garde de 20260730163756), comme les autres tests.
select count(*) from public.bridge_auction_sales_to_outcome_graph();

-- Structure, accès ------------------------------------------------------------------------------------
select has_table('app_private', 'sale_market_estimate_snapshots', 'the snapshot table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.sale_market_estimate_snapshots'::regclass),
  'row level security is enabled on the snapshots'
);
select ok(
  not has_table_privilege('anon', 'app_private.sale_market_estimate_snapshots', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.sale_market_estimate_snapshots', 'SELECT')
  and not has_table_privilege('anon', 'app_private.sale_market_estimate_snapshots', 'INSERT')
  and not has_table_privilege('authenticated', 'app_private.sale_market_estimate_snapshots', 'INSERT')
  and not has_table_privilege('authenticated', 'app_private.sale_market_estimate_snapshots', 'DELETE'),
  'neither visitors nor accounts can read or write the snapshots'
);
select ok(
  has_table_privilege('service_role', 'app_private.sale_market_estimate_snapshots', 'SELECT')
  and not has_table_privilege('service_role', 'app_private.sale_market_estimate_snapshots', 'INSERT')
  and not has_table_privilege('service_role', 'app_private.sale_market_estimate_snapshots', 'UPDATE')
  and not has_table_privilege('service_role', 'app_private.sale_market_estimate_snapshots', 'DELETE'),
  'service_role reads the snapshots and cannot write them (the definer functions do)'
);
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'app_private' and table_name = 'sale_market_estimate_snapshots'
      and column_name in (
        'id', 'sale_id', 'auction_sale_id', 'address', 'city', 'postal_code', 'title', 'source_url',
        'latitude', 'longitude', 'lawyer_name', 'observations'
      )),
  0::bigint,
  'no address, place, title, source or sale identifier column'
);
select ok(
  (select bool_and(procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[])
     from pg_proc procedure_row
    where procedure_row.oid in (
      'app_private.snapshot_sale_market_estimate(public.auction_sales)'::regprocedure,
      'app_private.snapshot_market_estimate_before_delete()'::regprocedure,
      'app_private.snapshot_market_estimate_on_status_exit()'::regprocedure,
      'app_private.purge_market_estimate_snapshots(timestamptz)'::regprocedure
    )),
  'the writing and purge functions are security definer with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.snapshot_sale_market_estimate(public.auction_sales)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.snapshot_sale_market_estimate(public.auction_sales)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.purge_market_estimate_snapshots(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.purge_market_estimate_snapshots(timestamptz)', 'EXECUTE'),
  'only the server can run the purge; nobody outside the triggers writes a snapshot'
);

select is(
  (select count(*) from app_private.sale_market_estimate_snapshots),
  0::bigint,
  'nothing is captured while the sales are alive'
);

-- Sortie des statuts active / upcoming ------------------------------------------------------------------
update public.auction_sales set status = 'adjudicated' where id = 'c7160000-1000-4000-8000-000000000002';
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots where starting_price_eur = 50000),
  1::bigint,
  'a sale leaving upcoming for adjudicated leaves a snapshot'
);
select is(
  (select count(*) from public.auction_sale_market_estimates
    where auction_sale_id = 'c7160000-1000-4000-8000-000000000002'),
  0::bigint,
  'and its estimate row is gone, as before'
);
select lives_ok(
  $$delete from public.auction_sales where id = 'c7160000-1000-4000-8000-000000000002'$$,
  'deleting that sale afterwards works'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots where starting_price_eur = 50000),
  1::bigint,
  'the deletion adds no second snapshot for the same sale'
);

-- Suppression de la vente (purge à l'audience) ---------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7160000-1000-4000-8000-000000000001'$$,
  'the sale a is deleted, as the catalogue retention does at the hearing'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots where starting_price_eur = 100000),
  1::bigint,
  'its deletion leaves one snapshot'
);
select ok(
  (select court_code = 'pgtap_716_tj' and department = '33' and property_type = 'house'
          and property_group = 'housing' and starting_price_eur = 100000
          and sale_date = date '2000-01-02'
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 100000),
  'the snapshot carries court, department, type, comparison group, starting price and hearing day'
);
select ok(
  (select value_p10_eur = 150000 and value_p50_eur = 200000 and value_p90_eur = 260000 and actionable
          and comparable_count = 12 and confidence_score = 70 and engine_kind = 'comparable_ensemble'
          and model_version = 'pgtap-716-v1' and estimate_computed_at = '1999-12-20 08:00:00Z'::timestamptz
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 100000),
  'it carries the estimate (P10, P50, P90), its quality and the model'
);
select is(
  (select snapshot_key from app_private.sale_market_estimate_snapshots where starting_price_eur = 100000),
  pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to('sale-market-estimate-snapshot:v1:c7160000-1000-4000-8000-000000000001', 'UTF8')),
    'hex'
  ),
  'the key is the SHA-256 of the sale identifier, not the identifier'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots
    where to_jsonb(sale_market_estimate_snapshots)::text like '%c7160000-1000-4000-8000-000000000001%'
       or to_jsonb(sale_market_estimate_snapshots)::text like '%example.test%'),
  0::bigint,
  'the identifier of the sale and its URL appear nowhere in the row'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots where starting_price_eur = 20000),
  0::bigint,
  'the sale k is still alive: no snapshot yet'
);

-- Une seule fois par vente -----------------------------------------------------------------------------
select lives_ok(
  $$select app_private.snapshot_sale_market_estimate(sale) from public.auction_sales sale
     where sale.id = 'c7160000-1000-4000-8000-000000000010'$$,
  'the writing function can be called for the sale k'
);
select lives_ok(
  $$select app_private.snapshot_sale_market_estimate(sale) from public.auction_sales sale
     where sale.id = 'c7160000-1000-4000-8000-000000000010'$$,
  'and again'
);
select lives_ok(
  $$delete from public.auction_sales where id = 'c7160000-1000-4000-8000-000000000010'$$,
  'then the sale k is deleted'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots where starting_price_eur = 20000),
  1::bigint,
  'three writes for the same sale leave one snapshot'
);
select is(
  (select property_group from app_private.sale_market_estimate_snapshots where starting_price_eur = 20000),
  'land',
  'a land sale keeps its own comparison group (land), not housing'
);

-- Ce qui ne laisse aucun instantané ----------------------------------------------------------------------
update public.auction_sales set status = 'postponed' where id = 'c7160000-1000-4000-8000-000000000005';
insert into app_private.auction_sale_merges (old_sale_id, old_source_url, canonical_sale_id)
values (
  'c7160000-1000-4000-8000-000000000007', 'https://example.test/716/g',
  'c7160000-1000-4000-8000-000000000008'
);
select lives_ok(
  $$delete from public.auction_sales where id in (
      'c7160000-1000-4000-8000-000000000003', 'c7160000-1000-4000-8000-000000000004',
      'c7160000-1000-4000-8000-000000000005', 'c7160000-1000-4000-8000-000000000006',
      'c7160000-1000-4000-8000-000000000007', 'c7160000-1000-4000-8000-000000000009')$$,
  'the sales c, d, e, f, g and i are deleted'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots),
  3::bigint,
  'none of them leaves a snapshot: estimate pending, hearing to come, postponed, other type of sale, merge, no court'
);

-- Une panne de l'écriture ne bloque pas la suppression ------------------------------------------------
create or replace function app_private.scenario_property_group(p_property_type text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  raise exception 'pgtap forced failure of the property group';
end;
$$;
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, tribunal_code, department,
  property_type, sale_venue_type
) values (
  'c7160000-1000-4000-8000-000000000011', 'pgtap-716', 'https://example.test/716/l', 'Maison L', 'upcoming',
  '2000-01-02 12:00:00Z', 30000, 'pgtap_716_tj', '33', 'house', 'tribunal'
);
update public.auction_sale_market_estimates
   set status = 'ready', estimate = '{}'::jsonb, value_p50_eur = 40000, actionable = true
 where auction_sale_id = 'c7160000-1000-4000-8000-000000000011';
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales where id = 'c7160000-1000-4000-8000-000000000011'$$,
  'a failure of the snapshot never blocks the deletion of the sale'
);
select is(
  (select count(*) from public.auction_sales where id = 'c7160000-1000-4000-8000-000000000011'),
  0::bigint,
  'the sale is gone'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots),
  3::bigint,
  'and no half-written snapshot remains'
);
create or replace function app_private.scenario_property_group(p_property_type text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_property_type in ('apartment', 'studio', 'house', 'villa') then 'housing'
    when p_property_type = 'parking' then 'parking'
    when p_property_type = 'land' then 'land'
    when p_property_type = 'commercial' then 'commercial'
  end;
$function$;

-- Conservation : 36 mois après l'audience -----------------------------------------------------------------
select is(
  app_private.market_estimate_snapshot_retention(),
  interval '36 months',
  'the retention is 36 months, the window of the scenarios'
);
select is(
  (app_private.purge_market_estimate_snapshots('2002-12-31T00:00:00Z'::timestamptz)
     ->> 'sale_market_estimate_snapshots')::integer,
  0,
  'before the 36 months after the hearing, nothing is purged'
);
select is(
  (app_private.purge_market_estimate_snapshots('2003-01-04T00:00:00Z'::timestamptz)
     ->> 'sale_market_estimate_snapshots')::integer,
  3,
  'after them, the snapshots are purged'
);

-- run_data_retention ---------------------------------------------------------------------------------
insert into app_private.sale_market_estimate_snapshots (
  snapshot_key, court_code, starting_price_eur, sale_date, value_p50_eur, actionable, comparable_count
) values (repeat('a', 64), 'pgtap_716_tj', 10000, '2000-01-02', 12000, true, 5);

select ok(
  position('purge_market_estimate_snapshots' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_sale_result_dispatches' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_followed_sale_snapshots' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_expired_operational_data' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_errors' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0,
  'run_data_retention runs the snapshot purge and keeps its other purges and purge_errors'
);
select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'sale_market_estimate_snapshots')::integer,
  1,
  'the weekly retention reports the snapshots it purged'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots),
  0::bigint,
  'and they are gone'
);

-- Une purge qui échoue est signalée sans arrêter les autres.
create or replace function app_private.purge_market_estimate_snapshots(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
as $$
begin
  raise exception 'pgtap forced failure of the estimate snapshot purge';
end;
$$;
select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'purge_errors',
  '{"purge_market_estimate_snapshots": "P0001"}'::jsonb,
  'a failing snapshot purge is reported by name'
);
select ok(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'sale_result_dispatches'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'user_followed_sale_snapshots',
  'and the other purges still run'
);

select * from finish();
rollback;
