begin;

-- Phase 6 keeps commercial consent evidence separate from mutable account data.
-- The user reference is deliberately nullable: an account can be erased while the
-- minimum contract/accounting evidence remains archived for the applicable period.
create table public.commercial_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  purpose text not null default 'analyse_checkout' check (purpose = 'analyse_checkout'),
  terms_version text not null,
  terms_sha256 text not null check (terms_sha256 ~ '^[0-9a-f]{64}$'),
  privacy_version text not null,
  privacy_sha256 text not null check (privacy_sha256 ~ '^[0-9a-f]{64}$'),
  offer_code text not null check (offer_code = 'analyse_30_days'),
  amount_cents integer not null check (amount_cents = 2900),
  currency text not null check (currency = 'eur'),
  terms_accepted boolean not null check (terms_accepted),
  payment_obligation_acknowledged boolean not null check (payment_obligation_acknowledged),
  immediate_performance_requested boolean not null check (immediate_performance_requested),
  withdrawal_information_acknowledged boolean not null check (withdrawal_information_acknowledged),
  requester_email_hash text check (
    requester_email_hash is null or requester_email_hash ~ '^[0-9a-f]{64}$'
  ),
  request_id text,
  user_agent_hash text check (user_agent_hash is null or user_agent_hash ~ '^[0-9a-f]{64}$'),
  checkout_session_id text unique,
  checkout_created_at timestamptz,
  accepted_at timestamptz not null default statement_timestamp(),
  archived_until timestamptz not null default statement_timestamp() + interval '10 years',
  evidence jsonb not null default '{}'::jsonb check (pg_column_size(evidence) <= 16384),
  constraint commercial_acceptances_checkout_attachment_check check (
    (checkout_session_id is null and checkout_created_at is null)
    or (checkout_session_id is not null and checkout_created_at is not null)
  )
);

comment on table public.commercial_acceptances is
  'Immutable evidence of the pre-contract information and explicit acknowledgements presented before Stripe Checkout.';

create index commercial_acceptances_user_date_idx
  on public.commercial_acceptances (user_id, accepted_at desc)
  where user_id is not null;

create index commercial_acceptances_archive_idx
  on public.commercial_acceptances (archived_until);

alter table public.commercial_acceptances enable row level security;
revoke all on table public.commercial_acceptances from public, anon, authenticated;
grant select, insert, update on table public.commercial_acceptances to service_role;

create or replace function app_private.protect_commercial_acceptance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.archived_until := pg_catalog.timezone(
      'UTC',
      pg_catalog.timezone('UTC', new.accepted_at) + interval '10 years'
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- DELETE is not granted to application roles. The trigger adds the temporal
    -- invariant so even an authorised retention worker cannot purge evidence early.
    if old.archived_until <= statement_timestamp() then
      return old;
    end if;
    raise exception using errcode = '55000', message = 'Commercial acceptance evidence is immutable until its retention period expires.';
  end if;

  if old.checkout_session_id is null
    and new.checkout_session_id is not null
    and new.checkout_created_at is not null
    and new.id = old.id
    and new.user_id is not distinct from old.user_id
    and new.purpose = old.purpose
    and new.terms_version = old.terms_version
    and new.terms_sha256 = old.terms_sha256
    and new.privacy_version = old.privacy_version
    and new.privacy_sha256 = old.privacy_sha256
    and new.offer_code = old.offer_code
    and new.amount_cents = old.amount_cents
    and new.currency = old.currency
    and new.terms_accepted = old.terms_accepted
    and new.payment_obligation_acknowledged = old.payment_obligation_acknowledged
    and new.immediate_performance_requested = old.immediate_performance_requested
    and new.withdrawal_information_acknowledged = old.withdrawal_information_acknowledged
    and new.requester_email_hash is not distinct from old.requester_email_hash
    and new.request_id is not distinct from old.request_id
    and new.user_agent_hash is not distinct from old.user_agent_hash
    and new.accepted_at = old.accepted_at
    and new.archived_until = old.archived_until
    and new.evidence = old.evidence then
    return new;
  end if;

  raise exception using errcode = '55000', message = 'Commercial acceptance evidence is immutable.';
end;
$$;

revoke all on function app_private.protect_commercial_acceptance()
  from public, anon, authenticated;

create trigger protect_commercial_acceptance
before insert or update or delete on public.commercial_acceptances
for each row execute function app_private.protect_commercial_acceptance();

create or replace function app_private.set_phase_6_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

revoke all on function app_private.set_phase_6_updated_at()
  from public, anon, authenticated;

create table public.commercial_confirmation_deliveries (
  id uuid primary key default gen_random_uuid(),
  acceptance_id uuid not null unique references public.commercial_acceptances(id) on delete cascade,
  checkout_session_id text not null unique,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  recipient_hash text check (recipient_hash is null or recipient_hash ~ '^[0-9a-f]{64}$'),
  provider_message_id text,
  error_message text check (error_message is null or length(error_message) <= 2000),
  paid_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

alter table public.commercial_confirmation_deliveries enable row level security;
revoke all on table public.commercial_confirmation_deliveries from public, anon, authenticated;
grant select, insert, update on table public.commercial_confirmation_deliveries to service_role;

create trigger commercial_confirmation_deliveries_updated_at
before update on public.commercial_confirmation_deliveries
for each row execute function app_private.set_phase_6_updated_at();

create table public.data_subject_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  requester_email text not null check (length(requester_email) between 3 and 320),
  request_type text not null check (
    request_type in (
      'access',
      'portability',
      'rectification',
      'erasure',
      'restriction',
      'objection',
      'consent_withdrawal',
      'contract_withdrawal'
    )
  ),
  message text check (message is null or length(message) <= 4000),
  status text not null default 'received' check (
    status in ('received', 'identity_verification', 'in_review', 'completed', 'rejected')
  ),
  identity_status text not null default 'authenticated' check (
    identity_status in ('authenticated', 'additional_verification_required', 'verified')
  ),
  submitted_at timestamptz not null default statement_timestamp(),
  due_at timestamptz not null default statement_timestamp() + interval '1 month',
  acknowledged_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  resolution_code text,
  operator_notes text check (operator_notes is null or length(operator_notes) <= 8000),
  metadata jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 16384),
  updated_at timestamptz not null default statement_timestamp(),
  constraint data_subject_requests_completion_check check (
    (
      status in ('completed', 'rejected')
      and completed_at is not null
      and nullif(pg_catalog.btrim(resolution_code), '') is not null
    )
    or (status not in ('completed', 'rejected') and completed_at is null)
  )
);

comment on table public.data_subject_requests is
  'Authenticated privacy and distance-contract requests with a one-month response deadline.';

create index data_subject_requests_user_date_idx
  on public.data_subject_requests (user_id, submitted_at desc)
  where user_id is not null;

create index data_subject_requests_open_due_idx
  on public.data_subject_requests (due_at)
  where status not in ('completed', 'rejected');

alter table public.data_subject_requests enable row level security;
revoke all on table public.data_subject_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.data_subject_requests to service_role;

create trigger data_subject_requests_updated_at
before update on public.data_subject_requests
for each row execute function app_private.set_phase_6_updated_at();

-- Extend the already scheduled retention job with the two Phase 6 evidence stores.
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
  deleted_commercial_acceptances bigint := 0;
  deleted_data_subject_requests bigint := 0;
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
    'data_subject_requests', deleted_data_subject_requests
  );
end;
$$;

revoke all on function app_private.purge_expired_operational_data(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_expired_operational_data(timestamptz)
  to service_role;

notify pgrst, 'reload schema';

commit;
