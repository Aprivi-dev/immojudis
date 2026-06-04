-- Harden the public API surface for the investor preview.
-- Grants decide which objects are reachable through Supabase Data API;
-- RLS then decides which rows are visible or mutable.

-- Opt future objects out of Supabase's broad legacy default grants.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- Public read models: app needs read-only access from the browser.
revoke all on table public.public_auction_sales from anon, authenticated;
revoke all on table public.auction_sales_quality_issues from anon, authenticated;
revoke all on table public.auction_sales_investment_candidates from anon, authenticated;
revoke all on table public.auction_source_coverage from anon, authenticated;
revoke all on table public.v_auction_sales_app from anon, authenticated;

grant select on table public.public_auction_sales to anon, authenticated;
grant select on table public.auction_sales_quality_issues to anon, authenticated;
grant select on table public.auction_sales_investment_candidates to anon, authenticated;
grant select on table public.auction_source_coverage to anon, authenticated;
grant select on table public.v_auction_sales_app to anon, authenticated;

-- Public structured app tables: expose only read operations.
revoke all on table public.auction_features from anon, authenticated;
revoke all on table public.auction_surfaces from anon, authenticated;
revoke all on table public.auction_risks from anon, authenticated;
revoke all on table public.auction_risk_occurrences from anon, authenticated;
revoke all on table public.auction_score_factors from anon, authenticated;
revoke all on table public.auction_scoring_versions from anon, authenticated;
revoke all on table public.tribunals from anon, authenticated;

grant select on table public.auction_features to anon, authenticated;
grant select on table public.auction_surfaces to anon, authenticated;
grant select (
  source_url, risk_type, risk_label, severity, evidence, evidence_json,
  confidence, detector, detector_version, score_impact, updated_at
) on table public.auction_risks to anon, authenticated;
grant select (
  source_url, risk_type, risk_label, severity, document_url, document_label,
  document_type, page_number, excerpt, confidence, detector, detector_version,
  matched_terms, is_negated, score_impact, created_at, updated_at
) on table public.auction_risk_occurrences to anon, authenticated;
grant select (
  source_url, factor_order, factor_key, label, reason, delta, weight,
  raw_value, normalized_value, confidence, evidence, evidence_refs,
  created_at, updated_at
) on table public.auction_score_factors to anon, authenticated;
grant select on table public.auction_scoring_versions to anon, authenticated;
grant select on table public.tribunals to anon, authenticated;

-- User-owned tables: anonymous users do not need direct privileges.
revoke all on table public.user_alerts from anon, authenticated;
revoke all on table public.user_favorites from anon, authenticated;
grant select, insert, update, delete on table public.user_alerts to authenticated;
grant select, insert, delete on table public.user_favorites to authenticated;

-- Canonical app source tables: keep a narrow column-level read grant because
-- security_invoker views also need the invoker to have access to referenced columns.
revoke all on table public.auction_sales from anon, authenticated;
grant select (
  id, source_url, source_name, primary_source, tribunal, tribunal_code,
  department, city, address, postal_code, property_type, title, description,
  habitable_surface_m2, land_surface_m2, carrez_surface_m2, surface_m2,
  app_surface_m2, app_surface_kind, surface_scope, surface_source,
  surface_confidence, surface_evidence, rooms_count, bedrooms_count,
  bathrooms_count, parking_count, has_garden, has_terrace, has_garage,
  has_pool, has_air_conditioning, has_double_glazing, starting_price_eur,
  sale_date, visit_dates, status, documents, latitude, longitude,
  occupancy_status, risk_notes, investment_score, investment_summary,
  source_urls, score_version, score_confidence, score_factors,
  dedupe_confidence, quality_flags, first_seen_at, last_seen_at,
  created_at, updated_at
) on table public.auction_sales to anon, authenticated;

revoke all on table public.auction_documents from anon, authenticated;
grant select (
  source_url, document_url, label, document_type, download_status,
  extraction_status, docling_status, text_chars, updated_at
) on table public.auction_documents to anon, authenticated;

drop policy if exists auction_sales_public_read on public.auction_sales;
create policy auction_sales_public_read
on public.auction_sales for select
to anon, authenticated
using (true);

drop policy if exists auction_documents_public_read on public.auction_documents;
create policy auction_documents_public_read
on public.auction_documents for select
to anon, authenticated
using (true);

-- Internal/raw pipeline tables must stay server-only.
revoke all on table public.auction_observations from anon, authenticated;
revoke all on table public.auction_extractions from anon, authenticated;
revoke all on table public.auction_sale_history from anon, authenticated;
revoke all on table public.auction_runs from anon, authenticated;

-- PostGIS metadata objects are owned by the managed extension role on Supabase.
-- Revoke browser-facing privileges when possible; ownership can prevent enabling RLS.
do $$
declare
  object_name text;
begin
  foreach object_name in array array[
    'spatial_ref_sys',
    'geometry_columns',
    'geography_columns'
  ]
  loop
    if to_regclass('public.' || object_name) is not null then
      begin
        execute format('revoke all on table public.%I from anon, authenticated', object_name);
      exception
        when insufficient_privilege then
          raise notice 'Could not revoke grants on public.%: insufficient privilege', object_name;
      end;
    end if;
  end loop;
end $$;
