begin;

-- User-facing publication inserts must never be able to set moderation fields.
revoke insert on table public.listing_publication_requests from authenticated;
grant insert (
  id,
  requester_id,
  requester_email,
  title,
  location,
  starting_price_eur,
  hearing_date,
  court,
  description,
  strengths,
  cautions,
  anonymize_documents,
  document_types,
  promotion_options,
  submitted_documents
) on public.listing_publication_requests to authenticated;

-- Referral matching, report snapshots, notification delivery and export audit rows
-- are server-owned. Authenticated users retain read access through RLS.
revoke insert on table public.lawyer_referral_requests from authenticated;
revoke insert, update, delete on table public.saved_property_reports from authenticated;
revoke insert on table public.property_report_exports from authenticated;
revoke insert on table public.sale_data_exports from authenticated;
revoke insert, update, delete on table public.user_alert_notifications from authenticated;
grant update (read_at, dismissed_at, updated_at)
  on public.user_alert_notifications to authenticated;

alter table public.listing_publication_requests
  drop constraint if exists listing_publication_requests_documents_size_check,
  add constraint listing_publication_requests_documents_size_check check (
    jsonb_typeof(submitted_documents) = 'array'
    and jsonb_array_length(submitted_documents) <= 20
    and pg_column_size(submitted_documents) <= 131072
  ) not valid;

alter table public.lawyer_referral_requests
  drop constraint if exists lawyer_referral_requests_snapshot_size_check,
  add constraint lawyer_referral_requests_snapshot_size_check check (
    jsonb_typeof(sale_snapshot) = 'object'
    and pg_column_size(sale_snapshot) <= 65536
    and jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 32768
  ) not valid;

alter table public.saved_property_reports
  drop constraint if exists saved_property_reports_snapshot_size_check,
  add constraint saved_property_reports_snapshot_size_check check (
    jsonb_typeof(report_snapshot) = 'object'
    and pg_column_size(report_snapshot) <= 1048576
    and pg_column_size(market_snapshot) <= 262144
    and pg_column_size(coalesce(environmental_snapshot, '{}'::jsonb)) <= 262144
    and pg_column_size(ceiling_snapshot) <= 131072
  ) not valid,
  drop constraint if exists saved_property_reports_share_expiry_check,
  add constraint saved_property_reports_share_expiry_check check (
    share_expires_at is null
    or (
      shared_at is not null
      and share_expires_at > shared_at
      and share_expires_at <= shared_at + interval '90 days'
    )
  ) not valid;

alter table public.user_alert_notifications
  drop constraint if exists user_alert_notifications_snapshot_size_check,
  add constraint user_alert_notifications_snapshot_size_check check (
    jsonb_typeof(notification_snapshot) = 'object'
    and pg_column_size(notification_snapshot) <= 32768
  ) not valid;

create or replace function app_private.has_active_analysis_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_subscriptions subscription
    where subscription.user_id = p_user_id
      and subscription.plan_code = 'analyse'
      and subscription.status in ('trialing', 'active')
      and (
        subscription.current_period_end is null
        or subscription.current_period_end > statement_timestamp()
      )
  );
$$;

revoke all on function app_private.has_active_analysis_access(uuid) from public, anon, authenticated;
grant execute on function app_private.has_active_analysis_access(uuid) to service_role;

create or replace function app_private.enforce_finite_resource_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count bigint;
  quota_key text;
  target_user_id uuid;
begin
  if tg_table_name = 'sale_workspace_collaborators' then
    target_user_id := new.owner_id;
  else
    target_user_id := new.user_id;
  end if;

  if target_user_id is null then
    raise exception using errcode = '23514', message = 'Quota owner is required.';
  end if;

  if session_user not in ('postgres', 'supabase_admin')
    and not app_private.has_active_analysis_access(target_user_id)
    and not coalesce(public.is_admin(), false) then
    raise exception using errcode = '42501', message = 'Analyse access is required.';
  end if;

  quota_key := tg_table_name || ':' || target_user_id::text;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(quota_key, 0));

  case tg_table_name
    when 'user_api_keys' then
      if new.revoked_at is not null then return new; end if;
      select count(*) into current_count
      from public.user_api_keys item
      where item.user_id = new.user_id
        and item.revoked_at is null
        and item.id <> new.id;
      if current_count >= 2 then
        raise exception using errcode = 'P0001', message = 'Quota de 2 clés API actives atteint.';
      end if;
    when 'user_watched_zones' then
      if not new.is_active then return new; end if;
      select count(*) into current_count
      from public.user_watched_zones item
      where item.user_id = new.user_id
        and item.is_active
        and item.id <> new.id;
      if current_count >= 25 then
        raise exception using errcode = 'P0001', message = 'Quota de 25 zones surveillées atteint.';
      end if;
    when 'user_sale_analysis_sets' then
      if new.is_archived then return new; end if;
      select count(*) into current_count
      from public.user_sale_analysis_sets item
      where item.user_id = new.user_id
        and not item.is_archived
        and item.id <> new.id;
      if current_count >= 20 then
        raise exception using errcode = 'P0001', message = 'Quota de 20 analyses multi-biens atteint.';
      end if;
    when 'user_sale_analysis_items' then
      quota_key := tg_table_name || ':' || new.analysis_set_id::text;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(quota_key, 0));
      select count(*) into current_count
      from public.user_sale_analysis_items item
      where item.analysis_set_id = new.analysis_set_id
        and item.id <> new.id;
      if current_count >= 12 then
        raise exception using errcode = 'P0001', message = 'Quota de 12 biens par analyse atteint.';
      end if;
    when 'sale_workspace_collaborators' then
      if new.status = 'revoked' then return new; end if;
      quota_key := tg_table_name || ':' || new.workspace_id::text;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(quota_key, 0));
      select count(*) into current_count
      from public.sale_workspace_collaborators item
      where item.workspace_id = new.workspace_id
        and item.status <> 'revoked'
        and item.id <> new.id;
      if current_count >= 25 then
        raise exception using errcode = 'P0001', message = 'Quota de 25 collaborateurs par dossier atteint.';
      end if;
    else
      raise exception using errcode = '0A000', message = 'Unsupported quota trigger table.';
  end case;

  return new;
end;
$$;

revoke all on function app_private.enforce_finite_resource_quota() from public, anon, authenticated;

drop trigger if exists enforce_user_api_keys_quota on public.user_api_keys;
create trigger enforce_user_api_keys_quota
before insert or update of user_id, revoked_at on public.user_api_keys
for each row execute function app_private.enforce_finite_resource_quota();

drop trigger if exists enforce_user_watched_zones_quota on public.user_watched_zones;
create trigger enforce_user_watched_zones_quota
before insert or update of user_id, is_active on public.user_watched_zones
for each row execute function app_private.enforce_finite_resource_quota();

drop trigger if exists enforce_user_sale_analysis_sets_quota on public.user_sale_analysis_sets;
create trigger enforce_user_sale_analysis_sets_quota
before insert or update of user_id, is_archived on public.user_sale_analysis_sets
for each row execute function app_private.enforce_finite_resource_quota();

drop trigger if exists enforce_user_sale_analysis_items_quota on public.user_sale_analysis_items;
create trigger enforce_user_sale_analysis_items_quota
before insert or update of user_id, analysis_set_id on public.user_sale_analysis_items
for each row execute function app_private.enforce_finite_resource_quota();

drop trigger if exists enforce_sale_workspace_collaborators_quota
on public.sale_workspace_collaborators;
create trigger enforce_sale_workspace_collaborators_quota
before insert or update of owner_id, workspace_id, status on public.sale_workspace_collaborators
for each row execute function app_private.enforce_finite_resource_quota();

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  processing_status text not null default 'processing' check (
    processing_status in ('processing', 'processed', 'ignored', 'failed')
  ),
  attempt_count integer not null default 1 check (attempt_count > 0),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_webhook_events to service_role;

create or replace function public.begin_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_livemode boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  insert into public.stripe_webhook_events (event_id, event_type, livemode)
  values (p_event_id, p_event_type, p_livemode)
  on conflict (event_id) do update
  set event_type = excluded.event_type,
      livemode = excluded.livemode,
      processing_status = 'processing',
      attempt_count = public.stripe_webhook_events.attempt_count + 1,
      error_message = null,
      processed_at = null,
      updated_at = statement_timestamp()
  where public.stripe_webhook_events.processing_status = 'failed'
     or (
       public.stripe_webhook_events.processing_status = 'processing'
       and public.stripe_webhook_events.updated_at < statement_timestamp() - interval '15 minutes'
     );
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;

create or replace function public.complete_stripe_webhook_event(
  p_event_id text,
  p_processing_status text,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_processing_status not in ('processed', 'ignored', 'failed') then
    raise exception using errcode = '22023', message = 'Invalid Stripe event status.';
  end if;

  update public.stripe_webhook_events
  set processing_status = p_processing_status,
      error_message = left(p_error_message, 1000),
      processed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where event_id = p_event_id;
end;
$$;

revoke all on function public.begin_stripe_webhook_event(text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.complete_stripe_webhook_event(text, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_stripe_webhook_event(text, text, boolean) to service_role;
grant execute on function public.complete_stripe_webhook_event(text, text, text) to service_role;

create table if not exists public.api_rate_limit_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket_key text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, bucket_key, window_started_at)
);

alter table public.api_rate_limit_buckets enable row level security;
revoke all on table public.api_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.api_rate_limit_buckets to service_role;

create table if not exists public.operational_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  summary jsonb not null default '{}'::jsonb check (pg_column_size(summary) <= 32768),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0)
);

create index if not exists operational_job_runs_name_started_idx
  on public.operational_job_runs (job_name, started_at desc);

alter table public.operational_job_runs enable row level security;
revoke all on table public.operational_job_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.operational_job_runs to service_role;

create or replace function public.begin_operational_job_run(p_job_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  run_id uuid;
begin
  if nullif(pg_catalog.btrim(p_job_name), '') is null then
    raise exception using errcode = '22023', message = 'Job name is required.';
  end if;
  insert into public.operational_job_runs (job_name)
  values (left(pg_catalog.btrim(p_job_name), 120))
  returning id into run_id;
  return run_id;
end;
$$;

create or replace function public.finish_operational_job_run(
  p_run_id uuid,
  p_status text,
  p_summary jsonb default '{}'::jsonb,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('success', 'failed') then
    raise exception using errcode = '22023', message = 'Invalid job status.';
  end if;
  update public.operational_job_runs
  set status = p_status,
      summary = case
        when pg_column_size(coalesce(p_summary, '{}'::jsonb)) <= 32768
          then coalesce(p_summary, '{}'::jsonb)
        else jsonb_build_object('truncated', true)
      end,
      error_message = left(p_error_message, 1000),
      finished_at = statement_timestamp(),
      duration_ms = greatest(0, floor(extract(epoch from (statement_timestamp() - started_at)) * 1000)::integer)
  where id = p_run_id;
end;
$$;

revoke all on function public.begin_operational_job_run(text) from public, anon, authenticated;
revoke all on function public.finish_operational_job_run(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.begin_operational_job_run(text) to service_role;
grant execute on function public.finish_operational_job_run(uuid, text, jsonb, text) to service_role;

create or replace function public.consume_api_rate_limit(
  p_user_id uuid,
  p_bucket_key text,
  p_window_seconds integer,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  bucket_start timestamptz;
  next_count integer;
begin
  if p_user_id is null
    or nullif(pg_catalog.btrim(p_bucket_key), '') is null
    or p_window_seconds < 1
    or p_limit < 1 then
    raise exception using errcode = '22023', message = 'Invalid rate-limit parameters.';
  end if;

  bucket_start := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from statement_timestamp()) / p_window_seconds)
      * p_window_seconds
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_bucket_key || ':' || bucket_start::text, 0)
  );

  insert into public.api_rate_limit_buckets (
    user_id,
    bucket_key,
    window_started_at,
    request_count,
    updated_at
  ) values (
    p_user_id,
    p_bucket_key,
    bucket_start,
    1,
    statement_timestamp()
  )
  on conflict (user_id, bucket_key, window_started_at)
  do update set
    request_count = public.api_rate_limit_buckets.request_count + 1,
    updated_at = statement_timestamp()
  returning request_count into next_count;

  if next_count > p_limit then
    raise exception using errcode = 'P0001', message = 'Rate limit exceeded.';
  end if;

  return next_count;
end;
$$;

revoke all on function public.consume_api_rate_limit(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, text, integer, integer)
  to service_role;

create or replace function app_private.purge_expired_operational_data(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_usage bigint := 0;
  deleted_exports bigint := 0;
  deleted_notifications bigint := 0;
  deleted_valuations bigint := 0;
  deleted_placements bigint := 0;
  deleted_webhooks bigint := 0;
  deleted_rate_limits bigint := 0;
  deleted_job_runs bigint := 0;
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

  return jsonb_build_object(
    'feature_usage_events', deleted_usage,
    'sale_data_exports', deleted_exports,
    'user_alert_notifications', deleted_notifications,
    'valuation_estimates', deleted_valuations,
    'lawyer_placement_events', deleted_placements,
    'stripe_webhook_events', deleted_webhooks,
    'api_rate_limit_buckets', deleted_rate_limits,
    'operational_job_runs', deleted_job_runs
  );
end;
$$;

revoke all on function app_private.purge_expired_operational_data(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_expired_operational_data(timestamptz)
  to service_role;

create or replace function public.run_data_retention(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app_private.purge_expired_operational_data(p_now);
$$;

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
