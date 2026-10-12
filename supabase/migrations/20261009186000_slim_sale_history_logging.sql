begin;

set local lock_timeout = '5s';

-- auction_sale_history grew by about 38 000 rows a day (592 MB in 23 days)
-- because every pipeline pass rewrote machine-generated columns that were then
-- logged as "changes".  The audit keeps the business columns; derived,
-- recomputed or per-run columns are no longer logged.
create or replace function public.log_auction_sale_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  changed jsonb;
begin
  select coalesce(
    jsonb_object_agg(
      current_value.key,
      case
        when jsonb_typeof(current_value.value) in ('object', 'array')
          or pg_column_size(current_value.value) > 2048
        then jsonb_build_object(
          'kind', 'changed_value_fingerprint',
          'size_bytes', pg_column_size(current_value.value),
          'md5', md5(current_value.value::text)
        )
        else current_value.value
      end
    ),
    '{}'::jsonb
  )
  into changed
  from jsonb_each(to_jsonb(new)) as current_value(key, value)
  left join jsonb_each(to_jsonb(old)) as previous_value(key, value)
    on previous_value.key = current_value.key
  where current_value.key not in (
      'updated_at', 'last_seen_at',
      'raw_payload', 'observations', 'last_run_id', 'raw_text',
      'score_factors', 'quality_flags', 'investment_summary', 'dedupe_confidence',
      'investment_score', 'score_confidence', 'sale_procedure'
    )
    and current_value.key not like 'premium\_readiness\_%'
    and current_value.key not like 'catalogue\_%'
    and current_value.key not like 'retention\_deadline%'
    and current_value.value is distinct from previous_value.value;

  if changed <> '{}'::jsonb then
    insert into public.auction_sale_history (source_url, changed_at, changed_fields)
    values (new.source_url, statement_timestamp(), changed);
  end if;
  return new;
end;
$function$;

-- A new evaluation timestamp alone is not a change of the readiness verdict.
create or replace function app_private.record_auction_sale_readiness_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and
     new.premium_readiness_score is not distinct from old.premium_readiness_score and
     new.premium_readiness_status is not distinct from old.premium_readiness_status and
     new.premium_readiness_policy_version is not distinct from old.premium_readiness_policy_version and
     new.premium_readiness_factors is not distinct from old.premium_readiness_factors and
     new.premium_readiness_blockers is not distinct from old.premium_readiness_blockers and
     new.premium_readiness_missing_fields is not distinct from old.premium_readiness_missing_fields and
     new.premium_readiness_override is not distinct from old.premium_readiness_override and
     new.premium_readiness_override_reason is not distinct from old.premium_readiness_override_reason and
     new.premium_readiness_override_expires_at is not distinct from old.premium_readiness_override_expires_at then
    return new;
  end if;

  insert into public.auction_sale_readiness_history (
    sale_id, readiness_score, readiness_status, policy_version, factors,
    blockers, missing_fields, evaluated_at, override_decision, override_reason,
    override_by, override_at, override_expires_at
  ) values (
    new.id, new.premium_readiness_score, new.premium_readiness_status,
    new.premium_readiness_policy_version, new.premium_readiness_factors,
    new.premium_readiness_blockers, new.premium_readiness_missing_fields,
    new.premium_readiness_evaluated_at, new.premium_readiness_override,
    new.premium_readiness_override_reason, new.premium_readiness_override_by,
    new.premium_readiness_override_at, new.premium_readiness_override_expires_at
  );
  return new;
end;
$function$;

-- Keep twelve months of both audit tables; the purge needs an index on the
-- timestamp to avoid scanning them whole.
create index if not exists auction_sale_history_changed_at_idx
  on public.auction_sale_history (changed_at);
create index if not exists auction_sale_readiness_history_recorded_at_idx
  on public.auction_sale_readiness_history (recorded_at);

create or replace function app_private.purge_expired_operational_data(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  deleted_usage bigint := 0;
  deleted_exports bigint := 0;
  deleted_notifications bigint := 0;
  deleted_valuations bigint := 0;
  deleted_placements bigint := 0;
  deleted_webhooks bigint := 0;
  deleted_rate_limits bigint := 0;
  deleted_job_runs bigint := 0;
  deleted_commercial_acceptances bigint := 0;
  deleted_data_subject_requests bigint := 0;
  deleted_sale_history bigint := 0;
  deleted_readiness_history bigint := 0;
begin
  delete from public.feature_usage_events where created_at < p_now - interval '24 months';
  get diagnostics deleted_usage = row_count;

  delete from public.sale_data_exports where created_at < p_now - interval '24 months';
  get diagnostics deleted_exports = row_count;

  delete from public.user_alert_notifications
  where created_at < p_now - interval '6 months'
    and (read_at is not null or dismissed_at is not null or delivery_status in ('failed', 'cancelled'));
  get diagnostics deleted_notifications = row_count;

  delete from public.valuation_estimates where created_at < p_now - interval '24 months';
  get diagnostics deleted_valuations = row_count;

  delete from public.lawyer_placement_events where created_at < p_now - interval '24 months';
  get diagnostics deleted_placements = row_count;

  delete from public.stripe_webhook_events where received_at < p_now - interval '24 months';
  get diagnostics deleted_webhooks = row_count;

  delete from public.api_rate_limit_buckets where window_started_at < p_now - interval '2 days';
  get diagnostics deleted_rate_limits = row_count;

  delete from public.operational_job_runs where started_at < p_now - interval '24 months';
  get diagnostics deleted_job_runs = row_count;

  delete from public.commercial_acceptances where archived_until <= p_now;
  get diagnostics deleted_commercial_acceptances = row_count;

  delete from public.data_subject_requests
  where completed_at is not null
    and completed_at < p_now - interval '5 years';
  get diagnostics deleted_data_subject_requests = row_count;

  delete from public.auction_sale_history where changed_at < p_now - interval '12 months';
  get diagnostics deleted_sale_history = row_count;

  delete from public.auction_sale_readiness_history where recorded_at < p_now - interval '12 months';
  get diagnostics deleted_readiness_history = row_count;

  return jsonb_build_object(
    'feature_usage_events', deleted_usage,
    'sale_data_exports', deleted_exports,
    'user_alert_notifications', deleted_notifications,
    'valuation_estimates', deleted_valuations,
    'lawyer_placement_events', deleted_placements,
    'stripe_webhook_events', deleted_webhooks,
    'api_rate_limit_buckets', deleted_rate_limits,
    'operational_job_runs', deleted_job_runs,
    'commercial_acceptances', deleted_commercial_acceptances,
    'data_subject_requests', deleted_data_subject_requests,
    'auction_sale_history', deleted_sale_history,
    'auction_sale_readiness_history', deleted_readiness_history
  );
end;
$function$;

commit;
