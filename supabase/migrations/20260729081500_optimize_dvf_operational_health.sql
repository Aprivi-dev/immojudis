begin;

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
  dvf_failed_count integer;
  dvf_stuck_count integer;
  dvf_last_completed_at timestamptz;
  open_alert_count integer;
begin
  with expected(job_name, max_age) as (
    values
      ('operational-health', interval '45 minutes'),
      ('smart-alerts', interval '30 hours'),
      ('alert-notifications', interval '30 hours'),
      ('sale-change-monitor', interval '30 hours'),
      ('precompute-valuations', interval '30 hours'),
      ('data-retention', interval '8 days'),
      ('cnb-lawyer-directory', interval '8 days')
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
      where status = 'failed' and updated_at >= p_now - interval '24 hours'
    )::integer,
    count(*) filter (
      where status = 'running' and created_at < p_now - interval '6 hours'
    )::integer
  into dvf_batch_count, dvf_last_completed_at, dvf_failed_count, dvf_stuck_count
  from public.dvf_import_batches;

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
      'oldest_queued_age_seconds', oldest_import_age_seconds
    ),
    import_failure_count > 0
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
      when dvf_transaction_count = 0 or dvf_failed_count > 0 or dvf_stuck_count > 0 then 'critical'
      else 'warning'
    end,
    jsonb_build_object(
      'transaction_count', dvf_transaction_count,
      'batch_count', dvf_batch_count,
      'last_completed_at', dvf_last_completed_at,
      'failed_last_day', dvf_failed_count,
      'stuck_running', dvf_stuck_count,
      'maximum_age_days', 220
    ),
    dvf_transaction_count = 0
      or dvf_last_completed_at is null
      or dvf_last_completed_at < p_now - interval '220 days'
      or dvf_failed_count > 0
      or dvf_stuck_count > 0,
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
    'dvf_failed_last_day', dvf_failed_count,
    'dvf_stuck', dvf_stuck_count
  );
end;
$$;

revoke all on function app_private.evaluate_operational_health(timestamptz)
from public, anon, authenticated;
grant execute on function app_private.evaluate_operational_health(timestamptz) to service_role;

commit;
