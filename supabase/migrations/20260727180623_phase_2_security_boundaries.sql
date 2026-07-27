begin;

-- Bound on-demand refresh admission in the same transaction as deduplication
-- and insertion. Limits are intentionally server-owned and cannot be supplied
-- by the request body.
revoke insert on table public.data_refresh_requests from authenticated;

create or replace function public.enqueue_data_refresh_bounded(
  p_user_id uuid,
  p_sale_id uuid,
  p_request_kind text,
  p_force boolean default false
)
returns table (request_id uuid, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_value text;
  existing_id uuid;
  created_id uuid;
  user_active_count integer;
  user_daily_count integer;
  global_active_count integer;
  user_active_limit constant integer := 3;
  user_daily_limit constant integer := 6;
  global_active_limit constant integer := 12;
begin
  if p_user_id is null or p_sale_id is null then
    raise exception using errcode = '22023', message = 'Refresh user and sale are required.';
  end if;
  if p_request_kind not in ('cadastre', 'dpe', 'full') then
    raise exception using errcode = '22023', message = 'Invalid refresh kind.';
  end if;
  if not app_private.has_active_analysis_access(p_user_id) then
    raise exception using errcode = '42501', message = 'Analyse access is required.';
  end if;

  select sale.source_url
  into source_value
  from public.auction_sales sale
  where sale.id = p_sale_id;
  if source_value is null then
    raise exception using errcode = 'P0002', message = 'Refreshable sale not found.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('data-refresh:global', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('data-refresh:user:' || p_user_id::text, 0)
  );

  select request.id
  into existing_id
  from public.data_refresh_requests request
  where request.user_id = p_user_id
    and request.source_url = source_value
    and request.request_kind = p_request_kind
    and request.status in ('queued', 'running')
  order by request.created_at desc
  limit 1;
  if existing_id is not null then
    return query select existing_id, true;
    return;
  end if;

  select count(*)::integer
  into user_active_count
  from public.data_refresh_requests request
  where request.user_id = p_user_id
    and request.status in ('queued', 'running');
  if user_active_count >= user_active_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_USER_ACTIVE_LIMIT';
  end if;

  select count(*)::integer
  into user_daily_count
  from public.data_refresh_requests request
  where request.user_id = p_user_id
    and request.created_at >= statement_timestamp() - interval '24 hours';
  if user_daily_count >= user_daily_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_USER_DAILY_LIMIT';
  end if;

  select count(*)::integer
  into global_active_count
  from public.data_refresh_requests request
  where request.status in ('queued', 'running');
  if global_active_count >= global_active_limit then
    raise exception using errcode = 'P0001', message = 'DATA_REFRESH_GLOBAL_BACKPRESSURE';
  end if;

  insert into public.data_refresh_requests (
    user_id,
    sale_id,
    source_url,
    request_kind,
    requested_payload,
    priority
  ) values (
    p_user_id,
    p_sale_id,
    source_value,
    p_request_kind,
    pg_catalog.jsonb_build_object('force', coalesce(p_force, false), 'requested_from', 'app'),
    case when p_request_kind = 'full' then 70 else 60 end
  )
  returning id into created_id;

  return query select created_id, false;
end;
$$;

revoke all on function public.enqueue_data_refresh_bounded(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_data_refresh_bounded(uuid, uuid, text, boolean)
  to service_role;

-- Owner revocation is terminal for a collaboration row. A later invitation
-- creates a new row instead of reactivating the revoked identity.
create or replace function app_private.enforce_terminal_collaboration_revocation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception using errcode = '23514', message = 'Revoked collaboration rows cannot be reactivated.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_terminal_collaboration_revocation()
  from public, anon, authenticated;

drop trigger if exists enforce_terminal_collaboration_revocation
on public.sale_workspace_collaborators;
create trigger enforce_terminal_collaboration_revocation
before update of status on public.sale_workspace_collaborators
for each row execute function app_private.enforce_terminal_collaboration_revocation();

-- Durable causal state for one-time Stripe payments. Event-id idempotence is
-- retained separately; this row correlates Checkout, Charge and Dispute events
-- through the PaymentIntent so delivery order cannot resurrect an entitlement.
create table if not exists public.stripe_payment_lifecycle (
  payment_intent_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  checkout_session_id text unique,
  state text not null check (
    state in ('paid', 'disputed', 'dispute_lost', 'cleared', 'refunded')
  ),
  last_event_id text not null,
  last_event_type text not null,
  last_event_created bigint not null check (last_event_created >= 0),
  metadata jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 32768),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_payment_lifecycle_user_updated_idx
  on public.stripe_payment_lifecycle (user_id, updated_at desc);

alter table public.stripe_payment_lifecycle enable row level security;
revoke all on table public.stripe_payment_lifecycle from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_payment_lifecycle to service_role;

drop trigger if exists immojudis_stripe_payment_lifecycle_updated_at
on public.stripe_payment_lifecycle;
create trigger immojudis_stripe_payment_lifecycle_updated_at
before update on public.stripe_payment_lifecycle
for each row execute function app_private.set_user_profiles_updated_at();

create or replace function public.record_stripe_payment_state(
  p_payment_intent_id text,
  p_user_id uuid,
  p_state text,
  p_event_id text,
  p_event_type text,
  p_event_created bigint,
  p_entitlement_status text,
  p_revoke_immediately boolean default false
)
returns table (recorded boolean, entitlement_updated boolean, effective_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  lifecycle public.stripe_payment_lifecycle%rowtype;
  apply_event boolean := false;
  updated_count integer := 0;
begin
  if nullif(pg_catalog.btrim(p_payment_intent_id), '') is null
    or p_user_id is null
    or nullif(pg_catalog.btrim(p_event_id), '') is null then
    raise exception using errcode = '22023', message = 'Stripe payment identity is required.';
  end if;
  if p_state not in ('disputed', 'dispute_lost', 'cleared', 'refunded') then
    raise exception using errcode = '22023', message = 'Invalid Stripe payment state.';
  end if;
  if p_entitlement_status not in ('active', 'paused', 'cancelled', 'expired') then
    raise exception using errcode = '22023', message = 'Invalid entitlement reconciliation state.';
  end if;
  if coalesce(p_event_created, -1) < 0 then
    raise exception using errcode = '22023', message = 'Invalid Stripe event timestamp.';
  end if;

  insert into public.stripe_payment_lifecycle (
    payment_intent_id,
    user_id,
    state,
    last_event_id,
    last_event_type,
    last_event_created,
    metadata
  ) values (
    p_payment_intent_id,
    p_user_id,
    p_state,
    p_event_id,
    p_event_type,
    p_event_created,
    pg_catalog.jsonb_build_object('recorded_at', statement_timestamp())
  )
  on conflict (payment_intent_id) do nothing;

  select payment.*
  into lifecycle
  from public.stripe_payment_lifecycle payment
  where payment.payment_intent_id = p_payment_intent_id
  for update;

  if lifecycle.user_id <> p_user_id then
    raise exception using errcode = '23514', message = 'Stripe payment user mismatch.';
  end if;

  apply_event := lifecycle.state <> 'refunded'
    and (
      p_state = 'refunded'
      or p_event_created > lifecycle.last_event_created
      or (
        p_event_created = lifecycle.last_event_created
        and case p_state
          when 'refunded' then 4
          when 'dispute_lost' then 3
          when 'disputed' then 2
          when 'cleared' then 1
          else 0
        end >= case lifecycle.state
          when 'refunded' then 4
          when 'dispute_lost' then 3
          when 'disputed' then 2
          when 'cleared' then 1
          else 0
        end
      )
    );

  if apply_event then
    update public.stripe_payment_lifecycle payment
    set
      state = p_state,
      last_event_id = p_event_id,
      last_event_type = p_event_type,
      last_event_created = p_event_created,
      metadata = coalesce(payment.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
        'last_reconciled_at', statement_timestamp()
      )
    where payment.payment_intent_id = p_payment_intent_id;

    update public.user_subscriptions subscription
    set
      status = p_entitlement_status,
      current_period_end = case
        when p_revoke_immediately then statement_timestamp()
        else subscription.current_period_end
      end,
      metadata = coalesce(subscription.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
        'last_reconciliation_event_id', p_event_id,
        'last_reconciliation_reason', p_event_type,
        'last_reconciled_at', statement_timestamp(),
        'payment_intent_id', p_payment_intent_id
      )
    where subscription.user_id = p_user_id
      and subscription.plan_code = 'analyse';
    get diagnostics updated_count = row_count;
  end if;

  select payment.state
  into effective_state
  from public.stripe_payment_lifecycle payment
  where payment.payment_intent_id = p_payment_intent_id;
  return query select true, updated_count = 1, effective_state;
end;
$$;

revoke all on function public.record_stripe_payment_state(
  text, uuid, text, text, text, bigint, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.record_stripe_payment_state(
  text, uuid, text, text, text, bigint, text, boolean
) to service_role;

create or replace function public.grant_analysis_access_from_payment(
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_user_id uuid,
  p_stripe_customer_id text,
  p_amount_total integer,
  p_currency text,
  p_paid_at timestamptz,
  p_event_id text,
  p_event_created bigint,
  p_duration_days integer default 30
)
returns table (granted boolean, access_end timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  lifecycle public.stripe_payment_lifecycle%rowtype;
  existing_end timestamptz;
  current_end timestamptz;
  next_start timestamptz;
  next_end timestamptz;
begin
  if nullif(pg_catalog.btrim(p_checkout_session_id), '') is null
    or nullif(pg_catalog.btrim(p_payment_intent_id), '') is null
    or nullif(pg_catalog.btrim(p_event_id), '') is null
    or p_user_id is null then
    raise exception using errcode = '22023', message = 'Checkout, payment, event and user are required.';
  end if;
  if p_duration_days <> 30 then
    raise exception using errcode = '22023', message = 'Analyse access duration must be exactly 30 days.';
  end if;
  if p_amount_total is distinct from 2900 or pg_catalog.lower(coalesce(p_currency, '')) <> 'eur' then
    raise exception using errcode = '22023', message = 'Analyse checkout must be paid at 29 EUR.';
  end if;
  if coalesce(p_event_created, -1) < 0 then
    raise exception using errcode = '22023', message = 'Invalid Stripe event timestamp.';
  end if;

  insert into public.stripe_payment_lifecycle (
    payment_intent_id,
    user_id,
    checkout_session_id,
    state,
    last_event_id,
    last_event_type,
    last_event_created,
    metadata
  ) values (
    p_payment_intent_id,
    p_user_id,
    p_checkout_session_id,
    'paid',
    p_event_id,
    'checkout.session.completed',
    p_event_created,
    pg_catalog.jsonb_build_object('paid_at', coalesce(p_paid_at, statement_timestamp()))
  )
  on conflict (payment_intent_id) do nothing;

  select payment.*
  into lifecycle
  from public.stripe_payment_lifecycle payment
  where payment.payment_intent_id = p_payment_intent_id
  for update;

  if lifecycle.user_id <> p_user_id then
    raise exception using errcode = '23514', message = 'Stripe payment user mismatch.';
  end if;
  if lifecycle.checkout_session_id is not null
    and lifecycle.checkout_session_id <> p_checkout_session_id then
    raise exception using errcode = '23514', message = 'Stripe payment checkout mismatch.';
  end if;

  select access_grant.access_end
  into existing_end
  from public.stripe_checkout_access_grants access_grant
  where access_grant.checkout_session_id = p_checkout_session_id;
  if found then
    return query select false, existing_end;
    return;
  end if;

  if lifecycle.state in ('refunded', 'disputed', 'dispute_lost') then
    select subscription.current_period_end
    into existing_end
    from public.user_subscriptions subscription
    where subscription.user_id = p_user_id;
    return query select false, existing_end;
    return;
  end if;

  update public.stripe_payment_lifecycle payment
  set
    checkout_session_id = coalesce(payment.checkout_session_id, p_checkout_session_id),
    state = case
      when p_event_created > payment.last_event_created then 'paid'
      else payment.state
    end,
    last_event_id = case
      when p_event_created > payment.last_event_created then p_event_id
      else payment.last_event_id
    end,
    last_event_type = case
      when p_event_created > payment.last_event_created then 'checkout.session.completed'
      else payment.last_event_type
    end,
    last_event_created = greatest(payment.last_event_created, p_event_created),
    metadata = coalesce(payment.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'checkout_session_id', p_checkout_session_id,
      'checkout_observed_at', statement_timestamp()
    )
  where payment.payment_intent_id = p_payment_intent_id;

  insert into public.user_subscriptions (user_id, plan_code, status)
  values (p_user_id, 'decouverte', 'active')
  on conflict (user_id) do nothing;

  select case
    when subscription.plan_code = 'analyse'
      and subscription.status in ('trialing', 'active')
      and subscription.current_period_end > coalesce(p_paid_at, statement_timestamp())
      then subscription.current_period_end
    else null
  end
  into current_end
  from public.user_subscriptions subscription
  where subscription.user_id = p_user_id
  for update;

  next_start := greatest(
    coalesce(p_paid_at, statement_timestamp()),
    coalesce(current_end, coalesce(p_paid_at, statement_timestamp()))
  );
  next_end := next_start + pg_catalog.make_interval(days => p_duration_days);

  insert into public.stripe_checkout_access_grants (
    checkout_session_id,
    user_id,
    stripe_customer_id,
    amount_total,
    currency,
    paid_at,
    access_start,
    access_end
  ) values (
    p_checkout_session_id,
    p_user_id,
    p_stripe_customer_id,
    p_amount_total,
    pg_catalog.lower(p_currency),
    coalesce(p_paid_at, statement_timestamp()),
    next_start,
    next_end
  );

  update public.user_subscriptions subscription
  set
    plan_code = 'analyse',
    status = 'active',
    stripe_customer_id = coalesce(p_stripe_customer_id, subscription.stripe_customer_id),
    stripe_subscription_id = null,
    current_period_end = next_end,
    metadata = coalesce(subscription.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'billing_model', 'one_time_30_days',
      'checkout_session_id', p_checkout_session_id,
      'payment_intent_id', p_payment_intent_id,
      'checkout_completed_at', coalesce(p_paid_at, statement_timestamp()),
      'access_duration_days', p_duration_days
    )
  where subscription.user_id = p_user_id;

  return query select true, next_end;
end;
$$;

revoke all on function public.grant_analysis_access_from_payment(
  text, text, uuid, text, integer, text, timestamptz, text, bigint, integer
) from public, anon, authenticated, service_role;
grant execute on function public.grant_analysis_access_from_payment(
  text, text, uuid, text, integer, text, timestamptz, text, bigint, integer
) to service_role;

-- Prevent any stale application instance from bypassing the PaymentIntent
-- lifecycle check through the legacy grant RPC.
revoke all on function public.grant_analysis_access_from_checkout(
  text, uuid, text, integer, text, timestamptz, integer
) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
