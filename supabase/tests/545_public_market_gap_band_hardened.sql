-- Fiche publique : porte durcie de la bande d'écart au marché, raisons d'insuffisance séparées et
-- bien occupé (migration 20261029120000).
--   * au moins 6 ventes comparables avec la méthode jackknife locale, au moins 8 sinon ;
--   * échantillon effectif d'au moins 5 ;
--   * largeur (P90 - P10) / P50 d'au plus 60 % ;
--   * rayon d'au plus 1 000 m pour un appartement urbain (et un type ou une zone inconnus), 2 000 m
--     pour une maison, un immeuble, un local, un terrain ou un appartement rural ; rayon absent : refusé ;
--   * 'occupied' à la place de 'under' pour un bien occupé, loué ou occupé par son propriétaire ;
--   * 'insufficient_surface', 'insufficient_type' et 'insufficient' distinguent les raisons.
begin;

select plan(31);

-- Fixtures -------------------------------------------------------------------------------------
-- Valeur centrale 120 000 ; fourchette 100 000 à 140 000 (largeur 33 %), sauf indication contraire.
-- Mise à prix 115 000 (dans la fourchette) sauf indication contraire. Appartement urbain, rayon 300 m,
-- 8 ventes, échantillon effectif 5, intervalle de repli fixe, sauf indication contraire.
--   1  jackknife, 6 ventes                          -> near
--   2  jackknife, 5 ventes                          -> insufficient
--   3  repli fixe, 7 ventes                         -> insufficient
--   4  repli fixe, 8 ventes                         -> near
--   5  repli fixe, 8 ventes, échantillon effectif 4,9 -> insufficient
--   6  largeur de 60 % pile                         -> near
--   7  largeur de 60,5 %                            -> insufficient
--   8  appartement urbain, rayon 1 000 m            -> near
--   9  appartement urbain, rayon 1 001 m            -> insufficient
--   10 appartement rural, rayon 2 000 m             -> near
--   11 appartement rural, rayon 2 001 m             -> insufficient
--   12 maison urbaine, rayon 2 000 m                -> near
--   13 maison urbaine, rayon 2 001 m                -> insufficient
--   14 rayon absent de l'estimation                 -> insufficient
--   15 type de bien absent, rayon 1 500 m           -> insufficient
--   16 type de bien absent, rayon 1 000 m           -> near
--   17 mise à prix sous la fourchette, bien libre   -> under
--   18 sous la fourchette, bien occupé              -> occupied
--   19 sous la fourchette, bien loué                -> occupied
--   20 sous la fourchette, occupé par le propriétaire -> occupied
--   21 sous la fourchette, occupation inconnue ('unknown') -> occupancy_unknown (migration 20261101190000)
--   22 sous la fourchette, occupation non renseignée -> occupancy_unknown
--   23 dans la fourchette, bien occupé              -> occupied (migration 20261101190000)
--   24 au-dessus de la fourchette, bien occupé      -> occupied
-- Les biens 1 à 16, 30 et 31 sont libres : depuis la migration 20261101190000, une bande n'est dite
-- que pour un bien libre.
--   25 bien occupé, échantillon effectif 3          -> insufficient
--   26 estimation échouée : surface manquante       -> insufficient_surface
--   27 estimation échouée : type non pris en charge -> insufficient_type
--   28 estimation échouée : aucune vente comparable -> insufficient
--   29 estimation échouée sans code                 -> insufficient
--   30 modèle LightGBM actif, 7 ventes              -> insufficient
--   31 modèle LightGBM actif, 8 ventes              -> near
insert into public.valuation_model_versions (id, model_key, version, segment, framework, status)
values
  ('c5450000-2000-4000-8000-000000000001', 'c545_model', 'active-1', 'apartment', 'lightgbm_quantile', 'active');

insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, occupancy_status, raw_payload
)
select
  ('c5450000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'public-market-gap-band-hardened-test', 'https://example.test/c545/' || f.n,
  'Hardened band title ' || f.n, 'Adresse privée ' || f.n, 'Hardville' || f.n, '33', 'apartment',
  f.price, now() + interval '30 days', 50, 'habitable', 2, 1, 1, 'upcoming', 44.837812, -0.579234,
  'tribunal', 'pending', f.occupancy, '{}'::jsonb
from (
  values
    (1, 115000, 'vacant'::text), (2, 115000, 'vacant'), (3, 115000, 'vacant'), (4, 115000, 'vacant'),
    (5, 115000, 'vacant'), (6, 115000, 'vacant'), (7, 115000, 'vacant'), (8, 115000, 'vacant'),
    (9, 115000, 'vacant'), (10, 115000, 'vacant'), (11, 115000, 'vacant'), (12, 115000, 'vacant'),
    (13, 115000, 'vacant'), (14, 115000, 'vacant'), (15, 115000, 'vacant'), (16, 115000, 'vacant'),
    (17, 60000, 'vacant'), (18, 60000, 'occupied'), (19, 60000, 'rented'),
    (20, 60000, 'owner_occupied'), (21, 60000, 'unknown'), (22, 60000, null),
    (23, 115000, 'occupied'), (24, 150000, 'occupied'), (25, 60000, 'occupied'),
    (26, 60000, null), (27, 60000, null), (28, 60000, null), (29, 60000, null),
    (30, 115000, 'vacant'), (31, 115000, 'vacant')
) as f(n, price, occupancy);

-- Les estimations : le déclencheur d'ajout d'une vente a créé une ligne « pending » pour chaque vente
-- à venir.
update public.auction_sale_market_estimates e
set status = x.status,
    actionable = x.status = 'ready',
    comparable_count = x.comps,
    value_p10_eur = x.p10,
    value_p50_eur = case when x.status = 'ready' then 120000 end,
    value_p90_eur = x.p90,
    engine_kind = x.engine,
    model_version_id = x.model,
    segment = x.segment,
    last_error_code = x.err,
    estimate = case
      when x.status = 'ready' then jsonb_strip_nulls(jsonb_build_object(
        'effectiveSampleSize', x.ess,
        'radiusM', x.radius,
        'areaKind', x.area,
        'predictionInterval', jsonb_build_object('method', x.method)
      ))
    end,
    computed_at = now()
from (
  values
    (1, 'ready', 6, 5.0, 100000, 140000, 800::numeric, 'urban'::text, 'local_jackknife'::text, 'apartment'::text, null::text, 'comparable_ensemble'::text, null::uuid),
    (2, 'ready', 5, 5.0, 100000, 140000, 800, 'urban', 'local_jackknife', 'apartment', null, 'comparable_ensemble', null),
    (3, 'ready', 7, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (4, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (5, 'ready', 8, 4.9, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (6, 'ready', 8, 5.0, 90000, 162000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (7, 'ready', 8, 5.0, 90000, 162600, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (8, 'ready', 8, 5.0, 100000, 140000, 1000, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (9, 'ready', 8, 5.0, 100000, 140000, 1001, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (10, 'ready', 8, 5.0, 100000, 140000, 2000, 'rural', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (11, 'ready', 8, 5.0, 100000, 140000, 2001, 'rural', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (12, 'ready', 8, 5.0, 100000, 140000, 2000, 'urban', 'segment_fallback', 'house', null, 'comparable_ensemble', null),
    (13, 'ready', 8, 5.0, 100000, 140000, 2001, 'urban', 'segment_fallback', 'house', null, 'comparable_ensemble', null),
    (14, 'ready', 8, 5.0, 100000, 140000, null, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (15, 'ready', 8, 5.0, 100000, 140000, 1500, null, 'segment_fallback', null, null, 'comparable_ensemble', null),
    (16, 'ready', 8, 5.0, 100000, 140000, 1000, null, 'segment_fallback', null, null, 'comparable_ensemble', null),
    (17, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (18, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (19, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (20, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (21, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (22, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (23, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (24, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (25, 'ready', 8, 3.0, 100000, 140000, 300, 'urban', 'segment_fallback', 'apartment', null, 'comparable_ensemble', null),
    (26, 'insufficient_data', 0, null, null, null, null, null, null, null, 'MISSING_SURFACE', null, null),
    (27, 'insufficient_data', 0, null, null, null, null, null, null, null, 'UNSUPPORTED_SEGMENT', null, null),
    (28, 'insufficient_data', 2, null, null, null, null, null, null, null, 'NO_COMPARABLES', null, null),
    (29, 'insufficient_data', 0, null, null, null, null, null, null, null, null, null, null),
    (30, 'ready', 7, 5.0, 100000, 140000, 300, 'urban', 'hybrid_mapie_cqr', 'apartment', null, 'hybrid_lightgbm', 'c5450000-2000-4000-8000-000000000001'::uuid),
    (31, 'ready', 8, 5.0, 100000, 140000, 300, 'urban', 'hybrid_mapie_cqr', 'apartment', null, 'hybrid_lightgbm', 'c5450000-2000-4000-8000-000000000001'::uuid)
) as x(n, status, comps, ess, p10, p90, radius, area, method, segment, err, engine, model)
where e.auction_sale_id = ('c5450000-1000-4000-8000-' || lpad(x.n::text, 12, '0'))::uuid;

-- Les fonctions -------------------------------------------------------------------------------
select has_function(
  'public', 'get_public_sale_market_gap_band', array['uuid'],
  'the public market gap band RPC still exists'
);
select has_function(
  'app_private', 'is_occupied_occupancy_status', array['text'],
  'the occupancy rule exists'
);
select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'app_private.get_public_sale_market_gap_band(uuid)'::regprocedure),
  'the read is still a security definer function with an empty search_path'
);
select ok(
  (select proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'app_private.is_occupied_occupancy_status(text)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'app_private.public_market_gap_band_max_radius_m(text, text)'::regprocedure),
  'the two new rules have an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.is_occupied_occupancy_status(text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.is_occupied_occupancy_status(text)', 'execute')
  and not has_function_privilege('anon', 'app_private.public_market_gap_band_max_radius_m(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.public_market_gap_band_max_radius_m(text, text)', 'execute'),
  'the new rules are not callable by a visitor or an account'
);
select is(
  (select pg_get_functiondef('app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
          ~ 's\.(address|latitude|longitude|lawyer_contact|documents|visit_dates|raw_payload|description|raw_text)\b'),
  false,
  'address, coordinates, contacts, documents, visit text and the raw announcement stay out'
);
select ok(
  (select pg_get_functiondef('app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
          ~ 'auction_sale_is_publicly_visible\(')
  and (select pg_get_functiondef('app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
          ~ 'local_jackknife')
  and (select pg_get_functiondef('app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
          ~ '<= 0\.60'),
  'the public visibility rule, the jackknife method and the 60 % width bound decide'
);

-- Le rayon maximal ----------------------------------------------------------------------------
select is(
  app_private.public_market_gap_band_max_radius_m('apartment', 'urban'), 1000,
  'an urban apartment: 1 000 m'
);
select is(
  app_private.public_market_gap_band_max_radius_m('apartment', null), 1000,
  'an apartment of unknown area: the strictest bound'
);
select is(
  app_private.public_market_gap_band_max_radius_m('apartment', 'rural'), 2000,
  'a rural apartment: 2 000 m'
);
select is(
  array[
    app_private.public_market_gap_band_max_radius_m('house', 'urban'),
    app_private.public_market_gap_band_max_radius_m('house', 'rural'),
    app_private.public_market_gap_band_max_radius_m('building', 'urban'),
    app_private.public_market_gap_band_max_radius_m('commercial', 'rural'),
    app_private.public_market_gap_band_max_radius_m('land', 'urban')
  ],
  array[2000, 2000, 2000, 2000, 2000],
  'a house and the other types: 2 000 m'
);
select is(
  app_private.public_market_gap_band_max_radius_m(null, null), 1000,
  'an unknown type: the strictest bound'
);

-- L'occupation ---------------------------------------------------------------------------------
select is(
  (select array_agg(app_private.is_occupied_occupancy_status(v) order by ord)
     from unnest(array['occupied', 'rented', 'owner_occupied', 'squatted', 'Loué',
                       'Occupé par le propriétaire', ' OCCUPIED ']) with ordinality as t(v, ord)),
  array[true, true, true, true, true, true, true],
  'occupied, rented, owner-occupied and squatted properties are occupied'
);
select is(
  (select array_agg(app_private.is_occupied_occupancy_status(v) order by ord)
     from unnest(array['vacant', 'unknown', '', null, 'Libre', 'Inoccupé']) with ordinality as t(v, ord)),
  array[false, false, false, false, false, false],
  'vacant, unknown and missing occupancy are not occupied'
);

-- Le comportement ------------------------------------------------------------------------------
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[1, 2]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'with the jackknife method, 6 comparable sales pass and 5 do not'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[4, 3]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'without it, 8 comparable sales pass and 7 do not'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[4, 5]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'an effective sample of 5 passes, 4,9 does not'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[6, 7]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'an interval of 60 % of the value passes, 60,5 % does not'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[8, 9]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'an urban apartment: 1 000 m passes, 1 001 m does not'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[10, 11]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'a rural apartment: 2 000 m passes, 2 001 m does not'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[12, 13]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'a house: 2 000 m passes, 2 001 m does not'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[14, 15, 16]) with ordinality as t(n, ord)),
  array['insufficient', 'insufficient', 'near'],
  'a missing radius is refused, an unknown type gets the strictest bound'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[31, 30]) with ordinality as t(n, ord)),
  array['near', 'insufficient'],
  'the interval of the LightGBM model is not the jackknife one: 8 comparable sales are needed'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[17, 21, 22]) with ordinality as t(n, ord)),
  array['under', 'occupancy_unknown', 'occupancy_unknown'],
  'a vacant property stays under, one of unknown occupancy gets no band'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[18, 19, 20]) with ordinality as t(n, ord)),
  array['occupied', 'occupied', 'occupied'],
  'an occupied, rented or owner-occupied property is never under: occupied'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[23, 24]) with ordinality as t(n, ord)),
  array['occupied', 'occupied'],
  'an occupied property gets no band, whichever it would have been'
);
select is(
  (select public.get_public_sale_market_gap_band('c5450000-1000-4000-8000-000000000025')),
  'insufficient',
  'an occupied property with an unreliable estimate says so, not occupied'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5450000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by ord)
     from unnest(array[26, 27, 28, 29]) with ordinality as t(n, ord)),
  array['insufficient_surface', 'insufficient_type', 'insufficient', 'insufficient'],
  'the reasons are told apart: surface, type, then not enough reliable sales'
);
select is(
  (select public.get_public_sale_market_gap_band('c5450000-1000-4000-8000-0000000000ff')), null,
  'an unknown sale gives nothing'
);

-- Un visiteur sans compte ----------------------------------------------------------------------
set local role anon;
select is(
  (select public.get_public_sale_market_gap_band('c5450000-1000-4000-8000-000000000018')), 'occupied',
  'a signed-out visitor reads the occupied answer'
);
select throws_ok(
  $$select count(*) from public.auction_sale_market_estimates$$,
  '42501',
  null,
  'a signed-out visitor still cannot read the estimates themselves'
);
reset role;

select * from finish();
rollback;
