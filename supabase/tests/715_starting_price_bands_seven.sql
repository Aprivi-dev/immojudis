-- « Scénarios d'enchères » (migration 20261102110000) : sept tranches de mise à prix (moins de 20 k€, 20-35 k€,
-- 35-50 k€, 50-75 k€, 75-100 k€, 100-200 k€, 200 k€ et plus). Le test vérifie la fonction de tranche, ses droits,
-- le cloisonnement des échantillons par tranche, et que le reste du calcul ne bouge pas : seuil national de 30
-- ventes comparables, repli sur le taux national sous 10 ventes du tribunal, lissage de 10 à 29, fiabilité.
begin;
select plan(35);

-- 1. La fonction de tranche, bornes comprises (le test de parité vitest relit les mêmes bornes dans la migration).
select is(app_private.starting_price_band(null), null::smallint, 'band: no price, no band');
select is(app_private.starting_price_band(0), null::smallint, 'band: a zero price has no band');
select is(app_private.starting_price_band(-5), null::smallint, 'band: a negative price has no band');
select is(app_private.starting_price_band(1000), 1::smallint, 'band 1 starts at 1 000 €');
select is(app_private.starting_price_band(19999.99), 1::smallint, 'band 1: just under 20 000 €');
select is(app_private.starting_price_band(20000), 2::smallint, 'band 2 starts at 20 000 €');
select is(app_private.starting_price_band(34999.99), 2::smallint, 'band 2: just under 35 000 €');
select is(app_private.starting_price_band(35000), 3::smallint, 'band 3 starts at 35 000 €');
select is(app_private.starting_price_band(49999.99), 3::smallint, 'band 3: just under 50 000 €');
select is(app_private.starting_price_band(50000), 4::smallint, 'band 4 starts at 50 000 €');
select is(app_private.starting_price_band(74999.99), 4::smallint, 'band 4: just under 75 000 €');
select is(app_private.starting_price_band(75000), 5::smallint, 'band 5 starts at 75 000 €');
select is(app_private.starting_price_band(99999.99), 5::smallint, 'band 5: just under 100 000 €');
select is(app_private.starting_price_band(100000), 6::smallint, 'band 6 starts at 100 000 €');
select is(app_private.starting_price_band(199999.99), 6::smallint, 'band 6: just under 200 000 €');
select is(app_private.starting_price_band(200000), 7::smallint, 'band 7 starts at 200 000 €');
select is(app_private.starting_price_band(5000000), 7::smallint, 'band 7 has no upper bound');

-- 2. Droits identiques à ceux de 20261031100600 : service_role seul.
select ok(
  has_function_privilege('service_role', 'app_private.starting_price_band(numeric)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.starting_price_band(numeric)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.starting_price_band(numeric)', 'EXECUTE'),
  'starting_price_band keeps its rights: service_role only'
);

-- 3. Échantillon de lots (trois dernières années), un tribunal principal « tj_715 » et un autre « tj_715_other ».
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  -- Tranche 2 (20 000 à 35 000 €) : 30 lots du tribunal principal, adjugés à 2 fois la mise à prix.
  select 'tj_715'::text as court_code, 'apartment'::text as property_type,
         30000::numeric as starting_price_eur, 60000::numeric as hammer_price_eur,
         (current_date - (n * 10))::date as sale_date
  from generate_series(1, 30) n
  union all
  -- Tranche 3 (35 000 à 50 000 €) : 5 lots du tribunal principal, 25 ailleurs, adjugés à 3 fois la mise à prix.
  select 'tj_715', 'apartment', 40000, 120000, (current_date - (n * 10))::date
  from generate_series(1, 5) n
  union all
  select 'tj_715_other', 'apartment', 40000, 120000, (current_date - (n * 10))::date
  from generate_series(1, 25) n
  union all
  -- Tranche 4 (50 000 à 75 000 €) : 12 lots du tribunal principal adjugés à 2 fois la mise à prix, 18 ailleurs
  -- adjugés à la mise à prix.
  select 'tj_715', 'apartment', 60000, 120000, (current_date - (n * 10))::date
  from generate_series(1, 12) n
  union all
  select 'tj_715_other', 'apartment', 60000, 60000, (current_date - (n * 10))::date
  from generate_series(1, 18) n
  union all
  -- Tranche 5 (75 000 à 100 000 €) : 29 lots en tout (9 + 20), un de moins que le seuil national.
  select 'tj_715', 'apartment', 90000, 180000, (current_date - (n * 10))::date
  from generate_series(1, 9) n
  union all
  select 'tj_715_other', 'apartment', 90000, 180000, (current_date - (n * 10))::date
  from generate_series(1, 20) n
  union all
  -- Tranche 6 (100 000 à 200 000 €) : 30 lots en tout, exactement le seuil national : 9 du tribunal principal
  -- adjugés à 3 fois la mise à prix, 21 ailleurs adjugés à la mise à prix.
  select 'tj_715', 'apartment', 150000, 450000, (current_date - (n * 10))::date
  from generate_series(1, 9) n
  union all
  select 'tj_715_other', 'apartment', 150000, 150000, (current_date - (n * 10))::date
  from generate_series(1, 21) n
  union all
  -- Aux bornes : 34 999 € (tranche 2) et 35 000 € (tranche 3), pour un tribunal à part.
  select 'tj_715_edge', 'apartment', 34999, 70000, (current_date - 20)::date
  union all
  select 'tj_715_edge', 'apartment', 35000, 70000, (current_date - 30)::date
) sample;

-- 3a. Les échantillons sont cloisonnés par tranche.
select is(
  (app_private.court_auction_scenarios('tj_715', 25000, 'housing'::text)->>'band')::int,
  2,
  'a 25 000 € starting price reads band 2'
);
select is(
  (app_private.court_auction_scenarios('tj_715', 25000, 'housing'::text)->>'national_sample')::int,
  31,
  'band 2 compares the 30 lots of 20-35 k€ and the 34 999 € lot, nothing from the 35-50 k€ band'
);
select is(
  (app_private.court_auction_scenarios('tj_715', 45000, 'housing'::text)->>'national_sample')::int,
  31,
  'band 3 compares the 30 lots of 35-50 k€ and the 35 000 € lot, nothing from the 20-35 k€ band'
);
select is(
  (app_private.court_auction_scenarios('tj_715_edge', 30000, 'housing'::text)->>'court_sample')
  || '/' ||
  (app_private.court_auction_scenarios('tj_715_edge', 40000, 'housing'::text)->>'court_sample'),
  '1/1',
  '34 999 € falls in band 2 and 35 000 € in band 3'
);

-- 3b. Seuil national : 30 ventes comparables au moins, aucun chiffre en dessous.
select is(
  app_private.court_auction_scenarios('tj_715', 90000, 'housing'::text) - 'band',
  jsonb_build_object(
    'status', 'insufficient', 'court_sample', 9, 'national_sample', 29, 'minimum_national_sample', 30
  ),
  '29 comparable sales in the band: no figure, only the sample sizes'
);
select is(
  app_private.court_auction_scenarios('tj_715', 150000, 'housing'::text)->>'status',
  'ok',
  '30 comparable sales in the band: figures'
);

-- 3c. Repli sous 10 ventes du tribunal, annoncé comme tel, parts nationales sans mélange.
select is(
  app_private.court_auction_scenarios('tj_715', 150000, 'housing'::text)->>'basis',
  'national',
  '9 sales at the court: the national rate is used and says so'
);
select is(
  app_private.court_auction_scenarios('tj_715', 150000, 'housing'::text)->>'reliability',
  'low',
  '9 sales at the court: low reliability'
);
select is(
  (select (scenario->>'probability')::numeric
   from jsonb_array_elements(app_private.court_auction_scenarios('tj_715', 150000, 'housing'::text)->'scenarios') scenario
   where scenario->>'key' = 'near_start'),
  round(21::numeric / 30, 4),
  'under 10 sales at the court the probabilities are the national ones, not blended with the court''s 9 lots'
);

-- 3d. De 10 à 29 ventes du tribunal : lissage au poids 15, fiabilité moyenne.
select is(
  app_private.court_auction_scenarios('tj_715', 60000, 'housing'::text)->>'basis',
  'court',
  '12 sales at the court: the court rate is blended with the national one'
);
select is(
  app_private.court_auction_scenarios('tj_715', 60000, 'housing'::text)->>'reliability',
  'medium',
  '10 to 29 sales at the court: medium reliability'
);
select is(
  (select (scenario->>'probability')::numeric
   from jsonb_array_elements(app_private.court_auction_scenarios('tj_715', 60000, 'housing'::text)->'scenarios') scenario
   where scenario->>'key' = 'up_to_3'),
  round((12 + 15 * 12::numeric / 30) / (12 + 15), 4),
  'from 10 sales a probability blends the court (weight 15) with the national rate'
);

-- 3e. 30 ventes du tribunal ou plus : bonne fiabilité ; aucune confusion avec la tranche voisine.
select is(
  app_private.court_auction_scenarios('tj_715', 25000, 'housing'::text)->>'reliability',
  'good',
  '30 sales at the court or more: good reliability'
);
select is(
  (app_private.court_auction_scenarios('tj_715', 25000, 'housing'::text)->'ratio_quartiles'->>'q50')::numeric,
  2.0,
  'the median ratio of band 2 is the one of its own lots (2), not of the 35-50 k€ lots (3)'
);

-- 3f. Le reste de la règle ne change pas : aucun scénario sous 1 000 €, 1 000 € est dans la tranche 1.
select is(
  app_private.court_auction_scenarios('tj_715', 999, 'housing'::text),
  null::jsonb,
  'no scenario under 1 000 € of starting price'
);
select is(
  (app_private.court_auction_scenarios('tj_715', 1000, 'housing'::text)->>'band')::int,
  1,
  'a starting price of 1 000 € is in band 1'
);

-- 4. La fonction publique, appelée en service_role (la fonction appelante n'est pas security definer : elle a
-- besoin du droit sur starting_price_band, voir 20261031100600).
select app_private.refresh_auction_scenario_observations(true);
set local role service_role;
select is(
  (public.get_court_auction_scenarios('tj_715', 60000, 'housing'::text)->'scenarios'->>'band')::int,
  4,
  'the public function reports the new band as service_role'
);
reset role;

select * from finish();
rollback;
