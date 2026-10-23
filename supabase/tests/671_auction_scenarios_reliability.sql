-- « Scénarios d'enchères » (migration 20261101120100) : effectif minimal et niveau de fiabilité, nature du bien,
-- seuil de mise à prix, date du cliché, médianes par tribunal.
begin;
select plan(24);

-- Tranche 20 000 à 50 000 € (40 000 et 30 000 €), trois dernières années.
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  -- 35 appartements du tribunal principal, adjugés à 2 fois la mise à prix.
  select 'tj_671'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 80000::numeric as hammer_price_eur,
         (current_date - (n * 10))::date as sale_date
  from generate_series(1, 35) n
  union all
  -- 20 parkings du même tribunal, adjugés à 5 fois la mise à prix.
  select 'tj_671', 'parking', 30000, 150000, (current_date - (n * 10))::date
  from generate_series(1, 20) n
  union all
  -- 12 appartements d'un tribunal moyen.
  select 'tj_671_mid', 'apartment', 40000, 80000, (current_date - (n * 10))::date
  from generate_series(1, 12) n
  union all
  -- 5 maisons d'un petit tribunal, adjugées à 3 fois la mise à prix.
  select 'tj_671_small', 'house', 40000, 120000, (current_date - (n * 10))::date
  from generate_series(1, 5) n
  union all
  -- 40 maisons ailleurs, adjugées à la mise à prix.
  select 'tj_671_other', 'house', 40000, 40000, (current_date - (n * 5))::date
  from generate_series(1, 40) n
) sample;

select is(
  array[
    app_private.scenario_property_group('apartment'), app_private.scenario_property_group('studio'),
    app_private.scenario_property_group('house'), app_private.scenario_property_group('villa'),
    app_private.scenario_property_group('parking'), app_private.scenario_property_group('land'),
    app_private.scenario_property_group('commercial'), app_private.scenario_property_group('building'),
    app_private.scenario_property_group('other'), app_private.scenario_property_group(null)
  ],
  array['housing', 'housing', 'housing', 'housing', 'parking', 'land', 'commercial', null, null, null],
  'a property type belongs to one comparison group (building, mixed, other: none)'
);

-- Logement : 35 + 12 + 5 + 40 = 92 ventes nationales, 35 du tribunal.
select is(
  (app_private.court_auction_scenarios('tj_671', 45000, 'housing'::text)->>'national_sample')::int,
  92,
  'a housing sale is compared with housing lots only (the 20 parkings are left out)'
);
select is(
  (app_private.court_auction_scenarios('tj_671', 45000, 'housing'::text)->>'court_sample')::int,
  35,
  'the court sample leaves the parkings out too'
);
select is(
  (app_private.court_auction_scenarios('tj_671', 45000)->>'national_sample')::int,
  112,
  'without a property group every lot of the band is compared'
);
select is(
  app_private.court_auction_scenarios('tj_671', 45000, 'housing'::text)->>'reliability',
  'good',
  '30 comparable sales or more at the court: good reliability'
);
select is(
  app_private.court_auction_scenarios('tj_671', 45000, 'housing'::text)->>'basis',
  'court',
  'a court with 10 sales or more is blended with the national rate'
);
select is(
  app_private.court_auction_scenarios('tj_671_mid', 45000, 'housing'::text)->>'reliability',
  'medium',
  '10 to 29 comparable sales at the court: medium reliability'
);
select is(
  app_private.court_auction_scenarios('tj_671_small', 45000, 'housing'::text)->>'reliability',
  'low',
  'fewer than 10 comparable sales at the court: low reliability'
);
select is(
  app_private.court_auction_scenarios('tj_671_small', 45000, 'housing'::text)->>'basis',
  'national',
  'fewer than 10 sales at the court: the national rate is used and says so'
);
select is(
  (select (scenario->>'probability')::numeric
   from jsonb_array_elements(app_private.court_auction_scenarios('tj_671_small', 45000, 'housing'::text)->'scenarios') scenario
   where scenario->>'key' = 'near_start'),
  round(40::numeric / 92, 4),
  'under 10 sales at the court the probabilities are the national ones, not blended'
);
select ok(
  abs((
    select sum((scenario->>'probability')::numeric)
    from jsonb_array_elements(app_private.court_auction_scenarios('tj_671_small', 45000, 'housing'::text)->'scenarios') scenario
  ) - 1) < 0.001,
  'the national probabilities add up to one'
);
select is(
  (select (scenario->>'probability')::numeric
   from jsonb_array_elements(app_private.court_auction_scenarios('tj_671', 45000, 'housing'::text)->'scenarios') scenario
   where scenario->>'key' = 'up_to_3'),
  round((35 + 15 * 47::numeric / 92) / (35 + 15), 4),
  'from 10 sales a probability still blends the court with the national rate (weight 15)'
);

-- 20 parkings seulement : moins de 30 ventes nationales comparables, aucun chiffre.
select is(
  app_private.court_auction_scenarios('tj_671', 45000, 'parking'::text)->>'status',
  'insufficient',
  'under 30 comparable national sales there is no figure'
);
select is(
  app_private.court_auction_scenarios('tj_671', 45000, 'parking'::text) - 'band',
  jsonb_build_object(
    'status', 'insufficient', 'court_sample', 20, 'national_sample', 20, 'minimum_national_sample', 30
  ),
  'the insufficient state carries the sample sizes and no scenario'
);
select is(
  app_private.court_auction_scenarios('tj_671', 999, 'housing'::text),
  null::jsonb,
  'no scenario under 1 000 € of starting price'
);
select isnt(
  app_private.court_auction_scenarios('tj_671', 1000, 'housing'::text),
  null::jsonb,
  'a starting price of 1 000 € is not excluded by that rule'
);

-- La fonction publique lit le cliché et renvoie sa date.
select app_private.refresh_auction_scenario_observations(true);
select is(
  (public.get_court_auction_scenarios('tj_671', 45000, 'housing'::text)->'scenarios'->>'court_sample')::int,
  35,
  'the public function passes the property group down'
);
select is(
  (public.get_court_auction_scenarios('tj_671', 45000)->'scenarios'->>'court_sample')::int,
  55,
  'the property group is optional'
);
select is(
  (public.get_court_auction_scenarios('tj_671', 45000)->>'data_as_of')::timestamptz,
  (select refreshed_at from app_private.auction_scenario_snapshot_state),
  'the answer carries the date of the copy'
);

-- Médianes par tribunal (55 lots : 35 à 40 000 / 80 000 €, 20 à 30 000 / 150 000 €).
select is(
  (select court->'licitor'->>'median_starting_price'
   from jsonb_array_elements(public.get_court_auction_summaries()) court
   where court->>'court_code' = 'tj_671'),
  '40000',
  'the summaries carry the median starting price'
);
select is(
  (select court->'licitor'->>'median_hammer_price'
   from jsonb_array_elements(public.get_court_auction_summaries()) court
   where court->>'court_code' = 'tj_671'),
  '80000',
  'the summaries carry the median hammer price'
);
select ok(
  (select court->'licitor' ? 'mean_hammer_price'
   from jsonb_array_elements(public.get_court_auction_summaries()) court
   where court->>'court_code' = 'tj_671'),
  'the means stay in the summaries (public API contract)'
);

select ok(
  has_function_privilege('service_role', 'public.get_court_auction_scenarios(text, numeric, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_court_auction_scenarios(text, numeric, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_court_auction_scenarios(text, numeric, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.scenario_property_group(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.scenario_property_group(text)', 'EXECUTE')
  and (select count(*) from pg_proc procedure_row
       join pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
       where schema_row.nspname = 'public' and procedure_row.proname = 'get_court_auction_scenarios') = 1,
  'one public scenarios function, for the server only'
);

set local role service_role;
select lives_ok(
  $$select public.get_court_auction_scenarios('tj_671', 45000, 'housing'::text)$$,
  'the public function runs as service_role (callee grants)'
);
reset role;

select * from finish();
rollback;
