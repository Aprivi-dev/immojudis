-- Risque d'inondation par vente (migration 20261106100200) : table privée alimentée par le traitement planifié.
--   * ni anon ni authenticated n'y touchent, service_role la lit et l'écrit, RLS activée, une seule politique ;
--   * aucune coordonnée, adresse ni URL dans la ligne (liste de colonnes figée, motif d'échec en code) ;
--   * un verdict connu vient toujours d'une observation réussie ;
--   * seul un verdict de la liste fermée est accepté ;
--   * la ligne suit la vente (suppression en cascade).
begin;

select plan(23);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type
) values
  ('c7540000-1000-4000-8000-000000000001', 'flood-test', 'https://example.test/flood/1',
   'Flood sale 1', 'upcoming', '2099-01-01 12:00:00Z', 100000, 'tribunal'),
  ('c7540000-1000-4000-8000-000000000002', 'flood-test', 'https://example.test/flood/2',
   'Flood sale 2', 'upcoming', '2099-01-02 12:00:00Z', 100000, 'tribunal');

-- Structure et droits ----------------------------------------------------------------------------
select has_table('public', 'auction_sale_flood_risk', 'the flood verdicts are stored');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_sale_flood_risk'::regclass),
  'row level security is enabled on the flood table'
);
select ok(
  not has_table_privilege('anon', 'public.auction_sale_flood_risk', 'SELECT')
  and not has_table_privilege('anon', 'public.auction_sale_flood_risk', 'INSERT')
  and not has_table_privilege('anon', 'public.auction_sale_flood_risk', 'UPDATE')
  and not has_table_privilege('anon', 'public.auction_sale_flood_risk', 'DELETE')
  and not has_table_privilege('authenticated', 'public.auction_sale_flood_risk', 'SELECT')
  and not has_table_privilege('authenticated', 'public.auction_sale_flood_risk', 'INSERT')
  and not has_table_privilege('authenticated', 'public.auction_sale_flood_risk', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.auction_sale_flood_risk', 'DELETE'),
  'neither a visitor nor an account holds any right on the flood table'
);
select ok(
  has_table_privilege('service_role', 'public.auction_sale_flood_risk', 'SELECT')
  and has_table_privilege('service_role', 'public.auction_sale_flood_risk', 'INSERT')
  and has_table_privilege('service_role', 'public.auction_sale_flood_risk', 'UPDATE'),
  'service_role reads and writes the flood table'
);
select is(
  (
    select array_agg(policy.roles::text order by policy.policyname)
    from pg_policies policy
    where policy.schemaname = 'public' and policy.tablename = 'auction_sale_flood_risk'
  ),
  array['{service_role}']::text[],
  'the only policy of the flood table is the service_role one'
);
select is(
  (select array_agg(column_name::text order by ordinal_position)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'auction_sale_flood_risk'),
  array[
    'sale_id', 'verdict', 'derive_version', 'position_key', 'position_kind', 'commune_insee',
    'commune_has_tri', 'tri_scenarios', 'ppri_perimeter', 'ppri_checked', 'map_date', 'observed_at',
    'attempted_at', 'failure_count', 'last_failure', 'verdict_changed_at', 'created_at', 'updated_at'
  ]::text[],
  'the flood table carries no coordinate, no address and no URL'
);

-- Un verdict connu exige une observation réussie ----------------------------------------------------------
select throws_ok(
  $$insert into public.auction_sale_flood_risk (sale_id, verdict, derive_version, position_key, position_kind)
    values ('c7540000-1000-4000-8000-000000000001', 'high', 'flood-v1', 'point:address:abc', 'point')$$,
  '23514',
  null,
  'a known verdict without a successful observation is refused'
);
select lives_ok(
  $$insert into public.auction_sale_flood_risk (
      sale_id, verdict, derive_version, position_key, position_kind, observed_at, failure_count, last_failure
    ) values (
      'c7540000-1000-4000-8000-000000000001', 'unknown', 'flood-v1', 'point:address:abc', 'point', null, 1, 'http_503'
    )$$,
  'a row that never succeeded is stored as unknown, with the failure code'
);
select lives_ok(
  $$insert into public.auction_sale_flood_risk (
      sale_id, verdict, derive_version, position_key, position_kind, commune_insee, tri_scenarios,
      ppri_perimeter, map_date, observed_at
    ) values (
      'c7540000-1000-4000-8000-000000000002', 'high', 'flood-v1', 'point:address:abc', 'point', '37261',
      '[["01For"]]'::jsonb, true, '2013-12-18', now()
    )$$,
  'a high verdict with its observation is stored'
);
select is(
  (select verdict from public.auction_sale_flood_risk where sale_id = 'c7540000-1000-4000-8000-000000000002'),
  'high',
  'the stored verdict is read back'
);

-- Listes fermées et formes ----------------------------------------------------------------------------------
select throws_ok(
  $$update public.auction_sale_flood_risk set verdict = 'dangerous'
     where sale_id = 'c7540000-1000-4000-8000-000000000002'$$,
  '23514',
  null,
  'the verdict comes from a closed list'
);
select lives_ok(
  $$update public.auction_sale_flood_risk set verdict = 'exposed'
     where sale_id = 'c7540000-1000-4000-8000-000000000002'$$,
  'the verdicts of the rule are accepted (exposed: shown, never excluding)'
);
select throws_ok(
  $$update public.auction_sale_flood_risk set position_kind = 'coordinates'
     where sale_id = 'c7540000-1000-4000-8000-000000000002'$$,
  '23514',
  null,
  'the position kind comes from a closed list'
);
select throws_ok(
  $$update public.auction_sale_flood_risk
       set last_failure = 'https://www.georisques.gouv.fr/api/v1/tri_zonage?latlon=0.689,47.399'
     where sale_id = 'c7540000-1000-4000-8000-000000000001'$$,
  '23514',
  null,
  'the failure column keeps a code, never a URL or a coordinate'
);
select throws_ok(
  $$update public.auction_sale_flood_risk set failure_count = -1
     where sale_id = 'c7540000-1000-4000-8000-000000000001'$$,
  '23514',
  null,
  'the failure count cannot be negative'
);
select throws_ok(
  $$update public.auction_sale_flood_risk set tri_scenarios = '{"01For": true}'::jsonb
     where sale_id = 'c7540000-1000-4000-8000-000000000002'$$,
  '23514',
  null,
  'the observed scenarios are a list'
);
select throws_ok(
  $$update public.auction_sale_flood_risk set commune_insee = '123'
     where sale_id = 'c7540000-1000-4000-8000-000000000002'$$,
  '23514',
  null,
  'the commune code has five characters'
);
select throws_ok(
  $$insert into public.auction_sale_flood_risk (sale_id, verdict, derive_version, position_key, position_kind)
    values ('c7540000-1000-4000-8000-000000000001', 'unknown', 'flood-v1', 'point:address:abc', 'point')$$,
  '23505',
  null,
  'one row per sale'
);

-- Défauts ----------------------------------------------------------------------------------------------
select is(
  (select failure_count::text || ',' || ppri_checked::text || ',' || tri_scenarios::text
     from public.auction_sale_flood_risk where sale_id = 'c7540000-1000-4000-8000-000000000002'),
  '0,true,[["01For"]]',
  'a successful observation has no failure and read the PPRi perimeter'
);

-- La ligne suit la vente --------------------------------------------------------------------------------
select is(
  (select count(*) from public.auction_sale_flood_risk
    where sale_id in ('c7540000-1000-4000-8000-000000000001', 'c7540000-1000-4000-8000-000000000002')),
  2::bigint,
  'two flood rows before the sales are deleted'
);
delete from public.auction_sales where id = 'c7540000-1000-4000-8000-000000000001';
select is(
  (select count(*) from public.auction_sale_flood_risk where sale_id = 'c7540000-1000-4000-8000-000000000001'),
  0::bigint,
  'the flood row is deleted with its sale'
);
select is(
  (select count(*) from public.auction_sale_flood_risk where sale_id = 'c7540000-1000-4000-8000-000000000002'),
  1::bigint,
  'the other sale keeps its verdict'
);

-- Aucune fonction publique ne lit la table ----------------------------------------------------------------
select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc like '%auction_sale_flood_risk%'
  ),
  'no public function reads the private flood table'
);

select * from finish();

rollback;
