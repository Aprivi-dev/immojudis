begin;

-- ImmoJudis now has one free catalog tier and one paid 30-day analysis tier.
-- Legacy "investisseur" rows keep their access but are folded into Analyse.
update public.user_subscriptions
set
  plan_code = 'analyse',
  updated_at = now(),
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'legacy_plan_code', 'investisseur',
    'migrated_to_analyse_at', now()
  )
where plan_code = 'investisseur';

alter table public.user_subscriptions
  drop constraint if exists user_subscriptions_plan_code_check;

alter table public.user_subscriptions
  add constraint user_subscriptions_plan_code_check
  check (plan_code in ('decouverte', 'analyse'));

-- Single source of truth used by RLS. It only answers for the current user and
-- deliberately treats a missing period end as an explicit manual/admin grant.
create or replace function public.has_analysis_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(public.is_admin(), false)
    or exists (
      select 1
      from public.user_subscriptions subscription
      where subscription.user_id = (select auth.uid())
        and subscription.plan_code = 'analyse'
        and subscription.status in ('trialing', 'active')
        and (
          subscription.current_period_end is null
          or subscription.current_period_end > now()
        )
    );
$$;

revoke all on function public.has_analysis_access() from public, anon;
grant execute on function public.has_analysis_access() to authenticated, service_role;

-- The browser may read this view on the Découverte plan. Every premium column
-- is replaced at the database boundary, so DevTools cannot reveal the values
-- shown as blurred previews by the UI. security_barrier prevents caller
-- predicates from being pushed through the curated boundary.
create or replace view public.v_auction_sales_discovery
with (security_invoker = false, security_barrier = true)
as
select
  s.id,
  s.title,
  null::text as description,
  null::text as source_description,
  null::text as llm_display_description,
  null::text as about_description,
  s.city,
  s.department,
  s.postal_code,
  s.address,
  s.tribunal,
  s.tribunal_code,
  t.canonical_name as tribunal_name,
  t.city as tribunal_city,
  s.property_type,
  s.starting_price_eur,
  s.sale_date,
  s.visit_dates,
  null::text as lawyer_name,
  null::text as lawyer_contact,
  null::numeric as adjudication_price_eur,
  s.latitude,
  s.longitude,
  null::text as occupancy_status,
  s.surface_m2,
  s.habitable_surface_m2,
  s.carrez_surface_m2,
  s.land_surface_m2,
  s.app_surface_m2,
  s.app_surface_kind,
  s.surface_scope,
  s.surface_source,
  null::double precision as surface_confidence,
  null::text as surface_evidence,
  s.rooms_count,
  s.bedrooms_count,
  s.bathrooms_count,
  s.parking_count,
  s.has_garden,
  s.has_terrace,
  s.has_garage,
  s.has_pool,
  s.has_air_conditioning,
  s.has_double_glazing,
  null::double precision as investment_score,
  null::text as investment_summary,
  null::text as score_version,
  null::double precision as score_confidence,
  '[]'::jsonb as score_factors,
  null::text as risk_notes,
  '[]'::jsonb as risks,
  null::text as source_name,
  null::text as primary_source,
  null::text as source_url,
  '[]'::jsonb as source_urls,
  null::text as dedupe_confidence,
  '[]'::jsonb as documents,
  '[]'::jsonb as documents_rich,
  s.status,
  '[]'::jsonb as quality_flags,
  s.created_at,
  s.updated_at,
  case
    when nullif(s.raw_payload->>'raw_image_url', '') ~* '^https?://'
      then jsonb_build_array(jsonb_build_object(
        'type', 'image',
        'url', nullif(s.raw_payload->>'raw_image_url', '')
      ))
    else '[]'::jsonb
  end as media,
  null::jsonb as source_blocks,
  '{}'::jsonb as source_blocks_by_source
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
where s.status in ('upcoming', 'unknown')
  and s.latitude is not null
  and s.longitude is not null;

revoke all on table public.v_auction_sales_discovery from public, anon;
grant select on table public.v_auction_sales_discovery to authenticated;

-- Full judicial data is still queryable through the existing security-invoker
-- view, but only when this RLS predicate succeeds.
drop policy if exists auction_sales_authenticated_read on public.auction_sales;
create policy auction_sales_authenticated_read
on public.auction_sales for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_sales_app_read_authenticated_read on public.auction_sales_app_read;
create policy auction_sales_app_read_authenticated_read
on public.auction_sales_app_read for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_documents_authenticated_read on public.auction_documents;
create policy auction_documents_authenticated_read
on public.auction_documents for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_features_authenticated_read on public.auction_features;
create policy auction_features_authenticated_read
on public.auction_features for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_surfaces_authenticated_read on public.auction_surfaces;
create policy auction_surfaces_authenticated_read
on public.auction_surfaces for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_risks_authenticated_read on public.auction_risks;
create policy auction_risks_authenticated_read
on public.auction_risks for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_risk_occurrences_authenticated_read on public.auction_risk_occurrences;
create policy auction_risk_occurrences_authenticated_read
on public.auction_risk_occurrences for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_score_factors_authenticated_read on public.auction_score_factors;
create policy auction_score_factors_authenticated_read
on public.auction_score_factors for select
to authenticated
using (public.has_analysis_access());

drop policy if exists auction_scoring_versions_authenticated_read on public.auction_scoring_versions;
create policy auction_scoring_versions_authenticated_read
on public.auction_scoring_versions for select
to authenticated
using (public.has_analysis_access());

drop policy if exists properties_authenticated_read on public.properties;
create policy properties_authenticated_read
on public.properties for select
to authenticated
using (public.has_analysis_access());

drop policy if exists judicial_sales_authenticated_read on public.judicial_sales;
create policy judicial_sales_authenticated_read
on public.judicial_sales for select
to authenticated
using (public.has_analysis_access());

-- Remove obsolete read models that could bypass the two curated catalog views.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'public.public_auction_sales',
    'public.auction_sales_quality_issues',
    'public.auction_sales_investment_candidates',
    'public.auction_source_coverage',
    'public.v_auction_map_pins'
  ] loop
    if to_regclass(relation_name) is not null then
      execute format('revoke all on table %s from anon, authenticated', relation_name);
    end if;
  end loop;
end $$;

-- Defense in depth for user-owned paid workflows. Existing ownership policies
-- remain in place; these restrictive policies are ANDed with them.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'public.user_favorites',
    'public.user_alerts',
    'public.saved_property_reports',
    'public.property_report_exports',
    'public.sale_workspaces',
    'public.sale_data_exports',
    'public.user_alert_matches',
    'public.user_watched_zones',
    'public.user_sale_analysis_sets',
    'public.user_sale_analysis_items',
    'public.user_alert_notifications',
    'public.sale_workspace_collaborators',
    'public.sale_workspace_annotations',
    'public.user_sale_watch_snapshots',
    'public.user_sale_change_events',
    'public.data_refresh_requests',
    'public.referenced_lawyers',
    'public.referenced_lawyer_coverage',
    'public.lawyer_referral_requests'
  ] loop
    if to_regclass(relation_name) is not null then
      execute format('drop policy if exists analysis_access_required on %s', relation_name);
      execute format(
        'create policy analysis_access_required on %s as restrictive for all to authenticated using (public.has_analysis_access()) with check (public.has_analysis_access())',
        relation_name
      );
    end if;
  end loop;
end $$;

-- Idempotent ledger for the 29 EUR / 30 day one-time Checkout purchase.
create table if not exists public.stripe_checkout_access_grants (
  checkout_session_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null default 'analyse' check (plan_code = 'analyse'),
  stripe_customer_id text,
  amount_total integer,
  currency text,
  paid_at timestamptz not null,
  access_start timestamptz not null,
  access_end timestamptz not null,
  created_at timestamptz not null default now(),
  check (access_end > access_start),
  check (amount_total is null or amount_total >= 0)
);

create index if not exists stripe_checkout_access_grants_user_end_idx
  on public.stripe_checkout_access_grants (user_id, access_end desc);

alter table public.stripe_checkout_access_grants enable row level security;
revoke all on table public.stripe_checkout_access_grants from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_checkout_access_grants to service_role;

create or replace function public.grant_analysis_access_from_checkout(
  p_checkout_session_id text,
  p_user_id uuid,
  p_stripe_customer_id text,
  p_amount_total integer,
  p_currency text,
  p_paid_at timestamptz,
  p_duration_days integer default 30
)
returns table (granted boolean, access_end timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_end timestamptz;
  current_end timestamptz;
  next_start timestamptz;
  next_end timestamptz;
begin
  if nullif(trim(p_checkout_session_id), '') is null or p_user_id is null then
    raise exception 'Checkout session and user are required';
  end if;

  if p_duration_days <> 30 then
    raise exception 'Analyse access duration must be exactly 30 days';
  end if;

  if p_amount_total is distinct from 2900
    or lower(coalesce(p_currency, '')) <> 'eur' then
    raise exception 'Analyse checkout must be paid at 29 EUR';
  end if;

  insert into public.user_subscriptions (user_id, plan_code, status)
  values (p_user_id, 'decouverte', 'active')
  on conflict (user_id) do nothing;

  select case
    when subscription.plan_code = 'analyse'
      and subscription.status in ('trialing', 'active')
      and subscription.current_period_end > coalesce(p_paid_at, now())
      then subscription.current_period_end
    else null
  end
  into current_end
  from public.user_subscriptions subscription
  where subscription.user_id = p_user_id
  for update;

  select access_grant.access_end
  into existing_end
  from public.stripe_checkout_access_grants access_grant
  where access_grant.checkout_session_id = p_checkout_session_id;

  if found then
    return query select false, existing_end;
    return;
  end if;

  next_start := greatest(
    coalesce(p_paid_at, now()),
    case
      when current_end is not null and current_end > coalesce(p_paid_at, now())
        then current_end
      else coalesce(p_paid_at, now())
    end
  );
  next_end := next_start + make_interval(days => p_duration_days);

  insert into public.stripe_checkout_access_grants (
    checkout_session_id,
    user_id,
    stripe_customer_id,
    amount_total,
    currency,
    paid_at,
    access_start,
    access_end
  ) values (
    p_checkout_session_id,
    p_user_id,
    p_stripe_customer_id,
    p_amount_total,
    lower(p_currency),
    coalesce(p_paid_at, now()),
    next_start,
    next_end
  );

  update public.user_subscriptions
  set
    plan_code = 'analyse',
    status = 'active',
    stripe_customer_id = coalesce(p_stripe_customer_id, stripe_customer_id),
    stripe_subscription_id = null,
    current_period_end = next_end,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'billing_model', 'one_time_30_days',
      'checkout_session_id', p_checkout_session_id,
      'checkout_completed_at', coalesce(p_paid_at, now()),
      'access_duration_days', p_duration_days
    ),
    updated_at = now()
  where user_id = p_user_id;

  return query select true, next_end;
end;
$$;

revoke all on function public.grant_analysis_access_from_checkout(
  text, uuid, text, integer, text, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.grant_analysis_access_from_checkout(
  text, uuid, text, integer, text, timestamptz, integer
) to service_role;

notify pgrst, 'reload schema';

commit;
