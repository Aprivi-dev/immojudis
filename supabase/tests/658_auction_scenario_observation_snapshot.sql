-- « Scénarios d'enchères » (migration 20261031100800) : les lectures de l'application passent par
-- app_private.auction_scenario_observation_snapshot, une copie de la vue des lots remplie par
-- app_private.refresh_auction_scenario_observations(p_force).
begin;
select plan(9);

create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'tj_snapshot'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 20))::date as sale_date
  from generate_series(1, 12) n
  union all
  select 'tj_snapshot_other', 'house', 30000, 30000, (current_date - (n * 10))::date
  from generate_series(1, 10) n
) sample;

select is(
  app_private.refresh_auction_scenario_observations(true),
  22,
  'a forced refresh copies every lot of the view'
);
select is(
  (select observation_count from app_private.auction_scenario_snapshot_state),
  22,
  'the refresh records how many lots it copied'
);
select is(
  app_private.refresh_auction_scenario_observations(false),
  null::integer,
  'an unforced refresh does nothing when the copy is less than a day old'
);

-- The view changes: the application keeps reading the copy until the next refresh.
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'tj_snapshot'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - 5)::date as sale_date
) sample;

select is(
  (public.get_court_auction_scenarios('tj_snapshot', 45000)->'scenarios'->>'court_sample')::int,
  12,
  'the scenarios read the copy, not the view'
);
select is(
  (select (court->'licitor'->>'sample')::int
   from jsonb_array_elements(public.get_court_auction_summaries()) court
   where court->>'court_code' = 'tj_snapshot'),
  12,
  'the tribunal averages read the copy too'
);

update app_private.auction_scenario_snapshot_state set refreshed_at = statement_timestamp() - interval '2 days';
select is(
  app_private.refresh_auction_scenario_observations(false),
  1,
  'an unforced refresh runs once the copy is more than a day old'
);
select is(
  (public.get_court_auction_scenarios('tj_snapshot', 45000)->'scenarios'->>'court_sample')::int,
  1,
  'after the refresh the scenarios follow the view'
);

select ok(
  has_function_privilege('service_role', 'app_private.refresh_auction_scenario_observations(boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.refresh_auction_scenario_observations(boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.refresh_auction_scenario_observations(boolean)', 'EXECUTE'),
  'only the server refreshes the copy'
);
select ok(
  has_table_privilege('service_role', 'app_private.auction_scenario_observation_snapshot', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.auction_scenario_observation_snapshot', 'SELECT')
  and not has_table_privilege('anon', 'app_private.auction_scenario_observation_snapshot', 'SELECT')
  and not has_table_privilege('service_role', 'app_private.auction_scenario_observation_snapshot', 'INSERT'),
  'the copy is read by the server only and written by the refresh only'
);

select * from finish();
rollback;
