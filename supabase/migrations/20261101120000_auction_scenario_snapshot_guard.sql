begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » (chantier W3, points 6 et 21 du compte-rendu du 23/10/2026) : le cliché des lots
-- (app_private.auction_scenario_observation_snapshot, 20261031100800) devient plus sûr à remplacer et moins coûteux
-- à lire.
--
-- 1. refresh_auction_scenario_observations(p_force, p_allow_shrink) : la fonction remplaçait le cliché par
--    « delete » puis « insert » sans regarder ce qu'elle recopiait. Une vue source vidée par un incident (porte
--    statistique fermée, rattachement des tribunaux cassé) aurait effacé les scénarios de toutes les ventes.
--    Elle refuse désormais de remplacer un cliché de 100 lots ou plus par un jeu de moins de la moitié des lots
--    du précédent (erreur 55000 : tout est annulé, l'ancien cliché reste lu), sauf p_allow_shrink = true, le
--    forçage explicite d'un opérateur. Sous 100 lots, les variations sont normales et rien n'est refusé.
--    Le paramètre est ajouté avec une valeur par défaut : l'ancienne signature à un argument est retirée, sinon
--    un appel `refresh_auction_scenario_observations(true)` serait ambigu. La collecte (un seul argument) et les
--    droits (service_role seul) sont inchangés.
-- 2. L'index sur sale_date du cliché ne sert à rien : les lectures prennent trois ans sur quelque quatre mille
--    lots, c'est un parcours complet de toute façon, et l'index ralentit chaque recopie.
-- 3. get_court_auction_summaries et court_auction_history cherchent max(mutation_date) de dvf_court_adjudications
--    à chaque appel : sans index sur cette colonne seule, c'est un parcours complet de la table.
--    (La table est petite et écrite par l'import annuel : l'index se crée dans la transaction.)

drop function if exists app_private.refresh_auction_scenario_observations(boolean);

create or replace function app_private.refresh_auction_scenario_observations(
  p_force boolean default true,
  p_allow_shrink boolean default false
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_previous integer;
begin
  if not p_force and exists (
    select 1
    from app_private.auction_scenario_snapshot_state state
    where state.refreshed_at > statement_timestamp() - interval '1 day'
  ) then
    return null;
  end if;

  select state.observation_count into v_previous
  from app_private.auction_scenario_snapshot_state state;

  lock table app_private.auction_scenario_observation_snapshot in exclusive mode;
  delete from app_private.auction_scenario_observation_snapshot;
  insert into app_private.auction_scenario_observation_snapshot (
    court_code, property_type, starting_price_eur, hammer_price_eur, sale_date
  )
  select observation.court_code, observation.property_type, observation.starting_price_eur,
         observation.hammer_price_eur, observation.sale_date
  from app_private.auction_scenario_observations observation;
  get diagnostics v_count = row_count;

  -- Garde contre une réduction brutale : l'exception annule le delete et l'insert ci-dessus.
  if not p_allow_shrink and v_previous >= 100 and v_count < v_previous * 0.5 then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        'Scenario snapshot refresh refused: %s lots instead of %s (less than half); pass p_allow_shrink to force it.',
        v_count, v_previous
      );
  end if;

  insert into app_private.auction_scenario_snapshot_state (singleton, refreshed_at, observation_count)
  values (true, statement_timestamp(), v_count)
  on conflict (singleton) do update
    set refreshed_at = excluded.refreshed_at, observation_count = excluded.observation_count;
  return v_count;
end;
$function$;

revoke all on function app_private.refresh_auction_scenario_observations(boolean, boolean)
  from public, anon, authenticated;
grant execute on function app_private.refresh_auction_scenario_observations(boolean, boolean) to service_role;

drop index if exists app_private.auction_scenario_observation_snapshot_sale_date_idx;

create index if not exists dvf_court_adjudications_mutation_date_idx
  on public.dvf_court_adjudications (mutation_date desc);

notify pgrst, 'reload schema';

commit;
