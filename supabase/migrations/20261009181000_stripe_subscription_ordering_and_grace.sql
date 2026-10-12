begin;

set local lock_timeout = '5s';

-- 1. Order Stripe subscription events.  A subscription.updated delivered late,
--    or replayed after a refund, must not undo a newer state.
alter table public.user_subscriptions
  add column if not exists stripe_event_created bigint;

comment on column public.user_subscriptions.stripe_event_created is
  'Creation time (Unix seconds) of the newest Stripe subscription event applied to this row.';

-- 2. One definition of "this subscription still grants access", shared by the
--    two access functions.  A failed renewal (past_due) keeps access for seven
--    days after the end of the paid period so the customer can fix the card.
create or replace function app_private.subscription_grants_access(
  p_status text,
  p_period_end timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case
    when p_status in ('trialing', 'active')
      then p_period_end is null or p_period_end > statement_timestamp()
    when p_status = 'past_due'
      then p_period_end is not null
        and p_period_end + interval '7 days' > statement_timestamp()
    else false
  end;
$function$;

revoke all on function app_private.subscription_grants_access(text, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.subscription_grants_access(text, timestamptz)
  to authenticated, service_role;

create or replace function app_private.current_user_has_premium_access()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select
    exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = (select auth.uid())
        and (
          profile.user_role = 'admin'
          or profile.account_tier = 'premium'
        )
    )
    or exists (
      select 1
      from public.user_subscriptions subscription
      where subscription.user_id = (select auth.uid())
        and subscription.plan_code = 'analyse'
        and app_private.subscription_grants_access(
          subscription.status,
          subscription.current_period_end
        )
    );
$function$;

create or replace function app_private.has_active_analysis_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = p_user_id
      and (profile.account_tier = 'premium' or profile.user_role = 'admin')
  )
  or exists (
    select 1
    from public.user_subscriptions subscription
    where subscription.user_id = p_user_id
      and subscription.plan_code = 'analyse'
      and app_private.subscription_grants_access(
        subscription.status,
        subscription.current_period_end
      )
  );
$function$;

-- 3. Apply a subscription snapshot read from Stripe, ordered by event time and
--    never re-activating a subscription whose payment was refunded or lost.
create or replace function public.apply_stripe_subscription_state(
  p_user_id uuid,
  p_plan_code text,
  p_status text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_current_period_end timestamptz,
  p_event_created bigint,
  p_metadata jsonb default '{}'::jsonb
)
returns table(applied boolean, reason text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  current_row public.user_subscriptions%rowtype;
  same_subscription boolean;
begin
  if p_user_id is null
    or p_status not in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')
    or p_plan_code not in ('decouverte', 'analyse')
    or coalesce(p_event_created, -1) < 0 then
    raise exception using errcode = '22023', message = 'Invalid Stripe subscription state.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('analyse-checkout:' || p_user_id::text, 0)
  );

  select * into current_row
  from public.user_subscriptions
  where user_id = p_user_id
  for update;

  same_subscription := current_row.user_id is not null
    and current_row.stripe_subscription_id is not distinct from p_stripe_subscription_id;

  if same_subscription
    and current_row.stripe_event_created is not null
    and p_event_created < current_row.stripe_event_created then
    return query select false, 'stale_event'::text;
    return;
  end if;

  if same_subscription
    and p_status in ('trialing', 'active', 'past_due')
    and exists (
      select 1
      from public.stripe_payment_lifecycle lifecycle
      where lifecycle.user_id = p_user_id
        and lifecycle.state in ('refunded', 'dispute_lost')
        and lifecycle.last_event_created >= coalesce(current_row.stripe_event_created, 0)
    ) then
    return query select false, 'payment_reversed'::text;
    return;
  end if;

  insert into public.user_subscriptions (
    user_id, plan_code, status, stripe_customer_id, stripe_subscription_id,
    current_period_end, metadata, stripe_event_created
  ) values (
    p_user_id, p_plan_code, p_status, p_stripe_customer_id, p_stripe_subscription_id,
    p_current_period_end, coalesce(p_metadata, '{}'::jsonb), p_event_created
  )
  on conflict (user_id) do update set
    plan_code = excluded.plan_code,
    status = excluded.status,
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    current_period_end = excluded.current_period_end,
    metadata = coalesce(public.user_subscriptions.metadata, '{}'::jsonb) || excluded.metadata,
    stripe_event_created = excluded.stripe_event_created;

  return query select true, 'applied'::text;
end;
$function$;

revoke all on function public.apply_stripe_subscription_state(
  uuid, text, text, text, text, timestamptz, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_state(
  uuid, text, text, text, text, timestamptz, bigint, jsonb
) to service_role;

commit;
