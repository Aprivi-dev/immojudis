-- Achat d'une vente à l'unité, 19 € TTC (lot 3, décision du propriétaire du 15/11/2026).
--
-- Un compte gratuit qui a utilisé son déblocage gratuit peut ACHETER le déblocage d'une autre vente :
-- 1 900 centimes, eur, paiement unique par Stripe Checkout. Le déblocage acheté ouvre la même chose qu'un
-- déblocage gratuit (current_user_unlocked_sale, v_auction_sales_unlocked, rapports enregistrés de la porte
-- déblocage), tant que la vente est en ligne, 24 mois au plus.
--
-- CONSERVATION, À VALIDER PAR juridique-rgpd : public.sale_unlock_purchases garde la trace d'un paiement
-- (montant, date, identifiants Stripe). Sa clé user_id est « on delete cascade », comme les autres tables du
-- compte (stripe_payment_lifecycle, stripe_checkout_access_grants sont aussi effacées avec le compte) : la
-- suppression du compte efface cette trace. Une obligation comptable peut imposer de la garder (anonymisée,
-- user_id à null, comme commercial_acceptances). Le choix « suppression ou anonymisation », et la durée de
-- conservation de la table (aucune purge ici, lignes en attente ou expirées comprises), sont à valider par
-- juridique-rgpd ; voir docs/data-retention-matrix.md.
--
-- 1. Table public.sale_unlock_purchases : une ligne par achat (réservation « pending » avant Stripe, puis
--    « paid », « refunded », « disputed », « dispute_lost » ou « expired »). Fermée aux rôles du navigateur
--    (RLS active, aucun droit pour anon ni authenticated, comme toute table créée depuis le 04/11/2026) : le
--    compte lit ses crédits par get_sale_unlock_status, le serveur lit le reste avec le rôle de service.
--    Les écritures passent par les fonctions ci-dessous.
-- 2. public.user_sale_unlocks gagne source ('free', 'purchase', 'credit') et purchase_id. Une seule ligne par
--    (compte, vente), toutes sources confondues (contrainte existante) : une vente déjà débloquée, quelle que
--    soit la source, n'est ni rachetée ni rouverte par un crédit.
-- 3. Règles :
--    * Le déblocage acheté n'est accordé que par public.grant_purchased_sale_unlock (webhook Stripe, rôle de
--      service). Au paiement, si la vente n'est plus débloquable ou est déjà débloquée par le compte :
--      pas de déblocage, l'achat devient un CRÉDIT.
--    * CRÉDIT : un achat « paid », non déduit d'un abonnement, payé il y a moins de 24 mois, qu'aucun
--      déblocage « vivant » n'utilise (aucune ligne user_sale_unlocks de cet achat dont la vente n'est pas
--      « withdrawn » ; une ligne détachée d'une vente purgée reste vivante). Règle unique :
--      app_private.sale_unlock_credit_purchases. Vente achetée puis retirée : l'achat redevient un crédit,
--      que public.redeem_sale_unlock_credit utilise pour débloquer une autre vente. Un achat ne porte
--      jamais plus d'un déblocage vivant : le crédit utilisé efface la ligne morte (vente retirée) de l'achat.
--    * 24 MOIS : un déblocage acheté ou par crédit de plus de 24 mois n'ouvre plus la vente (comme un
--      gratuit) et la purge le supprime ; la ligne d'achat reste. Il ne redevient pas un crédit : un crédit
--      exige un paiement de moins de 24 mois, et la ligne de déblocage ne peut pas être plus ancienne que
--      son paiement.
--    * LITIGE : « disputed » suspend l'achat (le déblocage n'ouvre plus, le crédit n'est plus disponible) ;
--      un litige gagné rétablit « paid » ; « refunded » (remboursement total) et « dispute_lost » sont
--      définitifs et suppriment le déblocage de l'achat (ou éteignent son crédit).
--    * DÉDUCTION : les achats « paid » des 30 derniers jours, non déduits, sont déduits du premier mois
--      d'abonnement Analyse, dans la limite de app_private.unit_purchase_deduction_cap_cents() (5 900).
--      Un achat déduit garde son déblocage mais n'est plus un crédit.
--    * Un achat ne consomme jamais le déblocage gratuit : sale_unlocks_used ne compte que source = 'free'.
--      release_sale_unlock refuse une ligne achetée ou par crédit (« not_free »).
-- 4. Prix : une seule source côté base, app_private.sale_unlock_purchase_amount_cents() (1 900) et
--    app_private.sale_unlock_purchase_currency() ('eur'), lues par reserve_sale_unlock_purchase. Un test
--    Vitest les compare à la constante TypeScript de l'offre.
-- 5. public.commercial_acceptances : purpose accepte 'sale_unlock_purchase' et offer_code 'sale_unlock_unit'.
--
-- Les fonctions appelées par le serveur sont dans le schéma public (exécutables par service_role seulement),
-- comme reserve_analyse_checkout et record_stripe_payment_state : app_private n'est pas exposé par l'API.
-- current_user_unlocked_sale garde sa signature et ses droits ; v_auction_sales_unlocked n'est pas
-- redéfinie ; unlock_sale_at n'est pas redéfinie (la colonne source vaut 'free' par défaut, et sa
-- vérification « déjà débloquée » porte sur les lignes de toute source) ; purge_sale_unlocks n'est pas
-- redéfinie (elle ne supprime que des lignes de user_sale_unlocks, jamais un achat).
--
-- Verrous : création d'une table ; ajout de deux colonnes à user_sale_unlocks et remplacement de deux
-- contraintes de commercial_acceptances (verrous brefs, tables petites) ; redéfinition de fonctions.
begin;

set local lock_timeout = '5s';

-- 1. Prix et plafond --------------------------------------------------------------------------------------

create or replace function app_private.sale_unlock_purchase_amount_cents()
returns integer
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select 1900;
$$;

revoke all on function app_private.sale_unlock_purchase_amount_cents()
  from public, anon, authenticated;
grant execute on function app_private.sale_unlock_purchase_amount_cents() to service_role;

comment on function app_private.sale_unlock_purchase_amount_cents() is
  'Price of one sale unlock bought on its own, in cents (TTC). The single database source of the price, read by reserve_sale_unlock_purchase; a Vitest test compares it with the TypeScript constant of the offer.';

create or replace function app_private.sale_unlock_purchase_currency()
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select 'eur'::text;
$$;

revoke all on function app_private.sale_unlock_purchase_currency()
  from public, anon, authenticated;
grant execute on function app_private.sale_unlock_purchase_currency() to service_role;

comment on function app_private.sale_unlock_purchase_currency() is
  'Currency of one sale unlock bought on its own (Stripe lower-case code). Read by reserve_sale_unlock_purchase.';

create or replace function app_private.unit_purchase_deduction_cap_cents()
returns integer
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select 5900;
$$;

revoke all on function app_private.unit_purchase_deduction_cap_cents()
  from public, anon, authenticated;
grant execute on function app_private.unit_purchase_deduction_cap_cents() to service_role;

comment on function app_private.unit_purchase_deduction_cap_cents() is
  'Most that unit purchases can take off the first month of an Analyse subscription, in cents (the monthly price of Analyse). A Vitest test compares it with the TypeScript constant.';

-- 2. Table des achats ---------------------------------------------------------------------------------------

create table if not exists public.sale_unlock_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid references public.auction_sales(id) on delete set null,
  checkout_session_id text unique,
  payment_intent_id text unique,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null,
  state text not null default 'pending' check (
    state in ('pending', 'paid', 'refunded', 'disputed', 'dispute_lost', 'expired')
  ),
  outcome text check (outcome in ('unlocked', 'credit')),
  paid_at timestamptz,
  deducted_checkout_session_id text,
  deduction_reserved_token text,
  deduction_reserved_at timestamptz,
  commercial_acceptance_id uuid,
  last_event_id text,
  last_event_created bigint check (last_event_created is null or last_event_created >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_unlock_purchases_paid_check check (
    state in ('pending', 'expired')
    or (paid_at is not null and payment_intent_id is not null and outcome is not null)
  )
);

comment on table public.sale_unlock_purchases is
  'Sale unlocks bought on its own by a free account (one row per purchase). Written only by the SECURITY DEFINER functions of 20261122100000 (reservation, Stripe webhook, payment states, deduction); closed to the browser roles. A paid purchase that no live unlock uses is a credit (app_private.sale_unlock_credit_purchases). Deleted with the account (retention to be validated by juridique-rgpd).';
comment on column public.sale_unlock_purchases.sale_id is
  'Sale bought at first. Set to null when the sale is deleted: the purchase then becomes a credit if it is paid afterwards.';
comment on column public.sale_unlock_purchases.state is
  'pending (reserved before Stripe Checkout), expired (Checkout expired unpaid), paid, disputed (suspended), dispute_lost and refunded (final: no unlock, no credit).';
comment on column public.sale_unlock_purchases.outcome is
  'What the payment gave: unlocked (the sale bought) or credit (the sale was no longer unlockable or already unlocked).';
comment on column public.sale_unlock_purchases.deduction_reserved_token is
  'Token of the Analyse checkout that reserved this purchase for the deduction (live for 31 minutes, like reserve_analyse_checkout).';
comment on column public.sale_unlock_purchases.deducted_checkout_session_id is
  'Analyse Checkout Session whose first month this purchase was deducted from. A deducted purchase is no longer a credit.';
comment on column public.sale_unlock_purchases.last_event_created is
  'created of the last Stripe event applied by record_sale_unlock_payment_state: an older event is ignored.';

create unique index if not exists sale_unlock_purchases_one_pending_idx
  on public.sale_unlock_purchases (user_id, sale_id)
  where state = 'pending';
create index if not exists sale_unlock_purchases_user_paid_idx
  on public.sale_unlock_purchases (user_id, paid_at)
  where state = 'paid';
create index if not exists sale_unlock_purchases_sale_idx
  on public.sale_unlock_purchases (sale_id);
create index if not exists sale_unlock_purchases_deduction_token_idx
  on public.sale_unlock_purchases (deduction_reserved_token)
  where deduction_reserved_token is not null;
create index if not exists sale_unlock_purchases_deducted_session_idx
  on public.sale_unlock_purchases (deducted_checkout_session_id)
  where deducted_checkout_session_id is not null;

alter table public.sale_unlock_purchases enable row level security;

revoke all on table public.sale_unlock_purchases from public, anon, authenticated;
grant select, insert, update, delete on table public.sale_unlock_purchases to service_role;

drop trigger if exists sale_unlock_purchases_updated_at on public.sale_unlock_purchases;
create trigger sale_unlock_purchases_updated_at
before update on public.sale_unlock_purchases
for each row execute function app_private.set_phase_6_updated_at();

-- 3. Source des déblocages -----------------------------------------------------------------------------------

alter table public.user_sale_unlocks
  add column if not exists source text not null default 'free',
  add column if not exists purchase_id uuid
    references public.sale_unlock_purchases(id) on delete set null;

alter table public.user_sale_unlocks
  drop constraint if exists user_sale_unlocks_source_check,
  add constraint user_sale_unlocks_source_check check (source in ('free', 'purchase', 'credit')),
  drop constraint if exists user_sale_unlocks_free_without_purchase_check,
  add constraint user_sale_unlocks_free_without_purchase_check check (
    source <> 'free' or purchase_id is null
  );

create index if not exists user_sale_unlocks_purchase_idx
  on public.user_sale_unlocks (purchase_id)
  where purchase_id is not null;

comment on table public.user_sale_unlocks is
  'Sales unlocked by a Découverte account: the free unlock (one in all), a bought unlock or a credit (20261122100000). A row opens its sale for 24 months at most while the sale is online. Written only by unlock_sale (free), grant_purchased_sale_unlock (purchase) and redeem_sale_unlock_credit (credit); the free counter is app_private.sale_unlocks_used.';
comment on column public.user_sale_unlocks.source is
  'free (the free unlock of the account, counted by sale_unlocks_used), purchase (bought for this sale) or credit (opened with the credit of an earlier purchase).';
comment on column public.user_sale_unlocks.purchase_id is
  'Purchase that paid for this unlock (null for a free unlock). A purchase that is not paid (disputed) closes the sale; a refunded or lost one deletes the row.';

-- Free unlocks only: a bought unlock or a credit never uses the free unlock of the account.  Same
-- signature and security invoker as in 20261120100000, one predicate more.
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
    and unlock_row.source = 'free'
    and unlock_row.unlocked_at > p_now - interval '24 months'
    and (unlock_row.sale_id is null or not app_private.sale_is_withdrawn(unlock_row.sale_id));
$$;

revoke all on function app_private.sale_unlocks_used(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.sale_unlocks_used(uuid, timestamptz)
  to authenticated, service_role;

comment on function app_private.sale_unlocks_used(uuid, timestamptz) is
  'Free unlocks that count for the account at p_now: source free, younger than 24 months and not on a withdrawn sale (a row detached from its purged sale still counts). Bought unlocks and credits never count.';

-- Same body as 20261025130100, plus: a bought or credit unlock opens the sale only while its purchase is
-- paid (a disputed purchase closes it).  Same signature and grants.
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
        and (
          unlock_row.source = 'free'
          or exists (
            select 1
            from public.sale_unlock_purchases purchase
            where purchase.id = unlock_row.purchase_id
              and purchase.state = 'paid'
          )
        )
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
  'True when the signed-in account unlocked this sale (free unlock, bought unlock or credit; a bought or credit unlock only while its purchase is paid), less than 24 months ago, and the sale is still online. Used by get_sale_unlock_status, v_auction_sales_unlocked and the restrictive policy analysis_access_required of saved_property_reports.';

-- 4. Crédits ---------------------------------------------------------------------------------------------------

-- The single rule of a credit.  Callers: sale_unlock_credits_available (count) and
-- redeem_sale_unlock_credit (oldest first).
create or replace function app_private.sale_unlock_credit_purchases(p_user_id uuid)
returns table (purchase_id uuid, paid_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select purchase.id, purchase.paid_at
  from public.sale_unlock_purchases purchase
  where purchase.user_id = p_user_id
    and purchase.state = 'paid'
    and purchase.deducted_checkout_session_id is null
    and purchase.paid_at > pg_catalog.now() - interval '24 months'
    and not exists (
      select 1
      from public.user_sale_unlocks unlock_row
      where unlock_row.purchase_id = purchase.id
        and (unlock_row.sale_id is null or not app_private.sale_is_withdrawn(unlock_row.sale_id))
    );
$$;

revoke all on function app_private.sale_unlock_credit_purchases(uuid)
  from public, anon, authenticated;
grant execute on function app_private.sale_unlock_credit_purchases(uuid) to service_role;

comment on function app_private.sale_unlock_credit_purchases(uuid) is
  'Purchases of the account that are credits: paid, not deducted from a subscription, paid less than 24 months ago, and used by no live unlock (no unlock row of the purchase whose sale is not withdrawn).';

create or replace function app_private.sale_unlock_credits_available(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from app_private.sale_unlock_credit_purchases(p_user_id);
$$;

revoke all on function app_private.sale_unlock_credits_available(uuid)
  from public, anon, authenticated;
grant execute on function app_private.sale_unlock_credits_available(uuid) to service_role;

comment on function app_private.sale_unlock_credits_available(uuid) is
  'Number of credits of the account (app_private.sale_unlock_credit_purchases), whatever its access.';

-- For get_sale_unlock_status, which runs as the caller: the credits of the signed-in account only.
create or replace function app_private.current_user_sale_unlock_credits()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null then 0
    else app_private.sale_unlock_credits_available((select auth.uid()))
  end;
$$;

revoke all on function app_private.current_user_sale_unlock_credits()
  from public, anon, authenticated;
grant execute on function app_private.current_user_sale_unlock_credits()
  to authenticated, service_role;

comment on function app_private.current_user_sale_unlock_credits() is
  'Credits of the signed-in account (0 without a session). Number only; used by get_sale_unlock_status.';

-- Same body as 20261120100000, plus `credits` (0 for an Analyse account) and `source` (source of the
-- unlock that opens p_sale_id, null otherwise).  Every key is kept, period_start / period_end included.
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
  v_unlocked boolean;
  v_source text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Connexion requise.';
  end if;

  select period.period_start, period.period_end
    into v_period_start, v_period_end
  from app_private.sale_unlock_period(pg_catalog.now()) period;

  v_analysis := app_private.current_user_has_premium_access();
  v_used := app_private.sale_unlocks_used(v_user_id, pg_catalog.now());
  v_unlocked := p_sale_id is not null and app_private.current_user_unlocked_sale(p_sale_id);

  if v_unlocked then
    select unlock_row.source
      into v_source
    from public.user_sale_unlocks unlock_row
    where unlock_row.user_id = v_user_id
      and unlock_row.sale_id = p_sale_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'sale_id', p_sale_id,
    'unlocked', v_unlocked,
    'unlockable', p_sale_id is null or app_private.current_user_can_unlock_sale(p_sale_id),
    'analysis_access', v_analysis,
    'limit', case when v_analysis then null else v_limit end,
    'used', case when v_analysis then 0 else v_used end,
    'remaining', case when v_analysis then null else greatest(v_limit - v_used, 0) end,
    'credits', case when v_analysis then 0 else app_private.current_user_sale_unlock_credits() end,
    'source', v_source,
    'period_start', v_period_start,
    'period_end', v_period_end
  );
end;
$$;

revoke all on function public.get_sale_unlock_status(uuid) from public, anon;
grant execute on function public.get_sale_unlock_status(uuid) to authenticated, service_role;

-- Opens one sale with a credit, for the signed-in account.  Same lock, same refusals and same answer as
-- unlock_sale, plus `credits` (left after the call); refusal without credit: P0001, detail
-- sale_unlock_no_credit.  A sale already unlocked (any source, less than 24 months) is answered as is and
-- uses no credit.  The oldest credit is used; the dead row of that purchase (withdrawn sale) is deleted,
-- so that a purchase never carries more than one live unlock.
create or replace function public.redeem_sale_unlock_credit(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_now timestamptz := pg_catalog.now();
  v_limit integer := app_private.free_sale_unlock_limit();
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_used integer;
  v_purchase_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Connexion requise.';
  end if;
  if p_sale_id is null then
    raise exception using errcode = 'P0002', message = 'Vente introuvable.';
  end if;

  select period.period_start, period.period_end
    into v_period_start, v_period_end
  from app_private.sale_unlock_period(v_now) period;

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
      'credits', 0,
      'period_start', v_period_start,
      'period_end', v_period_end
    );
  end if;

  if not app_private.sale_is_unlockable(p_sale_id) then
    raise exception using errcode = 'P0002', message = 'Vente introuvable ou plus en ligne.';
  end if;

  -- Same lock as unlock_sale_at: one unlock at a time per account, whatever its source.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_sale_unlocks:' || v_user_id::text, 0)
  );

  v_used := app_private.sale_unlocks_used(v_user_id, v_now);

  if exists (
    select 1
    from public.user_sale_unlocks unlock_row
    where unlock_row.user_id = v_user_id
      and unlock_row.sale_id = p_sale_id
      and unlock_row.unlocked_at > v_now - interval '24 months'
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
      'credits', app_private.sale_unlock_credits_available(v_user_id),
      'period_start', v_period_start,
      'period_end', v_period_end
    );
  end if;

  select available.purchase_id
    into v_purchase_id
  from app_private.sale_unlock_credit_purchases(v_user_id) available
  order by available.paid_at, available.purchase_id
  limit 1;

  if v_purchase_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'Vous n''avez pas de crédit de déblocage disponible.',
      detail = 'sale_unlock_no_credit';
  end if;

  perform 1 from public.sale_unlock_purchases purchase where purchase.id = v_purchase_id for update;

  delete from public.user_sale_unlocks unlock_row
  where unlock_row.purchase_id = v_purchase_id;

  -- An unlock over 24 months old no longer opens the sale (see unlock_sale_at).
  delete from public.user_sale_unlocks unlock_row
  where unlock_row.user_id = v_user_id
    and unlock_row.sale_id = p_sale_id
    and unlock_row.unlocked_at <= v_now - interval '24 months';

  insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source, purchase_id)
  values (v_user_id, p_sale_id, v_now, 'credit', v_purchase_id);

  return pg_catalog.jsonb_build_object(
    'sale_id', p_sale_id,
    'unlocked', true,
    'already_unlocked', false,
    'analysis_access', false,
    'consumed', true,
    'limit', v_limit,
    'used', v_used,
    'remaining', greatest(v_limit - v_used, 0),
    'credits', app_private.sale_unlock_credits_available(v_user_id),
    'period_start', v_period_start,
    'period_end', v_period_end
  );
end;
$$;

revoke all on function public.redeem_sale_unlock_credit(uuid) from public, anon;
grant execute on function public.redeem_sale_unlock_credit(uuid) to authenticated, service_role;

comment on function public.redeem_sale_unlock_credit(uuid) is
  'Opens one online sale with a credit of the signed-in account (a paid unit purchase that no live unlock uses), serialized per account like unlock_sale; refusal without credit: detail sale_unlock_no_credit. SECURITY DEFINER by design (allowlisted in supabase/tests/441_function_privileges.sql): the caller is identified by auth.uid() only.';

-- Gives a free unlock back (body of 20261120100000).  A bought or credit unlock is refused: it is governed
-- by its purchase (refund, credit), never by this function.
--   {"released": true,  "outcome": "released", ...}  the row was deleted, the unlock is available again
--   {"released": false, "outcome": "not_found"}      no such unlock (already released, or wrong id)
--   {"released": false, "outcome": "not_free", ...}  a bought or credit unlock: nothing changed
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

  if v_row.source <> 'free' then
    return pg_catalog.jsonb_build_object(
      'released', false,
      'outcome', 'not_free',
      'source', v_row.source,
      'purchase_id', v_row.purchase_id
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

revoke all on function app_private.release_sale_unlock(uuid)
  from public, anon, authenticated;
grant execute on function app_private.release_sale_unlock(uuid) to service_role;

comment on function app_private.release_sale_unlock(uuid) is
  'Gives back one free sale unlock (terms, article 2: Immojudis withdrew the sale), whatever its date; refuses a bought or credit unlock (outcome not_free). service_role only; see docs/runbooks/restituer-un-deblocage.md.';

-- 5. Réservation et Checkout ----------------------------------------------------------------------------------

-- Creates the pending purchase of (account, sale), or returns the pending one with its Checkout Session.
-- Refusals: P0001 with detail analysis_access, free_unlock_available, credit_available, already_unlocked or
-- sale_not_unlockable (checked in that order).  Amount and currency come from the price functions.
create or replace function public.reserve_sale_unlock_purchase(p_user_id uuid, p_sale_id uuid)
returns table (purchase_id uuid, existing_session_id text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_purchase_id uuid;
  v_session_id text;
begin
  if p_user_id is null or p_sale_id is null then
    raise exception using errcode = '22023', message = 'Invalid sale unlock purchase reservation.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_sale_unlocks:' || p_user_id::text, 0)
  );

  if app_private.has_active_analysis_access(p_user_id) then
    raise exception using
      errcode = 'P0001',
      message = 'Votre compte a déjà accès à toutes les ventes.',
      detail = 'analysis_access';
  end if;
  if app_private.sale_unlocks_used(p_user_id, pg_catalog.now()) < app_private.free_sale_unlock_limit() then
    raise exception using
      errcode = 'P0001',
      message = 'Votre déblocage gratuit est encore disponible.',
      detail = 'free_unlock_available';
  end if;
  if app_private.sale_unlock_credits_available(p_user_id) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'Vous avez un crédit de déblocage à utiliser.',
      detail = 'credit_available';
  end if;
  if exists (
    select 1
    from public.user_sale_unlocks unlock_row
    where unlock_row.user_id = p_user_id
      and unlock_row.sale_id = p_sale_id
      and unlock_row.unlocked_at > pg_catalog.now() - interval '24 months'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Cette vente est déjà débloquée.',
      detail = 'already_unlocked';
  end if;
  if not app_private.sale_is_unlockable(p_sale_id) then
    raise exception using
      errcode = 'P0001',
      message = 'Vente introuvable ou plus en ligne.',
      detail = 'sale_not_unlockable';
  end if;

  select purchase.id, purchase.checkout_session_id
    into v_purchase_id, v_session_id
  from public.sale_unlock_purchases purchase
  where purchase.user_id = p_user_id
    and purchase.sale_id = p_sale_id
    and purchase.state = 'pending';

  if v_purchase_id is null then
    insert into public.sale_unlock_purchases (user_id, sale_id, amount_cents, currency, state)
    values (
      p_user_id,
      p_sale_id,
      app_private.sale_unlock_purchase_amount_cents(),
      app_private.sale_unlock_purchase_currency(),
      'pending'
    )
    returning id into v_purchase_id;
  end if;

  return query select v_purchase_id, v_session_id;
end;
$$;

revoke all on function public.reserve_sale_unlock_purchase(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_sale_unlock_purchase(uuid, uuid) to service_role;

comment on function public.reserve_sale_unlock_purchase(uuid, uuid) is
  'Reserves the purchase of one sale unlock (pending row, price from app_private.sale_unlock_purchase_amount_cents / _currency) or returns the pending one with its Checkout Session. Refuses with detail analysis_access, free_unlock_available, credit_available, already_unlocked or sale_not_unlockable. service_role only.';

-- Attaches the Checkout Session (and the commercial acceptance) to a pending purchase.  True when the
-- purchase now carries this session; false when it is no longer pending or already carries another one
-- (the caller then expires its own session and uses the existing one).
create or replace function public.attach_sale_unlock_checkout(
  p_purchase_id uuid,
  p_checkout_session_id text,
  p_commercial_acceptance_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_purchase_id is null or nullif(pg_catalog.btrim(p_checkout_session_id), '') is null then
    raise exception using errcode = '22023', message = 'Invalid sale unlock checkout attachment.';
  end if;

  update public.sale_unlock_purchases purchase
  set checkout_session_id = p_checkout_session_id,
      commercial_acceptance_id = coalesce(p_commercial_acceptance_id, purchase.commercial_acceptance_id)
  where purchase.id = p_purchase_id
    and purchase.state = 'pending'
    and (
      purchase.checkout_session_id is null
      or purchase.checkout_session_id = p_checkout_session_id
    );
  return found;
end;
$$;

revoke all on function public.attach_sale_unlock_checkout(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.attach_sale_unlock_checkout(uuid, text, uuid) to service_role;

comment on function public.attach_sale_unlock_checkout(uuid, text, uuid) is
  'Attaches a Checkout Session (and optionally the commercial acceptance) to a pending unit purchase; false when the purchase is no longer pending or already carries another session. service_role only.';

-- checkout.session.expired: the pending purchase of that session is closed, so that the account can
-- reserve again.  True when a pending purchase was expired.
create or replace function public.expire_sale_unlock_purchase(p_checkout_session_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(pg_catalog.btrim(p_checkout_session_id), '') is null then
    raise exception using errcode = '22023', message = 'Invalid Checkout Session.';
  end if;

  update public.sale_unlock_purchases purchase
  set state = 'expired'
  where purchase.checkout_session_id = p_checkout_session_id
    and purchase.state = 'pending';
  return found;
end;
$$;

revoke all on function public.expire_sale_unlock_purchase(text)
  from public, anon, authenticated;
grant execute on function public.expire_sale_unlock_purchase(text) to service_role;

comment on function public.expire_sale_unlock_purchase(text) is
  'Marks the pending unit purchase of an expired Checkout Session as expired (a payment that still arrives is granted). service_role only.';

-- 6. Paiement ----------------------------------------------------------------------------------------------

-- checkout.session.completed.  Idempotent: the same session or payment intent replayed writes nothing more
-- and answers the same (granted = the purchase is paid, outcome = what it gave).  Refuses (23514, detail
-- sale_unlock_purchase_mismatch) a purchase of another account, another sale, another session, an amount
-- or a currency different from the reservation, or a session / payment intent already recorded for
-- another purchase.  A purchase whose sale was deleted (sale_id null) becomes a credit.
create or replace function public.grant_purchased_sale_unlock(
  p_purchase_id uuid,
  p_user_id uuid,
  p_sale_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_currency text,
  p_event_id text,
  p_paid_at timestamptz
)
returns table (granted boolean, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_owner uuid;
  v_purchase public.sale_unlock_purchases%rowtype;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_outcome text;
begin
  if p_purchase_id is null
    or p_user_id is null
    or nullif(pg_catalog.btrim(p_checkout_session_id), '') is null
    or nullif(pg_catalog.btrim(p_payment_intent_id), '') is null
    or p_amount_cents is null
    or nullif(pg_catalog.btrim(p_currency), '') is null
    or nullif(pg_catalog.btrim(p_event_id), '') is null
    or p_paid_at is null then
    raise exception using errcode = '22023', message = 'Invalid sale unlock payment.';
  end if;

  select purchase.user_id into v_owner
  from public.sale_unlock_purchases purchase
  where purchase.id = p_purchase_id;
  if v_owner is null then
    raise exception using errcode = 'P0002', message = 'Sale unlock purchase not found.';
  end if;
  if v_owner <> p_user_id then
    raise exception using
      errcode = '23514',
      message = 'Sale unlock purchase user mismatch.',
      detail = 'sale_unlock_purchase_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_sale_unlocks:' || p_user_id::text, 0)
  );

  if exists (
    select 1
    from public.sale_unlock_purchases other
    where other.id <> p_purchase_id
      and (
        other.checkout_session_id = p_checkout_session_id
        or other.payment_intent_id = p_payment_intent_id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Stripe payment already recorded for another sale unlock purchase.',
      detail = 'sale_unlock_purchase_mismatch';
  end if;

  select * into v_purchase
  from public.sale_unlock_purchases purchase
  where purchase.id = p_purchase_id
  for update;

  if v_purchase.checkout_session_id is not null
    and v_purchase.checkout_session_id <> p_checkout_session_id then
    raise exception using
      errcode = '23514',
      message = 'Sale unlock purchase session mismatch.',
      detail = 'sale_unlock_purchase_mismatch';
  end if;

  -- Replay of an applied payment: same answer, nothing written.
  if v_purchase.state not in ('pending', 'expired') then
    if v_purchase.payment_intent_id is distinct from p_payment_intent_id then
      raise exception using
        errcode = '23514',
        message = 'Sale unlock purchase payment intent mismatch.',
        detail = 'sale_unlock_purchase_mismatch';
    end if;
    return query select v_purchase.state = 'paid', v_purchase.outcome;
    return;
  end if;

  if v_purchase.amount_cents <> p_amount_cents
    or v_purchase.currency <> pg_catalog.lower(p_currency) then
    raise exception using
      errcode = '23514',
      message = 'Sale unlock purchase amount or currency mismatch.',
      detail = 'sale_unlock_purchase_mismatch';
  end if;
  if v_purchase.sale_id is not null and v_purchase.sale_id is distinct from p_sale_id then
    raise exception using
      errcode = '23514',
      message = 'Sale unlock purchase sale mismatch.',
      detail = 'sale_unlock_purchase_mismatch';
  end if;

  if v_purchase.sale_id is not null
    and app_private.sale_is_unlockable(v_purchase.sale_id)
    and not exists (
      select 1
      from public.user_sale_unlocks unlock_row
      where unlock_row.user_id = p_user_id
        and unlock_row.sale_id = v_purchase.sale_id
        and unlock_row.unlocked_at > v_now - interval '24 months'
    ) then
    -- An unlock over 24 months old no longer opens the sale (see unlock_sale_at).
    delete from public.user_sale_unlocks unlock_row
    where unlock_row.user_id = p_user_id
      and unlock_row.sale_id = v_purchase.sale_id;

    insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source, purchase_id)
    values (p_user_id, v_purchase.sale_id, v_now, 'purchase', p_purchase_id);
    v_outcome := 'unlocked';
  else
    v_outcome := 'credit';
  end if;

  update public.sale_unlock_purchases purchase
  set state = 'paid',
      outcome = v_outcome,
      paid_at = p_paid_at,
      checkout_session_id = p_checkout_session_id,
      payment_intent_id = p_payment_intent_id,
      last_event_id = p_event_id
  where purchase.id = p_purchase_id;

  return query select true, v_outcome;
end;
$$;

revoke all on function public.grant_purchased_sale_unlock(
  uuid, uuid, uuid, text, text, integer, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.grant_purchased_sale_unlock(
  uuid, uuid, uuid, text, text, integer, text, text, timestamptz
) to service_role;

comment on function public.grant_purchased_sale_unlock(uuid, uuid, uuid, text, text, integer, text, text, timestamptz) is
  'Stripe webhook (checkout.session.completed) of a unit purchase: marks it paid and writes the bought unlock (outcome unlocked), or leaves a credit when the sale is no longer unlockable or already unlocked (outcome credit). Idempotent per session and payment intent. The only way to grant a bought unlock; service_role only.';

-- Refund, dispute and dispute closure of a paid purchase, keyed by its payment intent.
--   refunded, dispute_lost : final; the unlock of the purchase is deleted (or its credit is gone);
--   disputed               : suspended; the unlock no longer opens the sale (current_user_unlocked_sale);
--   paid                   : dispute won; the purchase is paid again.
-- An event older than the last applied one is ignored (same ordering as record_stripe_payment_state; a
-- refund always applies).  True when the state was applied; false for an unknown payment intent, a
-- final purchase or an older event.
create or replace function public.record_sale_unlock_payment_state(
  p_payment_intent_id text,
  p_state text,
  p_event_id text,
  p_event_created bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_purchase public.sale_unlock_purchases%rowtype;
  v_rank_new integer;
  v_rank_current integer;
begin
  if nullif(pg_catalog.btrim(p_payment_intent_id), '') is null
    or nullif(pg_catalog.btrim(p_event_id), '') is null then
    raise exception using errcode = '22023', message = 'Stripe payment identity is required.';
  end if;
  if p_state is null or p_state not in ('paid', 'disputed', 'dispute_lost', 'refunded') then
    raise exception using errcode = '22023', message = 'Invalid sale unlock payment state.';
  end if;
  if coalesce(p_event_created, -1) < 0 then
    raise exception using errcode = '22023', message = 'Invalid Stripe event timestamp.';
  end if;

  select purchase.user_id into v_owner
  from public.sale_unlock_purchases purchase
  where purchase.payment_intent_id = p_payment_intent_id;
  if v_owner is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_sale_unlocks:' || v_owner::text, 0)
  );

  select * into v_purchase
  from public.sale_unlock_purchases purchase
  where purchase.payment_intent_id = p_payment_intent_id
  for update;

  if v_purchase.state not in ('paid', 'disputed') then
    return false;
  end if;

  v_rank_new := case p_state
    when 'refunded' then 4 when 'dispute_lost' then 3 when 'disputed' then 2 else 1 end;
  v_rank_current := case v_purchase.state when 'disputed' then 2 else 1 end;

  if not (
    p_state = 'refunded'
    or v_purchase.last_event_created is null
    or p_event_created > v_purchase.last_event_created
    or (p_event_created = v_purchase.last_event_created and v_rank_new >= v_rank_current)
  ) then
    return false;
  end if;

  update public.sale_unlock_purchases purchase
  set state = p_state,
      last_event_id = p_event_id,
      last_event_created = p_event_created
  where purchase.id = v_purchase.id;

  if p_state in ('refunded', 'dispute_lost') then
    delete from public.user_sale_unlocks unlock_row
    where unlock_row.purchase_id = v_purchase.id;
  end if;

  return true;
end;
$$;

revoke all on function public.record_sale_unlock_payment_state(text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.record_sale_unlock_payment_state(text, text, text, bigint)
  to service_role;

comment on function public.record_sale_unlock_payment_state(text, text, text, bigint) is
  'Refund (refunded), dispute (disputed), lost dispute (dispute_lost) or won dispute (paid) of a unit purchase, by payment intent; refunded and dispute_lost delete its unlock. Ignores an event older than the last applied one. service_role only.';

-- 7. Déduction du premier mois d'abonnement -----------------------------------------------------------------

-- Reserves for the Analyse checkout p_token the paid purchases of the last 30 days that are not deducted
-- and not reserved by another live token (a reservation lives 31 minutes, like reserve_analyse_checkout).
-- Returns what to take off the first month, capped by unit_purchase_deduction_cap_cents().  Calling again
-- with the same token renews the reservation and answers the same sum.
create or replace function public.reserve_unit_purchase_deduction(
  p_user_id uuid,
  p_token text,
  p_now timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  if p_user_id is null or p_token is null or pg_catalog.length(p_token) < 16 or p_now is null then
    raise exception using errcode = '22023', message = 'Invalid unit purchase deduction reservation.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_sale_unlocks:' || p_user_id::text, 0)
  );

  update public.sale_unlock_purchases purchase
  set deduction_reserved_token = p_token,
      deduction_reserved_at = p_now
  where purchase.user_id = p_user_id
    and purchase.state = 'paid'
    and purchase.deducted_checkout_session_id is null
    and purchase.paid_at > p_now - interval '30 days'
    and purchase.paid_at <= p_now
    and (
      purchase.deduction_reserved_token is null
      or purchase.deduction_reserved_token = p_token
      or purchase.deduction_reserved_at <= p_now - interval '31 minutes'
    );

  select coalesce(pg_catalog.sum(purchase.amount_cents), 0)::integer
    into v_total
  from public.sale_unlock_purchases purchase
  where purchase.user_id = p_user_id
    and purchase.deduction_reserved_token = p_token
    and purchase.deducted_checkout_session_id is null
    and purchase.state = 'paid';

  return least(v_total, app_private.unit_purchase_deduction_cap_cents());
end;
$$;

revoke all on function public.reserve_unit_purchase_deduction(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_unit_purchase_deduction(uuid, text, timestamptz)
  to service_role;

comment on function public.reserve_unit_purchase_deduction(uuid, text, timestamptz) is
  'Reserves for an Analyse checkout the paid unit purchases of the last 30 days (not deducted, not reserved by another live token) and returns the amount to deduct from the first month, capped at unit_purchase_deduction_cap_cents(). service_role only.';

-- The Analyse checkout p_token was paid: its reserved purchases are deducted (marked with the session).
-- Returns the amount deducted for that session, capped; replaying answers the same.
create or replace function public.settle_unit_purchase_deduction(
  p_token text,
  p_checkout_session_id text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  if p_token is null
    or pg_catalog.length(p_token) < 16
    or nullif(pg_catalog.btrim(p_checkout_session_id), '') is null then
    raise exception using errcode = '22023', message = 'Invalid unit purchase deduction settlement.';
  end if;

  update public.sale_unlock_purchases purchase
  set deducted_checkout_session_id = p_checkout_session_id
  where purchase.deduction_reserved_token = p_token
    and purchase.deducted_checkout_session_id is null
    and purchase.state = 'paid';

  select coalesce(pg_catalog.sum(purchase.amount_cents), 0)::integer
    into v_total
  from public.sale_unlock_purchases purchase
  where purchase.deducted_checkout_session_id = p_checkout_session_id;

  return least(v_total, app_private.unit_purchase_deduction_cap_cents());
end;
$$;

revoke all on function public.settle_unit_purchase_deduction(text, text)
  from public, anon, authenticated;
grant execute on function public.settle_unit_purchase_deduction(text, text) to service_role;

comment on function public.settle_unit_purchase_deduction(text, text) is
  'Marks the purchases reserved by p_token as deducted from the Analyse Checkout Session p_checkout_session_id and returns the amount deducted for that session (capped). Idempotent. service_role only.';

-- The Analyse checkout p_token was abandoned or failed: its reservation is given back.  Returns the number
-- of purchases released.
create or replace function public.release_unit_purchase_deduction(p_token text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  if p_token is null or pg_catalog.length(p_token) < 16 then
    raise exception using errcode = '22023', message = 'Invalid unit purchase deduction token.';
  end if;

  update public.sale_unlock_purchases purchase
  set deduction_reserved_token = null,
      deduction_reserved_at = null
  where purchase.deduction_reserved_token = p_token
    and purchase.deducted_checkout_session_id is null;
  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

revoke all on function public.release_unit_purchase_deduction(text)
  from public, anon, authenticated;
grant execute on function public.release_unit_purchase_deduction(text) to service_role;

comment on function public.release_unit_purchase_deduction(text) is
  'Gives back the deduction reservation of an abandoned Analyse checkout; returns the number of purchases released. service_role only.';

-- 8. Preuve d'acceptation commerciale -----------------------------------------------------------------------

alter table public.commercial_acceptances
  drop constraint if exists commercial_acceptances_purpose_check,
  add constraint commercial_acceptances_purpose_check check (
    purpose in ('analyse_checkout', 'sale_unlock_purchase')
  ),
  drop constraint if exists commercial_acceptances_offer_code_check,
  add constraint commercial_acceptances_offer_code_check check (
    offer_code in (
      'analyse_30_days',
      'analyse_subscription_trial_7_days',
      'analyse_subscription_recurring',
      'sale_unlock_unit'
    )
  );

notify pgrst, 'reload schema';

commit;
