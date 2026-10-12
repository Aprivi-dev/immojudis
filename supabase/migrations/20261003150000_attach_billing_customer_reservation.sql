begin;

-- Attach the Stripe Customer created after reserve_analyse_checkout without
-- replacing the reservation metadata. The account advisory lock makes the
-- customer association and reservation check one database transaction.
create or replace function public.attach_analyse_checkout_customer(
  p_user_id uuid,
  p_checkout_token text,
  p_stripe_customer_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.user_subscriptions%rowtype;
  effective_customer_id text;
begin
  if p_user_id is null
    or p_checkout_token is null
    or length(p_checkout_token) < 16
    or nullif(pg_catalog.btrim(p_stripe_customer_id), '') is null then
    raise exception using errcode = '22023', message = 'Invalid Stripe customer attachment.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('analyse-checkout:' || p_user_id::text, 0)
  );

  select *
  into current_row
  from public.user_subscriptions
  where user_id = p_user_id
  for update;

  if current_row.user_id is null then
    raise exception using errcode = 'P0002', message = 'Checkout reservation not found.';
  end if;

  if current_row.metadata->>'analyse_checkout_reservation_token' is distinct from p_checkout_token then
    raise exception using errcode = '40001', message = 'Checkout reservation is no longer owned by this request.';
  end if;

  if current_row.stripe_customer_id is not null then
    return current_row.stripe_customer_id;
  end if;

  update public.user_subscriptions
  set
    stripe_customer_id = p_stripe_customer_id,
    metadata = coalesce(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'stripe_customer_id', p_stripe_customer_id,
      'stripe_customer_created_at', coalesce(
        metadata->>'stripe_customer_created_at',
        pg_catalog.statement_timestamp()::text
      )
    ),
    updated_at = pg_catalog.statement_timestamp()
  where user_id = p_user_id
  returning stripe_customer_id into effective_customer_id;

  return effective_customer_id;
end;
$$;

revoke all on function public.attach_analyse_checkout_customer(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.attach_analyse_checkout_customer(uuid, text, text)
to service_role;

commit;
