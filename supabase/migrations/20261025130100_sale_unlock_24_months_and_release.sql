-- "3 déblocages par mois": the 24-month limit of the terms, and the release of an unlock.
--
-- 1. The terms (conditions générales, article 2) promise that an unlocked sale stays readable "dans
--    la limite de 24 mois après le déblocage".  Until now only the nightly retention
--    (app_private.purge_sale_unlocks) deleted the old rows, so an unlock older than 24 months kept
--    working until the purge ran.  app_private.current_user_unlocked_sale (which feeds
--    get_sale_unlock_status and v_auction_sales_unlocked) now applies the limit itself.
--    Same signature, same grants; one extra predicate.
--
-- 2. The terms promise that an unlock is given back "sur simple demande" when Immojudis itself
--    withdraws the sale (publication error, suspension of a source decided by Immojudis), on the
--    month of the unlock.  app_private.release_sale_unlock is the only way to do it: reserved to
--    service_role (the operator, from the SQL editor or a script), never callable by a browser
--    role.  The procedure is in docs/runbooks/restituer-un-deblocage.md.
begin;

set local lock_timeout = '5s';

create or replace function app_private.current_user_unlocked_sale(p_sale_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select auth.uid()) is not null
    and p_sale_id is not null
    and exists (
      select 1
      from public.user_sale_unlocks unlock_row
      where unlock_row.user_id = (select auth.uid())
        and unlock_row.sale_id = p_sale_id
        and unlock_row.unlocked_at > pg_catalog.now() - interval '24 months'
    )
    and app_private.sale_is_unlockable(p_sale_id),
    false
  );
$$;

revoke all on function app_private.current_user_unlocked_sale(uuid)
  from public, anon, authenticated;
grant execute on function app_private.current_user_unlocked_sale(uuid)
  to authenticated, service_role;

comment on function app_private.current_user_unlocked_sale(uuid) is
  'True when the signed-in account unlocked this sale (3 per Paris month for Découverte), less than 24 months ago, and the sale is still online. Used by get_sale_unlock_status and v_auction_sales_unlocked.';

-- Gives an unlock back: deletes the row, so the unlock no longer counts in its month and the sale is
-- locked again for that account.  Only an unlock of the CURRENT Paris month is given back, as the
-- terms say ("rendu sur le mois du déblocage": a request received after the end of the month gives
-- nothing back, unlocks are not carried over).  Idempotent and explicit about what it did:
--   {"released": true,  "outcome": "released"}       the row was deleted, one unlock is available again
--   {"released": false, "outcome": "not_found"}      no such unlock (already released, or wrong id)
--   {"released": false, "outcome": "past_month"}     the unlock belongs to a past month: nothing changed
-- p_unlock_id is user_sale_unlocks.id; the runbook shows how to find it from the sale and the
-- account.  p_now is a parameter so that tests can move the clock; callers pass now().
create or replace function app_private.release_sale_unlock(
  p_unlock_id uuid,
  p_now timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.user_sale_unlocks%rowtype;
  v_period_start timestamptz;
  v_period_end timestamptz;
begin
  select * into v_row from public.user_sale_unlocks where id = p_unlock_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('released', false, 'outcome', 'not_found');
  end if;

  select period.period_start, period.period_end
    into v_period_start, v_period_end
  from app_private.sale_unlock_period(p_now) period;

  if v_row.unlocked_at < v_period_start or v_row.unlocked_at >= v_period_end then
    return pg_catalog.jsonb_build_object(
      'released', false,
      'outcome', 'past_month',
      'unlocked_at', v_row.unlocked_at
    );
  end if;

  delete from public.user_sale_unlocks where id = p_unlock_id;
  return pg_catalog.jsonb_build_object(
    'released', true,
    'outcome', 'released',
    'unlocked_at', v_row.unlocked_at,
    'sale_id', v_row.sale_id
  );
end;
$$;

revoke all on function app_private.release_sale_unlock(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.release_sale_unlock(uuid, timestamptz) to service_role;

comment on function app_private.release_sale_unlock(uuid, timestamptz) is
  'Gives back one sale unlock of the current Paris month (terms, article 2: Immojudis withdrew the sale). service_role only; see docs/runbooks/restituer-un-deblocage.md.';

notify pgrst, 'reload schema';

commit;
