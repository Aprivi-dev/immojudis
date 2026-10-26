-- Code commune de chaque vente (migrations 20261106100000 et 20261106100100) :
--   * table privée : ni anon ni authenticated n'y touchent, service_role la lit et l'écrit, RLS activée ;
--   * le code commune est celui de GASPAR (75056, 13055, 69123) ; l'arrondissement est gardé à part et ne peut
--     se rattacher qu'à sa commune ;
--   * la ligne suit la vente (suppression en cascade) ;
--   * aucune colonne n'est ajoutée à auction_sales (l'invariant des droits de colonnes reste vrai) ;
--   * le nom de commune normalisé du repli (code postal et nom) suit celui du pipeline.
begin;

select plan(23);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type
) values
  ('c7530000-1000-4000-8000-000000000001', 'communes-test', 'https://example.test/communes/1',
   'Commune sale 1', 'upcoming', '2099-01-01 12:00:00Z', 100000, 'tribunal'),
  ('c7530000-1000-4000-8000-000000000002', 'communes-test', 'https://example.test/communes/2',
   'Commune sale 2', 'upcoming', '2099-01-02 12:00:00Z', 100000, 'tribunal');

-- Structure et droits ----------------------------------------------------------------------------
select has_table('public', 'auction_sale_communes', 'the sale commune codes are stored');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_sale_communes'::regclass),
  'row level security is enabled on the commune table'
);
select ok(
  not has_table_privilege('anon', 'public.auction_sale_communes', 'SELECT')
  and not has_table_privilege('anon', 'public.auction_sale_communes', 'INSERT')
  and not has_table_privilege('anon', 'public.auction_sale_communes', 'UPDATE')
  and not has_table_privilege('anon', 'public.auction_sale_communes', 'DELETE')
  and not has_table_privilege('authenticated', 'public.auction_sale_communes', 'SELECT')
  and not has_table_privilege('authenticated', 'public.auction_sale_communes', 'INSERT')
  and not has_table_privilege('authenticated', 'public.auction_sale_communes', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.auction_sale_communes', 'DELETE'),
  'neither a visitor nor an account holds any right on the commune table'
);
select ok(
  has_table_privilege('service_role', 'public.auction_sale_communes', 'SELECT')
  and has_table_privilege('service_role', 'public.auction_sale_communes', 'INSERT')
  and has_table_privilege('service_role', 'public.auction_sale_communes', 'UPDATE'),
  'service_role reads and writes the commune table'
);
select is(
  (
    select array_agg(policy.roles::text order by policy.policyname)
    from pg_policies policy
    where policy.schemaname = 'public' and policy.tablename = 'auction_sale_communes'
  ),
  array['{service_role}']::text[],
  'the only policy of the commune table is the service_role one'
);
select is(
  (select array_agg(column_name::text order by ordinal_position)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'auction_sale_communes'),
  array['sale_id', 'commune_insee', 'arrondissement_insee', 'source', 'resolved_at']::text[],
  'the commune table carries the commune, the arrondissement, the source and the date, nothing else'
);
select hasnt_column(
  'public', 'auction_sales', 'commune_insee',
  'auction_sales gets no commune column (the code lives in the linked private table)'
);

-- Contraintes ---------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source)
    values ('c7530000-1000-4000-8000-000000000001', '75056', '75108', 'geocode')$$,
  'a Paris arrondissement is stored with its commune'
);
select lives_ok(
  $$insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source)
    values ('c7530000-1000-4000-8000-000000000002', '37261', null, 'reference_communes')$$,
  'an ordinary commune has no arrondissement'
);
select throws_ok(
  $$update public.auction_sale_communes set arrondissement_insee = '13205'
     where sale_id = 'c7530000-1000-4000-8000-000000000001'$$,
  '23514',
  null,
  'an arrondissement cannot be attached to another city (Marseille 13205 under Paris 75056)'
);
select throws_ok(
  $$update public.auction_sale_communes set commune_insee = '37261'
     where sale_id = 'c7530000-1000-4000-8000-000000000001'$$,
  '23514',
  null,
  'an arrondissement code cannot sit under an ordinary commune'
);
select lives_ok(
  $$update public.auction_sale_communes set commune_insee = '13055', arrondissement_insee = '13216'
     where sale_id = 'c7530000-1000-4000-8000-000000000001'$$,
  'Marseille arrondissements run up to 13216'
);
select lives_ok(
  $$update public.auction_sale_communes set commune_insee = '69123', arrondissement_insee = '69389'
     where sale_id = 'c7530000-1000-4000-8000-000000000001'$$,
  'Lyon arrondissements are 69381 to 69389'
);
select throws_ok(
  $$update public.auction_sale_communes set commune_insee = '69123', arrondissement_insee = '69390'
     where sale_id = 'c7530000-1000-4000-8000-000000000001'$$,
  '23514',
  null,
  'there is no 10th arrondissement in Lyon'
);
select throws_ok(
  $$update public.auction_sale_communes set commune_insee = '3726'
     where sale_id = 'c7530000-1000-4000-8000-000000000002'$$,
  '23514',
  null,
  'a commune code has five characters'
);
select lives_ok(
  $$update public.auction_sale_communes set commune_insee = '2A004'
     where sale_id = 'c7530000-1000-4000-8000-000000000002'$$,
  'a Corsican commune code is accepted'
);
select throws_ok(
  $$update public.auction_sale_communes set source = 'cadastre'
     where sale_id = 'c7530000-1000-4000-8000-000000000002'$$,
  '23514',
  null,
  'the source comes from a closed list'
);

-- Normalisation du nom de commune (repli code postal et nom) ----------------------------------------------
select is(
  app_private.normalize_commune_name('Saint-Étienne (42)'),
  'saint etienne',
  'accents, punctuation and the trailing department are dropped'
);
select is(
  app_private.normalize_commune_name('ST-QUENTIN'),
  'saint quentin',
  'st is expanded at the start'
);
select is(
  app_private.normalize_commune_name('Ste Marie-aux-Mines'),
  'sainte marie aux mines',
  'ste is expanded at the start'
);
select is(
  app_private.normalize_commune_name('Cœuvres-et-Valsery (02)'),
  'c uvres et valsery',
  'a ligature is a separator, exactly like the pipeline normaliser (name_normalized of reference_communes)'
);
select ok(
  not has_function_privilege('anon', 'app_private.normalize_commune_name(text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.normalize_commune_name(text)', 'execute'),
  'the name normaliser is not open to the browser roles'
);

-- La ligne suit la vente ------------------------------------------------------------------------------
-- Le déclencheur require_outcome_bridge_before_auction_sale_delete exige le pont vers l'Outcome Graph avant toute
-- suppression d'une vente (même méthode que 409_enrichment_job_delete_receipts.sql).
do $bridge$ begin perform public.bridge_auction_sales_to_outcome_graph_batch('c752ffff-ffff-4fff-8fff-ffffffffffff'::uuid, 25); end $bridge$;
delete from public.auction_sales where id = 'c7530000-1000-4000-8000-000000000002';
select is(
  (select count(*) from public.auction_sale_communes
    where sale_id = 'c7530000-1000-4000-8000-000000000002'),
  0::bigint,
  'the commune row is deleted with its sale'
);

select * from finish();

rollback;
