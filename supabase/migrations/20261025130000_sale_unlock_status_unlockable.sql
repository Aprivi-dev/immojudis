-- "3 déblocages par mois": tell the client whether a sale can be unlocked at all.
--
-- app_private.sale_is_unlockable (20261023100000) requires the sale to be online AND ready for
-- Analyse (public.catalogue_readiness_allows_premium), while the free sheet only requires the sale
-- to be online.  A sale that is online but not yet ready showed an "Unlock" button, and the click
-- ended on a "Vente introuvable" refusal (P0002).  get_sale_unlock_status now carries an
-- `unlockable` flag so the sheet can hide the button instead.
--
-- Compatible by construction:
--   * same signature public.get_sale_unlock_status(uuid), same grants, same security invoker;
--     only one key is added to the JSON answer (clients that do not know it ignore it, and the
--     application reads a missing key as "unlockable", the behaviour before this migration);
--   * the check goes through a new SECURITY DEFINER helper, because app_private.sale_is_unlockable
--     is granted to service_role only and get_sale_unlock_status runs as the caller.  The helper
--     only answers a boolean for a signed-in account and reads nothing else.
begin;

set local lock_timeout = '5s';

-- True when the signed-in account could unlock this sale right now (same rule as unlock_sale):
-- the sale is online and, when the operator enforces catalogue readiness, ready for Analyse.
create or replace function app_private.current_user_can_unlock_sale(p_sale_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select auth.uid()) is not null
    and p_sale_id is not null
    and app_private.sale_is_unlockable(p_sale_id),
    false
  );
$$;

revoke all on function app_private.current_user_can_unlock_sale(uuid)
  from public, anon, authenticated;
grant execute on function app_private.current_user_can_unlock_sale(uuid)
  to authenticated, service_role;

comment on function app_private.current_user_can_unlock_sale(uuid) is
  'True when a signed-in account could unlock this sale now (online and ready for Analyse, like unlock_sale). Boolean only; used by get_sale_unlock_status.';

-- Same body as 20261023100000_discovery_sale_unlocks.sql plus `unlockable`.  A later migration that
-- redefines this function must keep every key.  Without a sale, `unlockable` is true: there is
-- nothing to refuse.
create or replace function public.get_sale_unlock_status(p_sale_id uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_limit integer := app_private.monthly_sale_unlock_limit();
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_used integer;
  v_analysis boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Connexion requise.';
  end if;

  select period.period_start, period.period_end
    into v_period_start, v_period_end
  from app_private.sale_unlock_period(pg_catalog.now()) period;

  v_analysis := app_private.current_user_has_premium_access();
  v_used := app_private.sale_unlocks_used(v_user_id, pg_catalog.now());

  return pg_catalog.jsonb_build_object(
    'sale_id', p_sale_id,
    'unlocked', p_sale_id is not null and app_private.current_user_unlocked_sale(p_sale_id),
    'unlockable', p_sale_id is null or app_private.current_user_can_unlock_sale(p_sale_id),
    'analysis_access', v_analysis,
    'limit', case when v_analysis then null else v_limit end,
    'used', case when v_analysis then 0 else v_used end,
    'remaining', case when v_analysis then null else greatest(v_limit - v_used, 0) end,
    'period_start', v_period_start,
    'period_end', v_period_end
  );
end;
$$;

revoke all on function public.get_sale_unlock_status(uuid) from public, anon;
grant execute on function public.get_sale_unlock_status(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
