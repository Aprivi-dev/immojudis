-- Offre gratuite : une seule vente débloquée, plus d'essai (décision du propriétaire du 15/11/2026).
--
-- 1. Déblocages du compte Découverte (20261023100000, 20261025130000, 20261025130100, 20261025160000).
--    * UN déblocage en tout au lieu de 3 par mois civil de Paris : plus de remise à zéro mensuelle.
--      app_private.free_sale_unlock_limit() (1) remplace app_private.monthly_sale_unlock_limit() (3),
--      supprimée après la redéfinition de ses deux appelants (unlock_sale_at, get_sale_unlock_status).
--    * Un déblocage reste valable tant que la vente est en ligne, 24 mois au plus (inchangé). Après 24 mois
--      la ligne ne compte plus et la purge la supprime : un déblocage redevient disponible (voulu).
--    * Restitution automatique : une ligne dont la vente a auction_sales.status = 'withdrawn' ne compte plus
--      dans les déblocages utilisés (app_private.sale_is_withdrawn, lue par sale_unlocks_used).
--    * Une ligne détachée de sa vente purgée (sale_id null) compte jusqu'à ses 24 mois : purge_sale_unlocks ne
--      la supprime plus à la fin du mois.
--    * Restitution manuelle par l'opérateur : app_private.release_sale_unlock(uuid), sans la règle « mois en
--      cours » (plus de résultat past_month). La version (uuid, timestamptz) est supprimée.
--    * Compatibilité : unlock_sale_at et get_sale_unlock_status gardent toutes leurs clés JSON, y compris
--      period_start et period_end que l'application déployée avant cette migration exige. Ces deux clés sont
--      héritées et ne décrivent plus le quota ; elles seront retirées par une migration ultérieure, une fois
--      l'application déployée. app_private.sale_unlock_period reste donc en place.
--
-- 2. Fin de l'essai gratuit de 7 jours pour tous les comptes, essais en cours compris, dès l'application
--    de cette migration. Décision du propriétaire du 15/11/2026, prise en connaissance des articles 2, 13
--    et 14 des CGU. Aucune fonction d'accès n'est redéfinie :
--    * l'interrupteur app_private.launch_offer est coupé, puis sa date de coupure (closed_at) est reculée au
--      01/01/2026. Le déclencheur launch_offer_track_closing (20261108130100) n'écrit closed_at que lors du
--      passage d'actif à inactif : le second update garde la date donnée. Effet :
--      app_private.launch_offer_confirmed_before_close est faux pour tous les comptes dont l'essai pourrait
--      courir, plus aucun essai en cours ;
--    * les prolongations d'essai accordées par l'administrateur (lignes user_subscriptions reconnues par
--      app_private.is_admin_trial_extension, donc sans abonnement Stripe) se terminent maintenant.
--
-- ÉCRITURES DE DONNÉES EN PRODUCTION : à l'application de cette migration, deux écritures s'exécutent en
-- production : (a) app_private.launch_offer (une ligne : active = false, closed_at = 2026-01-01) ;
-- (b) public.user_subscriptions : current_period_end = now() pour les prolongations d'essai encore en cours
-- (status 'trialing', metadata.manual_grant.source = 'admin_trial_extension', stripe_subscription_id null).
-- Aucune ligne portant un abonnement Stripe n'est modifiée. Aucune ligne de user_sale_unlocks n'est modifiée.
--
-- Verrous : redéfinition de fonctions, deux updates de quelques lignes.
begin;

set local lock_timeout = '5s';

-- 1. Déblocages ---------------------------------------------------------------------------------------------

create or replace function app_private.free_sale_unlock_limit()
returns integer
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select 1;
$$;

revoke all on function app_private.free_sale_unlock_limit()
  from public, anon, authenticated;
grant execute on function app_private.free_sale_unlock_limit()
  to authenticated, service_role;

comment on function app_private.free_sale_unlock_limit() is
  'Sale unlocks of a Découverte account, in all (no monthly reset); an unlock counts for 24 months at most and no longer counts once its sale is withdrawn. Must equal the free unlock limit of PLAN_LIMITS.decouverte (src/lib/plans.ts); the Vitest suite compares both.';

-- Boolean only: sale_unlocks_used runs as the caller, and a Découverte account cannot read auction_sales.
create or replace function app_private.sale_is_withdrawn(p_sale_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select sale.status = 'withdrawn' from public.auction_sales sale where sale.id = p_sale_id),
    false
  );
$$;

revoke all on function app_private.sale_is_withdrawn(uuid)
  from public, anon, authenticated;
grant execute on function app_private.sale_is_withdrawn(uuid)
  to authenticated, service_role;

comment on function app_private.sale_is_withdrawn(uuid) is
  'True when the sale exists and its status is withdrawn (false otherwise). Boolean only; used by sale_unlocks_used so that the unlock of a withdrawn sale no longer counts.';

-- Unlocks that count for one account at p_now: younger than 24 months, and not on a withdrawn sale (a
-- row detached from its purged sale keeps counting).  Same signature and security invoker as in
-- 20261023100000: an account only sees its own rows through RLS, the definer functions run it as the
-- owner.
create or replace function app_private.sale_unlocks_used(
  p_user_id uuid,
  p_now timestamptz default now()
)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from public.user_sale_unlocks unlock_row
  where unlock_row.user_id = p_user_id
    and unlock_row.unlocked_at > p_now - interval '24 months'
    and (unlock_row.sale_id is null or not app_private.sale_is_withdrawn(unlock_row.sale_id));
$$;

revoke all on function app_private.sale_unlocks_used(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.sale_unlocks_used(uuid, timestamptz)
  to authenticated, service_role;

comment on function app_private.sale_unlocks_used(uuid, timestamptz) is
  'Unlocks that count for the account at p_now: younger than 24 months and not on a withdrawn sale (a row detached from its purged sale still counts). No monthly period.';

-- Same body as 20261025160000_unlock_sale_at_24_months.sql, with free_sale_unlock_limit() and the new
-- refusal message.  The row of a withdrawn sale no longer counts (sale_unlocks_used), so it does not
-- prevent unlocking another sale; unlocking the same sale again stays idempotent.
create or replace function app_private.unlock_sale_at(p_sale_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_limit integer := app_private.free_sale_unlock_limit();
  -- Legacy keys period_start / period_end: the application deployed before 20261120100000 requires
  -- them. They no longer describe the quota; remove them in a later migration once the application
  -- is deployed.
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
      message = 'Vous avez déjà utilisé le déblocage de votre compte gratuit.',
      detail = 'sale_unlock_quota_reached';
  end if;

  -- An unlock over 24 months old no longer opens the sale: drop it (the nightly purge would) so
  -- that the account can unlock the sale again, as a new unlock.
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

comment on function public.unlock_sale(uuid) is
  'Unlocks one online sale for the signed-in Découverte account: one unlock in all (valid while the sale is online, 24 months at most; given back when the sale is withdrawn), idempotent per sale, serialized per account. SECURITY DEFINER by design (allowlisted in supabase/tests/441_function_privileges.sql): the caller is identified by auth.uid() only.';

-- Same body as 20261025130000_sale_unlock_status_unlockable.sql, with free_sale_unlock_limit().  Every
-- key is kept.
create or replace function public.get_sale_unlock_status(p_sale_id uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_limit integer := app_private.free_sale_unlock_limit();
  -- Legacy keys period_start / period_end: the application deployed before 20261120100000 requires
  -- them. They no longer describe the quota; remove them in a later migration once the application
  -- is deployed.
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

drop function if exists app_private.monthly_sale_unlock_limit();

-- Gives an unlock back: deletes the row, so the unlock no longer counts and the sale is locked again for
-- that account.  No month rule any more.  Idempotent and explicit about what it did:
--   {"released": true,  "outcome": "released", ...}  the row was deleted, the unlock is available again
--   {"released": false, "outcome": "not_found"}      no such unlock (already released, or wrong id)
-- p_unlock_id is user_sale_unlocks.id; docs/runbooks/restituer-un-deblocage.md shows how to find it.
drop function if exists app_private.release_sale_unlock(uuid, timestamptz);

create or replace function app_private.release_sale_unlock(p_unlock_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.user_sale_unlocks%rowtype;
begin
  select * into v_row from public.user_sale_unlocks where id = p_unlock_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('released', false, 'outcome', 'not_found');
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

revoke all on function app_private.release_sale_unlock(uuid)
  from public, anon, authenticated;
grant execute on function app_private.release_sale_unlock(uuid) to service_role;

comment on function app_private.release_sale_unlock(uuid) is
  'Gives back one sale unlock (terms, article 2: Immojudis withdrew the sale), whatever its date. service_role only; see docs/runbooks/restituer-un-deblocage.md.';

-- Retention: no unlock outlives 24 months.  A row detached from its purged sale keeps counting until
-- then, so it is no longer removed at the end of its month.  Same signature, grants and result shape
-- as in 20261023100000.
create or replace function app_private.purge_sale_unlocks(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired integer := 0;
begin
  delete from public.user_sale_unlocks
  where unlocked_at < p_now - interval '24 months';
  get diagnostics v_expired = row_count;

  return pg_catalog.jsonb_build_object('user_sale_unlocks', v_expired);
end;
$$;

revoke all on function app_private.purge_sale_unlocks(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_sale_unlocks(timestamptz) to service_role;

comment on table public.user_sale_unlocks is
  'Sales unlocked by a Découverte account (one unlock in all; a row counts for 24 months at most and no longer counts once its sale is withdrawn). Written only by public.unlock_sale; the counter is app_private.sale_unlocks_used.';
comment on column public.user_sale_unlocks.sale_id is
  'Unlocked sale. Set to null when the sale is purged so that the unlock keeps counting until its 24 months; the row is then removed by app_private.purge_sale_unlocks.';

comment on function app_private.current_user_unlocked_sale(uuid) is
  'True when the signed-in account unlocked this sale (one unlock in all for Découverte), less than 24 months ago, and the sale is still online. Used by get_sale_unlock_status and v_auction_sales_unlocked.';

comment on view public.v_auction_sales_unlocked is
  'SECURITY DEFINER by design (security_barrier): the sales the signed-in account unlocked (one unlock in all for Découverte, 24 months at most), as the unlocked page needs them: the redacted discovery columns plus the listing facts read by the bid ceiling and the official documents. auction_sales is not opened to an unlock. Listed as an accepted security_definer_view exception (supabase/tests/442).';

-- 2. Fin de l'essai gratuit pour tous ------------------------------------------------------------------------

-- Coupure (le déclencheur écrit closed_at = now() si l'interrupteur était actif), puis date de coupure
-- reculée : l'interrupteur étant déjà inactif, le déclencheur garde la valeur donnée.
update app_private.launch_offer
set active = false,
    updated_at = statement_timestamp(),
    updated_by = null
where singleton;

update app_private.launch_offer
set closed_at = timestamptz '2026-01-01 00:00:00+00'
where singleton;

comment on column app_private.launch_offer.closed_at is
  'Instant de la dernière coupure de l''essai (null tant qu''il est actif). Les comptes dont l''adresse a été confirmée avant cet instant gardent leurs 7 jours. Une date reculée (antérieure aux confirmations dont l''essai pourrait courir) ferme aussi les essais en cours : c''est l''état posé par 20261120100000 (01/01/2026).';

-- Prolongations d'essai de l'administrateur encore en cours : elles se terminent maintenant.
-- is_admin_trial_extension exige stripe_subscription_id null : aucun abonnement Stripe n'est touché.
update public.user_subscriptions
set current_period_end = pg_catalog.now()
where status = 'trialing'
  and app_private.is_admin_trial_extension(metadata, stripe_subscription_id)
  and current_period_end > pg_catalog.now();

notify pgrst, 'reload schema';

commit;
