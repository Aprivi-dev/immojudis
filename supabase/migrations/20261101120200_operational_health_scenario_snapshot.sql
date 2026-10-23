begin;

set local lock_timeout = '5s';

-- Chantier W3 « scénarios d'enchères » (compte-rendu du 23/10/2026, point 6) : l'âge du cliché des lots n'était
-- surveillé par personne. Le cliché (app_private.auction_scenario_observation_snapshot, 20261031100800) est
-- rafraîchi par la collecte Licitor ; si cette collecte tombe en panne (ou si la recopie échoue), les scénarios
-- se figent sans alerte. Redéfinition complète de app_private.evaluate_operational_health(timestamptz).
--
-- Point de départ : la dernière définition est celle de 20261029170000 (W9), reprise À L'IDENTIQUE, y compris
-- la liste des tâches attendues de cron.stale, vérifiée par la garde juste en dessous. Seul ajout :
--   * auction_scenarios.snapshot.stale (catégorie cron, avertissement) : app_private.auction_scenario_snapshot_state
--     .refreshed_at date de plus de 3 jours, ou le cliché n'a jamais été rempli. La collecte le rafraîchit au
--     plus une fois par jour (davantage quand des lots sont attestés) : trois jours sans recopie réussie
--     signalent une collecte arrêtée ou une recopie qui échoue (refusée par la garde de réduction, délai dépassé).
--     Un jour de retard ou deux, un week-end, ne déclenchent rien.
--   * la réponse gagne la clé auction_scenario_snapshot_refreshed_at.
--
-- Sans réparation de données. Une base où la définition n'a pas la forme attendue fait échouer la migration
-- (refuser de deviner) au lieu d'écraser une définition modifiée entre-temps.
do $guard$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  );
begin
  -- Déjà redéfinie par cette migration : rien à vérifier, le remplacement ci-dessous est idempotent.
  if position('auction_scenarios.snapshot.stale' in definition) > 0 then
    return;
  end if;
  if position('(''operational-health'', interval ''45 minutes'')' in definition) = 0
    or position('(''data-retention'', interval ''8 days'')' in definition) = 0
    or position('(''sale-retention'', interval ''20 minutes'')' in definition) = 0
    or position('(''information-agent-inbound'', interval ''10 minutes'')' in definition) = 0
    or position('(''listing-completeness'', interval ''3 hours'')' in definition) = 0
    or position('(''sale-reminders'', interval ''27 hours'')' in definition) = 0
    or position('(''smart-alerts'', interval ''27 hours'')' in definition) = 0
    or position('(''alert-notifications'', interval ''27 hours'')' in definition) = 0
    or position('(''sale-change-monitor'', interval ''27 hours'')' in definition) = 0
    or position('dvf_failed_since_last_success' in definition) = 0
    or position('alerts.delivery.late' in definition) = 0
    or position('catalogue.invalidation.backlog' in definition) = 0
    or position('retention.sale.overdue' in definition) = 0
    or position('precompute-valuations' in definition) > 0 then
    raise exception using
      errcode = '55000',
      message = 'Operational health definition changed; review before redefining it (W3).';
  end if;
end;
$guard$;

create or replace function app_private.evaluate_operational_health(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
      ('operational-health', interval '45 minutes'),
      ('smart-alerts', interval '27 hours'),
      ('alert-notifications', interval '27 hours'),
      ('sale-change-monitor', interval '27 hours'),
      ('data-retention', interval '8 days'),
      ('sale-retention', interval '20 minutes'),
      ('information-agent-inbound', interval '10 minutes'),
      ('listing-completeness', interval '3 hours'),
      ('sale-reminders', interval '27 hours')
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
      'failure_threshold', 3
    ),
    import_failure_count >= 3
      or (import_failure_count > 0 and import_backlog_count > 0)
      or import_stuck_count > 0
      or oldest_import_age_seconds > 1800,
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
$$;

-- CREATE OR REPLACE conserve les droits existants ; on réaffirme la frontière privée.
revoke all on function app_private.evaluate_operational_health(timestamptz)
from public, anon, authenticated;
grant execute on function app_private.evaluate_operational_health(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
