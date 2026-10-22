begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » : la lecture des lots Licitor (vue app_private.auction_scenario_observations,
-- qui passe par la porte statistique et le rattachement des tribunaux) coûte encore 3,5 à 6 s en
-- production après 20261031100700, pour un délai de 8 s par appel. Les lots ne changent que lorsque la
-- collecte Licitor en atteste de nouveaux : ils sont désormais recopiés dans une table, et les lectures
-- de l'application (scénarios d'une vente, moyennes par tribunal) ne lisent plus que cette table.
--
-- * app_private.auction_scenario_observation_snapshot : les colonnes de la vue, toutes années confondues
--   (la fenêtre de trois ans reste appliquée à la lecture, puisque la date du jour avance).
-- * app_private.refresh_auction_scenario_observations(p_force) : recopie la vue. Sans p_force, ne fait
--   rien si la dernière copie a moins d'un jour. Appelée par la collecte Licitor après chaque
--   attestation (services/data-pipeline/src/sources/licitor_history_refresh.py), forcée quand de
--   nouveaux lots ont été attestés, au plus une fois par jour sinon. Le verrou exclusif sur la table
--   sérialise deux copies simultanées sans bloquer les lectures, qui voient l'ancienne copie jusqu'au
--   commit.
-- * Les signatures app_private.court_auction_scenarios(text, numeric) et court_auction_history(text)
--   continuent de lire la vue elle-même (diagnostic, tests).
-- Les calculs et la forme du JSON ne changent pas ; tout reste réservé à service_role.

create table if not exists app_private.auction_scenario_observation_snapshot (
  court_code text,
  property_type text not null,
  starting_price_eur numeric not null,
  hammer_price_eur numeric not null,
  sale_date date not null
);

create index if not exists auction_scenario_observation_snapshot_sale_date_idx
  on app_private.auction_scenario_observation_snapshot (sale_date);

alter table app_private.auction_scenario_observation_snapshot enable row level security;
revoke all on table app_private.auction_scenario_observation_snapshot from public, anon, authenticated;
grant select on table app_private.auction_scenario_observation_snapshot to service_role;

create table if not exists app_private.auction_scenario_snapshot_state (
  singleton boolean primary key default true check (singleton),
  refreshed_at timestamptz not null,
  observation_count integer not null check (observation_count >= 0)
);

alter table app_private.auction_scenario_snapshot_state enable row level security;
revoke all on table app_private.auction_scenario_snapshot_state from public, anon, authenticated;
grant select on table app_private.auction_scenario_snapshot_state to service_role;

comment on table app_private.auction_scenario_observation_snapshot is
  'Copie de app_private.auction_scenario_observations lue par les scénarios d''enchères et les moyennes par tribunal. Remplie par app_private.refresh_auction_scenario_observations().';

create or replace function app_private.refresh_auction_scenario_observations(p_force boolean default true)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  if not p_force and exists (
    select 1
    from app_private.auction_scenario_snapshot_state state
    where state.refreshed_at > statement_timestamp() - interval '1 day'
  ) then
    return null;
  end if;

  lock table app_private.auction_scenario_observation_snapshot in exclusive mode;
  delete from app_private.auction_scenario_observation_snapshot;
  insert into app_private.auction_scenario_observation_snapshot (
    court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
  )
  select observation.court_code, observation.property_type, observation.starting_price_eur,
         observation.hammer_price_eur, observation.sale_date
  from app_private.auction_scenario_observations observation;
  get diagnostics v_count = row_count;

  insert into app_private.auction_scenario_snapshot_state (singleton, refreshed_at, observation_count)
  values (true, statement_timestamp(), v_count)
  on conflict (singleton) do update
    set refreshed_at = excluded.refreshed_at, observation_count = excluded.observation_count;
  return v_count;
end;
$function$;

revoke all on function app_private.refresh_auction_scenario_observations(boolean)
  from public, anon, authenticated;
grant execute on function app_private.refresh_auction_scenario_observations(boolean) to service_role;

create or replace function public.get_court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with recent as (
    select array(
      select (
        observation.court_code,
        observation.property_type,
        observation.starting_price_eur,
        observation.hammer_price_eur,
        observation.sale_date
      )::app_private.auction_scenario_observations
      from app_private.auction_scenario_observation_snapshot observation
      where observation.sale_date >= (current_date - interval '3 years')::date
        and observation.sale_date <= current_date
    ) as observations
  )
  select jsonb_build_object(
    'scenarios', app_private.court_auction_scenarios(p_court_code, p_starting_price, recent.observations),
    'history', app_private.court_auction_history(p_court_code, recent.observations)
  )
  from recent;
$function$;

-- Every court with enough history, for the tribunal comparison table.
create or replace function public.get_court_auction_summaries()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with lots as (
    select observation.*
    from app_private.auction_scenario_observation_snapshot observation
    where observation.court_code is not null
      and observation.sale_date >= (current_date - interval '3 years')::date
      and observation.sale_date <= current_date
  ),
  licitor as (
    select
      court_code,
      count(*) as sample,
      round(avg(starting_price_eur)) as mean_starting_price,
      round(avg(hammer_price_eur)) as mean_hammer_price,
      round(percentile_cont(0.5) within group (order by (hammer_price_eur / starting_price_eur)::double precision)::numeric, 3) as median_ratio,
      round(avg((hammer_price_eur >= 2 * starting_price_eur)::int), 4) as at_least_double_rate
    from lots
    group by court_code
  ),
  dvf_window as (
    select max(mutation_date) as last_date from public.dvf_court_adjudications
  ),
  dvf as (
    select
      adjudication.court_code,
      count(*) as sample,
      round(percentile_cont(0.5) within group (order by adjudication.price_eur::double precision)::numeric) as median_price
    from public.dvf_court_adjudications adjudication, dvf_window
    where adjudication.court_code is not null
      and adjudication.mutation_date > (dvf_window.last_date - interval '3 years')::date
    group by adjudication.court_code
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'court_code', courts.court_code,
      'court_name', coalesce(tribunal.canonical_name, courts.court_code),
      'licitor', case when licitor.sample >= 10 then jsonb_build_object(
        'sample', licitor.sample,
        'mean_starting_price', licitor.mean_starting_price,
        'mean_hammer_price', licitor.mean_hammer_price,
        'median_ratio', licitor.median_ratio,
        'at_least_double_rate', licitor.at_least_double_rate
      ) end,
      'dvf', case when dvf.sample >= 10 then jsonb_build_object(
        'sample', dvf.sample,
        'median_price', dvf.median_price
      ) end
    )
    order by coalesce(licitor.sample, 0) + coalesce(dvf.sample, 0) desc
  ), '[]'::jsonb)
  from (
    select court_code from licitor where sample >= 10
    union
    select court_code from dvf where sample >= 10
  ) courts
  left join licitor on licitor.court_code = courts.court_code
  left join dvf on dvf.court_code = courts.court_code
  left join public.tribunals tribunal on tribunal.code = courts.court_code;
$function$;

select app_private.refresh_auction_scenario_observations(true);

notify pgrst, 'reload schema';

commit;
