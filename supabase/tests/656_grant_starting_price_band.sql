-- « Scénarios d'enchères » (migration 20261031100600) : app_private.starting_price_band est appelée par
-- app_private.court_auction_scenarios, qui n'est pas security definer et s'exécute donc avec les droits
-- de service_role. Sans EXECUTE pour service_role, chaque appel de get_court_auction_scenarios échouait
-- avec « permission denied for function starting_price_band ». Le test 456 tourne en postgres et ne
-- pouvait pas le voir : celui-ci appelle la fonction publique en service_role, sur des lots connus, et
-- vérifie le résultat (et non plus seulement que l'appel ne lève pas d'erreur).
begin;

select plan(7);

select ok(
  has_function_privilege('service_role', 'app_private.starting_price_band(numeric)', 'EXECUTE'),
  'service_role can execute starting_price_band'
);
select ok(
  not has_function_privilege('anon', 'app_private.starting_price_band(numeric)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.starting_price_band(numeric)', 'EXECUTE'),
  'anon and authenticated still cannot execute starting_price_band'
);

-- 40 lots du tribunal de la tranche 35 000 à 50 000 €, tous adjugés à 2,5 fois la mise à prix.
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'pgtap_656_court'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 10))::date as sale_date
  from generate_series(1, 40) n
) sample;
select app_private.refresh_auction_scenario_observations(true);

set local role service_role;

select lives_ok(
  $$select public.get_court_auction_scenarios('pgtap_656_court', 45000)$$,
  'get_court_auction_scenarios runs as service_role'
);
select is(
  (public.get_court_auction_scenarios('pgtap_656_court', 45000)->'scenarios'->>'court_sample')::int,
  40,
  'service_role reads the 40 lots of the court through the band function'
);
select is(
  (public.get_court_auction_scenarios('pgtap_656_court', 45000)->'scenarios'->>'band')::int,
  3,
  'the scenarios report the band of the starting price'
);
select is(
  (public.get_court_auction_scenarios('pgtap_656_court', 45000)->'scenarios'->'ratio_quartiles'->>'q50')::numeric,
  2.5,
  'the median ratio of the 40 lots is 2.5'
);
select is(
  app_private.starting_price_band(45000),
  3::smallint,
  'service_role reads the starting price band'
);

reset role;

select * from finish();
rollback;
