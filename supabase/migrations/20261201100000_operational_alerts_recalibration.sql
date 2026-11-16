begin;

set local lock_timeout = '5s';

-- Recalibrage des alertes d'exploitation du pipeline (16/11/2026, 7 alertes ouvertes en production, décision du
-- propriétaire). Chaque alerte ci-dessous était ouverte sans incident réel, ou pour la même cause qu'une autre.
--
-- 1. pipeline.import.unhealthy (app_private.evaluate_operational_health) : une exécution en file ouvre l'alerte à
--    plus de 5 400 s au lieu de 1 800 s. Le 16/11, l'alerte était ouverte pour une file de 1 802 s : le seuil égalait
--    la cadence. Règle « seuil >= 2 x cadence réelle + durée d'un passage » (docs/operations/planification.md) :
--    2 x 30 min (passages d'operational-health qui déclenchent le workflow) + ~29 min d'un passage = 89 min, arrondi
--    à 90 min. Sévérité critique au-delà de 7 200 s, inchangée. Seuil recopié dans les détails
--    (maximum_queued_age_seconds). Redéfinition complète, recopiée de la définition en place (voir la section 1
--    plus bas), avec garde md5.
--
-- 2. pipeline.source.<source>.stale_listings :
--    (a) la fenêtre de fraîcheur suit la politique de relecture de la collecte. Une seule source de vérité côté SQL :
--        app_private.listing_review_policy(), JUMELLE de detail_reread_hours
--        (services/data-pipeline/src/freshness.py) : changer l'une, c'est changer l'autre. Relecture par défaut toutes
--        les 72 h, donc une annonce est revue si elle l'a été depuis moins de 72 h ; 24 h pour Licitor (exception de
--        SOURCE_DETAIL_FRESHNESS_HOURS) et pour une vente dans les 7 jours. La collecte relit ces ventes proches à chaque inventaire (cadence de 12 h) : 24 h
--        tolèrent un inventaire manqué (2 x 12 h) sans alerter, pas deux. Le 16/11, notaires était à 0,46 avec la
--        fenêtre de 24 h alors que la collecte ne relit ses fiches que toutes les 72 h, volontairement.
--        public.auction_all_source_freshness lit la politique ; tout le reste de la fonction est recopié tel quel.
--    (b) une cause = une alerte : stale_listings ne s'ouvre pas pour une source dont .missed est vraie à ce passage ou
--        encore ouverte (Enchères Immobilières le 16/11 : stale_listings n'était que la conséquence de .missed).
--        Détail : suppressed_by_missed.
--
-- 3. pipeline.enrichment.stalled (public.observe_autonomous_pipeline) : la règle « une tâche de plus de 24 h » était
--    toujours vraie avec une file de ~1 300 tâches et un débit inférieur à la file. Elle signale désormais un vrai
--    blocage :
--    (a) une tâche running dont le bail de 30 minutes a expiré depuis plus de 24 h (inchangé, expired_lease_24h) ;
--    (b) OU des tâches PRENABLES (colonne claimable : vente gardée, révision la plus récente, source active, aucun
--        bail en cours sur la vente ; hors attente d'une tâche pdf de la même vente ; sous budget_limited, seules
--        les source_detail, comme avant) non servies depuis plus de 72 h (ni écrites ni attendues :
--        greatest(updated_at, next_attempt_at)), unserved_72h, ET leur nombre n'a pas baissé depuis l'observation
--        enrichment-queue d'il y a au moins 24 h (unserved_72h_24h_before, unserved_72h_compared_at). Sans
--        observation de comparaison (premier jour après cette migration), (b) n'ouvre rien : une file qui se vide
--        n'est pas bloquée, une file qui ne bouge plus l'est.
--    Les compteurs d'avant (older_than_24h, immobile_24h, etc.) restent dans les détails et l'observation.
--
-- 4. pipeline.enrichment.exhausted : la hausse ouvre l'alerte à partir de greatest(10, 2 % de la file vivante)
--    tâches épuisées en 24 h (file vivante = backlog moins les tâches épuisées) au lieu de 3 ; reliquat >= 50
--    inchangé. Le 16/11 : 6 en 24 h pour ~1 280 tâches vivantes (seuil désormais 26). Seuils dans les détails.
--
-- 5. catalogue.quality.licitor_lot_mismatch (app_private.evaluate_catalogue_quality_health) : ne s'ouvre que si une
--    vente discordante est présente sur deux évaluations consécutives (seuil 0 conservé). Chaque évaluation garde
--    sa mesure dans public.auction_pipeline_observations (source_name = 'catalogue-quality-licitor-lot', même
--    rétention de 90 jours, purgée par observe_autonomous_pipeline). Cas particulier assumé : c'est la seule mesure
--    du catalogue dont un cas transitoire est connu (recalcul d'une page Licitor à plusieurs lots entre deux
--    passages) ; les autres invariants gardent leur règle.
--
-- 6. pipeline.source.<source>.missed : les détails relaient la cause d'arrêt que la collecte écrit DÉJÀ dans
--    auction_source_state (coverage.stop_reason, ou celle du résumé du run, coverage.errors, consecutive_failures,
--    last_attempt_at, suspended_until, suspension_reason, last_error tronqué à 300 caractères). http_attempts était
--    déjà dans l'évidence. Aucune nouvelle clé n'est attendue de la collecte.
--
-- Non modifié : la revendication des tâches (claim_auction_enrichment_jobs_family). Son classement contient déjà un
-- terme d'ancienneté non borné (1 point par heure d'attente) et les familles source_detail et enrichment sont des
-- voies séparées, réparties par le travailleur Python : docs/runbooks/pipeline-enrichment-stalled.md, « Équité de
-- la file ».
--
-- Sans réparation de données : aucune ligne existante n'est modifiée. Une base dont l'observateur, la fraîcheur, la
-- sentinelle qualité ou la santé d'exploitation n'ont pas le corps attendu fait échouer la migration (refuser de
-- deviner).
--
-- Invariant (services/data-pipeline/tests/test_pipeline_cadence_invariants.py) : un seul seuil
-- « ) < p_now - interval 'N hours'; » dans ce fichier, celui de .missed (18 heures).
--
-- RETOUR ARRIÈRE : réappliquer les définitions de 20261119101000 (observateur), 20261008102328 (fraîcheur),
-- 20261111100000 (sentinelle qualité), la définition d'evaluate_operational_health ci-dessous avec 1800 au lieu de
-- 5400 (et sans maximum_queued_age_seconds), puis drop function app_private.listing_review_policy(). Les lignes
-- catalogue-quality-licitor-lot peuvent rester (purgées à 90 jours).

-- Gardes de départ : empreinte md5 du corps (pg_proc.prosrc) de la définition précédente, ou de celle de cette
-- migration (migration rejouée). Tout autre corps fait échouer la migration : une modification faite hors migration
-- serait sinon écrasée sans le dire.
do $guard$
declare
  observer_md5 text := (
    select md5(procedure_row.prosrc)
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = 'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
  freshness_md5 text := (
    select md5(procedure_row.prosrc)
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = 'public.auction_all_source_freshness(timestamptz)'::regprocedure
  );
  quality_md5 text := (
    select md5(procedure_row.prosrc)
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = 'app_private.evaluate_catalogue_quality_health(timestamptz)'::regprocedure
  );
begin
  if observer_md5 not in (
    '0763c61fb793f2891eb842f48e50dd2e',  -- 20261119101000 (point de départ)
    'c4b39635acdec51fea83a35fbbd365c1'   -- cette migration, déjà appliquée
  ) then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected health observer body (md5 %s); refusing the alert recalibration.', observer_md5
      );
  end if;
  if freshness_md5 not in (
    'febaf8c3831ac1100ebde8c71ee0dab5',  -- 20261008102328 (point de départ)
    '19eef044a54bb48cfb805c3acd11c16f'   -- cette migration, déjà appliquée
  ) then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected source freshness body (md5 %s); refusing the alert recalibration.', freshness_md5
      );
  end if;
  if quality_md5 not in (
    '51458f11eab23c275460d89df460267a',  -- 20261111100000 (point de départ)
    '115f8bb5eedcdc0ed0d21ff3bc0b7d84'   -- cette migration, déjà appliquée
  ) then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected catalogue quality body (md5 %s); refusing the alert recalibration.', quality_md5
      );
  end if;
end;
$guard$;

-- 2 (a). Politique de relecture des annonces : seule source de vérité côté SQL.
create or replace function app_private.listing_review_policy()
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  -- Jumelle de services/data-pipeline/src/freshness.py (detail_reread_hours) : la collecte relit une fiche au plus
  -- tard après review_hours (DETAIL_REREAD_HOURS), ou après la valeur propre à sa source (source_review_hours,
  -- SOURCE_DETAIL_FRESHNESS_HOURS : Licitor, dont seule la fiche dit « non requise / annulée / reportée ») ; une
  -- vente dans les near_sale_days jours (NEAR_SALE_HORIZON) est relue à chaque inventaire de 12 h, et
  -- near_sale_review_hours en tolère un manqué (2 x 12 h).
  select pg_catalog.jsonb_build_object(
    'review_hours', 72,
    'source_review_hours', pg_catalog.jsonb_build_object('licitor', 24),
    'near_sale_review_hours', 24,
    'near_sale_days', 7
  );
$$;

revoke all on function app_private.listing_review_policy() from public, anon, authenticated;
grant execute on function app_private.listing_review_policy() to service_role;

comment on function app_private.listing_review_policy() is
  'Fenêtre de fraîcheur des annonces de la santé du pipeline : revue depuis moins de 72 h (24 h pour Licitor), 24 h pour une vente dans les 7 jours. Jumelle de services/data-pipeline/src/freshness.py (politique de relecture de la collecte) : changer l''une, c''est changer l''autre. Lue par auction_all_source_freshness et observe_autonomous_pipeline.';

create or replace function public.auction_all_source_freshness(
  p_now timestamptz default now()
)
returns table(source_name text, active_listings bigint, fresh_listings bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform app_private.assert_auction_sale_source_checks_complete();

  return query
    with policy as (
      select (settings.value->>'review_hours')::integer as review_hours,
             settings.value->'source_review_hours' as source_review_hours,
             pg_catalog.make_interval(hours => (settings.value->>'near_sale_review_hours')::integer)
               as near_sale_review_window,
             pg_catalog.make_interval(days => (settings.value->>'near_sale_days')::integer) as near_sale_horizon
        from (select app_private.listing_review_policy() as value) settings
    ),
    active as materialized (
      select cache.sale_id,
             cache.source_url,
             cache.sale_date
        from app_private.auction_sale_source_checks cache
       where cache.status in ('active', 'upcoming', 'postponed', 'unknown')
    ),
    links as materialized (
      select active.source_url as canonical_url,
             link.source_name,
             link.checked_url,
             active.sale_date,
             link.checked_at
        from active
        join app_private.auction_sale_source_check_links link
          on link.sale_id = active.sale_id
      union all
      select active.source_url,
             observation.source_name,
             observation.source_url,
             active.sale_date,
             checked.checked_at
        from active
        join public.auction_observations observation
          on observation.canonical_source_url = active.source_url
        left join lateral (
          select max(link.checked_at) as checked_at
            from app_private.auction_sale_source_check_links link
           where link.sale_id = active.sale_id
             and link.checked_url = observation.source_url
        ) checked on true
    ),
    latest as (
      select link.canonical_url,
             link.source_name,
             link.sale_date,
             max(link.checked_at) filter (
               where link.checked_at <= p_now
             ) as checked_at
        from links link
       where link.source_name is not null
         and link.checked_url is not null
       group by link.canonical_url, link.source_name, link.sale_date
    )
    select latest.source_name,
           count(*),
           count(*) filter (
             where latest.checked_at >= p_now -
               case
                 when latest.sale_date between p_now and p_now + policy.near_sale_horizon
                   then policy.near_sale_review_window
                 else pg_catalog.make_interval(
                   hours => coalesce(
                     (policy.source_review_hours->>latest.source_name)::integer,
                     policy.review_hours
                   )
                 )
               end
           )
      from latest
      cross join policy
     group by latest.source_name;
end;
$function$;

revoke all on function public.auction_all_source_freshness(timestamptz)
  from public, anon, authenticated;
grant execute on function public.auction_all_source_freshness(timestamptz)
  to service_role;

-- 2 (b), 3, 4, 6. Redéfinition COMPLÈTE de public.observe_autonomous_pipeline(timestamptz), point de départ
-- 20261119101000. Changent seulement : les détails de .missed, la condition de .stale_listings, la mesure et la
-- condition de pipeline.enrichment.stalled, le seuil de hausse de pipeline.enrichment.exhausted. Tout le reste
-- (pilote coupé, inventaire, drop, publication, publication_stale, purge, droits) est recopié tel quel.
create or replace function public.observe_autonomous_pipeline(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_row record;
  freshness_counts jsonb;
  evidence jsonb;
  backlog integer;
  delayed integer;
  claimable_due integer;
  excluded_due integer;
  exhausted integer;
  exhausted_recent integer;
  exhausted_recent_threshold integer;
  budget_deferred integer;
  immobile integer;
  immobile_running integer;
  immobile_claimable integer;
  immobile_claimable_source_detail integer;
  unserved integer;
  unserved_claimable integer;
  unserved_claimable_source_detail integer;
  unserved_previous integer;
  unserved_previous_at timestamptz;
  alert_active boolean;
  missed_open boolean;
  enabled_at timestamptz;
  control_enabled boolean;
  control_changed_at timestamptz;
  enabled_source_count integer;
  recent_inventory_count integer;
  current_active integer;
  current_ratio numeric;
  previous_active integer;
  previous_ratio numeric;
  review_policy constant jsonb := app_private.listing_review_policy();
  publication_stale_after constant interval := interval '36 hours';
  -- Une tâche prenable non servie depuis 72 h (trois jours de passages du travailleur) dont le nombre ne baisse pas
  -- sur 24 h : la file ne l'atteindra pas d'elle-même.
  unserved_after constant interval := interval '72 hours';
  unserved_trend_window constant interval := interval '24 hours';
  -- Hausse des tâches épuisées : au moins 10, et au moins 2 % de la file vivante.
  exhausted_recent_minimum constant integer := 10;
  exhausted_recent_share constant numeric := 0.02;
  exhausted_backlog_threshold constant integer := 50;
begin
  delete from public.auction_collection_checkpoints
   where observed_at < p_now - interval '24 hours';

  -- Pilote coupé depuis plus de 24 h, et plus aucune source activée avec un inventaire complet de moins
  -- de 18 h : ces deux alertes sont évaluées AVANT le retour ci-dessous, qui saute tout le reste quand le
  -- pilote est coupé (jusque-là, `{enabled: false}` sans aucune alerte). `updated_at` du contrôle est
  -- posé par la route d'administration à chaque changement (et par l'expéditeur seulement quand le
  -- pilote est actif) : il date donc la coupure.
  select control.enabled, control.updated_at
    into control_enabled, control_changed_at
    from public.auction_pipeline_control control
   where control.id;
  select count(*) filter (where state.enabled)::integer,
         count(*) filter (
           where state.enabled
             and state.last_inventory_complete_at >= p_now - interval '18 hours'
         )::integer
    into enabled_source_count, recent_inventory_count
    from public.auction_source_state state;
  perform app_private.sync_operational_alert(
    'pipeline.scheduler.disabled',
    'import',
    'warning',
    jsonb_build_object(
      'enabled', coalesce(control_enabled, false),
      'disabled_since', case when control_enabled is false then control_changed_at else null end,
      'maximum_disabled_hours', 24
    ),
    control_enabled is false
      and control_changed_at < p_now - interval '24 hours',
    p_now
  );
  perform app_private.sync_operational_alert(
    'pipeline.inventory.stale',
    'import',
    'critical',
    jsonb_build_object(
      'scheduler_enabled', coalesce(control_enabled, false),
      'enabled_sources', enabled_source_count,
      'sources_with_recent_inventory', recent_inventory_count,
      'maximum_inventory_age_hours', 18
    ),
    recent_inventory_count = 0,
    p_now
  );

  select observation_started_at
    into enabled_at
    from public.auction_pipeline_control
   where id and enabled;
  if not found then
    return jsonb_build_object('enabled', false);
  end if;

  select coalesce(
    jsonb_object_agg(
      f.source_name,
      jsonb_build_object('active', f.active_listings, 'fresh', f.fresh_listings)
    ),
    '{}'::jsonb
  )
    into freshness_counts
    from public.auction_all_source_freshness(p_now) f;

  for source_row in
    with current_run_ids as materialized (
      select distinct state.last_run_id
        from public.auction_source_state state
       where state.last_run_id is not null
    ),
    current_items as materialized (
      select item.run_id,
             item.decision,
             item.discovered_at,
             item.published_at
        from public.auction_collection_items item
        join current_run_ids current_run
          on current_run.last_run_id = item.run_id
    ),
    decision_counts as materialized (
      select item.run_id,
             item.decision,
             count(*) as decision_count
        from current_items item
       group by item.run_id, item.decision
    ),
    item_rollup as (
      select counts.run_id,
             sum(counts.decision_count)::integer as inventory_count,
             coalesce(
               sum(counts.decision_count)
                 filter (where counts.decision = 'publication_failed'),
               0
             )::integer as failed_publication,
             jsonb_object_agg(counts.decision, counts.decision_count) as decisions
        from decision_counts counts
       group by counts.run_id
    ),
    latency_rollup as (
      select item.run_id,
             (
               percentile_cont(0.95) within group (
                 order by extract(epoch from item.published_at - item.discovered_at)
               )
             )::numeric as latency_p95
        from current_items item
       where item.published_at is not null
       group by item.run_id
    ),
    baseline_projection as materialized (
      select state.source_name,
             observation.observed_at,
             observation.metrics->>'run_id' as run_id_text,
             observation.metrics->>'inventory_count' as inventory_count_text
        from public.auction_source_state state
        join public.auction_pipeline_observations observation
          on observation.source_name = state.source_name
       where observation.metrics->>'inventory_complete' = 'true'
         and observation.metrics->>'run_id' is distinct from state.last_run_id::text
    ),
    baseline_candidates as materialized (
      select projection.source_name,
             projection.observed_at,
             projection.run_id_text,
             projection.inventory_count_text,
             row_number() over (
               partition by projection.source_name, projection.run_id_text
               order by projection.observed_at desc
             ) as run_rank
        from baseline_projection projection
    ),
    baseline_runs as materialized (
      select candidate.source_name,
             candidate.observed_at,
             candidate.inventory_count_text,
             row_number() over (
               partition by candidate.source_name
               order by candidate.observed_at desc
             ) as source_rank
        from baseline_candidates candidate
       where candidate.run_rank = 1
    ),
    baseline_rollup as (
      select baseline.source_name,
             avg(baseline.inventory_count_text::numeric) as inventory_baseline
        from baseline_runs baseline
       where baseline.source_rank <= 28
       group by baseline.source_name
    )
    select state.*,
           coalesce(items.inventory_count, 0) as inventory_count,
           coalesce(items.failed_publication, 0) as failed_publication,
           coalesce(items.decisions, '{}'::jsonb) as decisions,
           latency.latency_p95,
           baseline.inventory_baseline,
           run_info.summary as run_summary,
           (
             run_info.finished_at is not null
             and coalesce((state.coverage->>'coverage_complete')::boolean, false)
           ) as inventory_complete
      from public.auction_source_state state
      left join item_rollup items
        on items.run_id = state.last_run_id
      left join latency_rollup latency
        on latency.run_id = state.last_run_id
      left join baseline_rollup baseline
        on baseline.source_name = state.source_name
      left join public.auction_runs run_info
        on run_info.id = state.last_run_id
  loop
    evidence := jsonb_build_object(
      'enabled', source_row.enabled,
      'availability', source_row.availability,
      'run_id', source_row.last_run_id,
      'inventory_count', source_row.inventory_count,
      'inventory_complete', coalesce(source_row.inventory_complete, false),
      'last_inventory_complete_at', source_row.last_inventory_complete_at,
      'last_publication_complete_at', source_row.last_publication_complete_at,
      'active_listings', coalesce(
        (freshness_counts->source_row.source_name->>'active')::integer,
        0
      ),
      'fresh_listings', coalesce(
        (freshness_counts->source_row.source_name->>'fresh')::integer,
        0
      ),
      'freshness_ratio', case
        when coalesce((freshness_counts->source_row.source_name->>'active')::integer, 0) > 0
          then coalesce((freshness_counts->source_row.source_name->>'fresh')::numeric, 0)
            / (freshness_counts->source_row.source_name->>'active')::numeric
        else null
      end,
      'failed_publication', source_row.failed_publication,
      'inventory_baseline', source_row.inventory_baseline,
      'decisions', source_row.decisions,
      'discovery_to_publication_p95_seconds', source_row.latency_p95,
      'execution_seconds', source_row.run_summary->'execution_seconds',
      'http_attempts', source_row.coverage->'http_attempts_including_retries'
    );

    current_active := coalesce((evidence->>'active_listings')::integer, 0);
    current_ratio := (evidence->>'freshness_ratio')::numeric;

    -- Observation précédente de cette source (avant l'insertion de la courante) : le ratio de fraîcheur
    -- doit être bas sur deux observations consécutives pour ouvrir stale_listings.
    select (previous.metrics->>'active_listings')::integer,
           (previous.metrics->>'freshness_ratio')::numeric
      into previous_active, previous_ratio
      from public.auction_pipeline_observations previous
     where previous.source_name = source_row.source_name
       and previous.observed_at < p_now
     order by previous.observed_at desc
     limit 1;

    insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
    values (source_row.source_name, p_now, evidence);

    alert_active := source_row.enabled
      and coalesce(
        source_row.last_inventory_complete_at,
        enabled_at,
        source_row.updated_at
      ) < p_now - interval '18 hours';
    -- La cause d'arrêt telle que la collecte l'écrit déjà (auction_source_state, résumé du run) : pas de clé future.
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.missed',
      'import',
      'critical',
      evidence || jsonb_build_object(
        'stop_reason', coalesce(
          source_row.coverage->>'stop_reason',
          source_row.run_summary->'scrape_coverage'->source_row.source_name->>'stop_reason'
        ),
        'coverage_errors', source_row.coverage->'errors',
        'consecutive_failures', source_row.consecutive_failures,
        'last_attempt_at', source_row.last_attempt_at,
        'suspended_until', source_row.suspended_until,
        'suspension_reason', source_row.suspension_reason,
        'last_error', left(source_row.last_error, 300)
      ),
      alert_active,
      p_now
    );
    -- Une cause = une alerte : .missed vraie à ce passage ou encore ouverte (hystérésis de deux heures) explique
    -- déjà des annonces non revues.
    missed_open := alert_active
      or exists (
        select 1
          from public.operational_alerts missed
         where missed.alert_key = 'pipeline.source.' || source_row.source_name || '.missed'
           and missed.status = 'open'
      );
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.drop',
      'import',
      'warning',
      evidence,
      source_row.enabled
        and source_row.inventory_baseline >= 10
        and coalesce(source_row.inventory_complete, false)
        and source_row.inventory_count < source_row.inventory_baseline * 0.7,
      p_now
    );
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.publication',
      'import',
      'critical',
      evidence,
      source_row.enabled and source_row.failed_publication > 0,
      p_now
    );
    -- La publication complète (inventaire complet ET publication sans échec) n'a pas abouti depuis
    -- 36 h : une source figée (Enchères Immobilières depuis le 08/10) ou qui n'a jamais publié
    -- (Agrasc) reste muette pour .missed tant que son inventaire se termine.
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.publication_stale',
      'import',
      'critical',
      evidence || jsonb_build_object('maximum_publication_age_hours', 36),
      source_row.enabled
        and coalesce(
          source_row.last_publication_complete_at,
          enabled_at,
          source_row.updated_at
        ) < p_now - publication_stale_after,
      p_now
    );
    -- Annonces non revues : moins de 80 % des annonces actives de la source ont été revues dans la fenêtre de
    -- app_private.listing_review_policy(), sur deux observations consécutives, pour une source activée d'au moins
    -- 10 ventes, sauf si .missed porte déjà la cause.
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.stale_listings',
      'import',
      'warning',
      evidence || jsonb_build_object(
        'previous_freshness_ratio', previous_ratio,
        'freshness_ratio_threshold', 0.8,
        'minimum_active_listings', 10,
        'review_hours', coalesce(
          review_policy->'source_review_hours'->source_row.source_name,
          review_policy->'review_hours'
        ),
        'near_sale_review_hours', review_policy->'near_sale_review_hours',
        'suppressed_by_missed', missed_open
      ),
      source_row.enabled
        and not missed_open
        and current_active >= 10
        and current_ratio < 0.8
        and coalesce(previous_active, 0) >= 10
        and previous_ratio < 0.8,
      p_now
    );
  end loop;

  with due_candidates as materialized (
    -- Keep the full due set for raw backlog and eligibility evidence, but carry
    -- the revision key so only these groups need to be ranked.
    select j.id,
           j.job_type,
           j.source_url,
           j.detail_source_name,
           j.detail_source_url,
           j.status,
           j.updated_at,
           j.next_attempt_at
      from public.auction_enrichment_jobs j
     where (
             j.status in ('queued','failed')
             or (
                  j.status = 'running'
                  and coalesce(j.locked_at,j.updated_at)
                      < p_now - interval '30 minutes'
                )
           )
       and j.next_attempt_at <= p_now
       and j.attempt_count < j.max_attempts
  ), revision_ranked as materialized (
    select j.id,
           row_number() over (
             partition by j.source_url, j.job_type, j.detail_source_name, j.detail_source_url
             order by j.created_at desc,
                      (j.input_hash like 'pipeline_v2:%') desc,
                      j.id desc
           ) as revision_rank
      from public.auction_enrichment_jobs j
      join (
        select distinct source_url,
                        job_type,
                        detail_source_name,
                        detail_source_url
          from due_candidates
      ) groups
        on j.source_url = groups.source_url
       and j.job_type = groups.job_type
       and (
         (j.detail_source_name = groups.detail_source_name
          and j.detail_source_url = groups.detail_source_url)
         or (
           j.detail_source_name is null
           and groups.detail_source_name is null
           and j.detail_source_url is null
           and groups.detail_source_url is null
         )
         or (
           j.detail_source_name is null
           and groups.detail_source_name is null
           and j.detail_source_url = groups.detail_source_url
         )
         or (
           j.detail_source_name = groups.detail_source_name
           and j.detail_source_url is null
           and groups.detail_source_url is null
         )
       )
     where j.status <> 'cancelled'
  ), classified as (
    select due.id,
           (
             revision.revision_rank = 1
             and
             exists (
               select 1
                 from public.auction_sales s
                where s.source_url = due.source_url
                  and s.status in ('active','unknown','upcoming','postponed','past')
                  and s.retention_deadline_materialized
                  and (s.retention_deadline is null or s.retention_deadline > p_now)
             )
             and (
               due.job_type <> 'source_detail'
               or (
                 exists (
                   select 1
                     from public.auction_pipeline_control c
                    where c.id and c.enabled and c.source_details_enabled
                 )
                 and exists (
                   select 1
                     from public.auction_source_state state
                    where state.source_name = due.detail_source_name
                      and state.enabled
                      and (state.suspended_until is null or state.suspended_until <= p_now)
                 )
               )
             )
             and not exists (
               select 1
                 from public.auction_enrichment_jobs active
                where active.source_url = due.source_url
                  and active.status = 'running'
                  and coalesce(active.locked_at,active.updated_at)
                      >= p_now - interval '30 minutes'
             )
           ) as claimable,
           -- Description et faits attendent la tâche pdf de leur vente (garde de la revendication,
           -- 20261111050000) : une attente voulue, jamais une tâche immobile.
           (
             due.job_type in ('display_description', 'fact_extraction')
             and exists (
               select 1
                 from public.auction_enrichment_jobs pdf
                where pdf.source_url = due.source_url
                  and pdf.job_type = 'pdf'
                  and pdf.status in ('queued', 'running', 'failed')
                  and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)
             )
           ) as waits_for_pdf,
           due.job_type,
           due.status,
           due.updated_at,
           due.next_attempt_at
      from due_candidates due
      join revision_ranked revision
        on revision.id = due.id
  ), immobile_candidates as (
    -- Immobile (b) : prenable par la revendication, ni écrite ni attendue depuis 24 h (mesure gardée dans les
    -- détails ; elle n'ouvre plus l'alerte à elle seule).
    select classified.job_type
      from classified
     where classified.claimable
       and not classified.waits_for_pdf
       and classified.status <> 'running'
       and greatest(classified.updated_at, classified.next_attempt_at) < p_now - interval '24 hours'
  ), unserved_candidates as (
    -- Non servie : prenable, ni écrite ni attendue depuis 72 h.
    select classified.job_type
      from classified
     where classified.claimable
       and not classified.waits_for_pdf
       and classified.status <> 'running'
       and greatest(classified.updated_at, classified.next_attempt_at) < p_now - unserved_after
  )
  select (select count(*) from classified where claimable),
         (select count(*) from classified where not claimable),
         (select count(*) from immobile_candidates),
         (select count(*) from immobile_candidates where job_type = 'source_detail'),
         (select count(*) from unserved_candidates),
         (select count(*) from unserved_candidates where job_type = 'source_detail')
    into claimable_due, excluded_due, immobile_claimable, immobile_claimable_source_detail,
         unserved_claimable, unserved_claimable_source_detail;

  select count(*),
         count(*) filter (
           where created_at < p_now - interval '24 hours'
             and not (status = 'failed' and attempt_count >= max_attempts)
         ),
         count(*) filter (where status = 'failed' and attempt_count >= max_attempts),
         count(*) filter (
           where status = 'failed'
             and attempt_count >= max_attempts
             and updated_at >= p_now - interval '24 hours'
         ),
         count(*) filter (
           where status = 'queued'
             and last_error like 'Daily % budget exhausted%'
             and updated_at >= p_now - interval '24 hours'
         ),
         -- Immobile (a) : running dont le bail de 30 minutes a expiré depuis plus de 24 h, sans reprise.
         count(*) filter (
           where status = 'running'
             and coalesce(locked_at, updated_at) < p_now - interval '24 hours 30 minutes'
         )
    into backlog, delayed, exhausted, exhausted_recent, budget_deferred, immobile_running
    from public.auction_enrichment_jobs
   where status in ('queued', 'running', 'failed');
  -- Après le premier refus du budget IA du jour, le worker ne prend plus que des tâches source_detail
  -- (queued_runner._run_enrichment_queue_worker) : sous budget_limited, les autres attendent sans être touchées,
  -- un report voulu. Les mesures (b) ne comptent alors que les tâches source_detail ; le cas (a) (bail expiré
  -- depuis 24 h) compte toujours.
  immobile := immobile_running
    + case when budget_deferred > 0 then immobile_claimable_source_detail else immobile_claimable end;
  unserved := case when budget_deferred > 0 then unserved_claimable_source_detail else unserved_claimable end;

  -- Valeur de comparaison : la dernière observation de la file vieille d'au moins 24 h qui porte la mesure.
  select (observation.metrics->>'unserved_72h')::integer,
         observation.observed_at
    into unserved_previous, unserved_previous_at
    from public.auction_pipeline_observations observation
   where observation.source_name = 'enrichment-queue'
     and observation.observed_at <= p_now - unserved_trend_window
     and observation.metrics ? 'unserved_72h'
   order by observation.observed_at desc
   limit 1;

  evidence := jsonb_build_object(
    'backlog', backlog,
    'older_than_24h', delayed,
    'exhausted', exhausted,
    'exhausted_24h', exhausted_recent,
    'claimable_due', claimable_due,
    'excluded_due', excluded_due,
    'budget_deferred_24h', budget_deferred,
    'budget_limited', budget_deferred > 0,
    'immobile_24h', immobile,
    'expired_lease_24h', immobile_running,
    'unserved_72h', unserved
  );
  insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
  values ('enrichment-queue', p_now, evidence);
  perform app_private.sync_operational_alert(
    'pipeline.enrichment.stalled',
    'import',
    'warning',
    evidence || jsonb_build_object(
      'unserved_72h_24h_before', unserved_previous,
      'unserved_72h_compared_at', unserved_previous_at,
      'unserved_after_hours', 72,
      'expired_lease_after_hours', 24
    ),
    -- Un bail expiré depuis 24 h sans reprise est un blocage. Sinon, des tâches prenables qui attendent depuis
    -- 72 h ne signalent un blocage que si leur nombre n'a pas baissé en 24 h : une file longue qui avance n'est
    -- pas bloquée.
    immobile_running > 0
      or (
        unserved > 0
        and unserved_previous is not null
        and unserved >= unserved_previous
      ),
    p_now
  );
  -- Dead letters (failed, every attempt used) are never claimed again: they are
  -- reported apart from pipeline.enrichment.stalled, on a rise or a backlog. The
  -- rise is proportional to the live queue (backlog without dead letters).
  exhausted_recent_threshold := greatest(
    exhausted_recent_minimum,
    ceil((backlog - exhausted) * exhausted_recent_share)::integer
  );
  perform app_private.sync_operational_alert(
    'pipeline.enrichment.exhausted',
    'import',
    'warning',
    evidence || jsonb_build_object(
      'exhausted_24h_threshold', exhausted_recent_threshold,
      'exhausted_24h_minimum', exhausted_recent_minimum,
      'exhausted_24h_queue_share', exhausted_recent_share,
      'exhausted_threshold', exhausted_backlog_threshold
    ),
    exhausted_recent >= exhausted_recent_threshold or exhausted >= exhausted_backlog_threshold,
    p_now
  );

  -- Aggregated operation metrics follow the existing 90-day operational history policy.
  delete from public.auction_pipeline_observations
   where observed_at < p_now - interval '90 days';
  return jsonb_build_object('enabled', true, 'queue', evidence);
end;
$$;

revoke all on function public.observe_autonomous_pipeline(timestamptz)
  from public, anon, authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz)
  to service_role;

-- 5. Sentinelle qualité : redéfinition COMPLÈTE de app_private.evaluate_catalogue_quality_health(timestamptz),
-- point de départ 20261111100000. Seul change le lot Licitor discordant (deux évaluations consécutives).
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
  v_licitor_previous integer;
  v_day_start timestamptz := pg_catalog.date_trunc('day', p_now, 'UTC');
begin
  -- Invariants : une seule vente en ligne suffit.
  foreach v_key in array array['bedrooms_ge_rooms', 'land_with_rooms'] loop
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

  -- Lot Licitor discordant : invariant aussi, mais un cas transitoire est connu (page à plusieurs lots recalculée
  -- entre deux passages). Il faut une vente discordante à l'évaluation précédente ET à celle-ci. Chaque évaluation
  -- garde sa mesure (catalogue-quality-licitor-lot) pour la suivante.
  v_metric := v_metrics -> 'metrics' -> 'licitor_lot_mismatch';
  select (observation.metrics ->> 'count')::integer
    into v_licitor_previous
    from public.auction_pipeline_observations observation
   where observation.source_name = 'catalogue-quality-licitor-lot'
     and observation.observed_at < p_now
   order by observation.observed_at desc
   limit 1;
  insert into public.auction_pipeline_observations (source_name, observed_at, metrics)
  values ('catalogue-quality-licitor-lot', p_now, v_metric);
  perform app_private.sync_operational_alert(
    'catalogue.quality.licitor_lot_mismatch',
    'import',
    'warning',
    v_metric || pg_catalog.jsonb_build_object(
      'live_sales', v_live,
      'maximum_count', 0,
      'previous_count', v_licitor_previous,
      'consecutive_observations', 2
    ),
    (v_metric ->> 'count')::integer > 0 and coalesce(v_licitor_previous, 0) > 0,
    p_now
  );

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
  'Alertes catalogue.quality.* sur les ventes en ligne (lot Licitor discordant : deux évaluations consécutives), et cliché quotidien des mesures (auction_pipeline_observations, catalogue-quality). Appelée par evaluate_operational_health ; ne renvoie rien.';

-- 1. pipeline.import.unhealthy : redéfinition COMPLÈTE de app_private.evaluate_operational_health(timestamptz). Depuis
-- le lot R2b (20261118100000), une migration n'exécute plus de SQL assemblé (scripts/check-security-invariants) : la
-- méthode des retouches précédentes (pg_get_functiondef puis remplacement) n'est plus permise. Point de départ : la
-- définition de 20261101120200 et ses retouches en place (20261104100100, 20261106100300, 20261108100000,
-- 20261110120100, 20261110120200, 20261110120400, 20261111100000, 20261117100600), rejouées sur une base jetable et
-- recopiées À L'IDENTIQUE ; la garde md5 ci-dessous refuse tout autre corps. Seuls changent le seuil d'âge de file
-- (1 800 s -> 5 400 s) et la clé maximum_queued_age_seconds des détails.
do $guard_health$
declare
  health_md5 text := (
    select md5(procedure_row.prosrc)
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = 'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  );
begin
  if health_md5 not in (
    '18d10ed8ab3afbd15699fbe0ca04c311',  -- 20261117100600 et ses prédécesseurs (point de départ)
    'a3ffbb215334372e19ab6cc250d2e3f3'   -- cette migration, déjà appliquée
  ) then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected operational health body (md5 %s); refusing the import queue threshold.', health_md5
      );
  end if;
end;
$guard_health$;

create or replace function app_private.evaluate_operational_health(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  stale_cron_jobs text[] := '{}'::text[];
  webhook_failure_count integer;
  webhook_stuck_count integer;
  import_failure_count integer;
  import_stuck_count integer;
  import_backlog_count integer;
  oldest_import_age_seconds integer;
  refresh_backlog_count integer;
  oldest_refresh_age_seconds integer;
  dvf_batch_count bigint;
  dvf_transaction_count bigint;
  dvf_failed_since_last_success integer;
  dvf_stuck_count integer;
  dvf_last_completed_at timestamptz;
  retention_overdue_count integer;
  retention_oldest_overdue timestamptz;
  retention_passes_counted integer;
  retention_passes_remaining integer;
  invalidation_count integer;
  invalidation_oldest timestamptz;
  late_delivery_count integer;
  late_delivery_oldest timestamptz;
  snapshot_refreshed_at timestamptz;
  open_alert_count integer;
begin
  with expected(job_name, max_age) as (
    values
      ('operational-health', interval '65 minutes'),
      ('smart-alerts', interval '27 hours'),
      ('alert-notifications', interval '27 hours'),
      ('sale-change-monitor', interval '27 hours'),
      ('data-retention', interval '8 days'),
      ('sale-retention', interval '35 minutes'),
      ('information-agent-inbound', interval '25 minutes'),
      ('listing-completeness', interval '3 hours'), ('sale-pepites', interval '3 hours'), ('sale-flood-risk', interval '5 hours'),
      ('sale-reminders', interval '27 hours'), ('sale-results', interval '27 hours'), ('weekly-digest', interval '8 days'), ('fact-registry-check', interval '27 hours')
  )
  select coalesce(array_agg(expected.job_name order by expected.job_name), '{}'::text[])
  into stale_cron_jobs
  from expected
  where not exists (
    select 1
    from public.operational_job_runs run
    where run.job_name = expected.job_name
      and (
        (
          run.status = 'success'
          and run.finished_at >= p_now - expected.max_age
        )
        or (
          expected.job_name = 'operational-health'
          and run.status = 'running'
          and run.started_at >= p_now - interval '10 minutes'
        )
      )
  );

  select count(*)::integer into webhook_failure_count
  from public.stripe_webhook_events
  where processing_status = 'failed'
    and updated_at >= p_now - interval '1 hour';

  select count(*)::integer into webhook_stuck_count
  from public.stripe_webhook_events
  where processing_status = 'processing'
    and updated_at < p_now - interval '15 minutes';

  select count(*)::integer into import_failure_count
  from public.auction_runs
  where status = 'failed'
    and coalesce(finished_at, updated_at, created_at) >= p_now - interval '1 hour';

  select count(*)::integer into import_stuck_count
  from public.auction_runs
  where status = 'running'
    and started_at < p_now - interval '3 hours';

  select
    count(*)::integer,
    coalesce(max(extract(epoch from (p_now - created_at)))::integer, 0)
  into import_backlog_count, oldest_import_age_seconds
  from public.auction_runs
  where status = 'queued';

  select
    count(*)::integer,
    coalesce(max(extract(epoch from (p_now - created_at)))::integer, 0)
  into refresh_backlog_count, oldest_refresh_age_seconds
  from public.data_refresh_requests
  where status in ('queued', 'running');

  select
    count(*)::bigint,
    max(completed_at) filter (where status = 'completed'),
    count(*) filter (
      where status = 'running' and created_at < p_now - interval '6 hours'
    )::integer
  into dvf_batch_count, dvf_last_completed_at, dvf_stuck_count
  from public.dvf_import_batches;

  select count(*)::integer
  into dvf_failed_since_last_success
  from public.dvf_import_batches
  where status = 'failed'
    and updated_at >= p_now - interval '24 hours'
    and (dvf_last_completed_at is null or updated_at > dvf_last_completed_at);

  select
    case
      when exists (select 1 from public.dvf_transactions limit 1)
        then greatest(coalesce(dvf_table.reltuples::bigint, 0), 1)
      else 0
    end
  into dvf_transaction_count
  from pg_catalog.pg_class dvf_table
  join pg_catalog.pg_namespace dvf_schema on dvf_schema.oid = dvf_table.relnamespace
  where dvf_schema.nspname = 'public'
    and dvf_table.relname = 'dvf_transactions';

  -- Ventes échues pas encore purgées (index partiel auction_sales_catalogue_expiry_deadline_idx).
  -- La lecture s'arrête à 1 001 lignes : le nombre exact n'importe pas au-delà.
  select count(*)::integer, min(overdue.deadline)
  into retention_overdue_count, retention_oldest_overdue
  from (
    select sale.catalogue_expiry_deadline as deadline
    from public.auction_sales sale
    where sale.catalogue_expiry_materialized
      and sale.catalogue_expiry_deadline is not null
      and sale.catalogue_expiry_deadline <= p_now
    order by sale.catalogue_expiry_deadline
    limit 1001
  ) overdue;

  -- Les six derniers passages de la purge (toutes les 5 minutes) : tous réussis, tous avec des ventes
  -- restantes (`remaining` du résultat de /api/cron/sale-retention).
  select
    count(*)::integer,
    count(*) filter (
      where passes.status = 'success'
        and case
          when pg_catalog.jsonb_typeof(passes.summary->'remaining') = 'number'
            then (passes.summary->>'remaining')::numeric
          else 0
        end > 0
    )::integer
  into retention_passes_counted, retention_passes_remaining
  from (
    select run.status, run.summary
    from public.operational_job_runs run
    where run.job_name = 'sale-retention'
    order by run.started_at desc
    limit 6
  ) passes;

  -- Boîte d'invalidation du cache public (app_private.catalogue_invalidations, index sur `at`).
  select count(*)::integer, min(pending.at)
  into invalidation_count, invalidation_oldest
  from (
    select box.at
    from app_private.catalogue_invalidations box
    order by box.at
    limit 1001
  ) pending;

  -- Notifications d'alerte prévues depuis plus de 26 h et toujours en file (index delivery_status,
  -- scheduled_for). Les envois sont quotidiens : un retard normal reste sous 24 h.
  select count(*)::integer, min(late.scheduled_for)
  into late_delivery_count, late_delivery_oldest
  from (
    select notification.scheduled_for
    from public.user_alert_notifications notification
    where notification.delivery_status = 'queued'
      and notification.scheduled_for < p_now - interval '26 hours'
    order by notification.scheduled_for
    limit 1001
  ) late;

  -- Cliché des lots des scénarios d'enchères (ligne unique ; absente = jamais rempli).
  select state.refreshed_at into snapshot_refreshed_at
  from app_private.auction_scenario_snapshot_state state;

  perform app_private.sync_operational_alert(
    'cron.stale',
    'cron',
    'critical',
    jsonb_build_object(
      'stale_job_count', cardinality(stale_cron_jobs),
      'stale_jobs', to_jsonb(stale_cron_jobs)
    ),
    cardinality(stale_cron_jobs) > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'stripe.webhook.unhealthy',
    'webhook',
    'critical',
    jsonb_build_object(
      'failed_last_hour', webhook_failure_count,
      'stuck_processing', webhook_stuck_count
    ),
    webhook_failure_count > 0 or webhook_stuck_count > 0,
    p_now
  );

  -- Un échec isolé avec une file vide se rattrape seul (le lanceur relance la source au passage
  -- suivant) : seuil à 3 échecs dans l'heure, ou dès un échec quand une file attend.
  perform app_private.sync_operational_alert(
    'pipeline.import.unhealthy',
    'import',
    case
      when import_stuck_count > 0 or oldest_import_age_seconds > 7200 then 'critical'
      else 'warning'
    end,
    jsonb_build_object(
      'failed_last_hour', import_failure_count,
      'stuck_running', import_stuck_count,
      'queued', import_backlog_count,
      'oldest_queued_age_seconds', oldest_import_age_seconds,
      'failure_threshold', 3,
      'maximum_queued_age_seconds', 5400
    ),
    -- Âge de file : 5 400 s, soit 2 x la cadence de 30 min + un passage de ~29 min (20261201100000).
    import_failure_count >= 3
      or (import_failure_count > 0 and import_backlog_count > 0)
      or import_stuck_count > 0
      or oldest_import_age_seconds > 5400,
    p_now
  );

  perform app_private.sync_operational_alert(
    'refresh_queue.stale',
    'refresh_queue',
    case when oldest_refresh_age_seconds > 7200 then 'critical' else 'warning' end,
    jsonb_build_object(
      'backlog', refresh_backlog_count,
      'oldest_age_seconds', oldest_refresh_age_seconds
    ),
    oldest_refresh_age_seconds > 1800,
    p_now
  );

  perform app_private.sync_operational_alert(
    'dvf.freshness',
    'dvf',
    case
      when dvf_transaction_count = 0
        or dvf_failed_since_last_success > 0
        or dvf_stuck_count > 0 then 'critical'
      else 'warning'
    end,
    jsonb_build_object(
      'transaction_count', dvf_transaction_count,
      'batch_count', dvf_batch_count,
      'last_completed_at', dvf_last_completed_at,
      'failed_since_last_success', dvf_failed_since_last_success,
      'stuck_running', dvf_stuck_count,
      'maximum_age_days', 220
    ),
    dvf_transaction_count = 0
      or dvf_last_completed_at is null
      or dvf_last_completed_at < p_now - interval '220 days'
      or dvf_failed_since_last_success > 0
      or dvf_stuck_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'retention.sale.overdue',
    'cron',
    'critical',
    jsonb_build_object(
      'overdue_count', retention_overdue_count,
      'oldest_overdue_at', retention_oldest_overdue,
      'oldest_overdue_age_minutes',
        case
          when retention_oldest_overdue is null then null
          else (extract(epoch from (p_now - retention_oldest_overdue)) / 60)::integer
        end,
      'passes_checked', retention_passes_counted,
      'passes_with_remaining', retention_passes_remaining,
      'maximum_age_hours', 2,
      'passes_threshold', 6
    ),
    (
      retention_oldest_overdue is not null
      and retention_oldest_overdue < p_now - interval '2 hours'
    )
      or (retention_passes_counted = 6 and retention_passes_remaining = 6),
    p_now
  );

  perform app_private.sync_operational_alert(
    'catalogue.invalidation.backlog',
    'import',
    'warning',
    jsonb_build_object(
      'pending_count', invalidation_count,
      'oldest_at', invalidation_oldest,
      'oldest_age_minutes',
        case
          when invalidation_oldest is null then null
          else (extract(epoch from (p_now - invalidation_oldest)) / 60)::integer
        end,
      'maximum_age_hours', 2,
      'maximum_count', 1000
    ),
    (invalidation_oldest is not null and invalidation_oldest < p_now - interval '2 hours')
      or invalidation_count > 1000,
    p_now
  );

  perform app_private.sync_operational_alert(
    'alerts.delivery.late',
    'cron',
    'warning',
    jsonb_build_object(
      'late_count', late_delivery_count,
      'oldest_scheduled_for', late_delivery_oldest,
      'maximum_delay_hours', 26
    ),
    late_delivery_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'auction_scenarios.snapshot.stale',
    'cron',
    'warning',
    jsonb_build_object(
      'refreshed_at', snapshot_refreshed_at,
      'age_hours',
        case
          when snapshot_refreshed_at is null then null
          else (extract(epoch from (p_now - snapshot_refreshed_at)) / 3600)::integer
        end,
      'maximum_age_days', 3
    ),
    snapshot_refreshed_at is null or snapshot_refreshed_at < p_now - interval '3 days',
    p_now
  );

  perform app_private.evaluate_flood_pepite_reference_health(p_now);
  perform app_private.evaluate_catalogue_duplicates_health(p_now);
  perform app_private.evaluate_catalogue_quality_health(p_now);

  select count(*)::integer into open_alert_count
  from public.operational_alerts
  where status = 'open';

  return jsonb_build_object(
    'ok', open_alert_count = 0,
    'open_alerts', open_alert_count,
    'stale_crons', cardinality(stale_cron_jobs),
    'stale_cron_jobs', to_jsonb(stale_cron_jobs),
    'webhook_failures', webhook_failure_count,
    'webhook_stuck', webhook_stuck_count,
    'import_failures', import_failure_count,
    'import_stuck', import_stuck_count,
    'import_backlog', import_backlog_count,
    'oldest_import_age_seconds', oldest_import_age_seconds,
    'refresh_backlog', refresh_backlog_count,
    'oldest_refresh_age_seconds', oldest_refresh_age_seconds,
    'dvf_transactions', dvf_transaction_count,
    'dvf_batches', dvf_batch_count,
    'dvf_last_completed_at', dvf_last_completed_at,
    'dvf_failed_since_last_success', dvf_failed_since_last_success,
    'dvf_stuck', dvf_stuck_count,
    'retention_overdue', retention_overdue_count,
    'catalogue_invalidations', invalidation_count,
    'late_alert_deliveries', late_delivery_count,
    'auction_scenario_snapshot_refreshed_at', snapshot_refreshed_at
  );
end;
$function$;

revoke all on function app_private.evaluate_operational_health(timestamptz) from public, anon, authenticated;
grant execute on function app_private.evaluate_operational_health(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
