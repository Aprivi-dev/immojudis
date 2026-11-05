begin;

set local lock_timeout = '5s';

-- Sentinelle de qualité du catalogue (audit qualité du 03/11/2026). L'audit de toutes les annonces en ligne a relevé,
-- puis corrigé, plusieurs familles de défauts : mise à prix ou commune recopiées d'un autre lot sur les pages Licitor à
-- plusieurs lots (#407), surfaces rangées dans le mauvais champ (bâti / terrain), chambres >= pièces, terrains avec un
-- nombre de pièces, prix au m² aberrants, codes postaux manquants, pièces jointes bloquées « incomplete ». Jusqu'ici
-- personne ne les surveillait : le propriétaire les découvrait en lisant les annonces. Cette migration les mesure sur
-- les seules ventes EN LIGNE (public.v_auction_sales_discovery, ~860 lignes) et ouvre une alerte opérationnelle quand
-- une famille revient.
--
-- Mesures (app_private.catalogue_quality_metrics, un seul passage sur les ventes en ligne, chaque mesure avec son nombre
-- et au plus cinq identifiants de vente en exemple). Valeurs du 03/11/2026 vers 14 h UTC, 862 ventes en ligne :
--   1. bedrooms_ge_rooms              chambres >= pièces, avec plus d'une pièce                          0
--   2. land_with_rooms                terrain (property_type = 'land') avec un nombre de pièces           0
--   3. price_per_m2_implausible       mise à prix / coalesce(habitable, carrez, surface_m2) > 30 000 €/m² 1, reconnue
--   4. licitor_lot_mismatch           vente Licitor dont la mise à prix diffère de celle de sa propre
--                                     carte de liste (raw_payload->'source_lots'->0->>'starting_price_eur',
--                                     un texte « 80 000 € » ou « 27 742,81 € » lu en euros, à 1 € près)   9 (voir plus bas)
--   5. missing_postal_code_ratio      part des ventes en ligne sans code postal                           32/862 = 3,7 %
--   6. dwelling_without_surface_ratio part des maisons et appartements sans surface                      137/654 = 20,9 %
--   7. occupancy_unknown_ratio        part des ventes à l'occupation inconnue (nulle ou 'unknown')       234/862 = 27,1 %
--   8. documents_incomplete           ventes en ligne avec une pièce « incomplete » connue depuis plus
--                                     de 3 jours (created_at : updated_at est réécrit à chaque passage
--                                     du pipeline et ne date pas le blocage)                              64
--
-- Alertes, toutes en avertissement, catégorie `import` (celle de catalogue.duplicates.cross_source, autre contrôle du
-- catalogue ; il n'y a pas de catégorie data_quality et operational_alerts_category_check n'est pas touchée) :
--   catalogue.quality.bedrooms_ge_rooms           invariant : dès 1 vente
--   catalogue.quality.land_with_rooms             invariant : dès 1 vente
--   catalogue.quality.licitor_lot_mismatch        invariant : dès 1 vente
--   catalogue.quality.price_per_m2_implausible    dès 1 vente au-dessus de 30 000 €/m², hors ventes reconnues
--       légitimes. La seule vente au-dessus le 03/11 (b13dcf59, Saint-Jean-Cap-Ferrat : une propriété de 900 m²,
--       deux maisons, piscine, mise à prix 35 000 000 € soit 38 889 €/m², carte Licitor concordante) est réelle :
--       elle est reconnue dans price_per_m2_acknowledged_sale_ids plutôt que de relever le seuil, qui doit rester
--       sensible aux vraies erreurs (une mise à prix d'un lot sur la surface d'un autre).
--   catalogue.quality.missing_postal_code_ratio   plus de 8 % des ventes en ligne sans code postal (3,7 % le 03/11 :
--       plus du double, soit ~70 ventes au lieu de 32).
--   catalogue.quality.documents_incomplete        plus de 80 ventes. Le 03/11, les 64 ventes concernées ont toutes une
--       tâche pdf en file (relecture lancée par 20261111080000 et 20261111090000) : le seuil laisse passer cette
--       relecture. Une fois qu'elle a abouti, abaisser le seuil (viser une dizaine) par une migration de
--       app_private.catalogue_quality_thresholds() seule.
--   Les deux mesures de tendance (6 et 7) n'ouvrent aucune alerte : la plupart des cas sont légitimes (une annonce qui
--   ne donne pas de surface, un jugement qui ne dit rien de l'occupation). Elles sont enregistrées pour la tendance.
--   Les alertes de part (5) ne s'ouvrent qu'à partir de 100 ventes en ligne : sur un catalogue presque vide, la part
--   ne dit rien (un catalogue vide est un autre incident, vu par le pipeline).
-- Tous les seuils sont dans app_private.catalogue_quality_thresholds() : une migration d'une fonction pour les changer.
--
-- Cycle de vie : celui de toutes les alertes (app_private.sync_operational_alert) : ouverture et notification dès le
-- dépassement, rappel au plus une fois par 24 h, fermeture deux heures après le retour sous le seuil. Le détail porte
-- le nombre, le seuil et des identifiants de vente en exemple ; aucune donnée personnelle.
--
-- Cadence : évaluée par app_private.evaluate_operational_health à chaque passage (toutes les 30 minutes), comme
-- catalogue.duplicates.cross_source, juste après elle. Coût : un passage sur les ~1 650 ventes à statut upcoming /
-- unknown / postponed (index idx_auction_sales_status), un accès indexé aux pièces par vente en ligne
-- (idx_auction_documents_source_url). Les vues latérales de v_auction_sales_discovery ne sont pas calculées (colonnes
-- non lues).
--
-- Historique : un cliché par jour (UTC) de toutes les mesures dans public.auction_pipeline_observations, sous le nom
-- `catalogue-quality` (comme `enrichment-queue`, une ligne d'agrégats qui n'est pas une source). Même rétention de
-- 90 jours, purgée par public.observe_autonomous_pipeline. Lecture de la tendance :
--   select observed_at, metrics from public.auction_pipeline_observations
--    where source_name = 'catalogue-quality' order by observed_at desc;
--
-- ORDRE DE MISE EN PRODUCTION : le 03/11 vers 14 h UTC, 9 ventes Licitor en ligne portaient encore la mise à prix d'un
-- autre lot de leur annonce (lignes à plusieurs lots pas encore recalculées avec #407, ex. 638fdb03 : URL et carte du
-- lot de Lamarque à 15 000 €, valeurs du lot 1 de Talence à 30 000 €). L'alerte licitor_lot_mismatch s'ouvre donc au
-- premier passage si ces lignes ne sont pas recalculées avant ; c'est un vrai signal, pas du bruit. Vérifier avec
--   select app_private.catalogue_quality_metrics() -> 'metrics' -> 'licitor_lot_mismatch';
-- RETOUR ARRIÈRE : retirer l'appel d'evaluate_operational_health (remplacement inverse), puis
-- drop function app_private.evaluate_catalogue_quality_health(timestamptz),
-- app_private.catalogue_quality_metrics(timestamptz), app_private.catalogue_quality_thresholds(). Les alertes
-- ouvertes se referment à la main (update public.operational_alerts set status = 'resolved' ...).

create or replace function app_private.catalogue_quality_thresholds()
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'price_per_m2_max_eur', 30000,
    'price_per_m2_acknowledged_sale_ids',
      pg_catalog.jsonb_build_array('b13dcf59-fa8a-42d5-8c5b-a0de982994cf'),
    'missing_postal_code_ratio_max', 0.08,
    'ratio_minimum_live_sales', 100,
    'documents_incomplete_minimum_age_days', 3,
    'documents_incomplete_max_sales', 80,
    'example_limit', 5
  );
$$;

revoke all on function app_private.catalogue_quality_thresholds() from public, anon, authenticated;
grant execute on function app_private.catalogue_quality_thresholds() to service_role;

comment on function app_private.catalogue_quality_thresholds() is
  'Seuils des alertes catalogue.quality.* : 30 000 €/m² (hors ventes reconnues), 8 % de ventes sans code postal à partir de 100 ventes en ligne, 80 ventes avec une pièce incomplete depuis plus de 3 jours. Les invariants (chambres >= pièces, terrain avec pièces, lot Licitor) alertent dès 1 vente.';

create or replace function app_private.catalogue_quality_metrics(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  -- PL/pgSQL plutôt que SQL : le plan de la requête est invalidé quand catalogue_quality_thresholds() est
  -- redéfinie (une fonction SQL garde son plan, seuils compris, pour toute la transaction appelante).
  with settings as (
    select
      thresholds,
      (thresholds ->> 'price_per_m2_max_eur')::numeric as price_per_m2_max,
      coalesce(
        array(select pg_catalog.jsonb_array_elements_text(thresholds -> 'price_per_m2_acknowledged_sale_ids')::uuid),
        '{}'::uuid[]
      ) as acknowledged_ids,
      pg_catalog.make_interval(days => (thresholds ->> 'documents_incomplete_minimum_age_days')::integer)
        as document_age,
      (thresholds ->> 'example_limit')::integer as example_limit
    from (select app_private.catalogue_quality_thresholds() as thresholds) source
  ),
  live as materialized (
    select
      sale.id,
      sale.source_name,
      sale.property_type,
      sale.rooms_count,
      sale.bedrooms_count,
      sale.starting_price_eur,
      sale.postal_code,
      sale.occupancy_status,
      nullif(coalesce(sale.habitable_surface_m2, sale.carrez_surface_m2, sale.surface_m2), 0) as surface,
      -- « 80 000 € », « 27 742,81 € » : seuls les chiffres et la virgule décimale restent. Un texte d'une autre forme
      -- (mention, deux montants) n'est pas lu : il est compté à part, jamais converti au hasard.
      pg_catalog.regexp_replace(
        sale.raw_payload -> 'source_lots' -> 0 ->> 'starting_price_eur', '[^0-9,]', '', 'g'
      ) as card_price_digits,
      sale.raw_payload -> 'source_lots' -> 0 ->> 'starting_price_eur' is not null as has_card_price,
      exists (
        select 1
        from public.auction_documents document
        cross join settings
        where document.source_url = sale.source_url
          and document.extraction_status = 'incomplete'
          and document.created_at < p_now - settings.document_age
      ) as has_stuck_document
    from public.v_auction_sales_discovery discovery
    join public.auction_sales sale on sale.id = discovery.id
  ),
  measured as (
    select
      live.*,
      case
        when live.card_price_digits ~ '^[0-9]+(,[0-9]{1,2})?$'
          then pg_catalog.replace(live.card_price_digits, ',', '.')::numeric
      end as card_price,
      live.starting_price_eur / live.surface as price_per_m2
    from live
  ),
  flagged as (
    select
      measured.*,
      measured.bedrooms_count >= measured.rooms_count and measured.rooms_count > 1 as bedrooms_ge_rooms,
      measured.property_type = 'land' and measured.rooms_count is not null as land_with_rooms,
      coalesce(measured.price_per_m2 > settings.price_per_m2_max, false) as price_above_max,
      measured.id = any(settings.acknowledged_ids) as price_acknowledged,
      measured.source_name = 'licitor'
        and measured.card_price is not null
        and (
          measured.starting_price_eur is null
          or pg_catalog.abs(measured.starting_price_eur - measured.card_price) >= 1
        ) as licitor_lot_mismatch,
      measured.postal_code is null or pg_catalog.btrim(measured.postal_code) = '' as missing_postal_code,
      measured.property_type in ('house', 'apartment') as dwelling,
      measured.surface is null as without_surface,
      measured.occupancy_status is null or measured.occupancy_status = 'unknown' as occupancy_unknown
    from measured
    cross join settings
  ),
  totals as (
    select
      count(*)::integer as live_sales,
      count(*) filter (where bedrooms_ge_rooms)::integer as bedrooms_ge_rooms,
      (array_agg(id order by id) filter (where bedrooms_ge_rooms)) as bedrooms_ge_rooms_ids,
      count(*) filter (where land_with_rooms)::integer as land_with_rooms,
      (array_agg(id order by id) filter (where land_with_rooms)) as land_with_rooms_ids,
      count(*) filter (where price_above_max and not price_acknowledged)::integer as price_per_m2_implausible,
      count(*) filter (where price_above_max and price_acknowledged)::integer as price_per_m2_acknowledged,
      (array_agg(id order by price_per_m2 desc, id) filter (where price_above_max and not price_acknowledged))
        as price_per_m2_ids,
      max(price_per_m2) filter (where price_above_max and not price_acknowledged) as price_per_m2_highest,
      count(*) filter (where source_name = 'licitor')::integer as licitor_live,
      count(*) filter (where source_name = 'licitor' and not has_card_price)::integer as licitor_without_card,
      count(*) filter (
        where source_name = 'licitor' and has_card_price and card_price is null
      )::integer as licitor_unreadable_card,
      count(*) filter (where licitor_lot_mismatch)::integer as licitor_lot_mismatch,
      (array_agg(id order by id) filter (where licitor_lot_mismatch)) as licitor_lot_mismatch_ids,
      count(*) filter (where missing_postal_code)::integer as missing_postal_code,
      (array_agg(id order by id) filter (where missing_postal_code)) as missing_postal_code_ids,
      count(*) filter (where dwelling)::integer as dwellings,
      count(*) filter (where dwelling and without_surface)::integer as dwelling_without_surface,
      count(*) filter (where occupancy_unknown)::integer as occupancy_unknown,
      count(*) filter (where has_stuck_document)::integer as documents_incomplete,
      (array_agg(id order by id) filter (where has_stuck_document)) as documents_incomplete_ids
    from flagged
  )
  select pg_catalog.jsonb_build_object(
    'evaluated_at', p_now,
    'live_sales', totals.live_sales,
    'metrics', pg_catalog.jsonb_build_object(
      'bedrooms_ge_rooms', pg_catalog.jsonb_build_object(
        'count', totals.bedrooms_ge_rooms,
        'example_sale_ids', coalesce(pg_catalog.to_jsonb(totals.bedrooms_ge_rooms_ids[1:settings.example_limit]), '[]'::jsonb)
      ),
      'land_with_rooms', pg_catalog.jsonb_build_object(
        'count', totals.land_with_rooms,
        'example_sale_ids', coalesce(pg_catalog.to_jsonb(totals.land_with_rooms_ids[1:settings.example_limit]), '[]'::jsonb)
      ),
      'price_per_m2_implausible', pg_catalog.jsonb_build_object(
        'count', totals.price_per_m2_implausible,
        'acknowledged', totals.price_per_m2_acknowledged,
        'highest_eur_per_m2', pg_catalog.round(totals.price_per_m2_highest),
        'example_sale_ids', coalesce(pg_catalog.to_jsonb(totals.price_per_m2_ids[1:settings.example_limit]), '[]'::jsonb)
      ),
      'licitor_lot_mismatch', pg_catalog.jsonb_build_object(
        'count', totals.licitor_lot_mismatch,
        'licitor_live', totals.licitor_live,
        'without_card', totals.licitor_without_card,
        'unreadable_card', totals.licitor_unreadable_card,
        'example_sale_ids', coalesce(pg_catalog.to_jsonb(totals.licitor_lot_mismatch_ids[1:settings.example_limit]), '[]'::jsonb)
      ),
      'missing_postal_code_ratio', pg_catalog.jsonb_build_object(
        'count', totals.missing_postal_code,
        'population', totals.live_sales,
        'ratio', case
          when totals.live_sales > 0
            then pg_catalog.round(totals.missing_postal_code::numeric / totals.live_sales, 4)
        end,
        'example_sale_ids', coalesce(pg_catalog.to_jsonb(totals.missing_postal_code_ids[1:settings.example_limit]), '[]'::jsonb)
      ),
      'dwelling_without_surface_ratio', pg_catalog.jsonb_build_object(
        'count', totals.dwelling_without_surface,
        'population', totals.dwellings,
        'ratio', case
          when totals.dwellings > 0
            then pg_catalog.round(totals.dwelling_without_surface::numeric / totals.dwellings, 4)
        end
      ),
      'occupancy_unknown_ratio', pg_catalog.jsonb_build_object(
        'count', totals.occupancy_unknown,
        'population', totals.live_sales,
        'ratio', case
          when totals.live_sales > 0
            then pg_catalog.round(totals.occupancy_unknown::numeric / totals.live_sales, 4)
        end
      ),
      'documents_incomplete', pg_catalog.jsonb_build_object(
        'count', totals.documents_incomplete,
        'example_sale_ids', coalesce(pg_catalog.to_jsonb(totals.documents_incomplete_ids[1:settings.example_limit]), '[]'::jsonb)
      )
    )
  )
  into result
  from totals
  cross join settings;
  return result;
end;
$$;

revoke all on function app_private.catalogue_quality_metrics(timestamptz) from public, anon, authenticated;
grant execute on function app_private.catalogue_quality_metrics(timestamptz) to service_role;

comment on function app_private.catalogue_quality_metrics(timestamptz) is
  'Mesures de qualité des ventes en ligne (v_auction_sales_discovery) : chambres >= pièces, terrain avec pièces, prix au m² aberrant, lot Licitor discordant avec sa carte, part sans code postal, part de logements sans surface, part d''occupation inconnue, ventes avec une pièce incomplete ancienne. Nombres et identifiants de vente en exemple ; lecture seule.';

create or replace function app_private.evaluate_catalogue_quality_health(
  p_now timestamptz default statement_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thresholds jsonb := app_private.catalogue_quality_thresholds();
  v_metrics jsonb := app_private.catalogue_quality_metrics(p_now);
  v_live integer := (v_metrics ->> 'live_sales')::integer;
  v_ratio_minimum integer := (v_thresholds ->> 'ratio_minimum_live_sales')::integer;
  v_postal_max numeric := (v_thresholds ->> 'missing_postal_code_ratio_max')::numeric;
  v_documents_max integer := (v_thresholds ->> 'documents_incomplete_max_sales')::integer;
  v_metric jsonb;
  v_key text;
  v_day_start timestamptz := pg_catalog.date_trunc('day', p_now, 'UTC');
begin
  -- Invariants : une seule vente en ligne suffit.
  foreach v_key in array array['bedrooms_ge_rooms', 'land_with_rooms', 'licitor_lot_mismatch'] loop
    v_metric := v_metrics -> 'metrics' -> v_key;
    perform app_private.sync_operational_alert(
      'catalogue.quality.' || v_key,
      'import',
      'warning',
      v_metric || pg_catalog.jsonb_build_object('live_sales', v_live, 'maximum_count', 0),
      (v_metric ->> 'count')::integer > 0,
      p_now
    );
  end loop;

  v_metric := v_metrics -> 'metrics' -> 'price_per_m2_implausible';
  perform app_private.sync_operational_alert(
    'catalogue.quality.price_per_m2_implausible',
    'import',
    'warning',
    v_metric || pg_catalog.jsonb_build_object(
      'live_sales', v_live,
      'maximum_count', 0,
      'price_per_m2_max_eur', v_thresholds -> 'price_per_m2_max_eur'
    ),
    (v_metric ->> 'count')::integer > 0,
    p_now
  );

  v_metric := v_metrics -> 'metrics' -> 'missing_postal_code_ratio';
  perform app_private.sync_operational_alert(
    'catalogue.quality.missing_postal_code_ratio',
    'import',
    'warning',
    v_metric || pg_catalog.jsonb_build_object(
      'maximum_ratio', v_postal_max,
      'minimum_live_sales', v_ratio_minimum
    ),
    v_live >= v_ratio_minimum and (v_metric ->> 'ratio')::numeric > v_postal_max,
    p_now
  );

  v_metric := v_metrics -> 'metrics' -> 'documents_incomplete';
  perform app_private.sync_operational_alert(
    'catalogue.quality.documents_incomplete',
    'import',
    'warning',
    v_metric || pg_catalog.jsonb_build_object(
      'live_sales', v_live,
      'maximum_count', v_documents_max,
      'minimum_age_days', v_thresholds -> 'documents_incomplete_minimum_age_days'
    ),
    (v_metric ->> 'count')::integer > v_documents_max,
    p_now
  );

  -- Cliché quotidien (jour UTC) de toutes les mesures, tendances comprises, pour l'historique.
  if not exists (
    select 1
    from public.auction_pipeline_observations observation
    where observation.source_name = 'catalogue-quality'
      and observation.observed_at >= v_day_start
      and observation.observed_at < v_day_start + interval '1 day'
  ) then
    insert into public.auction_pipeline_observations (source_name, observed_at, metrics)
    values (
      'catalogue-quality',
      p_now,
      v_metrics || pg_catalog.jsonb_build_object('thresholds', v_thresholds)
    );
  end if;
end;
$$;

revoke all on function app_private.evaluate_catalogue_quality_health(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.evaluate_catalogue_quality_health(timestamptz) to service_role;

comment on function app_private.evaluate_catalogue_quality_health(timestamptz) is
  'Alertes catalogue.quality.* sur les ventes en ligne, et cliché quotidien des mesures (auction_pipeline_observations, catalogue-quality). Appelée par evaluate_operational_health ; ne renvoie rien.';

-- Appel depuis app_private.evaluate_operational_health, juste après l'évaluation des doublons inter-sources
-- (20261110120400). Même méthode que les migrations précédentes : refuser de deviner si le fragment attendu n'y est plus.
do $hook$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  );
  anchor constant text := 'perform app_private.evaluate_catalogue_duplicates_health(p_now);';
begin
  if position('evaluate_catalogue_quality_health' in definition) = 0 then
    if position(anchor in definition) = 0 then
      raise exception using
        errcode = '55000',
        message = 'Operational health definition changed; review before adding the catalogue quality sentinel.';
    end if;
    execute replace(
      definition,
      anchor,
      anchor || E'\n  perform app_private.evaluate_catalogue_quality_health(p_now);'
    );
  end if;
end;
$hook$;

notify pgrst, 'reload schema';

commit;
