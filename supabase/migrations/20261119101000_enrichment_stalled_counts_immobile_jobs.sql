begin;

set local lock_timeout = '5s';

-- Alerte pipeline.enrichment.stalled : une tâche immobile depuis 24 h se compte à part, budget IA atteint ou non
-- (14/11/2026, état des lieux, T6 et D12).
--
-- Constat : depuis 20261029170100, dès qu'une tâche a été reportée par le budget IA du jour dans les 24 h
-- (budget_limited), l'alerte ne regarde plus que les tâches source_detail. Une lecture de pièces (pdf) restée en
-- « running » depuis le 11/11 12:58, bail de 30 minutes expiré depuis longtemps et vente bloquée derrière elle
-- (description et faits attendent sa tâche pdf), n'ouvrait donc rien.
--
-- Redéfinition COMPLÈTE de public.observe_autonomous_pipeline(timestamptz), point de départ 20261029170100 (aucune
-- migration ne l'a modifiée depuis). Seuls changent :
--   * la mesure immobile_24h, somme de deux comptes :
--     (a) tâche running dont le bail de 30 minutes a expiré depuis plus de 24 h sans reprise ;
--     (b) tâche PRENABLE (colonne claimable de la CTE classified : vente gardée, révision la plus récente, source
--         active, aucun bail en cours sur la vente), hors attente d'une tâche pdf de la même vente (garde de
--         20261111050000), dont ni la dernière écriture (updated_at) ni l'échéance de la prochaine tentative
--         (next_attempt_at) ne datent de moins de 24 h.
--     Une tâche retenue volontairement (attente de la lecture des pièces, source désactivée ou suspendue, révision
--     remplacée, vente expirée) n'est jamais immobile. Chaque écriture d'attempt_count (prise, fin, report) pose
--     aussi updated_at : une tâche dont updated_at n'a pas bougé n'a pas changé d'attempt_count. L'échéance protège
--     un report voulu (budget jusqu'à minuit UTC, attente d'accès de 24 h, Retry-After) ;
--   * la condition de l'alerte : immobile_24h > 0 l'ouvre toujours ; sinon la règle de 20261029170100 s'applique
--     (budget_limited : seules les tâches source_detail de plus de 24 h ; sinon toute tâche de plus de 24 h).
-- Tout le reste est recopié tel quel : alertes des sources, pilote coupé, inventaire, tâches épuisées, droits.
--
-- Invariant (services/data-pipeline/tests/test_pipeline_cadence_invariants.py) : un seul seuil
-- « ) < p_now - interval 'N hours'; » dans ce fichier, celui de .missed (18 heures).
--
-- Sans réparation de données : la migration ne touche aucune ligne, la tâche bloquée du 11/11 se traite à part
-- (docs/runbooks/pipeline-enrichment-stalled.md). Une base dont l'observateur ne ressemble pas au point de départ
-- fait échouer la migration (refuser de deviner).
--
-- RETOUR ARRIÈRE : réappliquer la définition de 20261029170100_pipeline_observer_alerts.sql.
-- Garde de départ : empreinte md5 du corps (pg_proc.prosrc), mesurée sur la définition de 20261029170100 rejouée
-- telle quelle, et celle du corps ci-dessous (migration rejouée). Tout autre corps, même voisin, fait échouer la
-- migration : une modification faite hors migration serait sinon écrasée sans le dire.
do $guard$
declare
  body_md5 text := (
    select md5(procedure_row.prosrc)
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid = 'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
begin
  if body_md5 not in (
    'fcab3b61c4a6841134d95e569fbfb05b',  -- 20261029170100 (point de départ)
    '7c716e042eb481d63d99e7f2060c1d05'   -- cette migration, déjà appliquée
  ) then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected health observer body (md5 %s); refusing the immobile-job redefinition.', body_md5
      );
  end if;
end;
$guard$;

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
  budget_deferred integer;
  delayed_source_detail integer;
  immobile integer;
  immobile_running integer;
  immobile_claimable integer;
  alert_active boolean;
  enabled_at timestamptz;
  control_enabled boolean;
  control_changed_at timestamptz;
  enabled_source_count integer;
  recent_inventory_count integer;
  current_active integer;
  current_ratio numeric;
  previous_active integer;
  previous_ratio numeric;
  publication_stale_after constant interval := interval '36 hours';
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
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.missed',
      'import',
      'critical',
      evidence,
      alert_active,
      p_now
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
    -- Annonces non revues : moins de 80 % des annonces actives de la source ont été revues
    -- récemment, sur deux observations consécutives, pour une source activée d'au moins 10 ventes.
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.stale_listings',
      'import',
      'warning',
      evidence || jsonb_build_object(
        'previous_freshness_ratio', previous_ratio,
        'freshness_ratio_threshold', 0.8,
        'minimum_active_listings', 10
      ),
      source_row.enabled
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
           due.status,
           due.updated_at,
           due.next_attempt_at
      from due_candidates due
      join revision_ranked revision
        on revision.id = due.id
  )
  select count(*) filter (where claimable),
         count(*) filter (where not claimable),
         -- Immobile (b) : prenable par la revendication, ni écrite ni attendue depuis 24 h.
         count(*) filter (
           where claimable
             and not waits_for_pdf
             and status <> 'running'
             and greatest(updated_at, next_attempt_at) < p_now - interval '24 hours'
         )
    into claimable_due, excluded_due, immobile_claimable
    from classified;

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
         count(*) filter (
           where created_at < p_now - interval '24 hours'
             and not (status = 'failed' and attempt_count >= max_attempts)
             and job_type = 'source_detail'
         ),
         -- Immobile (a) : running dont le bail de 30 minutes a expiré depuis plus de 24 h, sans reprise.
         count(*) filter (
           where status = 'running'
             and coalesce(locked_at, updated_at) < p_now - interval '24 hours 30 minutes'
         )
    into backlog, delayed, exhausted, exhausted_recent, budget_deferred, delayed_source_detail, immobile_running
    from public.auction_enrichment_jobs
   where status in ('queued', 'running', 'failed');
  immobile := immobile_running + immobile_claimable;
  evidence := jsonb_build_object(
    'backlog', backlog,
    'older_than_24h', delayed,
    'exhausted', exhausted,
    'exhausted_24h', exhausted_recent,
    'claimable_due', claimable_due,
    'excluded_due', excluded_due,
    'budget_deferred_24h', budget_deferred,
    'budget_limited', budget_deferred > 0,
    'immobile_24h', immobile
  );
  insert into public.auction_pipeline_observations(source_name, observed_at, metrics)
  values ('enrichment-queue', p_now, evidence);
  perform app_private.sync_operational_alert(
    'pipeline.enrichment.stalled',
    'import',
    'warning',
    evidence,
    -- Une tâche immobile depuis 24 h est un blocage, budget atteint ou non. Sinon, quand le budget IA du jour a
    -- reporté des tâches (budget_limited), les tâches de lecture et d'extraction qui attendent sont un report
    -- voulu : seules les tâches de collecte des fiches (source_detail, sans IA) signalent encore un blocage.
    immobile > 0
      or case when budget_deferred > 0 then delayed_source_detail > 0 else delayed > 0 end,
    p_now
  );
  -- Dead letters (failed, every attempt used) are never claimed again: they are
  -- reported apart from pipeline.enrichment.stalled, on a rise or a backlog.
  perform app_private.sync_operational_alert(
    'pipeline.enrichment.exhausted',
    'import',
    'warning',
    evidence || jsonb_build_object(
      'exhausted_24h_threshold', 3,
      'exhausted_threshold', 50
    ),
    exhausted_recent >= 3 or exhausted >= 50,
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

notify pgrst, 'reload schema';

commit;
