-- "3 déblocages par mois" for the free Découverte offer.
--
-- A Découverte account can unlock ONE sale at a time, three sales per calendar month in the
-- Europe/Paris time zone.  An unlocked sale gives that account, for that sale only, the rows that
-- Analyse reads through RLS (sale, official documents, risks, score factors), and the server routes
-- extend the matching rights (bid ceiling, document reading, sale history, tribunal statistics of the
-- sale).  It never opens PDF/CSV exports or saved reports, which stay on Analyse.
--
-- Rules fixed by the owner on 2026-10-13:
--   * the quota lives in one place per layer: PLAN_LIMITS.decouverte.monthlyUnlocks in
--     src/lib/plans.ts and app_private.monthly_sale_unlock_limit() here (a Vitest test compares them);
--   * an unlocked sale stays readable while it is online (app_private.auction_sale_is_publicly_visible);
--   * the counter restarts on the 1st at 00:00 Paris time (app_private.sale_unlock_period);
--   * unlocking an already unlocked sale consumes nothing; an Analyse account consumes nothing;
--   * no Stripe call and no email on this path.
--
-- The counter is derived from the rows of the current month: no second data set.  A row whose sale
-- was purged keeps counting for its month (sale_id set null), so deleting a sale never gives the
-- credit back; app_private.purge_sale_unlocks removes it once the month is over.
begin;

set local lock_timeout = '5s';

create or replace function app_private.monthly_sale_unlock_limit()
returns integer
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select 3;
$$;

revoke all on function app_private.monthly_sale_unlock_limit()
  from public, anon, authenticated;
grant execute on function app_private.monthly_sale_unlock_limit()
  to authenticated, service_role;

comment on function app_private.monthly_sale_unlock_limit() is
  'Sale unlocks per calendar month for a Découverte account. Must equal PLAN_LIMITS.decouverte.monthlyUnlocks (src/lib/plans.ts); the Vitest suite compares both.';

create table if not exists public.user_sale_unlocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid references public.auction_sales(id) on delete set null,
  unlocked_at timestamptz not null default now(),
  constraint user_sale_unlocks_user_sale_key unique (user_id, sale_id)
);

comment on table public.user_sale_unlocks is
  'Sales unlocked by a Découverte account (3 per Paris calendar month). Written only by public.unlock_sale; the monthly counter is the number of rows of the month.';
comment on column public.user_sale_unlocks.sale_id is
  'Unlocked sale. Set to null when the sale is purged so that the unlock keeps counting for its month; the row is then removed by app_private.purge_sale_unlocks.';

create index if not exists user_sale_unlocks_user_month_idx
  on public.user_sale_unlocks (user_id, unlocked_at desc);
create index if not exists user_sale_unlocks_sale_idx
  on public.user_sale_unlocks (sale_id);

alter table public.user_sale_unlocks enable row level security;

-- The browser roles can read their own rows and nothing else: no insert, update or delete grant
-- and no write policy, so a client cannot forge an unlock or erase one to get a credit back.
revoke all on table public.user_sale_unlocks from public, anon, authenticated;
grant select on table public.user_sale_unlocks to authenticated;
grant select, insert, update, delete on table public.user_sale_unlocks to service_role;

drop policy if exists user_sale_unlocks_select_own on public.user_sale_unlocks;
create policy user_sale_unlocks_select_own
on public.user_sale_unlocks for select
to authenticated
using (user_id = (select auth.uid()));

-- Calendar month in Europe/Paris that contains p_now: [period_start, period_end).
create or replace function app_private.sale_unlock_period(p_now timestamptz default now())
returns table (period_start timestamptz, period_end timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    pg_catalog.date_trunc('month', p_now at time zone 'Europe/Paris') at time zone 'Europe/Paris',
    (pg_catalog.date_trunc('month', p_now at time zone 'Europe/Paris') + interval '1 month')
      at time zone 'Europe/Paris';
$$;

revoke all on function app_private.sale_unlock_period(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.sale_unlock_period(timestamptz)
  to authenticated, service_role;

-- Unlocks of one account in the Paris month of p_now. Security invoker: an account only sees its
-- own rows through RLS, the definer functions below run it as the owner.
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
  cross join app_private.sale_unlock_period(p_now) period
  where unlock_row.user_id = p_user_id
    and unlock_row.unlocked_at >= period.period_start
    and unlock_row.unlocked_at < period.period_end;
$$;

revoke all on function app_private.sale_unlocks_used(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.sale_unlocks_used(uuid, timestamptz)
  to authenticated, service_role;

-- A sale can be unlocked, and stays readable once unlocked, only while it is online (the existing
-- catalogue definition) and, when the operator enforces catalogue readiness, as ready as it must
-- be for Analyse.
create or replace function app_private.sale_is_unlockable(p_sale_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select app_private.auction_sale_is_publicly_visible(sale.id)
        and public.catalogue_readiness_allows_premium(
          sale.premium_readiness_status,
          sale.premium_readiness_override,
          sale.premium_readiness_override_expires_at
        )
      from public.auction_sales sale
      where sale.id = p_sale_id
    ),
    false
  );
$$;

revoke all on function app_private.sale_is_unlockable(uuid)
  from public, anon, authenticated;
grant execute on function app_private.sale_is_unlockable(uuid) to service_role;

-- True when the signed-in account unlocked this sale and the sale is still online.
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
  'True when the signed-in account unlocked this sale (3 per Paris month for Découverte) and the sale is still online. Used by the RLS policies that gate the Analyse rows.';

-- Same test for the child tables of auction_sales, which are keyed by source_url.
create or replace function app_private.current_user_unlocked_source_url(p_source_url text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select app_private.current_user_unlocked_sale(sale.id)
      from public.auction_sales sale
      where sale.source_url = p_source_url
    ),
    false
  );
$$;

revoke all on function app_private.current_user_unlocked_source_url(text)
  from public, anon, authenticated;
grant execute on function app_private.current_user_unlocked_source_url(text)
  to authenticated, service_role;

-- The only writer of user_sale_unlocks.  p_now is a parameter so that tests can move the clock;
-- the public wrapper always passes now().
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

  -- Idempotent: an unlocked sale is returned as is and consumes nothing.
  if exists (
    select 1
    from public.user_sale_unlocks unlock_row
    where unlock_row.user_id = v_user_id and unlock_row.sale_id = p_sale_id
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

create or replace function public.unlock_sale(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app_private.unlock_sale_at(p_sale_id, pg_catalog.now());
end;
$$;

revoke all on function public.unlock_sale(uuid) from public, anon;
grant execute on function public.unlock_sale(uuid) to authenticated, service_role;

comment on function public.unlock_sale(uuid) is
  'Unlocks one online sale for the signed-in Découverte account: 3 per Paris calendar month, idempotent per sale, serialized per account. SECURITY DEFINER by design (allowlisted in supabase/tests/441_function_privileges.sql): the caller is identified by auth.uid() only.';

-- Where the account stands: quota, reset instant and, for p_sale_id, whether it is unlocked.
-- Security invoker: it only reads the caller's own rows.
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

-- Gated reads: an unlocked sale is readable like an Analyse sale, for that sale only.  Admin
-- bypass, readiness, quarantine and publication-marker guards of auction_sales_authenticated_read
-- are kept as they were (supabase/tests 385, 390 and 412 read their text).
alter policy auction_sales_authenticated_read on public.auction_sales
using (
  public.is_admin()
  or (
    (
      public.has_analysis_access()
      or app_private.current_user_unlocked_sale(id)
    )
    and public.catalogue_readiness_allows_premium(
      premium_readiness_status,
      premium_readiness_override,
      premium_readiness_override_expires_at
    )
    and coalesce(status, 'unknown') <> 'quarantined'
    and coalesce(raw_payload->>'publication_quarantine', '') = ''
  )
);

drop policy if exists auction_documents_authenticated_read on public.auction_documents;
create policy auction_documents_authenticated_read
on public.auction_documents for select
to authenticated
using (
  public.has_analysis_access()
  or app_private.current_user_unlocked_source_url(source_url)
);

drop policy if exists auction_features_authenticated_read on public.auction_features;
create policy auction_features_authenticated_read
on public.auction_features for select
to authenticated
using (
  public.has_analysis_access()
  or app_private.current_user_unlocked_source_url(source_url)
);

drop policy if exists auction_surfaces_authenticated_read on public.auction_surfaces;
create policy auction_surfaces_authenticated_read
on public.auction_surfaces for select
to authenticated
using (
  public.has_analysis_access()
  or app_private.current_user_unlocked_source_url(source_url)
);

drop policy if exists auction_risks_authenticated_read on public.auction_risks;
create policy auction_risks_authenticated_read
on public.auction_risks for select
to authenticated
using (
  public.has_analysis_access()
  or app_private.current_user_unlocked_source_url(source_url)
);

drop policy if exists auction_risk_occurrences_authenticated_read on public.auction_risk_occurrences;
create policy auction_risk_occurrences_authenticated_read
on public.auction_risk_occurrences for select
to authenticated
using (
  public.has_analysis_access()
  or app_private.current_user_unlocked_source_url(source_url)
);

drop policy if exists auction_score_factors_authenticated_read on public.auction_score_factors;
create policy auction_score_factors_authenticated_read
on public.auction_score_factors for select
to authenticated
using (
  public.has_analysis_access()
  or app_private.current_user_unlocked_source_url(source_url)
);

-- Opt-in stage 2 of 20261010003000 copies the auction_sales policy predicate into a definer view.
-- Same body, with the unlock added to that predicate so that turning stage 2 on later cannot hide
-- unlocked sales.
create or replace function app_private.set_catalogue_raw_columns_hidden(p_hidden boolean)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  view_definition text;
  stored_definition text;
  stored_options text[];
  matches integer;
  already_definer boolean;
  predicate constant text :=
    '(app_private.current_user_is_admin() OR ((public.has_analysis_access() '
    || 'OR app_private.current_user_unlocked_sale(s.id)) '
    || 'AND public.catalogue_readiness_allows_premium(s.premium_readiness_status, '
    || 's.premium_readiness_override, s.premium_readiness_override_expires_at) '
    || 'AND COALESCE(s.status, ''unknown''::text) <> ''quarantined''::text '
    || 'AND COALESCE(s.raw_payload ->> ''publication_quarantine''::text, ''''::text) = ''''::text)) AND ';
begin
  select coalesce(c.reloptions @> array['security_invoker=false'], false)
    into already_definer
    from pg_catalog.pg_class c
   where c.oid = 'public.v_auction_sales_app'::regclass;

  if p_hidden then
    if already_definer then
      return 'already hidden';
    end if;
    view_definition := pg_catalog.pg_get_viewdef('public.v_auction_sales_app'::regclass, true);
    select count(*) into matches
      from regexp_matches(view_definition, 'WHERE\s+\(s\.status = ANY', 'g');
    if matches <> 1 then
      raise exception 'v_auction_sales_app changed shape: update this function before hiding raw columns';
    end if;

    insert into app_private.catalogue_view_backups (view_name, definition, reloptions)
    select 'v_auction_sales_app', view_definition, c.reloptions
      from pg_catalog.pg_class c
     where c.oid = 'public.v_auction_sales_app'::regclass
    on conflict (view_name) do update
      set definition = excluded.definition,
          reloptions = excluded.reloptions,
          saved_at = now();

    view_definition := regexp_replace(
      view_definition,
      'WHERE\s+\(s\.status = ANY',
      'WHERE ' || predicate || '(s.status = ANY'
    );
    execute 'create or replace view public.v_auction_sales_app '
      || 'with (security_invoker = false, security_barrier = true) as '
      || rtrim(view_definition, E';\n ');
    revoke select (raw_payload, lawyer_contact, observations)
      on table public.auction_sales from authenticated;
    return 'hidden';
  end if;

  grant select (raw_payload, lawyer_contact, observations)
    on table public.auction_sales to authenticated;
  if already_definer then
    select b.definition, b.reloptions into stored_definition, stored_options
      from app_private.catalogue_view_backups b
     where b.view_name = 'v_auction_sales_app';
    if stored_definition is null then
      raise exception 'no stored definition for v_auction_sales_app; restore it manually';
    end if;
    execute 'create or replace view public.v_auction_sales_app '
      || 'with (security_invoker = true) as '
      || rtrim(stored_definition, E';\n ');
  end if;
  return 'visible';
end;
$$;

revoke all on function app_private.set_catalogue_raw_columns_hidden(boolean)
  from public, anon, authenticated, service_role;

comment on function app_private.set_catalogue_raw_columns_hidden(boolean) is
  'Opt-in stage 2 of P4-01, run as the migration role. true: v_auction_sales_app becomes a definer view guarded by the RLS predicate (Analyse access or an unlocked sale) and raw_payload/lawyer_contact/observations are revoked from authenticated. false: restores the stored definition. Run only after measuring the catalogue query.';

-- Retention: a row detached from its (purged) sale is only useful to its month's counter, and no
-- unlock outlives 24 months, like feature_usage_events.
create or replace function app_private.purge_sale_unlocks(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month_start timestamptz;
  v_detached integer := 0;
  v_expired integer := 0;
begin
  select period.period_start into v_month_start
  from app_private.sale_unlock_period(p_now) period;

  delete from public.user_sale_unlocks
  where sale_id is null and unlocked_at < v_month_start;
  get diagnostics v_detached = row_count;

  delete from public.user_sale_unlocks
  where unlocked_at < p_now - interval '24 months';
  get diagnostics v_expired = row_count;

  return pg_catalog.jsonb_build_object('user_sale_unlocks', v_detached + v_expired);
end;
$$;

revoke all on function app_private.purge_sale_unlocks(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_sale_unlocks(timestamptz) to service_role;

-- Same body as 20261020100000_offer_opening_notifications.sql plus the unlocks purge.  A later
-- migration that redefines this function must keep all four parts.
create or replace function public.run_data_retention(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app_private.purge_expired_operational_data(p_now)
    || app_private.purge_information_agent_data(p_now)
    || app_private.purge_offer_opening_notifications(p_now)
    || app_private.purge_sale_unlocks(p_now);
$$;

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
