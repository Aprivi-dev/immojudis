begin;
select plan(13);

-- The observations view reads the private Licitor gate; replace it with a known sample.
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  -- TJ test: 24 lots of the 35–50 k€ band, all sold at 2.5×.
  select 'tj_scenario_test'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 20))::date as sale_date
  from generate_series(1, 24) n
  union all
  -- Elsewhere: 76 lots of the same band, sold at the starting price.
  select 'tj_other', 'house', 40000, 40000, (current_date - (n * 10))::date
  from generate_series(1, 76) n
  union all
  -- A second court with only 4 comparable lots, sold at 3.5×.
  select 'tj_small', 'apartment', 38000, 133000, (current_date - 30)::date
  from generate_series(1, 4) n
  union all
  -- Too old for the three-year window.
  select 'tj_scenario_test', 'apartment', 40000, 400000, (current_date - interval '4 years')::date
  union all
  -- Another band: never compared with a 40 k€ starting price.
  select 'tj_scenario_test', 'house', 300000, 300000, (current_date - 15)::date
) sample;

select is(app_private.starting_price_band(15000), 1::smallint, 'band: under 20 k€');
select is(app_private.starting_price_band(200000), 7::smallint, 'band: 200 k€ and more');

select is(
  (app_private.court_auction_scenarios('tj_scenario_test', 45000)->>'court_sample')::int,
  24,
  'the court sample keeps the same band and the last three years only'
);
select is(
  (app_private.court_auction_scenarios('tj_scenario_test', 45000)->>'national_sample')::int,
  104,
  'the national sample is the same band everywhere'
);
select is(
  app_private.court_auction_scenarios('tj_scenario_test', 45000)->>'price_scope',
  'court',
  'a court with 20 comparable lots or more gives its own price range'
);
select is(
  (app_private.court_auction_scenarios('tj_scenario_test', 45000)->'ratio_quartiles'->>'q50')::numeric,
  2.5,
  'the median ratio is the court''s'
);
select ok(
  abs((
    select sum((scenario->>'probability')::numeric)
    from jsonb_array_elements(app_private.court_auction_scenarios('tj_scenario_test', 45000)->'scenarios') scenario
  ) - 1) < 0.001,
  'the five scenarios add up to one'
);
-- 24 lots at 2.5× (up_to_3) blended with the national rate 24/104 at weight 15.
select is(
  (select (scenario->>'probability')::numeric
   from jsonb_array_elements(app_private.court_auction_scenarios('tj_scenario_test', 45000)->'scenarios') scenario
   where scenario->>'key' = 'up_to_3'),
  round((24 + 15 * 24::numeric / 104) / (24 + 15), 4),
  'a probability blends the court with the national rate'
);
select is(
  app_private.court_auction_scenarios('tj_small', 45000)->>'price_scope',
  'national',
  'a court with few comparable lots borrows the national price range'
);
select is(
  app_private.court_auction_scenarios('tj_scenario_test', null),
  null::jsonb,
  'no starting price, no scenario'
);

insert into public.dvf_court_adjudications
  (mutation_id, mutation_date, insee_code, department, court_code, property_type, built_surface_m2, local_count, price_eur, source_year)
values
  ('2025-1', '2025-06-01', '93008', '93', 'tj_scenario_test', 'apartment', 50, 1, 150000, 2025),
  ('2025-2', '2025-05-01', '93008', '93', 'tj_scenario_test', 'apartment', 40, 1, 100000, 2025),
  ('2021-1', '2021-01-01', '93008', '93', 'tj_scenario_test', 'apartment', 40, 1, 999999, 2021);

select is(
  (app_private.court_auction_history('tj_scenario_test')->'dvf'->>'sample')::int,
  2,
  'DVF keeps the three years before the latest published mutation'
);
select is(
  (app_private.court_auction_history('tj_scenario_test')->'licitor'->>'mean_starting_price')::numeric,
  round((24 * 40000 + 300000)::numeric / 25),
  'the court history averages every band of the last three years'
);

select ok(
  not has_function_privilege('authenticated', 'public.get_court_auction_scenarios(text, numeric, text)', 'execute')
    and not has_function_privilege('anon', 'public.get_court_auction_summaries()', 'execute')
    and not has_table_privilege('authenticated', 'public.dvf_court_adjudications', 'select'),
  'scenarios are served by the Analyse API only'
);

select * from finish();
rollback;
