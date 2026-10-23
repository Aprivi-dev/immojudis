-- « Scénarios d'enchères » (migration 20261101120000) : le cliché des lots refuse d'être remplacé par un jeu
-- de moins de la moitié du précédent (sauf forçage explicite), et les index inutiles / manquants sont réglés.
begin;
select plan(13);

create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'tj_guard'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 2))::date as sale_date
  from generate_series(1, 300) n
) sample;

select is(
  app_private.refresh_auction_scenario_observations(true),
  300,
  'a first refresh copies the 300 lots'
);

-- La vue se vide presque entièrement : 20 lots sur 300 (moins de la moitié).
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'tj_guard'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 2))::date as sale_date
  from generate_series(1, 20) n
) sample;

select throws_ok(
  $$select app_private.refresh_auction_scenario_observations(true)$$,
  '55000',
  null,
  'a refresh that would keep less than half of the lots is refused'
);
select is(
  (select count(*)::int from app_private.auction_scenario_observation_snapshot),
  300,
  'the refused refresh leaves the previous copy in place'
);
select is(
  (select observation_count from app_private.auction_scenario_snapshot_state),
  300,
  'the refused refresh does not change the recorded count'
);
select throws_ok(
  $$select app_private.refresh_auction_scenario_observations(true, false)$$,
  '55000',
  null,
  'the unforced shrink is refused too'
);

-- Exactement la moitié passe (150 sur 300), le seuil est « moins de la moitié ».
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'tj_guard'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 2))::date as sale_date
  from generate_series(1, 150) n
) sample;
select is(
  app_private.refresh_auction_scenario_observations(true),
  150,
  'half of the previous lots is accepted'
);

-- Forçage explicite : 150 -> 10 lots.
create or replace view app_private.auction_scenario_observations as
select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
from (
  select 'tj_guard'::text as court_code, 'apartment'::text as property_type,
         40000::numeric as starting_price_eur, 100000::numeric as hammer_price_eur,
         (current_date - (n * 2))::date as sale_date
  from generate_series(1, 10) n
) sample;
select is(
  app_private.refresh_auction_scenario_observations(true, true),
  10,
  'an explicit p_allow_shrink replaces the copy by a much smaller one'
);

-- Sous 100 lots avant le remplacement, les variations sont normales.
select is(
  app_private.refresh_auction_scenario_observations(true),
  10,
  'a small copy (under 100 lots) is never refused'
);

select ok(
  has_function_privilege('service_role', 'app_private.refresh_auction_scenario_observations(boolean, boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.refresh_auction_scenario_observations(boolean, boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.refresh_auction_scenario_observations(boolean, boolean)', 'EXECUTE'),
  'only the server refreshes the copy'
);
select is(
  (select count(*)::int from pg_proc procedure_row
   join pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
   where schema_row.nspname = 'app_private'
     and procedure_row.proname = 'refresh_auction_scenario_observations'),
  1,
  'the one-argument signature is gone (a call with one argument is not ambiguous)'
);
select ok(
  (select procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[]
   from pg_proc procedure_row
   where procedure_row.oid = 'app_private.refresh_auction_scenario_observations(boolean, boolean)'::regprocedure),
  'the refresh stays SECURITY DEFINER with an empty search_path'
);

select ok(
  not exists (
    select 1 from pg_indexes
    where schemaname = 'app_private'
      and tablename = 'auction_scenario_observation_snapshot'
      and indexname = 'auction_scenario_observation_snapshot_sale_date_idx'
  ),
  'the useless sale_date index of the copy is dropped'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'dvf_court_adjudications'
      and indexname = 'dvf_court_adjudications_mutation_date_idx'
  ),
  'max(mutation_date) of the DVF adjudications has an index'
);

select * from finish();
rollback;
