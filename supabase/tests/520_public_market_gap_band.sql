-- Fiche publique : écart entre la mise à prix et le marché local en trois bandes
-- (migration 20261028200000).
--   * la fonction publique est accessible sans compte, la fonction privée est SECURITY DEFINER à
--     search_path fixé, l'enveloppe publique est SECURITY INVOKER ;
--   * la sortie est un mot (under / near / above / insufficient) ou null : aucun montant, aucun
--     pourcentage, aucun champ privé ne sort ;
--   * la bande compare la mise à prix à la fourchette de valeur estimée (sous P10, dans la
--     fourchette, au-dessus de P90) ;
--   * la porte de qualité du code est respectée : estimation « actionable », au moins 4 ventes
--     comparables, échantillon effectif d'au moins 3, intervalle exploitable (largeur d'au plus
--     110 %), modèle toujours actif pour une estimation LightGBM, statut « ready » ;
--   * le garde-fou d'écart de market-gap.ts (au-delà de 70 % sous la valeur ou de 50 % au-dessus :
--     aucune bande), arrondi comme Math.round ;
--   * seules les ventes visibles du catalogue public, au tribunal ou chez le notaire, sont concernées.
begin;

select plan(38);

-- Fixtures -------------------------------------------------------------------------------------
-- n : numéro de la vente ; price : mise à prix ; venue : type de vente ; status : statut de la vente.
--   1  mise à prix sous la fourchette (P10 = 100 000)           -> under
--   2  mise à prix dans la fourchette                             -> near
--   3  mise à prix au-dessus de la fourchette (P90 = 140 000)     -> above
--   4  écart de 83 % sous la valeur                               -> null (aberrant)
--   5  écart de 150 % au-dessus de la valeur                      -> null (aberrant)
--   6  estimation non « actionable »                              -> insufficient
--   7  seulement 3 ventes comparables                             -> insufficient
--   8  statut insufficient_data                                   -> insufficient
--   9  estimation pas encore calculée (pending)                   -> null
--   10 vente chez le notaire                                      -> near
--   11 cession de l'État                                          -> null
--   12 vente retirée (hors du catalogue public)                   -> null
--   13 modèle LightGBM retiré du registre                         -> insufficient
--   14 modèle LightGBM toujours actif                             -> under
--   15 intervalle trop large (116 %)                              -> insufficient
--   16 mise à prix = P10 pile                                     -> near
--   17 mise à prix = P90 pile                                     -> near
--   18 écart de -50,4 % (arrondi à -50)                           -> above
--   19 écart de -50,6 % (arrondi à -51)                           -> null
--   20 écart de 70,4 % (arrondi à 70)                             -> under
--   21 écart de 70,6 % (arrondi à 71)                             -> null
--   22 échantillon effectif de 2,9                                -> insufficient
--   23 mise à prix inconnue (0)                                   -> null
insert into public.valuation_model_versions (id, model_key, version, segment, framework, status)
values
  ('c5200000-2000-4000-8000-000000000001', 'c520_model', 'retired-1', 'house', 'lightgbm_quantile', 'retired'),
  ('c5200000-2000-4000-8000-000000000002', 'c520_model', 'active-1', 'apartment', 'lightgbm_quantile', 'active');

insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload
)
select
  ('c5200000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'public-market-gap-band-test', 'https://example.test/c520/' || f.n,
  'Market gap title ' || f.n, 'Adresse privée ' || f.n, 'Gapville' || f.n, '33', 'apartment',
  f.price, now() + interval '30 days', 50, 'habitable', 2, 1, 1, f.status, 44.837812, -0.579234,
  f.venue, 'pending', '{}'::jsonb
from (
  values
    (1, 60000, 'tribunal', 'upcoming'),
    (2, 115000, 'tribunal', 'upcoming'),
    (3, 150000, 'tribunal', 'upcoming'),
    (4, 20000, 'tribunal', 'upcoming'),
    (5, 300000, 'tribunal', 'upcoming'),
    (6, 60000, 'tribunal', 'upcoming'),
    (7, 60000, 'tribunal', 'upcoming'),
    (8, 60000, 'tribunal', 'upcoming'),
    (9, 60000, 'tribunal', 'upcoming'),
    (10, 110000, 'notary', 'upcoming'),
    (11, 60000, 'state', 'upcoming'),
    (12, 60000, 'tribunal', 'withdrawn'),
    (13, 60000, 'tribunal', 'upcoming'),
    (14, 60000, 'tribunal', 'upcoming'),
    (15, 60000, 'tribunal', 'upcoming'),
    (16, 100000, 'tribunal', 'upcoming'),
    (17, 140000, 'tribunal', 'upcoming'),
    (18, 180480, 'tribunal', 'upcoming'),
    (19, 180720, 'tribunal', 'upcoming'),
    (20, 35520, 'tribunal', 'upcoming'),
    (21, 35280, 'tribunal', 'upcoming'),
    (22, 60000, 'tribunal', 'upcoming'),
    (23, 0, 'tribunal', 'upcoming')
) as f(n, price, venue, status);

-- Les estimations : le déclencheur d'ajout d'une vente a créé une ligne « pending » pour chaque vente
-- à venir. Valeur centrale 120 000, fourchette 100 000 à 140 000, sauf indication contraire.
update public.auction_sale_market_estimates e
set status = x.status,
    actionable = x.actionable,
    comparable_count = x.comps,
    value_p10_eur = x.p10,
    value_p50_eur = 120000,
    value_p90_eur = x.p90,
    engine_kind = x.engine,
    model_version_id = x.model,
    estimate = jsonb_build_object('effectiveSampleSize', x.ess),
    computed_at = now()
from (
  values
    (1, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null::uuid, 5.0),
    (2, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (3, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (4, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (5, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (6, 'ready', false, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (7, 'ready', true, 3, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (8, 'insufficient_data', false, 1, null, null, null, null, null),
    (10, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (11, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (13, 'ready', true, 8, 100000, 140000, 'hybrid_lightgbm', 'c5200000-2000-4000-8000-000000000001'::uuid, 5.0),
    (14, 'ready', true, 8, 100000, 140000, 'hybrid_lightgbm', 'c5200000-2000-4000-8000-000000000002'::uuid, 5.0),
    (15, 'ready', true, 8, 40000, 180000, 'comparable_ensemble', null, 5.0),
    (16, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (17, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (18, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (19, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (20, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (21, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0),
    (22, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 2.9),
    (23, 'ready', true, 8, 100000, 140000, 'comparable_ensemble', null, 5.0)
) as x(n, status, actionable, comps, p10, p90, engine, model, ess)
where e.auction_sale_id = ('c5200000-1000-4000-8000-' || lpad(x.n::text, 12, '0'))::uuid;

-- La vente retirée n'a plus de ligne d'estimation (le déclencheur la supprime) : on lui en donne
-- une, pour prouver que c'est bien la visibilité publique qui l'écarte.
insert into public.auction_sale_market_estimates (
  auction_sale_id, status, input_fingerprint, estimate, actionable, comparable_count,
  value_p10_eur, value_p50_eur, value_p90_eur, computed_at
)
values (
  'c5200000-1000-4000-8000-000000000012', 'ready', 'test', '{"effectiveSampleSize": 5}'::jsonb,
  true, 8, 100000, 120000, 140000, now()
);

-- Les fonctions -------------------------------------------------------------------------------
select has_function(
  'public', 'get_public_sale_market_gap_band', array['uuid'],
  'the public market gap band RPC exists'
);
select ok(
  has_function_privilege('anon', 'public.get_public_sale_market_gap_band(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_sale_market_gap_band(uuid)', 'execute'),
  'signed-out visitors and accounts may read the band'
);
select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
  and (select coalesce(proconfig::text, '') like '%search_path=%'
         from pg_proc where oid = 'app_private.get_public_sale_market_gap_band(uuid)'::regprocedure),
  'the read is a security definer function with a fixed search_path'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.get_public_sale_market_gap_band(uuid)'::regprocedure),
  'the public wrapper is security invoker'
);
select ok(
  (select proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'public.get_public_sale_market_gap_band(uuid)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'app_private.get_public_sale_market_gap_band(uuid)'::regprocedure),
  'the wrapper and the read have an empty search_path'
);
select is(
  pg_get_function_result('public.get_public_sale_market_gap_band(uuid)'::regprocedure),
  'text',
  'the contract is a single word: no amount, no percentage'
);
select ok(
  not has_function_privilege('anon', 'app_private.public_market_gap_band(numeric, numeric, numeric, numeric)', 'execute'),
  'the pure rule is not callable by a signed-out visitor'
);

-- Le contrat -----------------------------------------------------------------------------------
select is(
  (select pg_get_functiondef('app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
          ~ 's\.(address|latitude|longitude|lawyer_contact|documents|visit_dates|raw_payload|description|raw_text)\b'),
  false,
  'address, coordinates, contacts, documents, visit text and the raw announcement stay out'
);
select is(
  (select pg_get_functiondef('app_private.get_public_sale_market_gap_band(uuid)'::regprocedure)
          ~ 'auction_sale_is_publicly_visible\('),
  true,
  'the public catalogue visibility rule decides which sales are concerned'
);

-- La règle seule --------------------------------------------------------------------------------
select is(
  app_private.public_market_gap_band(60000, 100000, 120000, 140000), 'under',
  'below the whole range: under'
);
select is(
  app_private.public_market_gap_band(100000, 100000, 120000, 140000), 'near',
  'at the low end of the range: near'
);
select is(
  app_private.public_market_gap_band(140000, 100000, 120000, 140000), 'near',
  'at the high end of the range: near'
);
select is(
  app_private.public_market_gap_band(150000, 100000, 120000, 140000), 'above',
  'above the whole range: above'
);
select is(
  app_private.public_market_gap_band(60000, 130000, 120000, 140000), null,
  'an inconsistent range gives no band'
);

-- Le comportement ------------------------------------------------------------------------------
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000001')), 'under',
  'a starting price under the whole range is under the market'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000002')), 'near',
  'a starting price inside the range is near the market'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000003')), 'above',
  'a starting price over the whole range is above the market'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000004')), null,
  'a gap of 83 % under the value gives no band'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000005')), null,
  'a gap of 150 % over the value gives no band'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000006')), 'insufficient',
  'an estimate that is not actionable is not reliable'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000007')), 'insufficient',
  'fewer than 4 comparable sales is not reliable'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000008')), 'insufficient',
  'an attempted estimate without enough data says so'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000009')), null,
  'an estimate not computed yet says nothing'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000010')), 'near',
  'a sale at the notary is concerned too'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000011')), null,
  'a State disposal has a published price, not a starting price: no band'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000012')), null,
  'a sale outside the public catalogue gives nothing'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000013')), 'insufficient',
  'an estimate of a model that is no longer active is not reliable'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000014')), 'under',
  'an estimate of the active model is kept'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000015')), 'insufficient',
  'a range wider than 110 % of the value is not reliable'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5200000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by n)
     from unnest(array[16, 17]) as n),
  array['near', 'near'],
  'the edges of the range belong to near'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5200000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by n)
     from unnest(array[18, 19]) as n),
  array['above', null],
  'a gap of -50,4 % rounds to -50 (kept), -50,6 % to -51 (no band), like Math.round'
);
select is(
  (select array_agg(public.get_public_sale_market_gap_band(
     ('c5200000-1000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) order by n)
     from unnest(array[20, 21]) as n),
  array['under', null],
  'a gap of 70,4 % rounds to 70 (kept), 70,6 % to 71 (no band), like Math.round'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000022')), 'insufficient',
  'an effective sample under 3 is not reliable'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000023')), null,
  'a missing starting price gives nothing'
);
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-0000000000ff')), null,
  'an unknown sale gives nothing'
);

-- Une estimation qui change repasse en « pending » : la bande disparaît jusqu'au recalcul.
update public.auction_sales
set app_surface_m2 = 51
where id = 'c5200000-1000-4000-8000-000000000001';
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000001')), null,
  'after a change of the sale, the band waits for the new estimate'
);

-- Un visiteur sans compte ----------------------------------------------------------------------
set local role anon;
select is(
  (select public.get_public_sale_market_gap_band('c5200000-1000-4000-8000-000000000002')), 'near',
  'a signed-out visitor reads the band'
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
