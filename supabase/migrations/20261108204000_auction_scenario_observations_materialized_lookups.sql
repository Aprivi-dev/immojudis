begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » : la recopie du cliché des lots (app_private.refresh_auction_scenario_observations)
-- échoue à chaque passage depuis le 23/10/2026 (délai de 60 s dépassé, snapshot_error), alors qu'elle prenait
-- 3,5 à 6 s. Mesure en production du 28/10 : `select count(*) from app_private.auction_scenario_observations`
-- dépasse 60 s. L'EXPLAIN montre la cause :
--   * le planificateur estime rows=1 pour le Seq Scan sur les candidats (le filtre combine pg_input_is_valid,
--     des conversions numeric et les quality_flags : aucune statistique n'y tient) ;
--   * il choisit donc des Nested Loop. Sous le Nested Loop Left Join sur `court_mapping`, le sous-plan est
--     réévalué pour CHAQUE candidat : il contient le CTE `labels` de licitor_ingestion.diagnostic_court_mappings,
--     qui relit tous les candidats (Seq Scan) et refait le GroupAggregate sur outcome_court_official_references /
--     normalize_court_label ; le contrôle du ressort (GroupAggregate de dvf_court_adjudications,
--     array_agg(distinct department)) est lui aussi sous la boucle. Coût quadratique.
-- Cette forme vient de 20261101120100 (ressort et lots aberrants), qui avait repris la jointure de
-- 20261031100700.
--
-- 1. La vue calcule la correspondance des libellés de tribunaux (`court_mapping`) et le ressort de chaque
--    tribunal UNE SEULE FOIS : deux CTE `as materialized`, jointes ensuite au flux des candidats. Un CTE
--    matérialisé n'est jamais réévalué par ligne, quel que soit le type de jointure choisi. Mêmes colonnes
--    (le type de ligne sert aux fonctions de scénarios), mêmes lignes, mêmes règles : libellés ambigus ou non
--    appariés écartés, statuts de correspondance acceptés inchangés, lots à moins de la moitié de la mise à
--    prix écartés, lot hors du ressort du tribunal écarté (tribunal sans adjudication DVF ou lot sans
--    département : conservé).
-- 2. Filet : la fonction de recopie pose `enable_nestloop = off` pour sa propre durée (attribut de fonction, qui
--    s'annule à la sortie : aucun effet sur la session). Une estimation à 1 ligne ne peut plus enfermer la
--    lecture dans des boucles imbriquées ; la jointure `position(...)` de la correspondance, qui n'a pas
--    d'égalité, reste possible en boucle (le paramètre ne fait que la renchérir). Corps de la fonction
--    inchangé (garde de réduction de 20261101120000 comprise), droits inchangés.
-- Aucune donnée n'est réparée ni recopiée par cette migration.

create or replace view app_private.auction_scenario_observations as
with court_mapping as materialized (
  select court_mapping.raw_tribunal_label, min(court_mapping.court_code) as court_code
  from licitor_ingestion.diagnostic_court_mappings court_mapping
  where court_mapping.mapping_status in (
      'unique_official_name_contained', 'unique_verified_historical_alias'
    )
  group by court_mapping.raw_tribunal_label
  having count(distinct court_mapping.court_code) = 1
), ressort as materialized (
  select adjudication.court_code, array_agg(distinct adjudication.department) as departments
  from public.dvf_court_adjudications adjudication
  where adjudication.court_code is not null
  group by adjudication.court_code
)
select
  mapping.court_code,
  coalesce(nullif(btrim(candidate.payload->>'property_type'), ''), 'other') as property_type,
  (candidate.payload->>'starting_price_eur')::numeric as starting_price_eur,
  (candidate.payload->>'adjudication_price_eur')::numeric as hammer_price_eur,
  (candidate.payload->>'sale_date')::date as sale_date
from licitor_ingestion.statistics_eligible_candidates candidate
left join court_mapping mapping
  on mapping.raw_tribunal_label = nullif(btrim(candidate.payload->>'tribunal'), '')
left join ressort
  on ressort.court_code = mapping.court_code
where coalesce(candidate.payload->>'sale_venue_type', 'tribunal') = 'tribunal'
  and pg_catalog.pg_input_is_valid(candidate.payload->>'sale_date', 'date')
  and pg_catalog.pg_input_is_valid(candidate.payload->>'starting_price_eur', 'numeric')
  and pg_catalog.pg_input_is_valid(candidate.payload->>'adjudication_price_eur', 'numeric')
  and (candidate.payload->>'starting_price_eur')::numeric > 1000
  and (candidate.payload->>'adjudication_price_eur')::numeric > 0
  -- Lot aberrant : une adjudication à moins de la moitié de la mise à prix est une erreur de lecture.
  and (candidate.payload->>'adjudication_price_eur')::numeric
    >= 0.5 * (candidate.payload->>'starting_price_eur')::numeric
  -- Lot dont le département n'est pas dans le ressort du tribunal rattaché.
  and (
    ressort.departments is null
    or nullif(pg_catalog.upper(btrim(candidate.payload->>'department')), '') is null
    or pg_catalog.upper(btrim(candidate.payload->>'department')) = any (ressort.departments)
  )
  and not (coalesce(candidate.payload->'quality_flags', '[]'::jsonb) ?| array[
    'index_detail_date_conflict',
    'conflicting_announcement_alias_capture',
    'cached_reparse_failed',
    'source_result_changed_pending_review',
    'lot_missing_in_latest_capture'
  ]);

revoke all on app_private.auction_scenario_observations from public, anon, authenticated;
grant select on app_private.auction_scenario_observations to service_role;

create or replace function app_private.refresh_auction_scenario_observations(
  p_force boolean default true,
  p_allow_shrink boolean default false
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
set enable_nestloop = off
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

commit;
