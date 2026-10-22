-- « Scénarios d'enchères » (migration 20261031100700) : get_court_auction_scenarios lit les lots une
-- seule fois et les passe aux deux fonctions privées ; le résultat doit rester celui des signatures
-- d'origine, qui lisent la vue elles-mêmes. Le rattachement au tribunal est joint une fois sur le
-- libellé au lieu d'une jointure latérale par lot.
begin;
select plan(5);

create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'tj_single_scan'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 20))::date as sale_date
  from generate_series(1, 24) n
  union all
  select 'tj_elsewhere', 'house', 30000, 30000, (current_date - (n * 10))::date
  from generate_series(1, 76) n
  union all
  select 'tj_single_scan', 'apartment', 40000, 400000, (current_date - interval '4 years')::date
) sample;

select is(
  public.get_court_auction_scenarios('tj_single_scan', 45000)->'scenarios',
  app_private.court_auction_scenarios('tj_single_scan', 45000),
  'the single read gives the same scenarios as the original signature'
);
select is(
  public.get_court_auction_scenarios('tj_single_scan', 45000)->'history',
  app_private.court_auction_history('tj_single_scan'),
  'the single read gives the same court history as the original signature'
);
select is(
  (public.get_court_auction_scenarios('tj_single_scan', 45000)->'scenarios'->>'court_sample')::int,
  24,
  'lots older than three years stay out of the scenarios'
);

select ok(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private'
         and p.proname in ('court_auction_scenarios', 'court_auction_history')
         and has_function_privilege('service_role', p.oid, 'EXECUTE')
         and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and not has_function_privilege('anon', p.oid, 'EXECUTE')) = 4,
  'the four private functions are for service_role only'
);

set local role service_role;
select lives_ok(
  $$select public.get_court_auction_scenarios('tj_single_scan', 45000)$$,
  'get_court_auction_scenarios runs as service_role'
);
reset role;

select * from finish();
rollback;
