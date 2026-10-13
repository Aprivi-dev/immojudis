begin;

set local lock_timeout = '5s';

-- A late or replayed event of an OLD Stripe subscription (typically the
-- customer.subscription.deleted of a subscription cancelled just before a
-- re-subscription) must not overwrite the row of a NEW subscription that still
-- grants access.  The ordering and refund guards of 20261009181000 only applied
-- to the same stripe_subscription_id, so the old event replaced the whole row,
-- including stripe_subscription_id, and the paying customer lost access.
--
-- New rule: when the event carries another subscription id than the row, and the
-- row holds a subscription that grants access, a status that grants no access is
-- ignored ('superseded_subscription').  A status that grants access from another
-- id still replaces the row: that is the re-subscription.
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
  other_subscription boolean;
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

  other_subscription := current_row.user_id is not null
    and current_row.stripe_subscription_id is not null
    and current_row.stripe_subscription_id is distinct from p_stripe_subscription_id;

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

  if other_subscription
    and p_status not in ('trialing', 'active', 'past_due')
    and app_private.subscription_grants_access(
      current_row.status,
      current_row.current_period_end
    ) then
    return query select false, 'superseded_subscription'::text;
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
