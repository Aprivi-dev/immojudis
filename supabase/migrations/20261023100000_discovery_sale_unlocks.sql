-- "3 déblocages par mois" for the free Découverte offer.
--
-- A Découverte account can unlock ONE sale at a time, three sales per calendar month in the
-- Europe/Paris time zone.  An unlocked sale opens five things for that sale only: the bid ceiling,
-- the reading of the documents, the history of the sale, the statistics of its tribunal and the
-- official documents of the case.  Nothing else of Analyse is opened, so the database opens nothing
-- else either:
--   * auction_sales is NOT widened (row level security cannot limit columns, and the table carries
--     the investment score, risk notes, raw payload...).  The sale is served by
--     public.v_auction_sales_unlocked, a redacted projection of the discovery view that only returns
--     the sales the caller unlocked, plus the facts the bid ceiling reads (source blocks) and the
--     official documents;
--   * no child table is opened to an unlock either: auction_documents, auction_risks,
--     auction_risk_occurrences, auction_score_factors, auction_features and auction_surfaces keep
--     their Analyse-only policies (20260710083858); the official documents reach the unlocked page
--     through the view only, with the projection the page displays;
--   * the server routes extend the matching rights (bid ceiling, document reading, sale history,
--     tribunal statistics of the sale) and return only what the unlocked page displays.
-- It never opens PDF/CSV exports or saved reports, which stay on Analyse.
--
-- Rules fixed by the owner on 2026-10-13 and 2026-10-14:
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
  'True when the signed-in account unlocked this sale (3 per Paris month for Découverte) and the sale is still online. Used by get_sale_unlock_status.';

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

-- The sale an account unlocked, as the unlocked page needs it.  auction_sales_authenticated_read is
-- left untouched: row level security cannot limit columns, and a policy opened to an unlocked sale
-- would hand the account every column granted to authenticated (investment score and summary, risk
-- notes, score factors, adjudication price...).  This view is the discovery projection (same columns,
-- same redactions: no score, no risks, no source url) for the sales the caller unlocked, with only
-- what the five unlocked elements read in addition:
--   * source_blocks and source_blocks_by_source: the facts of the listing (fees, deposit, DPE...) the
--     bid ceiling reads, so that the ceiling of an unlocked sale equals the one Analyse computes;
--   * documents and documents_rich: the official documents of the case.
-- It lists one row per unlock of the caller (at most three a month, 24 months) and checks that the
-- sale is still unlockable (online and ready), so a sale that left the catalogue disappears from it.
create or replace view public.v_auction_sales_unlocked
with (security_invoker = false, security_barrier = true) as
select
  s.id,
  s.title,
  s.description,
  nullif(s.raw_payload ->> 'source_description', '') as source_description,
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
  s.lawyer_name,
  s.lawyer_contact,
  null::numeric as adjudication_price_eur,
  s.latitude,
  s.longitude,
  s.occupancy_status,
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
  coalesce(s.documents, '[]'::jsonb) as documents,
  coalesce(d.documents_rich, '[]'::jsonb) as documents_rich,
  s.status,
  '[]'::jsonb as quality_flags,
  s.created_at,
  s.updated_at,
  coalesce(m.media, '[]'::jsonb) as media,
  s.raw_payload -> 'source_blocks' as source_blocks,
  coalesce(sb.source_blocks_by_source, '{}'::jsonb) as source_blocks_by_source,
  s.sale_venue_type,
  s.sale_legal_framework,
  s.sale_verification_status,
  s.sale_procedure,
  coalesce(c.source_checks, '{}'::jsonb) as source_checks,
  coalesce(s.raw_payload -> 'source_conflicts', '[]'::jsonb) as source_conflicts,
  case
    when (s.raw_payload ->> 'source_content_changed') = 'true' then 'pending'
    when nullif(s.raw_payload ->> 'llm_display_description', '') is not null then 'complete'
    else coalesce(s.raw_payload ->> 'llm_display_status', 'pending')
  end as analysis_status,
  app_private.auction_sale_source_presence_json(s.id) as source_presence,
  coalesce(dc.document_count, 0) as document_count
from public.user_sale_unlocks unlock_row
join public.auction_sales s on s.id = unlock_row.sale_id
left join public.tribunals t on t.code = s.tribunal_code
-- Source checks keyed by an opaque rank: the original keys are listing URLs.
left join lateral (
  select jsonb_object_agg('source_' || checks.ordinality, checks.value) as source_checks
    from jsonb_each(
      case when jsonb_typeof(s.raw_payload -> 'source_checks') = 'object'
           then s.raw_payload -> 'source_checks' else '{}'::jsonb end
    ) with ordinality as checks(key, value, ordinality)
) c on true
left join lateral (
  select count(*)::integer as document_count
    from public.auction_documents ad
   where ad.source_url = s.source_url
) dc on true
left join lateral (
  select jsonb_agg(
           jsonb_build_object('type', 'image', 'url', deduped.image_url)
           order by deduped.source_rank, deduped.image_url
         ) as media
    from (
      select distinct on (images.image_url) images.image_url, images.source_rank
        from (
          select nullif(s.raw_payload ->> 'raw_image_url', '') as image_url, 0 as source_rank
          union all
          select nullif(image.value, ''), 1
            from jsonb_array_elements_text(
              case when jsonb_typeof(s.raw_payload -> 'source_images') = 'array'
                   then s.raw_payload -> 'source_images' else '[]'::jsonb end
            ) as image(value)
        ) images
       where images.image_url is not null
         and images.image_url ~* '^https?://'
         and images.image_url !~* '\.(pdf|docx?|svg)([?#].*)?$'
         and images.image_url !~* '(^|[/_.-])(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)'
       order by images.image_url, images.source_rank
    ) deduped
) m on true
-- Facts of the other sources of the same listing, as the Analyse view builds them.
left join lateral (
  select jsonb_object_agg(source_key, source_blocks) as source_blocks_by_source
  from (
    select
      coalesce(nullif(s.source_name, ''), 'source') || ':primary' as source_key,
      s.raw_payload -> 'source_blocks' as source_blocks
    where jsonb_typeof(s.raw_payload -> 'source_blocks') = 'object'
    union all
    select
      coalesce(nullif(observation.value ->> 'source_name', ''), 'source') || ':' || observation.ordinality::text as source_key,
      observation.value -> 'raw_payload' -> 'source_blocks' as source_blocks
    from jsonb_array_elements(
      case
        when jsonb_typeof(s.observations) = 'array'
          then s.observations
        else '[]'::jsonb
      end
    ) with ordinality as observation(value, ordinality)
    where jsonb_typeof(observation.value -> 'raw_payload' -> 'source_blocks') = 'object'
  ) blocks
) sb on true
-- Official documents, with the same projection as v_auction_sales_app.
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'label', ad.label,
      'url', ad.document_url,
      'type', ad.document_type,
      'document_type', ad.document_type,
      'download_status', ad.download_status,
      'extraction_status', ad.extraction_status,
      'docling_status', ad.docling_status,
      'text_chars', ad.text_chars,
      'updated_at', ad.updated_at
    )
    order by ad.document_type, ad.label
  ) as documents_rich
  from public.auction_documents ad
  where ad.source_url = s.source_url
) d on true
where unlock_row.user_id = (select auth.uid())
  and app_private.sale_is_unlockable(s.id);

revoke all on table public.v_auction_sales_unlocked from public, anon;
grant select on table public.v_auction_sales_unlocked to authenticated;

comment on view public.v_auction_sales_unlocked is
  'SECURITY DEFINER by design (security_barrier): the sales the signed-in account unlocked (3 per Paris month), as the unlocked page needs them: the redacted discovery columns plus the listing facts read by the bid ceiling and the official documents. auction_sales is not opened to an unlock. Listed as an accepted security_definer_view exception (supabase/tests/442).';

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
