-- Filtre de /sales « Mise à prix sous la fourchette des ventes comparables » (20261030110000) : la fonction
-- rend les identifiants des ventes dont la bande publique est 'under', jamais un bien occupé, jamais une
-- estimation insuffisante, jamais 'near' ni 'above' ; elle est ouverte à un visiteur, ne rend aucun chiffre.
begin;

select plan(10);

-- Fixtures -------------------------------------------------------------------------------------
-- Estimation fiable : 8 ventes comparables, échantillon effectif 5, fourchette 100 000 à 140 000 (largeur
-- 33 %), valeur centrale 120 000, rayon 300 m, appartement urbain, intervalle de repli fixe.
--   1  mise à prix 60 000, bien libre                -> under      (rendue)
--   2  mise à prix 60 000, occupation inconnue       -> occupancy_unknown (non rendue, migration 20261101190000)
--   3  mise à prix 60 000, bien occupé               -> occupied   (non rendue)
--   4  mise à prix 60 000, bien loué                 -> occupied   (non rendue)
--   5  mise à prix 115 000                           -> near       (non rendue)
--   6  mise à prix 150 000                           -> above      (non rendue)
--   7  mise à prix 60 000, 5 ventes comparables      -> insufficient (non rendue)
--   8  mise à prix 60 000, estimation en attente     -> aucune bande (non rendue)
--   9  mise à prix 60 000, vente de l'État           -> aucune bande (non rendue)
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, occupancy_status, raw_payload
)
select
  ('c6200000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'under-range-test', 'https://example.test/c620/' || f.n,
  'Under range title ' || f.n, 'Adresse privée ' || f.n, 'Underville' || f.n, '33', 'apartment',
  f.price, now() + interval '30 days', 50, 'habitable', 2, 1, 1, 'upcoming', 44.837812, -0.579234,
  f.venue, 'pending', f.occupancy, '{}'::jsonb
from (
  values
    (1, 60000, 'vacant'::text, 'tribunal'::text), (2, 60000, null, 'tribunal'),
    (3, 60000, 'occupied', 'tribunal'), (4, 60000, 'rented', 'tribunal'),
    (5, 115000, 'vacant', 'tribunal'), (6, 150000, 'vacant', 'tribunal'),
    (7, 60000, 'vacant', 'tribunal'), (8, 60000, 'vacant', 'tribunal'),
    (9, 60000, 'vacant', 'state')
) as f(n, price, occupancy, venue);

-- Le déclencheur d'ajout d'une vente a créé une ligne « pending » par vente à venir.
update public.auction_sale_market_estimates e
set status = 'ready',
    actionable = true,
    comparable_count = x.comps,
    value_p10_eur = 100000,
    value_p50_eur = 120000,
    value_p90_eur = 140000,
    engine_kind = 'comparable_ensemble',
    segment = 'apartment',
    estimate = jsonb_build_object(
      'effectiveSampleSize', 5.0,
      'radiusM', 300,
      'areaKind', 'urban',
      'predictionInterval', jsonb_build_object('method', 'segment_fallback')
    ),
    computed_at = now()
from (
  values (1, 8), (2, 8), (3, 8), (4, 8), (5, 8), (6, 8), (7, 5), (9, 8)
) as x(n, comps)
where e.auction_sale_id = ('c6200000-1000-4000-8000-' || lpad(x.n::text, 12, '0'))::uuid;

-- Structure ------------------------------------------------------------------------------------
select has_function(
  'public', 'list_public_sale_ids_under_market_range', array[]::text[],
  'the public list function exists'
);
select ok(
  (select prosecdef from pg_proc where oid = 'app_private.list_public_sale_ids_under_market_range()'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'app_private.list_public_sale_ids_under_market_range()'::regprocedure),
  'the read is a security definer function with an empty search_path'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.list_public_sale_ids_under_market_range()'::regprocedure),
  'the public wrapper is security invoker'
);
select ok(
  has_function_privilege('anon', 'public.list_public_sale_ids_under_market_range()', 'execute')
  and has_function_privilege('authenticated', 'public.list_public_sale_ids_under_market_range()', 'execute')
  and not has_function_privilege('public', 'public.list_public_sale_ids_under_market_range()', 'execute'),
  'a visitor and an account can call the public wrapper, public itself cannot'
);
select is(
  pg_get_function_result('public.list_public_sale_ids_under_market_range()'::regprocedure),
  'SETOF uuid',
  'only identifiers come out: no price, no range, no gap'
);

-- Comportement ---------------------------------------------------------------------------------
select is(
  (select array_agg(id order by id)
     from public.list_public_sale_ids_under_market_range() as id
    where id::text like 'c6200000-1000-4000-8000-%'),
  array['c6200000-1000-4000-8000-000000000001'::uuid],
  'only the vacant sale under the range is listed'
);
select is(
  (select count(*)::integer
     from public.list_public_sale_ids_under_market_range() as id
    where id in (
      'c6200000-1000-4000-8000-000000000002', 'c6200000-1000-4000-8000-000000000003',
      'c6200000-1000-4000-8000-000000000004'
    )),
  0,
  'a property of unknown occupancy, an occupied one or a rented one is never listed, even under the range'
);
select is(
  (select count(*)::integer
     from public.list_public_sale_ids_under_market_range() as id
    where id in (
      'c6200000-1000-4000-8000-000000000005', 'c6200000-1000-4000-8000-000000000006'
    )),
  0,
  'a start price within or above the range is not listed'
);
select is(
  (select count(*)::integer
     from public.list_public_sale_ids_under_market_range() as id
    where id in (
      'c6200000-1000-4000-8000-000000000007', 'c6200000-1000-4000-8000-000000000008',
      'c6200000-1000-4000-8000-000000000009'
    )),
  0,
  'an insufficient estimate, a pending one and a State sale are not listed'
);

-- Un visiteur sans compte ----------------------------------------------------------------------
set local role anon;
select is(
  (select count(*)::integer
     from public.list_public_sale_ids_under_market_range() as id
    where id::text like 'c6200000-1000-4000-8000-%'),
  1,
  'a visitor without an account gets the same identifier'
);
reset role;

select * from finish();
rollback;
