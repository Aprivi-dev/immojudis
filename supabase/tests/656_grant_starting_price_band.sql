-- « Scénarios d'enchères » (migration 20261031100600) : app_private.starting_price_band est appelée par
-- app_private.court_auction_scenarios, qui n'est pas security definer et s'exécute donc avec les droits
-- de service_role. Sans EXECUTE pour service_role, chaque appel de get_court_auction_scenarios échouait
-- avec « permission denied for function starting_price_band ». Le test 456 tourne en postgres et ne
-- pouvait pas le voir : celui-ci appelle la fonction publique en service_role.
begin;

select plan(4);

select ok(
  has_function_privilege('service_role', 'app_private.starting_price_band(numeric)', 'EXECUTE'),
  'service_role can execute starting_price_band'
);
select ok(
  not has_function_privilege('anon', 'app_private.starting_price_band(numeric)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.starting_price_band(numeric)', 'EXECUTE'),
  'anon and authenticated still cannot execute starting_price_band'
);

set local role service_role;

select lives_ok(
  $$select public.get_court_auction_scenarios('pgtap_656_court', 45000)$$,
  'get_court_auction_scenarios runs as service_role'
);
select is(
  app_private.starting_price_band(45000),
  2::smallint,
  'service_role reads the starting price band'
);

reset role;

select * from finish();
rollback;
