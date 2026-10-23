-- Fiche publique : une bande d'écart au marché n'est dite que pour un bien libre (migration
-- 20261101190000).
--   * 'occupied' pour un bien occupé, loué, occupé par son propriétaire ou squatté, quelle que soit la bande
--     (avant : seulement à la place de 'under') ;
--   * 'occupancy_unknown' pour une occupation inconnue, non renseignée ou illisible, quelle que soit la
--     bande (avant : 'under' sans réserve) ;
--   * 'under', 'near', 'above' pour un bien libre, vacant ou inoccupé ;
--   * une estimation qui ne passe pas la porte reste 'insufficient', et un écart aberrant reste sans bande,
--     même pour un bien occupé ou d'occupation inconnue.
begin;

select plan(13);

-- Fixtures -------------------------------------------------------------------------------------
-- La contrainte auction_sales_occupancy_status_check n'admet que les valeurs normalisées : les
-- libellés libres (« Inoccupé », « Libre ») sont testés directement sur is_vacant_occupancy_status.
-- Estimation fiable : 8 ventes comparables, échantillon effectif 5, fourchette 100 000 à 140 000,
-- valeur centrale 120 000, rayon 300 m, appartement urbain, intervalle de repli fixe.
--   1  libre, sous la fourchette (60 000)            -> under
--   2  libre, dans la fourchette (115 000)           -> near
--   3  libre, au-dessus de la fourchette (150 000)   -> above
--   4  libre, sous la fourchette (second cas)      -> under
--   5  occupation inconnue ('unknown'), sous         -> occupancy_unknown
--   6  occupation non renseignée (null), dans        -> occupancy_unknown
--   7  occupation inconnue, au-dessus             -> occupancy_unknown
--   8  occupé, sous                                  -> occupied
--   9  loué, dans la fourchette                      -> occupied
--   10 occupé par le propriétaire, au-dessus         -> occupied
--   11 squatté, sous                                 -> occupied
--   12 occupation inconnue, estimation non fiable (3 ventes) -> insufficient
--   13 occupation inconnue, écart aberrant (20 000)  -> null
--   14 occupé, écart aberrant (300 000)              -> null
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, occupancy_status, raw_payload
)
select
  ('c7050000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'public-market-gap-band-vacant-only-test', 'https://example.test/c705/' || f.n,
  'Vacant only title ' || f.n, 'Adresse privée ' || f.n, 'Vacantville' || f.n, '33', 'apartment',
  f.price, now() + interval '30 days', 50, 'habitable', 2, 1, 1, 'upcoming', 44.837812, -0.579234,
  'tribunal', 'pending', f.occupancy, '{}'::jsonb
from (
  values
    (1, 60000, 'vacant'::text), (2, 115000, 'vacant'), (3, 150000, 'vacant'),
    (4, 60000, 'vacant'), (5, 60000, 'unknown'), (6, 115000, null),
    (7, 150000, 'unknown'), (8, 60000, 'occupied'), (9, 115000, 'rented'),
    (10, 150000, 'owner_occupied'), (11, 60000, 'squatted'), (12, 60000, 'unknown'),
    (13, 20000, 'unknown'), (14, 300000, 'occupied')
) as f(n, price, occupancy);

-- Le déclencheur d'ajout d'une vente a créé une ligne « pending » par vente à venir.
update public.auction_sale_market_estimates e
set status = 'ready',
    actionable = true,
    comparable_count = case when e.auction_sale_id = 'c7050000-1000-4000-8000-000000000012' then 3 else 8 end,
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
where e.auction_sale_id::text like 'c7050000-1000-4000-8000-%';

-- La règle d'occupation ------------------------------------------------------------------------
select has_function(
  'app_private', 'is_vacant_occupancy_status', array['text'],
  'the vacant rule exists'
);
select ok(
  (select proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'app_private.is_vacant_occupancy_status(text)'::regprocedure)
  and not has_function_privilege('anon', 'app_private.is_vacant_occupancy_status(text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.is_vacant_occupancy_status(text)', 'execute'),
  'the vacant rule has an empty search_path and is not callable by a visitor or an account'
);
select is(
  (select array_agg(app_private.is_vacant_occupancy_status(v) order by ord)
     from unnest(array['vacant', 'Libre', 'Inoccupé', ' VACANT ']) with ordinality as t(v, ord)),
  array[true, true, true, true],
  'vacant, free and unoccupied properties are vacant'
);
select is(
  (select array_agg(app_private.is_vacant_occupancy_status(v) order by ord)
     from unnest(array['occupied', 'rented', 'owner_occupied', 'squatted', 'unknown', '', null, 'à voir']) with ordinality as t(v, ord)),
  array[false, false, false, false, false, false, false, false],
  'occupied, unknown, empty and unreadable occupancy are not vacant'
);

-- Le comportement ------------------------------------------------------------------------------
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c7050000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[1, 2, 3, 4]) with ordinality as t(n, ord)),
  array['under', 'near', 'above', 'under'],
  'a vacant property keeps its band'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c7050000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[5, 6, 7]) with ordinality as t(n, ord)),
  array['occupancy_unknown', 'occupancy_unknown', 'occupancy_unknown'],
  'an unknown or missing occupancy gets no band, whichever it would have been'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c7050000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[8, 9, 10, 11]) with ordinality as t(n, ord)),
  array['occupied', 'occupied', 'occupied', 'occupied'],
  'an occupied, rented, owner-occupied or squatted property gets occupied, whichever band it would have been'
);
select is(
  (select public.get_public_sale_market_gap_band('c7050000-1000-4000-8000-000000000012')),
  'insufficient',
  'an unknown occupancy with an unreliable estimate says the estimate is not reliable'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c7050000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[13, 14]) with ordinality as t(n, ord)),
  array[null, null]::text[],
  'an implausible gap stays without a band, occupied or not'
);

-- Le filtre « sous la fourchette » -------------------------------------------------------------
select is(
  (select array_agg(id order by id)
     from public.list_public_sale_ids_under_market_range() as id
    where id::text like 'c7050000-1000-4000-8000-%'),
  array[
    'c7050000-1000-4000-8000-000000000001'::uuid,
    'c7050000-1000-4000-8000-000000000004'::uuid
  ],
  'the under-range list holds only vacant properties'
);

-- Le contrat -----------------------------------------------------------------------------------
select is(
  pg_get_function_result('public.get_public_sale_market_gap_band(uuid)'::regprocedure),
  'text',
  'the contract is still a single word'
);
select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'app_private.get_public_sale_market_gap_band(uuid)'::regprocedure),
  'the read is still a security definer function with an empty search_path'
);

set local role anon;
select is(
  (select public.get_public_sale_market_gap_band('c7050000-1000-4000-8000-000000000005')),
  'occupancy_unknown',
  'a signed-out visitor reads the occupancy_unknown answer'
);
reset role;

select * from finish();
rollback;
