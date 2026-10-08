begin;

-- The active Analyse offer is a recurring Stripe Price with a seven-day trial.
-- Keep historical one-time evidence valid while allowing the approved price to
-- remain a deployment configuration until the commercial decision is final.
alter table public.commercial_acceptances
  alter column amount_cents drop not null,
  drop constraint if exists commercial_acceptances_offer_code_check,
  drop constraint if exists commercial_acceptances_amount_cents_check,
  add constraint commercial_acceptances_offer_code_check check (
    offer_code in ('analyse_30_days', 'analyse_subscription_trial_7_days', 'analyse_subscription_recurring')
  ),
  add constraint commercial_acceptances_amount_cents_check check (
    amount_cents is null or amount_cents > 0
  );

-- A subscription entitlement and a manually granted premium/admin profile are
-- equivalent for quota enforcement. This helper is called by security
-- definer triggers, so it reads the profile without relying on caller RLS.
create or replace function app_private.has_active_analysis_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
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
      and subscription.status in ('trialing', 'active')
      and (
        subscription.current_period_end is null
        or subscription.current_period_end > statement_timestamp()
      )
  );
$$;

revoke all on function app_private.has_active_analysis_access(uuid) from public, anon, authenticated;
grant execute on function app_private.has_active_analysis_access(uuid) to service_role;

create or replace function app_private.enforce_favorite_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and auth.uid() is distinct from new.user_id then
    raise exception using errcode = '42501', message = 'Favorite owner mismatch.';
  end if;
  if new.user_id is null then
    raise exception using errcode = '23514', message = 'Favorite owner is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_favorites:' || new.user_id::text, 0)
  );
  -- Existing duplicates must reach the unique constraint, allowing idempotent API retries.
  if exists (
    select 1 from public.user_favorites
    where user_id = new.user_id and sale_id = new.sale_id
  ) then return new; end if;
  if not app_private.has_active_analysis_access(new.user_id)
    and (select count(*) from public.user_favorites where user_id = new.user_id) >= 3 then
    raise exception using errcode = 'P0001', message = 'Quota de 3 favoris gratuits atteint. Retirez un favori pour en ajouter un autre.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_favorite_quota() from public, anon, authenticated;
drop trigger if exists enforce_favorite_quota on public.user_favorites;
create trigger enforce_favorite_quota
before insert on public.user_favorites
for each row execute function app_private.enforce_favorite_quota();

-- Allow the nullable amount in new subscription evidence to pass the same
-- immutable attach-only update path used by the historical one-time offer.
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
    and new.amount_cents is not distinct from old.amount_cents
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

revoke all on function app_private.protect_commercial_acceptance() from public, anon, authenticated;

-- Serialize checkout creation per account. Stripe itself does not make two
-- simultaneously-created Checkout Sessions share a trial, so the reservation
-- closes that race before a Session is created. A cancelled browser session
-- expires through the webhook; an abandoned one is retryable after 30 minutes.
create or replace function public.reserve_analyse_checkout(
  p_user_id uuid,
  p_checkout_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.user_subscriptions%rowtype;
  reserved_at timestamptz;
  affected_rows integer;
begin
  if p_user_id is null or p_checkout_token is null or length(p_checkout_token) < 16 then
    raise exception using errcode = '22023', message = 'Invalid checkout reservation.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('analyse-checkout:' || p_user_id::text, 0)
  );

  select * into current_row
  from public.user_subscriptions
  where user_id = p_user_id
  for update;

  if current_row.user_id is not null
    and current_row.plan_code = 'analyse'
    and (
      current_row.status in ('past_due', 'paused')
      or (
        current_row.status in ('trialing', 'active')
        and (
          current_row.current_period_end is null
          or current_row.current_period_end > statement_timestamp()
        )
      )
    ) then
    return false;
  end if;

  if current_row.user_id is not null
    and (current_row.metadata->>'analyse_checkout_reservation_token') = p_checkout_token then
    return true;
  end if;

  if current_row.user_id is not null
    and current_row.metadata->>'analyse_checkout_reserved_at' is not null then
    begin
      reserved_at := (current_row.metadata->>'analyse_checkout_reserved_at')::timestamptz;
    exception when others then
      reserved_at := null;
    end;
    if reserved_at is not null and reserved_at > statement_timestamp() - interval '31 minutes' then
      return false;
    end if;
  end if;

  if current_row.user_id is null then
    insert into public.user_subscriptions (user_id, plan_code, status, metadata)
    values (
      p_user_id,
      'decouverte',
      'active',
      jsonb_build_object(
        'analyse_checkout_reservation_token', p_checkout_token,
        'analyse_checkout_reserved_at', statement_timestamp()
      )
    );
  else
    update public.user_subscriptions
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'analyse_checkout_reservation_token', p_checkout_token,
      'analyse_checkout_reserved_at', statement_timestamp()
    )
    where user_id = p_user_id;
  end if;
  return true;
end;
$$;

revoke all on function public.reserve_analyse_checkout(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_analyse_checkout(uuid, text) to service_role;

create or replace function public.release_analyse_checkout(
  p_user_id uuid,
  p_checkout_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  released boolean := false;
  affected_rows integer;
begin
  update public.user_subscriptions
  set metadata = coalesce(metadata, '{}'::jsonb)
    - 'analyse_checkout_reservation_token'
    - 'analyse_checkout_reserved_at'
  where user_id = p_user_id
    and metadata->>'analyse_checkout_reservation_token' = p_checkout_token;
  get diagnostics affected_rows = row_count;
  released := affected_rows > 0;
  return released;
end;
$$;

revoke all on function public.release_analyse_checkout(uuid, text) from public, anon, authenticated;
grant execute on function public.release_analyse_checkout(uuid, text) to service_role;

commit;
