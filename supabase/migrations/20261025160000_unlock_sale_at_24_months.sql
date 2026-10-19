-- "3 déblocages par mois": unlock_sale_at applies the 24-month limit of the terms too.
--
-- 20261025130100 made app_private.current_user_unlocked_sale (get_sale_unlock_status,
-- v_auction_sales_unlocked) ignore an unlock older than 24 months, but the idempotence check of
-- app_private.unlock_sale_at still saw the expired row: until the nightly purge ran, unlocking the
-- same sale again answered "already_unlocked" and gave nothing back, while the sale was locked.
-- Now:
--   * the idempotence check only counts an unlock younger than 24 months (p_now - 24 months, p_now
--     being now() in the public wrapper);
--   * an expired row of the same account and sale is deleted before the new insert, so the
--     unique (user_id, sale_id) constraint does not refuse the new unlock, which consumes one
--     unlock of the current month like any other.
-- Same signature, security definer, search_path and grants as in 20261023100000.
begin;

set local lock_timeout = '5s';

create or replace function app_private.unlock_sale_at(p_sale_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_limit integer := app_private.monthly_sale_unlock_limit();
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_used integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Connexion requise.';
  end if;
  if p_sale_id is null then
    raise exception using errcode = 'P0002', message = 'Vente introuvable.';
  end if;

  select period.period_start, period.period_end
    into v_period_start, v_period_end
  from app_private.sale_unlock_period(p_now) period;

  -- An Analyse account (or an administrator) already reads every sale: nothing to unlock,
  -- nothing consumed.
  if app_private.current_user_has_premium_access() then
    return pg_catalog.jsonb_build_object(
      'sale_id', p_sale_id,
      'unlocked', true,
      'already_unlocked', false,
      'analysis_access', true,
      'consumed', false,
      'limit', null,
      'used', 0,
      'remaining', null,
      'period_start', v_period_start,
      'period_end', v_period_end
    );
  end if;

  if not app_private.sale_is_unlockable(p_sale_id) then
    raise exception using errcode = 'P0002', message = 'Vente introuvable ou plus en ligne.';
  end if;

  -- One unlock at a time per account, so two simultaneous clicks cannot exceed the quota
  -- (same pattern as app_private.enforce_favorite_quota).
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_sale_unlocks:' || v_user_id::text, 0)
  );

  v_used := app_private.sale_unlocks_used(v_user_id, p_now);

  -- Idempotent: a sale unlocked less than 24 months ago is returned as is and consumes nothing.
  if exists (
    select 1
    from public.user_sale_unlocks unlock_row
    where unlock_row.user_id = v_user_id
      and unlock_row.sale_id = p_sale_id
      and unlock_row.unlocked_at > p_now - interval '24 months'
  ) then
    return pg_catalog.jsonb_build_object(
      'sale_id', p_sale_id,
      'unlocked', true,
      'already_unlocked', true,
      'analysis_access', false,
      'consumed', false,
      'limit', v_limit,
      'used', v_used,
      'remaining', greatest(v_limit - v_used, 0),
      'period_start', v_period_start,
      'period_end', v_period_end
    );
  end if;

  if v_used >= v_limit then
    raise exception using
      errcode = 'P0001',
      message = 'Vous avez utilisé tous vos déblocages de ce mois-ci.',
      detail = 'sale_unlock_quota_reached';
  end if;

  -- An unlock over 24 months old no longer opens the sale: drop it (the nightly purge would) so
  -- that the account can unlock the sale again, as a new unlock of this month.
  delete from public.user_sale_unlocks
  where user_id = v_user_id
    and sale_id = p_sale_id
    and unlocked_at <= p_now - interval '24 months';

  insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at)
  values (v_user_id, p_sale_id, p_now);

  return pg_catalog.jsonb_build_object(
    'sale_id', p_sale_id,
    'unlocked', true,
    'already_unlocked', false,
    'analysis_access', false,
    'consumed', true,
    'limit', v_limit,
    'used', v_used + 1,
    'remaining', v_limit - v_used - 1,
    'period_start', v_period_start,
    'period_end', v_period_end
  );
end;
$$;

revoke all on function app_private.unlock_sale_at(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.unlock_sale_at(uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
