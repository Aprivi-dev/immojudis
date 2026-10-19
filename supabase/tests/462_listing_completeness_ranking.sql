-- Classement de /sales par complétude (migration 20261024100000).
--   * la table des scores n'est lisible ni par anon ni par authenticated, écrite par service_role ;
--   * les vues de recherche n'exposent que le palier (completeness_tier), en dernière colonne ;
--   * les RPC publiques v3 et v4 classent : ventes localisées d'abord, palier décroissant, date de
--     vente croissante, identifiant ; une vente non évaluée est au palier bas ;
--   * la barrière de sécurité de la vue Découverte est conservée.
begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(42);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c4620000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ranking-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4620000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ranking-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c4620000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c4620000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

-- Sept ventes en ligne.  Palier haut : s1, s4, s5, s7.  Palier bas : s2.  Non évaluées : s3, s6.
-- s1 et s7 ont la même date (départage par identifiant), s5 n'a pas de coordonnées, s6 est la plus tardive.
-- (Une vente sans date n'est pas visible au catalogue: le tri « sans date en dernier » est couvert
-- par le test Vitest de queries.ts.)
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload
)
select
  ('c4620000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'listing-completeness-ranking-test', 'https://example.test/ranking/' || i,
  'Ranking title ' || i, 'Ranking address ' || i, 'ClassementC462', '33', 'apartment',
  100000 + i * 1000,
  case i
    when 1 then '2099-03-10 10:00:00Z'::timestamptz
    when 2 then '2099-01-20 10:00:00Z'::timestamptz
    when 3 then '2099-01-10 10:00:00Z'::timestamptz
    when 4 then '2099-02-10 10:00:00Z'::timestamptz
    when 5 then '2099-01-05 10:00:00Z'::timestamptz
    when 6 then '2099-12-31 10:00:00Z'::timestamptz
    when 7 then '2099-03-10 10:00:00Z'::timestamptz
  end,
  50, 'habitable', 2, 1, 1, 'upcoming',
  case when i = 5 then null else 44.837812 end, -0.579234,
  'tribunal', 'pending', '{}'::jsonb
from generate_series(1, 7) i;

insert into public.auction_sale_listing_completeness
  (sale_id, score, tier, policy_version, input_fingerprint)
values
  ('c4620000-1000-4000-8000-000000000001', 82.5, 1, 'completeness-tier-v1', 'fp-1'),
  ('c4620000-1000-4000-8000-000000000002', 40.0, 0, 'completeness-tier-v1', 'fp-2'),
  ('c4620000-1000-4000-8000-000000000004', 75.0, 1, 'completeness-tier-v1', 'fp-4'),
  ('c4620000-1000-4000-8000-000000000005', 91.0, 1, 'completeness-tier-v1', 'fp-5'),
  ('c4620000-1000-4000-8000-000000000007', 88.0, 1, 'completeness-tier-v1', 'fp-7');

-- La table ------------------------------------------------------------------------------------
select has_table('public', 'auction_sale_listing_completeness', 'the completeness scores are stored');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_sale_listing_completeness'::regclass),
  'row level security is enabled on the completeness table'
);
select ok(
  not has_table_privilege('anon', 'public.auction_sale_listing_completeness', 'SELECT')
  and not has_table_privilege('anon', 'public.auction_sale_listing_completeness', 'INSERT')
  and not has_table_privilege('anon', 'public.auction_sale_listing_completeness', 'UPDATE')
  and not has_table_privilege('anon', 'public.auction_sale_listing_completeness', 'DELETE'),
  'anon holds no right on the completeness table'
);
select ok(
  not has_table_privilege('authenticated', 'public.auction_sale_listing_completeness', 'SELECT')
  and not has_table_privilege('authenticated', 'public.auction_sale_listing_completeness', 'INSERT')
  and not has_table_privilege('authenticated', 'public.auction_sale_listing_completeness', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.auction_sale_listing_completeness', 'DELETE'),
  'authenticated holds no right on the completeness table'
);
select ok(
  has_table_privilege('service_role', 'public.auction_sale_listing_completeness', 'SELECT')
  and has_table_privilege('service_role', 'public.auction_sale_listing_completeness', 'INSERT')
  and has_table_privilege('service_role', 'public.auction_sale_listing_completeness', 'UPDATE'),
  'service_role reads and writes the completeness table'
);
select is(
  (
    select array_agg(policy.roles::text order by policy.policyname)
    from pg_policies policy
    where policy.schemaname = 'public'
      and policy.tablename = 'auction_sale_listing_completeness'
  ),
  array['{service_role}']::text[],
  'the only policy of the completeness table is the service_role one'
);
select throws_ok(
  $$insert into public.auction_sale_listing_completeness
      (sale_id, score, tier, policy_version, input_fingerprint)
    values ('c4620000-1000-4000-8000-000000000003', 50, 2, 'completeness-tier-v1', 'fp')$$,
  '23514',
  null,
  'only two tiers exist'
);
select throws_ok(
  $$insert into public.auction_sale_listing_completeness
      (sale_id, score, tier, policy_version, input_fingerprint)
    values ('c4620000-1000-4000-8000-000000000003', 100.1, 1, 'completeness-tier-v1', 'fp')$$,
  '23514',
  null,
  'a score above 100 is refused'
);
select throws_ok(
  $$insert into public.auction_sale_listing_completeness
      (sale_id, score, tier, policy_version, input_fingerprint)
    values ('c4620000-1000-4000-8000-000000000003', -1, 0, 'completeness-tier-v1', 'fp')$$,
  '23514',
  null,
  'a negative score is refused'
);
select throws_ok(
  $$insert into public.auction_sale_listing_completeness
      (sale_id, score, tier, policy_version, input_fingerprint)
    values (gen_random_uuid(), 50, 0, 'completeness-tier-v1', 'fp')$$,
  '23503',
  null,
  'a score needs an existing sale'
);

-- Les vues de recherche -------------------------------------------------------------------------
select is(
  (
    select array_agg(attribute.attname::text order by attribute.attnum)
    from (
      select attname, attnum
      from pg_attribute
      where attrelid = 'public.v_auction_sales_app_search'::regclass
        and attnum > 0 and not attisdropped
      order by attnum desc
      limit 2
    ) attribute
  ),
  array['coordinates_rank', 'completeness_tier']::text[],
  'v_auction_sales_app_search ends with coordinates_rank then completeness_tier'
);
select is(
  (
    select array_agg(attribute.attname::text order by attribute.attnum)
    from (
      select attname, attnum
      from pg_attribute
      where attrelid = 'public.v_auction_sales_discovery_search'::regclass
        and attnum > 0 and not attisdropped
      order by attnum desc
      limit 2
    ) attribute
  ),
  array['coordinates_rank', 'completeness_tier']::text[],
  'v_auction_sales_discovery_search ends with coordinates_rank then completeness_tier'
);
select ok(
  not exists (
    select 1
    from pg_attribute
    where attrelid in (
        'public.v_auction_sales_app_search'::regclass,
        'public.v_auction_sales_discovery_search'::regclass
      )
      and attnum > 0 and not attisdropped
      and attname in (
        'completeness_score', 'tier', 'policy_version', 'input_fingerprint', 'evaluated_at'
      )
  ),
  'the search views publish the tier only, never the score nor its inputs'
);
select ok(
  (
    select reloptions @> array['security_invoker=true']::text[]
      from pg_class where oid = 'public.v_auction_sales_app_search'::regclass
  )
  and (
    select reloptions @> array['security_invoker=false', 'security_barrier=true']::text[]
      from pg_class where oid = 'public.v_auction_sales_discovery_search'::regclass
  ),
  'the invoker view stays invoker and the discovery view keeps its security barrier'
);
select ok(
  not has_table_privilege('anon', 'public.v_auction_sales_app_search', 'SELECT')
  and not has_table_privilege('anon', 'public.v_auction_sales_discovery_search', 'SELECT')
  and has_table_privilege('authenticated', 'public.v_auction_sales_app_search', 'SELECT')
  and has_table_privilege('authenticated', 'public.v_auction_sales_discovery_search', 'SELECT')
  and has_table_privilege('service_role', 'public.v_auction_sales_app_search', 'SELECT')
  and has_table_privilege('service_role', 'public.v_auction_sales_discovery_search', 'SELECT'),
  'the search views keep their grants'
);
select ok(
  has_function_privilege('authenticated', 'app_private.sale_completeness_tier(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.sale_completeness_tier(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.sale_completeness_tier(uuid)', 'EXECUTE'),
  'the tier helper is callable by the roles that read the search views, not by anon'
);

-- Un compte Analyse lit le palier par la vue « app » (security_invoker, sans droit sur la table)
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c4620000-0000-4000-8000-000000000002';

select is(
  (
    select array_agg(id::text order by id)
    from public.v_auction_sales_app_search
    where city = 'ClassementC462' and completeness_tier = 1
  ),
  array[
    'c4620000-1000-4000-8000-000000000001', 'c4620000-1000-4000-8000-000000000004',
    'c4620000-1000-4000-8000-000000000005', 'c4620000-1000-4000-8000-000000000007'
  ],
  'an Analyse account reads the tier of the evaluated sales through the invoker view'
);
select is(
  (
    select array_agg(id::text order by id)
    from public.v_auction_sales_app_search
    where city = 'ClassementC462' and completeness_tier = 0
  ),
  array[
    'c4620000-1000-4000-8000-000000000002', 'c4620000-1000-4000-8000-000000000003',
    'c4620000-1000-4000-8000-000000000006'
  ],
  'a sale not evaluated yet (s3, s6) is in the low tier, like an evaluated low one (s2)'
);
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from (
      select id from public.v_auction_sales_app_search
      where city = 'ClassementC462'
      order by coordinates_rank, completeness_tier desc, sale_date asc nulls last, id
    ) ranked
  ),
  array[4, 1, 7, 3, 2, 6, 5],
  'ordering the app search view by rank, tier, date and id gives the expected list'
);
select throws_ok(
  $$select score from public.auction_sale_listing_completeness$$,
  '42501',
  'permission denied for table auction_sale_listing_completeness',
  'an authenticated account cannot read the score table'
);

-- Un compte Découverte lit le palier par la vue Découverte (définer, barrière de sécurité)
set local "request.jwt.claim.sub" = 'c4620000-0000-4000-8000-000000000001';
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from (
      select id from public.v_auction_sales_discovery_search
      where city = 'ClassementC462'
      order by coordinates_rank, completeness_tier desc, sale_date asc nulls last, id
    ) ranked
  ),
  array[4, 1, 7, 3, 2, 6, 5],
  'the discovery search view orders deterministically by rank, tier, date and id'
);
select is(
  (select completeness_tier from public.v_auction_sales_discovery_search
    where id = 'c4620000-1000-4000-8000-000000000001'),
  1::smallint,
  'a Découverte account reads the tier of a well documented sale'
);
select is(
  (select completeness_tier from public.v_auction_sales_discovery_search
    where id = 'c4620000-1000-4000-8000-000000000003'),
  0::smallint,
  'a Découverte account reads the low tier of a sale not evaluated yet'
);
select is(
  (select count(*) from public.v_auction_sales_app_search where city = 'ClassementC462'),
  0::bigint,
  'the Découverte account still cannot read the full catalogue view'
);
select throws_ok(
  $$select score from public.auction_sale_listing_completeness$$,
  '42501',
  'permission denied for table auction_sale_listing_completeness',
  'a Découverte account cannot read the score table either'
);
reset role;

-- La RPC publique v3 ---------------------------------------------------------------------------
set local role anon;

select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v3(p_city => 'ClassementC462', p_limit => 20)
  ),
  array[4, 1, 7, 3, 2, 6, 5],
  'v3 default order: located sales first, then tier, then sale date, then id'
);
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v3(
      p_city => 'ClassementC462', p_sort => 'completeness_desc', p_limit => 20
    )
  ),
  array[4, 1, 7, 3, 2, 6, 5],
  'v3 completeness_desc is the default order'
);
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v3(
      p_city => 'ClassementC462', p_sort => 'score_desc', p_limit => 20
    )
  ),
  array[4, 1, 7, 3, 2, 6, 5],
  'v3 treats the investment score sort like the default (the score is not public)'
);
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v3(
      p_city => 'ClassementC462', p_sort => 'date_asc', p_limit => 20
    )
  ),
  array[3, 2, 4, 1, 7, 6, 5],
  'v3 date_asc ignores the tier (located sales first, then by date)'
);
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v3(
      p_city => 'ClassementC462', p_sort => 'price_desc', p_limit => 20
    )
  ),
  array[7, 6, 4, 3, 2, 1, 5],
  'v3 price_desc ignores the tier'
);
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v3(
      p_city => 'ClassementC462', p_limit => 3, p_offset => 3
    )
  ),
  array[3, 2, 6],
  'pagination continues the default order without skipping or repeating a sale'
);
select is(
  (
    select array_agg(completeness_tier order by right(id::text, 1))
    from public.search_auction_sales_preview_v3(p_city => 'ClassementC462', p_limit => 20)
  ),
  array[1, 0, 0, 1, 1, 0, 1]::smallint[],
  'the RPC returns the tier of each sale, 0 when it is not evaluated'
);
select is(
  (
    select array_agg(key order by key)
    from jsonb_object_keys(
      (select to_jsonb(result)
        from public.search_auction_sales_preview_v3(p_city => 'ClassementC462', p_limit => 1) result)
    ) key
  ),
  (select array_agg(key order by key) from unnest(array[
    'id','starting_price_eur','total_count','sale_venue_type','sale_verification_status',
    'city','department','property_type','sale_date','app_surface_m2','app_surface_kind',
    'rooms_count','bedrooms_count','bathrooms_count','latitude','longitude','thumbnail_url',
    'completeness_tier'
  ]) key),
  'the RPC adds the tier to the approved public fields, and nothing else'
);

-- La RPC publique v4 ---------------------------------------------------------------------------
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v4(
      p_city => 'ClassementC462', p_min_sale_date => '2099-01-01',
      p_max_sale_date => '2099-12-31', p_limit => 20
    )
  ),
  array[4, 1, 7, 3, 2, 6, 5],
  'v4 default order is the same, within the date range'
);
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v4(
      p_city => 'ClassementC462', p_sort => 'date_asc', p_min_sale_date => '2099-01-01',
      p_max_sale_date => '2099-12-31', p_limit => 20
    )
  ),
  array[3, 2, 4, 1, 7, 6, 5],
  'v4 date_asc ignores the tier'
);
select is(
  (
    select array_agg(completeness_tier order by right(id::text, 1))
    from public.search_auction_sales_preview_v4(p_city => 'ClassementC462', p_limit => 20)
  ),
  array[1, 0, 0, 1, 1, 0, 1]::smallint[],
  'v4 returns the same tiers'
);
select throws_ok(
  $$select score from public.auction_sale_listing_completeness$$,
  '42501',
  'permission denied for table auction_sale_listing_completeness',
  'anon cannot read the score table'
);
select throws_ok(
  $$select * from public.search_auction_sales_preview_v3(p_min_score => 70)$$,
  '42501',
  'Protected filters are not available in the public preview.',
  'the protected filters stay closed in v3'
);
reset role;

-- Suppression d'une vente: son score disparaît avec elle ----------------------------------------
-- La garde de suppression exige le pont Outcome Graph; la cascade supprime ensuite le score.
do $$ begin perform public.bridge_auction_sales_to_outcome_graph(); end $$;
delete from public.auction_sales where id = 'c4620000-1000-4000-8000-000000000002';
select is(
  (select count(*) from public.auction_sale_listing_completeness
    where sale_id = 'c4620000-1000-4000-8000-000000000002'),
  0::bigint,
  'deleting a sale deletes its completeness row (cascade)'
);
select is(
  (select count(*) from public.auction_sale_listing_completeness
    where sale_id::text like 'c4620000-1000-4000-8000-%'),
  4::bigint,
  'the other completeness rows are kept'
);

-- Réévaluation: un upsert de service_role met à jour le palier ------------------------------------
set local role service_role;
select lives_ok(
  $$insert into public.auction_sale_listing_completeness
      (sale_id, score, tier, policy_version, input_fingerprint)
    values ('c4620000-1000-4000-8000-000000000003', 77.0, 1, 'completeness-tier-v1', 'fp-3')
    on conflict (sale_id) do update
      set score = excluded.score, tier = excluded.tier,
          policy_version = excluded.policy_version,
          input_fingerprint = excluded.input_fingerprint, evaluated_at = now()$$,
  'service_role can upsert a completeness row'
);
reset role;
set local role anon;
select is(
  (
    select array_agg(right(id::text, 1)::int)
    from public.search_auction_sales_preview_v3(p_city => 'ClassementC462', p_limit => 20)
  ),
  array[3, 4, 1, 7, 6, 5],
  'once evaluated into the high tier, the former unevaluated sale moves up and sorts by date (s3 first)'
);
reset role;

select * from finish();
rollback;
