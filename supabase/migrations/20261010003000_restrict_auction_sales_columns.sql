-- P4-01: stop exposing internal pipeline columns of public.auction_sales to the Data API.
--
-- Until now `authenticated` held a table-wide SELECT grant (20260630180814_...) behind the
-- `auction_sales_authenticated_read` policy, so any premium JWT could run
-- `select raw_text, content_hash, premium_readiness_*, ... from auction_sales` through
-- PostgREST. The application only reads the catalogue through the views
-- v_auction_sales_app / _preview / v_auction_map_pins (security_invoker) and the two
-- discovery views (security definer, see below).
--
-- Stage 1 (applied here): replace the table grant by a column grant that drops every
-- column no invoker view, policy-independent query or app path needs. Row access is still
-- decided by the unchanged RLS policy (policy expressions are not column-privilege checked).
--
-- Stage 2 (opt-in, NOT applied here): raw_payload, lawyer_contact and observations are read
-- by the security_invoker view v_auction_sales_app to derive source blocks, checks, media
-- and the lawyer line, so they cannot be hidden from `authenticated` without turning that
-- view into a definer view guarded by the RLS predicate. That rewrite touches the hottest
-- catalogue query and must be coordinated with the catalogue performance work (P1-01), so it
-- ships as a reversible function, `app_private.set_catalogue_raw_columns_hidden(boolean)`,
-- to be run once the new view definition has been measured.
begin;
set local lock_timeout = '5s';

revoke select on table public.auction_sales from authenticated;

grant select (
  id,
  source_name,
  source_url,
  tribunal,
  department,
  city,
  address,
  postal_code,
  property_type,
  title,
  description,
  surface_m2,
  starting_price_eur,
  sale_date,
  visit_dates,
  lawyer_name,
  lawyer_contact,
  status,
  adjudication_price_eur,
  documents,
  latitude,
  longitude,
  occupancy_status,
  risk_notes,
  raw_payload,
  created_at,
  updated_at,
  rooms_count,
  bedrooms_count,
  habitable_surface_m2,
  land_surface_m2,
  carrez_surface_m2,
  bathrooms_count,
  parking_count,
  has_garden,
  has_terrace,
  has_garage,
  has_pool,
  has_air_conditioning,
  has_double_glazing,
  investment_score,
  investment_summary,
  app_surface_m2,
  app_surface_kind,
  quality_flags,
  primary_source,
  source_urls,
  dedupe_confidence,
  surface_source,
  surface_confidence,
  surface_evidence,
  observations,
  tribunal_code,
  surface_scope,
  score_version,
  score_confidence,
  score_factors,
  sale_venue_type,
  sale_legal_framework,
  sale_verification_status,
  sale_procedure,
  catalogue_expiry_deadline,
  catalogue_expiry_materialized
) on table public.auction_sales to authenticated;

comment on table public.auction_sales is
  'Judicial sales. authenticated holds a column-level SELECT grant (no raw_text, content_hash, premium_readiness_*, retention_*, last_run_id, location, external_id); rows are gated by auction_sales_authenticated_read. See 20261010003000_restrict_auction_sales_columns.sql.';

-- The two discovery views are deliberately SECURITY DEFINER: they are redacted public
-- projections (no raw_payload content beyond derived scalars, no lawyer contact) that must
-- be readable by users whose own RLS policy hides the underlying rows. They are the only
-- sanctioned definer views; the CI contract (supabase/tests/441_function_privileges.sql)
-- fails if another definer view or an unlisted definer function appears.
comment on view public.v_auction_sales_discovery is
  'SECURITY DEFINER by design (security_barrier): redacted public discovery projection. Listed as an accepted security_definer_view exception.';
comment on view public.v_auction_sales_discovery_search is
  'SECURITY DEFINER by design (security_barrier): redacted public discovery search projection. Listed as an accepted security_definer_view exception.';

-- Stage 2 helper (not executed by this migration). The original definition is parked in
-- app_private.catalogue_view_backups so that `set_catalogue_raw_columns_hidden(false)` can
-- restore it exactly.
create table if not exists app_private.catalogue_view_backups (
  view_name text primary key,
  definition text not null,
  reloptions text[],
  saved_at timestamptz not null default now()
);
alter table app_private.catalogue_view_backups enable row level security;
revoke all on table app_private.catalogue_view_backups from public, anon, authenticated;

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
    '(app_private.current_user_is_admin() OR (public.has_analysis_access() '
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
  'Opt-in stage 2 of P4-01, run as the migration role. true: v_auction_sales_app becomes a definer view guarded by the RLS predicate and raw_payload/lawyer_contact/observations are revoked from authenticated. false: restores the stored definition. Run only after measuring the catalogue query.';

commit;
